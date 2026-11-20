import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import { initialGraphDraft } from '../../core/database/execution-graphs-migration';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { lockProjectGraph, requireProject } from '../projects/project-relations';
import { graphResourceReferences } from '../projects/project-resource-extraction';
import { unavailableReference } from '../projects/project-resource-protection';
import { redactTaskLog } from '../tasks/task-log.service';
import { compileCanvas, withDraftCanvas } from './execution-graph-canvas';
import { validateGraphDefinition, type GraphDefinition } from './execution-graph-definition';
import type { StageGraphMigrationDto, SwitchGraphMigrationDto } from './graph-migration.dto';
import {
  legacyNodes,
  migrateLegacyDefinition,
  migrationIssue,
  type MigrationIssue,
} from './graph-migration-mapping';
import { migrationComparisons, type MigrationComparisonInput } from './graph-migration-plan';
import { activeFlowStatuses } from './graph-run-lifecycle';
import { GraphTriggersService } from './graph-triggers.service';

const stageAction = 'execution_graph.migration.stage';
const switchAction = 'execution_graph.migration.cutover';
const restoreAction = 'execution_graph.migration.restore';
const resourceKind = 'execution_graph_migration';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definitionOf = (json: string) => JSON.parse(json) as GraphDefinition;
type MigrationState = 'MISSING' | 'LEGACY_DRAFT' | 'PRESERVED_DRAFT' | 'STAGED' | 'CURRENT';
type Rule = Selectable<Database['execution_graph_triggers']>;
type CutoverTrigger = {
  id: string;
  previousVersion: number;
  flowId: string;
  enabled: number;
  configHash: string;
};
type Cutover = { id: string; targetVersion: number; triggers: CutoverTrigger[] };
type Staged = { planHash: string; revision: number; draftHash: string; fromVersion: number | null };

function visibleCutover(record: Cutover, restored = false) {
  return {
    id: record.id,
    targetVersion: record.targetVersion,
    triggers: record.triggers.map(({ id, previousVersion }) => ({ id, previousVersion })),
    restored,
  };
}

function canRunVersion(definition: GraphDefinition) {
  try {
    if (legacyNodes(definition).length) return false;
    validateGraphDefinition(definition);
    return true;
  } catch {
    return false;
  }
}

function canRestoreFlow(definition: GraphDefinition, flowId: string) {
  const flowIds = new Set([flowId]);
  for (const id of flowIds) {
    const flow = definition.flows.find((item) => item.id === id);
    if (!flow) return false;
    for (const node of flow.nodes)
      if (node.type === 'FLOW_CALL' && node.flowId) flowIds.add(node.flowId);
  }
  return canRunVersion({ flows: definition.flows.filter(({ id }) => flowIds.has(id)) });
}

