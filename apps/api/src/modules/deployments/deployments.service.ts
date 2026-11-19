import { ConflictException, Controller, Get, Injectable, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database, DeploymentRecordsTable } from '../../core/database/schema';
import type { PipelineSnapshot, PipelineTarget } from '../pipelines/pipeline.types';
import { lockTaskLease, TaskLeaseUnavailableError } from '../tasks/task-lease';
import { assertCurrentTargets, serviceReleasePolicy } from './release-policy';
import { lockAvailableArtifacts } from '../artifacts/artifact-availability';
import { DeliveryRecordFilters } from '../projects/delivery-filters';

export type DeploymentHealth = 'NOT_CHECKED' | 'HEALTHY' | 'FAILED' | 'UNKNOWN';
@Injectable()
export class DeploymentsService {
  constructor(private readonly database: DatabaseService) {}
  async current(db: Kysely<Database>, serviceId: string, environmentId: string, serverId: string) {
    return db
      .selectFrom('deployment_records')
      .select(['id', 'deploy_path', 'release_snapshot_json'])
      .where('service_id', '=', serviceId)
      .where('environment_id', '=', environmentId)
      .where('server_id', '=', serverId)
      .where((eb) => eb.or([eb('activated_at', 'is not', null), eb('status', '=', 'SUCCESS')]))
      .orderBy((eb) => eb.fn.coalesce('activated_at', 'started_at'), 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }

  async assertApproval(taskId: string, snapshot: PipelineSnapshot, targets?: PipelineTarget[]) {
    const db = this.database.db;
    const { policy } = await serviceReleasePolicy(db, snapshot.serviceId, snapshot.environmentId);
    const requiresApproval = policy.requireApproval || snapshot.releasePolicy?.requireApproval;
    if (!requiresApproval && snapshot.mode !== 'DEPLOY_ARTIFACT') return;
    const automatic = snapshot.triggerType && snapshot.triggerType !== 'MANUAL';
    if (targets && (automatic || requiresApproval || snapshot.rollbackOfDeploymentId))
      await assertCurrentTargets(db, snapshot, targets);
    let query = db
      .selectFrom('tasks')
      .innerJoin('users as requester', 'requester.id', 'tasks.created_by')
      .select('tasks.id')
      .where('tasks.id', '=', taskId)
      .where('requester.role', 'in', automatic ? ['ADMIN'] : ['ADMIN', 'OPERATOR'])
      .where('requester.status', '=', 'ACTIVE')
      .where('requester.must_change_password', '=', 0);
    if (requiresApproval) {
      query = query
        .innerJoin('users as approver', 'approver.id', 'tasks.release_approved_by')
        .where('approver.role', '=', 'ADMIN')
        .where('approver.status', '=', 'ACTIVE')
        .where('approver.must_change_password', '=', 0);
    }
    if (!(await query.executeTakeFirst()))
      throw new ConflictException(
        requiresApproval ? '发布需要有效的管理员审批，请预览并重新提交' : '发布提交人的权限已失效',
      );
  }

  async activeSnapshot(
    snapshot: PipelineSnapshot,
    serverId: string,
  ): Promise<PipelineSnapshot | undefined> {
    const current = await this.current(
      this.database.db,
      snapshot.serviceId,
      snapshot.environmentId,
      serverId,
    );
    if (!current?.release_snapshot_json || current.deploy_path !== snapshot.definition.deployPath)
      return undefined;
    return JSON.parse(current.release_snapshot_json) as PipelineSnapshot;
  }

  rollbackSnapshot(row: Selectable<DeploymentRecordsTable>) {
    if (
      row.status !== 'SUCCESS' ||
      !row.artifact_id ||
      !row.release_snapshot_json ||
      !row.server_id
    )
      return undefined;
    const snapshot = JSON.parse(row.release_snapshot_json) as PipelineSnapshot;
    if (!snapshot.sourceBuildTaskId || !snapshot.releaseKey) return undefined;
    return { id: row.id, artifactId: row.artifact_id, snapshot };
  }

  async rollbackCandidate(snapshot: PipelineSnapshot, serverId: string) {
    const policy = snapshot.releasePolicy;
    if (!policy || policy.rollbackMode === 'OFF' || snapshot.rollbackOfDeploymentId)
      return undefined;
    const db = this.database.db;
    let query = db
      .selectFrom('deployment_records')
      .selectAll()
      .where('service_id', '=', snapshot.serviceId)
      .where('environment_id', '=', snapshot.environmentId)
      .where('server_id', '=', serverId)
      .where('deploy_path', '=', snapshot.definition.deployPath)
      .where('release_snapshot_json', 'is not', null)
      .where('artifact_id', 'is not', null)
      .where('status', '=', 'SUCCESS')
      .where('health_status', '=', 'HEALTHY');
    const current = await this.current(db, snapshot.serviceId, snapshot.environmentId, serverId);
    if (policy.rollbackMode === 'PINNED') {
      if (!policy.pinnedDeploymentId) return undefined;
      query = query.where(
        'pipeline_run_id',
        '=',
        db
          .selectFrom('deployment_records')
          .select('pipeline_run_id')
          .where('id', '=', policy.pinnedDeploymentId),
      );
    }
    const row = await query
      .orderBy((eb) => eb.fn.coalesce('activated_at', 'started_at'), 'desc')
      .executeTakeFirst();
    const candidate = row && this.rollbackSnapshot(row);
    if (
      !candidate ||
      candidate.snapshot.definition.artifactType !== snapshot.definition.artifactType
    )
      return undefined;
    const activeSnapshot = current?.release_snapshot_json
      ? (JSON.parse(current.release_snapshot_json) as PipelineSnapshot)
      : undefined;
    return {
      ...candidate,
      releaseKey: candidate.snapshot.releaseKey!,
      currentReleaseKey: activeSnapshot?.releaseKey,
    };
  }

  async start(
    s: PipelineSnapshot,
    serverId: string,
    targetId: string,
    lease?: { taskId: string; owner: string },
    artifactId?: string,
  ) {
    const id = randomUUID();
    await this.database.db.transaction().execute(async (tx) => {
      if (artifactId) await lockAvailableArtifacts(tx, [artifactId]);
      if (lease) {
        if (!(await lockTaskLease(tx, lease.taskId, lease.owner)))
          throw new TaskLeaseUnavailableError();
        await tx
          .selectFrom('task_targets')
          .innerJoin('pipeline_runs', 'pipeline_runs.task_id', 'task_targets.task_id')
          .select('task_targets.id')
          .where('pipeline_runs.id', '=', s.runId)
          .where('task_targets.task_id', '=', lease.taskId)
          .where('task_targets.id', '=', targetId)
          .where('task_targets.server_id', '=', serverId)
          .where('task_targets.status', '=', 'RUNNING')
          .executeTakeFirstOrThrow();
      }
      const previous = await this.current(tx, s.serviceId, s.environmentId, serverId);
      if (
        s.expectedCurrentDeploymentId !== undefined &&
        (previous?.id ?? null) !== s.expectedCurrentDeploymentId
      )
        throw new ConflictException('当前版本已变化，请重新预览回滚');
      await tx
        .insertInto('deployment_records')
        .values({
          id,
          pipeline_run_id: s.runId,
          task_target_id: targetId,
          artifact_id: artifactId,
          service_id: s.serviceId,
          environment_id: s.environmentId,
          server_id: serverId,
          status: 'RUNNING',
          release_version: s.commitSha,
          deploy_path: s.definition.deployPath,
          health_status: 'PENDING',
          previous_deployment_id: previous?.id ?? null,
          rollback_of_deployment_id: s.rollbackOfDeploymentId,
          release_snapshot_json: s.sourceBuildTaskId
            ? JSON.stringify({ ...s, releaseKey: s.releaseKey ?? lease?.taskId })
            : null,
          started_at: Date.now(),
        })
        .execute();
    });
    return id;
  }

  async markActivated(id: string, lease?: { taskId: string; owner: string }) {
    await this.database.db.transaction().execute(async (tx) => {
      if (lease && !(await lockTaskLease(tx, lease.taskId, lease.owner)))
        throw new TaskLeaseUnavailableError();
      const active = await tx
        .updateTable('deployment_records')
        .set({ activated_at: Date.now() })
        .where('id', '=', id)
        .where('status', '=', 'RUNNING')
        .returning('id')
        .executeTakeFirst();
      if (!active) throw new TaskLeaseUnavailableError();
    });
  }
  async finish(
    id: string,
    status: string,
    artifactId?: string,
    healthStatus: DeploymentHealth = 'NOT_CHECKED',
    lease?: { taskId: string; owner: string },
  ) {
    return this.database.db.transaction().execute(async (tx) => {
      if (lease && !(await lockTaskLease(tx, lease.taskId, lease.owner, true))) return false;
      let update = tx
        .updateTable('deployment_records')
        .set({
          status,
          ...(artifactId !== undefined && { artifact_id: artifactId }),
          health_status: healthStatus,
          finished_at: Date.now(),
        })
        .where('id', '=', id)
        .where('status', '=', 'RUNNING');
      if (lease) {
        update = update.where(
          'task_target_id',
          'in',
          tx.selectFrom('task_targets').select('id').where('task_id', '=', lease.taskId),
        );
      }
      return Boolean(await update.returning('id').executeTakeFirst());
    });
  }
  async list(projectId?: string, filters: DeliveryRecordFilters = {}) {
    let q = this.database.db
      .selectFrom('deployment_records')
      .innerJoin('pipeline_runs', 'pipeline_runs.id', 'deployment_records.pipeline_run_id')
      .leftJoin('artifacts', 'artifacts.id', 'deployment_records.artifact_id')
      .selectAll('deployment_records')
      .select([
        'pipeline_runs.project_id',
        'pipeline_runs.commit_sha',
        'pipeline_runs.task_id',
        'artifacts.pruned_at',
        'artifacts.storage_type',
      ])
      .select((eb) =>
        eb
          .selectFrom('deployment_records as active')
          .select('active.id')
          .whereRef('active.service_id', '=', 'deployment_records.service_id')
          .whereRef('active.environment_id', '=', 'deployment_records.environment_id')
          .whereRef('active.server_id', '=', 'deployment_records.server_id')
          .where((filter) =>
            filter.or([
              filter('active.activated_at', 'is not', null),
              filter('active.status', '=', 'SUCCESS'),
            ]),
          )
          .orderBy((value) => value.fn.coalesce('active.activated_at', 'active.started_at'), 'desc')
          .orderBy('active.id', 'desc')
          .limit(1)
          .as('current_id'),
      )
      .select((eb) =>
        eb
          .selectFrom('deployment_records as rollback')
          .select('rollback.status')
          .whereRef('rollback.rollback_of_deployment_id', '=', 'deployment_records.id')
          .orderBy('rollback.started_at', 'desc')
          .limit(1)
          .as('rollback_status'),
      );
    if (projectId) q = q.where('pipeline_runs.project_id', '=', projectId);
    if (filters.recordId) q = q.where('deployment_records.id', '=', filters.recordId);
    if (filters.pipelineRunId) q = q.where('pipeline_runs.id', '=', filters.pipelineRunId);
    if (filters.taskId) q = q.where('pipeline_runs.task_id', '=', filters.taskId);
    if (filters.serviceId) q = q.where('deployment_records.service_id', '=', filters.serviceId);
    if (filters.environmentId)
      q = q.where('deployment_records.environment_id', '=', filters.environmentId);
    if (filters.commit)
      q = q.where('pipeline_runs.commit_sha', 'like', filters.commit.toLowerCase() + '%');
    return (await q.orderBy('deployment_records.started_at', 'desc').limit(200).execute()).map(
      (r) => ({
        id: r.id,
        projectId: r.project_id,
        taskId: r.task_id,
        sourceCommit: r.commit_sha,
        pipelineRunId: r.pipeline_run_id,
        artifactId: r.artifact_id,
        serviceId: r.service_id,
        environmentId: r.environment_id,
        serverId: r.server_id,
        status: r.status,
        releaseVersion: r.release_version,
        deployPath: r.deploy_path,
        healthStatus: r.health_status,
        previousDeploymentId: r.previous_deployment_id,
        rollbackAvailable:
          (r.pruned_at === null || r.storage_type === 'REGISTRY_IMAGE') &&
          Boolean(this.rollbackSnapshot(r)),
        isCurrent: r.current_id === r.id,
        rollbackOfDeploymentId: r.rollback_of_deployment_id,
        rollbackStatus: r.rollback_status,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      }),
    );
  }
}
@Controller('deployments')
export class DeploymentsController {
  constructor(private readonly service: DeploymentsService) {}
  @Get() list(@Query() filters: DeliveryRecordFilters) {
    return this.service.list(filters.projectId, filters);
  }
}
