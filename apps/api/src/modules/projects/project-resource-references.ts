import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { GraphDefinition } from '../execution-graphs/execution-graph-definition';
import { activeFlowStatuses } from '../execution-graphs/graph-run-lifecycle';
import type { TaskPayload } from '../tasks/tasks.types';
import { terminalTaskStatuses } from '../tasks/tasks.types';
import {
  graphResourceReferences,
  graphTriggerReferences,
  objectValue,
  referenceRows,
  runResourceReferences,
  selectionReferences,
  taskPayloadResourceReferences,
  type ProjectResourceReference,
  type ProjectResourceState,
  type ProjectResourceType,
  type ReferenceSource,
} from './project-resource-extraction';

export {
  graphResourceReferences,
  graphTriggerReferences,
  runResourceReferences,
  taskPayloadResourceReferences,
  projectResourceStates,
  projectResourceTypes,
  type ProjectResourceReference,
  type ProjectResourceSourceKind,
  type ProjectResourceState,
  type ProjectResourceType,
} from './project-resource-extraction';

export interface ProjectResourceOptions {
  resourceType?: ProjectResourceType;
  resourceId?: string;
  states?: readonly ProjectResourceState[];
  /** Each kind of completed run, task, deployment and artifact is listed newest first. */
  historyLimit?: number;
}

type Db = Kysely<Database>;
const includes = (options: ProjectResourceOptions, state: ProjectResourceState) =>
  !options.states || options.states.includes(state);
const capHistory = (options: ProjectResourceOptions) =>
  Math.max(0, Math.min(options.historyLimit ?? 100, 500));
