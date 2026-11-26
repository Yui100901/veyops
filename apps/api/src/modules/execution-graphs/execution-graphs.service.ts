import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { lockProjectGraph, requireProject } from '../projects/project-guards';
import { graphResourceReferences } from '../projects/project-resource-references';
import { unavailableReference } from '../projects/project-resource-protection';
import { canvasIssues, compileCanvas, withDraftCanvas } from './execution-graph-canvas';
import { type GraphDefinition, type SaveGraphDraftDto } from './execution-graph-definition';
import { GraphCompileError, type GraphDiagnostic } from './graph-fields';
import { expandGraphTemplate, type ExpandGraphTemplateDto } from './graph-flow-templates';
import { GraphTriggersService } from './graph-triggers.service';
import { validateSimplifiedSourceDirectories } from './simplified-flow-definition';

const unsupportedDraft = '执行图仅支持简化执行链，请使用 FLOW_V2 画布';

function readStoredDefinition(json: string) {
  const definition = JSON.parse(json) as GraphDefinition;
  if (definition.canvas?.model === 'FLOW_V2') {
    for (const { start, finish } of definition.canvas.nodes) {
      if (start?.release) Reflect.deleteProperty(start.release, 'deployPath');
      if (finish) Reflect.deleteProperty(finish, 'excludePaths');
    }
  }
  return definition;
}

function writableCanvas(definition: GraphDefinition) {
  if (definition.canvas?.model !== 'FLOW_V2') throw new BadRequestException(unsupportedDraft);
  return definition.canvas;
}

function graphResponse(row: Selectable<Database['execution_graphs']>) {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    publishedVersion: row.published_version,
    draft: withDraftCanvas(readStoredDefinition(row.draft_json)),
  };
}

