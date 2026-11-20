import { BadRequestException } from '@nestjs/common';
import type { GraphFlow, GraphNode } from './execution-graph-definition';
import {
  graphDefaultBinding,
  validateGraphValue,
  type GraphBinding,
  type GraphField,
} from './graph-fields';
import type { GraphInputsDto } from './graph-runner.controller';
import { redactTaskLog } from '../tasks/task-log.service';

export type Values = Record<string, unknown>;

export interface GraphBindingContext {
  parameters?: Values;
  outputs?: ReadonlyMap<string, Values>;
  context: Values;
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
  switch (binding?.kind) {
    case 'INPUT':
      return entry(state.parameters, binding.fieldId);
    case 'OUTPUT':
      return entry(state.outputs?.get(binding.nodeId), binding.fieldId);
    case 'CONTEXT':
      return entry(state.context, binding.fieldId);
    case 'VALUE':
      return binding.value;
    case 'FIRST_AVAILABLE':
      return binding.sources
        .map((source) => bindingValue(source, state))
        .find((value) => value != null && (!Array.isArray(value) || value.length > 0));
  }
}

export function nodeBindings(
  flow: GraphFlow,
  node: GraphNode,
  state: GraphBindingContext,
  ports: string[] = [],
) {
  const bindings = flow.inputBindings?.[node.id] ?? {};
  return Object.fromEntries(
    [...new Set([...ports, ...Object.keys(bindings)])].flatMap((port) => {
      const binding = entry(bindings, port) as GraphBinding | undefined;
      const value = bindingValue(binding ?? graphDefaultBinding(flow, node, port), state);
      return value === undefined ? [] : [[port, value]];
    }),
  );
}

export function outputSources(binding?: GraphBinding): { nodeId: string; fieldId: string }[] {
  if (binding?.kind === 'OUTPUT') return [{ nodeId: binding.nodeId, fieldId: binding.fieldId }];
  if (binding?.kind === 'FIRST_AVAILABLE') return binding.sources.flatMap(outputSources);
  return [];
}

export function checkedParameters(flow: GraphFlow, supplied?: Values, allowArtifactRule = false) {
  const fields = flowStart(flow).inputs ?? [];
  if (supplied && (Object.keys(supplied).length > 64 || JSON.stringify(supplied).length > 65_536))
    throw new BadRequestException('运行参数过大');
  for (const id of Object.keys(supplied ?? {}))
    if (!fields.some((field) => field.id === id))
      throw new BadRequestException(`未声明运行参数 ${id}`);
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = entry(supplied, field.id) ?? field.defaultValue;
      if (value === undefined && allowArtifactRule && field.selection === 'LATEST_COMPATIBLE')
        return [];
      if (!validateGraphValue(field, value))
        throw new BadRequestException(`运行参数「${field.name}」缺失或不符合 ${field.type} 约束`);
      if (value !== undefined && redactTaskLog(JSON.stringify(value)) !== JSON.stringify(value))
        throw new BadRequestException(`运行参数「${field.name}」含明文凭据，请使用凭据引用`);
      return value === undefined ? [] : [[field.id, value]];
    }),
  );
}

export function declaredScope(flow: GraphFlow, inputs: GraphInputsDto) {
  const fields = flowStart(flow).inputs ?? [];
  const find = (type: GraphField['type']) => {
    const candidates = fields.filter((field) => field.type === type && !field.multiple);
    return candidates.length === 1 ? entry(inputs.parameters, candidates[0]!.id) : undefined;
  };
  return {
    serviceId: flow.serviceId ?? stringValue(find('SERVICE')),
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
    (value && typeof value === 'object' && 'id' in value ? stringValue(value.id) : undefined)
  );
}

export function artifactIds(value: unknown) {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const ids = items.map(referenceId);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
    throw new BadRequestException('产物输入必须包含不同的产物引用');
  return ids as string[];
}

export function outputReferences(flow: GraphFlow, state: GraphBindingContext) {
  return Object.fromEntries(
    (flowEnd(flow).outputs ?? []).flatMap((field) => {
      const value = bindingValue(
        entry(flow.outputBindings, field.id) as GraphBinding | undefined,
        state,
      );
      if (!validateGraphValue(field, value))
        throw new BadRequestException(`结束节点「${field.name}」缺少有效输出`);
      return value === undefined ? [] : [[field.id, value]];
    }),
  );
}
