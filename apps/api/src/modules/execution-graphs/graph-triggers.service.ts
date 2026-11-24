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
import { lockProjectGraph, requireProject } from '../projects/project-guards';
import { graphTriggerReferences } from '../projects/project-resource-references';
import { unavailableReference } from '../projects/project-resource-protection';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { redactTaskLog } from '../tasks/task-log.service';
import type { GraphDefinition } from './execution-graph-definition';
import { flowEnd, flowStart, type GraphFieldSource, type Values } from './graph-run-bindings';
import { compatibleGraphFields, validateGraphValue, type GraphField } from './graph-fields';
import {
  graphDeliveryId,
  triggerEventFields,
  type GraphParameterMapping,
  type GraphTriggerDto,
  type GraphTriggerKind,
  type InvokeGraphTriggerDto,
  type UpstreamResult,
} from './graph-trigger.dto';
import { GraphRunnerService } from './graph-runner.service';
import { assertAutomaticGraphFlow, assertGraphAutomation } from './graph-automatic-delivery';

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
  parameterMappings?: Record<string, GraphParameterMapping>;
  repositoryId?: string;
  refPrefix?: string;
}

interface TriggerEventInput {
  invokedBy?: string;
  value?: string | null;
  repositoryId?: string;
  ref?: string;
  commitSha?: string;
  scheduledAt?: number;
  upstreamRunId?: string;
  upstreamStatus?: string;
}

function eventFields(row: Event): TriggerEventInput {
  if (!row.input_value) return {};
  const input = JSON.parse(row.input_value) as TriggerEventInput;
  return input;
}

