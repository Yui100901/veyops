import type { GraphBinding, GraphFlow } from './execution-graph-definition';
import type { DeliveryScope, DeliveryTab } from './delivery-route';

const resourcePanels = ['settings', 'servers', 'variables', 'reviews', 'failure'] as const;

export type GraphWorkbenchScope = {
  serviceId?: string;
  environmentId?: string;
  view?: string;
  resourcePanel?: (typeof resourcePanels)[number];
};
export type GraphPane = 'run' | 'draft' | 'published' | 'history' | 'migration';
export type GraphDeliveryReturn = Pick<
  DeliveryScope,
  'recordId' | 'commit' | 'repositoryId' | 'pipelineRunId' | 'taskId'
> & { deliveryTab: DeliveryTab };

type GraphLocation = GraphWorkbenchScope &
  Partial<GraphDeliveryReturn> & {
    pane?: GraphPane;
    start?: string;
    run?: string;
    version?: number;
    node?: string;
    flow?: string;
  };

function queryPath(path: string, query: Record<string, string | number | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) params.set(key, String(value));
  return path + (params.size ? '?' + params : '');
}

export function graphWorkbenchPath(projectId: string, location: GraphLocation = {}) {
  return queryPath(`/projects/${encodeURIComponent(projectId)}/execution-graph`, location);
}

export function graphStartHref(
  projectId: string,
  startId: string,
  scope: GraphWorkbenchScope = {},
) {
  return '#' + graphWorkbenchPath(projectId, { ...scope, start: startId });
}

export function graphRunHref(
  projectId: string,
  runId: string,
  scope: GraphWorkbenchScope = {},
  delivery?: GraphDeliveryReturn,
) {
  return '#' + graphWorkbenchPath(projectId, { ...scope, ...delivery, run: runId });
}

export function graphReturnDelivery(params: URLSearchParams): GraphDeliveryReturn | undefined {
  const deliveryTab = params.get('deliveryTab');
  if (deliveryTab !== 'artifacts' && deliveryTab !== 'deployments' && deliveryTab !== 'approvals')
    return undefined;
  return {
    deliveryTab,
    recordId: params.get('recordId'),
    commit: params.get('commit'),
    repositoryId: params.get('repositoryId'),
    pipelineRunId: params.get('pipelineRunId'),
    taskId: params.get('taskId'),
  };
}

export function graphScopeBackHref(projectId: string, scope: GraphWorkbenchScope) {
  const { resourcePanel, ...context } = scope;
  return (
    '#' +
    queryPath(`/projects/${encodeURIComponent(projectId)}`, {
      resource: scope.serviceId ? 'services' : 'environments',
      ...context,
      panel: resourcePanel,
    })
  );
}

export function graphResourcePanel(value: string | null | undefined) {
  return resourcePanels.find((panel) => panel === value);
}

const dynamicBinding = Symbol();

function knownReference(binding: GraphBinding): string | undefined | typeof dynamicBinding {
  if (binding.kind === 'FIRST_AVAILABLE') {
    for (const source of binding.sources) {
      const ref = knownReference(source);
      if (ref !== undefined) return ref;
    }
    return undefined;
  }
  if (binding.kind !== 'VALUE') return dynamicBinding;
  if (typeof binding.value === 'string') return binding.value;
  if (binding.value && typeof binding.value === 'object' && 'id' in binding.value)
    return typeof binding.value.id === 'string' ? binding.value.id : dynamicBinding;
  return binding.value == null || (Array.isArray(binding.value) && !binding.value.length)
    ? undefined
    : dynamicBinding;
}

function scopeBinding(flow: GraphFlow, port: 'service' | 'environment') {
  const inputs = flow.nodes.find(({ type }) => type === 'START')?.inputs ?? [];
  const type = port === 'service' ? 'SERVICE' : 'ENVIRONMENT';
  const fields = inputs.filter((input) => input.type === type && !input.multiple);
  const fixed = new Set<string>();
  const directInputs = new Set<string>();
  if (port === 'service' && flow.serviceId) fixed.add(flow.serviceId);
  for (const node of flow.nodes) {
    if (node.type === 'FLOW_CALL') continue;
    const binding = flow.inputBindings?.[node.id]?.[port];
    if (!binding) continue;
    const reference = knownReference(binding);
    if (typeof reference === 'string') fixed.add(reference);
    if (binding.kind === 'INPUT') directInputs.add(binding.fieldId);
  }
  const bound = fields.filter(({ id }) => directInputs.has(id));
  const field = bound.length === 1 ? bound[0] : fields.length === 1 ? fields[0] : undefined;
  return { field, fixed };
}

/** Select a start that can consume this scope. Only declared scalar input fields receive context. */
export function graphFlowScope(flow: GraphFlow, scope: GraphWorkbenchScope) {
  const parameters: Record<string, string> = {};
  for (const [port, id] of [
    ['service', scope.serviceId],
    ['environment', scope.environmentId],
  ] as const) {
    if (!id) continue;
    const { fixed, field } = scopeBinding(flow, port);
    if (
      [...fixed].some((value) => value !== id) ||
      (field?.options && !field.options.includes(id)) ||
      (port === 'service' && !fixed.size && !field)
    )
      return undefined;
    if (field) parameters[field.id] = id;
  }
  return parameters;
}

export function flowMatchesScope(flow: GraphFlow, scope: GraphWorkbenchScope) {
  return graphFlowScope(flow, scope) !== undefined;
}
