import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
import type { ExecutionVariables } from '../../infrastructure/execution-variables';
import { isUUID } from 'class-validator';
import type { FrozenEnvironmentSet } from '../projects/environment-sets.service';
import type { GraphVariableSource } from './graph-environment';
import type { GraphFlow, GraphNode } from './execution-graph-definition';
import { graphInputIssue } from './graph-execution-plan-issues';
import {
  graphDefaultBinding,
  graphModulePorts,
  graphNodeEnvironmentBindings,
  graphRecord,
  validateGraphValue,
  type GraphBinding,
  type GraphField,
} from './graph-fields';
import type { GraphInputsDto } from './graph-runner.controller';
import { redactTaskLog } from '../tasks/task-log.service';
import { graphScalarProjection } from './graph-scalar-projection';

export type Values = Record<string, unknown>;

export interface GraphBindingContext {
  parameters?: Values;
  outputs?: ReadonlyMap<string, Values>;
  context: Values;
  environmentSet?: FrozenEnvironmentSet;
  parameterSources?: Record<string, GraphFieldSource>;
  pendingArtifacts?: ReadonlySet<string>;
  nodeInputs?: Values;
  nodeInputFields?: readonly GraphField[];
  nodeInputEvidence?: readonly GraphFieldEvidence[];
  producerStatus?: (nodeId: string) => string | undefined;
  credentialNonces?: Readonly<Record<string, string>>;
  executionServerId?: string;
}

export interface GraphFieldSource {
  kind: string;
  nodeId?: string;
  fieldId?: string;
  key?: string;
  eventField?: string;
  transform?: 'BRANCH' | 'TAG';
}

export interface GraphFieldEvidence {
  fieldId: string;
  name: string;
  type: GraphField['type'];
  state: 'RESOLVED' | 'DEFERRED' | 'OMITTED' | 'DEFAULTED' | 'ERROR';
  source?: GraphFieldSource;
  onMissing?: string;
  value?: unknown;
  sensitive?: boolean;
  message?: string;
}

type BindingRead = {
  state: 'VALUE' | 'DEFERRED' | 'MISSING' | 'INVALID';
  source?: GraphFieldSource;
  value?: unknown;
  credentialId?: string;
  nonce?: string;
  message?: string;
};

export interface GraphBindingOptions {
  values: Pick<BindingRead, 'source' | 'value' | 'state'>[];
  missing: boolean;
}

export interface GitRefValue {
  kind: 'BRANCH' | 'TAG' | 'COMMIT';
  value: string;
}

export function flowStart(flow: GraphFlow) {
  return flow.nodes.find((node) => node.type === 'START')!;
}

export function flowEnd(flow: GraphFlow) {
  return flow.nodes.find((node) => node.type === 'END')!;
}

const entry = (values: Values | undefined, key: string) =>
  values && Object.hasOwn(values, key) ? values[key] : undefined;

export function bindingValue(
  binding: GraphBinding | undefined,
  state: GraphBindingContext,
): unknown {
  const result = readBinding(binding, state);
  return result.state === 'VALUE' && !result.credentialId ? result.value : undefined;
}

