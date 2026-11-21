import { PipelineTriggersService } from '../pipeline-triggers/pipeline-triggers.service';
import { AiFailureHandlingService } from '../ai/ai-failure-handling.service';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database, TasksTable } from '../../core/database/schema';
import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
import { TaskHandlerRegistry } from './task-handler.registry';
import { TasksService } from './tasks.service';
import { redactTaskLog, TaskLogService } from './task-log.service';
import type { TaskHandler, TaskPayload, TaskRecord, TaskStatus } from './tasks.types';
import { lockTaskLease, TaskLeaseUnavailableError } from './task-lease';
import { graphTaskKeyPrefix } from '../execution-graphs/graph-run-lifecycle';
import { SystemSettingsService } from '../system/system-settings.service';
import { ArtifactRetentionService } from '../artifacts/artifact-retention.service';
import { OperationSchedulesService } from '../operation-schedules/operation-schedules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SshExecutionError } from '../../infrastructure/ssh/ssh.service';
import { isStandaloneGraphBuild } from '../pipelines/pipeline.types';

const TASK_LEASE_MS = 60_000;
const SQLITE_LEASE_MS = 45_000;
const WORKER_KEY = 'worker:sqlite-owner';
const EXECUTION_INTERRUPTED = '执行进程中断，远程执行结果需人工核查';
const EXECUTION_FAILED = '执行记录未完整保存，远程执行结果需人工核查';
const LOG_FAILED = '任务日志存储失败，远程执行结果需人工核查';
const CANCELLED = '任务已取消';
const LOG_PRUNE_INTERVAL_MS = 60 * 60_000;
const ARTIFACT_PRUNE_INTERVAL_MS = 60 * 60_000;
const MAX_GRAPH_TASKS_PER_WORKER = 3;