@Injectable()
export class GraphMigrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly triggers: GraphTriggersService,
  ) {}

  async preview(projectId: string, comparison: MigrationComparisonInput = {}) {
    if (comparison.value && redactTaskLog(comparison.value) !== comparison.value)
      throw new BadRequestException('条件样本不能包含明文凭据');
    return (await this.inspect(this.database.db, projectId, comparison)).plan;
  }

  private async journal<T>(db: Kysely<Database>, projectId: string, action: string) {
    const entry = await db
      .selectFrom('audit_logs')
      .select('details_json')
      .where('action', '=', action)
      .where('resource_type', '=', resourceKind)
      .where('resource_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    return entry ? (JSON.parse(entry.details_json) as T) : undefined;
  }

  private async inspect(db: Kysely<Database>, id: string, input: MigrationComparisonInput) {
    await requireProject(db, id);
    const graph = await db
      .selectFrom('execution_graphs')
      .selectAll()
      .where('project_id', '=', id)
      .executeTakeFirst();
    const versions = graph
      ? await db
          .selectFrom('execution_graph_versions')
          .selectAll()
          .where('graph_id', '=', graph.id)
          .orderBy('version', 'desc')
          .execute()
      : [];
    const rules = await db
      .selectFrom('execution_graph_triggers')
      .selectAll()
      .where('project_id', '=', id)
      .orderBy('id')
      .execute();
    const pendingEvents = await db
      .selectFrom('execution_graph_trigger_events as event')
      .innerJoin('execution_graph_triggers as rule', 'rule.id', 'event.trigger_id')
      .select('event.trigger_id')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('rule.project_id', '=', id)
      .where('event.status', '=', 'PENDING')
      .groupBy('event.trigger_id')
      .execute();
    const inFlight = await db
      .selectFrom('execution_flow_runs')
      .select('version')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('project_id', '=', id)
      .where('status', 'in', activeFlowStatuses)
      .groupBy('version')
      .execute();
    const artifacts = await db
      .selectFrom('artifacts')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('project_id', '=', id)
      .executeTakeFirstOrThrow();
    const legacyPipelines = await db
      .selectFrom('pipelines as pipeline')
      .leftJoin('pipeline_webhooks as webhook', 'webhook.pipeline_id', 'pipeline.id')
      .select([
        'pipeline.id',
        'pipeline.name',
        'pipeline.service_id as serviceId',
        'pipeline.current_version as version',
      ])
      .select((eb) =>
        eb.case().when('webhook.enabled', '=', 1).then(1).else(0).end().as('webhookEnabled'),
      )
      .where('pipeline.project_id', '=', id)
      .where('pipeline.id', 'not like', '________-____-8___-%')
      .orderBy('pipeline.id')
      .execute();
    const legacyTargetRows = await db
      .selectFrom('service_environment_configs as config')
      .innerJoin('services as service', 'service.id', 'config.service_id')
      .innerJoin('deployment_targets as target', 'target.id', 'config.target_id')
      .innerJoin('deployment_target_servers as member', 'member.target_id', 'target.id')
      .select([
        'target.id',
        'target.name',
        'target.strategy',
        'target.failure_policy as failurePolicy',
        'target.max_parallel as maxParallel',
        'member.server_id as serverId',
      ])
      .where('service.project_id', '=', id)
      .orderBy('target.id')
      .orderBy('member.sort_order')
      .orderBy('member.server_id')
      .execute();
    const legacyTargets = new Map<
      string,
      {
        id: string;
        name: string;
        strategy: string;
        failurePolicy: string;
        maxParallel: number;
        serverIds: string[];
      }
    >();
    for (const { serverId, ...target } of legacyTargetRows) {
      const stored = legacyTargets.get(target.id) ?? {
        ...target,
        name: redactTaskLog(target.name),
        serverIds: [],
      };
      if (!stored.serverIds.includes(serverId)) stored.serverIds.push(serverId);
      legacyTargets.set(target.id, stored);
    }
    const legacyReviews = await db
      .selectFrom('service_source_reviews')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('project_id', '=', id)
      .executeTakeFirstOrThrow();
    const staged = await this.journal<Staged>(db, id, stageAction);
    const cutover = await this.journal<Cutover>(db, id, switchAction);
    const restoration = await this.journal<{ id: string; suspendedTriggerIds: string[] }>(
      db,
      id,
      restoreAction,
    );
    const restored = cutover !== undefined && restoration?.id === cutover.id;
    const draft = graph ? definitionOf(graph.draft_json) : undefined;
    const latest = versions.find(({ version }) => version === graph?.published_version);
    const published = latest ? definitionOf(latest.definition_json) : undefined;
    const hasBeenStaged = Boolean(graph && staged?.draftHash === digest(draft));
    const issues: MigrationIssue[] = [];
    if (legacyPipelines.some(({ webhookEnabled }) => webhookEnabled === 1))
      issues.push(
        migrationIssue(
          'ACTIVE_LEGACY_WEBHOOK',
          '迁移前保留旧 Pipeline 运行记录。切换前先停用仍启用的旧 Pipeline Webhook，以免重复发布。',
          false,
        ),
      );
    let candidate: GraphDefinition | undefined;
    let before = draft?.flows ?? [];
    let status: MigrationState = 'CURRENT';
    if (!graph) {
      status = 'MISSING';
      candidate = compileCanvas(withDraftCanvas(definitionOf(initialGraphDraft)).canvas, false);
    } else if (draft && legacyNodes(draft).length) {
      status = 'LEGACY_DRAFT';
      try {
        const mapped = migrateLegacyDefinition(draft);
        before = mapped.previous;
        candidate = mapped.candidate;
        issues.push(...mapped.issues);
      } catch {
        issues.push(
          migrationIssue(
            'INVALID_LEGACY_GRAPH',
            '旧草稿无法安全转换，请人工核对节点与连线。',
            true,
          ),
        );
      }
    } else if (hasBeenStaged) {
      status = 'STAGED';
      const source = versions.find(({ version }) => version === staged?.fromVersion);
      before = source ? definitionOf(source.definition_json).flows : before;
    } else if (published && legacyNodes(published).length) {
      status = 'PRESERVED_DRAFT';
      before = published.flows;
      issues.push(
        migrationIssue('PRESERVE_DRAFT', '当前草稿已采用新模块，请在草稿中完成对照并发布。', false),
      );
    }
    if (candidate && graph) {
      const missing = await unavailableReference(
        db,
        id,
        graphResourceReferences(candidate, { sourceId: graph.id, state: 'DRAFT' }),
      );
      if (missing)
        issues.push(
          migrationIssue(
            'UNAVAILABLE_REFERENCE',
            '迁移草稿引用了不可用的项目资源。',
            true,
            missing.flowId,
          ),
        );
    }
    const affected = before.filter((flow) => legacyNodes({ flows: [flow] }).length > 0);
    let comparison: Awaited<ReturnType<typeof migrationComparisons>>['comparison'] = [];
    if (affected.length) {
      const compared = await migrationComparisons(
        db,
        id,
        affected,
        (candidate ?? draft)?.flows ?? [],
        input,
      );
      comparison = compared.comparison;
      issues.push(...compared.issues);
    }
    const storedVersions = versions.map((row) => ({
      version: row.version,
      legacy: Boolean(legacyNodes(definitionOf(row.definition_json)).length),
      retired: row.retired_at !== null,
      pendingRuns: Number(inFlight.find(({ version }) => version === row.version)?.count ?? 0),
    }));
    const storedTriggers = rules.map((rule) => ({
      id: rule.id,
      name: redactTaskLog(rule.name),
      kind: rule.kind,
      flowId: rule.flow_id,
      version: rule.version,
      enabled: rule.enabled === 1,
      pendingEvents: Number(
        pendingEvents.find(({ trigger_id }) => trigger_id === rule.id)?.count ?? 0,
      ),
    }));
    const summary = {
      status,
      graphId: graph?.id ?? null,
      revision: graph?.revision ?? null,
      publishedVersion: graph?.published_version ?? null,
      issues: [...new Map(issues.map((item) => [item.id, item])).values()],
      comparison,
      versions: storedVersions,
      triggers: storedTriggers,
      artifactCount: Number(artifacts.count),
      legacyPipelines: legacyPipelines.map((pipeline) => ({
        ...pipeline,
        name: redactTaskLog(pipeline.name),
        webhookEnabled: pipeline.webhookEnabled === 1,
      })),
      legacyTargets: [...legacyTargets.values()],
      legacyReviewCount: Number(legacyReviews.count),
      lastCutover: cutover ? visibleCutover(cutover, restored) : undefined,
    };
    const planHash = digest([
      id,
      input.environmentId,
      input.commitSha?.toLowerCase(),
      input.serverIds,
      input.groupIds,
      input.artifactId,
      input.targetId,
      input.value,
      graph?.draft_json,
      latest?.definition_json,
      summary,
      rules.map((rule) => [rule.id, rule.config_json, rule.updated_at]),
    ]);
    return {
      plan: { planHash, ...summary },
      graph,
      candidate,
      versions,
      rules,
      staged,
      cutover,
      restored,
      restoration,
    };
  }

  private async lock(tx: Transaction<Database>, projectId: string, userId: string) {
    await lockProjectGraph(tx);
    const active = await tx
      .updateTable('projects')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!active) throw new BadRequestException('项目不存在或已归档');
    const admin = await tx
      .updateTable('users')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', userId)
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .where('must_change_password', '=', 0)
      .returning('id')
      .executeTakeFirst();
    if (!admin) throw new ForbiddenException('管理员权限已变化，请刷新登录状态');
  }

  async stage(projectId: string, input: StageGraphMigrationDto, userId: string) {
    if (input.comparison?.value && redactTaskLog(input.comparison.value) !== input.comparison.value)
      throw new BadRequestException('条件样本不能包含明文凭据');
    return this.database.db.transaction().execute(async (tx) => {
      await this.lock(tx, projectId, userId);
      const { graph, candidate, plan, staged } = await this.inspect(
        tx,
        projectId,
        input.comparison ?? {},
      );
      if (graph && staged?.planHash === input.planHash && plan.status === 'STAGED')
        return { graphId: graph.id, revision: graph.revision, changed: false };
      if (input.planHash !== plan.planHash)
        throw new ConflictException('草稿、资源或触发器已变化，请重新预演');
      if (plan.status === 'STAGED' && graph)
        return { graphId: graph.id, revision: graph.revision, changed: false };
      if (!candidate || plan.issues.some(({ blocking }) => blocking))
        throw new BadRequestException('当前方案需要人工处理，请核对预演问题');
      const acknowledgements = new Set(input.acknowledgements);
      if (plan.issues.some(({ id }) => !acknowledgements.has(id)))
        throw new BadRequestException('请确认所有迁移差异');
      const now = Date.now();
      const graphId = graph?.id ?? randomUUID();
      const revision = graph ? graph.revision + 1 : 1;
      const values = { revision, draft_json: JSON.stringify(candidate), updated_at: now };
      if (graph)
        await tx.updateTable('execution_graphs').set(values).where('id', '=', graphId).execute();
      else
        await tx
          .insertInto('execution_graphs')
          .values({ ...values, id: graphId, project_id: projectId, created_at: now })
          .execute();
      const detail: Staged = {
        planHash: input.planHash,
        revision,
        draftHash: digest(candidate),
        fromVersion: graph?.published_version ?? null,
      };
      await this.audit.record(
        userId,
        stageAction,
        resourceKind,
        projectId,
        { ...detail, graphId },
        tx,
      );
      return { graphId, revision, changed: true };
    });
  }

  private async lockRules(tx: Transaction<Database>, projectId: string, ids: string[]) {
    const result: Rule[] = [];
    for (const id of [...ids].sort()) {
      const rule = await tx
        .updateTable('execution_graph_triggers')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', id)
        .where('project_id', '=', projectId)
        .returningAll()
        .executeTakeFirst();
      if (!rule) throw new ConflictException('触发器不存在或不属于当前项目');
      const pending = await tx
        .selectFrom('execution_graph_trigger_events')
        .select('id')
        .where('trigger_id', '=', id)
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (pending || (rule.enabled === 1 && rule.next_at !== null && rule.next_at <= Date.now()))
        throw new ConflictException('触发器仍有待处理事件或到期时点，请等候处理后重新预演');
      result.push(rule);
    }
    return result;
  }

  async cutover(projectId: string, input: SwitchGraphMigrationDto, userId: string) {
    if (!input.confirmed) throw new BadRequestException('请确认切换触发器');
    return this.database.db.transaction().execute(async (tx) => {
      await this.lock(tx, projectId, userId);
      const rules = await this.lockRules(tx, projectId, input.triggerIds);
      const { graph, plan, versions, cutover, restored } = await this.inspect(tx, projectId, {});
      if (
        cutover &&
        !restored &&
        cutover.targetVersion === input.targetVersion &&
        rules.length === cutover.triggers.length &&
        rules.every(
          (rule) =>
            rule.version === input.targetVersion &&
            cutover.triggers.some(
              (item) => item.id === rule.id && item.configHash === digest(rule.config_json),
            ),
        )
      )
        return visibleCutover(cutover);
      if (input.planHash !== plan.planHash)
        throw new ConflictException('发布版本或触发器已变化，请重新预演');
      if (cutover && !restored) throw new ConflictException('已有未恢复的切换记录');
      if (plan.legacyPipelines.some(({ webhookEnabled }) => webhookEnabled))
        throw new ConflictException('请先停用项目的旧 Pipeline Webhook，再切换发布入口');
      const target = versions.find(({ version }) => version === input.targetVersion);
      if (!target || target.retired_at !== null || graph?.published_version !== target.version)
        throw new ConflictException('请先发布新版本，再切换关联触发器');
      const definition = definitionOf(target.definition_json);
      if (!canRunVersion(definition))
        throw new BadRequestException('当前版本仍有旧交付配置，请先发布已转换的执行流');
      if (rules.some(({ version }) => version >= target.version))
        throw new ConflictException('请选择仍关联旧版本的触发器');
      const record: Cutover = {
        id: randomUUID(),
        targetVersion: target.version,
        triggers: rules.map((rule) => ({
          id: rule.id,
          previousVersion: rule.version,
          flowId: rule.flow_id,
          enabled: rule.enabled,
          configHash: digest(rule.config_json),
        })),
      };
      for (const rule of rules)
        await tx
          .updateTable('execution_graph_triggers')
          .set({ version: target.version, updated_at: Date.now() })
          .where('id', '=', rule.id)
          .execute();
      for (const rule of rules)
        await this.triggers.validateMigrationBinding(tx, rule, target.version, definition);
      await this.audit.record(userId, switchAction, resourceKind, projectId, { ...record }, tx);
      return visibleCutover(record);
    });
  }

  async restore(projectId: string, cutoverId: string, confirmed: boolean, userId: string) {
    if (!confirmed) throw new BadRequestException('请确认恢复触发器');
    return this.database.db.transaction().execute(async (tx) => {
      await this.lock(tx, projectId, userId);
      const { cutover, restored, restoration, versions } = await this.inspect(tx, projectId, {});
      if (!cutover || cutover.id !== cutoverId) throw new ConflictException('该切换记录已失效');
      if (restored && restoration) return { ...restoration, restored: true };
      const rules = await this.lockRules(
        tx,
        projectId,
        cutover.triggers.map(({ id }) => id),
      );
      const suspendedTriggerIds: string[] = [];
      const restoredRules: { rule: Rule; version: number; definition: GraphDefinition }[] = [];
      for (const rule of rules) {
        const previous = cutover.triggers.find(({ id }) => id === rule.id)!;
        if (
          rule.version !== cutover.targetVersion ||
          rule.flow_id !== previous.flowId ||
          rule.enabled !== previous.enabled ||
          digest(rule.config_json) !== previous.configHash
        )
          throw new ConflictException('触发器在切换后已修改，请人工确认要恢复的版本');
        const previousRow = versions.find(({ version }) => version === previous.previousVersion);
        if (!previousRow) throw new ConflictException('原发布版本无法恢复');
        const original = definitionOf(previousRow.definition_json);
        const runnable = previousRow.retired_at === null && canRestoreFlow(original, rule.flow_id);
        if (rule.enabled === 1 && !runnable) suspendedTriggerIds.push(rule.id);
        await tx
          .updateTable('execution_graph_triggers')
          .set({
            version: previous.previousVersion,
            enabled: runnable ? rule.enabled : 0,
            next_at: runnable ? rule.next_at : null,
            updated_at: Date.now(),
          })
          .where('id', '=', rule.id)
          .execute();
        if (runnable)
          restoredRules.push({ rule, version: previous.previousVersion, definition: original });
      }
      for (const entry of restoredRules)
        await this.triggers.validateMigrationBinding(
          tx,
          entry.rule,
          entry.version,
          entry.definition,
        );
      const detail = { id: cutover.id, suspendedTriggerIds };
      await this.audit.record(userId, restoreAction, resourceKind, projectId, detail, tx);
      return { ...detail, restored: true };
    });
  }
}