function readBinding(binding: GraphBinding | undefined, state: GraphBindingContext): BindingRead {
  if (!binding) return { state: 'MISSING' };
  const value = (result: unknown, source: GraphFieldSource): BindingRead =>
    result === undefined ? { state: 'MISSING', source } : { state: 'VALUE', value: result, source };
  switch (binding.kind) {
    case 'INPUT':
      if (state.pendingArtifacts?.has(binding.fieldId))
        return { state: 'DEFERRED', source: { kind: 'INPUT', fieldId: binding.fieldId } };
      return value(entry(state.parameters, binding.fieldId), {
        kind: 'INPUT',
        fieldId: binding.fieldId,
        ...state.parameterSources?.[binding.fieldId],
      });
    case 'NODE_INPUT': {
      const source = { kind: 'NODE_INPUT', fieldId: binding.fieldId };
      const resolved = entry(state.nodeInputs, binding.fieldId);
      const pending = state.nodeInputEvidence?.find(({ fieldId }) => fieldId === binding.fieldId);
      if (pending?.state === 'DEFERRED')
        return { state: 'DEFERRED', source: pending.source ?? source };
      if (pending?.state === 'ERROR') return { state: 'INVALID', source, message: pending.message };
      return typeof resolved === 'string' &&
        state.nodeInputFields?.some(
          ({ id, type }) => id === binding.fieldId && type === 'CREDENTIAL',
        )
        ? { state: 'VALUE', credentialId: resolved, source }
        : value(resolved, source);
    }
    case 'OUTPUT': {
      const source = { kind: 'OUTPUT', nodeId: binding.nodeId, fieldId: binding.fieldId };
      const status = state.producerStatus?.(binding.nodeId);
      const resolved = entry(state.outputs?.get(binding.nodeId), binding.fieldId);
      if (resolved !== undefined) return value(resolved, source);
      if (status === 'SUCCESS' || status === 'SKIPPED') return { state: 'MISSING', source };
      if (status && !['PENDING', 'QUEUED', 'WAITING', 'RUNNING'].includes(status))
        return { state: 'INVALID', source, message: '结果来源未成功完成' };
      return { state: 'DEFERRED', source };
    }
    case 'CONTEXT':
      if (binding.fieldId === 'triggeredAt' && entry(state.context, binding.fieldId) === undefined)
        return { state: 'DEFERRED', source: { kind: 'CONTEXT', fieldId: binding.fieldId } };
      return value(entry(state.context, binding.fieldId), {
        kind: 'CONTEXT',
        fieldId: binding.fieldId,
      });
    case 'VALUE':
      return value(binding.value, { kind: 'VALUE' });
    case 'ENVIRONMENT_KEY': {
      const source = { kind: 'ENVIRONMENT_KEY', key: binding.key };
      const id = entry(state.environmentSet?.secretVariables, binding.key);
      return typeof id === 'string'
        ? {
            state: 'VALUE',
            source,
            credentialId: id,
            nonce: state.environmentSet?.secretCredentialNonces[binding.key],
          }
        : value(entry(state.environmentSet?.variables, binding.key), source);
    }
    case 'CREDENTIAL':
      return { state: 'VALUE', credentialId: binding.credentialId, source: { kind: 'CREDENTIAL' } };
    case 'AS_GIT_REF': {
      const original = readBinding(binding.source, state);
      const source = {
        ...original.source,
        kind: original.source?.kind ?? 'AS_GIT_REF',
        transform: binding.refKind,
      };
      if (original.state !== 'VALUE') return { ...original, source };
      if (typeof original.value !== 'string' || original.credentialId)
        return { state: 'INVALID', source, message: 'Git 版本转换需要普通文本' };
      return value({ kind: binding.refKind, value: original.value }, source);
    }
    case 'PROJECT_VALUE': {
      const original = readBinding(binding.source, state);
      if (original.state !== 'VALUE') return original;
      const scalar = graphScalarProjection(
        binding,
        original.value,
        state.nodeInputs?.workspace,
        state.executionServerId,
      );
      return scalar === undefined
        ? {
            state: 'INVALID',
            source: original.source,
            message: '请指定当前工作区或可在执行位置访问的唯一产物实例',
          }
        : value(scalar, original.source ?? { kind: 'OUTPUT' });
    }
    case 'FIRST_AVAILABLE': {
      let missing: BindingRead = { state: 'MISSING' };
      for (const candidate of binding.sources) {
        const result = readBinding(candidate, state);
        if (result.state !== 'MISSING') return result;
        missing = result;
      }
      return missing;
    }
  }
}

