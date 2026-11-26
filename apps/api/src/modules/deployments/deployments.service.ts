import { ConflictException, Controller, Get, Injectable, Optional, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database, DeploymentRecordsTable } from '../../core/database/schema';
import type { PipelineSnapshot, PipelineTarget } from '../pipelines/pipeline.types';
import { isProjectReleasePath } from '../pipelines/pipeline.validation';
import type { TaskPayload } from '../tasks/tasks.types';
import { lockTaskLease, TaskLeaseUnavailableError } from '../tasks/task-lease';
import { assertCurrentTargets, serviceReleasePolicy } from './release-policy';
import {
  assertAutomaticTargets,
  assertGraphAutomation,
  isGraphTriggerKind,
} from '../execution-graphs/graph-automatic-delivery';
import { lockAvailableArtifacts } from '../artifacts/artifact-availability';
import { DeliveryRecordFilters } from '../projects/delivery-filters';
import { SourceReviewService } from './source-review.service';
import type { ComposeReleaseEvidence } from '../service-configs/compose-template-reference';
import { assertGraphReleaseGate } from '../execution-graphs/graph-release-gates';
import {
  assignedReleasePaths,
  deploymentScopeKey,
  normalizeReleasePath,
  releaseScopeForTarget,
  type ReleaseScope,
} from './deployment-scope';

export type DeploymentHealth = 'NOT_CHECKED' | 'HEALTHY' | 'FAILED' | 'UNKNOWN';
@Injectable()
export class DeploymentsService {
  constructor(
    private readonly database: DatabaseService,
    @Optional() private readonly sourceReviews?: SourceReviewService,
  ) {}
  async currentSnapshot(db: Kysely<Database>, scope: ReleaseScope, serverId: string) {
    return db
      .selectFrom('deployment_records')
      .select([
        'id',
        'deploy_path',
        'release_snapshot_json',
        'compose_release_json',
        'status',
        'activated_at',
      ])
      .where('release_scope_key', '=', deploymentScopeKey(scope, serverId))
      .where((eb) => eb.or([eb('activated_at', 'is not', null), eb('status', '=', 'SUCCESS')]))
      .orderBy(
        (eb) => eb.fn.coalesce('activated_at', 'started_at'),
        (order) => order.desc().nullsLast(),
      )
      .orderBy('id', 'desc')
      .executeTakeFirst();
  }

  async assertGraphReleasePath(db: Kysely<Database>, scope: ReleaseScope, serverId: string) {
    scope = releaseScopeForTarget(scope, serverId);
    if (!scope.graphDeployment) return;
    const path = normalizeReleasePath(scope.definition.deployPath);
    const occupied = await db
      .selectFrom('deployment_records')
      .select('release_scope_key')
      .where('server_id', '=', serverId)
      .where('release_path_key', '=', path)
      .where((eb) => eb.or([eb('activated_at', 'is not', null), eb('status', '=', 'SUCCESS')]))
      .orderBy(
        (eb) => eb.fn.coalesce('activated_at', 'started_at'),
        (order) => order.desc().nullsLast(),
      )
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (occupied && occupied.release_scope_key !== deploymentScopeKey(scope, serverId))
      throw new ConflictException('部署目录已有其他发布，请先核查当前部署方式及归属');
    if (scope.graphDeployment.targetPaths || isProjectReleasePath(path)) {
      const assigned = await assignedReleasePaths(db, scope, [serverId]);
      if (assigned[serverId] && assigned[serverId] !== path)
        throw new ConflictException('该服务的发布位置已变化，请重新预览发布计划');
    }
  }

  async assertAutomaticDelivery(
    taskId: string,
    snapshot: PipelineSnapshot,
    targets?: PipelineTarget[],
  ) {
    const db = this.database.db;
    if (!snapshot.graphAutomation) {
      const linked = await db
        .selectFrom('execution_node_runs as node')
        .innerJoin('execution_flow_runs as run', 'run.id', 'node.run_id')
        .select(['run.trigger_type', 'run.inputs_json'])
        .where('node.task_id', '=', taskId)
        .executeTakeFirst();
      if (
        isGraphTriggerKind(snapshot.graph?.trigger?.kind) ||
        (linked &&
          (isGraphTriggerKind(linked.trigger_type) ||
            isGraphTriggerKind(JSON.parse(linked.inputs_json).trigger?.kind)))
      )
        throw new ConflictException('旧版自动交付任务缺少授权记录，请从触发入口重新提交');
      return;
    }
    const task = await db
      .selectFrom('tasks')
      .select('created_by')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow();
    await assertGraphAutomation(db, snapshot.projectId, task.created_by, snapshot.graphAutomation);
    if (snapshot.mode === 'DEPLOY_ARTIFACT' || snapshot.definition.buildLocation === 'TARGET')
      await assertAutomaticTargets(db, targets ?? []);
  }