async function configuredReferences(
  db: Db,
  projectId: string,
  archived: boolean,
  options: ProjectResourceOptions,
) {
  const result: ProjectResourceReference[] = [];
  const typeWanted = (...types: ProjectResourceType[]) =>
    !options.resourceType || types.includes(options.resourceType);
  const stateOf = (...owners: unknown[]): ProjectResourceState =>
    archived || owners.some((value) => typeof value === 'number') ? 'HISTORY' : 'CONFIGURED';
  if (typeWanted('SERVER', 'SERVER_GROUP', 'ENVIRONMENT')) {
    const defaults = await db
      .selectFrom('environments')
      .select(['id', 'name', 'archived_at', 'default_target_selection_json'])
      .where('project_id', '=', projectId)
      .where('default_target_selection_json', 'is not', null)
      .orderBy('id')
      .execute();
    for (const row of defaults) {
      const state = stateOf(row.archived_at);
      if (!includes(options, state)) continue;
      const source: ReferenceSource = {
        sourceKind: 'ENVIRONMENT_DEFAULT',
        sourceId: row.id,
        state,
        environmentId: row.id,
        label: row.name,
      };
      result.push(
        ...referenceRows(source, 'ENVIRONMENT', row.id),
        ...selectionReferences(source, JSON.parse(row.default_target_selection_json!)),
      );
    }
  }
  if (typeWanted('SERVER', 'SERVER_GROUP', 'LEGACY_TARGET', 'SERVICE', 'ENVIRONMENT', 'REGISTRY')) {
    const configs = await db
      .selectFrom('service_environment_configs as config')
      .innerJoin('services as service', 'service.id', 'config.service_id')
      .innerJoin('environments as environment', 'environment.id', 'config.environment_id')
      .where('service.project_id', '=', projectId)
      .where('environment.project_id', '=', projectId)
      .select([
        'config.id',
        'config.target_selection_json',
        'config.config_json',
        'config.target_id',
        'config.service_id',
        'config.environment_id',
        'service.name as serviceName',
        'environment.name as environmentName',
        'service.archived_at as serviceArchived',
        'environment.archived_at as environmentArchived',
      ])
      .orderBy('config.id')
      .execute();
    for (const row of configs) {
      const state = stateOf(row.serviceArchived, row.environmentArchived);
      if (!includes(options, state)) continue;
      const source: ReferenceSource = {
        sourceKind: 'SERVICE_ENVIRONMENT',
        sourceId: row.id,
        state,
        serviceId: row.service_id,
        environmentId: row.environment_id,
        label: `${row.serviceName} · ${row.environmentName}`,
      };
      result.push(
        ...referenceRows(source, 'SERVICE', row.service_id),
        ...referenceRows(source, 'ENVIRONMENT', row.environment_id),
        ...referenceRows(source, 'LEGACY_TARGET', row.target_id),
        ...referenceRows(source, 'REGISTRY', objectValue(JSON.parse(row.config_json)).registryId),
        ...selectionReferences(
          source,
          row.target_selection_json ? JSON.parse(row.target_selection_json) : undefined,
        ),
      );
    }
  }
  if (typeWanted('SERVICE', 'REPOSITORY')) {
    const links = await db
      .selectFrom('service_repositories as link')
      .innerJoin('services as service', 'service.id', 'link.service_id')
      .innerJoin('repositories as repository', 'repository.id', 'link.repository_id')
      .where('service.project_id', '=', projectId)
      .where('repository.project_id', '=', projectId)
      .select([
        'link.service_id',
        'link.repository_id',
        'service.name',
        'service.archived_at as serviceArchived',
        'repository.archived_at as repoArchived',
      ])
      .orderBy('link.service_id')
      .orderBy('link.repository_id')
      .execute();
    for (const row of links) {
      const state = stateOf(row.serviceArchived, row.repoArchived);
      if (!includes(options, state)) continue;
      const source: ReferenceSource = {
        sourceKind: 'SERVICE_REPOSITORY',
        sourceId: `${row.service_id}:${row.repository_id}`,
        state,
        serviceId: row.service_id,
        label: row.name,
      };
      result.push(
        ...referenceRows(source, 'SERVICE', row.service_id),
        ...referenceRows(source, 'REPOSITORY', row.repository_id),
      );
    }
  }
  if (typeWanted('CREDENTIAL')) {
    const repos = await db
      .selectFrom('repositories')
      .select(['id', 'name', 'credential_id', 'archived_at'])
      .where('project_id', '=', projectId)
      .where('credential_id', 'is not', null)
      .orderBy('id')
      .execute();
    for (const row of repos) {
      const state = stateOf(row.archived_at);
      if (includes(options, state))
        result.push(
          ...referenceRows(
            {
              sourceKind: 'REPOSITORY',
              sourceId: row.id,
              state,
              label: row.name,
            },
            'CREDENTIAL',
            row.credential_id,
          ),
        );
    }
    const [projectVariables, environmentVariables, serviceVariables, environmentSetVariables] = await Promise.all([
      db
        .selectFrom('project_variables')
        .select(['id', 'key', 'credential_id'])
        .where('project_id', '=', projectId)
        .where('credential_id', 'is not', null)
        .orderBy('id')
        .execute(),
      db
        .selectFrom('environment_variables as variable')
        .innerJoin('environments as environment', 'environment.id', 'variable.environment_id')
        .select([
          'variable.id',
          'variable.key',
          'variable.credential_id',
          'variable.environment_id as environmentId',
          'environment.archived_at',
        ])
        .where('environment.project_id', '=', projectId)
        .where('variable.credential_id', 'is not', null)
        .orderBy('variable.id')
        .execute(),
      db
        .selectFrom('service_environment_variables as variable')
        .innerJoin('services as service', 'service.id', 'variable.service_id')
        .innerJoin('environments as environment', 'environment.id', 'variable.environment_id')
        .select([
          'variable.id',
          'variable.key',
          'variable.credential_id',
          'variable.service_id as serviceId',
          'variable.environment_id as environmentId',
          'service.archived_at',
          'environment.archived_at as environmentArchived',
        ])
        .where('service.project_id', '=', projectId)
        .where('environment.project_id', '=', projectId)
        .where('variable.credential_id', 'is not', null)
        .orderBy('variable.id')
        .execute(),
      db
        .selectFrom('project_environment_set_variables as variable')
        .innerJoin('project_environment_sets as env_set', 'env_set.id', 'variable.environment_set_id')
        .select(['variable.id', 'variable.key', 'variable.credential_id', 'env_set.archived_at'])
        .where('env_set.project_id', '=', projectId)
        .where('variable.credential_id', 'is not', null)
        .orderBy('variable.id')
        .execute(),
    ]);
    for (const row of [...projectVariables, ...environmentVariables, ...serviceVariables, ...environmentSetVariables]) {
      const state = stateOf(
        'archived_at' in row ? row.archived_at : null,
        'environmentArchived' in row ? row.environmentArchived : null,
      );
      if (!includes(options, state)) continue;
      result.push(
        ...referenceRows(
          {
            sourceKind: 'VARIABLE',
            sourceId: row.id,
            state,
            label: row.key,
            environmentId:
              'environmentId' in row && typeof row.environmentId === 'string'
                ? row.environmentId
                : undefined,
            serviceId:
              'serviceId' in row && typeof row.serviceId === 'string' ? row.serviceId : undefined,
          },
          'CREDENTIAL',
          row.credential_id,
        ),
      );
    }
  }
  return result;
}

