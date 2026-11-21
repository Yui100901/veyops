import type { ProjectDetail } from '../models';
import { isReleaseNode } from './execution-graph-definition';
import type { GraphBinding, GraphField, GraphFlow, GraphNode } from './execution-graph-definition';
import type { DeliveryScope, DeliveryTab } from './delivery-route';

const resourcePanels = [
  'settings',
  'servers',
  'variables',
  'reviews',
  'failure',
  'compose',
  'repositories',
  'file',
  'targets',
] as const;

export type GraphWorkbenchScope = {
  serviceId?: string;
  environmentId?: string;
  view?: string;
  viewSearch?: string;
  resourcePanel?: (typeof resourcePanels)[number];
};
export type GraphPane = 'run' | 'draft' | 'published' | 'history' | 'migration';
export type GraphStartLocation = GraphWorkbenchScope & {
  start: string;
  version?: number;
  field?: string;
};
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
    field?: string;
    returnStart?: string;
    returnField?: string;
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

export function graphDraftSetupHref(
  projectId: string,
  origin: GraphStartLocation,
  editor: { node?: string; field?: string; flow?: string },
) {
  const { start, field, ...context } = origin;
  return (
    '#' +
    graphWorkbenchPath(projectId, {
      ...context,
      ...editor,
      pane: 'draft',
      returnStart: start,
      returnField: field,
    })
  );
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
type ScopeType = 'service' | 'environment';

export type GraphScopeMismatch = {
  status: 'CONTEXT_MISMATCH';
  reason: 'FIXED_SCOPE' | 'OPTION_NOT_ALLOWED' | 'SERVICE_NOT_DECLARED' | 'AMBIGUOUS_SCOPE';
  scopeType: ScopeType;
  contextId: string;
  fieldId?: string;
  fixedIds?: string[];
};

const resourceKinds = {
  REPOSITORY: 'repositories',
  SERVICE: 'services',
  ENVIRONMENT: 'environments',
} as const;
type ResourceType = keyof typeof resourceKinds;
type ReadinessProject = Pick<ProjectDetail, (typeof resourceKinds)[ResourceType]>;
export type GraphStartConfigurationIssue = {
  reason: 'NO_AVAILABLE_OPTIONS' | 'RESOURCE_UNAVAILABLE';
  nodeId?: string;
  fieldId?: string;
  fieldName?: string;
  resourceType?: ResourceType;
  resourceId?: string;
};
type GraphStartInputs = {
  parameters: Record<string, string>;
  missingFields: GraphField[];
  scopeNotice?: GraphScopeMismatch;
};
export type GraphStartReadiness =
  | (GraphStartInputs & { status: 'READY_TO_PREVIEW' | 'NEEDS_INPUT' })
  | (GraphStartInputs & { status: 'NEEDS_CONFIGURATION'; issues: GraphStartConfigurationIssue[] })
  | GraphScopeMismatch;

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
  if (binding.value && typeof binding.value === 'object' && 'serviceId' in binding.value)
    return typeof binding.value.serviceId === 'string' ? binding.value.serviceId : dynamicBinding;
  if (binding.value && typeof binding.value === 'object' && 'id' in binding.value)
    return typeof binding.value.id === 'string' ? binding.value.id : dynamicBinding;
  return binding.value == null || (Array.isArray(binding.value) && !binding.value.length)
    ? undefined
    : dynamicBinding;
}

function knownRepository(node: GraphNode, bindings?: Record<string, GraphBinding>) {
  if (bindings?.repository) return knownReference(bindings.repository);
  if (node.type === 'CHECKOUT') return node.checkout?.repositoryId;
  if (!bindings?.source && !bindings?.workspace) return node.build?.repositoryId;
}

function scopeBinding(flow: GraphFlow, port: ScopeType) {
  const inputs = flow.nodes.find(({ type }) => type === 'START')?.inputs ?? [];
  const type = port === 'service' ? 'SERVICE' : 'ENVIRONMENT';
  const fields = inputs.filter((input) => input.type === type && !input.multiple);
  const fixed = new Set<string>();
  const directInputs = new Set<string>();
  let dynamic = false;
  if (port === 'service' && flow.serviceId) fixed.add(flow.serviceId);
  for (const node of flow.nodes) {
    if (node.type === 'FLOW_CALL') continue;
    const binding = flow.inputBindings?.[node.id]?.[port];
    if (!binding) continue;
    const reference = knownReference(binding);
    if (typeof reference === 'string') fixed.add(reference);
    if (reference === dynamicBinding) dynamic = true;
    if (binding.kind === 'INPUT') directInputs.add(binding.fieldId);
  }
  const bound = fields.filter(({ id }) => directInputs.has(id));
  const field = bound.length === 1 ? bound[0] : fields.length === 1 ? fields[0] : undefined;
  return { field, fixed, ambiguous: !field && (fields.length > 1 || dynamic) };
}

