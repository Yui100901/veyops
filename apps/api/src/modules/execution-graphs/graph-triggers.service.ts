import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  normalizeScheduleTiming,
  upcomingTimes,
} from '../operation-schedules/operation-schedule-time';
import type { ScheduleTiming } from '../operation-schedules/operation-schedule-time';
import { requireProject } from '../projects/project-relations';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { redactTaskLog } from '../tasks/task-log.service';
import type { GraphDefinition } from './execution-graph-definition';
import {
  graphDeliveryId,
  type GraphTriggerDto,
  type GraphTriggerKind,
  type InvokeGraphTriggerDto,
  type UpstreamResult,
} from './graph-trigger.dto';
import { GraphRunnerService } from './graph-runner.service';

type Rule = Selectable<Database['execution_graph_triggers']>;
type Event = Selectable<Database['execution_graph_trigger_events']>;
type Cron = Extract<ScheduleTiming, { type: 'CRON' }>;

interface TriggerConfig {
  revision: string;
  inputValue?: string | null;
  cron?: string;
  timeZone?: string;
  credentialId?: string;
  credentialNonce?: string;
  upstreamFlowId?: string;
  upstreamStatus?: UpstreamResult;
}

const safeNodes = new Set([
  'START',
  'END',
  'LOG',
  'CONDITION',
  'SWITCH',
  'PARALLEL',
  'JOIN',
  'FLOW_CALL',
  'DELAY',
  'APPROVAL',
]);
const failed = ['FAILED', 'PARTIAL_FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'];
const completed = ['SUCCESS', 'CANCELLED', ...failed];
const batchSize = 50;

function config(row: Rule) {
  return JSON.parse(row.config_json) as TriggerConfig;
}

function visibleRule(row: Rule) {
  const { inputValue, cron, timeZone, credentialId, upstreamFlowId, upstreamStatus } = config(row);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    flowId: row.flow_id,
    version: row.version,
    enabled: row.enabled === 1,
    nextAt: row.next_at,
    inputValue,
    cron,
    timeZone,
    credentialId,
    upstreamFlowId,
    upstreamStatus,
  };
}

