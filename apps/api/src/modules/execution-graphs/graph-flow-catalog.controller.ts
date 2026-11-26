import { Controller, Get } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { GraphDefinition } from './execution-graph-definition';
import { flowStart } from './graph-run-bindings';

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
      const draftCanvas = draft.canvas?.model === 'FLOW_V2' ? draft.canvas : undefined;
      const currentFlows = current?.canvas?.model === 'FLOW_V2' ? current.flows : [];
      const hasDraftChanges = Boolean(
        draftCanvas &&
        (current ? project.source_revision !== project.revision : draftCanvas.nodes.length),
      );
      const notes = new Map<
        string,
        {
          id: string;
          name: string;
          serviceIds: string[];
          inDraft: boolean;
          version?: number;
          hasRuntimeInputs?: boolean;
          needsArtifactInput?: boolean;
        }
      >();
      for (const node of draftCanvas?.nodes ?? []) {
        if (node.type === 'START') {
          const serviceId = node.start?.release?.serviceId;
          notes.set(node.id, {
            id: node.id,
            name: node.name,
            serviceIds: serviceId ? [serviceId] : [],
            inDraft: true,
          });
        }
      }
      for (const flow of currentFlows) {
        if (flow.model !== 'FLOW_V2') continue;
        const start = flowStart(flow).start;
        const serviceId = start?.release?.serviceId;
        const requiresArtifact = start?.release?.artifactSource === 'RUN_PARAMETER';
        const artifactOverride = Boolean(start?.release?.allowArtifactOverride);
        notes.set(flow.id, {
          id: flow.id,
          name: flow.name,
          serviceIds: serviceId ? [serviceId] : [],
          version: project.published_version!,
          inDraft: notes.has(flow.id),
          hasRuntimeInputs: Boolean(
            requiresArtifact ||
            artifactOverride ||
            start?.sources?.some(({ allowRefOverride }) => allowRefOverride) ||
            start?.variables?.some(
              ({ allowOverride, credentialId }) => allowOverride && !credentialId,
            ) ||
            flow.nodes.some(
              ({ type, condition, branch, switch: choice }) =>
                (type === 'CONDITION' || type === 'SWITCH') &&
                !(condition ?? branch ?? choice)?.parameterKey,
            ),
          ),
          needsArtifactInput:
            requiresArtifact || (artifactOverride && Boolean(start?.release?.useUpstreamArtifact)),
        });
      }
      return {
        projectId: project.id,
        projectName: project.name,
        hasDraftChanges,
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
