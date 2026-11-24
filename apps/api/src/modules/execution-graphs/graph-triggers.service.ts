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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
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
import { RepositoryMetadataService } from '../projects/repository-metadata.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { redactTaskLog } from '../tasks/task-log.service';
import type { GraphDefinition } from './execution-graph-definition';
import { flowEnd, flowStart, type GraphFieldSource, type Values } from './graph-run-bindings';
import {
  compatibleGraphFields,
  GraphCompileError,
  validateGraphValue,
  type GraphField,
} from './graph-fields';
import {
  triggerEventFields,
  type GraphParameterMapping,
  type GraphTriggerDto,
  type GraphTriggerKind,
  type InvokeGraphTriggerDto,
  type UpstreamResult,
} from './graph-trigger.dto';
import { GraphRunnerService } from './graph-runner.service';
import {
  branchPrefix,
  compareSourceObservation,
  decodeTriggerWebhook,
  matchesGiteaRepository,
  resolveTriggerSource,
  sourceObservation,
  SourceObservationChanged,
  sourceWebhook,
  updateObservation,
  validBranchRef,
  validCommit,
  type SourceScope,
  type TriggerSourceConfig,
  type WebhookRequest,
} from './graph-trigger-source';
import { assertAutomaticGraphFlow, assertGraphAutomation } from './graph-automatic-delivery';

type Rule = Selectable<Database['execution_graph_triggers']>;
type Event = Selectable<Database['execution_graph_trigger_events']>;
type Cron = Extract<ScheduleTiming, { type: 'CRON' }>;

interface TriggerConfig extends TriggerSourceConfig {
  revision: string;
  enabledSince?: number;
  unpublished?: boolean;
  followLatest?: boolean;
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
  checkedAt?: number;
  previousCommitSha?: string;
  checkoutNodeId?: string;
  eventSource?: 'POLL' | 'GITEA' | 'BEARER' | 'SIGNED';
  upstreamRunId?: string;
  upstreamStatus?: string;
  upstreamVersion?: number;
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
    cronMode,
    buildOnFirstObservation,
    webhookProtocol,
    ref,
    unpublished,
  } = config(row);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    flowId: row.flow_id,
    version: unpublished ? null : row.version,
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
    cronMode,
    buildOnFirstObservation,
    webhookProtocol,
    ref,
    receivePath: row.kind === 'WEBHOOK' ? '/api/v1/graph-webhooks/' + row.id : undefined,
  };
}

function visibleEvent(row: Event & { runStatus?: string | null }) {
  return {
    id: row.id,
    eventId: row.event_key,
    status: row.status,
    runId: row.run_id,
    runStatus: row.runStatus,
    version: row.graph_version,
    flowId: row.flow_id,
    ruleRevision: row.rule_revision,
    parameters: row.resolved_inputs ? (JSON.parse(row.resolved_inputs) as Values) : undefined,
    duplicateOf: row.duplicate_of,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    metadata: eventFields(row),
  };
}