async function graphAndRunReferences(
  db: Db,
  projectId: string,
  archived: boolean,
  options: ProjectResourceOptions,
) {
  const result: ProjectResourceReference[] = [];
  const graph = await db
    .selectFrom('execution_graphs')
    .select(['id', 'draft_json'])
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!graph) return result;
  if (!archived && includes(options, 'DRAFT'))
    result.push(
      ...graphResourceReferences(JSON.parse(graph.draft_json) as GraphDefinition, {
        sourceId: graph.id,
        state: 'DRAFT',
      }),
    );
  const published = await db
    .selectFrom('execution_graph_versions')
    .select(['id', 'version', 'definition_json', 'retired_at'])
    .where('graph_id', '=', graph.id)
    .orderBy('version', 'desc')
    .execute();
  const definitions = new Map(
    published.map((row) => [row.version, JSON.parse(row.definition_json) as GraphDefinition]),
  );
  for (const row of published) {
    const state = archived || row.retired_at !== null ? 'HISTORY' : 'RUNNABLE';
    if (includes(options, state))
      result.push(
        ...graphResourceReferences(definitions.get(row.version)!, {
          sourceId: row.id,
          state,
          version: row.version,
        }),
      );
  }
  if (!archived && includes(options, 'RUNNABLE')) {
    const triggers = await db
      .selectFrom('execution_graph_triggers')
      .select(['id', 'name', 'flow_id', 'version', 'config_json'])
      .where('project_id', '=', projectId)
      .where('enabled', '=', 1)
      .orderBy('id')
      .execute();
    for (const row of triggers) {
      const definition = definitions.get(row.version);
      if (
        !definition ||
        !published.some((version) => version.version === row.version && version.retired_at === null)
      )
        continue;
      result.push(
        ...graphTriggerReferences(
          definition,
          {
            sourceId: row.id,
            flowId: row.flow_id,
            version: row.version,
            label: row.name,
          },
          JSON.parse(row.config_json),
        ),
      );
    }
  }
  for (const state of ['PENDING', 'HISTORY'] as const) {
    if (!includes(options, state)) continue;
    const rows = await db
      .selectFrom('execution_flow_runs')
      .select(['id', 'flow_id', 'flow_name', 'version', 'inputs_json'])
      .where('project_id', '=', projectId)
      .where('status', state === 'PENDING' ? 'in' : 'not in', activeFlowStatuses)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .$if(state === 'HISTORY', (query) => query.limit(capHistory(options)))
      .execute();
    for (const row of rows) {
      const context = {
        sourceId: row.id,
        state,
        version: row.version,
        flowId: row.flow_id,
        label: row.flow_name,
      };
      const definition = definitions.get(row.version);
      result.push(...runResourceReferences(definition, context, JSON.parse(row.inputs_json)));
      // A version may be retired while a run still needs a statically bound credential or other input.
      if (state === 'PENDING' && definition) {
        const pendingFlows = new Set([row.flow_id]);
        for (const flowId of pendingFlows)
          for (const node of definition.flows.find(({ id }) => id === flowId)?.nodes ?? [])
            if (node.type === 'FLOW_CALL' && node.flowId) pendingFlows.add(node.flowId);
        result.push(
          ...graphResourceReferences(
            { flows: definition.flows.filter(({ id }) => pendingFlows.has(id)) },
            context,
          ).map((reference) => ({ ...reference, sourceKind: 'RUN' as const, runId: row.id })),
        );
      }
    }
  }
  return result;
}

