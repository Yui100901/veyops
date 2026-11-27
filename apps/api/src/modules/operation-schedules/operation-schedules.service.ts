import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import type { CurrentUser } from '../auth/auth.decorators';
import { TargetResolver } from '../command-center/target-resolver.service';
import { OperationPlansService } from '../operation-plans/operation-plans.service';
import { SystemSettingsService } from '../system/system-settings.service';
import { TasksService } from '../tasks/tasks.service';
import type { CreateTaskInput, TaskPayload } from '../tasks/tasks.types';
import type {
  PreviewOperationScheduleDto,
  SaveOperationScheduleDto,
} from './operation-schedule.dto';
import {
  normalizeScheduleTiming,
  type ScheduleTiming,
  upcomingTimes,
} from './operation-schedule-time';

const confirmationWindow = 15 * 60_000;
const onTimeGrace = 5_000;
const scheduledBatchSize = 50;

type Actor = Pick<CurrentUser, 'id' | 'role'>;
type ScheduleRow = Selectable<Database['operation_schedules']>;
type RunState = 'QUEUED' | 'AWAITING_CONFIRMATION' | 'SKIPPED' | 'FAILED';
type ScheduleConfig = Omit<PreviewOperationScheduleDto, 'timing' | 'kind'> & {
  timing: ScheduleTiming;
  kind: 'OPERATION_PLAN' | 'COMMAND_TEMPLATE';
};
type ApprovedTargets = { hash: string; ids: string[] };
type RunSnapshot = {
  name: string;
  ownerId: string;
  sourceVersion: number;
  sourceId: string;
  kind: ScheduleConfig['kind'];
  targetIds: string[];
  revision: number;
  steps?: string[];
};
type PreparedAction = {
  input: CreateTaskInput;
  beforeInsert(tx: Transaction<Database>): Promise<void>;
};

function configOf(row: ScheduleRow) {
  const saved = JSON.parse(row.config_json) as Omit<
    ScheduleConfig,
    'name' | 'kind' | 'sourceId' | 'sourceVersion'
  > & { anchorAt: number };
  const { anchorAt, ...config } = saved;
  return {
    anchorAt,
    config: {
      ...config,
      name: row.name,
      kind: row.kind as ScheduleConfig['kind'],
      sourceId: row.source_id,
      sourceVersion: row.source_version,
    },
  };
}

function targetsOf(row: ScheduleRow): ApprovedTargets {
  return JSON.parse(row.approved_targets_json) as ApprovedTargets;
}

function errorReason(error: unknown) {
  return error instanceof HttpException && error.getStatus() < 500 ? error.message : undefined;
}

function reviewSteps(payload: TaskPayload) {
  if (payload.operationChain)
    return payload.operationChain.nodes.flatMap((node) =>
      node.type === 'COMMAND' ? [{ name: node.name, command: node.command }] : [],
    );
  return payload.steps.map(({ name, command }) => ({ name, command }));
}

@Injectable()
export class OperationSchedulesService {
  private readonly logger = new Logger(OperationSchedulesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly plans: OperationPlansService,
    private readonly targets: TargetResolver,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
  ) {}

  private async prepare(config: ScheduleConfig, targetHash: string): Promise<PreparedAction> {
    if (config.kind !== 'OPERATION_PLAN')
      throw new BadRequestException('此计划使用已停用的命令模板，请编辑并选择运维方案');
    const options = {
      ...config.target,
      confirmed: true,
      version: config.sourceVersion,
      parameters: config.parameters,
      strategy: config.strategy ?? 'PARALLEL',
      maxParallel: config.maxParallel,
      failurePolicy: config.failurePolicy,
      timeout: config.timeoutSeconds,
      expectedTargetHash: targetHash,
    };
    return this.plans.prepareRun(config.sourceId, options);
  }