function mappedValue(
  field: GraphField,
  mapping: GraphParameterMapping,
  event: TriggerEventInput,
  eventId: string,
  upstream?: Values,
) {
  if (mapping.source === 'VALUE') return mapping.value;
  if (mapping.source === 'UPSTREAM_OUTPUT')
    return upstream && Object.hasOwn(upstream, mapping.fieldId)
      ? upstream[mapping.fieldId]
      : undefined;
  switch (mapping.field) {
    case 'repository':
      return event.repositoryId;
    case 'commit':
      return (
        event.commitSha &&
        (field.type === 'GIT_REF' ? { kind: 'COMMIT', value: event.commitSha } : event.commitSha)
      );
    case 'ref':
      return (
        event.ref &&
        (field.type === 'GIT_REF'
          ? {
              kind: event.ref.startsWith('refs/tags/') ? 'TAG' : 'BRANCH',
              value: event.ref.replace(/^refs\/(heads|tags)\//, ''),
            }
          : event.ref)
      );
    case 'eventId':
      return eventId;
    case 'scheduledAt':
      return field.type === 'TEXT' && event.scheduledAt !== undefined
        ? new Date(event.scheduledAt).toISOString()
        : event.scheduledAt;
    case 'upstreamRunId':
      return event.upstreamRunId;
    case 'upstreamStatus':
      return event.upstreamStatus;
  }
}
const failed = ['FAILED', 'PARTIAL_FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'];
const completed = ['SUCCESS', 'CANCELLED', ...failed];
const batchSize = 50;

function config(row: Rule) {
  return JSON.parse(row.config_json) as TriggerConfig;
}

function visibleRule(row: Rule) {
  const {
    inputValue,
    cron,
    timeZone,
    credentialId,
    upstreamFlowId,
    upstreamStatus,
    parameterMappings,
    repositoryId,
    refPrefix,
  } = config(row);
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
    parameterMappings,
    repositoryId,
    refPrefix,
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
    metadata: eventFields(row),
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

  private async published(
    projectId: string,
    version: number,
    db = this.database.db,
    runnable = true,
  ) {
    const row = await db
      .selectFrom('execution_graph_versions as version')
      .innerJoin('execution_graphs as graph', 'graph.id', 'version.graph_id')
      .where('graph.project_id', '=', projectId)
      .where('version.version', '=', version)
      .select(['version.definition_json', 'version.retired_at'])
      .executeTakeFirst();
    if (!row) throw new NotFoundException('已发布的图版本不存在');
    if (runnable && row.retired_at !== null) throw new ConflictException('该执行图版本已停用');
    return JSON.parse(row.definition_json) as GraphDefinition;
  }

  private startFields(definition: GraphDefinition, flowId: string) {
    const flow = definition.flows.find((candidate) => candidate.id === flowId);
    if (!flow) throw new NotFoundException('该版本中不存在选中的执行流');
    return flowStart(flow).inputs ?? [];
  }

  private validateMappings(
    fields: GraphField[],
    input: GraphTriggerDto,
    definition: GraphDefinition,
  ) {
    const mappings = Object.entries(input.parameterMappings ?? {});
    if (mappings.length > 64 || JSON.stringify(mappings).length > 32768)
      throw new BadRequestException('触发参数映射过大');
    const samples: TriggerEventInput = {
      ...(input.kind === 'WEBHOOK' || input.kind === 'API'
        ? {
            repositoryId: '00000000-0000-4000-a000-000000000001',
            ref: 'refs/heads/main',
            commitSha: 'a'.repeat(40),
          }
        : {}),
      ...(input.kind === 'CRON' && { scheduledAt: 1 }),
      ...(input.kind === 'UPSTREAM' && { upstreamRunId: 'example', upstreamStatus: 'SUCCESS' }),
    };
    for (const [id, mapping] of mappings) {
      const field = fields.find((candidate) => candidate.id === id);
      if (!field || !mapping || !['VALUE', 'EVENT', 'UPSTREAM_OUTPUT'].includes(mapping.source))
        throw new BadRequestException('触发参数映射未引用有效的开始参数');
      if (mapping.source === 'UPSTREAM_OUTPUT') {
        const upstream = definition.flows.find(({ id }) => id === input.upstreamFlowId);
        const output =
          upstream && flowEnd(upstream).outputs?.find(({ id }) => id === mapping.fieldId);
        if (
          input.kind !== 'UPSTREAM' ||
          input.upstreamStatus !== 'SUCCESS' ||
          !output ||
          ![
            'TEXT',
            'NUMBER',
            'BOOLEAN',
            'REPOSITORY',
            'GIT_REF',
            'SERVICE',
            'ARTIFACT',
            'PATH',
            'IMAGE',
          ].includes(output.type) ||
          !compatibleGraphFields(field, output) ||
          (field.required !== false &&
            field.defaultValue === undefined &&
            output.required === false)
        )
          throw new BadRequestException(
            '参数「' + field.name + '」需要同版本上游成功且可独立验证的兼容输出',
          );
        continue;
      }
      if (field.type === 'ENVIRONMENT_SET' && mapping.source === 'EVENT')
        throw new BadRequestException('变量集合参数需要指定项目集合或沿用字段默认值');
      if (mapping.source === 'EVENT' && !triggerEventFields.includes(mapping.field))
        throw new BadRequestException('触发参数引用了未知事件字段');
      const sample = mappedValue(field, mapping, samples, 'example');
      if (
        sample === undefined ||
        (mapping.source === 'VALUE' && !validateGraphValue(field, sample)) ||
        (mapping.source === 'EVENT' &&
          (field.multiple || !validateGraphValue({ ...field, options: undefined }, sample)))
      )
        throw new BadRequestException('触发事件无法提供参数「' + field.name + '」所需的值');
      const encoded = JSON.stringify(sample);
      if (redactTaskLog(encoded) !== encoded)
        throw new BadRequestException('触发映射不能包含明文凭据');
    }
    if (input.enabled)
      for (const field of fields)
        if (
          field.required !== false &&
          field.defaultValue === undefined &&
          field.selection !== 'LATEST_COMPATIBLE' &&
          !Object.hasOwn(input.parameterMappings ?? {}, field.id)
        )
          throw new BadRequestException(
            '启用前请为必填参数「' + field.name + '」指定事件映射或默认值',
          );
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
    const definition = await this.published(
      projectId,
      input.version,
      this.database.db,
      input.enabled,
    );
    this.validateMappings(this.startFields(definition, input.flowId), input, definition);
    if (input.enabled) assertAutomaticGraphFlow(definition, input.flowId, input.kind);
    const now = Date.now();
    const settings: TriggerConfig = {
      revision: randomUUID(),
      inputValue: plainValue(input.inputValue),
      parameterMappings: input.parameterMappings,
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
      settings.repositoryId = input.repositoryId;
      settings.refPrefix = input.refPrefix;
      if (
        input.repositoryId &&
        !(await this.database.db
          .selectFrom('repositories')
          .select('id')
          .where('id', '=', input.repositoryId)
          .where('project_id', '=', projectId)
          .where('archived_at', 'is', null)
          .executeTakeFirst())
      )
        throw new BadRequestException('Webhook 仓库过滤必须引用当前项目中的仓库');
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
      await lockProjectGraph(tx);
      const project = await tx
        .updateTable('projects')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', projectId)
        .where('deleted_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!project) throw new NotFoundException('项目不存在或已归档');
      if (input.enabled) {
        const bound = await this.published(projectId, input.version, tx);
        const references = graphTriggerReferences(
          bound,
          {
            sourceId: triggerId ?? projectId,
            version: input.version,
            flowId: input.flowId,
            label: name,
          },
          settings,
        );
        if (await unavailableReference(tx, projectId, references))
          throw new ConflictException('触发器引用的资源不可用，请检查参数映射');
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
      .where('version', '=', rule.version)
      .where('flow_id', '=', rule.flow_id)
      .where('config_json', '=', rule.config_json)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new ConflictException('触发器已停用或配置已变更');
  }

  async validateMigrationBinding(
    tx: Transaction<Database>,
    rule: Rule,
    version: number,
    definition: GraphDefinition,
  ) {
    const settings = config(rule);
    const active = rule.enabled === 1;
    const flow = definition.flows.find(({ id }) => id === rule.flow_id);
    if (!flow) throw new ConflictException('切换版本中没有触发器关联的执行流');
    const fields = flowStart(flow).inputs ?? [];
    this.validateMappings(
      fields,
      {
        name: rule.name,
        kind: rule.kind as GraphTriggerKind,
        version,
        flowId: rule.flow_id,
        enabled: active,
        parameterMappings: settings.parameterMappings,
        upstreamFlowId: settings.upstreamFlowId,
        upstreamStatus: settings.upstreamStatus,
      },
      definition,
    );
    if (!active) return;
    assertAutomaticGraphFlow(definition, rule.flow_id, rule.kind as GraphTriggerKind);
    if (settings.upstreamFlowId) {
      if (!definition.flows.some(({ id }) => id === settings.upstreamFlowId))
        throw new ConflictException('切换版本缺少触发器所需的上游执行流');
      await this.ensureNoUpstreamLoop(
        tx,
        rule.project_id,
        version,
        rule.flow_id,
        settings.upstreamFlowId,
        rule.id,
      );
    }
    await this.requireAdmin(tx, rule.created_by);
    await this.lockCredential(tx, settings);
    const references = graphTriggerReferences(
      definition,
      { sourceId: rule.id, version, flowId: rule.flow_id, label: rule.name },
      settings,
    );
    if (await unavailableReference(tx, rule.project_id, references))
      throw new ConflictException('触发器引用的资源不可用，请检查参数映射');
  }

  private async recordEvent(
    tx: Transaction<Database>,
    rule: Rule,
    eventId: string,
    fields: TriggerEventInput,
  ) {
    const value = JSON.stringify(fields);
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
    if (previous.request_hash === hash) return previous;
    if (rule.kind === 'API' && !eventFields(previous).invokedBy) {
      const legacyInput = { ...fields };
      delete legacyInput.invokedBy;
      if (previous.request_hash === requestHash(rule, eventId, JSON.stringify(legacyInput)))
        return previous;
    }
    throw new ConflictException('该事件标识已用于另一组触发参数');
  }

  async invoke(projectId: string, triggerId: string, input: InvokeGraphTriggerDto, userId: string) {
    await requireProject(this.database.db, projectId);
    const rule = await this.getRule(projectId, triggerId);
    if (!rule || rule.kind !== 'API' || !rule.enabled)
      throw new NotFoundException('已启用的 API 触发器不存在');
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockRule(tx, rule);
      const event = await this.recordEvent(tx, rule, input.eventId, {
        invokedBy: userId,
        value: plainValue(input.inputValue ?? config(rule).inputValue),
        repositoryId: input.repositoryId,
        ref: input.ref,
        commitSha: input.commitSha?.toLowerCase(),
      });
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
      repositoryId?: string;
      ref?: string;
      commitSha?: string;
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
    if (
      (settings.repositoryId && settings.repositoryId !== input.repositoryId) ||
      (settings.refPrefix && !input.ref?.startsWith(settings.refPrefix))
    )
      return { status: 'IGNORED' };
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockRule(tx, rule);
      await this.lockCredential(tx, settings);
      const event = await this.recordEvent(tx, rule, eventId, {
        value: plainValue(input.inputValue ?? settings.inputValue),
        repositoryId: input.repositoryId,
        ref: input.ref,
        commitSha: input.commitSha?.toLowerCase(),
      });
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
          .where('version', '=', rule.version)
          .where('flow_id', '=', rule.flow_id)
          .where('config_json', '=', rule.config_json)
          .where('next_at', '=', rule.next_at)
          .returning('id')
          .executeTakeFirst();
        if (scheduled)
          await this.recordEvent(tx, rule, String(rule.next_at), {
            value: settings.inputValue,
            scheduledAt: rule.next_at!,
          });
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
        .select(['run.id', 'run.status'])
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
            await this.recordEvent(tx, rule, run.id, {
              value: settings.inputValue,
              upstreamRunId: run.id,
              upstreamStatus: run.status,
            });
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
      const kind = rule.kind as GraphTriggerKind;
      const hasDelivery = assertAutomaticGraphFlow(definition, rule.flow_id, kind);
      const fields = this.startFields(definition, rule.flow_id);
      const { invokedBy, ...eventInput } = eventFields(event);
      const settings = config(rule);
      const authorization = { kind, ruleId: rule.id, revision: settings.revision, invokedBy };
      const mappings = settings.parameterMappings ?? {};
      const parameterSources: Record<string, GraphFieldSource> = Object.create(null);
      const upstream = Object.values(mappings).some(({ source }) => source === 'UPSTREAM_OUTPUT')
        ? await this.upstreamValues(rule, settings, eventInput.upstreamRunId)
        : undefined;
      const parameters = Object.fromEntries(
        fields.flatMap((field) => {
          const mapping = Object.hasOwn(mappings, field.id) ? mappings[field.id] : undefined;
          if (!mapping) return [];
          const value = mappedValue(field, mapping, eventInput, event.event_key, upstream);
          if (value === undefined) {
            if (
              mapping.source === 'EVENT' &&
              (field.required !== false || field.type === 'GIT_REF')
            )
              throw new BadRequestException('触发事件未提供参数「' + field.name + '」选定的来源');
            return [];
          }
          parameterSources[field.id] =
            mapping.source === 'EVENT'
              ? { kind: 'TRIGGER_EVENT', eventField: mapping.field }
              : mapping.source === 'UPSTREAM_OUTPUT'
                ? { kind: 'UPSTREAM_OUTPUT', fieldId: mapping.fieldId }
                : { kind: 'TRIGGER_VALUE' };
          return [[field.id, value]];
        }),
      );
      const inputs = {
        value: eventInput.value ?? undefined,
        parameters,
      };
      const metadata: Values = {
        ...eventInput,
        value: undefined,
        eventId: event.event_key,
        kind: rule.kind,
        triggeredAt: eventInput.scheduledAt ?? event.created_at,
        parameterSources,
      };
      const preview = await this.runner.preview(
        rule.project_id,
        rule.flow_id,
        {
          version: rule.version,
          inputs,
        },
        { trigger: metadata, automation: authorization },
      );
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
          triggerType: kind,
          authorization,
          metadata,
          beforeInsert: async (tx) => {
            await this.lockRule(tx, rule);
            await this.requireAdmin(tx, rule.created_by);
            await this.lockCredential(tx, config(rule));
            await assertGraphAutomation(
              tx,
              rule.project_id,
              rule.created_by,
              authorization,
              hasDelivery,
            );
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

  private async upstreamValues(rule: Rule, settings: TriggerConfig, upstreamRunId?: string) {
    if (!upstreamRunId || !settings.upstreamFlowId || rule.kind !== 'UPSTREAM')
      throw new BadRequestException('缺少上游执行记录');
    const output = await this.database.db
      .selectFrom('execution_flow_runs as run')
      .innerJoin('execution_node_runs as node', 'node.run_id', 'run.id')
      .select('node.output_json')
      .where('run.id', '=', upstreamRunId)
      .where('run.project_id', '=', rule.project_id)
      .where('run.version', '=', rule.version)
      .where('run.flow_id', '=', settings.upstreamFlowId)
      .where('run.parent_run_id', 'is', null)
      .where('run.status', '=', 'SUCCESS')
      .where('node.node_type', '=', 'END')
      .where('node.status', '=', 'SUCCESS')
      .executeTakeFirst();
    if (!output) throw new ConflictException('上游执行记录已失效或未成功完成');
    return JSON.parse(output.output_json ?? '{}') as Values;
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
