import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { graphTaskKeyPrefix } from '../execution-graphs/graph-run-lifecycle';
import { TaskHandlerRegistry } from './task-handler.registry';
import { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import { Database, TaskTargetsTable, TasksTable } from '../../core/database/schema';
import {
  CreateTaskInput,
  TaskExecutionContext,
  TaskPayload,
  terminalTaskStatuses,
} from './tasks.types';
import { TaskLogService, redactTaskLog } from './task-log.service';
import { lockTaskLease, TaskLeaseUnavailableError } from './task-lease';
import type { CurrentUser } from '../auth/auth.decorators';
import { pendingReleaseApprovalTime, serviceReleasePolicy } from '../deployments/release-policy';
import { deploymentScopeKey } from '../deployments/deployment-scope';
import { lockAvailableArtifacts } from '../artifacts/artifact-availability';
import {
  graphUnscopedArtifactService,
  storeDeliveryProfile,
} from '../pipelines/delivery-execution-profile';
import { isStandaloneGraphBuild } from '../pipelines/pipeline.types';
import { lockProjectGraph } from '../projects/project-guards';
import { taskPayloadResourceReferences } from '../projects/project-resource-references';
import { unavailableReference } from '../projects/project-resource-protection';

const terminal = new Set<string>(terminalTaskStatuses);
export const isTerminalStatus = (status: string) => terminal.has(status);
function retryable(task: Selectable<TasksTable>, target: Selectable<TaskTargetsTable>) {
  if (task.idempotency_key?.startsWith('ai-repair:')) return false;
  return (
    (task.task_type === 'COMMAND' || task.task_type === 'OPERATION_PLAN') &&
    isTerminalStatus(task.status) &&
    task.status !== 'NEEDS_ATTENTION' &&
    Boolean(target.server_id) &&
    ((target.status === 'FAILED' && target.exit_code !== null) ||
      (target.status === 'CANCELLED' && target.started_at === null))
  );
}

export function taskDto(task: Selectable<TasksTable>) {
  return presentTask(task, JSON.parse(task.payload_json) as TaskPayload);
}

function presentTask(task: Selectable<TasksTable>, payload: TaskPayload) {
  const pipeline = task.task_type === 'PIPELINE' ? payload.pipeline : undefined;
  const result = task.result_json ? JSON.parse(task.result_json) : null;
  return {
    id: task.id,
    type: task.task_type,
    name: task.name,
    status: task.status,
    createdBy: task.created_by,
    projectId: task.project_id,
    serviceId: task.service_id,
    environmentId: task.environment_id,
    createdAt: task.created_at,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
    errorSummary: task.error_summary,
    result,
    operationPlanVersionId: task.operation_plan_version_id,
    commandTemplate: payload.commandTemplate ?? null,
    retryOf: payload.retryOf ?? null,
    ...(task.task_type === 'PIPELINE'
      ? {
          executionMode: pipeline?.deployAfterBuild ? 'DEPLOY' : (pipeline?.mode ?? 'DEPLOY'),
          deliveryStage: pipeline?.mode === 'BUILD_ONLY' ? 'BUILD' : 'DEPLOY',
          deployAfterBuild: pipeline?.deployAfterBuild ?? false,
          sourceBuildTaskId: pipeline?.sourceBuildTaskId ?? null,
          deploymentTaskId: (result?.deploymentTaskId as string | undefined) ?? null,
          deploymentSkippedReason: (result?.deploymentSkippedReason as string | undefined) ?? null,
          pipelineRunId: pipeline?.runId ?? null,
          triggerType: pipeline?.triggerType ?? 'MANUAL',
          approvalStatus: task.release_approved_by
            ? 'APPROVED'
            : task.status === 'PENDING' && task.available_at === pendingReleaseApprovalTime
              ? 'PENDING'
              : null,
        }
      : {}),
  };
}

@Injectable()
export class TasksService {
  private readonly cancellations = new Map<string, AbortController>();
  constructor(
    private readonly database: DatabaseService,
    private readonly logStore: TaskLogService,
    @Optional() private readonly registry?: TaskHandlerRegistry,
  ) {}
  bindCancellation(id: string, controller: AbortController): () => void {
    this.cancellations.set(id, controller);
    return () => {
      if (this.cancellations.get(id) === controller) this.cancellations.delete(id);
    };
  }
  async create(
    input: CreateTaskInput,
    userId: string,
    beforeInsert?: (tx: Transaction<Database>) => Promise<string | void>,
    afterInsert?: (tx: Transaction<Database>, taskId: string) => Promise<void>,
  ) {
    const taskId = await this.database.db.transaction().execute(async (tx) => {
      if (input.scope?.projectId) await lockProjectGraph(tx);
      const existing = await beforeInsert?.(tx);
      if (!existing && input.scope?.projectId) {
        const references = taskPayloadResourceReferences(
          {
            sourceKind: 'TASK',
            sourceId: input.scope.projectId,
            state: 'PENDING',
            serviceId: input.scope.serviceId,
            environmentId: input.scope.environmentId,
          },
          input.payload,
        );
        const scoped = [
          ...references,
          ...(input.scope.serviceId
            ? [{ resourceType: 'SERVICE' as const, resourceId: input.scope.serviceId }]
            : []),
          ...(input.scope.environmentId
            ? [{ resourceType: 'ENVIRONMENT' as const, resourceId: input.scope.environmentId }]
            : []),
          ...(input.scope.targetId
            ? [{ resourceType: 'LEGACY_TARGET' as const, resourceId: input.scope.targetId }]
            : []),
        ];
        const pipeline = input.payload.pipeline;
        const internalService =
          pipeline?.graph && pipeline.mode === 'BUILD_ONLY'
            ? graphUnscopedArtifactService(input.scope.projectId).id
            : undefined;
        const artifactRootRunId =
          pipeline?.mode === 'DEPLOY_ARTIFACT' &&
          input.idempotencyKey?.startsWith(graphTaskKeyPrefix)
            ? pipeline.artifactRootRunId
            : undefined;
        const projectResources = scoped.filter(
          ({ resourceId, resourceType }) =>
            resourceType !== 'SERVICE' || resourceId !== internalService,
        );
        if (
          await unavailableReference(tx, input.scope.projectId, projectResources, {
            artifactRootRunId,
          })
        )
          throw new ConflictException('任务引用的资源已变化，请重新预览');
      }
      const id = existing || (await this.createInTransaction(tx, input, userId));
      await afterInsert?.(tx, id);
      return id;
    });
    return this.get(taskId);
  }
  async createInTransaction(tx: Transaction<Database>, input: CreateTaskInput, userId: string) {
    const targets = input.payload.targets;
    if (
      (!targets.length &&
        input.type !== 'GRAPH_MODULE' &&
        !isStandaloneGraphBuild(input.payload.pipeline)) ||
      new Set(targets.map((target) => target.id)).size !== targets.length
    )
      throw new BadRequestException('任务目标必须明确指定且不能重复');
    const id = randomUUID();
    const now = Date.now();
    if (input.registrationProfile)
      await storeDeliveryProfile(tx, input.registrationProfile, userId);
    const pipeline = input.payload.pipeline;
    if (pipeline?.deploymentArtifacts?.length)
      await lockAvailableArtifacts(
        tx,
        pipeline.deploymentArtifacts.map((artifact) => artifact.id),
      );
    let payload = input.payload;
    if (pipeline && targets.some((target) => target.credentialId && !target.credentialNonce)) {
      const ids = [
        ...new Set(targets.flatMap((target) => (target.credentialId ? [target.credentialId] : []))),
      ];
      const credentials = await tx
        .selectFrom('credentials')
        .select(['id', 'nonce'])
        .where('id', 'in', ids)
        .where('status', '=', 'ACTIVE')
        .execute();
      const versions = new Map(credentials.map((credential) => [credential.id, credential.nonce]));
      payload = {
        ...payload,
        targets: targets.map((target) => ({
          ...target,
          credentialNonce: target.credentialNonce ?? versions.get(target.credentialId ?? ''),
        })),
      };
    }
    let availableAt = now;
    if (input.type === 'PIPELINE' && pipeline && pipeline.mode !== 'BUILD_ONLY') {
      const { policy } = await serviceReleasePolicy(tx, pipeline.serviceId, pipeline.environmentId);
      const requireApproval =
        policy.requireApproval || Boolean(pipeline.releasePolicy?.requireApproval);
      const requireCodeReview = Boolean(
        policy.requireCodeReview || pipeline.releasePolicy?.requireCodeReview,
      );
      const releasePolicy = pipeline.rollbackOfDeploymentId
        ? {
            ...(pipeline.releasePolicy ?? policy),
            requireApproval,
            requireCodeReview,
            rollbackMode: 'OFF' as const,
          }
        : { ...policy, requireApproval, requireCodeReview };
      payload = { ...payload, pipeline: { ...pipeline, releasePolicy } };
      if (requireApproval) availableAt = pendingReleaseApprovalTime;
    }
    const inserted = await tx
      .insertInto('tasks')
      .values({
        id,
        task_type: input.type,
        name: input.name,
        created_by: userId,
        operation_plan_version_id: input.operationPlanVersionId ?? null,
        project_id: input.scope?.projectId ?? null,
        service_id: input.scope?.serviceId ?? null,
        environment_id: input.scope?.environmentId ?? null,
        target_id: input.scope?.targetId ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        payload_json: JSON.stringify(payload),
        created_at: now,
        updated_at: now,
        available_at: availableAt,
        log_file_key: this.logStore.key(id, now),
      })
      .onConflict((conflict) => conflict.column('idempotency_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      const existing = await tx
        .selectFrom('tasks')
        .select('id')
        .where('idempotency_key', '=', input.idempotencyKey!)
        .executeTakeFirstOrThrow();
      return existing.id;
    }
    if (targets.length)
      await tx
        .insertInto('task_targets')
        .values(
          targets.map((target) => ({
            id: randomUUID(),
            task_id: id,
            server_id: target.id,
            server_name_snapshot: target.name,
            release_scope_key:
              input.type === 'PIPELINE' &&
              pipeline?.mode === 'DEPLOY_ARTIFACT' &&
              (pipeline.graphDeployment || pipeline.rollbackOfDeploymentId)
                ? deploymentScopeKey(pipeline, target.id)
                : null,
            host_snapshot: target.host,
            port_snapshot: target.port,
            username_snapshot: target.username,
            credential_id_snapshot: target.credentialId,
            fingerprint_snapshot: target.hostKeyFingerprint,
          })),
        )
        .execute();
    // Graph artifact producers keep their authored task scope while recording
    // delivery history against the backing service and environment.
    const deliveryServiceId = input.registrationProfile?.serviceId ?? input.scope?.serviceId;
    const deliveryEnvironmentId = input.registrationProfile
      ? pipeline?.environmentId
      : input.scope?.environmentId;
    if (input.pipelineRun && input.scope?.projectId && deliveryServiceId && deliveryEnvironmentId) {
      const run = input.pipelineRun;
      await tx
        .insertInto('pipeline_runs')
        .values({
          id: run.id,
          task_id: id,
          pipeline_id: run.pipelineId,
          pipeline_version_id: run.pipelineVersionId,
          project_id: input.scope.projectId,
          service_id: deliveryServiceId,
          environment_id: deliveryEnvironmentId,
          target_id: input.scope.targetId ?? null,
          target_selection_json: payload.pipeline?.targetSelection
            ? JSON.stringify(payload.pipeline.targetSelection)
            : null,
          git_ref: run.gitRef,
          commit_sha: run.commitSha,
          build_location_snapshot: run.buildLocation,
          artifact_type_snapshot: run.artifactType,
          trigger_type: run.triggerType ?? 'MANUAL',
          created_at: now,
        })
        .execute();
    }
    return id;
  }
  async list(type?: string) {
    let query = this.database.db.selectFrom('tasks').selectAll();
    if (type) query = query.where('task_type', '=', type);
    return (await query.orderBy('created_at', 'desc').limit(100).execute()).map(taskDto);
  }
  async row(id: string) {
    const task = await this.database.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!task) throw new NotFoundException('任务不存在');
    return task;
  }
  async get(id: string) {
    const task = await this.row(id);
    const payload = JSON.parse(task.payload_json) as TaskPayload;
    const definition = task.task_type === 'PIPELINE' ? payload.pipeline?.definition : undefined;
    return {
      ...presentTask(task, payload),
      ...(this.reusableCommand(task.task_type, payload) && { canReuseCommand: true as const }),
      ...(definition?.nodes?.length && {
        pipelineGraph: {
          buildLocation: definition.buildLocation,
          nodes: definition.nodes.map(({ id, type, name }) => ({ id, type, name })),
        },
      }),
    };
  }

  private reusableCommand(type: string, payload: TaskPayload) {
    const command = payload.steps?.[0]?.command;
    return type === 'COMMAND' &&
      payload.steps?.length === 1 &&
      command &&
      !payload.commandTemplate &&
      !payload.graphModule &&
      !payload.aiRepair &&
      !payload.environment &&
      redactTaskLog(command) === command
      ? command
      : undefined;
  }

  async commandReuse(id: string, user: CurrentUser) {
    const task = await this.row(id);
    if (user.role !== 'ADMIN' && task.created_by !== user.id)
      throw new ForbiddenException('仅执行者和管理员可以沿用该命令');
    const payload = JSON.parse(task.payload_json) as TaskPayload;
    const command = this.reusableCommand(task.task_type, payload);
    if (!command) throw new BadRequestException('该任务没有可沿用的临时命令');
    return {
      name: task.name,
      command,
      timeout: payload.timeout,
      strategy: payload.strategy,
      maxParallel: payload.maxParallel,
      failurePolicy: payload.failurePolicy,
      selection: payload.commandSelection?.targets ?? {
        serverIds: payload.targets.map(({ id }) => id),
      },
      previousTargetHash: payload.commandSelection?.confirmedTargetHash,
      previousTargets: payload.targets.map(({ id, name, host }) => ({ id, name, host })),
    };
  }
  async targets(id: string, user?: CurrentUser) {
    const task = await this.row(id);
    const snapshot = JSON.parse(task.payload_json) as TaskPayload;
    const versionedTargets = new Set(
      snapshot.targets?.filter((target) => target.credentialNonce).map((target) => target.id),
    );
    const rows = await this.database.db
      .selectFrom('task_targets')
      .selectAll()
      .where('task_id', '=', id)
      .orderBy('server_name_snapshot')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name_snapshot,
      host: row.host_snapshot,
      status: row.status,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorSummary: row.error_summary,
      canRetry:
        !!user &&
        (user.role === 'ADMIN' || (user.role === 'OPERATOR' && task.created_by === user.id)) &&
        retryable(task, row) &&
        versionedTargets.has(row.server_id!),
    }));
  }
  async retryTarget(id: string, targetId: string, user: CurrentUser) {
    const task = await this.row(id);
    if (user.role !== 'ADMIN' && (user.role !== 'OPERATOR' || task.created_by !== user.id))
      throw new ForbiddenException('只能重试本人提交的任务');
    const target = await this.database.db
      .selectFrom('task_targets')
      .selectAll()
      .where('task_id', '=', id)
      .where('id', '=', targetId)
      .executeTakeFirst();
    if (!target) throw new NotFoundException('任务目标不存在');
    if (!retryable(task, target)) throw new ConflictException('此目标的执行结果不允许重试');
    const payload = JSON.parse(task.payload_json) as TaskPayload;
    const previous = payload.targets.find((item) => item.id === target.server_id);
    if (!previous?.credentialNonce)
      throw new ConflictException('原任务缺少可核对的 SSH 快照，请重新提交');
    return this.create(
      {
        type: task.task_type === 'OPERATION_PLAN' ? 'OPERATION_PLAN' : 'COMMAND',
        name: task.name.startsWith('重试 · ') ? task.name : `重试 · ${task.name}`,
        operationPlanVersionId: task.operation_plan_version_id ?? undefined,
        idempotencyKey: `retry:${targetId}`,
        scope: {
          projectId: task.project_id ?? undefined,
          serviceId: task.service_id ?? undefined,
          environmentId: task.environment_id ?? undefined,
          targetId: task.target_id ?? undefined,
        },
        payload: {
          ...payload,
          targets: [previous],
          strategy: 'SEQUENTIAL',
          maxParallel: 1,
          retryOf: { taskId: id, targetId },
        },
      },
      user.id,
      async (tx) => {
        const current = await tx
          .selectFrom('servers as s')
          .innerJoin('credentials as c', 'c.id', 's.credential_id')
          .select([
            's.host',
            's.port',
            's.username',
            's.credential_id',
            's.host_key_fingerprint',
            'c.nonce',
          ])
          .where('s.id', '=', previous.id)
          .where('s.is_active', '=', 1)
          .where('c.status', '=', 'ACTIVE')
          .where('c.type', 'in', ['SSH_PASSWORD', 'SSH_KEY'])
          .executeTakeFirst();
        if (
          !current ||
          current.host !== previous.host ||
          current.port !== previous.port ||
          current.username !== previous.username ||
          current.credential_id !== previous.credentialId ||
          current.host_key_fingerprint !== previous.hostKeyFingerprint ||
          current.nonce !== previous.credentialNonce
        )
          throw new ConflictException('服务器或 SSH 凭据已变化，请重新选择目标提交任务');
        if (
          task.project_id &&
          !(await tx
            .selectFrom('projects')
            .select('id')
            .where('id', '=', task.project_id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst())
        )
          throw new ConflictException('任务关联的项目已删除');
      },
    );
  }
  async steps(id: string) {
    await this.row(id);
    return (
      await this.database.db
        .selectFrom('task_steps')
        .selectAll()
        .where('task_id', '=', id)
        .orderBy('step_order')
        .execute()
    ).map((row) => ({
      id: row.id,
      targetId: row.task_target_id,
      serverId: row.execution_target_key,
      key: row.step_key,
      name: (JSON.parse(row.input_json) as { name?: string }).name ?? row.step_key,
      order: row.step_order,
      status: row.status,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  }
  async logs(id: string, offset = 0) {
    return this.logStore.read((await this.row(id)).log_file_key, offset);
  }
  async recentLog(id: string) {
    return this.logStore.tail((await this.row(id)).log_file_key);
  }
  async cancel(id: string, reconcileGraph = true) {
    const row = await this.row(id);
    if (isTerminalStatus(row.status)) throw new BadRequestException('已结束的任务不能取消');
    const now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      const pending = await tx
        .updateTable('tasks')
        .set({ status: 'CANCELLED', cancel_requested_at: now, finished_at: now, updated_at: now })
        .where('id', '=', id)
        .where('status', '=', 'PENDING')
        .returning('id')
        .executeTakeFirst();
      if (pending) {
        await tx
          .updateTable('task_targets')
          .set({ status: 'CANCELLED', finished_at: now })
          .where('task_id', '=', id)
          .where('status', '=', 'PENDING')
          .execute();
      } else
        await tx
          .updateTable('tasks')
          .set({ status: 'CANCEL_REQUESTED', cancel_requested_at: now, updated_at: now })
          .where('id', '=', id)
          .where('status', 'in', ['RUNNING', 'CANCEL_REQUESTED'])
          .execute();
    });
    this.cancellations.get(id)?.abort();
    if (reconcileGraph && row.idempotency_key?.startsWith(graphTaskKeyPrefix))
      await this.registry?.advanceGraphRuns(id)?.catch(() => undefined);
    return this.get(id);
  }
  context(task: Selectable<TasksTable>, signal: AbortSignal): TaskExecutionContext {
    const owner = task.lease_owner!;
    return {
      signal,
      leaseOwner: owner,
      log: (text, serverId) => {
        this.logStore.append(
          task.id,
          task.log_file_key!,
          serverId ? `[${serverId}] ${text}` : text,
        );
      },
      startTarget: (serverId) =>
        this.database.db.transaction().execute(async (tx) => {
          if (signal.aborted || !(await lockTaskLease(tx, task.id, owner)))
            throw new TaskLeaseUnavailableError();
          const row = await tx
            .updateTable('task_targets')
            .set({ status: 'RUNNING', started_at: Date.now() })
            .where('task_id', '=', task.id)
            .where('server_id', '=', serverId)
            .where('status', '=', 'PENDING')
            .returning('id')
            .executeTakeFirstOrThrow();
          return row.id;
        }),
      finishTarget: (targetId, status, exitCode, error) =>
        this.database.db.transaction().execute(async (tx) => {
          if (!(await lockTaskLease(tx, task.id, owner, true))) return;
          await tx
            .updateTable('task_targets')
            .set({
              status,
              exit_code: exitCode,
              error_summary: error ?? null,
              finished_at: Date.now(),
            })
            .where('id', '=', targetId)
            .where('task_id', '=', task.id)
            .where('status', '=', 'RUNNING')
            .execute();
        }),
      startStep: (targetId, serverId, step, index) =>
        this.database.db.transaction().execute(async (tx) => {
          if (signal.aborted || !(await lockTaskLease(tx, task.id, owner)))
            throw new TaskLeaseUnavailableError();
          const id = randomUUID();
          await tx
            .insertInto('task_steps')
            .values({
              id,
              task_id: task.id,
              task_target_id: targetId,
              execution_target_key: serverId,
              step_key: step.key ?? `${index + 1}:${step.name}`,
              step_order: index,
              step_type: 'SSH_COMMAND',
              status: 'RUNNING',
              input_json: JSON.stringify({ name: step.name, timeout: step.timeout }),
              started_at: Date.now(),
            })
            .execute();
          return id;
        }),
      finishStep: (stepId, status, exitCode, error) =>
        this.database.db.transaction().execute(async (tx) => {
          if (!(await lockTaskLease(tx, task.id, owner, true))) return;
          await tx
            .updateTable('task_steps')
            .set({
              status,
              exit_code: exitCode,
              result_json: error ? JSON.stringify({ error }) : null,
              finished_at: Date.now(),
            })
            .where('id', '=', stepId)
            .where('task_id', '=', task.id)
            .where('status', '=', 'RUNNING')
            .execute();
        }),
    };
  }
}