export function previewGraphBindingOptions(
  binding: GraphBinding | undefined,
  context: GraphBindingContext,
  active: ReadonlySet<string>,
  outputOptions: (nodeId: string, fieldId: string) => GraphBindingOptions | undefined,
  requiredOutput: (nodeId: string, fieldId: string) => boolean,
): GraphBindingOptions {
  if (binding?.kind === 'FIRST_AVAILABLE') {
    const values: GraphBindingOptions['values'] = [];
    for (const source of binding.sources) {
      const next = previewGraphBindingOptions(
        source,
        context,
        active,
        outputOptions,
        requiredOutput,
      );
      values.push(...next.values);
      if (!next.missing) return { values, missing: false };
    }
    return { values, missing: true };
  }
  if (binding?.kind === 'OUTPUT') {
    const { nodeId, fieldId } = binding;
    if (!active.has(nodeId)) return { values: [], missing: true };
    const options = outputOptions(nodeId, fieldId);
    if (options)
      return {
        values: options.values.map((entry) => ({
          ...entry,
          source: { kind: 'OUTPUT', nodeId, fieldId },
        })),
        missing: options.missing,
      };
  }
  const entry = readBinding(binding, {
    ...context,
    producerStatus: (nodeId) => (active.has(nodeId) ? context.producerStatus?.(nodeId) : 'SKIPPED'),
  });
  if (entry.state === 'MISSING') return { values: [], missing: true };
  return {
    values: entry.state === 'INVALID' ? [] : [entry],
    missing:
      entry.state === 'DEFERRED' &&
      binding?.kind === 'OUTPUT' &&
      !requiredOutput(binding.nodeId, binding.fieldId),
  };
}

function checkedBinding(
  field: GraphField,
  binding: GraphBinding | undefined,
  context: GraphBindingContext,
  environment = false,
): { evidence: GraphFieldEvidence; value?: unknown; credentialId?: string; nonce?: string } {
  const result = readBinding(binding, context);
  const evidence: GraphFieldEvidence = {
    fieldId: field.id,
    name: field.name,
    type: field.type,
    state: 'RESOLVED',
    source: result.source,
    onMissing: binding?.onMissing,
  };
  const fail = (message: string) => ({
    evidence: { ...evidence, state: 'ERROR' as const, message },
  });
  if (result.state === 'INVALID') return fail(result.message ?? '输入来源无效');
  if (result.state === 'DEFERRED') return { evidence: { ...evidence, state: 'DEFERRED' as const } };
  if (result.state === 'MISSING') {
    if (binding?.onMissing === 'ERROR') return fail('所选来源没有值');
    const defaultValue =
      !binding || binding.onMissing === 'USE_DEFAULT' ? field.defaultValue : undefined;
    if (defaultValue !== undefined && validateGraphValue(field, defaultValue)) {
      return {
        value: defaultValue,
        evidence: {
          ...evidence,
          state: 'DEFAULTED' as const,
          source: { kind: 'DEFAULT', fieldId: field.id },
          ...(field.type === 'CREDENTIAL'
            ? { sensitive: true }
            : { value: publicValue(field, defaultValue) }),
        },
      };
    }
    if (field.required !== false || binding?.onMissing === 'USE_DEFAULT')
      return fail('缺少必填值或可用默认值');
    return {
      evidence: {
        ...evidence,
        state: 'OMITTED' as const,
        message:
          binding?.onMissing === 'REPOSITORY_DEFAULT' ? '使用仓库默认版本' : '来源未提供可选值',
      },
    };
  }
  if (environment && result.credentialId)
    return {
      credentialId: result.credentialId,
      nonce: result.nonce ?? context.credentialNonces?.[result.credentialId],
      evidence: { ...evidence, type: 'CREDENTIAL' as const, sensitive: true },
    };
  const raw =
    field.type === 'ARTIFACT' && result.source?.kind === 'OUTPUT'
      ? fitArtifactCardinality(field, result.value)
      : result.value;
  if (
    result.credentialId ||
    raw === null ||
    (environment
      ? !['string', 'number', 'boolean'].includes(typeof raw) ||
        (typeof raw === 'string' && (raw.includes('\0') || raw.length > 65_536))
      : !validateGraphValue(field, raw) &&
        !field.acceptedTypes?.some((type) => validateGraphValue({ ...field, type }, raw)))
  )
    return fail('实际输入与端口类型或数量不匹配');
  return {
    value: raw,
    evidence: {
      ...evidence,
      ...(field.type === 'CREDENTIAL' ? { sensitive: true } : { value: publicValue(field, raw) }),
    },
  };
}

