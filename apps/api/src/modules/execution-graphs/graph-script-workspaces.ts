import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
import type { GraphEdge, GraphFlow, GraphNode } from './execution-graph-definition';
import { graphBranchPaths } from './graph-binding-validation';
import type { ScriptWorkspaceCandidate, ScriptWorkspacePlan } from './graph-node-tasks';
import {
  nodeInputBinding,
  outputSources,
  previewGraphBindingOptions,
  stringValue,
  type GraphBindingContext,
  type GraphBindingOptions,
  type Values,
} from './graph-run-bindings';

export class ScriptWorkspacePreview {
  private readonly paths;
  private readonly workspaceOutputs = new Map<
    ReturnType<typeof graphBranchPaths>[number],
    Map<string, GraphBindingOptions>
  >();

  constructor(
    private readonly flow: GraphFlow,
    ordered: GraphNode[],
  ) {
    this.paths = graphBranchPaths(flow, ordered);
  }

  prepare(
    node: GraphNode,
    context: GraphBindingContext,
    matches: ReadonlyMap<string, NonNullable<GraphEdge['when']>>,
  ) {
    const workspaceBinding = nodeInputBinding(this.flow, node, 'workspace');
    const sourceBinding = nodeInputBinding(this.flow, node, 'source');
    const inputs = new Map<(typeof this.paths)[number], GraphBindingOptions>();
    const candidates: ScriptWorkspaceCandidate[] = [];
    const seen = new Set<string>();
    let optional = false;
    for (const path of this.paths) {
      if (
        !path.active.has(node.id) ||
        path.branches.some(
          ({ edge }) => matches.has(edge.from) && matches.get(edge.from) !== edge.when,
        )
      )
        continue;
      const options = (binding: typeof workspaceBinding) =>
        previewGraphBindingOptions(
          binding,
          context,
          path.active,
          (nodeId, fieldId) =>
            fieldId === 'workspace' ? this.workspaceOutputs.get(path)?.get(nodeId) : undefined,
          (nodeId, fieldId) =>
            this.flow.compiled?.nodes[nodeId]?.outputs.find(({ id }) => id === fieldId)
              ?.required !== false,
        );
      const workspace = options(workspaceBinding);
      const source = options(sourceBinding);
      const fixedSource =
        !source.missing && source.values.length === 1 && source.values[0]?.state === 'VALUE'
          ? (source.values[0].value as Values)
          : undefined;
      optional ||= workspace.missing;
      inputs.set(path, workspace);
      for (const entry of workspace.values) {
        const value = entry.value as Values | undefined;
        if (
          value?.repositoryId &&
          fixedSource &&
          workspace.values.length === 1 &&
          !workspace.missing &&
          (value.repositoryId !== fixedSource.repositoryId ||
            value.commitSha !== fixedSource.commitSha)
        )
          throw new ExecutionPlanIssueError({
            code: 'INPUT',
            fieldId: 'workspace',
            fieldSection: 'input',
            message: '脚本绑定的源码与工作区来自不同 Git 提交',
          });
        const pin = entry.state === 'DEFERRED' ? fixedSource : value;
        const candidate = {
          producerNodeId: entry.source?.nodeId,
          producerField: entry.source?.fieldId,
          repositoryId: stringValue(pin?.repositoryId),
          commitSha: stringValue(pin?.commitSha),
          deferred: entry.state === 'DEFERRED',
        };
        const key = JSON.stringify(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }
    // Runtime limits each path to its ordered first present source. Keep that priority in the plan as well.
    const order = outputSources(workspaceBinding);
    const rank = (candidate: ScriptWorkspaceCandidate) =>
      order.findIndex(
        ({ nodeId, fieldId }) =>
          nodeId === candidate.producerNodeId && fieldId === candidate.producerField,
      );
    candidates.sort((left, right) => rank(left) - rank(right));
    const plan: ScriptWorkspacePlan | undefined = candidates[0] && {
      ...candidates[0],
      ...(candidates.length > 1 && { candidates }),
      ...(optional && { optional: true }),
    };
    return { plan, inputs };
  }

  recordOutputs(
    nodeId: string,
    inputs: ReturnType<ScriptWorkspacePreview['prepare']>['inputs'],
    manager: boolean,
  ) {
    for (const [path, workspace] of inputs) {
      let outputs = this.workspaceOutputs.get(path);
      if (!outputs) this.workspaceOutputs.set(path, (outputs = new Map()));
      outputs.set(
        nodeId,
        manager
          ? {
              // A manager script without an input workspace creates its own unversioned workspace.
              values: workspace.missing
                ? [...workspace.values, { state: 'VALUE', value: {} }]
                : workspace.values,
              missing: false,
            }
          : { values: [], missing: true },
      );
    }
  }
}