async function taskReferences(db: Db, projectId: string, options: ProjectResourceOptions) {
  const refs: ProjectResourceReference[] = [];
  for (const state of ['PENDING', 'HISTORY'] as const) {
    if (!includes(options, state)) continue;
    const tasks = await db
      .selectFrom('tasks')
      .select(['id', 'name', 'service_id', 'environment_id', 'target_id', 'payload_json'])
      .where('project_id', '=', projectId)
      .where('status', state === 'PENDING' ? 'not in' : 'in', terminalTaskStatuses)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .$if(state === 'HISTORY', (query) => query.limit(capHistory(options)))
      .execute();
    for (const row of tasks) {
      const payload = JSON.parse(row.payload_json) as TaskPayload;
      const source: ReferenceSource = {
        sourceKind: 'TASK',
        sourceId: row.id,
        taskId: row.id,
        state,
        label: row.name,
        serviceId: row.service_id ?? undefined,
        environmentId: row.environment_id ?? undefined,
        runId: payload.pipeline?.graph?.runId,
      };
      refs.push(
        ...referenceRows(source, 'SERVICE', row.service_id),
        ...referenceRows(source, 'ENVIRONMENT', row.environment_id),
        ...referenceRows(source, 'LEGACY_TARGET', row.target_id),
        ...taskPayloadResourceReferences(source, payload),
      );
    }
  }
  if (includes(options, 'HISTORY')) {
    const [deployments, artifacts] = await Promise.all([
      db
        .selectFrom('deployment_records as deployment')
        .innerJoin('pipeline_runs as run', 'deployment.pipeline_run_id', 'run.id')
        .leftJoin('task_targets as target', 'deployment.task_target_id', 'target.id')
        .where('run.project_id', '=', projectId)
        .where('deployment.finished_at', 'is not', null)
        .select([
          'deployment.id',
          'deployment.service_id',
          'deployment.environment_id',
          'deployment.server_id',
          'deployment.artifact_id',
          'run.task_id',
          'target.server_name_snapshot',
          'target.host_snapshot',
          'target.port_snapshot',
        ])
        .orderBy('deployment.started_at', 'desc')
        .orderBy('deployment.id')
        .limit(capHistory(options))
        .execute(),
      db
        .selectFrom('artifacts')
        .select(['id', 'service_id', 'server_id', 'registry_id', 'graph_run_id', 'artifact_name'])
        .where('project_id', '=', projectId)
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(capHistory(options))
        .execute(),
    ]);
    for (const row of deployments) {
      const source: ReferenceSource = {
        sourceKind: 'DEPLOYMENT',
        sourceId: row.id,
        state: 'HISTORY',
        taskId: row.task_id,
        serviceId: row.service_id,
        environmentId: row.environment_id,
      };
      refs.push(
        ...referenceRows(
          {
            ...source,
            serverNameSnapshot: row.server_name_snapshot ?? undefined,
            hostSnapshot: row.host_snapshot ?? undefined,
            portSnapshot: row.port_snapshot ?? undefined,
          },
          'SERVER',
          row.server_id,
        ),
        ...referenceRows(source, 'SERVICE', row.service_id),
        ...referenceRows(source, 'ENVIRONMENT', row.environment_id),
        ...referenceRows(source, 'ARTIFACT', row.artifact_id),
      );
    }
    for (const row of artifacts) {
      const source: ReferenceSource = {
        sourceKind: 'ARTIFACT',
        sourceId: row.id,
        state: 'HISTORY',
        serviceId: row.service_id,
        runId: row.graph_run_id ?? undefined,
        label: row.artifact_name ?? undefined,
      };
      refs.push(
        ...referenceRows(source, 'SERVER', row.server_id),
        ...referenceRows(source, 'SERVICE', row.service_id),
        ...referenceRows(source, 'REGISTRY', row.registry_id),
      );
    }
  }
  return refs;
}

async function currentMembers(db: Db, refs: ProjectResourceReference[], serverId?: string) {
  const memberSources = refs.filter((row) =>
    ['CONFIGURED', 'DRAFT', 'RUNNABLE'].includes(row.state),
  );
  const groupSources = memberSources.filter((row) => row.resourceType === 'SERVER_GROUP');
  const targetSources = memberSources.filter((row) => row.resourceType === 'LEGACY_TARGET');
  const result: ProjectResourceReference[] = [];
  // Chunk typed IN predicates for SQLite and index sources before expanding membership.
  const sections = async (
    sources: ProjectResourceReference[],
    expand: (ids: string[]) => Promise<{ ownerId: string; serverId: string; name: string }[]>,
    kind: 'GROUP' | 'TARGET',
  ) => {
    const map = new Map<string, ProjectResourceReference[]>();
    for (const source of sources) {
      const entries = map.get(source.resourceId);
      if (entries) entries.push(source);
      else map.set(source.resourceId, [source]);
    }
    const ids = [...map.keys()];
    for (let offset = 0; offset < ids.length; offset += 250) {
      for (const member of await expand(ids.slice(offset, offset + 250))) {
        for (const source of map.get(member.ownerId) ?? [])
          result.push({
            ...source,
            resourceType: 'SERVER',
            resourceId: member.serverId,
            ...(kind === 'GROUP'
              ? { viaGroupId: member.ownerId, viaGroupName: member.name }
              : { viaTargetId: member.ownerId, viaTargetName: member.name }),
          });
      }
    }
  };
  await sections(
    groupSources,
    (ids) =>
      db
        .selectFrom('server_group_members as member')
        .innerJoin('server_groups as group', 'group.id', 'member.group_id')
        .select(['member.group_id as ownerId', 'member.server_id as serverId', 'group.name'])
        .where('member.group_id', 'in', ids)
        .$if(!!serverId, (query) => query.where('member.server_id', '=', serverId!))
        .orderBy('member.group_id')
        .orderBy('member.sort_order')
        .orderBy('member.server_id')
        .execute(),
    'GROUP',
  );
  await sections(
    targetSources,
    (ids) =>
      db
        .selectFrom('deployment_target_servers as member')
        .innerJoin('deployment_targets as target', 'target.id', 'member.target_id')
        .select(['member.target_id as ownerId', 'member.server_id as serverId', 'target.name'])
        .where('member.target_id', 'in', ids)
        .$if(!!serverId, (query) => query.where('member.server_id', '=', serverId!))
        .orderBy('member.target_id')
        .orderBy('member.sort_order')
        .orderBy('member.server_id')
        .execute(),
    'TARGET',
  );
  return result;
}

