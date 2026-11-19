import { BadRequestException } from '@nestjs/common';
import { redactTaskLog } from '../tasks/task-log.service';
import { terminalTaskStatuses } from '../tasks/tasks.types';
import { orderedFlowNodes, type GraphFlow, type GraphNode } from './execution-graph-definition';
import type { GraphInputsDto } from './graph-runner.controller';

export const graphTaskKeyPrefix = 'execution-flow:';
export const activeFlowStatuses = ['QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED'];
export const isNodeTerminal = (status: string) =>
  status === 'SKIPPED' || (terminalTaskStatuses as readonly string[]).includes(status);
export const isDelivery = ({ type }: GraphNode) => type === 'BUILD' || type === 'DEPLOY_ARTIFACT';

export function flowSelection(flow: GraphFlow, inputs: GraphInputsDto) {
  const selected = new Set<string>();
  const matches = new Map<string, boolean>();
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
        selected.has(from) && (when === undefined || matches.get(from) === (when === 'TRUE')),
    );
    incoming.set(node.id, relevant);
    if (node.type !== 'START' && !relevant.length) continue;
    selected.add(node.id);
    if (node.type === 'CONDITION' && node.condition) {
      const { key, value } = node.condition;
      if (key === 'commitSha' && !inputs.commitSha)
        throw new BadRequestException('按提交判断的流程必须提供完整提交 SHA');
      matches.set(
        node.id,
        key === 'commitSha'
          ? inputs.commitSha?.toLowerCase() === value.toLowerCase()
          : inputs.value === value,
      );
    }
  }
  return { ordered, selected, matches, incoming };
}

export function graphNodeOutput(node: GraphNode, match?: boolean) {
  switch (node.type) {
    case 'LOG':
      return redactTaskLog(node.message ?? '');
    case 'START':
      return '执行流已开始';
    case 'END':
      return '执行流已结束';
    case 'CONDITION':
      return match ? '条件命中，进入成立分支。' : '条件未命中，进入不成立分支。';
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