@Injectable()
export class ExecutionGraphsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly triggers: GraphTriggersService,
  ) {}

  private async graph(projectId: string, db = this.database.db) {
    const row = await db
      .selectFrom('execution_graphs')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('项目执行图不存在');
    return row;
  }

  async get(projectId: string) {
    return graphResponse(await this.graph(projectId));
  }

  async expandTemplate(
    projectId: string,
    { templateId, artifactType, model = 'FLOW_V2' }: ExpandGraphTemplateDto,
  ) {
    await requireProject(this.database.db, projectId);
    await this.graph(projectId);
    return expandGraphTemplate(templateId, artifactType, model);
  }

  private async lockDraft(tx: Transaction<Database>, projectId: string, expectedRevision: number) {
    // Serialize writers with project archival as well as other draft saves/publications.
    const live = await tx
      .updateTable('projects')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!live) throw new NotFoundException('项目不存在或已归档');
    const graph = await this.graph(projectId, tx);
    this.checkRevision(graph.revision, expectedRevision);
    return graph;
  }

  private checkRevision(revision: number, expectedRevision: number) {
    if (revision !== expectedRevision)
      throw new ConflictException('草稿已被其他操作更新，请刷新后核对修改');
  }

  private async validateReferences(
    tx: Kysely<Database>,
    projectId: string,
    definition: GraphDefinition,
  ) {
    const reference = await unavailableReference(
      tx,
      projectId,
      graphResourceReferences(definition, {
        sourceId: projectId,
        state: 'RUNNABLE',
      }),
    );
    if (reference) {
      const flow = definition.flows.find(({ id }) => id === reference.flowId);
      const node = flow?.nodes.find(({ id }) => id === reference.nodeId);
      const path = [flow?.name, node?.name, reference.fieldId].filter(Boolean).join(' → ');
      throw new GraphCompileError({
        flowId: reference.flowId,
        nodeId: reference.nodeId,
        fieldId: reference.fieldId,
        message: (path ? path + ' · ' : '') + '引用的资源不存在、已停用或不属于当前项目',
      });
    }
    const simplifiedFlows = definition.flows.filter(({ model }) => model === 'FLOW_V2');
    const ids = [
      ...new Set(
        simplifiedFlows.flatMap(({ nodes }) =>
          nodes.flatMap(
            ({ start }) =>
              start?.sources?.flatMap(({ repositoryId }) => (repositoryId ? [repositoryId] : [])) ??
              [],
          ),
        ),
      ),
    ];
    if (!ids.length) return;
    const rows = await tx
      .selectFrom('repositories')
      .select(['id', 'clone_url'])
      .where('project_id', '=', projectId)
      .where('id', 'in', ids)
      .execute();
    const urls = new Map(rows.map(({ id, clone_url }) => [id, clone_url]));
    for (const flow of simplifiedFlows) validateSimplifiedSourceDirectories(flow, urls);
  }

  async validate(
    projectId: string,
    definition: GraphDefinition,
  ): Promise<{ issues: GraphDiagnostic[] }> {
    await requireProject(this.database.db, projectId);
    if (definition.canvas?.model !== 'FLOW_V2') return { issues: [{ message: unsupportedDraft }] };
    const issues = canvasIssues(definition.canvas);
    if (issues.length) return { issues };
    try {
      const compiled = compileCanvas(definition.canvas, true);
      await this.validateReferences(this.database.db, projectId, compiled);
      const graph = await this.graph(projectId);
      await this.triggers.validatePublication(
        projectId,
        graph.id,
        (graph.published_version ?? 0) + 1,
        compiled,
      );
      return { issues: [] };
    } catch (error) {
      if (error instanceof GraphCompileError) return { issues: error.issues };
      throw error;
    }
  }

  async save(projectId: string, input: SaveGraphDraftDto, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      const graph = await this.lockDraft(tx, projectId, input.expectedRevision);
      const definition = compileCanvas(writableCanvas(input.definition), false);
      const row = await this.updateDraft(tx, graph, definition);
      await this.audit.record(
        userId,
        'execution_graph.save',
        'execution_graph',
        graph.id,
        { projectId, revision: row.revision },
        tx,
      );
      return graphResponse(row);
    });
  }

  private updateDraft(
    tx: Transaction<Database>,
    graph: Selectable<Database['execution_graphs']>,
    definition: GraphDefinition,
  ) {
    return tx
      .updateTable('execution_graphs')
      .set({
        draft_json: JSON.stringify(definition),
        revision: graph.revision + 1,
        updated_at: Date.now(),
      })
      .where('id', '=', graph.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async publicationImpact(projectId: string, expectedRevision: number) {
    await requireProject(this.database.db, projectId);
    const graph = await this.graph(projectId);
    this.checkRevision(graph.revision, expectedRevision);
    const draft = readStoredDefinition(graph.draft_json);
    const definition = compileCanvas(writableCanvas(draft), true);
    const prior = graph.published_version
      ? (JSON.parse(
          (await this.publishedVersion(this.database.db, graph.id, graph.published_version))
            .definition_json,
        ) as GraphDefinition)
      : { flows: [] };
    const previous = new Map(prior.flows.map((flow) => [flow.id, flow] as const));
    const next = new Map(definition.flows.map((flow) => [flow.id, flow] as const));
    const rules = await this.database.db
      .selectFrom('execution_graph_triggers')
      .select(['flow_id', 'name', 'config_json'])
      .where('project_id', '=', projectId)
      .where('enabled', '=', 1)
      .orderBy('name')
      .execute();
    const changed = [...new Set([...next.keys(), ...previous.keys()])].flatMap((id) => {
      const before = previous.get(id);
      const after = next.get(id);
      if (JSON.stringify(before) === JSON.stringify(after)) return [];
      return [
        {
          id,
          name: (after ?? before)!.name,
          change: !before ? 'ADDED' : !after ? 'REMOVED' : 'CHANGED',
          triggers: rules
            .filter(
              (rule) => rule.flow_id === id || JSON.parse(rule.config_json).upstreamFlowId === id,
            )
            .map(({ name }) => name),
        },
      ];
    });
    return {
      revision: graph.revision,
      version: (graph.published_version ?? 0) + 1,
      flows: changed,
    };
  }

  async publish(projectId: string, expectedRevision: number, userId: string) {
    await requireProject(this.database.db, projectId);
    const candidate = await this.graph(projectId);
    this.checkRevision(candidate.revision, expectedRevision);
    const priorPublication = await this.database.db
      .selectFrom('execution_graph_versions')
      .select('version')
      .where('graph_id', '=', candidate.id)
      .where('source_revision', '=', expectedRevision)
      .executeTakeFirst();
    const draft = readStoredDefinition(candidate.draft_json);
    const definition = compileCanvas(writableCanvas(draft), true);
    const version = (candidate.published_version ?? 0) + 1;
    const triggerChecks = priorPublication
      ? []
      : await this.triggers.validatePublication(projectId, candidate.id, version, definition);
    return this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const graph = await this.lockDraft(tx, projectId, expectedRevision);
      const existing = await tx
        .selectFrom('execution_graph_versions')
        .select('version')
        .where('graph_id', '=', graph.id)
        .where('source_revision', '=', expectedRevision)
        .executeTakeFirst();
      if (existing) return graphResponse(graph);
      if (candidate.published_version !== graph.published_version)
        throw new ConflictException('已发布版本已变化，请重新校验后发布');
      const now = Date.now();
      await this.validateReferences(tx, projectId, definition);
      await this.triggers.followPublication(tx, projectId, version, definition, triggerChecks);
      await tx
        .insertInto('execution_graph_versions')
        .values({
          id: randomUUID(),
          graph_id: graph.id,
          version,
          source_revision: expectedRevision,
          definition_json: JSON.stringify(definition),
          created_at: now,
          created_by: userId,
        })
        .execute();
      const row = await tx
        .updateTable('execution_graphs')
        .set({ published_version: version, updated_at: now })
        .where('id', '=', graph.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        userId,
        'execution_graph.publish',
        'execution_graph',
        graph.id,
        { projectId, version, revision: expectedRevision },
        tx,
      );
      return graphResponse(row);
    });
  }

  async versions(projectId: string) {
    const graph = await this.graph(projectId);
    return this.database.db
      .selectFrom('execution_graph_versions')
      .select([
        'version',
        'source_revision as sourceRevision',
        'created_at as createdAt',
        'created_by as createdBy',
        'retired_at as retiredAt',
      ])
      .where('graph_id', '=', graph.id)
      .orderBy('version', 'desc')
      .execute();
  }

  async version(projectId: string, version: number) {
    const graph = await this.graph(projectId);
    const row = await this.publishedVersion(this.database.db, graph.id, version);
    return {
      version: row.version,
      sourceRevision: row.source_revision,
      createdAt: row.created_at,
      createdBy: row.created_by,
      retiredAt: row.retired_at,
      definition: JSON.parse(row.definition_json) as GraphDefinition,
    };
  }

  async restore(projectId: string, version: number, expectedRevision: number, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      const graph = await this.lockDraft(tx, projectId, expectedRevision);
      const published = await this.publishedVersion(tx, graph.id, version);
      const stored = readStoredDefinition(published.definition_json);
      const definition = compileCanvas(writableCanvas(stored), true);
      await this.validateReferences(tx, projectId, definition);
      const row = await this.updateDraft(tx, graph, definition);
      await this.audit.record(
        userId,
        'execution_graph.restore',
        'execution_graph',
        graph.id,
        { projectId, version, revision: row.revision },
        tx,
      );
      return graphResponse(row);
    });
  }

  async retire(projectId: string, version: number, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await requireProject(tx, projectId);
      const graph = await this.graph(projectId, tx);
      const published = await this.publishedVersion(tx, graph.id, version);
      if (published.retired_at !== null) return { version, retiredAt: published.retired_at };
      if (graph.published_version === version)
        throw new ConflictException('请先发布替代版本，再停用当前发布版本');
      const trigger = await tx
        .selectFrom('execution_graph_triggers')
        .select('name')
        .where('project_id', '=', projectId)
        .where('version', '=', version)
        .where('enabled', '=', 1)
        .executeTakeFirst();
      if (trigger) throw new ConflictException(`请先停用该版本的触发器「${trigger.name}」`);
      const pending = await tx
        .selectFrom('execution_graph_trigger_events as event')
        .innerJoin('execution_graph_triggers as rule', 'rule.id', 'event.trigger_id')
        .select('event.id')
        .where('rule.project_id', '=', projectId)
        .where('event.graph_version', '=', version)
        .where('event.status', '=', 'PENDING')
        .executeTakeFirst();
      if (pending) throw new ConflictException('该版本仍有已接收的触发事件，请等待派发完成');
      const retiredAt = Date.now();
      await tx
        .updateTable('execution_graph_versions')
        .set({ retired_at: retiredAt })
        .where('id', '=', published.id)
        .execute();
      await this.audit.record(
        userId,
        'execution_graph.retire',
        'execution_graph',
        graph.id,
        { projectId, version },
        tx,
      );
      return { version, retiredAt };
    });
  }

  private async publishedVersion(db: Kysely<Database>, graphId: string, version: number) {
    const row = await db
      .selectFrom('execution_graph_versions')
      .selectAll()
      .where('graph_id', '=', graphId)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('执行图发布版本不存在');
    return row;
  }
}