export async function projectResourceReferences(
  db: Db,
  projectId: string,
  options: ProjectResourceOptions = {},
): Promise<ProjectResourceReference[]> {
  const project = await db
    .selectFrom('projects')
    .select('deleted_at')
    .where('id', '=', projectId)
    .executeTakeFirst();
  if (!project) return [];
  const archived = project.deleted_at !== null;
  const [configured, graph, tasks] = await Promise.all([
    includes(options, 'CONFIGURED') || includes(options, 'HISTORY')
      ? configuredReferences(db, projectId, archived, options)
      : [],
    ['DRAFT', 'RUNNABLE', 'PENDING', 'HISTORY'].some((state) =>
      includes(options, state as ProjectResourceState),
    )
      ? graphAndRunReferences(db, projectId, archived, options)
      : [],
    includes(options, 'PENDING') || includes(options, 'HISTORY')
      ? taskReferences(db, projectId, options)
      : [],
  ]);
  const refs = [...configured, ...graph, ...tasks];
  if (!options.resourceType || options.resourceType === 'SERVER')
    refs.push(
      ...(await currentMembers(
        db,
        refs,
        options.resourceId && options.resourceType === 'SERVER' ? options.resourceId : undefined,
      )),
    );
  const seen = new Set<string>();
  return refs.filter((row) => {
    if (
      (options.resourceType && row.resourceType !== options.resourceType) ||
      (options.resourceId && row.resourceId !== options.resourceId)
    )
      return false;
    const identity = JSON.stringify([
      row.resourceType,
      row.resourceId,
      row.state,
      row.sourceKind,
      row.sourceId,
      row.flowId,
      row.nodeId,
      row.fieldId,
      row.serviceId,
      row.environmentId,
      row.viaGroupId,
      row.viaTargetId,
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export async function projectResourceInventory(
  db: Db,
  projectId: string,
  options?: ProjectResourceOptions,
) {
  const references = await projectResourceReferences(db, projectId, options);
  const byHost = new Map<string, ProjectResourceReference[]>();
  for (const row of references) {
    if (row.resourceType !== 'SERVER') continue;
    const entries = byHost.get(row.resourceId);
    if (entries) entries.push(row);
    else byHost.set(row.resourceId, [row]);
  }
  const ids = [...byHost]
    .filter(([, refs]) =>
      refs.some(({ state }) => state === 'CONFIGURED' || state === 'DRAFT' || state === 'RUNNABLE'),
    )
    .map(([id]) => id);
  const servers: {
    id: string;
    name: string;
    host: string;
    port: number;
    status: string;
    active: boolean;
    references: ProjectResourceReference[];
  }[] = [];
  for (let offset = 0; offset < ids.length; offset += 250) {
    const rows = await db
      .selectFrom('servers')
      .select(['id', 'name', 'host', 'port', 'status', 'is_active'])
      .where('id', 'in', ids.slice(offset, offset + 250))
      .execute();
    servers.push(
      ...rows.map(({ is_active, ...row }) => ({
        ...row,
        active: is_active === 1,
        references: byHost.get(row.id)!,
      })),
    );
  }
  servers.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  return { servers, references };
}

export async function targetProjectReferences(
  db: Db,
  resourceType: 'SERVER' | 'SERVER_GROUP',
  resourceId: string,
) {
  const projects = await db.selectFrom('projects')
    .select(['id', 'name', 'slug'])
    .where('deleted_at', 'is', null)
    .orderBy('name')
    .orderBy('id')
    .execute();
  const result: (typeof projects[number] & { references: ProjectResourceReference[] })[] = [];
  for (const project of projects) {
    const references = await projectResourceReferences(db, project.id, {
      resourceType,
      resourceId,
      historyLimit: 20,
    });
    if (references.length) result.push({ ...project, references });
  }
  return result;
}