function requestHash(eventId: string, input: string | null, legacyConfig?: string) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        legacyConfig === undefined ? [eventId, input] : [legacyConfig, eventId, input],
      ),
    )
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
    private readonly repositories: RepositoryMetadataService,
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

  private async checkCredential(credentialId: string, db = this.database.db) {
    const row = await db
      .selectFrom('credentials')
      .select('nonce')
      .where('id', '=', credentialId)
      .where('type', '=', 'CUSTOM_SECRET')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!row) throw new BadRequestException('请选择启用的自定义密钥凭据');
    const stored = await this.credentials.decrypt(credentialId, row.nonce, db);
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

  private sourceSettings(input: GraphTriggerDto): TriggerSourceConfig & { refPrefix?: string } {
    if (input.kind === 'CRON') {
      const cronMode = input.cronMode ?? 'RUN';
      return cronMode === 'POLL'
        ? {
            cronMode,
            buildOnFirstObservation: input.buildOnFirstObservation ?? false,
            repositoryId: input.repositoryId,
            ref: input.ref,
          }
        : { cronMode };
    }
    if (input.kind !== 'WEBHOOK') return {};
    const webhookProtocol = input.webhookProtocol ?? 'SIGNED';
    if (input.ref && !validBranchRef(input.ref))
      throw new BadRequestException('请输入有效的分支完整引用，如 refs/heads/main');
    return {
      webhookProtocol,
      repositoryId: input.repositoryId,
      ref: input.ref,
      refPrefix: webhookProtocol === 'SIGNED' ? input.refPrefix : undefined,
    };
  }

  private resolveSourceScope(
    projectId: string,
    source: { flowId: string; settings: TriggerConfig },
    definition: GraphDefinition,
    db = this.database.db,
  ) {
    return resolveTriggerSource(db, projectId, source.flowId, source.settings, definition);
  }

  private async sourceRepository(projectId: string, repositoryId: string, db = this.database.db) {
    const row = await db
      .selectFrom('repositories')
      .select(['clone_url', 'credential_id', 'updated_at'])
      .where('id', '=', repositoryId)
      .where('project_id', '=', projectId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new BadRequestException('触发规则关联的仓库已不可用');
    return row;
  }

  private async observeHead(projectId: string, scope: { repositoryId: string; ref: string }) {
    const access = await this.sourceRepository(projectId, scope.repositoryId);
    const branch = scope.ref.slice(branchPrefix.length);
    const heads = await this.repositories.branchHeads(
      projectId,
      scope.repositoryId,
      [branch],
      access,
    );
    const sha = heads.get(branch);
    if (!sha || !validCommit(sha))
      throw new BadRequestException('远端分支不存在或未返回有效的提交');
    return sha.toLowerCase();
  }

  private async prepareCredential(
    tx: Transaction<Database>,
    input: GraphTriggerDto,
    settings: TriggerConfig,
    userId: string,
    previous?: TriggerConfig,
  ) {
    if (input.kind !== 'WEBHOOK') return undefined;
    const credentialId = input.credentialId ?? previous?.credentialId;
    if (credentialId) {
      if (credentialId === previous?.credentialId && previous?.generatedCredential) {
        settings.credentialId = credentialId;
        settings.credentialNonce = previous.credentialNonce;
        settings.generatedCredential = true;
        return undefined;
      }
      const { nonce } = await this.checkCredential(credentialId, tx);
      settings.credentialId = credentialId;
      settings.credentialNonce = nonce;
      return undefined;
    }
    if (!sourceWebhook(settings.webhookProtocol)) throw new BadRequestException('请选择签名凭据');
    const secret = randomBytes(32).toString('base64url');
    const stored = await this.credentials.storeWebhookSecret(
      tx,
      userId,
      'Webhook · ' + input.name,
      secret,
    );
    settings.credentialId = stored.id;
    settings.credentialNonce = stored.nonce;
    settings.generatedCredential = true;
    return secret;
  }

  private async sourceObservation(row: Rule, definition?: GraphDefinition) {
    const settings = config(row);
    if (settings.cronMode !== 'POLL' && !sourceWebhook(settings.webhookProtocol)) return undefined;
    const scope = await this.sourceDefinition(row, settings, definition)
      .then((published) =>
        this.resolveSourceScope(row.project_id, { flowId: row.flow_id, settings }, published),
      )
      .catch((error: unknown) => {
        if (!(error instanceof HttpException)) throw error;
        return undefined;
      });
    const observation = scope
      ? await sourceObservation(this.database.db, this.sourceKey(row, scope))
      : undefined;
    return {
      commitSha: observation?.commit_sha,
      lastCheckedAt: row.source_checked_at ?? observation?.last_checked_at,
      error: row.source_error || undefined,
      resolvedRepositoryId: scope?.repositoryId,
      resolvedRef: scope?.ref,
    };
  }

  private async sourceDefinition(row: Rule, settings: TriggerConfig, definition?: GraphDefinition) {
    if (definition) return definition;
    if (settings.unpublished) {
      const graph = await this.projectGraph(row.project_id);
      return JSON.parse(graph.draft_json) as GraphDefinition;
    }
    return this.published(row.project_id, row.version);
  }

  private sourceKey(rule: Rule, scope: { repositoryId: string; ref: string }): SourceScope {
    return {
      project_id: rule.project_id,
      flow_id: rule.flow_id,
      repository_id: scope.repositoryId,
      ref: scope.ref,
    };
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
    upstreamDefinition = definition,
  ) {
    const mappings = Object.entries(input.parameterMappings ?? {});
    if (mappings.length > 64 || JSON.stringify(mappings).length > 32768)
      throw new BadRequestException('触发参数映射过大');
    const samples: TriggerEventInput = {
      ...(input.kind === 'WEBHOOK' || input.kind === 'API' || input.cronMode === 'POLL'
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
      if (field.runtimeOverride === false)
        throw this.triggerPlanIssue(
          input.flowId,
          '参数「' + field.name + '」采用已发布的默认值，触发器不能覆盖',
          field.id,
        );
      if (mapping.source === 'UPSTREAM_OUTPUT') {
        const upstream = upstreamDefinition.flows.find(({ id }) => id === input.upstreamFlowId);
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
          throw this.triggerPlanIssue(
            input.flowId,
            '参数「' + field.name + '」需要上游成功且可独立验证的兼容输出',
            field.id,
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
          throw this.triggerPlanIssue(
            input.flowId,
            '启用前请为必填参数「' + field.name + '」指定事件映射或默认值',
            field.id,
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
    const rows = await this.database.db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return Promise.all(
      rows.map(async (row) => {
        const observation = await this.sourceObservation(row);
        return {
          ...visibleRule(row),
          observation,
          resolvedRepositoryId: observation?.resolvedRepositoryId,
          resolvedRef: observation?.resolvedRef,
        };
      }),
    );
  }

  async events(projectId: string, triggerId: string) {
    await requireProject(this.database.db, projectId);
    if (!(await this.getRule(projectId, triggerId))) throw new NotFoundException('触发器不存在');
    return (
      await this.database.db
        .selectFrom('execution_graph_trigger_events as event')
        .leftJoin(
          'execution_graph_trigger_events as canonical',
          'canonical.id',
          'event.duplicate_of',
        )
        .leftJoin('execution_flow_runs as run', (join) =>
          join.on((eb) => eb('run.id', '=', eb.fn.coalesce('event.run_id', 'canonical.run_id'))),
        )
        .selectAll('event')
        .select(['run.status as runStatus', 'run.id as effectiveRunId'])
        .where('event.trigger_id', '=', triggerId)
        .orderBy('event.created_at', 'desc')
        .orderBy('event.id', 'desc')
        .limit(100)
        .execute()
    ).map(({ effectiveRunId, ...row }) => visibleEvent({ ...row, run_id: effectiveRunId }));
  }

  private async projectGraph(projectId: string, db: Kysely<Database> = this.database.db) {
    const graph = await db
      .selectFrom('execution_graphs')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!graph) throw new NotFoundException('项目执行图不存在');
    return graph;
  }

  private triggerPlanIssue(flowId: string, message: string, fieldId?: string) {
    return new ExecutionPlanIssueError({ code: 'INPUT', flowId, nodeId: flowId, fieldId, message });
  }

  private candidateSettings(input: GraphTriggerDto, now: number): TriggerConfig {
    if (!input.name.trim()) throw new BadRequestException('请填写触发器名称');
    const settings: TriggerConfig = {
      revision: randomUUID(),
      inputValue: plainValue(input.inputValue),
      parameterMappings: input.parameterMappings,
      ...this.sourceSettings(input),
    };
    if (input.enabled) settings.enabledSince = now;
    if (input.kind === 'CRON') {
      const timing = normalizeScheduleTiming({
        type: 'CRON',
        cron: input.cron,
        timeZone: input.timeZone,
      }) as Cron;
      settings.cron = timing.cron;
      settings.timeZone = timing.timeZone;
    }
    if (input.kind === 'UPSTREAM') {
      if (!input.upstreamFlowId)
        throw this.triggerPlanIssue(input.flowId, '请选择上游执行流', 'upstreamFlowId');
      if (input.upstreamFlowId === input.flowId)
        throw this.triggerPlanIssue(input.flowId, '执行流不能以上游事件触发自身', 'upstreamFlowId');
      settings.upstreamFlowId = input.upstreamFlowId;
      settings.upstreamStatus = input.upstreamStatus ?? 'SUCCESS';
    }
    if (JSON.stringify(settings.parameterMappings ?? {}).length > 32768)
      throw new BadRequestException('触发参数映射过大');
    return settings;
  }

  private nextTimes(settings: TriggerConfig, now: number, count: number) {
    return settings.cron && settings.timeZone
      ? upcomingTimes(
          { type: 'CRON', cron: settings.cron, timeZone: settings.timeZone },
          now,
          now,
          count,
        )
      : [];
  }

  private sourceRule(kind: GraphTriggerKind, settings: TriggerConfig) {
    return (
      settings.cronMode === 'POLL' ||
      (kind === 'WEBHOOK' &&
        (settings.webhookProtocol === 'GITEA' || settings.webhookProtocol === 'BEARER'))
    );
  }

  private mappingInput(
    input: Pick<GraphTriggerDto, 'name' | 'flowId' | 'kind'>,
    version: number,
    settings: TriggerConfig,
  ): GraphTriggerDto {
    return {
      ...input,
      version,
      enabled: true,
      cronMode: settings.cronMode,
      upstreamFlowId: settings.upstreamFlowId,
      upstreamStatus: settings.upstreamStatus,
      parameterMappings: settings.parameterMappings,
    };
  }

  private async checkPlan(
    projectId: string,
    graphId: string,
    input: Pick<GraphTriggerDto, 'name' | 'flowId' | 'kind'>,
    version: number,
    definition: GraphDefinition,
    settings: TriggerConfig,
    ruleId?: string,
  ) {
    const fields = this.startFields(definition, input.flowId);
    this.validateMappings(fields, this.mappingInput(input, version, settings), definition);
    if (
      settings.upstreamFlowId &&
      !definition.flows.some(({ id }) => id === settings.upstreamFlowId)
    )
      throw this.triggerPlanIssue(input.flowId, '发布版本中缺少上游执行流', 'upstreamFlowId');
    const checkout = this.sourceRule(input.kind, settings)
      ? await this.resolveSourceScope(projectId, { flowId: input.flowId, settings }, definition)
      : undefined;
    const mappings = settings.parameterMappings ?? {};
    const incoming: TriggerEventInput = {
      ...(input.kind === 'CRON' && { scheduledAt: Date.now() }),
      ...(input.kind === 'UPSTREAM' && {
        upstreamRunId: 'preview',
        upstreamStatus: settings.upstreamStatus,
      }),
      ...(checkout && { repositoryId: checkout.repositoryId, ref: checkout.ref }),
    };
    if (
      checkout &&
      Object.values(mappings).some((item) => item.source === 'EVENT' && item.field === 'commit')
    )
      incoming.commitSha = await this.observeHead(projectId, checkout);

    const parameters: Values = Object.create(null);
    const artifacts = new Set<string>();
    for (const field of fields) {
      const mapping = Object.hasOwn(mappings, field.id) ? mappings[field.id] : undefined;
      if (!mapping) continue;
      if (mapping.source === 'UPSTREAM_OUTPUT' && field.type === 'ARTIFACT') {
        artifacts.add(field.id);
        continue;
      }
      const sample = mappedValue(field, mapping, incoming, 'preview') ?? field.defaultValue;
      if (sample !== undefined) {
        parameters[field.id] = sample;
        continue;
      }
      const scalar =
        field.type === 'TEXT'
          ? 'preview'
          : field.type === 'NUMBER'
            ? 0
            : field.type === 'BOOLEAN'
              ? false
              : undefined;
      if (scalar !== undefined && validateGraphValue(field, scalar)) {
        parameters[field.id] = scalar;
        continue;
      }
      // A free-form authenticated API event can provide legacy Git facts at invocation.
      if (
        !checkout &&
        (input.kind === 'API' || input.kind === 'WEBHOOK') &&
        mapping.source === 'EVENT' &&
        ['repository', 'commit', 'ref'].includes(mapping.field)
      ) {
        const flow = definition.flows.find(({ id }) => id === input.flowId)!;
        if (
          flow.nodes.some(({ type }) =>
            ['BUILD', 'CHECKOUT', 'DEPLOY_ARTIFACT', 'SHELL', 'CHECK'].includes(type),
          )
        )
          throw this.triggerPlanIssue(
            input.flowId,
            '请为自动交付配置可验证的默认源码或使用绑定仓库的 Webhook',
            field.id,
          );
        continue;
      }
      if (field.required !== false)
        throw this.triggerPlanIssue(
          input.flowId,
          '暂无法验证参数「' + field.name + '」的可用值',
          field.id,
        );
    }
    const automation = {
      kind: input.kind,
      ruleId: ruleId ?? 'preflight',
      revision: settings.revision,
    };
    assertAutomaticGraphFlow(definition, input.flowId, input.kind);
    await this.runner.preview(
      projectId,
      input.flowId,
      { version, inputs: { value: settings.inputValue ?? undefined, parameters } },
      {
        automation,
        definitionOverride: { graphId, definition },
        pendingArtifactParameters: artifacts,
      },
    );
    return checkout;
  }

  async preflight(projectId: string, input: GraphTriggerDto, userId: string, triggerId?: string) {
    await requireProject(this.database.db, projectId);
    const graph = await this.projectGraph(projectId);
    const candidate = { ...input, enabled: true };
    const version = graph.published_version;
    let nextTimes: number[] = [];
    let timeZone: string | undefined;
    try {
      const settings = this.candidateSettings(candidate, Date.now());
      timeZone = settings.timeZone;
      nextTimes = this.nextTimes(settings, Date.now(), 3);
      if (!version) throw this.triggerPlanIssue(input.flowId, '请先发布当前执行流');
      if (input.version !== undefined && input.version !== version)
        throw new ConflictException('已发布版本已变化，请刷新后校验');
      const definition = await this.published(projectId, version);
      if (input.kind === 'WEBHOOK' && input.credentialId) {
        const { nonce } = await this.checkCredential(input.credentialId);
        settings.credentialId = input.credentialId;
        settings.credentialNonce = nonce;
      }
      const checkout = await this.checkPlan(
        projectId,
        graph.id,
        candidate,
        version,
        definition,
        settings,
        triggerId,
      );
      await this.database.db.transaction().execute(async (tx) => {
        await this.requireAdmin(tx, userId);
        if (settings.upstreamFlowId)
          await this.ensureNoUpstreamLoop(
            tx,
            projectId,
            input.flowId,
            settings.upstreamFlowId,
            triggerId,
          );
        await this.validateTriggerReferences(
          tx,
          projectId,
          definition,
          {
            sourceId: triggerId ?? projectId,
            version,
            flowId: input.flowId,
            label: input.name,
          },
          settings,
        );
      });
      return { eligible: true, version, nextTimes, timeZone, checkout };
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const issue =
        error instanceof ExecutionPlanIssueError
          ? error.issue
          : { message: error.message, flowId: input.flowId, nodeId: input.flowId };
      return { eligible: false, version, nextTimes, timeZone, issue };
    }
  }

  async save(projectId: string, input: GraphTriggerDto, userId: string, triggerId?: string) {
    await requireProject(this.database.db, projectId);
    const graph = await this.projectGraph(projectId);
    const previous = triggerId ? await this.getRule(projectId, triggerId) : undefined;
    if (triggerId && !previous) throw new NotFoundException('触发器不存在');
    const name = input.name.trim();
    const now = Date.now();
    const settings = this.candidateSettings(input, now);
    const version = graph.published_version;
    const times = this.nextTimes(settings, now, 1);
    if (input.enabled) {
      if (!version) throw this.triggerPlanIssue(input.flowId, '请先发布当前执行流');
      if (input.version !== undefined && input.version !== version)
        throw new ConflictException('已发布版本已变化，请刷新后启用触发器');
      const definition = await this.published(projectId, version);
      await this.checkPlan(projectId, graph.id, input, version, definition, settings, triggerId);
    }
    settings.unpublished = !version;
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
      const current = await this.projectGraph(projectId, tx);
      const liveVersion = current.published_version;
      if (input.enabled && version !== liveVersion)
        throw new ConflictException('已发布版本已变化，请刷新后启用触发器');
      if (input.draftRevision !== undefined && current.revision !== input.draftRevision)
        throw new ConflictException('执行图草稿已变化，请刷新后保存触发器');
      const bound = liveVersion
        ? await this.published(projectId, liveVersion, tx, input.enabled)
        : undefined;
      const sameFlow = previous?.flow_id === input.flowId;
      const flowPublished = bound?.flows.some(({ id }) => id === input.flowId) ?? false;
      if (!input.enabled && !flowPublished && !sameFlow) {
        const draft = JSON.parse(current.draft_json) as GraphDefinition;
        if (
          !draft.flows.some(({ id }) => id === input.flowId) &&
          !draft.canvas?.nodes.some(({ id, type }) => id === input.flowId && type === 'START')
        )
          throw this.triggerPlanIssue(input.flowId, '请先保存包含该开始节点的画布草稿');
      }
      settings.unpublished = !flowPublished;
      if (flowPublished && !bound?.canvas) settings.followLatest = false;
      const actor = input.enabled || !previous ? userId : previous.created_by;
      await this.requireAdmin(tx, userId);
      if (previous) {
        const locked = await tx
          .updateTable('execution_graph_triggers')
          .set((eb) => ({ updated_at: eb.ref('updated_at') }))
          .where('id', '=', previous.id)
          .where('project_id', '=', projectId)
          .where('config_json', '=', previous.config_json)
          .returning('id')
          .executeTakeFirst();
        if (!locked) throw new ConflictException('触发器已变化，请刷新后保存');
      }
      const priorSettings = previous && config(previous);
      const keepPausedSecret =
        !input.enabled &&
        input.kind === 'WEBHOOK' &&
        priorSettings?.credentialId &&
        (!input.credentialId || input.credentialId === priorSettings.credentialId);
      if (keepPausedSecret) {
        settings.credentialId = priorSettings.credentialId;
        settings.credentialNonce = priorSettings.credentialNonce;
        settings.generatedCredential = priorSettings.generatedCredential;
      }
      const secret = keepPausedSecret
        ? undefined
        : await this.prepareCredential(tx, input, settings, userId, priorSettings);
      if (input.enabled) {
        await this.lockCredential(tx, settings);
        await this.validateTriggerReferences(
          tx,
          projectId,
          bound!,
          {
            sourceId: triggerId ?? projectId,
            version: liveVersion!,
            flowId: input.flowId,
            label: name,
          },
          settings,
        );
        if (settings.upstreamFlowId)
          await this.ensureNoUpstreamLoop(
            tx,
            projectId,
            input.flowId,
            settings.upstreamFlowId,
            triggerId,
          );
      }
      const values = {
        project_id: projectId,
        name,
        version: liveVersion ?? 1,
        flow_id: input.flowId,
        kind: input.kind,
        config_json: JSON.stringify(settings),
        enabled: input.enabled ? 1 : 0,
        next_at: input.enabled ? (times[0] ?? null) : null,
        created_by: actor,
        updated_at: now,
      };
      const row = triggerId
        ? await tx
            .updateTable('execution_graph_triggers')
            .set(values)
            .where('id', '=', triggerId)
            .where('project_id', '=', projectId)
            .returningAll()
            .executeTakeFirstOrThrow()
        : await tx
            .insertInto('execution_graph_triggers')
            .values({ ...values, id: randomUUID(), created_at: now })
            .returningAll()
            .executeTakeFirstOrThrow();
      await this.audit.record(
        userId,
        'execution-graph.trigger.save',
        'execution-graph-trigger',
        row.id,
        { projectId, kind: row.kind, enabled: input.enabled, version: row.version },
        tx,
      );
      return { ...visibleRule(row), ...(secret && { secret }) };
    });
  }

  private async validateTriggerReferences(
    db: Kysely<Database>,
    projectId: string,
    definition: GraphDefinition,
    source: Parameters<typeof graphTriggerReferences>[1],
    settings: TriggerConfig,
  ) {
    const references = graphTriggerReferences(definition, source, settings);
    if (await unavailableReference(db, projectId, references))
      throw this.triggerPlanIssue(source.flowId, '触发器引用的资源不可用，请检查参数映射');
  }

  private async ensureNoUpstreamLoop(
    tx: Transaction<Database>,
    projectId: string,
    target: string,
    source: string,
    editing?: string,
  ) {
    const entries = await tx
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('project_id', '=', projectId)
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

  private async lockRule(tx: Transaction<Database>, rule: Rule, matchVersion = true) {
    const row = await tx
      .updateTable('execution_graph_triggers')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', rule.id)
      .where('enabled', '=', 1)
      .$if(matchVersion, (query) => query.where('version', '=', rule.version))
      .where('flow_id', '=', rule.flow_id)
      .where('config_json', '=', rule.config_json)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new ConflictException('触发器已停用或配置已变更');
  }

  private enabledRules(projectId: string, db: Kysely<Database> = this.database.db) {
    return db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('enabled', '=', 1)
      .orderBy('id')
      .execute()
      .then((rules) => rules.filter((rule) => config(rule).followLatest !== false));
  }

  private publicationIssue(rule: Rule, error: HttpException): GraphCompileError['issue'] {
    const issue = error instanceof ExecutionPlanIssueError ? error.issue : undefined;
    return {
      flowId: issue?.flowId ?? rule.flow_id,
      nodeId: issue?.nodeId ?? rule.flow_id,
      fieldId: issue?.fieldId,
      fieldSection: issue?.fieldSection,
      message: '触发器「' + rule.name + '」阻止发布。' + error.message,
    };
  }

  async validatePublication(
    projectId: string,
    graphId: string,
    version: number,
    definition: GraphDefinition,
  ) {
    const rules = await this.enabledRules(projectId);
    const previous = new Map<number, GraphDefinition>();
    const issues: GraphCompileError['issues'] = [];
    const signature = (candidate: GraphDefinition, rootIds: string[]) => {
      const ids = new Set(rootIds);
      const entries = [];
      for (const id of ids) {
        const flow = candidate.flows.find((entry) => entry.id === id);
        entries.push(flow);
        for (const node of flow?.nodes ?? [])
          if (node.type === 'FLOW_CALL' && node.flowId) ids.add(node.flowId);
      }
      return JSON.stringify(entries);
    };
    for (const rule of rules) {
      const settings = config(rule);
      const ids = [rule.flow_id, ...(settings.upstreamFlowId ? [settings.upstreamFlowId] : [])];
      if (!previous.has(rule.version))
        previous.set(
          rule.version,
          await this.published(projectId, rule.version, this.database.db, false),
        );
      if (signature(definition, ids) === signature(previous.get(rule.version)!, ids)) continue;
      try {
        await this.checkPlan(
          projectId,
          graphId,
          {
            name: rule.name,
            kind: rule.kind as GraphTriggerKind,
            flowId: rule.flow_id,
          },
          version,
          definition,
          settings,
          rule.id,
        );
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        issues.push(this.publicationIssue(rule, error));
      }
    }
    if (issues.length) throw new GraphCompileError(issues[0]!, issues);
    return rules;
  }

  async followPublication(
    tx: Transaction<Database>,
    projectId: string,
    version: number,
    definition: GraphDefinition,
    checked: Rule[],
  ) {
    const live = await this.enabledRules(projectId, tx);
    if (
      live.length !== checked.length ||
      live.some((rule, i) => {
        const prior = checked[i];
        return (
          prior?.id !== rule.id ||
          prior.version !== rule.version ||
          prior.config_json !== rule.config_json
        );
      })
    )
      throw new ConflictException('发布预检后触发器已变化，请重新校验后发布');
    for (const rule of live) {
      try {
        await this.validateMigrationBinding(tx, rule, version, definition);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        throw new GraphCompileError(this.publicationIssue(rule, error));
      }
    }
    if (live.length)
      await tx
        .updateTable('execution_graph_triggers')
        .set({ version })
        .where(
          'id',
          'in',
          live.map(({ id }) => id),
        )
        .execute();
    const flowIds = definition.flows.map(({ id }) => id);
    if (!flowIds.length) return;
    const drafts = await tx
      .selectFrom('execution_graph_triggers')
      .select(['id', 'config_json'])
      .where('project_id', '=', projectId)
      .where('enabled', '=', 0)
      .where('flow_id', 'in', flowIds)
      .execute();
    for (const draft of drafts) {
      const settings = JSON.parse(draft.config_json) as TriggerConfig;
      if (settings.followLatest === false) continue;
      await tx
        .updateTable('execution_graph_triggers')
        .set({ version, config_json: JSON.stringify({ ...settings, unpublished: false }) })
        .where('id', '=', draft.id)
        .execute();
    }
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
    if (!flow)
      throw this.triggerPlanIssue(
        rule.flow_id,
        '请先暂停触发器「' + rule.name + '」，或恢复关联开始节点',
      );
    const fields = flowStart(flow).inputs ?? [];
    this.validateMappings(
      fields,
      {
        ...this.mappingInput(
          { name: rule.name, kind: rule.kind as GraphTriggerKind, flowId: rule.flow_id },
          version,
          settings,
        ),
        enabled: active,
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
        rule.flow_id,
        settings.upstreamFlowId,
        rule.id,
      );
    }
    await this.requireAdmin(tx, rule.created_by);
    await this.lockCredential(tx, settings);
    await this.validateTriggerReferences(
      tx,
      rule.project_id,
      definition,
      { sourceId: rule.id, version, flowId: rule.flow_id, label: rule.name },
      settings,
    );
  }

  private async recordEvent(
    tx: Transaction<Database>,
    rule: Rule,
    eventId: string,
    fields: TriggerEventInput,
    options: {
      status?: string;
      error?: string;
      runId?: string | null;
      duplicateOf?: string;
      now?: number;
    } = {},
  ) {
    const value = JSON.stringify(fields);
    const hash = requestHash(eventId, value);
    const status = options.status ?? 'PENDING';
    const now = options.now ?? Date.now();
    const row = await tx
      .insertInto('execution_graph_trigger_events')
      .values({
        id: randomUUID(),
        trigger_id: rule.id,
        event_key: eventId,
        request_hash: hash,
        input_value: value,
        graph_version: rule.version,
        flow_id: rule.flow_id,
        rule_revision: config(rule).revision,
        status,
        error: options.error,
        run_id: options.runId,
        duplicate_of: options.duplicateOf,
        created_at: now,
        finished_at: status === 'PENDING' ? null : now,
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
    if (
      previous.request_hash === hash ||
      (previous.rule_revision === null &&
        previous.request_hash === requestHash(eventId, value, rule.config_json))
    )
      return previous;
    if (rule.kind === 'API' && !eventFields(previous).invokedBy) {
      const legacyInput = { ...fields };
      delete legacyInput.invokedBy;
      if (
        previous.request_hash ===
        requestHash(eventId, JSON.stringify(legacyInput), rule.config_json)
      )
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

  async rotateWebhookSecret(projectId: string, triggerId: string, userId: string) {
    await requireProject(this.database.db, projectId);
    return this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await requireProject(tx, projectId);
      await this.requireAdmin(tx, userId);
      const rule = await tx
        .selectFrom('execution_graph_triggers')
        .selectAll()
        .where('id', '=', triggerId)
        .where('project_id', '=', projectId)
        .where('kind', '=', 'WEBHOOK')
        .executeTakeFirst();
      if (!rule) throw new NotFoundException('Webhook 规则不存在');
      await this.lockWebhook(tx, rule);
      const settings = config(rule);
      const secret = randomBytes(32).toString('base64url');
      const stored = await this.credentials.storeWebhookSecret(
        tx,
        userId,
        'Webhook · ' + rule.name,
        secret,
        settings.generatedCredential ? settings.credentialId : undefined,
      );
      const updated = {
        ...settings,
        revision: randomUUID(),
        credentialId: stored.id,
        credentialNonce: stored.nonce,
        generatedCredential: true,
      };
      await tx
        .updateTable('execution_graph_triggers')
        .set({ config_json: JSON.stringify(updated), updated_at: Date.now() })
        .where('id', '=', rule.id)
        .execute();
      await this.audit.record(
        userId,
        'execution-graph.trigger.rotate-secret',
        'execution-graph-trigger',
        rule.id,
        { projectId },
        tx,
      );
      return { secret, receivePath: '/api/v1/graph-webhooks/' + rule.id };
    });
  }

  private async lockWebhook(tx: Transaction<Database>, rule: Rule) {
    const same = await tx
      .updateTable('execution_graph_triggers')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', rule.id)
      .where('enabled', '=', rule.enabled)
      .where('version', '=', rule.version)
      .where('flow_id', '=', rule.flow_id)
      .where('config_json', '=', rule.config_json)
      .returning('id')
      .executeTakeFirst();
    if (!same) throw new ConflictException('触发规则已变更，请重新投递');
  }

  private async webhookReplay(
    rule: Rule,
    key: string,
    fields: TriggerEventInput,
    db = this.database.db,
  ) {
    const existing = await db
      .selectFrom('execution_graph_trigger_events')
      .selectAll()
      .where('trigger_id', '=', rule.id)
      .where('event_key', '=', key)
      .executeTakeFirst();
    if (!existing) return undefined;
    const previous = eventFields(existing);
    if (
      previous.ref !== fields.ref ||
      previous.commitSha !== fields.commitSha ||
      ((config(rule).webhookProtocol ?? 'SIGNED') === 'SIGNED' &&
        (previous.repositoryId !== fields.repositoryId || previous.value !== fields.value))
    )
      throw new ConflictException('该事件标识已用于另一组触发参数');
    return existing;
  }

  private async eventResult(event: Event, db = this.database.db) {
    if (!event.duplicate_of) return visibleEvent(event);
    const canonical = await db
      .selectFrom('execution_graph_trigger_events')
      .select('run_id')
      .where('id', '=', event.duplicate_of)
      .executeTakeFirst();
    return visibleEvent({ ...event, run_id: canonical?.run_id ?? null });
  }

  async webhook(triggerId: string, input: WebhookRequest, test = false) {
    const rule = await this.database.db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('id', '=', triggerId)
      .where('kind', '=', 'WEBHOOK')
      .executeTakeFirst();
    if (!rule) throw new UnauthorizedException('Webhook 认证失败');
    const settings = config(rule);
    const protocol = settings.webhookProtocol ?? 'SIGNED';
    if (!rule.enabled && !test && protocol === 'SIGNED')
      throw new UnauthorizedException('Webhook 认证失败');
    if (!settings.credentialId) throw new UnauthorizedException('Webhook 认证失败');
    const { secret, nonce } = await this.checkCredential(settings.credentialId).catch(() => {
      throw new UnauthorizedException('Webhook 认证失败');
    });
    if (nonce !== settings.credentialNonce) throw new UnauthorizedException('Webhook 认证失败');
    const delivery = decodeTriggerWebhook(input, protocol, secret);
    const eventId = test ? 'test:' + delivery.eventId : delivery.eventId;
    const fields: TriggerEventInput = {
      value: plainValue(delivery.inputValue ?? settings.inputValue),
      ref: delivery.ref,
      commitSha: delivery.commitSha,
      eventSource: protocol,
      ...(protocol === 'SIGNED' && { repositoryId: delivery.repositoryId }),
    };
    await requireProject(this.database.db, rule.project_id);
    const replay = await this.webhookReplay(rule, eventId, fields);
    if (replay) return this.eventResult(replay);
    const store = (status: string, error?: string) =>
      this.database.db.transaction().execute(async (tx) => {
        await this.lockWebhook(tx, rule);
        await this.lockCredential(tx, settings);
        const existing = await this.webhookReplay(rule, eventId, fields, tx);
        return this.eventResult(
          existing ?? (await this.recordEvent(tx, rule, eventId, fields, { status, error })),
          tx,
        );
      });
    if (protocol === 'SIGNED') {
      if (
        (settings.repositoryId && settings.repositoryId !== delivery.repositoryId) ||
        (settings.refPrefix && !delivery.ref?.startsWith(settings.refPrefix)) ||
        (settings.ref && settings.ref !== delivery.ref)
      )
        return store('IGNORED', '仓库或分支不匹配');
      return store(test ? 'TESTED' : 'PENDING');
    }
    if (delivery.unsupported || !fields.ref || !fields.commitSha)
      return store('IGNORED', '仅接收含有效提交的分支推送，已跳过删除或其他事件');
    if (!rule.enabled && !test) return store('IGNORED', '触发规则已暂停');
    let scope;
    try {
      scope = await this.resolveSourceScope(
        rule.project_id,
        { flowId: rule.flow_id, settings },
        await this.sourceDefinition(rule, settings),
      );
      fields.repositoryId = scope.repositoryId;
      fields.checkoutNodeId = scope.nodeId;
      const repository = await this.sourceRepository(rule.project_id, scope.repositoryId);
      if (
        protocol === 'GITEA' &&
        !matchesGiteaRepository(
          repository.clone_url,
          delivery.repositoryUrl,
          delivery.repositoryName,
        )
      )
        return store('IGNORED', '推送仓库与规则中登记的仓库不匹配');
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return store('REJECTED', redactTaskLog(error.message).slice(0, 500));
    }
    if (scope.ref !== fields.ref) return store('IGNORED', '推送分支与规则不匹配');
    if (test) return store('TESTED');

    const key = this.sourceKey(rule, scope);
    for (let attempt = 0; attempt < 3; attempt++) {
      const prior = await sourceObservation(this.database.db, key);
      let head;
      try {
        head = await this.observeHead(rule.project_id, scope);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        return store('REJECTED', redactTaskLog(error.message).slice(0, 500));
      }
      if (head !== fields.commitSha) return store('IGNORED', '推送提交已不是远端分支的当前 HEAD');
      try {
        return await this.database.db.transaction().execute(async (tx) => {
          await this.lockRule(tx, rule);
          await this.lockCredential(tx, settings);
          const existing = await this.webhookReplay(rule, eventId, fields, tx);
          if (existing) return this.eventResult(existing, tx);
          const { changed, row } = await compareSourceObservation(tx, key, prior, head, Date.now());
          const event = await this.recordEvent(
            tx,
            rule,
            eventId,
            {
              ...fields,
              previousCommitSha: changed ? prior?.commit_sha : undefined,
            },
            row.event_id
              ? { status: 'IGNORED', error: '该分支变化已有触发事件', duplicateOf: row.event_id }
              : undefined,
          );
          if (!row.event_id) await updateObservation(tx, key).set({ event_id: event.id }).execute();
          return this.eventResult(event, tx);
        });
      } catch (error) {
        if (!(error instanceof SourceObservationChanged) || attempt === 2) throw error;
      }
    }
    throw new ConflictException('分支观察状态已变化，请重新投递');
  }

  private async pollRepository(rule: Rule, now: number, nextAt: number) {
    const settings = config(rule);
    const eventId = 'poll:' + rule.next_at;
    const fields: TriggerEventInput = {
      value: settings.inputValue,
      scheduledAt: rule.next_at!,
      checkedAt: now,
      eventSource: 'POLL',
    };
    const transact = async <T>(
      error: string | null,
      operation: (tx: Transaction<Database>) => Promise<T>,
    ) =>
      this.database.db.transaction().execute(async (tx) => {
        const scheduled = await tx
          .updateTable('execution_graph_triggers')
          .set({ next_at: nextAt, source_checked_at: now, source_error: error })
          .where('id', '=', rule.id)
          .where('enabled', '=', 1)
          .where('version', '=', rule.version)
          .where('flow_id', '=', rule.flow_id)
          .where('config_json', '=', rule.config_json)
          .where('next_at', '=', rule.next_at)
          .returning('id')
          .executeTakeFirst();
        if (scheduled) return operation(tx);
      });
    const fail = async (error: HttpException) => {
      const note = redactTaskLog(error.message).slice(0, 500);
      await transact(note, (tx) =>
        this.recordEvent(tx, rule, eventId, fields, {
          status: 'REJECTED',
          error: note,
        }),
      );
    };
    let scope;
    try {
      scope = await this.resolveSourceScope(
        rule.project_id,
        { flowId: rule.flow_id, settings },
        await this.published(rule.project_id, rule.version),
      );
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      await fail(error);
      return;
    }
    Object.assign(fields, {
      repositoryId: scope.repositoryId,
      ref: scope.ref,
      checkoutNodeId: scope.nodeId,
    });
    const key = this.sourceKey(rule, scope);
    for (let attempt = 0; attempt < 3; attempt++) {
      const prior = await sourceObservation(this.database.db, key);
      let sha;
      try {
        sha = await this.observeHead(rule.project_id, scope);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        await fail(error);
        return;
      }
      try {
        await transact(null, async (tx) => {
          const { changed, row } = await compareSourceObservation(tx, key, prior, sha, now);
          if (changed && (prior || settings.buildOnFirstObservation)) {
            const event = await this.recordEvent(tx, rule, eventId, {
              ...fields,
              commitSha: sha,
              previousCommitSha: prior?.commit_sha,
            });
            await updateObservation(tx, key).set({ event_id: event.id }).execute();
          } else if (!changed && row.event_id) {
            const canonical = await tx
              .selectFrom('execution_graph_trigger_events')
              .select(['created_at', 'trigger_id'])
              .where('id', '=', row.event_id)
              .executeTakeFirst();
            // A push accepted since the previous poll may have seen this change first.
            if (
              canonical &&
              canonical.trigger_id !== rule.id &&
              canonical.created_at > (rule.source_checked_at ?? 0) &&
              !(await tx
                .selectFrom('execution_graph_trigger_events')
                .select('id')
                .where('trigger_id', '=', rule.id)
                .where('duplicate_of', '=', row.event_id)
                .executeTakeFirst())
            )
              await this.recordEvent(
                tx,
                rule,
                eventId,
                {
                  ...fields,
                  commitSha: sha,
                },
                { status: 'IGNORED', duplicateOf: row.event_id, error: '该分支变化已有触发事件' },
              );
          }
        });
        return;
      } catch (error) {
        if (!(error instanceof SourceObservationChanged) || attempt === 2) throw error;
      }
    }
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
      const nextAt = this.nextTimes(settings, now, 1)[0]!;
      if (settings.cronMode === 'POLL') {
        await this.pollRepository(rule, now, nextAt);
        continue;
      }
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
        if (scheduled) {
          const late = now - rule.next_at! >= 60_000;
          await this.recordEvent(
            tx,
            rule,
            String(rule.next_at),
            { value: settings.inputValue, scheduledAt: rule.next_at! },
            late
              ? { status: 'SKIPPED', error: '错过计划时点，已跳过积压并恢复下一次计划', now }
              : { now },
          );
        }
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
        .select(['run.id', 'run.status', 'run.version'])
        .where('run.project_id', '=', rule.project_id)
        .where('run.flow_id', '=', settings.upstreamFlowId!)
        .where('run.parent_run_id', 'is', null)
        .where('run.finished_at', '>=', settings.enabledSince ?? rule.updated_at)
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
              upstreamVersion: run.version,
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
      const settings = config(rule);
      const version = event.graph_version ?? rule.version;
      const flowId = event.flow_id ?? rule.flow_id;
      if (
        !rule.enabled ||
        flowId !== rule.flow_id ||
        (event.rule_revision !== null
          ? event.rule_revision !== settings.revision
          : event.request_hash !==
            requestHash(event.event_key, event.input_value, rule.config_json))
      )
        throw new ConflictException('触发器已停用或配置已变更');
      const definition = await this.published(rule.project_id, version);
      const kind = rule.kind as GraphTriggerKind;
      const hasDelivery = assertAutomaticGraphFlow(definition, flowId, kind);
      const fields = this.startFields(definition, flowId);
      const { invokedBy, ...eventInput } = eventFields(event);
      const authorization = { kind, ruleId: rule.id, revision: settings.revision, invokedBy };
      const mappings = settings.parameterMappings ?? {};
      const parameterSources: Record<string, GraphFieldSource> = Object.create(null);
      const upstream = Object.values(mappings).some(({ source }) => source === 'UPSTREAM_OUTPUT')
        ? await this.upstreamValues(
            rule,
            settings,
            eventInput.upstreamRunId,
            definition,
            fields,
            version,
          )
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
        triggerRuleId: rule.id,
        triggerEventId: event.id,
        ruleRevision: settings.revision,
        acceptedAt: event.created_at,
        triggeredAt: eventInput.scheduledAt ?? event.created_at,
        parameterSources,
      };
      const preview = await this.runner.preview(
        rule.project_id,
        flowId,
        {
          version,
          inputs,
        },
        { trigger: metadata, automation: authorization },
      );
      await this.runner.run(
        rule.project_id,
        flowId,
        {
          version,
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
            await this.lockRule(tx, rule, false);
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
              .set({
                status: 'QUEUED',
                run_id: runId,
                finished_at: Date.now(),
                resolved_inputs: JSON.stringify(preview.parameters),
              })
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

  private async upstreamValues(
    rule: Rule,
    settings: TriggerConfig,
    upstreamRunId: string | undefined,
    downstream: GraphDefinition,
    fields: GraphField[],
    version: number,
  ) {
    if (!upstreamRunId || !settings.upstreamFlowId || rule.kind !== 'UPSTREAM')
      throw new BadRequestException('缺少上游执行记录');
    const output = await this.database.db
      .selectFrom('execution_flow_runs as run')
      .innerJoin('execution_node_runs as node', 'node.run_id', 'run.id')
      .select(['node.output_json', 'run.version'])
      .where('run.id', '=', upstreamRunId)
      .where('run.project_id', '=', rule.project_id)
      .where('run.flow_id', '=', settings.upstreamFlowId)
      .where('run.parent_run_id', 'is', null)
      .where('run.status', '=', 'SUCCESS')
      .where('node.node_type', '=', 'END')
      .where('node.status', '=', 'SUCCESS')
      .executeTakeFirst();
    if (!output) throw new ConflictException('上游执行记录已失效或未成功完成');
    const definition = await this.published(
      rule.project_id,
      output.version,
      this.database.db,
      false,
    );
    this.validateMappings(
      fields,
      this.mappingInput(
        {
          name: rule.name,
          kind: 'UPSTREAM',
          flowId: rule.flow_id,
        },
        version,
        settings,
      ),
      downstream,
      definition,
    );
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
