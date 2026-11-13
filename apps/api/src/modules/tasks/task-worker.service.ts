import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Selectable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import { TasksTable } from '../../core/database/schema';
import { TaskHandlerRegistry } from './task-handler.registry';
import { TasksService } from './tasks.service';
import { TaskLogService } from './task-log.service';
import { TaskPayload } from './tasks.types';

@Injectable()
export class TaskWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('TaskWorker');
  private readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private running?: Promise<void>;
  private controller?: AbortController;
  private stopping = false;
  private sqliteLeaseLost = false;
  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: TasksService,
    private readonly registry: TaskHandlerRegistry,
    private readonly logs: TaskLogService,
  ) {}
  onApplicationBootstrap() {
    if (process.env.WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: Error) => this.logger.error(error.message));
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.running;
    if (this.database.client === 'sqlite') {
      await this.database.db
        .deleteFrom('system_settings')
        .where('key', '=', 'worker:sqlite-owner')
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
      .values({ key: 'worker:sqlite-owner', value_json: owner, updated_at: now })
      .onConflict((conflict) => conflict.column('key').doNothing())
      .execute();
    const row = await this.database.db
      .updateTable('system_settings')
      .set({ value_json: owner, updated_at: now })
      .where('key', '=', 'worker:sqlite-owner')
      .where((eb) => eb.or([eb('value_json', '=', owner), eb('updated_at', '<', now - 45_000)]))
      .returning('key')
      .executeTakeFirst();
    return Boolean(row);
  }
  async tick(): Promise<void> {
    if (this.polling || this.stopping) return;
    this.polling = true;
    try {
      if (!(await this.ownSqliteLease())) {
        if (this.running) {
          this.sqliteLeaseLost = true;
          this.controller?.abort();
        }
        return;
      }
      await this.recoverExpired();
      if (this.running) return;
      const task = await this.claim();
      if (!task) return;
      this.sqliteLeaseLost = false;
      this.running = this.execute(task)
        .catch((error: Error) =>
          this.logger.error(`任务状态写入失败，租约过期后将进入人工核查：${error.message}`),
        )
        .finally(() => {
          this.running = undefined;
          this.controller = undefined;
        });
    } finally {
      this.polling = false;
    }
  }
  async claim() {
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
    return this.database.db
      .updateTable('tasks')
      .set((eb) => ({
        status: 'RUNNING',
        lease_owner: this.owner,
        lease_expires_at: now + 60_000,
        heartbeat_at: now,
        started_at: now,
        updated_at: now,
        attempt_count: eb('attempt_count', '+', 1),
      }))
      .where('id', '=', candidate.id)
      .where('status', '=', 'PENDING')
      .returningAll()
      .executeTakeFirst();
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
        await tx
          .updateTable('task_targets')
          .set({
            status: 'NEEDS_ATTENTION',
            finished_at: now,
            error_summary: 'Worker 中断，执行结果需核查',
          })
          .where('task_id', '=', task.id)
          .where('status', 'in', ['PENDING', 'RUNNING'])
          .execute();
        await tx
          .updateTable('task_steps')
          .set({ status: 'NEEDS_ATTENTION', finished_at: now })
          .where('task_id', '=', task.id)
          .where('status', '=', 'RUNNING')
          .execute();
        // Deployment history must reflect the same uncertain outcome as its expired task.
        // Only unfinished records for this task are fenced; successful historical releases remain intact.
        await tx
          .updateTable('deployment_records')
          .set({ status: 'NEEDS_ATTENTION', finished_at: now })
          .where('status', '=', 'RUNNING')
          .where(
            'task_target_id',
            'in',
            tx.selectFrom('task_targets').select('id').where('task_id', '=', task.id),
          )
          .execute();
      }
    });
  }
  private async execute(task: Selectable<TasksTable>) {
    const controller = new AbortController();
    this.controller = controller;
    const unbindCancellation = this.tasks.bindCancellation(task.id, controller);
    const context = this.tasks.context(task, controller.signal);
    let lostLease = false;
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void (async () => {
        const row = await this.tasks.row(task.id);
        if (row.lease_owner !== this.owner || row.status === 'NEEDS_ATTENTION') {
          lostLease = true;
          controller.abort();
          return;
        }
        if (row.status === 'CANCEL_REQUESTED') controller.abort();
        const now = Date.now();
        await this.database.db
          .updateTable('tasks')
          .set({ heartbeat_at: now, lease_expires_at: now + 60_000, updated_at: now })
          .where('id', '=', task.id)
          .where('lease_owner', '=', this.owner)
          .execute();
      })()
        .catch((error: Error) => {
          lostLease = true;
          controller.abort();
          this.logger.error(error.message);
        })
        .finally(() => {
          heartbeatBusy = false;
        });
    }, 1000);
    try {
      if ((await this.tasks.row(task.id)).status === 'CANCEL_REQUESTED') controller.abort();
      context.log(
        `任务开始：${task.name}\n目标快照已固定，${JSON.parse(task.payload_json).targets.length} 台服务器\n`,
      );
      const handler = this.registry.get(task.task_type);
      await handler.execute(
        {
          id: task.id,
          type: task.task_type,
          name: task.name,
          payload: JSON.parse(task.payload_json) as TaskPayload,
        },
        context,
      );
      const targets = await this.tasks.targets(task.id);
      let status = aggregateStatus(
        targets.map((target) => target.status),
        controller.signal.aborted,
      );
      const interrupted = this.stopping || lostLease || this.sqliteLeaseLost;
      if (interrupted) status = 'NEEDS_ATTENTION';
      if (interrupted) {
        await this.database.db
          .updateTable('task_targets')
          .set({
            status: 'NEEDS_ATTENTION',
            finished_at: Date.now(),
            error_summary: '执行进程中断，结果需要核查',
          })
          .where('task_id', '=', task.id)
          .where('status', 'in', ['RUNNING', 'CANCELLED'])
          .execute();
      }
      const cancelled = controller.signal.aborted;
      await this.database.db
        .updateTable('task_targets')
        .set({
          status: cancelled ? (interrupted ? 'NEEDS_ATTENTION' : 'CANCELLED') : 'CANCELLED',
          finished_at: Date.now(),
          error_summary: cancelled ? '任务已中断' : '因失败停止策略未执行',
        })
        .where('task_id', '=', task.id)
        .where('status', '=', 'PENDING')
        .execute();
      const error =
        status === 'SUCCESS'
          ? null
          : interrupted
            ? '执行进程中断，远程执行结果需人工核查'
            : (targets.find((target) => target.errorSummary)?.errorSummary ?? '部分目标未成功执行');
      const size = this.logs.append(task.id, task.log_file_key!, `\n任务结束：${status}\n`);
      await this.database.db
        .updateTable('tasks')
        .set({
          status,
          error_summary: error,
          result_json: JSON.stringify({
            total: targets.length,
            success: targets.filter((target) => target.status === 'SUCCESS').length,
          }),
          finished_at: Date.now(),
          updated_at: Date.now(),
          lease_owner: null,
          lease_expires_at: null,
          log_size_bytes: size,
        })
        .where('id', '=', task.id)
        .where('lease_owner', '=', this.owner)
        .execute();
    } catch (error) {
      const message = error instanceof Error ? error.message : '任务执行失败';
      try {
        context.log(`执行中断：${message}\n`);
      } catch {
        this.logger.error('任务日志存储失败，任务将进入人工核查状态');
      }
      await this.database.db
        .updateTable('task_targets')
        .set({ status: 'NEEDS_ATTENTION', finished_at: Date.now(), error_summary: message })
        .where('task_id', '=', task.id)
        .where('status', 'in', ['PENDING', 'RUNNING'])
        .execute();
      await this.database.db
        .updateTable('tasks')
        .set({
          status: 'NEEDS_ATTENTION',
          error_summary: message,
          finished_at: Date.now(),
          updated_at: Date.now(),
          lease_owner: null,
          lease_expires_at: null,
        })
        .where('id', '=', task.id)
        .where('lease_owner', '=', this.owner)
        .execute();
    } finally {
      clearInterval(heartbeat);
      unbindCancellation();
    }
  }
}

export function aggregateStatus(statuses: string[], cancelled: boolean): string {
  if (cancelled) return 'CANCELLED';
  if (statuses.length && statuses.every((status) => status === 'SUCCESS')) return 'SUCCESS';
  if (statuses.some((status) => status === 'NEEDS_ATTENTION')) return 'NEEDS_ATTENTION';
  if (statuses.some((status) => status === 'SUCCESS')) return 'PARTIAL_FAILED';
  if (statuses.some((status) => status === 'TIMED_OUT')) return 'TIMED_OUT';
  return 'FAILED';
}
