import type {
  GraphDefinition,
  GraphFlow,
  GraphNode,
} from '../execution-graphs/execution-graph-definition';
import { graphModulePorts } from '../execution-graphs/graph-fields';
import type { GraphBinding, GraphField } from '../execution-graphs/graph-fields';
import type { TaskPayload } from '../tasks/tasks.types';
import { unversionedArtifactRepository } from '../execution-graphs/graph-workspace';
import {
  isSimplifiedCanvasNode,
  simplifiedTriggerArtifactInput,
  type HistoricalSimplifiedExecution,
  type HistoricalSimplifiedRelease,
} from '../execution-graphs/simplified-flow-definition';

export const projectResourceTypes = [
  'SERVER',
  'SERVER_GROUP',
  'REPOSITORY',
  'SERVICE',
  'ENVIRONMENT',
  'ENVIRONMENT_SET',
  'CREDENTIAL',
  'REGISTRY',
  'LEGACY_TARGET',
  'ARTIFACT',
] as const;
export type ProjectResourceType = (typeof projectResourceTypes)[number];
export const projectResourceStates = [
  'CONFIGURED',
  'DRAFT',
  'RUNNABLE',
  'PENDING',
  'HISTORY',
] as const;
export type ProjectResourceState = (typeof projectResourceStates)[number];
export type ProjectResourceSourceKind =
  | 'SERVICE_ENVIRONMENT'
  | 'ENVIRONMENT_DEFAULT'
  | 'SERVICE_REPOSITORY'
  | 'REPOSITORY'
  | 'VARIABLE'
  | 'GRAPH'
  | 'TRIGGER'
  | 'RUN'
  | 'TASK'
  | 'DEPLOYMENT'
  | 'ARTIFACT';

export interface ProjectResourceReference {
  resourceType: ProjectResourceType;
  resourceId: string;
  sourceKind: ProjectResourceSourceKind;
  sourceId: string;
  state: ProjectResourceState;
  serviceId?: string;
  environmentId?: string;
  version?: number;
  flowId?: string;
  flowName?: string;
  nodeId?: string;
  nodeName?: string;
  fieldId?: string;
  triggerId?: string;
  runId?: string;
  taskId?: string;
  viaGroupId?: string;
  viaGroupName?: string;
  viaTargetId?: string;
  viaTargetName?: string;
  serverNameSnapshot?: string;
  hostSnapshot?: string;
  portSnapshot?: number;
  label?: string;
}

type ValueRecord = Record<string, unknown>;
export type ReferenceSource = Omit<ProjectResourceReference, 'resourceType' | 'resourceId'>;

export function objectValue(value: unknown): ValueRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as ValueRecord)
    : {};
}

