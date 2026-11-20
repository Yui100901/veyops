import { compileCanvas, withDraftCanvas } from './execution-graph-canvas';
import {
  orderedFlowNodes,
  type GraphBuildSettings,
  type GraphDefinition,
  type GraphDeploySettings,
  type GraphFlow,
  type GraphNode,
} from './execution-graph-definition';
import { redactTaskLog } from '../tasks/task-log.service';
import { GraphCompileError, type GraphBinding, type GraphField } from './graph-fields';

type LegacyPreset = {
  kind?: string;
  serviceId?: string;
  build?: GraphBuildSettings;
  deploy?: GraphDeploySettings;
};
type LegacyNode = GraphNode & {
  delivery?: LegacyPreset;
  pipelineId?: string;
  pipelineVersion?: number;
};

export interface MigrationIssue {
  id: string;
  code: string;
  message: string;
  flowId?: string;
  blocking: boolean;
}

export function migrationIssue(
  code: string,
  message: string,
  blocking: boolean,
  flowId?: string,
): MigrationIssue {
  return { id: flowId ? `${code}:${flowId}` : code, code, message, blocking, flowId };
}

export function legacyNodes(definition: GraphDefinition) {
  return [
    ...definition.flows.flatMap(({ nodes }) => nodes),
    ...(definition.canvas?.nodes ?? []),
    ...(definition.canvas?.templates ?? []),
  ].filter(
    (node): node is LegacyNode =>
      'delivery' in node || 'pipelineId' in node || 'pipelineVersion' in node,
  );
}

export function legacyPreset(flow: GraphFlow) {
  return (flow.nodes.find(({ type }) => type === 'START') as LegacyNode | undefined)?.delivery;
}

function migrationCanvas(definition: GraphDefinition) {
  const { canvas } = withDraftCanvas(definition);
  if (definition.canvas) return structuredClone(canvas);
  let offset = 0;
  for (const [index, flow] of definition.flows.entries()) {
    const ids = new Map(flow.nodes.map(({ id }, i) => [id, canvas.nodes[offset + i]!.id]));
    offset += flow.nodes.length;
    const endpoint = canvas.endpoints[index]!;
    const rename = (binding: GraphBinding): GraphBinding => {
      if (binding.kind === 'OUTPUT') return { ...binding, nodeId: ids.get(binding.nodeId)! };
      if (binding.kind === 'FIRST_AVAILABLE')
        return { ...binding, sources: binding.sources.map(rename) };
      return binding;
    };
    const fields = (bindings: Record<string, GraphBinding>) =>
      Object.fromEntries(Object.entries(bindings).map(([id, binding]) => [id, rename(binding)]));
    endpoint.serviceId = flow.serviceId;
    if (flow.inputBindings)
      endpoint.inputBindings = Object.fromEntries(
        Object.entries(flow.inputBindings).map(([id, bindings]) => [
          ids.get(id)!,
          fields(bindings),
        ]),
      );
    if (flow.outputBindings) endpoint.outputBindings = fields(flow.outputBindings);
    if (flow.edgeSelections)
      endpoint.edgeSelections = Object.fromEntries(
        Object.entries(flow.edgeSelections).map(([id, edges]) => [
          ids.get(id)!,
          edges.map((target) => ids.get(target)!),
        ]),
      );
  }
  return structuredClone(canvas);
}

function addStartField(start: GraphNode, field: GraphField) {
  const ids = new Set(start.inputs?.map(({ id }) => id));
  let id = field.id;
  for (let suffix = 2; ids.has(id); suffix++) id = `${field.id}-${suffix}`;
  const created = { ...field, id };
  start.inputs = [...(start.inputs ?? []), created];
  return created;
}

function startField(start: GraphNode, field: GraphField) {
  return (
    start.inputs?.find(
      (candidate) =>
        candidate.type === field.type && Boolean(candidate.multiple) === Boolean(field.multiple),
    ) ?? addStartField(start, field)
  );
}

