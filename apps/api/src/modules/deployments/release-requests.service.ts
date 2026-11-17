import {
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Matches } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { ServersService } from '../servers/servers.service';
import { TasksService } from '../tasks/tasks.service';
import type { TaskPayload } from '../tasks/tasks.types';
import { DeploymentsService } from './deployments.service';
import {
  assertCurrentTargets,
  pendingReleaseApprovalTime,
  serviceReleasePolicy,
} from './release-policy';

class RollbackConfirmationDto {
  @Matches(/^[a-f0-9]{64}$/) confirmationHash!: string;
}

@Injectable()
export class ReleaseRequestsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly deployments: DeploymentsService,
    private readonly artifacts: ArtifactsService,
    private readonly servers: ServersService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
  ) {}

  async listApprovals() {
    const tasks = await this.database.db
      .selectFrom('tasks')
      .select(['id', 'name', 'payload_json', 'service_id', 'environment_id', 'created_at'])
      .where('task_type', '=', 'PIPELINE')
      .where('status', '=', 'PENDING')
      .where('available_at', '=', pendingReleaseApprovalTime)
      .orderBy('created_at', 'asc')
      .limit(200)
      .execute();
    return tasks.map((row) => {
      const payload = JSON.parse(row.payload_json) as TaskPayload;
      return {
        id: row.id,
        name: row.name,
        serviceId: row.service_id,
        environmentId: row.environment_id,
        createdAt: row.created_at,
        commitSha: payload.pipeline?.commitSha ?? null,
        serverIds: payload.targets.map((server) => server.id),
        artifactIds: payload.pipeline?.deploymentArtifacts?.map((artifact) => artifact.id) ?? [],
        rollbackOfDeploymentId: payload.pipeline?.rollbackOfDeploymentId ?? null,
      };
    });
  }

  async approve(id: string, userId: string) {
    await this.database.db.transaction().execute(async (tx) => {
      const row = await tx
        .selectFrom('tasks')
        .innerJoin('users', 'users.id', 'tasks.created_by')
        .select('tasks.payload_json')
        .where('tasks.id', '=', id)
        .where('tasks.status', '=', 'PENDING')
        .where('tasks.available_at', '=', pendingReleaseApprovalTime)
        .where('users.role', 'in', ['ADMIN', 'OPERATOR'])
        .where('users.status', '=', 'ACTIVE')
        .executeTakeFirst();
      if (!row) throw new ConflictException('发布已处理或提交人权限已失效');
      const payload = JSON.parse(row.payload_json) as TaskPayload;
      const snapshot = payload.pipeline;
      if (!snapshot || snapshot.mode === 'BUILD_ONLY')
        throw new ConflictException('任务不需要发布审批');
      await assertCurrentTargets(tx, snapshot, payload.targets);
      const now = Date.now();
      const changed = await tx
        .updateTable('tasks')
        .set({ release_approved_by: userId, available_at: now, updated_at: now })
        .where('id', '=', id)
        .where('status', '=', 'PENDING')
        .where('available_at', '=', pendingReleaseApprovalTime)
        .returning('id')
        .executeTakeFirst();
      if (!changed) throw new ConflictException('发布已由其他管理员处理');
      await this.audit.record(userId, 'deployment.approve', 'task', id, {}, tx);
    });
    return this.tasks.get(id);
  }

  private async rollbackPlan(id: string) {
    const db = this.database.db;
    const row = await db
      .selectFrom('deployment_records')
      .innerJoin('pipeline_runs', 'pipeline_runs.id', 'deployment_records.pipeline_run_id')
      .innerJoin('projects', 'projects.id', 'pipeline_runs.project_id')
      .selectAll('deployment_records')
      .where('deployment_records.id', '=', id)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('发布记录不存在');
    const source = this.deployments.rollbackSnapshot(row);
    if (!source || !row.server_id)
      throw new ConflictException('历史发布缺少可恢复的产物或完整快照');
    const server = await this.servers.get(row.server_id);
    if (!server.credentialId || !server.hostKeyFingerprint)
      throw new ConflictException('目标必须配置 SSH 凭据和已确认指纹');
    await assertCurrentTargets(db, { ...source.snapshot, rollbackOfDeploymentId: row.id }, [server]);
    const current = await this.deployments.current(
      db,
      row.service_id,
      row.environment_id,
      row.server_id,
    );
    const { policy, deployPath } = await serviceReleasePolicy(
      db,
      row.service_id,
      row.environment_id,
    );
    if (
      !current ||
      current.deploy_path !== row.deploy_path ||
      (deployPath && deployPath !== row.deploy_path)
    )
      throw new ConflictException('当前部署目录与历史发布不一致，请重新部署已归档产物');
    if (current.id === id) throw new ConflictException('所选版本已是当前发布');
    const currentSnapshot = current.release_snapshot_json
      ? (JSON.parse(current.release_snapshot_json) as PipelineSnapshot)
      : undefined;
    if (
      currentSnapshot &&
      currentSnapshot.definition.artifactType !== source.snapshot.definition.artifactType
    )
      throw new ConflictException('历史版本的部署方式与当前发布不一致');
    const artifact = await db
      .selectFrom('artifacts')
      .select(['server_id', 'checksum', 'image_digest'])
      .where('id', '=', source.artifactId)
      .executeTakeFirstOrThrow();
    const snapshot: PipelineSnapshot = {
      ...source.snapshot,
      mode: 'DEPLOY_ARTIFACT',
      deployAfterBuild: false,
      deploymentArtifacts: [{ id: source.artifactId, serverId: artifact.server_id }],
      triggerType: 'MANUAL',
      rollbackOfDeploymentId: id,
      expectedCurrentDeploymentId: current.id,
      releaseKey: undefined,
      releasePolicy: {
        ...(source.snapshot.releasePolicy ?? policy),
        requireApproval: policy.requireApproval,
        rollbackMode: 'OFF',
      },
    };
    await this.artifacts.forDeployment(snapshot, row.server_id);
    const connection = [
      server.id,
      server.host,
      server.port,
      server.username,
      server.credentialId,
      server.hostKeyFingerprint,
    ];
    const confirmationHash = createHash('sha256')
      .update(JSON.stringify([id, snapshot, connection]))
      .digest('hex');
    return {
      snapshot,
      server,
      preview: {
        confirmationHash,
        deploymentId: id,
        artifactId: source.artifactId,
        sourceCommit: snapshot.commitSha,
        checksum: artifact.checksum,
        imageDigest: artifact.image_digest,
        serviceId: row.service_id,
        environmentId: row.environment_id,
        serverId: row.server_id,
        deployPath: row.deploy_path,
        requireApproval: policy.requireApproval,
      },
    };
  }

  async preview(id: string) {
    return (await this.rollbackPlan(id)).preview;
  }

  async rollback(id: string, confirmationHash: string, userId: string) {
    const { snapshot, server, preview } = await this.rollbackPlan(id);
    if (preview.confirmationHash !== confirmationHash)
      throw new ConflictException('发布或目标状态已变化，请重新预览回滚');
    snapshot.runId = randomUUID();
    const taskId = await this.database.db.transaction().execute(async (tx) => {
      await assertCurrentTargets(tx, snapshot, [server]);
      const current = await this.deployments.current(
        tx,
        snapshot.serviceId,
        snapshot.environmentId,
        server.id,
      );
      if (current?.id !== snapshot.expectedCurrentDeploymentId)
        throw new ConflictException('当前发布已变化，请重新预览回滚');
      const taskId = await this.tasks.createInTransaction(
        tx,
        {
          type: 'PIPELINE',
          name: `回滚 · ${snapshot.commitSha.slice(0, 8)}`,
          idempotencyKey: `release-rollback:${confirmationHash}`,
          scope: {
            projectId: snapshot.projectId,
            serviceId: snapshot.serviceId,
            environmentId: snapshot.environmentId,
            targetId: snapshot.targetId,
          },
          pipelineRun: {
            id: snapshot.runId,
            pipelineId: snapshot.pipelineId,
            pipelineVersionId: snapshot.pipelineVersionId,
            gitRef: snapshot.commitSha,
            commitSha: snapshot.commitSha,
            buildLocation: snapshot.definition.buildLocation,
            artifactType: snapshot.definition.artifactType,
          },
          payload: {
            pipeline: snapshot,
            targets: [server],
            steps: [],
            strategy: 'SEQUENTIAL',
            maxParallel: 1,
            failurePolicy: 'STOP',
            timeout: 1200,
          },
        },
        userId,
      );
      await this.audit.record(
        userId,
        'deployment.rollback',
        'task',
        taskId,
        { sourceDeploymentId: id },
        tx,
      );
      return taskId;
    });
    return this.tasks.get(taskId);
  }
}

@Controller('deployments')
export class ReleaseRequestsController {
  constructor(private readonly releases: ReleaseRequestsService) {}
  @Roles('ADMIN') @Get('approvals') approvals() {
    return this.releases.listApprovals();
  }
  @Roles('ADMIN') @Post('approvals/:id/approve') approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthRequest,
  ) {
    return this.releases.approve(id, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post(':id/rollback/preview') preview(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.releases.preview(id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post(':id/rollback') rollback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RollbackConfirmationDto,
    @Req() req: AuthRequest,
  ) {
    return this.releases.rollback(id, dto.confirmationHash, req.user.id);
  }
}