function visibleEvent(row: Event) {
  return {
    id: row.id,
    eventId: row.event_key,
    status: row.status,
    runId: row.run_id,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function requestHash(rule: Rule, eventId: string, input: string | null) {
  return createHash('sha256')
    .update(JSON.stringify([rule.config_json, eventId, input]))
    .digest('hex');
}

function plainValue(value?: string | null) {
  if (value != null && redactTaskLog(value) !== value)
    throw new BadRequestException('运行参数不能包含明文凭据');
  return value ?? null;
}

@Injectable()
export class GraphTriggersService implements OnModuleInit {
  private readonly logger = new Logger(GraphTriggersService.name);
  private activeTick?: Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    private readonly runner: GraphRunnerService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
    private readonly registry: TaskHandlerRegistry,
  ) {}

  onModuleInit() {
    this.registry.registerGraphTriggerPump(() => this.tick());
  }

  private async requireAdmin(tx: Transaction<Database>, userId: string) {
    const admin = await tx
      .updateTable('users')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', userId)
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .where('must_change_password', '=', 0)
      .returning('id')
      .executeTakeFirst();
    if (!admin) throw new ForbiddenException('触发器的配置管理员已失效，请由管理员重新保存');
  }

  private async checkCredential(credentialId: string) {
    const row = await this.database.db
      .selectFrom('credentials')
      .select('nonce')
      .where('id', '=', credentialId)
      .where('type', '=', 'CUSTOM_SECRET')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!row) throw new BadRequestException('请选择启用的自定义密钥凭据');
    const stored = await this.credentials.decrypt(credentialId, row.nonce);
    const secret = stored.value || stored.secret;
    if (typeof secret !== 'string' || !secret.trim() || Buffer.byteLength(secret, 'utf8') < 32)
      throw new BadRequestException('Webhook 密钥至少需要 32 字节');
    return { secret, nonce: row.nonce };
  }

  private async lockCredential(tx: Transaction<Database>, timing: TriggerConfig) {
    if (!timing.credentialId) return;
    const valid = await tx
      .updateTable('credentials')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', timing.credentialId)
      .where('nonce', '=', timing.credentialNonce!)
      .where('type', '=', 'CUSTOM_SECRET')
      .where('status', '=', 'ACTIVE')
      .returning('id')
      .executeTakeFirst();
    if (!valid) throw new ForbiddenException('Webhook 密钥已变更，请重新保存触发器');
  }

  private async published(projectId: string, version: number) {
    const row = await this.database.db
      .selectFrom('execution_graph_versions as version')
      .innerJoin('execution_graphs as graph', 'graph.id', 'version.graph_id')
      .where('graph.project_id', '=', projectId)
      .where('version.version', '=', version)
      .select('version.definition_json')
      .executeTakeFirst();
    if (!row) throw new NotFoundException('已发布的图版本不存在');
    return JSON.parse(row.definition_json) as GraphDefinition;
  }

  private ensureSafe(definition: GraphDefinition, flowId: string) {
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const flow = definition.flows.find((candidate) => candidate.id === id);
      if (!flow) throw new NotFoundException('该版本中不存在选中的执行流');
      for (const node of flow.nodes) {
        if (!safeNodes.has(node.type))
          throw new BadRequestException(
            '原生触发器只允许图内控制、日志与等待节点。源码拉取、Shell 与交付节点请手动运行',
          );
        if (node.condition?.key === 'commitSha' || node.switch?.key === 'commitSha')
          throw new BadRequestException('触发器仅能提供普通运行参数，需提交 SHA 的节点请手动运行');
        if (node.type === 'FLOW_CALL') visit(node.flowId!);
      }
    };
    visit(flowId);
  }

  private getRule(projectId: string, triggerId: string) {
    return this.database.db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('id', '=', triggerId)
      .executeTakeFirst();
  }

  async list(projectId: string) {
    await requireProject(this.database.db, projectId);
    return (
      await this.database.db
        .selectFrom('execution_graph_triggers')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute()
    ).map(visibleRule);
  }

  async events(projectId: string, triggerId: string) {
    if (!(await this.getRule(projectId, triggerId))) throw new NotFoundException('触发器不存在');
    return (
      await this.database.db
        .selectFrom('execution_graph_trigger_events')
        .selectAll()
        .where('trigger_id', '=', triggerId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(100)
        .execute()
    ).map(visibleEvent);
  }

  async save(projectId: string, input: GraphTriggerDto, userId: string, triggerId?: string) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('请填写触发器名称');
    await requireProject(this.database.db, projectId);
    const definition = await this.published(projectId, input.version);
    this.ensureSafe(definition, input.flowId);
    const now = Date.now();
    const settings: TriggerConfig = {
      revision: randomUUID(),
      inputValue: plainValue(input.inputValue),
    };
    let nextAt: number | null = null;
    if (input.kind === 'CRON') {
      if (!input.timeZone) throw new BadRequestException('请选择计划时区');
      const timing = normalizeScheduleTiming({
        type: 'CRON',
        cron: input.cron,
        timeZone: input.timeZone,
      }) as Cron;
      settings.cron = timing.cron;
      settings.timeZone = timing.timeZone;
      const first = upcomingTimes(timing, now, now, 1)[0]!;
      if (input.enabled) nextAt = first;
    }
    if (input.kind === 'WEBHOOK') {
      if (!input.credentialId) throw new BadRequestException('请选择签名凭据');
      const { nonce } = await this.checkCredential(input.credentialId);
      settings.credentialId = input.credentialId;
      settings.credentialNonce = nonce;
    }
    if (input.kind === 'UPSTREAM') {
      if (
        !input.upstreamFlowId ||
        !input.upstreamStatus ||
        !definition.flows.some((flow) => flow.id === input.upstreamFlowId)
      )
        throw new BadRequestException('请选择同一版本中的上游执行流和状态');
      if (input.upstreamFlowId === input.flowId)
        throw new BadRequestException('执行流不能以上游事件触发自身');
      settings.upstreamFlowId = input.upstreamFlowId;
      settings.upstreamStatus = input.upstreamStatus;
    }
    return this.database.db.transaction().execute(async (tx) => {
      const project = await tx
        .updateTable('projects')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', projectId)
        .where('deleted_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!project) throw new NotFoundException('项目不存在或已归档');
      if (input.enabled) {
        const latest = await tx
          .selectFrom('execution_graphs as graph')
          .innerJoin('execution_graph_versions as version', (join) =>
            join
              .onRef('version.graph_id', '=', 'graph.id')
              .onRef('version.version', '=', 'graph.published_version'),
          )
          .select('version.definition_json')
          .where('graph.project_id', '=', projectId)
          .executeTakeFirst();
        if (latest) {
          const current = JSON.parse(latest.definition_json) as GraphDefinition;
          if (current.canvas && !current.flows.some(({ id }) => id === input.flowId))
            throw new ConflictException('最新发布版已移除该开始节点，不能启用此触发器');
        }
      }
      if (triggerId) {
        const rule = await tx
          .updateTable('execution_graph_triggers')
          .set((eb) => ({ updated_at: eb.ref('updated_at') }))
          .where('id', '=', triggerId)
          .where('project_id', '=', projectId)
          .returning('id')
          .executeTakeFirst();
        if (!rule) throw new NotFoundException('触发器不存在');
      }
      await this.requireAdmin(tx, userId);
      await this.lockCredential(tx, settings);
      if (settings.upstreamFlowId && input.enabled)
        await this.ensureNoUpstreamLoop(
          tx,
          projectId,
          input.version,
          input.flowId,
          settings.upstreamFlowId,
          triggerId,
        );
      const values = {
        project_id: projectId,
        name,
        version: input.version,
        flow_id: input.flowId,
        kind: input.kind,
        config_json: JSON.stringify(settings),
        enabled: input.enabled ? 1 : 0,
        next_at: nextAt,
        created_by: userId,
        updated_at: now,
      };
      const row = triggerId
        ? await tx
            .updateTable('execution_graph_triggers')
            .set(values)
            .where('id', '=', triggerId)
            .where('project_id', '=', projectId)
            .returningAll()
            .executeTakeFirst()
        : await tx
            .insertInto('execution_graph_triggers')
            .values({
              ...values,
              id: randomUUID(),
              created_at: now,
            })
            .returningAll()
            .executeTakeFirst();
      if (!row) throw new NotFoundException('触发器不存在');
      await this.audit.record(
        userId,
        'execution-graph.trigger.save',
        'execution-graph-trigger',
        row.id,
        { projectId, kind: row.kind, enabled: input.enabled, version: row.version },
        tx,
      );
      return visibleRule(row);
    });
  }

  private async ensureNoUpstreamLoop(
    tx: Transaction<Database>,
    projectId: string,
    version: number,
    target: string,
    source: string,
    editing?: string,
  ) {
    const entries = await tx
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('version', '=', version)
      .where('kind', '=', 'UPSTREAM')
      .where('enabled', '=', 1)
      .execute();
    const downstream = new Map<string, string[]>();
    for (const rule of entries) {
      if (rule.id === editing) continue;
      const up = config(rule).upstreamFlowId!;
      downstream.set(up, [...(downstream.get(up) ?? []), rule.flow_id]);
    }
    const pending = [target];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === source) throw new BadRequestException('上游触发器会形成循环');
      if (visited.has(id)) continue;
      visited.add(id);
      pending.push(...(downstream.get(id) ?? []));
    }
  }

  private async lockRule(tx: Transaction<Database>, rule: Rule) {
    const row = await tx
      .updateTable('execution_graph_triggers')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', rule.id)
      .where('enabled', '=', 1)
      .where('config_json', '=', rule.config_json)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new ConflictException('触发器已停用或配置已变更');
  }

  private async recordEvent(
    tx: Transaction<Database>,
    rule: Rule,
    eventId: string,
    value: string | null,
  ) {
    const hash = requestHash(rule, eventId, value);
    const row = await tx
      .insertInto('execution_graph_trigger_events')
      .values({
        id: randomUUID(),
        trigger_id: rule.id,
        event_key: eventId,
        request_hash: hash,
        input_value: value,
        status: 'PENDING',
        created_at: Date.now(),
      })
      .onConflict((c) => c.columns(['trigger_id', 'event_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (row) return row;
    const previous = await tx
      .selectFrom('execution_graph_trigger_events')
      .selectAll()
      .where('trigger_id', '=', rule.id)
      .where('event_key', '=', eventId)
      .executeTakeFirstOrThrow();
    if (previous.request_hash !== hash)
      throw new ConflictException('该事件标识已用于另一组触发参数');
    return previous;
  }

  async invoke(projectId: string, triggerId: string, input: InvokeGraphTriggerDto, userId: string) {
    await requireProject(this.database.db, projectId);
    const rule = await this.getRule(projectId, triggerId);
    if (!rule || rule.kind !== 'API' || !rule.enabled)
      throw new NotFoundException('已启用的 API 触发器不存在');
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockRule(tx, rule);
      const event = await this.recordEvent(
        tx,
        rule,
        input.eventId,
        plainValue(input.inputValue ?? config(rule).inputValue),
      );
      await this.audit.record(
        userId,
        'execution-graph.trigger.invoke',
        'execution-graph-trigger',
        rule.id,
        { eventId: event.id },
        tx,
      );
      return visibleEvent(event);
    });
  }

  async webhook(
    triggerId: string,
    input: {
      raw?: Buffer;
      timestamp?: string;
      eventId?: string;
      signature?: string;
      inputValue?: string;
    },
  ) {
    const { raw, timestamp, eventId, signature } = input;
    if (
      !raw ||
      raw.length > 8192 ||
      !timestamp ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000 ||
      !eventId ||
      !graphDeliveryId.test(eventId) ||
      !signature ||
      !/^sha256=[\da-f]{64}$/i.test(signature)
    )
      throw new UnauthorizedException('Webhook 签名或时间戳无效');
    const rule = await this.database.db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('id', '=', triggerId)
      .where('kind', '=', 'WEBHOOK')
      .where('enabled', '=', 1)
      .executeTakeFirst();
    if (!rule) throw new UnauthorizedException('Webhook 认证失败');
    const settings = config(rule);
    const { secret, nonce } = await this.checkCredential(settings.credentialId!).catch(() => {
      throw new UnauthorizedException('Webhook 认证失败');
    });
    const expected = createHmac('sha256', secret)
      .update(timestamp + '.' + eventId + '.')
      .update(raw)
      .digest();
    if (
      nonce !== settings.credentialNonce ||
      !timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))
    )
      throw new UnauthorizedException('Webhook 认证失败');
    await requireProject(this.database.db, rule.project_id);
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockRule(tx, rule);
      await this.lockCredential(tx, settings);
      const event = await this.recordEvent(
        tx,
        rule,
        eventId,
        plainValue(input.inputValue ?? settings.inputValue),
      );
      return visibleEvent(event);
    });
  }

  tick(now = Date.now()) {
    this.activeTick ??= this.pump(now).finally(() => {
      this.activeTick = undefined;
    });
    return this.activeTick;
  }

  private async enqueueCron(now: number) {
    const due = await this.database.db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('kind', '=', 'CRON')
      .where('enabled', '=', 1)
      .where('next_at', '<=', now)
      .orderBy('next_at')
      .limit(batchSize)
      .execute();
    for (const rule of due) {
      const settings = config(rule);
      const nextAt = upcomingTimes(
        { type: 'CRON', cron: settings.cron!, timeZone: settings.timeZone! },
        now,
        now,
        1,
      )[0]!;
      await this.database.db.transaction().execute(async (tx) => {
        const scheduled = await tx
          .updateTable('execution_graph_triggers')
          .set({ next_at: nextAt })
          .where('id', '=', rule.id)
          .where('enabled', '=', 1)
          .where('config_json', '=', rule.config_json)
          .where('next_at', '=', rule.next_at)
          .returning('id')
          .executeTakeFirst();
        if (scheduled)
          await this.recordEvent(tx, rule, String(rule.next_at), settings.inputValue ?? null);
      });
    }
  }

  private async enqueueUpstream() {
    const available = await this.database.db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('kind', '=', 'UPSTREAM')
      .where('enabled', '=', 1)
      .execute();
    for (const rule of available) {
      const settings = config(rule);
      const statuses =
        settings.upstreamStatus === 'SUCCESS'
          ? ['SUCCESS']
          : settings.upstreamStatus === 'FAILED'
            ? failed
            : completed;
      const runs = await this.database.db
        .selectFrom('execution_flow_runs as run')
        .select('run.id')
        .where('run.project_id', '=', rule.project_id)
        .where('run.version', '=', rule.version)
        .where('run.flow_id', '=', settings.upstreamFlowId!)
        .where('run.parent_run_id', 'is', null)
        .where('run.finished_at', '>=', rule.updated_at)
        .where('run.status', 'in', statuses)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('execution_graph_trigger_events as event')
                .where('event.trigger_id', '=', rule.id)
                .whereRef('event.event_key', '=', 'run.id')
                .select('event.id'),
            ),
          ),
        )
        .orderBy('run.finished_at')
        .orderBy('run.id')
        .limit(batchSize)
        .execute();
      if (!runs.length) continue;
      await this.database.db
        .transaction()
        .execute(async (tx) => {
          await this.lockRule(tx, rule);
          for (const run of runs)
            await this.recordEvent(tx, rule, run.id, settings.inputValue ?? null);
        })
        .catch((error: unknown) => {
          if (!(error instanceof ConflictException)) throw error;
        });
    }
  }

  private async dispatch(event: Event) {
    const rule = await this.database.db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('id', '=', event.trigger_id)
      .executeTakeFirstOrThrow();
    try {
      if (
        !rule.enabled ||
        event.request_hash !== requestHash(rule, event.event_key, event.input_value)
      )
        throw new ConflictException('触发器已停用或配置已变更');
      const definition = await this.published(rule.project_id, rule.version);
      this.ensureSafe(definition, rule.flow_id);
      const inputs = event.input_value == null ? {} : { value: event.input_value };
      const preview = await this.runner.preview(rule.project_id, rule.flow_id, {
        version: rule.version,
        inputs,
      });
      await this.runner.run(
        rule.project_id,
        rule.flow_id,
        {
          version: rule.version,
          inputs,
          expectedConfigurationHash: preview.configurationHash,
          idempotencyKey: 'trigger:' + event.id,
        },
        rule.created_by,
        {
          triggerType: rule.kind as GraphTriggerKind,
          beforeInsert: async (tx) => {
            await this.lockRule(tx, rule);
            await this.requireAdmin(tx, rule.created_by);
            await this.lockCredential(tx, config(rule));
            const pending = await tx
              .updateTable('execution_graph_trigger_events')
              .set({ status: 'PENDING' })
              .where('id', '=', event.id)
              .where('status', '=', 'PENDING')
              .returning('id')
              .executeTakeFirst();
            if (!pending) throw new ConflictException('该触发事件已处理');
          },
          afterInsert: async (tx, runId) => {
            await tx
              .updateTable('execution_graph_trigger_events')
              .set({ status: 'QUEUED', run_id: runId, finished_at: Date.now() })
              .where('id', '=', event.id)
              .execute();
          },
        },
      );
    } catch (error) {
      if (!(error instanceof HttpException)) {
        this.logger.warn('执行图触发事件暂未处理，将在下一轮重试');
        return;
      }
      await this.database.db
        .updateTable('execution_graph_trigger_events')
        .set({
          status: 'REJECTED',
          error: redactTaskLog(error.message).slice(0, 500),
          finished_at: Date.now(),
        })
        .where('id', '=', event.id)
        .where('status', '=', 'PENDING')
        .execute();
    }
  }

  private async pump(now: number) {
    await this.enqueueCron(now);
    await this.enqueueUpstream();
    const pending = await this.database.db
      .selectFrom('execution_graph_trigger_events')
      .selectAll()
      .where('status', '=', 'PENDING')
      .orderBy('created_at')
      .orderBy('id')
      .limit(batchSize)
      .execute();
    for (const event of pending) await this.dispatch(event);
  }
}