export function migrateLegacyDefinition(definition: GraphDefinition) {
  const issues: MigrationIssue[] = [];
  const canvas = migrationCanvas(definition);
  const original = compileCanvas(structuredClone(canvas), false);
  const nodes = new Map(canvas.nodes.map((node) => [node.id, node as LegacyNode]));
  const previous = new Map(original.flows.map((flow) => [flow.id, flow]));
  for (const node of canvas.templates as LegacyNode[])
    if (node.delivery || node.pipelineId || node.pipelineVersion)
      issues.push(
        migrationIssue('LEGACY_TEMPLATE', '节点库仍引用旧交付配置，请先处理该模板。', true),
      );

  for (const endpoint of canvas.endpoints) {
    const flowId = endpoint.startId;
    const start = nodes.get(flowId)!;
    const preset = start.delivery;
    const flow = previous.get(flowId);
    if (!preset || !flow) continue;
    const sequence = orderedFlowNodes(flow);
    const builds = sequence.filter((node) => node.type === 'BUILD');
    const deploys = sequence.filter((node) => node.type === 'DEPLOY_ARTIFACT');
    const [build] = builds;
    const [deploy] = deploys;
    if (!build && !deploy) {
      if (preset.build || preset.deploy) {
        issues.push(
          migrationIssue('ORPHAN_SETTINGS', '开始节点的配置没有对应的交付节点。', true, flowId),
        );
        continue;
      }
      delete start.delivery;
      continue;
    }
    if (
      !preset.serviceId ||
      (endpoint.serviceId && preset.serviceId !== endpoint.serviceId) ||
      builds.length > 1 ||
      deploys.length > 1 ||
      (build && !preset.build?.repositoryId) ||
      Boolean(build) !== ['BUILD', 'BUILD_DEPLOY'].includes(preset.kind ?? '') ||
      Boolean(deploy) !== ['DEPLOY', 'BUILD_DEPLOY'].includes(preset.kind ?? '')
    ) {
      issues.push(
        migrationIssue(
          'UNRESOLVED_DELIVERY',
          '服务、仓库、交付预设或交付节点需要重新确认。',
          true,
          flowId,
        ),
      );
      continue;
    }
    function conflicts(node: GraphNode | undefined, field: 'build' | 'deploy') {
      if (!node) return false;
      const current = nodes.get(node.id)!;
      const desired = preset![field] ?? {};
      if (current.pipelineId || (current[field] && !isDeepStrictEqual(current[field], desired)))
        return true;
      return original.flows.some((other) => {
        if (other.id === flowId || !other.nodes.some(({ id }) => id === node.id)) return false;
        const settings = legacyPreset(other);
        return !settings || !isDeepStrictEqual(settings[field] ?? {}, desired);
      });
    }
    if (conflicts(build, 'build') || conflicts(deploy, 'deploy')) {
      issues.push(
        migrationIssue(
          'SHARED_DELIVERY',
          '交付节点已有不同设置或引用旧 Pipeline，请手动确认共享节点和输入。',
          true,
          flowId,
        ),
      );
      continue;
    }
    if (
      (start.inputs ?? []).filter((field) => field.type === 'ENVIRONMENT' && !field.multiple)
        .length > 1
    ) {
      issues.push(
        migrationIssue(
          'ENVIRONMENT_BINDING_AMBIGUOUS',
          '开始节点有多个环境参数，请明确各交付节点的输入。',
          true,
          flowId,
        ),
      );
      continue;
    }
    endpoint.serviceId = preset.serviceId;
    const environment = startField(start, {
      id: 'environment',
      name: '环境',
      type: 'ENVIRONMENT',
      required: true,
    });
    const binding = endpoint.inputBindings ?? {};
    const targetFields = (start.inputs ?? []).filter(
      (field) => field.type === 'TARGETS' && !field.multiple,
    );
    for (const node of [build, deploy]) {
      if (!node) continue;
      binding[node.id] = {
        environment: { kind: 'INPUT', fieldId: environment.id },
        ...binding[node.id],
      };
      const needsTargets =
        node.type === 'DEPLOY_ARTIFACT' || preset.build?.buildLocation !== 'MANAGER';
      if (!needsTargets || binding[node.id]!.targets) continue;
      if (targetFields.length > 1) {
        issues.push(
          migrationIssue(
            'TARGET_BINDING_AMBIGUOUS',
            '旧开始节点有多个目标参数，请人工明确各交付节点的目标来源。',
            true,
            flowId,
          ),
        );
        continue;
      }
      const isBuild = node.type === 'BUILD';
      const target =
        targetFields[0] ??
        addStartField(start, {
          id: isBuild ? 'build-targets' : 'release-targets',
          name: isBuild ? '构建服务器' : '发布服务器或分组',
          type: 'TARGETS',
          required: isBuild && preset.build?.buildLocation === 'TARGET',
        });
      binding[node.id]!.targets = { kind: 'INPUT', fieldId: target.id };
    }
    if (build) nodes.get(build.id)!.build = { ...preset.build };
    if (deploy) {
      nodes.get(deploy.id)!.deploy = { ...preset.deploy };
      if (!binding[deploy.id]!.artifact) {
        if (build) {
          binding[deploy.id]!.artifact = { kind: 'OUTPUT', nodeId: build.id, fieldId: 'artifacts' };
        } else {
          const artifact = startField(start, {
            id: 'artifact',
            name: '发布产物',
            type: 'ARTIFACT',
            selection: 'LATEST_COMPATIBLE',
            multiple: true,
          });
          binding[deploy.id]!.artifact = { kind: 'INPUT', fieldId: artifact.id };
        }
      }
      const end = nodes.get(endpoint.endId)!;
      let output = end.outputs?.find(
        (field) => field.type === 'RELEASE' && field.required !== false,
      );
      if (!output) {
        const otherEnds = canvas.endpoints.filter(
          ({ startId, endId }) => startId !== flowId && endId === endpoint.endId,
        );
        if (
          otherEnds.some(
            ({ startId }) =>
              !previous.get(startId)?.nodes.some(({ type }) => type === 'DEPLOY_ARTIFACT'),
          )
        ) {
          issues.push(
            migrationIssue(
              'SHARED_END_OUTPUT',
              '该发布流与非发布流共用结束节点，请先为发布流设置独立结束节点。',
              true,
              flowId,
            ),
          );
          continue;
        }
        const ids = new Set(end.outputs?.map(({ id }) => id));
        let id = 'release';
        for (let suffix = 2; ids.has(id); suffix++) id = `release-${suffix}`;
        output = { id, name: '服务发布结果', type: 'RELEASE', required: true };
        end.outputs = [...(end.outputs ?? []), output];
      }
      endpoint.outputBindings = {
        [output.id]: { kind: 'OUTPUT', nodeId: deploy.id, fieldId: 'release' },
        ...endpoint.outputBindings,
      };
    }
    endpoint.inputBindings = binding;
    delete start.delivery;
  }
  const candidate = compileCanvas(canvas, false);
  if (legacyNodes(candidate).length)
    issues.push(
      migrationIssue('UNMAPPED_LEGACY_NODES', '仍有未映射的旧节点，原草稿将保留。', true),
    );
  try {
    if (!issues.some(({ blocking }) => blocking)) compileCanvas(canvas, true);
  } catch (error) {
    issues.push(
      migrationIssue(
        'INVALID_CANDIDATE',
        error instanceof GraphCompileError
          ? redactTaskLog(error.issue.message)
          : '映射后的画布未通过发布校验。请在原草稿处理分支或字段冲突。',
        true,
        error instanceof GraphCompileError ? error.issue.flowId : undefined,
      ),
    );
  }
  return { candidate, previous: definition.canvas ? original.flows : definition.flows, issues };
}
import { isDeepStrictEqual } from 'node:util';