function inspectGraphScope(
  flow: GraphFlow,
  scope: GraphWorkbenchScope,
): { parameters: Record<string, string>; uncertain?: GraphScopeMismatch } | GraphScopeMismatch {
  const parameters: Record<string, string> = {};
  let uncertain: GraphScopeMismatch | undefined;
  for (const [port, id] of [
    ['service', scope.serviceId],
    ['environment', scope.environmentId],
  ] as const) {
    if (!id) continue;
    const { fixed, field, ambiguous } = scopeBinding(flow, port);
    const context = { status: 'CONTEXT_MISMATCH' as const, scopeType: port, contextId: id };
    if ([...fixed].some((value) => value !== id))
      return { ...context, reason: 'FIXED_SCOPE', fixedIds: [...fixed] };
    if (field?.options && !field.options.includes(id))
      return { ...context, reason: 'OPTION_NOT_ALLOWED', fieldId: field.id };
    if (port === 'service' && !fixed.size && !field)
      return { ...context, reason: ambiguous ? 'AMBIGUOUS_SCOPE' : 'SERVICE_NOT_DECLARED' };
    if (ambiguous && !fixed.size && !uncertain)
      uncertain = { ...context, reason: 'AMBIGUOUS_SCOPE' };
    if (field) parameters[field.id] = id;
  }
  return { parameters, uncertain };
}

function isResourceType(type: GraphField['type']): type is ResourceType {
  return Object.hasOwn(resourceKinds, type);
}

/** Describe only conditions visible before preview fixes the actual execution plan. */
export function graphStartReadiness(
  flow: GraphFlow,
  scope: GraphWorkbenchScope,
  project?: ReadinessProject,
  inputs?: Readonly<Record<string, unknown>>,
): GraphStartReadiness {
  const result = inspectGraphScope(flow, scope);
  if (!('parameters' in result)) return result;

  const { parameters } = result;
  const start = flow.nodes.find(({ type }) => type === 'START');
  const issues: GraphStartConfigurationIssue[] = [];
  const missingFields: GraphField[] = [];
  for (const field of start?.inputs ?? []) {
    const { id, name, type } = field;
    const resourceType = isResourceType(type) ? type : undefined;
    const resources = project && resourceType ? project[resourceKinds[resourceType]] : undefined;
    const options = field.options;
    const hasOptions = resources
      ? resources.some((resource) => !options || options.includes(resource.id))
      : options?.length !== 0;
    const hasContextValue = Object.hasOwn(parameters, id);
    const value = hasContextValue
      ? parameters[id]
      : inputs && Object.hasOwn(inputs, id)
        ? inputs[id]
        : field.defaultValue;
    const missing =
      value == null ||
      (value === '' && type !== 'TEXT') ||
      (Array.isArray(value) && value.length === 0);
    const selections = field.multiple && Array.isArray(value) ? value : [value];
    const invalidResource =
      resourceType &&
      !missing &&
      ((field.multiple && !Array.isArray(value)) ||
        selections.some((selected) => {
          const reference =
            type === 'SERVICE' &&
            selected &&
            typeof selected === 'object' &&
            'serviceId' in selected
              ? selected.serviceId
              : selected;
          return (
            typeof reference !== 'string' ||
            (options && !options.includes(reference)) ||
            (resources && !resources.some((resource) => resource.id === reference))
          );
        }));
    if (!hasOptions && (field.required !== false || invalidResource)) {
      issues.push({
        reason: 'NO_AVAILABLE_OPTIONS',
        nodeId: start?.id,
        fieldId: id,
        fieldName: name,
        resourceType,
      });
    } else if (invalidResource && hasContextValue) {
      issues.push({
        reason: 'RESOURCE_UNAVAILABLE',
        nodeId: start?.id,
        fieldId: id,
        fieldName: name,
        resourceType,
        resourceId: parameters[id],
      });
    } else if (invalidResource || (missing && field.required !== false && !field.selection)) {
      missingFields.push(field);
    }
  }

  if (project) {
    const checkFixed = (
      resourceType: ResourceType,
      resourceId?: string,
      nodeId?: string,
      fieldId?: string,
    ) => {
      if (resourceId && !project[resourceKinds[resourceType]].some(({ id }) => id === resourceId))
        issues.push({ reason: 'RESOURCE_UNAVAILABLE', nodeId, fieldId, resourceType, resourceId });
    };
    checkFixed('SERVICE', flow.serviceId, start?.id);
    // Conditional branches and upstream outputs are resolved by preview.
    if (!flow.edges.some(({ when }) => when)) {
      for (const node of flow.nodes) {
        const bindings = flow.inputBindings?.[node.id];
        if (node.type === 'CHECKOUT' || node.type === 'BUILD') {
          const repositoryId = knownRepository(node, bindings);
          if (typeof repositoryId === 'string')
            checkFixed('REPOSITORY', repositoryId, node.id, 'repository');
        }
        const composeSource = node.deploy?.composeSource;
        if (isReleaseNode(node) && composeSource?.kind === 'REPOSITORY_FILE')
          checkFixed('REPOSITORY', composeSource.repositoryId, node.id, 'composeSource');
        if (node.type === 'BUILD' || isReleaseNode(node) || node.type === 'LOAD_ENV') {
          const service = bindings?.service && knownReference(bindings.service);
          const environment = bindings?.environment && knownReference(bindings.environment);
          if (node.type !== 'LOAD_ENV' && typeof service === 'string')
            checkFixed('SERVICE', service, node.id, 'service');
          if (typeof environment === 'string')
            checkFixed('ENVIRONMENT', environment, node.id, 'environment');
        }
      }
    }
  }

  const resolved = { parameters, missingFields, scopeNotice: result.uncertain };
  if (issues.length) return { status: 'NEEDS_CONFIGURATION', ...resolved, issues };
  return { status: missingFields.length ? 'NEEDS_INPUT' : 'READY_TO_PREVIEW', ...resolved };
}