  async assertApproval(taskId: string, snapshot: PipelineSnapshot, targets?: PipelineTarget[]) {
    await this.assertAutomaticDelivery(taskId, snapshot, targets);
    const db = this.database.db;
    const { policy } = snapshot.graphDeployment
      ? { policy: { requireApproval: false, requireCodeReview: false } }
      : await serviceReleasePolicy(db, snapshot.serviceId, snapshot.environmentId);
    if (snapshot.graphGate) await assertGraphReleaseGate(db, snapshot, taskId);
    await this.assertSourceReview(snapshot, { db, required: policy.requireCodeReview });
    const requiresApproval = policy.requireApproval || snapshot.releasePolicy?.requireApproval;
    if (!requiresApproval && snapshot.mode !== 'DEPLOY_ARTIFACT') return;
    const automatic = snapshot.triggerType && snapshot.triggerType !== 'MANUAL';
    if (
      targets &&
      (automatic || requiresApproval || snapshot.rollbackOfDeploymentId || snapshot.graphDeployment)
    )
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

  async assertSourceReview(
    snapshot: PipelineSnapshot,
    { db = this.database.db, required }: { db?: Kysely<Database>; required?: boolean } = {},
  ) {
    if (snapshot.graphDeployment) return null;
    if (
      !snapshot.releasePolicy?.requireCodeReview &&
      !(
        required ??
        (await serviceReleasePolicy(db, snapshot.serviceId, snapshot.environmentId)).policy
          .requireCodeReview
      )
    )
      return null;
    if (!this.sourceReviews) throw new ConflictException('代码审核服务不可用');
    return this.sourceReviews.requireReleaseReviewed(snapshot, db, true);
  }

  async activeSnapshot(
    snapshot: PipelineSnapshot,
    serverId: string,
  ): Promise<(PipelineSnapshot & { composeRelease?: ComposeReleaseEvidence }) | undefined> {
    snapshot = releaseScopeForTarget(snapshot, serverId);
    await this.assertGraphReleasePath(this.database.db, snapshot, serverId);
    const current = await this.currentSnapshot(this.database.db, snapshot, serverId);
    if (snapshot.graphDeployment && current && current.status !== 'SUCCESS')
      throw new ConflictException('当前发布状态待核查，暂不能覆盖');
    if (
      !current?.release_snapshot_json ||
      !current.deploy_path ||
      normalizeReleasePath(current.deploy_path) !==
        normalizeReleasePath(snapshot.definition.deployPath)
    )
      return undefined;
    return {
      ...(JSON.parse(current.release_snapshot_json) as PipelineSnapshot),
      composeRelease: current.compose_release_json
        ? (JSON.parse(current.compose_release_json) as ComposeReleaseEvidence)
        : undefined,
    };
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
      .where('release_scope_key', '=', deploymentScopeKey(snapshot, serverId))
      .where('release_snapshot_json', 'is not', null)
      .where('artifact_id', 'is not', null)
      .where('status', '=', 'SUCCESS')
      .where('health_status', '=', 'HEALTHY');
    const current = await this.currentSnapshot(db, snapshot, serverId);
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
      .orderBy(
        (eb) => eb.fn.coalesce('activated_at', 'started_at'),
        (order) => order.desc().nullsLast(),
      )
      .orderBy('id', 'desc')
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
    s = releaseScopeForTarget(s, serverId);
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
      await this.assertGraphReleasePath(tx, s, serverId);
      const previous = await this.currentSnapshot(tx, s, serverId);
      if (s.graphDeployment && previous && previous.status !== 'SUCCESS')
        throw new ConflictException('当前发布状态待核查，暂不能覆盖');
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
          release_path_key: normalizeReleasePath(s.definition.deployPath),
          release_scope_key: deploymentScopeKey(s, serverId),
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

  async assertGraphBuildGate(taskId: string, snapshot: PipelineSnapshot) {
    if (snapshot.graphGate) await assertGraphReleaseGate(this.database.db, snapshot, taskId);
  }

  async assertGraphHealthRequester(taskId: string, projectId: string, serverId: string) {
    const permission = await this.database.db
      .selectFrom('tasks as task')
      .innerJoin('users as requester', 'requester.id', 'task.created_by')
      .innerJoin('execution_node_runs as node', 'node.task_id', 'task.id')
      .innerJoin('execution_flow_runs as run', 'run.id', 'node.run_id')
      .innerJoin('task_targets as target', 'target.task_id', 'task.id')
      .select('task.id')
      .where('task.id', '=', taskId)
      .where('task.status', '=', 'RUNNING')
      .where('run.project_id', '=', projectId)
      .where('run.status', 'in', ['QUEUED', 'RUNNING', 'WAITING'])
      .whereRef('run.created_by', '=', 'requester.id')
      .where('node.node_type', '=', 'HEALTH_CHECK')
      .where('target.server_id', '=', serverId)
      .where('target.status', '=', 'RUNNING')
      .where('requester.role', 'in', ['ADMIN', 'OPERATOR'])
      .where('requester.status', '=', 'ACTIVE')
      .where('requester.must_change_password', '=', 0)
      .executeTakeFirst();
    if (!permission) throw new ConflictException('健康检查发起人权限或运行状态已失效');
  }

  async graphHealthRelease(projectId: string, serverId: string, deploymentId: string) {
    const db = this.database.db;
    const row = await db
      .selectFrom('deployment_records as release')
      .innerJoin('pipeline_runs as run', 'run.id', 'release.pipeline_run_id')
      .innerJoin('tasks as task', 'task.id', 'run.task_id')
      .innerJoin('projects as project', 'project.id', 'run.project_id')
      .select(['release.release_snapshot_json', 'release.deploy_path', 'task.payload_json'])
      .where('release.id', '=', deploymentId)
      .where('run.project_id', '=', projectId)
      .where('project.deleted_at', 'is', null)
      .where('release.server_id', '=', serverId)
      .where('release.status', '=', 'SUCCESS')
      .where('release.activated_at', 'is not', null)
      .executeTakeFirst();
    if (!row?.release_snapshot_json) throw new ConflictException('检查目标没有成功激活的发布记录');
    const snapshot = JSON.parse(row.release_snapshot_json) as PipelineSnapshot;
    const target = (JSON.parse(row.payload_json) as TaskPayload).targets.find(
      (entry) => entry.id === serverId,
    );
    const server = await db
      .selectFrom('servers as server')
      .innerJoin('credentials as credential', 'credential.id', 'server.credential_id')
      .select([
        'server.host',
        'server.port',
        'server.username',
        'server.host_key_fingerprint',
        'server.credential_id',
        'credential.nonce',
      ])
      .where('server.id', '=', serverId)
      .where('server.is_active', '=', 1)
      .where('credential.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (
      !snapshot.graphDeployment ||
      snapshot.projectId !== projectId ||
      !snapshot.releaseKey ||
      !/^[a-f0-9-]{36}$/i.test(snapshot.releaseKey) ||
      !row.deploy_path ||
      normalizeReleasePath(row.deploy_path) !==
        normalizeReleasePath(snapshot.definition.deployPath) ||
      !target?.credentialNonce ||
      !server ||
      target.host !== server.host ||
      target.port !== server.port ||
      target.username !== server.username ||
      target.credentialId !== server.credential_id ||
      target.hostKeyFingerprint !== server.host_key_fingerprint ||
      target.credentialNonce !== server.nonce
    )
      throw new ConflictException('发布位置或服务器身份已失效，请重新确认');
    const current = await this.currentSnapshot(db, snapshot, serverId);
    if (current?.id !== deploymentId) throw new ConflictException('该记录已不是当前激活的发布');
    return { target, snapshot };
  }

  async recordGraphHealth(deploymentId: string, status: DeploymentHealth) {
    await this.database.db
      .updateTable('deployment_records')
      .set({ health_status: status, health_observed_at: Date.now() })
      .where('id', '=', deploymentId)
      .where('status', '=', 'SUCCESS')
      .execute();
  }

  async markActivated(
    id: string,
    lease?: { taskId: string; owner: string },
    composeRelease?: ComposeReleaseEvidence,
  ) {
    await this.database.db.transaction().execute(async (tx) => {
      if (lease && !(await lockTaskLease(tx, lease.taskId, lease.owner)))
        throw new TaskLeaseUnavailableError();
      const active = await tx
        .updateTable('deployment_records')
        .set({
          activated_at: Date.now(),
          ...(composeRelease && { compose_release_json: JSON.stringify(composeRelease) }),
        })
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
      const finishedAt = Date.now();
      let update = tx
        .updateTable('deployment_records')
        .set({
          status,
          ...(artifactId !== undefined && { artifact_id: artifactId }),
          health_status: healthStatus,
          health_observed_at: healthStatus === 'NOT_CHECKED' ? null : finishedAt,
          finished_at: finishedAt,
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
      .leftJoin('task_targets', 'task_targets.id', 'deployment_records.task_target_id')
      .leftJoin('execution_node_runs as node', 'node.task_id', 'pipeline_runs.task_id')
      .leftJoin('execution_flow_runs as flow', (join) =>
        join
          .onRef('flow.id', '=', 'node.run_id')
          .onRef('flow.project_id', '=', 'pipeline_runs.project_id'),
      )
      .selectAll('deployment_records')
      .select([
        'pipeline_runs.project_id',
        'pipeline_runs.commit_sha',
        'pipeline_runs.task_id',
        'artifacts.pruned_at',
        'artifacts.storage_type',
        'task_targets.server_name_snapshot',
        'task_targets.host_snapshot',
        'task_targets.port_snapshot',
        'flow.id as graph_run_id',
        'flow.version as graph_version',
        'flow.flow_name as graph_flow_name',
        'node.name as graph_node_name',
      ])
      .select((eb) =>
        eb
          .selectFrom('deployment_records as active')
          .select('active.id')
          .whereRef('active.release_scope_key', '=', 'deployment_records.release_scope_key')
          .where((filter) =>
            filter.or([
              filter('active.activated_at', 'is not', null),
              filter('active.status', '=', 'SUCCESS'),
            ]),
          )
          .orderBy(
            (value) => value.fn.coalesce('active.activated_at', 'active.started_at'),
            (order) => order.desc().nullsLast(),
          )
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
    if (filters.commit || filters.repositoryId) {
      const sha = filters.commit?.toLowerCase();
      q = q.where((eb) => {
        const matched = eb.exists(
          eb
            .selectFrom('artifact_sources as source')
            .select('source.artifact_id')
            .whereRef('source.artifact_id', '=', 'deployment_records.artifact_id')
            .$if(Boolean(filters.repositoryId), (query) =>
              query.where('source.repository_id', '=', filters.repositoryId!),
            )
            .$if(Boolean(sha), (query) => query.where('source.commit_sha', 'like', sha + '%')),
        );
        return !filters.repositoryId && sha
          ? eb.or([
              matched,
              eb.and([
                eb('artifacts.source_manifest', 'is', null),
                eb('pipeline_runs.commit_sha', 'like', sha + '%'),
              ]),
            ])
          : matched;
      });
    }
    return (await q.orderBy('deployment_records.started_at', 'desc').limit(200).execute()).map(
      (r) => ({
        id: r.id,
        projectId: r.project_id,
        taskId: r.task_id,
        sourceCommit: r.commit_sha,
        pipelineRunId: r.pipeline_run_id,
        artifactId: r.artifact_id,
        graphRunId: r.graph_run_id,
        graphVersion: r.graph_version,
        graphFlowName: r.graph_flow_name,
        graphNodeName: r.graph_run_id ? r.graph_node_name : null,
        serviceId: r.service_id,
        environmentId: r.environment_id,
        serverId: r.server_id,
        serverName: r.server_name_snapshot,
        serverHost: r.host_snapshot,
        serverPort: r.port_snapshot,
        status: r.status,
        releaseVersion: r.release_version,
        deployPath: r.deploy_path,
        composeRelease: r.compose_release_json
          ? (JSON.parse(r.compose_release_json) as ComposeReleaseEvidence)
          : undefined,
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