function publicValue(field: GraphField, value: unknown): unknown {
  if (field.type === 'CREDENTIAL' || field.type === 'VARIABLES') return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(redactTaskLog(encoded));
  } catch {
    return undefined;
  }
}

export function inspectNodeInputs(
  flow: GraphFlow,
  node: GraphNode,
  context: GraphBindingContext,
  calledFlow?: GraphFlow,
) {
  const compiled = flow.compiled?.nodes[node.id];
  const fields =
    compiled?.inputs ??
    (node.type === 'START' ? node.inputs : graphModulePorts(node, calledFlow)?.inputs) ??
    [];
  const values: Values = Object.create(null);
  const evidence = fields.map((field) => {
    const binding: GraphBinding | undefined =
      node.type === 'START'
        ? {
            kind: 'INPUT',
            fieldId: field.id,
            onMissing: field.defaultValue === undefined ? undefined : 'USE_DEFAULT',
          }
        : nodeInputBinding(flow, node, field.id);
    const usesDeclaredDefault =
      binding?.kind === 'VALUE' &&
      node.declaredPorts &&
      node.inputs?.some(({ id }) => id === field.id) &&
      field.defaultValue !== undefined &&
      !flow.inputBindings?.[node.id]?.[field.id];
    const read = checkedBinding(field, usesDeclaredDefault ? undefined : binding, context);
    if (read.value !== undefined) values[field.id] = read.value;
    return read.evidence;
  });
  return { fields, values, evidence };
}

export function nodeInputBinding(flow: GraphFlow, node: GraphNode, fieldId: string) {
  const bindings = flow.compiled?.nodes[node.id]?.inputBindings ?? flow.inputBindings?.[node.id];
  return bindings?.[fieldId] ?? graphDefaultBinding(flow, node, fieldId);
}

export function inspectDeclaredNodeOutputs(
  node: GraphNode,
  output: unknown,
  effective = graphModulePorts(node)?.outputs,
): GraphFieldEvidence[] {
  if (!node.declaredPorts || !node.outputs) return [];
  const values = graphRecord(output) ? output : undefined;
  return node.outputs.map((declared) => {
    const field = effective?.find(({ id }) => id === declared.id) ?? declared;
    const raw = entry(values, field.id);
    const value = field.type === 'ARTIFACT' ? fitArtifactCardinality(field, raw) : raw;
    return checkedBinding(
      { ...field, defaultValue: undefined },
      value === undefined ? undefined : { kind: 'VALUE', value },
      { context: {} },
    ).evidence;
  });
}

export function inspectNodeEnvironment(
  flow: GraphFlow,
  node: GraphNode,
  context: GraphBindingContext,
) {
  const variables: ExecutionVariables = {
    variables: Object.create(null),
    secretVariables: Object.create(null),
    secretCredentialNonces: Object.create(null),
  };
  const sources: GraphVariableSource[] = [];
  const bindings =
    flow.compiled?.nodes[node.id]?.environmentBindings ?? graphNodeEnvironmentBindings(flow, node);
  const evidence = Object.entries(bindings).map(([key, binding]) => {
    const read = checkedBinding(
      { id: key, name: key, type: 'TEXT', required: false },
      binding,
      context,
      true,
    );
    if (read.credentialId) {
      variables.secretVariables[key] = read.credentialId;
      if (read.nonce) variables.secretCredentialNonces![key] = read.nonce;
    } else if (read.value !== undefined) {
      variables.variables[key] = String(read.value);
    }
    if (read.credentialId || read.value !== undefined)
      sources.push({ key, source: 'NODE', isSecret: Boolean(read.credentialId) });
    return read.evidence;
  });
  return { variables, sources, evidence };
}

