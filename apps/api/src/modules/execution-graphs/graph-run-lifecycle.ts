import { BadRequestException } from '@nestjs/common';
import { redactTaskLog } from '../tasks/task-log.service';
import { terminalTaskStatuses } from '../tasks/tasks.types';
import {
  orderedFlowNodes,
  type GraphEdge,
  type GraphFlow,
  type GraphNode,
} from './execution-graph-definition';
import type { GraphInputsDto } from './graph-runner.controller';
import { nodeBindings, type GraphBindingContext } from './graph-run-bindings';

export const graphTaskKeyPrefix = 'execution-flow:';
export const activeFlowStatuses = ['QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED'];
export const isNodeTerminal = (status: string) =>
  status === 'SKIPPED' || (terminalTaskStatuses as readonly string[]).includes(status);
export const isDelivery = ({ type }: GraphNode) => type === 'BUILD' || type === 'DEPLOY_ARTIFACT';

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

export function branchMatch(
  flow: GraphFlow,
  node: GraphNode,
  inputs: GraphInputsDto,
  state?: GraphBindingContext,
): GraphEdge['when'] {
  const configuration = node.condition ?? node.switch;
  if (!configuration) return undefined;
  const explicit = flow.inputBindings?.[node.id]?.value;
  const settled = state?.outputs?.get(node.id)?.matched;
  if (typeof settled === 'boolean') return settled ? 'TRUE' : 'FALSE';
  if (typeof settled === 'string') return settled as GraphEdge['when'];
  const value = explicit
    ? state && nodeBindings(flow, node, state, ['value']).value
    : branchInput(inputs, configuration.key);
  if (explicit && value === undefined) return undefined;
  const commit = !explicit && configuration.key === 'commitSha';
  const matches = (candidate: string) =>
    (commit ? candidate.toLowerCase() : candidate) ===
    (value === undefined ? undefined : String(value));
  if (node.condition) return matches(node.condition.value) ? 'TRUE' : 'FALSE';
  const index = node.switch!.cases.findIndex(matches);
  return index === -1 ? 'DEFAULT' : `CASE:${index}`;
}

function branchInput(inputs: GraphInputsDto, key?: 'input' | 'commitSha') {
  if (!key) return inputs.value;
  if (key === 'input') return inputs.value;
  if (!inputs.commitSha) throw new BadRequestException('按提交判断的流程必须提供完整提交 SHA');
  return inputs.commitSha.toLowerCase();
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