@Injectable()
export class TaskWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('TaskWorker');
  private readonly owner = randomUUID();
  private readonly shutdownController = new AbortController();
  private timer?: NodeJS.Timeout;
  private evaluatingTriggers?: Promise<void>;
  private diagnosing?: Promise<void>;
  private cleaningArtifacts?: Promise<void>;
  private cleanupController?: AbortController;
  private polling?: Promise<void>;
  private readonly activeJobs = new Map<
    string,
    {
      running: Promise<void>;
      controller: AbortController;
      graph: boolean;
    }
  >();
  private shutdownPromise?: Promise<void>;
  private stopping = false;
  private sqliteLeaseLost = false;
  private nextLogPruneAt = 0;
  private nextArtifactPruneAt = Date.now() + ARTIFACT_PRUNE_INTERVAL_MS;
  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: TasksService,
    private readonly registry: TaskHandlerRegistry,
    private readonly logs: TaskLogService,
    @Optional() private readonly settings?: SystemSettingsService,
    @Optional() private readonly artifactRetention?: ArtifactRetentionService,
    @Optional() private readonly schedules?: OperationSchedulesService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly triggers?: PipelineTriggersService,
    @Optional() private readonly failures?: AiFailureHandlingService,
  ) {}
  onApplicationBootstrap() {
    if (process.env.WORKER_ENABLED !== 'false') this.start();
  }
  start(keepAlive = false) {
    if (this.stopping) return;
    this.timer ??= setInterval(() => {
      void this.tick().catch((error: Error) => this.logger.error(error.message));
    }, 1000);
    if (keepAlive) this.timer.ref();
    else this.timer.unref();
  }
  onModuleDestroy() {
    return this.shutdown();
  }
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.stop();
    return this.shutdownPromise;
  }
  private async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.shutdownController.abort();
    for (const job of this.activeJobs.values()) job.controller.abort();
    await this.polling?.catch(() => undefined);
    await this.evaluatingTriggers;
    await this.diagnosing;
    await this.cleaningArtifacts;
    await Promise.all([...this.activeJobs.values()].map((job) => job.running));
    if (this.database.client === 'sqlite') {
      await this.database.db
        .deleteFrom('system_settings')
        .where('key', '=', WORKER_KEY)
        .where('value_json', '=', JSON.stringify(this.owner))
        .execute()
        .catch(() => undefined);
    }
  }
  private async ownSqliteLease(): Promise<boolean> {
    if (this.database.client !== 'sqlite') return true;
    const now = Date.now();
    const owner = JSON.stringify(this.owner);
    await this.database.db
      .insertInto('system_settings')
      .values({ key: WORKER_KEY, value_json: owner, updated_at: now })
      .onConflict((conflict) => conflict.column('key').doNothing())
      .execute();
    const row = await this.database.db
      .updateTable('system_settings')
      .set({ value_json: owner, updated_at: now })
      .where('key', '=', WORKER_KEY)
      .where((eb) =>
        eb.or([eb('value_json', '=', owner), eb('updated_at', '<', now - SQLITE_LEASE_MS)]),
      )
      .returning('key')
      .executeTakeFirst();
    return Boolean(row);
  }
  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.polling ??= this.poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private async poll() {
    if (!(await this.ownSqliteLease())) {
      this.cleanupController?.abort();
      if (this.activeJobs.size) {
        this.sqliteLeaseLost = true;
        for (const job of this.activeJobs.values()) job.controller.abort();
      }
      return;
    }
    if (!this.stopping && this.triggers) {
      this.evaluatingTriggers ??= this.triggers
        .tick()
        .catch(() => this.logger.warn('自动构建触发检查失败，将在下一轮重试'))
        .finally(() => {
          this.evaluatingTriggers = undefined;
        });
    }
    await this.recoverExpired();
    if (!this.stopping) {
      await this.registry
        .tickGraphTriggers()
        ?.catch(() => this.logger.warn('执行图触发器检查失败，将在下一轮重试'));
    }
    if (!this.stopping) await this.advanceGraphRuns();
    if (this.failures && !this.stopping) {
      this.diagnosing ??= this.failures
        .tick(this.shutdownController.signal)
        .catch(() => this.logger.warn('故障诊断调度暂不可用'))
        .finally(() => {
          this.diagnosing = undefined;
        });
    }
    if (!this.stopping && this.schedules) {
      try {
        await this.schedules.tick();
      } catch {
        this.logger.warn('定时运维评估失败，将在下一轮重试');
      }
    }
    await this.pruneLogs();
    await this.pruneArtifacts();
    this.tickArtifactCleanup();
    if (!this.activeJobs.size) this.sqliteLeaseLost = false;
    while (
      !this.stopping &&
      !this.sqliteLeaseLost &&
      this.activeJobs.size < MAX_GRAPH_TASKS_PER_WORKER &&
      [...this.activeJobs.values()].every((job) => job.graph)
    ) {
      const task = await this.claim(true, this.activeJobs.size > 0);
      if (!task) return;
      const controller = new AbortController();
      const running = this.execute(task, controller)
        .catch(() => this.logger.error('任务状态写入失败，租约过期后将进入人工核查'))
        .finally(() => {
          this.activeJobs.delete(task.id);
        });
      this.activeJobs.set(task.id, {
        controller,
        running,
        graph: task.idempotency_key?.startsWith(graphTaskKeyPrefix) === true,
      });
    }
  }
  private async pruneArtifacts() {
    if (
      !this.artifactRetention ||
      this.stopping ||
      this.activeJobs.size > 0 ||
      Date.now() < this.nextArtifactPruneAt
    )
      return;
    this.nextArtifactPruneAt = Date.now() + ARTIFACT_PRUNE_INTERVAL_MS;
    try {
      await this.artifactRetention.pruneExpired();
    } catch {
      this.logger.warn('构建产物保留规则执行失败，将在下次调度重试');
    }
  }

  private tickArtifactCleanup() {
    if (this.stopping || !this.artifactRetention || this.cleaningArtifacts) return;
    const controller = new AbortController();
    this.cleanupController = controller;
    const signal = AbortSignal.any([this.shutdownController.signal, controller.signal]);
    this.cleaningArtifacts = this.artifactRetention
      .tickCleanup(signal)
      .catch(() => this.logger.warn('实物清理任务将等待后续调度'))
      .finally(() => {
        this.cleanupController = undefined;
        this.cleaningArtifacts = undefined;
      });
  }

  private async pruneLogs() {
    if (!this.settings || this.stopping || Date.now() < this.nextLogPruneAt) return;
    this.nextLogPruneAt = Date.now() + LOG_PRUNE_INTERVAL_MS;
    try {
      const settings = this.settings;
      const policies = await settings.logRetentionPolicies();
      if (!policies.systemDays && ![...policies.projectDays.values()].some((days) => days > 0)) {
        this.nextLogPruneAt = Date.now() + 60_000;
        return;
      }
      const result = await this.logs.pruneExpired(this.database.db, policies, Date.now(), (tx) =>
        settings.logRetentionPolicies(tx),
      );
      if (result.more) this.nextLogPruneAt = Date.now() + 60_000;
      if (result.failed) this.logger.warn(`本轮有 ${result.failed} 份过期任务日志清理失败`);
    } catch {
      this.logger.warn('任务日志保留策略执行失败，下次周期将重试');
    }
  }
  async claim(requireSqliteLease = false, parallelGraph = false) {
    // The conditional UPDATE is atomic in both dialects. Remote work never holds a DB transaction.
    const candidate = await this.database.db
      .selectFrom('tasks')
      .select(['id', 'idempotency_key'])
      .where('status', '=', 'PENDING')
      .where('available_at', '<=', Date.now())
      .orderBy('priority', 'desc')
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    if (!candidate || (parallelGraph && !candidate.idempotency_key?.startsWith(graphTaskKeyPrefix)))
      return undefined;
    const now = Date.now();
    let claim = this.database.db
      .updateTable('tasks')
      .set((eb) => ({
        status: 'RUNNING',
        lease_owner: this.owner,
        lease_expires_at: now + TASK_LEASE_MS,
        heartbeat_at: now,
        started_at: now,
        updated_at: now,
        attempt_count: eb('attempt_count', '+', 1),
      }))
      .where('id', '=', candidate.id)
      .where('status', '=', 'PENDING');
    if (requireSqliteLease && this.database.client === 'sqlite') {
      let conflicts = this.database.db
        .selectFrom('tasks as active')
        .select('active.id')
        .where('active.status', 'in', ['RUNNING', 'CANCEL_REQUESTED']);
      if (parallelGraph)
        conflicts = conflicts.where((active) =>
          active.or([
            active('active.lease_owner', 'is', null),
            active('active.lease_owner', '!=', this.owner),
            active('active.idempotency_key', 'is', null),
            active('active.idempotency_key', 'not like', graphTaskKeyPrefix + '%'),
          ]),
        );
      claim = claim.where((eb) =>
        eb.and([
          eb.exists(
            eb
              .selectFrom('system_settings')
              .select('key')
              .where('key', '=', WORKER_KEY)
              .where('value_json', '=', JSON.stringify(this.owner))
              .where('updated_at', '>=', now - SQLITE_LEASE_MS),
          ),
          eb.not(eb.exists(conflicts)),
        ]),
      );
    }
    return claim.returningAll().executeTakeFirst();
  }
  async recoverExpired() {
    const now = Date.now();
    // The parent and its execution/deployment records must move together; otherwise a
    // process crash between updates could leave RUNNING history that is never revisited.
    const graphTasks = await this.database.db.transaction().execute(async (tx) => {
      const expired = await tx
        .updateTable('tasks')
        .set({
          status: 'NEEDS_ATTENTION',
          error_summary: 'Worker 租约过期，远程写操作结果不确定；请核查后决定后续操作',
          finished_at: now,
          updated_at: now,
          lease_owner: null,
          lease_expires_at: null,
        })
        .where('status', 'in', ['RUNNING', 'CANCEL_REQUESTED'])
        .where('lease_expires_at', '<', now)
        .returning(['id', 'idempotency_key'])
        .execute();
      for (const task of expired) {
        await this.settleExecutionRows(tx, task.id, now, 'NEEDS_ATTENTION', EXECUTION_INTERRUPTED);
        await this.notifications?.recordTaskCompletion(tx, task.id, now);
        await this.failures?.completion(tx, task.id, now);
      }
      return expired.filter((task) => task.idempotency_key?.startsWith(graphTaskKeyPrefix));
    });
    for (const task of graphTasks) await this.advanceGraphRuns(task.id);
  }
  private async advanceGraphRuns(taskId?: string) {
    try {
      await this.registry.advanceGraphRuns(taskId);
    } catch {
      this.logger.warn('执行图调度暂不可用，将在下一轮重试');
    }
  }
  private async execute(task: Selectable<TasksTable>, controller: AbortController) {
    const unbind = this.tasks.bindCancellation(task.id, controller);
    const context = this.tasks.context(task, controller.signal);
    let lostLease = false;
    let heartbeatInProgress: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      heartbeatInProgress ??= this.heartbeat(task.id, controller)
        .catch(() => {
          lostLease = true;
          controller.abort();
        })
        .finally(() => {
          heartbeatInProgress = undefined;
        });
    }, 1000);

    let record: TaskRecord | undefined;
    let handler: TaskHandler | undefined;
    let failure: { cause: unknown } | undefined;
    let finalized = false;
    let result: Awaited<ReturnType<TaskHandler['execute']>> = undefined;
    try {
      try {
        await this.heartbeat(task.id, controller);
        if (this.stopping) controller.abort();
        record = {
          id: task.id,
          type: task.task_type,
          name: task.name,
          payload: JSON.parse(task.payload_json) as TaskPayload,
        };
        handler = this.registry.get(task.task_type);
        const origin = record.payload.aiRepair;
        if (origin) {
          if (!this.failures) throw new Error('修复权限检查不可用');
          await this.failures.authorizeRepair(origin, task.id);
          const startStep = context.startStep;
          context.startStep = async (...args) => {
            await this.failures!.authorizeRepair(origin, task.id);
            return startStep(...args);
          };
        }
        if (!controller.signal.aborted) {
          context.log(
            `任务开始：${task.name}\n目标快照已固定，${record.payload.targets.length} 台服务器\n`,
          );
          result = await handler.execute(record, context);
        }
      } catch (cause) {
        failure = { cause };
      }
      const completedRecord = record;
      const onFinalize = handler?.onFinalize;
      finalized = await this.finalize(
        task,
        failure,
        this.stopping || lostLease || this.sqliteLeaseLost,
        completedRecord && onFinalize
          ? (tx, status) => onFinalize(tx, completedRecord, task.created_by, status)
          : undefined,
        result,
      );
    } finally {
      clearInterval(heartbeat);
      unbind();
      await heartbeatInProgress;
    }
    if (finalized && !this.stopping && task.idempotency_key?.startsWith(graphTaskKeyPrefix))
      await this.advanceGraphRuns(task.id);

    if (
      finalized &&
      record &&
      handler?.afterCompletion &&
      !this.shutdownController.signal.aborted
    ) {
      try {
        await handler.afterCompletion(record, this.shutdownController.signal);
      } catch {
        this.logger.warn('任务已结束，后续分析未完成');
      }
    }
  }

  private async heartbeat(taskId: string, controller: AbortController) {
    const row = await this.database.db.transaction().execute(async (tx) => {
      if (!(await lockTaskLease(tx, taskId, this.owner, true))) {
        throw new TaskLeaseUnavailableError();
      }
      const now = Date.now();
      return tx
        .updateTable('tasks')
        .set({ heartbeat_at: now, lease_expires_at: now + TASK_LEASE_MS, updated_at: now })
        .where('id', '=', taskId)
        .returning('status')
        .executeTakeFirstOrThrow();
    });
    if (row.status === 'CANCEL_REQUESTED') controller.abort();
  }

  private finalize(
    task: Selectable<TasksTable>,
    failure: { cause: unknown } | undefined,
    interrupted: boolean,
    onFinalize?: (
      tx: Transaction<Database>,
      status: TaskStatus,
    ) => Promise<{ deploymentTaskId?: string; deploymentSkippedReason?: string } | undefined>,
    result?: void | { graphOutputs: Record<string, unknown> },
  ) {
    return this.database.db.transaction().execute(async (tx) => {
      if (!(await lockTaskLease(tx, task.id, this.owner, true))) return false;
      const parent = await tx
        .selectFrom('tasks')
        .select('status')
        .where('id', '=', task.id)
        .executeTakeFirstOrThrow();
      const cancelled = parent.status === 'CANCEL_REQUESTED';
      const targets = await tx
        .selectFrom('task_targets')
        .select(['status', 'error_summary'])
        .where('task_id', '=', task.id)
        .orderBy('server_name_snapshot')
        .execute();
      const activeStep = await tx
        .selectFrom('task_steps')
        .select('id')
        .where('task_id', '=', task.id)
        .where('status', '=', 'RUNNING')
        .executeTakeFirst();
      const activeDeployment = await tx
        .selectFrom('deployment_records')
        .select('id')
        .where(
          'task_target_id',
          'in',
          tx.selectFrom('task_targets').select('id').where('task_id', '=', task.id),
        )
        .where('status', '=', 'RUNNING')
        .executeTakeFirst();

      const executionFailed = Boolean(
        failure && !(cancelled && failure.cause instanceof TaskLeaseUnavailableError),
      );
      const graphModule =
        task.task_type === 'GRAPH_MODULE' ||
        (task.task_type === 'PIPELINE' &&
          !targets.length &&
          isStandaloneGraphBuild((JSON.parse(task.payload_json) as TaskPayload).pipeline));
      const graphHealth = Boolean(
        result &&
        task.task_type === 'GRAPH_MODULE' &&
        (JSON.parse(task.payload_json) as TaskPayload).graphModule?.type === 'HEALTH_CHECK',
      );
      const healthNeedsAttention =
        graphHealth && targets.some(({ status }) => status === 'NEEDS_ATTENTION');
      const abandoned =
        !cancelled &&
        (Boolean(activeStep || activeDeployment) ||
          targets.some((target) => target.status === 'RUNNING'));
      const workerInterrupted = interrupted || this.stopping || this.sqliteLeaseLost;
      const sshError =
        graphModule && failure?.cause instanceof SshExecutionError ? failure.cause : undefined;
      let uncertain =
        workerInterrupted ||
        (executionFailed && !graphModule) ||
        abandoned ||
        sshError?.kind === 'NEEDS_ATTENTION';
      let status = uncertain
        ? 'NEEDS_ATTENTION'
        : graphModule
          ? cancelled
            ? 'CANCELLED'
            : executionFailed
              ? (sshError?.kind ?? 'FAILED')
              : healthNeedsAttention
                ? 'NEEDS_ATTENTION'
                : 'SUCCESS'
          : aggregateStatus(
              targets.map((target) => target.status),
              cancelled,
            );
      const targetError = targets.find(
        (target) => target.status === status && target.error_summary,
      )?.error_summary;
      let error: string | null = null;
      if (workerInterrupted) error = EXECUTION_INTERRUPTED;
      else if (uncertain) error = EXECUTION_FAILED;
      else if (status === 'CANCELLED') error = targetError ?? CANCELLED;
      else if (graphModule && executionFailed) error = '执行图功能节点失败，请查看任务日志';
      else if (status !== 'SUCCESS') {
        error =
          targetError ??
          targets.find((target) => target.error_summary)?.error_summary ??
          '部分目标未成功执行';
      }

      let size = task.log_size_bytes;
      try {
        if (task.log_file_key)
          size = this.logs.append(task.id, task.log_file_key, `\n任务结束：${status}\n`);
      } catch {
        this.logger.warn(LOG_FAILED);
        status = 'NEEDS_ATTENTION';
        error = LOG_FAILED;
        uncertain = true;
      }

      const now = Date.now();
      const unfinishedStatus = status === 'NEEDS_ATTENTION' ? status : 'CANCELLED';
      const unfinishedMessage =
        status === 'NEEDS_ATTENTION'
          ? (error ?? EXECUTION_FAILED)
          : cancelled
            ? CANCELLED
            : '因失败停止策略未执行';
      await this.settleExecutionRows(
        tx,
        task.id,
        now,
        unfinishedStatus,
        unfinishedMessage,
        uncertain,
      );
      const continuation = await onFinalize?.(tx, status);
      await tx
        .updateTable('tasks')
        .set({
          status,
          error_summary: error,
          result_json: JSON.stringify({
            total: targets.length,
            success: targets.filter((target) => target.status === 'SUCCESS').length,
            ...(graphModule &&
              (status === 'SUCCESS' || (graphHealth && status === 'NEEDS_ATTENTION')) &&
              result),
            ...(graphModule &&
              status === 'FAILED' &&
              failure?.cause instanceof ExecutionPlanIssueError && {
                graphIssue: {
                  ...failure.cause.issue,
                  message: redactTaskLog(failure.cause.issue.message),
                },
              }),
            ...continuation,
          }),
          finished_at: now,
          updated_at: now,
          lease_owner: null,
          lease_expires_at: null,
          log_size_bytes: size,
        })
        .where('id', '=', task.id)
        .where('lease_owner', '=', this.owner)
        .execute();
      await this.notifications?.recordTaskCompletion(tx, task.id, now);
      await this.failures?.completion(tx, task.id, now);
      return true;
    });
  }

  private async settleExecutionRows(
    tx: Transaction<Database>,
    taskId: string,
    at: number,
    status: 'CANCELLED' | 'NEEDS_ATTENTION',
    message: string,
    includeInterrupted = false,
  ) {
    const active = includeInterrupted
      ? ['PENDING', 'RUNNING', 'CANCELLED']
      : ['PENDING', 'RUNNING'];
    await tx
      .updateTable('task_targets')
      .set({ status, finished_at: at, error_summary: message })
      .where('task_id', '=', taskId)
      .where('status', 'in', active)
      .execute();
    await tx
      .updateTable('task_steps')
      .set({ status, finished_at: at, result_json: JSON.stringify({ error: message }) })
      .where('task_id', '=', taskId)
      .where('status', 'in', active)
      .execute();
    await tx
      .updateTable('deployment_records')
      .set({ status, finished_at: at, health_status: 'NOT_CHECKED' })
      .where('status', 'in', active)
      .where(
        'task_target_id',
        'in',
        tx.selectFrom('task_targets').select('id').where('task_id', '=', taskId),
      )
      .execute();
  }
}

export function aggregateStatus(statuses: string[], cancelled: boolean): TaskStatus {
  if (statuses.some((status) => status === 'NEEDS_ATTENTION')) return 'NEEDS_ATTENTION';
  if (cancelled) return 'CANCELLED';
  if (statuses.length && statuses.every((status) => status === 'SUCCESS')) return 'SUCCESS';
  if (statuses.some((status) => status === 'SUCCESS')) return 'PARTIAL_FAILED';
  if (statuses.some((status) => status === 'TIMED_OUT')) return 'TIMED_OUT';
  return 'FAILED';
}
