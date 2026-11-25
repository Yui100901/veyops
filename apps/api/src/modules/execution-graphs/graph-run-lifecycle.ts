import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { redactTaskLog } from '../tasks/task-log.service';
import { terminalTaskStatuses } from '../tasks/tasks.types';
import {
  graphConditionMatch,
  orderedFlowNodes,
  type GraphEdge,
  type GraphFlow,
  type GraphNode,
} from './execution-graph-definition';
import type { GraphInputsDto } from './graph-runner.controller';
import { inspectNodeInputs, stringValue, type GraphBindingContext } from './graph-run-bindings';

export const graphTaskKeyPrefix = 'execution-flow:';
export const activeFlowStatuses = ['QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED'];
export const isNodeTerminal = (status: string) =>
  status === 'SKIPPED' || (terminalTaskStatuses as readonly string[]).includes(status);
export const isRelease = ({ type }: Pick<GraphNode, 'type'>) =>
  type === 'DEPLOY_ARTIFACT' || type === 'ROLLBACK_ARTIFACT';
export const isDelivery = (node: Pick<GraphNode, 'type'>) =>
  node.type === 'BUILD' || isRelease(node);

export function flowSelection(
  flow: GraphFlow,
  inputs: GraphInputsDto,
  state?: GraphBindingContext,
) {
  const selected = new Set<string>();
  const matches = new Map<string, NonNullable<GraphEdge['when']>>();
  const incoming = new Map<string, GraphFlow['edges']>();
  for (const edge of flow.edges) {
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }
  const ordered = orderedFlowNodes(flow);
  for (const node of ordered) {
    const relevant = (incoming.get(node.id) ?? []).filter(
      ({ from, when }) =>
        selected.has(from) &&
        (when === undefined || !matches.has(from) || matches.get(from) === when),
    );
    incoming.set(node.id, relevant);
    if (node.type !== 'START' && !relevant.length) continue;
    selected.add(node.id);
    const match = branchMatch(flow, node, inputs, state);
    if (match !== undefined) matches.set(node.id, match);
  }
  return { ordered, selected, matches, incoming };
}

export function graphPreviewRouting(flow: GraphFlow, selection: ReturnType<typeof flowSelection>) {
  const certain = new Set([selection.ordered[0]!.id]);
  const routes = new Map<GraphEdge, 'CERTAIN' | 'POSSIBLE'>();
  for (const node of selection.ordered) {
    for (const edge of selection.incoming.get(node.id) ?? []) {
      const resolved = !edge.when || selection.matches.has(edge.from);
      const active = certain.has(edge.from) && resolved;
      if (active) certain.add(edge.to);
      routes.set(edge, active ? 'CERTAIN' : 'POSSIBLE');
    }
  }
  return {
    certain,
    edges: flow.edges.map((edge) => ({
      ...edge,
      status: routes.get(edge) ?? ('EXCLUDED' as const),
    })),
  };
}

export function branchMatch(
  flow: GraphFlow,
  node: GraphNode,
  inputs: GraphInputsDto,
  state?: GraphBindingContext,
): GraphEdge['when'] {
  if (isRelease(node)) {
    const release = state?.outputs?.get(node.id)?.release as { status?: string } | undefined;
    if (release?.status === 'SUCCESS' || release?.status === 'PARTIAL_SUCCESS')
      return release.status;
  }
  const configuration = node.condition ?? node.switch;
  if (!configuration && !node.branch) return undefined;
  if (flow.model === 'FLOW_V2') {
    const key = (node.condition ?? node.branch ?? node.switch)?.parameterKey;
    const value = key ? inputs.parameters?.[key] : inputs.value;
    return value === undefined ? undefined : graphConditionMatch(node, value);
  }
  const explicit =
    flow.compiled?.nodes[node.id]?.inputBindings.value ?? flow.inputBindings?.[node.id]?.value;
  const output = state?.outputs?.get(node.id);
  if (node.branch) {
    if (typeof output?.branchId === 'string') return output.branchId as GraphEdge['when'];
    const value = state && inspectNodeInputs(flow, node, state).values.value;
    return value === undefined ? undefined : graphConditionMatch(node, value);
  }
  const settled = output?.matched;
  if (typeof settled === 'boolean') return settled ? 'TRUE' : 'FALSE';
  if (typeof settled === 'string') return settled as GraphEdge['when'];
  const value = explicit
    ? state && inspectNodeInputs(flow, node, state).values.value
    : branchInput(inputs, configuration?.key, stringValue(state?.context?.triggerCommitSha));
  if (explicit && value === undefined) return undefined;
  return graphConditionMatch(node, value, !explicit && configuration?.key === 'commitSha');
}

export function graphConditionOutput(node: GraphNode, match: NonNullable<GraphEdge['when']>) {
  if (node.branch) return { matched: match !== 'DEFAULT', branchId: match };
  if (node.type === 'CONDITION') return { matched: match === 'TRUE' };
  if (match === 'DEFAULT') return { matched: match, branchId: 'DEFAULT' };
  const index = Number(match.slice('CASE:'.length));
  const value = node.switch!.cases[index]!;
  const branchId = createHash('sha256').update(value).digest('hex');
  return { matched: match, branchId: 'CASE:' + branchId };
}

function branchInput(
  inputs: GraphInputsDto,
  key?: 'input' | 'commitSha',
  triggerCommitSha?: string,
) {
  if (!key) return inputs.value;
  if (key === 'input') return inputs.value;
  const sha = inputs.commitSha ?? triggerCommitSha;
  if (!sha) throw new BadRequestException('按提交判断的流程必须提供完整提交 SHA');
  return sha.toLowerCase();
}

export function graphNodeOutput(node: GraphNode, match?: GraphEdge['when']) {
  switch (node.type) {
    case 'LOG':
      return redactTaskLog(node.message ?? '');
    case 'START':
      return '执行流已开始';
    case 'END':
      return '执行流已结束';
    case 'CONDITION':
      if (node.branch)
        return match === 'DEFAULT' ? '未命中匹配值，进入默认分支。' : '规则命中，进入对应分支。';
      return match === 'TRUE' ? '条件命中，进入成立分支。' : '条件未命中，进入不成立分支。';
    case 'SWITCH':
      return match === 'DEFAULT' ? '未命中匹配值，进入默认分支。' : '多分支匹配成功。';
    case 'PARALLEL':
      return '并行分支就绪。';
    case 'JOIN':
      return '已选中的分支全部完成。';
    default:
      return '';
  }
}

export function failureStatus(statuses: string[]): string | undefined {
  return ['NEEDS_ATTENTION', 'TIMED_OUT', 'FAILED', 'PARTIAL_FAILED', 'CANCELLED'].find((status) =>
    statuses.includes(status),
  );
}
