import {
  ConflictException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { assertGraphAutomation } from '../execution-graphs/graph-automatic-delivery';
import { ServersService } from '../servers/servers.service';
import { TasksService } from '../tasks/tasks.service';
import type { TaskPayload } from '../tasks/tasks.types';
import { DeploymentsService } from './deployments.service';
import { DeliveryRecordFilters } from '../projects/delivery-filters';
import { lockProjectGraph } from '../projects/project-guards';
import type { ComposeReleaseEvidence } from '../service-configs/compose-template-reference';
import {
  assertCurrentTargets,
  pendingReleaseApprovalTime,
  serviceReleasePolicy,
} from './release-policy';

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

  async listApprovals(filters: DeliveryRecordFilters = {}) {
    let query = this.database.db
      .selectFrom('tasks')
      .leftJoin('pipeline_runs', 'pipeline_runs.task_id', 'tasks.id')
      .select([
        'tasks.id',
        'tasks.name',
        'tasks.payload_json',
        'tasks.project_id',
        'tasks.service_id',
        'tasks.environment_id',
        'tasks.created_at',
      ])
      .where('task_type', '=', 'PIPELINE')
      .where('status', '=', 'PENDING')
      .where('available_at', '=', pendingReleaseApprovalTime);
    if (filters.projectId) query = query.where('tasks.project_id', '=', filters.projectId);
    if (filters.recordId) query = query.where('tasks.id', '=', filters.recordId);
    if (filters.pipelineRunId) query = query.where('pipeline_runs.id', '=', filters.pipelineRunId);
    if (filters.taskId) query = query.where('tasks.id', '=', filters.taskId);
    if (filters.serviceId) query = query.where('tasks.service_id', '=', filters.serviceId);
    if (filters.environmentId)
      query = query.where('tasks.environment_id', '=', filters.environmentId);
    if (filters.commit)
      query = query.where('pipeline_runs.commit_sha', 'like', filters.commit.toLowerCase() + '%');
    const tasks = await query.orderBy('tasks.created_at', 'asc').limit(200).execute();
    return tasks.map((row) => {
      const payload = JSON.parse(row.payload_json) as TaskPayload;
      return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        serviceId: row.service_id,
        environmentId: row.environment_id,
        createdAt: row.created_at,
        commitSha: payload.pipeline?.commitSha ?? null,
        serverIds: payload.targets.map((server) => server.id),
        artifactIds: payload.pipeline?.deploymentArtifacts?.map((artifact) => artifact.id) ?? [],
        requireCodeReview: payload.pipeline?.releasePolicy?.requireCodeReview === true,
        rollbackOfDeploymentId: payload.pipeline?.rollbackOfDeploymentId ?? null,
      };
    });
  }

  async approve(id: string, userId: string) {
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const row = await tx
        .selectFrom('tasks')
        .innerJoin('users', 'users.id', 'tasks.created_by')
        .select(['tasks.payload_json', 'tasks.created_by'])
        .where('tasks.id', '=', id)
        .where('tasks.status', '=', 'PENDING')
        .where('tasks.available_at', '=', pendingReleaseApprovalTime)
        .where('users.role', 'in', ['ADMIN', 'OPERATOR'])
        .where('users.status', '=', 'ACTIVE')
        .where('users.must_change_password', '=', 0)
        .executeTakeFirst();
      if (!row) throw new ConflictException('发布已处理或提交人权限已失效');
      const payload = JSON.parse(row.payload_json) as TaskPayload;
      const snapshot = payload.pipeline;
      if (!snapshot || snapshot.mode === 'BUILD_ONLY')
        throw new ConflictException('任务不需要发布审批');
      if (snapshot.graphAutomation)
        await assertGraphAutomation(
          tx,
          snapshot.projectId,
          row.created_by,
          snapshot.graphAutomation,
        );
      await assertCurrentTargets(tx, snapshot, payload.targets);
      const sourceReviews = await this.deployments.assertSourceReview(snapshot, { db: tx });
      const approver = await tx
        .updateTable('users')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', userId)
        .where('role', '=', 'ADMIN')
        .where('status', '=', 'ACTIVE')
        .where('must_change_password', '=', 0)
        .returning('id')
        .executeTakeFirst();
      if (!approver) throw new ConflictException('管理员审批权限已失效');
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
      await this.audit.record(
        userId,
        'deployment.approve',
        'task',
        id,
        {
          ...(sourceReviews && { sourceReviews }),
        },
        tx,
      );
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
    await assertCurrentTargets(db, { ...source.snapshot, rollbackOfDeploymentId: row.id }, [
      server,
    ]);
    const current = await this.deployments.currentSnapshot(db, source.snapshot, row.server_id);
    const { policy, deployPath } = await serviceReleasePolicy(
      db,
      row.service_id,
      row.environment_id,
    );
    if (
      !current ||
      current.status !== 'SUCCESS' ||
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
      deploymentArtifacts: source.snapshot.graphDeployment?.imageBindings
        ? source.snapshot.deploymentArtifacts
        : [{ id: source.artifactId, serverId: artifact.server_id }],
      triggerType: 'MANUAL',
      graphAutomation: undefined,
      rollbackOfDeploymentId: id,
      expectedCurrentDeploymentId: current.id,
      releaseKey: undefined,
      releasePolicy: {
        ...(source.snapshot.releasePolicy ?? policy),
        requireApproval: policy.requireApproval,
        requireCodeReview: Boolean(
          source.snapshot.releasePolicy?.requireCodeReview || policy.requireCodeReview,
        ),
        rollbackMode: 'OFF',
      },
    };
    const deploymentArtifact = await this.artifacts.forDeployment(snapshot, row.server_id);
    await this.artifacts.managedCompose(snapshot);
    const previousCompose = row.compose_release_json
      ? (JSON.parse(row.compose_release_json) as ComposeReleaseEvidence)
      : undefined;
    const sourceReviews = await this.deployments.assertSourceReview(snapshot, { db });
    const connection = [
      server.id,
      server.host,
      server.port,
      server.username,
      server.credentialId,
      server.hostKeyFingerprint,
    ];
    const confirmationHash = createHash('sha256')
      .update(JSON.stringify([id, snapshot, connection, sourceReviews]))
      .digest('hex');
    return {
      snapshot,
      server,
      sourceReviews,
      preview: {
        confirmationHash,
        deploymentId: id,
        artifactId: source.artifactId,
        artifactIds: snapshot.deploymentArtifacts?.map(({ id }) => id) ?? [],
        sourceCommit: snapshot.commitSha,
        checksum: artifact.checksum,
        imageDigest: artifact.image_digest,
        imageReference: deploymentArtifact.imageReference,
        images: deploymentArtifact.pins
          ? Object.entries(deploymentArtifact.pins).map(([variable, image]) => ({
              variable,
              artifactId: image.id,
              imageReference: image.imageReference,
              imageId: image.imageId,
            }))
          : undefined,
        composeTemplate: snapshot.managedCompose ?? deploymentArtifact.composeTemplate,
        previousCompose,
        serviceId: row.service_id,
        environmentId: row.environment_id,
        serverId: row.server_id,
        deployPath: row.deploy_path,
        requireApproval: policy.requireApproval,
        requireCodeReview: sourceReviews !== null,
        sourceReviews,
      },
    };
  }

  async preview(id: string) {
    return (await this.rollbackPlan(id)).preview;
  }

  async rollback(id: string, confirmationHash: string, userId: string) {
    const { snapshot, server, preview, sourceReviews } = await this.rollbackPlan(id);
    if (preview.confirmationHash !== confirmationHash)
      throw new ConflictException('发布或目标状态已变化，请重新预览回滚');
    snapshot.runId = randomUUID();
    const taskId = await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await assertCurrentTargets(tx, snapshot, [server]);
      const currentReviews = await this.deployments.assertSourceReview(snapshot, { db: tx });
      if (JSON.stringify(sourceReviews) !== JSON.stringify(currentReviews))
        throw new ConflictException('代码审核结果已变化，请重新预览回滚');
      const current = await this.deployments.currentSnapshot(tx, snapshot, server.id);
      if (current?.id !== snapshot.expectedCurrentDeploymentId || current?.status !== 'SUCCESS')
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
        { sourceDeploymentId: id, ...(sourceReviews && { sourceReviews }) },
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
  @Roles('ADMIN') @Get('approvals') approvals(@Query() filters: DeliveryRecordFilters) {
    return this.releases.listApprovals(filters);
  }
}