export function directEnvironmentCredentials(flow: GraphFlow, node: GraphNode) {
  const read = (binding: GraphBinding): string[] => {
    if (binding.kind === 'CREDENTIAL') return [binding.credentialId];
    if (binding.kind === 'FIRST_AVAILABLE') return binding.sources.flatMap(read);
    return [];
  };
  return Object.values(flow.environmentBindings?.[node.id] ?? {}).flatMap(read);
}

export function publicParameters(flow: GraphFlow, inputs?: Values) {
  return Object.fromEntries(
    (flowStart(flow).inputs ?? []).flatMap((field) =>
      entry(inputs, field.id) === undefined
        ? []
        : [
            [
              field.id,
              field.type === 'CREDENTIAL' ? '[REDACTED]' : publicValue(field, inputs![field.id]),
            ],
          ],
    ),
  );
}

export function startParameterSources(
  flow: GraphFlow,
  supplied?: Values,
  trusted?: Values,
): Record<string, GraphFieldSource> {
  return Object.fromEntries(
    (flowStart(flow).inputs ?? []).map((field) => {
      const source = entry(trusted, field.id) as GraphFieldSource | undefined;
      return [
        field.id,
        source ?? {
          kind: entry(supplied, field.id) === undefined ? 'DEFAULT' : 'INPUT',
        },
      ];
    }),
  );
}

export function outputSources(binding?: GraphBinding): { nodeId: string; fieldId: string }[] {
  if (binding?.kind === 'OUTPUT') return [{ nodeId: binding.nodeId, fieldId: binding.fieldId }];
  if (binding?.kind === 'FIRST_AVAILABLE') return binding.sources.flatMap(outputSources);
  if (binding?.kind === 'AS_GIT_REF') return outputSources(binding.source);
  if (binding?.kind === 'PROJECT_VALUE') return outputSources(binding.source);
  return [];
}

export function checkedParameters(
  flow: GraphFlow,
  supplied?: Values,
  allowArtifactRule = false,
  pendingArtifacts?: ReadonlySet<string>,
) {
  const fields = flowStart(flow).inputs ?? [];
  if (supplied && (Object.keys(supplied).length > 64 || JSON.stringify(supplied).length > 65_536))
    throw graphInputIssue(flow, '运行参数过大');
  for (const id of Object.keys(supplied ?? {}))
    if (!fields.some((field) => field.id === id))
      throw graphInputIssue(flow, `未声明运行参数 ${id}`);
  return Object.fromEntries(
    fields.flatMap((field) => {
      const actual = entry(supplied, field.id);
      if (actual === undefined && field.type === 'ARTIFACT' && pendingArtifacts?.has(field.id))
        return [];
      const value = actual === undefined ? field.defaultValue : actual;
      if (value === undefined && allowArtifactRule && field.selection === 'LATEST_COMPATIBLE')
        return [];
      if (value === null || !validateGraphValue(field, value))
        throw graphInputIssue(
          flow,
          `运行参数「${field.name}」缺失或不符合 ${field.type} 约束`,
          field,
        );
      if (value !== undefined && redactTaskLog(JSON.stringify(value)) !== JSON.stringify(value))
        throw graphInputIssue(flow, `运行参数「${field.name}」含明文凭据，请使用凭据引用`, field);
      return value === undefined ? [] : [[field.id, value]];
    }),
  );
}

/** Validate the caller's overrides before resolving defaults or frozen run parameters. */
export function assertRuntimeParameterOverrides(flow: GraphFlow, supplied?: Values) {
  for (const field of flowStart(flow).inputs ?? [])
    if (field.runtimeOverride === false && Object.hasOwn(supplied ?? {}, field.id))
      throw graphInputIssue(
        flow,
        '开始参数「' + field.name + '」使用已发布配置，不允许本次运行修改',
        field,
      );
}

