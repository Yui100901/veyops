import { HttpException } from '@nestjs/common';
import { ExecutionPlanIssueError, type ExecutionPlanIssue } from '../../core/execution-plan-issue';
import type { GraphFlow, GraphNode } from './execution-graph-definition';
import { graphDefaultBinding, graphModulePorts, type GraphField } from './graph-fields';

type IssueLocation = Omit<ExecutionPlanIssue, 'message'>;

export function graphInputIssue(flow: GraphFlow, message: string, field?: GraphField) {
  const start = flow.nodes.find(({ type }) => type === 'START');
  return new ExecutionPlanIssueError({
    code:
      field?.type === 'ARTIFACT'
        ? 'ARTIFACT'
        : field?.type === 'REPOSITORY'
          ? 'REPOSITORY'
          : 'INPUT',
    message,
    flowId: flow.id,
    flowName: flow.name,
    nodeId: start?.id,
    nodeName: start?.name,
    fieldId: field?.id,
    fieldName: field?.name,
    parameterId: field?.id,
  });
}

export function withPlanIssue(error: unknown, fallback: IssueLocation): never {
  if (!(error instanceof HttpException)) throw error;
  const status = error.getStatus();
  if (
    !(error instanceof ExecutionPlanIssueError) &&
    ![400, 403, 404, 409, 502, 503, 504].includes(status)
  )
    throw error;
  const source = error instanceof ExecutionPlanIssueError ? error.issue : undefined;
  throw new ExecutionPlanIssueError(
    {
      ...fallback,
      message: error.message,
      ...source,
    },
    status,
  );
}

export function withNodePlanIssue(
  error: unknown,
  flow: GraphFlow,
  node: GraphNode,
  scope: Pick<ExecutionPlanIssue, 'serviceId' | 'environmentId'> = {},
): never {
  const typed = error instanceof ExecutionPlanIssueError ? error : undefined;
  const issue = typed?.issue;
  if (issue?.nodeId) throw error;
  const field = issue?.fieldId;
  const fieldName = field && graphModulePorts(node)?.inputs.find(({ id }) => id === field)?.name;
  const location: IssueLocation = {
    code: 'CONFIGURATION',
    flowId: flow.id,
    flowName: flow.name,
    nodeId: node.id,
    nodeName: node.name,
    ...(fieldName && { fieldName }),
    ...scope,
  };
  if (!typed || !issue) return withPlanIssue(error, location);
  const binding = field
    ? (flow.compiled?.nodes[node.id]?.inputBindings[field] ??
      flow.inputBindings?.[node.id]?.[field] ??
      graphDefaultBinding(flow, node, field))
    : undefined;
  const targetSource =
    issue.targetSource === 'RUN_INPUT' && binding && binding.kind !== 'INPUT'
      ? 'NODE'
      : issue.targetSource;
  const parameterId =
    binding?.kind === 'INPUT' && (!targetSource || targetSource === 'RUN_INPUT')
      ? binding.fieldId
      : undefined;
  throw new ExecutionPlanIssueError(
    { ...location, ...issue, targetSource, parameterId: issue.parameterId ?? parameterId },
    typed.getStatus(),
  );
}
