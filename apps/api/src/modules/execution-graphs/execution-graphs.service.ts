import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { requireProject } from '../projects/project-relations';
import { canvasIssues, compileCanvas, withDraftCanvas } from './execution-graph-canvas';
import {
  type GraphDefinition,
  type GraphFlow,
  type GraphNode,
  type SaveGraphDraftDto,
  validateGraphDefinition,
} from './execution-graph-definition';
import {
  GraphCompileError,
  graphModulePorts,
  type GraphBinding,
  type GraphDiagnostic,
  type GraphField,
} from './graph-fields';

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
    const tables = {
      REPOSITORY: 'repositories',
      ENVIRONMENT: 'environments',
      SERVICE: 'services',
      ARTIFACT: 'artifacts',
    } as const;
    type ResourceType = keyof typeof tables;
    type Reference = { flow: GraphFlow; node: GraphNode; field: GraphField };
    const refs = new Map<ResourceType, Map<string, Reference>>();
    function addReference(flow: GraphFlow, node: GraphNode, field: GraphField, value: unknown) {
      if (!Object.hasOwn(tables, field.type)) return;
      const type = field.type as ResourceType;
      const layer = refs.get(type) ?? new Map<string, Reference>();
      for (const item of Array.isArray(value) ? value : [value]) {
        const id =
          typeof item === 'string'
            ? item
            : item && typeof item === 'object' && 'id' in item && typeof item.id === 'string'
              ? item.id
              : undefined;
        if (id) layer.set(id, { flow, node, field });
      }
      if (layer.size) refs.set(type, layer);
    }
    function fromBinding(
      flow: GraphFlow,
      node: GraphNode,
      field: GraphField,
      binding: GraphBinding,
    ) {
      if (binding.kind === 'VALUE') addReference(flow, node, field, binding.value);
      if (binding.kind === 'FIRST_AVAILABLE')
        for (const item of binding.sources) fromBinding(flow, node, field, item);
    }
    const flows = new Map(definition.flows.map((flow) => [flow.id, flow]));
    for (const flow of definition.flows) {
      const start = flow.nodes.find((node) => node.type === 'START')!;
      const end = flow.nodes.find((node) => node.type === 'END')!;
      if (flow.serviceId)
        addReference(
          flow,
          start,
          { id: 'service', name: '项目服务', type: 'SERVICE' },
          flow.serviceId,
        );
      for (const input of start.inputs ?? []) addReference(flow, start, input, input.defaultValue);
      for (const node of flow.nodes) {
        const repository = node.checkout?.repositoryId ?? node.build?.repositoryId;
        if (repository)
          addReference(
            flow,
            node,
            { id: 'repository', name: '项目仓库', type: 'REPOSITORY' },
            repository,
          );
        const ports = graphModulePorts(node, flows.get(node.flowId ?? ''))?.inputs ?? [];
        for (const field of ports) {
          const binding = flow.inputBindings?.[node.id]?.[field.id];
          if (binding) fromBinding(flow, node, field, binding);
        }
      }
      for (const field of end.outputs ?? []) {
        const binding = flow.outputBindings?.[field.id];
        if (binding) fromBinding(flow, end, field, binding);
      }
    }
    for (const [type, bindings] of refs) {
      const ids = [...bindings.keys()];
      const rows = await tx
        .selectFrom(tables[type])
        .select('id')
        .where('project_id', '=', projectId)
        .where('id', 'in', ids)
        .execute();
      const available = new Set(rows.map((row) => row.id));
      const missing = ids.find((id) => !available.has(id));
      if (missing) {
        const { flow, node, field } = bindings.get(missing)!;
        throw new GraphCompileError({
          flowId: flow.id,
          nodeId: node.id,
          fieldId: field.id,
          message: `「${flow.name}」 → 「${node.name}」 → 「${field.name}」 · 引用的资源不存在或不属于当前项目`,
        });
      }
    }
  }

  async validate(
    projectId: string,
    definition: GraphDefinition,
  ): Promise<{ issues: GraphDiagnostic[] }> {
    await requireProject(this.database.db, projectId);
    if (!definition.canvas) return { issues: [{ message: '请提交执行图画布' }] };
    const issues = canvasIssues(definition.canvas);
    if (issues.length) return { issues };
    try {
      await this.validateReferences(
        this.database.db,
        projectId,
        compileCanvas(definition.canvas, true),
      );
      return { issues: [] };
    } catch (error) {
      if (error instanceof GraphCompileError) return { issues: [error.issue] };
      throw error;
    }
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