export function declaredScope(flow: GraphFlow, inputs: GraphInputsDto) {
  const fields = flowStart(flow).inputs ?? [];
  const find = (type: GraphField['type']) => {
    const candidates = fields.filter((field) => field.type === type && !field.multiple);
    return candidates.length === 1 ? entry(inputs.parameters, candidates[0]!.id) : undefined;
  };
  return {
    serviceId: flow.serviceId ?? referenceId(find('SERVICE')),
    environmentId: stringValue(find('ENVIRONMENT')) ?? inputs.environmentId,
    targets: (find('TARGETS') ?? {}) as Pick<
      GraphInputsDto,
      'serverIds' | 'groupIds' | 'strategy' | 'maxParallel' | 'failurePolicy'
    >,
  };
}

export function bindingContext(
  projectId: string,
  flow: GraphFlow,
  inputs: GraphInputsDto,
  outputs?: ReadonlyMap<string, Values>,
  trigger?: Values,
): GraphBindingContext {
  const scope = declaredScope(flow, inputs);
  return {
    parameters: inputs.parameters,
    outputs,
    context: {
      projectId,
      serviceId: scope.serviceId,
      environmentId: scope.environmentId,
      environmentSetId: graphEnvironmentSetId(flow, inputs),
      targets: Object.keys(scope.targets).length ? scope.targets : undefined,
      triggeredAt: trigger?.triggeredAt,
      triggerCommitSha: trigger?.commitSha,
    },
  };
}

export function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

export function referenceId(value: unknown): string | undefined {
  return (
    stringValue(value) ??
    (value && typeof value === 'object'
      ? stringValue(
          'serviceId' in value
            ? value.serviceId
            : 'artifactId' in value
              ? value.artifactId
              : 'id' in value
                ? value.id
                : undefined,
        )
      : undefined)
  );
}

export function graphEnvironmentSetId(flow: GraphFlow, inputs: GraphInputsDto) {
  const start = flowStart(flow);
  const config = start.environmentSet;
  if (config?.mode === 'FIXED') return config.environmentSetId;
  if (config?.mode === 'INPUT' && config.fieldId)
    return stringValue(entry(inputs.parameters, config.fieldId));
  if (!config && start.contract === 'PRESET') {
    const candidates = start.inputs?.filter(
      (field) => field.type === 'ENVIRONMENT_SET' && !field.multiple,
    );
    if (candidates?.length === 1) return stringValue(entry(inputs.parameters, candidates[0]!.id));
  }
  return undefined;
}

export type GraphArtifactRef =
  | { artifactId: string; instanceId?: string; instanceIds?: string[]; rootRunId?: string }
  | { temporaryArtifactId: string };

export function artifactReferenceInstances(ref: GraphArtifactRef): string[] {
  if ('temporaryArtifactId' in ref) return [ref.temporaryArtifactId];
  return ref.instanceId ? [ref.instanceId] : (ref.instanceIds ?? []);
}

