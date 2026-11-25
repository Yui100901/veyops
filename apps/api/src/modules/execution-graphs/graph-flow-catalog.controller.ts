import { Controller, Get } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import {
  orderedFlowNodes,
  type GraphDefinition,
  type GraphFlow,
} from './execution-graph-definition';
import { flowCandidateCatalog } from './graph-binding-validation';
import { flowStart, presetReleaseServiceIds, referenceId } from './graph-run-bindings';
import { isSimplifiedCanvasNode } from './simplified-flow-definition';

function belongsToServices(flow: GraphFlow, definition: GraphDefinition) {
  const start = flowStart(flow);
  if (flow.model === 'FLOW_V2')
    return start.start?.release?.serviceId ? [start.start.release.serviceId] : [];
  if (
    start.contract === 'PRESET' &&
    flow.nodes.some(({ type }) => type === 'DEPLOY_ARTIFACT' || type === 'ROLLBACK_ARTIFACT')
  ) {
    if (flow.compiled) return presetReleaseServiceIds(flow);
    const candidates = flowCandidateCatalog(flow, definition.flows, orderedFlowNodes(flow)).nodes;
    return presetReleaseServiceIds(
      flow,
      undefined,
      (node) => candidates[node.id]?.automaticInputBindings.service,
    );
  }
  const service =
    flow.serviceId ??
    referenceId(start.inputs?.find(({ type }) => type === 'SERVICE')?.defaultValue);
  return service ? [service] : [];
}

@Controller('delivery-flows')
export class GraphFlowCatalogController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  async list() {
    const db = this.database.db;
    const projects = await db
      .selectFrom('projects as project')
      .innerJoin('execution_graphs as graph', 'graph.project_id', 'project.id')
      .leftJoin('execution_graph_versions as version', (join) =>
        join
          .onRef('version.graph_id', '=', 'graph.id')
          .onRef('version.version', '=', 'graph.published_version'),
      )
      .where('project.deleted_at', 'is', null)
      .select([
        'project.id',
        'project.name',
        'graph.draft_json',
        'graph.published_version',
        'graph.revision',
        'version.definition_json',
        'version.retired_at',
        'version.source_revision',
      ])
      .orderBy('project.name')
      .orderBy('project.id')
      .execute();
    if (!projects.length) return [];
    const ids = projects.map(({ id }) => id);
    const [services, rules, latest] = await Promise.all([
      db
        .selectFrom('services')
        .where('project_id', 'in', ids)
        .where('archived_at', 'is', null)
        .select(['id', 'name', 'project_id'])
        .execute(),
      db
        .selectFrom('execution_graph_triggers')
        .where('project_id', 'in', ids)
        .where('enabled', '=', 1)
        .select(['project_id', 'flow_id', 'kind', 'config_json'])
        .execute(),
      db
        .selectFrom((eb) =>
          eb
            .selectFrom('execution_flow_runs')
            .where('project_id', 'in', ids)
            .where('parent_run_id', 'is', null)
            .select(['project_id', 'flow_id', 'id', 'status', 'created_at'])
            .select(
              sql<number>`row_number() over (partition by project_id, flow_id order by created_at desc, id desc)`.as(
                'position',
              ),
            )
            .as('ranked'),
        )
        .where('position', '=', 1)
        .select(['project_id', 'flow_id', 'id', 'status', 'created_at'])
        .execute(),
    ]);
    const names = new Map(services.map(({ id, name }) => [id, name]));
    const key = (project: string, flow: string) => project + ':' + flow;
    const events = new Map<string, string[]>();
    for (const rule of rules) {
      const id = key(rule.project_id, rule.flow_id);
      const kind =
        rule.kind === 'CRON' && JSON.parse(rule.config_json).cronMode === 'POLL'
          ? 'POLL'
          : rule.kind;
      events.set(id, [...(events.get(id) ?? []), kind]);
    }
    const history = new Map(
      latest.map((run) => [
        key(run.project_id, run.flow_id),
        {
          id: run.id,
          status: run.status,
          createdAt: run.created_at,
        },
      ]),
    );
    return projects.map((project) => {
      const draft = JSON.parse(project.draft_json) as GraphDefinition;
      const current =
        project.definition_json && project.retired_at === null
          ? (JSON.parse(project.definition_json) as GraphDefinition)
          : undefined;
      const notes = new Map<
        string,
        { id: string; name: string; serviceIds: string[]; version?: number }
      >();
      for (const node of draft.canvas?.nodes ?? []) {
        if (node.type === 'START') {
          const serviceId =
            draft.canvas && isSimplifiedCanvasNode(draft.canvas, node)
              ? node.start?.release?.serviceId
              : referenceId(node.inputs?.find(({ type }) => type === 'SERVICE')?.defaultValue);
          notes.set(node.id, {
            id: node.id,
            name: node.name,
            serviceIds: serviceId ? [serviceId] : [],
          });
        }
      }
      for (const flow of draft.flows)
        notes.set(flow.id, {
          id: flow.id,
          name: flow.name,
          serviceIds: belongsToServices(flow, draft),
        });
      for (const flow of current?.flows ?? [])
        notes.set(flow.id, {
          id: flow.id,
          name: flow.name,
          serviceIds: belongsToServices(flow, current!),
          version: project.published_version!,
        });
      return {
        projectId: project.id,
        projectName: project.name,
        flows: [...notes.values()].map((flow) => {
          const serviceIds = flow.serviceIds.filter((id) => names.has(id));
          const serviceId = serviceIds.length === 1 ? serviceIds[0] : undefined;
          return {
            ...flow,
            serviceIds,
            serviceId,
            serviceName: serviceId ? names.get(serviceId) : undefined,
            serviceNames: serviceIds.map((id) => names.get(id)!),
            hasDraftChanges: !flow.version || project.source_revision !== project.revision,
            triggerKinds: [...new Set(events.get(key(project.id, flow.id)) ?? [])],
            latestRun: history.get(key(project.id, flow.id)),
          };
        }),
      };
    });
  }
}
