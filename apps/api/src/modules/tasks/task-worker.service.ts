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
import { TaskHandlerRegistry } from './task-handler.registry';
import { TasksService } from './tasks.service';
import { TaskLogService } from './task-log.service';
import type { TaskHandler, TaskPayload, TaskRecord, TaskStatus } from './tasks.types';
import { lockTaskLease, TaskLeaseUnavailableError } from './task-lease';
import { SystemSettingsService } from '../system/system-settings.service';
import { ArtifactRetentionService } from '../artifacts/artifact-retention.service';

const TASK_LEASE_MS = 60_000;
const SQLITE_LEASE_MS = 45_000;
const WORKER_KEY = 'worker:sqlite-owner';
const EXECUTION_INTERRUPTED = '执行进程中断，远程执行结果需人工核查';
const EXECUTION_FAILED = '执行记录未完整保存，远程执行结果需人工核查';
const LOG_FAILED = '任务日志存储失败，远程执行结果需人工核查';
const CANCELLED = '任务已取消';
const LOG_PRUNE_INTERVAL_MS = 60 * 60_000;
const ARTIFACT_PRUNE_INTERVAL_MS = 60 * 60_000;

@Injectable()
export class TaskWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('TaskWorker');
  private readonly owner = randomUUID();
  private readonly shutdownController = new AbortController();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private running?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private controller?: AbortController;
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
    this.controller?.abort();
    await this.polling?.catch(() => undefined);
    await this.running;
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
      if (this.running) {
        this.sqliteLeaseLost = true;
        this.controller?.abort();
      }
      return;
    }
    await this.recoverExpired();
    await this.pruneLogs();
    await this.pruneArtifacts();
    if (this.running || this.stopping) return;
    const task = await this.claim(true);
    if (!task) return;
    this.sqliteLeaseLost = false;
    this.running = this.execute(task)
      .catch(() => this.logger.error('任务状态写入失败，租约过期后将进入人工核查'))
      .finally(() => {
        this.running = undefined;
        this.controller = undefined;
      });
  }
  private async pruneArtifacts() {
    if (!this.artifactRetention || this.stopping || this.running || Date.now() < this.nextArtifactPruneAt) return;
    this.nextArtifactPruneAt = Date.now() + ARTIFACT_PRUNE_INTERVAL_MS;
    try {
      await this.artifactRetention.pruneExpired();
    } catch {
      this.logger.warn('构建产物保留规则执行失败，将在下次调度重试');
    }
  }

  private async pruneLogs() {
    if (!this.settings || this.stopping || Date.now() < this.nextLogPruneAt) return;
    this.nextLogPruneAt = Date.now() + LOG_PRUNE_INTERVAL_MS;
    try {
      const { logRetentionDays } = await this.settings.get();
      if (!logRetentionDays) {
        this.nextLogPruneAt = Date.now() + 60_000;
        return;
      }
      const result = await this.logs.pruneExpired(this.database.db, logRetentionDays);
      if (result.more) this.nextLogPruneAt = Date.now() + 60_000;
      if (result.failed) this.logger.warn(`本轮有 ${result.failed} 份过期任务日志清理失败`);
    } catch {
      this.logger.warn('任务日志保留策略执行失败，下次周期将重试');
    }
  }
  async claim(requireSqliteLease = false) {
    // The conditional UPDATE is atomic in both dialects. Remote work never holds a DB transaction.
    const candidate = await this.database.db
      .selectFrom('tasks')
      .select('id')
      .where('status', '=', 'PENDING')
      .where('available_at', '<=', Date.now())
      .orderBy('priority', 'desc')
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    if (!candidate) return undefined;
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
          eb.not(
            eb.exists(
              eb
                .selectFrom('tasks as active')
                .select('active.id')
                .where('active.status', 'in', ['RUNNING', 'CANCEL_REQUESTED']),
            ),
          ),
        ]),
      );
    }
    return claim.returningAll().executeTakeFirst();
  }
  async recoverExpired() {
    const now = Date.now();
    // The parent and its execution/deployment records must move together; otherwise a
    // process crash between updates could leave RUNNING history that is never revisited.
    await this.database.db.transaction().execute(async (tx) => {
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
        .returning('id')
        .execute();
      for (const task of expired) {
        await this.settleExecutionRows(tx, task.id, now, 'NEEDS_ATTENTION', EXECUTION_INTERRUPTED);
      }
    });
  }
  private async execute(task: Selectable<TasksTable>) {
    const controller = new AbortController();
    this.controller = controller;
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
        if (!controller.signal.aborted) {
          context.log(
            `任务开始：${task.name}\n目标快照已固定，${record.payload.targets.length} 台服务器\n`,
          );
          await handler.execute(record, context);
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
      );
    } finally {
      clearInterval(heartbeat);
      unbind();
      this.controller = undefined;
      await heartbeatInProgress;
    }

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
      const abandoned =
        !cancelled &&
        (Boolean(activeStep || activeDeployment) ||
          targets.some((target) => target.status === 'RUNNING'));
      const workerInterrupted = interrupted || this.stopping || this.sqliteLeaseLost;
      let uncertain = workerInterrupted || executionFailed || abandoned;
      let status = uncertain
        ? 'NEEDS_ATTENTION'
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