export function artifactBindingRefs(value: unknown): GraphArtifactRef[] {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const validId = (id: unknown): id is string => typeof id === 'string' && isUUID(id);
  const refs = items.map((entry): GraphArtifactRef | undefined => {
    if (validId(entry)) return { artifactId: entry };
    if (!entry || typeof entry !== 'object') return undefined;
    if ('temporaryArtifactId' in entry)
      return validId(entry.temporaryArtifactId) &&
        !('artifactId' in entry) &&
        !('instanceId' in entry)
        ? { temporaryArtifactId: entry.temporaryArtifactId }
        : undefined;
    const id = 'artifactId' in entry ? entry.artifactId : 'id' in entry ? entry.id : undefined;
    const instanceId = 'instanceId' in entry ? entry.instanceId : undefined;
    const instanceIds = 'instanceIds' in entry ? entry.instanceIds : undefined;
    const rootRunId = 'rootRunId' in entry ? entry.rootRunId : undefined;
    const restricted = 'scope' in entry ? entry.scope === 'TEMPORARY' : rootRunId !== undefined;
    return validId(id) &&
      (instanceId === undefined || validId(instanceId)) &&
      (instanceIds === undefined ||
        (instanceId === undefined &&
          Array.isArray(instanceIds) &&
          instanceIds.length > 0 &&
          instanceIds.length <= 100 &&
          instanceIds.every(validId))) &&
      (restricted ? validId(rootRunId) : rootRunId === undefined)
      ? {
          artifactId: id,
          ...(instanceId && { instanceId }),
          ...(instanceIds && { instanceIds }),
          ...(rootRunId && { rootRunId }),
        }
      : undefined;
  });
  if (refs.some((entry) => !entry))
    throw new ExecutionPlanIssueError({
      code: 'ARTIFACT',
      fieldId: 'artifact',
      message: '产物输入含无效的逻辑产物或实例引用',
    });
  const grouped = new Map<string, GraphArtifactRef>();
  for (const ref of refs as GraphArtifactRef[]) {
    if ('temporaryArtifactId' in ref) {
      grouped.set(`temporary:${ref.temporaryArtifactId}`, ref);
      continue;
    }
    const key = `${ref.artifactId}:${ref.rootRunId ?? ''}`;
    const previous = grouped.get(key);
    if (!previous) {
      grouped.set(key, ref);
      continue;
    }
    const current = artifactReferenceInstances(ref);
    const before = artifactReferenceInstances(previous);
    const instances = [...new Set([...before, ...current])].sort();
    grouped.set(key, {
      artifactId: ref.artifactId,
      ...(ref.rootRunId && { rootRunId: ref.rootRunId }),
      ...(before.length &&
        current.length &&
        (instances.length === 1 ? { instanceId: instances[0] } : { instanceIds: instances })),
    });
  }
  return [...grouped.values()];
}

function fitArtifactCardinality(field: GraphField, value: unknown) {
  if (field.multiple) return graphRecord(value) && Array.isArray(value.instances) ? [value] : value;
  if (!Array.isArray(value) || !value.length) return value;
  try {
    // A frozen plan may still feed the old per-instance array into this outlet.
    // Collapse it only when every value belongs to the same logical artifact.
    const refs = artifactBindingRefs(value);
    return refs.length === 1 ? (value.length === 1 ? value[0] : refs[0]) : value;
  } catch {
    return value;
  }
}

export function inspectFlowOutputs(flow: GraphFlow, state: GraphBindingContext) {
  const bindings = flow.compiled?.outputBindings ?? flow.outputBindings;
  const evidence: GraphFieldEvidence[] = [];
  const values = Object.fromEntries(
    (flowEnd(flow).outputs ?? []).flatMap((field) => {
      const read = checkedBinding(
        field,
        entry(bindings, field.id) as GraphBinding | undefined,
        state,
      );
      evidence.push(read.evidence);
      return read.value === undefined ? [] : [[field.id, read.value]];
    }),
  );
  return { values, evidence };
}

export function fieldIssue(flow: GraphFlow, node: GraphNode, evidence: GraphFieldEvidence) {
  const source = evidence.source;
  return new ExecutionPlanIssueError({
    code: evidence.type === 'REPOSITORY' || evidence.type === 'GIT_REF' ? 'REPOSITORY' : 'INPUT',
    flowId: flow.id,
    flowName: flow.name,
    nodeId: node.id,
    nodeName: node.name,
    fieldId: evidence.fieldId,
    fieldName: evidence.name,
    sourceNodeId: source?.nodeId,
    sourceFieldId: source?.fieldId,
    message: evidence.message ?? '所需的上游结果尚未生成',
  });
}
