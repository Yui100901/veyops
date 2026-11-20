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
import { requireProject } from '../projects/project-relations';
import { compileCanvas, withDraftCanvas } from './execution-graph-canvas';
import {
  extractGraphFlow,
  type ExtractGraphFlowDto,
  type GraphDefinition,
  type SaveGraphDraftDto,
  validateGraphDefinition,
} from './execution-graph-definition';

function graphResponse(row: Selectable<Database['execution_graphs']>) {
  return {
    id: row.id,
    projectId: row.project_id,
    revision: row.revision,
    publishedVersion: row.published_version,
    draft: withDraftCanvas(JSON.parse(row.draft_json) as GraphDefinition),
  };
}

@Injectable()
export class ExecutionGraphsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
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
    const flowNodes = definition.flows.flatMap((flow) => flow.nodes);
    const repos = [...new Set(flowNodes.flatMap((node) => node.checkout?.repositoryId ?? []))];
    if (repos.length) {
      const rows = await tx
        .selectFrom('repositories')
        .select('id')
        .where('project_id', '=', projectId)
        .where('id', 'in', repos)
        .execute();
      if (rows.length !== repos.length)
        throw new BadRequestException('源码拉取节点引用的仓库不存在或不属于当前项目');
    }
    const nodes = flowNodes.filter((node) => node.pipelineId);
    if (!nodes.length) return;
    const ids = [...new Set(nodes.map((node) => node.pipelineId!))];
    const rows = await tx
      .selectFrom('pipelines as p')
      .innerJoin('pipeline_versions as v', 'v.pipeline_id', 'p.id')
      .select(['p.id', 'v.version'])
      .where('p.project_id', '=', projectId)
      .where('p.id', 'in', ids)
      .where('v.version', 'in', [...new Set(nodes.map((node) => node.pipelineVersion!))])
      .execute();
    const available = new Set(rows.map((row) => `${row.id}/${row.version}`));
    if (nodes.some((node) => !available.has(`${node.pipelineId}/${node.pipelineVersion}`)))
      throw new BadRequestException('节点引用的固定流水线版本不存在或不属于当前项目');
  }

  async save(projectId: string, input: SaveGraphDraftDto, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      const graph = await this.lockDraft(tx, projectId, input.expectedRevision);
      const definition = input.definition.canvas
        ? compileCanvas(input.definition.canvas, false)
        : input.definition;
      if (!definition.canvas) {
        validateGraphDefinition(definition);
        await this.validateReferences(tx, projectId, definition);
      }
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

  async previewExtraction(projectId: string, input: ExtractGraphFlowDto) {
    await requireProject(this.database.db, projectId);
    const graph = await this.graph(projectId);
    this.checkRevision(graph.revision, input.expectedRevision);
    return extractGraphFlow(this.extractableDraft(graph.draft_json), input).preview;
  }

  async extract(projectId: string, input: ExtractGraphFlowDto, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      const graph = await this.lockDraft(tx, projectId, input.expectedRevision);
      const { definition, preview } = extractGraphFlow(
        this.extractableDraft(graph.draft_json),
        input,
      );
      await this.validateReferences(tx, projectId, definition);
      const row = await this.updateDraft(tx, graph, definition);
      await this.audit.record(
        userId,
        'execution_graph.extract',
        'execution_graph',
        graph.id,
        { projectId, revision: row.revision, mode: input.mode, ...preview },
        tx,
      );
      return graphResponse(row);
    });
  }

  private extractableDraft(draft: string) {
    const definition = JSON.parse(draft) as GraphDefinition;
    if (definition.canvas)
      throw new BadRequestException('在画布中配对开始节点和结束节点即可生成执行流');
    return definition;
  }

  async publish(projectId: string, expectedRevision: number, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      const graph = await this.lockDraft(tx, projectId, expectedRevision);
      const existing = await tx
        .selectFrom('execution_graph_versions')
        .select('version')
        .where('graph_id', '=', graph.id)
        .where('source_revision', '=', expectedRevision)
        .executeTakeFirst();
      if (existing) return graphResponse(graph);
      const version = (graph.published_version ?? 0) + 1;
      const now = Date.now();
      const draft = JSON.parse(graph.draft_json) as GraphDefinition;
      const definition = draft.canvas ? compileCanvas(draft.canvas, true) : draft;
      if (!definition.canvas) validateGraphDefinition(definition);
      await this.validateReferences(tx, projectId, definition);
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
      if (definition.canvas) {
        await tx
          .updateTable('execution_graph_triggers')
          .set({ enabled: 0, next_at: null, updated_at: now })
          .where('project_id', '=', projectId)
          .where('enabled', '=', 1)
          .where(
            'flow_id',
            'not in',
            definition.flows.map(({ id }) => id),
          )
          .execute();
      }
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
      definition: JSON.parse(row.definition_json) as GraphDefinition,
    };
  }

  async restore(projectId: string, version: number, expectedRevision: number, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      const graph = await this.lockDraft(tx, projectId, expectedRevision);
      const published = await this.publishedVersion(tx, graph.id, version);
      const definition = JSON.parse(published.definition_json) as GraphDefinition;
      validateGraphDefinition(definition);
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