  private async previewConfig(input: PreviewOperationScheduleDto, now: number) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('计划名称不能为空');
    const settings = await this.settings.get();
    const config: ScheduleConfig = {
      name,
      kind: input.kind,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      timing: normalizeScheduleTiming(input.timing),
      target: { serverIds: input.target.serverIds ?? [], groupIds: input.target.groupIds ?? [] },
      parameters: Object.fromEntries(
        Object.entries(input.parameters ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
      strategy: input.strategy ?? 'PARALLEL',
      maxParallel: input.maxParallel ?? settings.defaultMaxParallelTargets,
      failurePolicy: input.failurePolicy ?? settings.defaultOperationFailurePolicy,
      timeoutSeconds: input.timeoutSeconds ?? settings.defaultOperationTimeoutSeconds,
      requireConfirmation: input.requireConfirmation !== false,
    };
    const upcoming = upcomingTimes(config.timing, now, now, 5);
    const targetPreview = await this.targets.preview(config.target);
    const prepared = await this.prepare(config, targetPreview.targetHash);
    const approved = {
      hash: targetPreview.targetHash,
      ids: targetPreview.targets.map(({ id }) => id),
    };
    const configurationHash = createHash('sha256')
      .update(
        JSON.stringify([
          config,
          approved.hash,
          prepared.input.payload.operationChain ?? prepared.input.payload.steps,
        ]),
      )
      .digest('hex');
    return {
      config,
      approved,
      prepared,
      upcoming,
      configurationHash,
      targets: targetPreview.targets,
    };
  }

  async preview(input: PreviewOperationScheduleDto) {
    const result = await this.previewConfig(input, Date.now());
    return {
      nextRunAt: result.upcoming[0] ?? null,
      upcoming: result.upcoming,
      targets: result.targets,
      configurationHash: result.configurationHash,
      requireConfirmation: result.config.requireConfirmation,
      steps: reviewSteps(result.prepared.input.payload),
    };
  }

  private async row(id: string, actor: Actor) {
    const row = await this.database.db
      .selectFrom('operation_schedules')
      .selectAll()
      .where('id', '=', id)
      .where('status', '!=', 'DELETED')
      .executeTakeFirst();
    if (!row || (actor.role !== 'ADMIN' && actor.id !== row.owner_id))
      throw new NotFoundException('定时运维计划不存在');
    return row;
  }

  private runQuery(db: Kysely<Database>, id: string) {
    return db
      .selectFrom('operation_schedule_runs as run')
      .selectAll('run')
      .leftJoin('tasks', 'tasks.id', 'run.task_id')
      .innerJoin('operation_schedules as schedule', 'schedule.id', 'run.schedule_id')
      .innerJoin('users as owner', 'owner.id', 'schedule.owner_id')
      .select([
        'tasks.status as task_status',
        'tasks.error_summary as task_error',
        'owner.username as owner_name',
      ])
      .where('run.schedule_id', '=', id)
      .orderBy('run.scheduled_at', 'desc');
  }

  private presentRun(
    row: Awaited<
      ReturnType<ReturnType<OperationSchedulesService['runQuery']>['executeTakeFirstOrThrow']>
    >,
  ) {
    const { name, ownerId, sourceId, sourceVersion, kind, targetIds, steps } = JSON.parse(
      row.snapshot_json,
    ) as RunSnapshot;
    return {
      name,
      ownerId,
      ownerName: row.owner_name,
      sourceId,
      sourceVersion,
      kind,
      targetIds,
      steps,
      id: row.id,
      scheduleId: row.schedule_id,
      scheduledAt: row.scheduled_at,
      triggeredAt: row.triggered_at,
      status: row.task_status ?? row.status,
      taskId: row.task_id,
      reason: row.task_error ?? row.reason,
      confirmationExpiresAt: row.confirmation_expires_at,
      missedUntil: row.missed_until,
    };
  }

  private async present(row: ScheduleRow) {
    const { config } = configOf(row);
    const last = await this.runQuery(this.database.db, row.id).limit(1).executeTakeFirst();
    return {
      ...config,
      id: row.id,
      ownerId: row.owner_id,
      status: row.status,
      statusReason: row.status_reason,
      nextRunAt: row.next_run_at,
      lastRun: last ? this.presentRun(last) : null,
      approvedTargetIds: targetsOf(row).ids,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async list(actor: Actor) {
    let query = this.database.db
      .selectFrom('operation_schedules')
      .selectAll()
      .where('status', '!=', 'DELETED');
    if (actor.role !== 'ADMIN') query = query.where('owner_id', '=', actor.id);
    const rows = await query.orderBy('created_at', 'desc').limit(200).execute();
    return Promise.all(rows.map((row) => this.present(row)));
  }

  async history(id: string, actor: Actor) {
    // A deleted schedule retains all execution and audit history.
    const row = await this.database.db
      .selectFrom('operation_schedules')
      .select(['owner_id'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || (actor.role !== 'ADMIN' && actor.id !== row.owner_id))
      throw new NotFoundException('定时运维计划不存在');
    const rows = await this.runQuery(this.database.db, id).limit(200).execute();
    return rows.map((run) => this.presentRun(run));
  }

  private async verifyActor(tx: Transaction<Database>, id: string, adminOnly = false) {
    const active = await tx
      .updateTable('users')
      .set((eb) => ({ status: eb.ref('status') }))
      .where('id', '=', id)
      .where('status', '=', 'ACTIVE')
      .where('role', 'in', adminOnly ? ['ADMIN'] : ['ADMIN', 'OPERATOR'])
      .returning('id')
      .executeTakeFirst();
    if (!active) throw new ForbiddenException('计划负责人或审批人已没有运维执行权限');
  }

  private async verifyTargets(
    tx: Transaction<Database>,
    config: ScheduleConfig,
    approved: ApprovedTargets,
    prepared: PreparedAction,
  ) {
    for (const id of [...(config.target.groupIds ?? [])].sort()) {
      const group = await tx
        .updateTable('server_groups')
        .set((eb) => ({ id: eb.ref('id') }))
        .where('id', '=', id)
        .returning('id')
        .executeTakeFirst();
      if (!group) throw new ConflictException('所选服务器分组已被删除');
    }
    for (const id of [...approved.ids].sort()) {
      await tx
        .updateTable('servers')
        .set((eb) => ({ is_active: eb.ref('is_active') }))
        .where('id', '=', id)
        .execute();
    }
    const credentials = [
      ...new Set(
        prepared.input.payload.targets.flatMap(({ credentialId }) =>
          credentialId ? [credentialId] : [],
        ),
      ),
    ].sort();
    for (const id of credentials) {
      await tx
        .updateTable('credentials')
        .set((eb) => ({ status: eb.ref('status') }))
        .where('id', '=', id)
        .execute();
    }
    const current = await this.targets.preview(config.target, tx);
    if (current.targetHash !== approved.hash)
      throw new ConflictException('目标或 SSH 配置已变化，请重新预览确认');
    await prepared.beforeInsert(tx);
  }

  async save(input: SaveOperationScheduleDto, actor: Actor, id?: string) {
    const existing = id ? await this.row(id, actor) : undefined;
    return this.saveConfig(input, input.enabled, input.expectedConfigurationHash, actor, existing);
  }

  async enable(id: string, expectedConfigurationHash: string, actor: Actor) {
    const existing = await this.row(id, actor);
    const { config } = configOf(existing);
    if (config.kind !== 'OPERATION_PLAN')
      throw new BadRequestException('此计划使用已停用的命令模板，请编辑并选择运维方案');
    return this.saveConfig(
      { ...config, kind: config.kind },
      true,
      expectedConfigurationHash,
      actor,
      existing,
    );
  }

  private async saveConfig(
    input: PreviewOperationScheduleDto,
    enabled: boolean,
    expectedHash: string,
    actor: Actor,
    existing?: ScheduleRow,
  ) {
    const { config, approved, prepared, configurationHash } = await this.previewConfig(
      input,
      Date.now(),
    );
    if (configurationHash !== expectedHash)
      throw new ConflictException('计划内容、执行版本或目标已变化，请重新预览确认');
    const owner = existing?.owner_id ?? actor.id;
    const id = existing?.id ?? randomUUID();
    const { name, kind, sourceId, sourceVersion, ...save } = config;
    const row = await this.database.db.transaction().execute(async (tx) => {
      if (existing) await this.lockSchedule(tx, existing);
      await this.verifyActor(tx, actor.id, owner !== actor.id);
      if (owner !== actor.id) await this.verifyActor(tx, owner);
      await this.verifyTargets(tx, config, approved, prepared);
      const now = Date.now();
      const nextRunAt = enabled ? (upcomingTimes(config.timing, now, now, 1)[0] ?? null) : null;
      if (enabled && nextRunAt === null)
        throw new BadRequestException('单次执行时间必须晚于当前时间');
      const fields = {
        name,
        kind,
        source_id: sourceId,
        source_version: sourceVersion,
        config_json: JSON.stringify({ ...save, anchorAt: now }),
        approved_targets_json: JSON.stringify(approved),
        status: enabled ? 'ENABLED' : 'DISABLED',
        status_reason: null,
        next_run_at: nextRunAt,
        updated_at: now,
      };
      const saved = existing
        ? await tx
            .updateTable('operation_schedules')
            .set({ ...fields, revision: existing.revision + 1 })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await tx
            .insertInto('operation_schedules')
            .values({
              ...fields,
              id,
              owner_id: owner,
              created_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
      if (existing) await this.skipConfirmations(tx, id, '计划已修改，等待中的执行已跳过');
      await this.audit.record(
        actor.id,
        existing ? 'schedule.update' : 'schedule.create',
        'operation-schedule',
        id,
        {
          enabled,
          sourceId,
          sourceVersion,
          targetIds: approved.ids,
        },
        tx,
      );
      return saved;
    });
    return this.present(row);
  }

  private async lockSchedule(tx: Transaction<Database>, row: ScheduleRow, due?: number) {
    let query = tx
      .updateTable('operation_schedules')
      .set((eb) => ({ revision: eb.ref('revision') }))
      .where('id', '=', row.id)
      .where('revision', '=', row.revision)
      .where('status', '!=', 'DELETED');
    if (due !== undefined)
      query = query.where('status', '=', 'ENABLED').where('next_run_at', '=', due);
    const locked = await query.returningAll().executeTakeFirst();
    if (!locked && due === undefined) throw new ConflictException('计划已变化，请刷新后重试');
    return locked;
  }

  private async skipConfirmations(tx: Transaction<Database>, id: string, reason: string) {
    await tx
      .updateTable('operation_schedule_runs')
      .set({ status: 'SKIPPED', reason })
      .where('schedule_id', '=', id)
      .where('status', '=', 'AWAITING_CONFIRMATION')
      .execute();
  }

  async disable(id: string, actor: Actor, remove = false) {
    const existing = await this.row(id, actor);
    const row = await this.database.db.transaction().execute(async (tx) => {
      await this.lockSchedule(tx, existing);
      await this.verifyActor(tx, actor.id, actor.id !== existing.owner_id);
      const updated = await tx
        .updateTable('operation_schedules')
        .set({
          status: remove ? 'DELETED' : 'DISABLED',
          status_reason: null,
          next_run_at: null,
          revision: existing.revision + 1,
          updated_at: Date.now(),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.skipConfirmations(tx, id, remove ? '计划已删除' : '计划已关闭');
      await this.audit.record(
        actor.id,
        remove ? 'schedule.delete' : 'schedule.disable',
        'operation-schedule',
        id,
        {},
        tx,
      );
      return updated;
    });
    return remove ? { success: true } : this.present(row);
  }

  async tick(now = Date.now()) {
    const db = this.database.db;
    await db
      .updateTable('operation_schedule_runs')
      .set({ status: 'SKIPPED', reason: '等待人工确认超时' })
      .where('status', '=', 'AWAITING_CONFIRMATION')
      .where('confirmation_expires_at', '<=', now)
      .execute();
    const due = await db
      .selectFrom('operation_schedules')
      .selectAll()
      .where('status', '=', 'ENABLED')
      .where('kind', '=', 'OPERATION_PLAN')
      .where('next_run_at', '<=', now)
      .orderBy('next_run_at')
      .orderBy('id')
      .limit(scheduledBatchSize)
      .execute();
    for (const row of due) {
      try {
        await this.trigger(row, now);
      } catch {
        this.logger.warn(`本轮定时运维处理未提交，待重试：${row.id}`);
      }
    }
  }

  private async trigger(row: ScheduleRow, now: number) {
    const { config, anchorAt } = configOf(row);
    const approved = targetsOf(row);
    const due = row.next_run_at!;
    // This small window accounts for live Worker polling jitter.
    const missed = now - due > onTimeGrace;
    const next = upcomingTimes(config.timing, anchorAt, missed ? now : due, 1)[0] ?? null;
    let prepared: PreparedAction | undefined;
    let reason: string | null = null;
    if (!missed) {
      try {
        prepared = await this.prepare(config, approved.hash);
      } catch (error) {
        const detail = errorReason(error);
        if (!detail) throw error;
        reason = detail;
      }
    }
    await this.database.db.transaction().execute(async (tx) => {
      if (!(await this.lockSchedule(tx, row, due))) return;
      const runId = randomUUID();
      const snapshot: RunSnapshot = {
        name: row.name,
        ownerId: row.owner_id,
        sourceId: row.source_id,
        sourceVersion: row.source_version,
        kind: config.kind,
        revision: row.revision,
        targetIds: approved.ids,
        steps: prepared && reviewSteps(prepared.input.payload).map(({ name }) => name),
      };
      let status: RunState = 'FAILED';
      let taskId: string | null = null;
      let confirmationExpiresAt: number | null = null;
      if (missed) {
        status = 'SKIPPED';
        reason = '错过计划时间，已跳过停机或延迟期间的执行';
      } else if (prepared) {
        try {
          await this.verifyActor(tx, row.owner_id);
          await this.verifyTargets(tx, config, approved, prepared);
        } catch (error) {
          const detail = errorReason(error);
          if (!detail) throw error;
          reason = detail;
        }
        if (!reason) {
          const active = await tx
            .selectFrom('operation_schedule_runs as run')
            .leftJoin('tasks', 'tasks.id', 'run.task_id')
            .select('run.id')
            .where('run.schedule_id', '=', row.id)
            .where((eb) =>
              eb.or([
                eb('run.status', '=', 'AWAITING_CONFIRMATION'),
                eb('tasks.status', 'in', ['PENDING', 'RUNNING', 'CANCEL_REQUESTED']),
              ]),
            )
            .executeTakeFirst();
          if (active) {
            status = 'SKIPPED';
            reason = '同一计划已有排队、执行中或待确认的任务';
          } else if (config.requireConfirmation) {
            status = 'AWAITING_CONFIRMATION';
            confirmationExpiresAt = now + confirmationWindow;
          } else {
            status = 'QUEUED';
            taskId = await this.enqueue(tx, row, due, prepared);
          }
        }
      }
      await tx
        .insertInto('operation_schedule_runs')
        .values({
          id: runId,
          schedule_id: row.id,
          scheduled_at: due,
          triggered_at: now,
          status,
          reason,
          task_id: taskId,
          confirmation_expires_at: confirmationExpiresAt,
          snapshot_json: JSON.stringify(snapshot),
          missed_until: missed ? now : null,
        })
        .execute();
      await tx
        .updateTable('operation_schedules')
        .set({
          next_run_at: status === 'FAILED' ? null : next,
          updated_at: now,
          ...(status === 'FAILED' && { status: 'PAUSED', status_reason: reason }),
        })
        .where('id', '=', row.id)
        .execute();
      await this.audit.record(
        null,
        'schedule.trigger',
        'operation-schedule',
        row.id,
        {
          status,
          runId,
          scheduledAt: due,
          taskId,
        },
        tx,
      );
    });
  }

  private enqueue(
    tx: Transaction<Database>,
    row: ScheduleRow,
    scheduledAt: number,
    prepared: PreparedAction,
  ) {
    return this.tasks.createInTransaction(
      tx,
      {
        ...prepared.input,
        name: row.name,
        idempotencyKey: `operation-schedule:${row.id}:${scheduledAt}`,
      },
      row.owner_id,
    );
  }

  async approve(id: string, runId: string, actor: Actor, confirmed: boolean) {
    if (confirmed !== true) throw new BadRequestException('请确认本次定时运维执行');
    const schedule = await this.row(id, actor);
    const { config } = configOf(schedule);
    const approved = targetsOf(schedule);
    let prepared: PreparedAction | undefined;
    let prepareFailure: string | undefined;
    try {
      prepared = await this.prepare(config, approved.hash);
    } catch (error) {
      prepareFailure = errorReason(error);
      if (!prepareFailure) throw error;
    }
    const result = await this.database.db.transaction().execute(async (tx) => {
      const locked = await this.lockSchedule(tx, schedule);
      const now = Date.now();
      const run = await tx
        .updateTable('operation_schedule_runs')
        .set((eb) => ({ status: eb.ref('status') }))
        .where('id', '=', runId)
        .where('schedule_id', '=', id)
        .where('status', '=', 'AWAITING_CONFIRMATION')
        .where('confirmation_expires_at', '>', now)
        .returningAll()
        .executeTakeFirst();
      if (
        locked?.status !== 'ENABLED' ||
        !run ||
        (JSON.parse(run.snapshot_json) as RunSnapshot).revision !== locked.revision
      )
        throw new ConflictException('此执行已超时、被处理或计划已变化');
      if (actor.id !== schedule.owner_id) await this.verifyActor(tx, actor.id, true);
      try {
        await this.verifyActor(tx, schedule.owner_id);
        if (!prepared) throw new ConflictException(prepareFailure ?? '计划已失去执行资格');
        await this.verifyTargets(tx, config, approved, prepared);
      } catch (error) {
        const reason = errorReason(error);
        if (!reason) throw error;
        await tx
          .updateTable('operation_schedule_runs')
          .set({ status: 'FAILED', reason })
          .where('id', '=', runId)
          .execute();
        await tx
          .updateTable('operation_schedules')
          .set({
            status: 'PAUSED',
            status_reason: reason,
            next_run_at: null,
            updated_at: now,
          })
          .where('id', '=', id)
          .execute();
        await this.skipConfirmations(tx, id, reason);
        await this.audit.record(
          actor.id,
          'schedule.approval-paused',
          'operation-schedule',
          id,
          { runId },
          tx,
        );
        return { reason };
      }
      const taskId = await this.enqueue(tx, schedule, run.scheduled_at, prepared);
      await tx
        .updateTable('operation_schedule_runs')
        .set({ status: 'QUEUED', task_id: taskId })
        .where('id', '=', runId)
        .execute();
      await this.audit.record(
        actor.id,
        'schedule.approve',
        'operation-schedule',
        id,
        { runId, taskId },
        tx,
      );
      return { taskId };
    });
    if (!result.taskId) throw new ConflictException(result.reason);
    return { taskId: result.taskId };
  }
}