function samples(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function idValue(value: unknown) {
  const object = objectValue(value);
  const candidate =
    typeof value === 'string' ? value : (object.id ?? object.serviceId ?? object.artifactId);
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

export function referenceRows(
  source: ReferenceSource,
  resourceType: ProjectResourceType,
  value: unknown,
): ProjectResourceReference[] {
  return samples(value).flatMap((item) => {
    const resourceId = idValue(item);
    if (resourceType === 'REPOSITORY' && resourceId === unversionedArtifactRepository) return [];
    return resourceId ? [{ ...source, resourceType, resourceId }] : [];
  });
}

/** Keep group and legacy target identities separate from the server member list. */
export function selectionReferences(source: ReferenceSource, selection: unknown) {
  const target = objectValue(selection);
  return [
    ...referenceRows(source, 'SERVER', target.serverIds),
    ...referenceRows(source, 'SERVER_GROUP', target.groupIds),
    ...referenceRows(source, 'LEGACY_TARGET', target.targetId),
  ];
}

const referenceFields = new Set<string>([
  'REPOSITORY',
  'SERVICE',
  'ENVIRONMENT',
  'ENVIRONMENT_SET',
  'ARTIFACT',
  'CREDENTIAL',
]);

function fieldReferences(source: ReferenceSource, field: GraphField, value: unknown) {
  const context = { ...source, fieldId: field.id };
  if (field.type === 'TARGETS')
    return samples(value).flatMap((targets) => selectionReferences(context, targets));
  return referenceFields.has(field.type)
    ? referenceRows(context, field.type as ProjectResourceType, value)
    : [];
}

function bindingReferences(
  source: ReferenceSource,
  field: GraphField,
  binding?: GraphBinding,
): ProjectResourceReference[] {
  if (binding?.kind === 'VALUE') return fieldReferences(source, field, binding.value);
  if (binding?.kind === 'CREDENTIAL')
    return referenceRows({ ...source, fieldId: field.id }, 'CREDENTIAL', binding.credentialId);
  if (binding?.kind === 'PROJECT_VALUE')
    return referenceRows({ ...source, fieldId: field.id }, 'SERVER', binding.serverId);
  if (binding?.kind === 'FIRST_AVAILABLE')
    return binding.sources.flatMap((candidate) => bindingReferences(source, field, candidate));
  return [];
}

function nodeReferences(
  source: ReferenceSource,
  node: GraphNode,
  ports = graphModulePorts(node)?.inputs ?? [],
) {
  const legacy = objectValue((node as GraphNode & { delivery?: unknown }).delivery);
  const oldBuild = objectValue(legacy.build);
  return [
    ...referenceRows(
      { ...source, fieldId: 'environmentSet' },
      'ENVIRONMENT_SET',
      node.environmentSet?.mode === 'FIXED' ? node.environmentSet.environmentSetId : undefined,
    ),
    ...referenceRows(
      { ...source, fieldId: 'repository' },
      'REPOSITORY',
      node.checkout?.repositoryId ?? node.build?.repositoryId ?? oldBuild.repositoryId,
    ),
    ...referenceRows(
      { ...source, fieldId: 'composeSource' },
      'REPOSITORY',
      node.deploy?.composeSource?.kind === 'REPOSITORY_FILE'
        ? node.deploy.composeSource.repositoryId
        : undefined,
    ),
    ...referenceRows(
      { ...source, fieldId: 'registryId' },
      'REGISTRY',
      node.build?.registryId ?? oldBuild.registryId,
    ),
    ...referenceRows({ ...source, fieldId: 'serverId' }, 'SERVER', node.shell?.serverId),
    ...referenceRows({ ...source, fieldId: 'service' }, 'SERVICE', legacy.serviceId),
    ...[...(node.inputs ?? []), ...(node.shell?.params ?? [])].flatMap((field) => [
      ...fieldReferences(source, field, field.defaultValue),
      ...(field.type === 'ENVIRONMENT_SET' ? fieldReferences(source, field, field.options) : []),
    ]),
    ...ports.flatMap((field) => fieldReferences(source, field, node.inputDefaults?.[field.id])),
  ];
}

type ScopedType = 'SERVICE' | 'ENVIRONMENT';

function singleScopedField(fields: GraphField[], type: ScopedType) {
  const matching = fields.filter((field) => field.type === type && !field.multiple);
  return matching.length === 1 ? matching[0] : undefined;
}

function authoredScope(
  binding: GraphBinding | undefined,
  fields: GraphField[],
  type: ScopedType,
  fallback: string | undefined,
): string | undefined {
  if (!binding) return fallback;
  const runtimeScope = Symbol();
  const resolve = (candidate: GraphBinding): string | undefined | typeof runtimeScope => {
    switch (candidate.kind) {
      case 'VALUE':
        if (candidate.value == null || (Array.isArray(candidate.value) && !candidate.value.length))
          return undefined;
        return idValue(candidate.value) ?? runtimeScope;
      case 'INPUT': {
        const field = fields.find(
          ({ id, type: kind, multiple }) => id === candidate.fieldId && kind === type && !multiple,
        );
        return idValue(field?.defaultValue) ?? runtimeScope;
      }
      case 'CONTEXT':
        return (
          (candidate.fieldId === (type === 'SERVICE' ? 'serviceId' : 'environmentId') &&
            fallback) ||
          runtimeScope
        );
      case 'FIRST_AVAILABLE':
        // A runtime-selected input can supersede a later literal fallback.
        for (const item of candidate.sources) {
          const value = resolve(item);
          if (value !== undefined) return value;
        }
        return undefined;
      case 'OUTPUT':
        return runtimeScope;
    }
  };
  const value = resolve(binding);
  return value === runtimeScope ? undefined : (value ?? fallback);
}

function flowReferences(source: ReferenceSource, flow: GraphFlow, flows: Map<string, GraphFlow>) {
  if (flow.model === 'FLOW_V2')
    return flow.nodes.flatMap((node) =>
      simplifiedNodeReferences({ ...source, flowId: flow.id, flowName: flow.name }, node),
    );
  const grouped = flow.compiled?.presetResourceGroups;
  const serviceId = grouped ? undefined : flow.serviceId;
  const context = { ...source, flowId: flow.id, flowName: flow.name, serviceId };
  const start = flow.nodes.find((node) => node.type === 'START');
  const fields = start?.inputs ?? [];
  const defaultEnvironment = idValue(singleScopedField(fields, 'ENVIRONMENT')?.defaultValue);
  const defaultService = serviceId ?? idValue(singleScopedField(fields, 'SERVICE')?.defaultValue);
  return [
    ...referenceRows(
      { ...context, nodeId: start?.id, nodeName: start?.name, fieldId: 'service' },
      'SERVICE',
      serviceId,
    ),
    ...flow.nodes.flatMap((node) => {
      const bindings = grouped
        ? flow.compiled?.nodes[node.id]?.inputBindings
        : flow.inputBindings?.[node.id];
      const nodeSource = {
        ...context,
        nodeId: node.id,
        nodeName: node.name,
        environmentId: authoredScope(
          bindings?.environment,
          fields,
          'ENVIRONMENT',
          idValue(node.inputDefaults?.environment) ?? defaultEnvironment,
        ),
        serviceId: authoredScope(
          bindings?.service,
          fields,
          'SERVICE',
          idValue(node.inputDefaults?.service) ?? defaultService,
        ),
      };
      const ports = graphModulePorts(node, flows.get(node.flowId ?? ''))?.inputs ?? [];
      return [
        ...nodeReferences(nodeSource, node, ports),
        ...ports.flatMap((field) => bindingReferences(nodeSource, field, bindings?.[field.id])),
        ...Object.entries(flow.environmentBindings?.[node.id] ?? {}).flatMap(([key, binding]) =>
          bindingReferences(nodeSource, { id: key, name: key, type: 'TEXT' }, binding),
        ),
        ...(node.type === 'END'
          ? (node.outputs ?? []).flatMap((field) =>
              bindingReferences(nodeSource, field, flow.outputBindings?.[field.id]),
            )
          : []),
      ];
    }),
  ];
}

function simplifiedNodeReferences(source: ReferenceSource, node: GraphNode) {
  const config = node.start;
  const execution = config?.execution as HistoricalSimplifiedExecution | undefined;
  const oldRelease = config?.release as HistoricalSimplifiedRelease | undefined;
  const context = {
    ...source,
    nodeId: node.id,
    nodeName: node.name,
    serviceId: config?.release?.serviceId,
  };
  const field = (fieldId: string) => ({ ...context, fieldId });
  return [
    ...(config?.sources ?? []).flatMap(({ id, repositoryId }) =>
      referenceRows(field('start.sources.' + id + '.repositoryId'), 'REPOSITORY', repositoryId),
    ),
    ...(execution?.location === 'MANAGER'
      ? []
      : [
          ...referenceRows(field('start.execution.serverId'), 'SERVER', execution?.serverId),
          ...referenceRows(field('start.execution.groupId'), 'SERVER_GROUP', execution?.groupId),
        ]),
    ...referenceRows(field('start.environmentSetId'), 'ENVIRONMENT_SET', config?.environmentSetId),
    ...(config?.variables ?? []).flatMap(({ key, credentialId }) =>
      referenceRows(field('start.variables.' + key + '.credentialId'), 'CREDENTIAL', credentialId),
    ),
    ...referenceRows(field('start.release.serviceId'), 'SERVICE', config?.release?.serviceId),
    ...selectionReferences(field('start.release.targets'), oldRelease?.targets),
    ...referenceRows(field('start.release.artifactId'), 'ARTIFACT', config?.release?.artifactId),
    ...(node.finish?.images ?? []).flatMap(({ registryId }, index) =>
      referenceRows(field(`finish.images.${index}.registryId`), 'REGISTRY', registryId),
    ),
  ];
}

/** Read only typed resource-bearing values, never opaque user scripts or variable data. */
export function graphResourceReferences(
  definition: GraphDefinition,
  source: { sourceId: string; state: ProjectResourceState; version?: number },
) {
  const context = { ...source, sourceKind: 'GRAPH' } as const;
  const flows = new Map((definition.flows ?? []).map((flow) => [flow.id, flow]));
  const rows = [...flows.values()].flatMap((flow) => flowReferences(context, flow, flows));
  const { canvas } = definition;
  if (source.state !== 'DRAFT' || !canvas) return rows;
  const compiledNodeIds = new Set(
    [...flows.values()].flatMap((flow) => flow.nodes.map((node) => node.id)),
  );
  const rawNodes = [
    ...canvas.nodes.filter(({ id }) => !compiledNodeIds.has(id)),
    ...(canvas.templates ?? []),
  ];
  rows.push(
    ...rawNodes.flatMap((node) =>
      isSimplifiedCanvasNode(canvas, node)
        ? simplifiedNodeReferences(context, node)
        : nodeReferences(
            { ...context, nodeId: node.id, nodeName: node.name },
            node,
            graphModulePorts(node, flows.get(node.flowId ?? ''))?.inputs ?? [],
          ),
    ),
  );
  // Drafts may keep endpoint bindings whose control path is temporarily incomplete.
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  for (const endpoint of canvas.endpoints) {
    if (flows.has(endpoint.startId)) continue;
    const start = byId.get(endpoint.startId);
    if (isSimplifiedCanvasNode(canvas, start)) continue;
    const end = byId.get(endpoint.endId);
    const boundNodes = Object.keys(endpoint.inputBindings ?? {}).flatMap((id) => {
      const node = byId.get(id);
      return node ? [node] : [];
    });
    const nodes = [
      ...new Set([start, ...boundNodes, end].filter((node): node is GraphNode => !!node)),
    ];
    rows.push(
      ...flowReferences(
        context,
        {
          ...endpoint,
          id: endpoint.startId,
          name: start?.name ?? endpoint.startId,
          nodes,
          edges: [],
        },
        flows,
      ),
    );
  }
  return rows;
}

function startFields(definition: GraphDefinition | undefined, flowId: string) {
  const flow = definition?.flows?.find(({ id }) => id === flowId);
  const artifact = simplifiedTriggerArtifactInput(flow);
  return artifact ? [artifact] : (flow?.nodes.find(({ type }) => type === 'START')?.inputs ?? []);
}

export function graphTriggerReferences(
  definition: GraphDefinition,
  source: { sourceId: string; version: number; flowId: string; label?: string },
  config: unknown,
) {
  const context = {
    ...source,
    sourceKind: 'TRIGGER',
    state: 'RUNNABLE',
    triggerId: source.sourceId,
  } as const;
  const record = objectValue(config);
  const mapping = objectValue(record.parameterMappings);
  const flows = new Map((definition.flows ?? []).map((flow) => [flow.id, flow]));
  const selected = new Set<string>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    for (const node of flows.get(id)?.nodes ?? [])
      if (node.type === 'FLOW_CALL' && node.flowId) visit(node.flowId);
  };
  visit(source.flowId);
  return [
    ...referenceRows({ ...context, fieldId: 'repositoryId' }, 'REPOSITORY', record.repositoryId),
    ...referenceRows({ ...context, fieldId: 'credentialId' }, 'CREDENTIAL', record.credentialId),
    ...startFields(definition, source.flowId).flatMap((field) => {
      const entry = objectValue(mapping[field.id]);
      return entry.source === 'VALUE' ? fieldReferences(context, field, entry.value) : [];
    }),
    ...[...selected].flatMap((id) => {
      const flow = flows.get(id);
      return flow ? flowReferences(context, flow, flows) : [];
    }),
  ];
}

function credentialReferences(source: ReferenceSource, values: unknown) {
  return referenceRows(
    source,
    'CREDENTIAL',
    Object.values(objectValue(objectValue(values).secretVariables)),
  );
}

function preparedNodeReferences(
  source: ReferenceSource,
  value: unknown,
  deploy = false,
): ProjectResourceReference[] {
  const plan = objectValue(value);
  const target = objectValue(plan.targetInputs);
  const resolution = objectValue(plan.configuration);
  const checkout = objectValue(plan.source);
  const profile = objectValue(plan.profile);
  const definition = objectValue(profile.definition);
  const readsRepository =
    source.state === 'HISTORY' ||
    !(
      deploy ||
      plan.type === 'DEPLOY_ARTIFACT' ||
      plan.type === 'ROLLBACK_ARTIFACT' ||
      (Array.isArray(plan.artifactIds) && plan.artifactIds.length > 0)
    );
  const context = {
    ...source,
    nodeId: idValue(plan.nodeId) ?? source.nodeId,
    serviceId: idValue(plan.serviceId) ?? source.serviceId,
    environmentId: idValue(plan.environmentId) ?? source.environmentId,
  };
  return [
    ...selectionReferences(context, plan),
    ...selectionReferences(context, plan.targetSelection),
    ...selectionReferences(context, { groupIds: target.groupIds, targetId: target.targetId }),
    ...selectionReferences(context, {
      ...objectValue(resolution.targetSelection),
      targetId: resolution.legacyTargetId,
    }),
    ...referenceRows(
      { ...context, serverNameSnapshot: idValue(plan.serverName) },
      'SERVER',
      plan.serverId,
    ),
    ...referenceRows(context, 'SERVICE', plan.serviceId),
    ...referenceRows(context, 'ENVIRONMENT', plan.environmentId),
    ...referenceRows(context, 'REPOSITORY', objectValue(plan.environmentFile).repositoryId),
    ...referenceRows(
      context,
      'REPOSITORY',
      objectValue(objectValue(profile.delivery).composeSource).repositoryId,
    ),
    ...referenceRows(context, 'ARTIFACT', plan.artifactIds),
    ...referenceRows(context, 'ARTIFACT', objectValue(plan.artifact).instances),
    ...referenceRows(context, 'REGISTRY', definition.registryId),
    ...(readsRepository
      ? [
          ...referenceRows(context, 'REPOSITORY', checkout.repositoryId ?? definition.repositoryId),
          ...referenceRows(context, 'CREDENTIAL', objectValue(checkout.access).credential_id),
          ...samples(plan.sourceSnapshot).flatMap((item) =>
            referenceRows(context, 'REPOSITORY', objectValue(item).repositoryId),
          ),
        ]
      : []),
    ...credentialReferences(context, plan.environment),
    ...credentialReferences(context, profile.graphVariables),
    ...samples(plan.alternatives)
      .filter(Boolean)
      .flatMap((alternative) => preparedNodeReferences(context, alternative, deploy)),
  ];
}

export function runResourceReferences(
  definition: GraphDefinition | undefined,
  source: {
    sourceId: string;
    state: ProjectResourceState;
    version: number;
    flowId: string;
    label?: string;
  },
  snapshot: unknown,
) {
  const root = { ...source, sourceKind: 'RUN', runId: source.sourceId } as const;
  const read = (source: ReferenceSource, value: unknown): ProjectResourceReference[] => {
    const prepared = objectValue(value);
    const simplified = objectValue(prepared.simplified);
    const release = objectValue(simplified.release);
    const workspaceSource = objectValue(simplified.workspaceSource);
    const executionServer = objectValue(objectValue(simplified.placement).target);
    const inputs = objectValue(prepared.inputs);
    const parameters = objectValue(inputs.parameters);
    const lookup = definition?.flows?.find((flow) => flow.id === source.flowId);
    const fields = startFields(definition, source.flowId ?? '');
    const scopedInput = (type: ScopedType) => {
      const field = singleScopedField(fields, type);
      return field ? idValue(parameters[field.id]) : undefined;
    };
    const context = {
      ...source,
      flowName: lookup?.name,
      serviceId: lookup?.serviceId ?? scopedInput('SERVICE') ?? source.serviceId,
      environmentId:
        scopedInput('ENVIRONMENT') ?? idValue(inputs.environmentId) ?? source.environmentId,
    };
    return [
      ...selectionReferences(context, inputs),
      ...referenceRows(context, 'ENVIRONMENT', inputs.environmentId),
      ...referenceRows(context, 'ENVIRONMENT_SET', prepared.environmentSet),
      ...referenceRows(context, 'CREDENTIAL', Object.keys(objectValue(prepared.credentials))),
      ...credentialReferences(context, prepared.frozenEnvironment),
      ...referenceRows(context, 'ARTIFACT', inputs.artifactIds),
      ...referenceRows(context, 'ARTIFACT', release.artifactId),
      ...referenceRows(
        { ...context, fieldId: 'workspaceArtifactId' },
        'ARTIFACT',
        workspaceSource.artifactId,
      ),
      ...referenceRows(context, 'SERVICE', simplified.serviceId),
      ...selectionReferences(context, simplified.buildSelection),
      ...selectionReferences(context, release.targets),
      ...referenceRows(context, 'SERVER', [
        executionServer.id,
        workspaceSource.serverId,
        ...samples(release.serverIds),
      ]),
      ...referenceRows(context, 'CREDENTIAL', executionServer.credentialId),
      ...samples(simplified.sources).flatMap((entry) => {
        const checkout = objectValue(objectValue(entry).source);
        return [
          ...referenceRows(context, 'REPOSITORY', checkout.repositoryId),
          ...referenceRows(context, 'CREDENTIAL', objectValue(checkout.access).credential_id),
        ];
      }),
      ...(context.state === 'HISTORY'
        ? referenceRows(context, 'REPOSITORY', objectValue(prepared.trigger).repositoryId)
        : []),
      ...fields.flatMap((field) => fieldReferences(context, field, parameters[field.id])),
      ...Object.entries(objectValue(prepared.plans ?? prepared.deliveries)).flatMap(
        ([key, plan]) => {
          const nodeId = key.slice(key.lastIndexOf(':') + 1);
          return preparedNodeReferences(
            { ...context, nodeId },
            plan,
            lookup?.nodes.some(
              (node) =>
                node.id === nodeId &&
                (node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT'),
            ),
          );
        },
      ),
      ...Object.entries(objectValue(prepared.children)).flatMap(([id, child]) => {
        const calledFlow = lookup?.nodes.find((node) => node.id === id)?.flowId;
        return read({ ...context, flowId: calledFlow }, child);
      }),
    ];
  };
  return read(root, snapshot);
}

export function taskPayloadResourceReferences(source: ReferenceSource, payload: TaskPayload) {
  const pipeline = payload.pipeline;
  const module = payload.graphModule;
  const readsRepository = source.state === 'HISTORY' || pipeline?.mode !== 'DEPLOY_ARTIFACT';
  return [
    ...(payload.targets ?? []).flatMap((target) => [
      ...referenceRows(
        {
          ...source,
          serverNameSnapshot: target.name,
          hostSnapshot: target.host,
          portSnapshot: target.port,
        },
        'SERVER',
        target.id,
      ),
      ...referenceRows(source, 'CREDENTIAL', target.credentialId),
    ]),
    ...selectionReferences(source, {
      groupIds: pipeline?.targetSelection?.groupIds,
      targetId: pipeline?.targetId,
    }),
    ...referenceRows(source, 'SERVER', pipeline?.targetMemberIds),
    ...(readsRepository
      ? [
          ...referenceRows(source, 'REPOSITORY', [
            pipeline?.definition?.repositoryId,
            module?.source?.repositoryId,
            module?.workspace?.repositoryId,
            module?.environmentFile?.repositoryId,
            module?.variables?.environmentFile?.repositoryId,
            pipeline?.graph?.variables?.environmentFile?.repositoryId,
            ...(pipeline?.artifactSources ?? []).map(({ repositoryId }) => repositoryId),
            ...(pipeline?.definition?.nodes ?? []).map(({ repositoryId }) => repositoryId),
          ]),
          ...referenceRows(source, 'CREDENTIAL', [
            pipeline?.repository?.credentialId,
            module?.source?.access?.credential_id,
            ...Object.values(pipeline?.nodeSources ?? {}).map(({ credentialId }) => credentialId),
          ]),
          ...(pipeline?.definition?.nodes ?? []).flatMap((node) =>
            referenceRows(
              source,
              'CREDENTIAL',
              (node.variables ?? []).map(({ credentialId }) => credentialId),
            ),
          ),
        ]
      : []),
    ...referenceRows(source, 'ARTIFACT', pipeline?.deploymentArtifacts),
    ...referenceRows(source, 'REGISTRY', pipeline?.definition?.registryId),
    ...referenceRows(source, 'CREDENTIAL', pipeline?.registry?.credentialId),
    ...credentialReferences(source, pipeline),
    ...credentialReferences(source, payload.environment),
    ...credentialReferences(source, module?.shell?.parameters),
  ];
}
