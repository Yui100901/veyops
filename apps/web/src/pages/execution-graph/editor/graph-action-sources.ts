import type { DeploymentSelection, ProjectDetail } from '../../../models';
import { effectiveNodeType, isReleaseNode } from '../execution-graph-definition';
import type { GraphBinding, GraphNode } from '../execution-graph-definition';
import {
  getGraphStartGroups,
  graphStartGroupCompanion,
  graphStartGroupDetails,
  graphStartGroupFields,
  selectedGraphStartGroup,
  type GraphStartGroupKind,
  type GraphTargetNames,
} from './graph-start-groups';

const captions: Record<string, string> = {
  repository: '仓库',
  version: 'Git 版本',
  workspace: '工作区',
  source: 'Git 来源',
  variables: '变量文件',
  targets: '执行目标',
  service: '发布服务',
  artifact: '产物',
  release: '发布结果',
};

export type GraphActionSource = {
  label: string;
  grouped?: boolean;
  sources: { name: string; nodeId?: string; fieldId?: string; section?: 'input' | 'output' }[];
};

export function graphActionSources(
  start: GraphNode | undefined,
  nodes: GraphNode[],
  bindings: Record<string, GraphBinding> | undefined,
  node: GraphNode,
  project: ProjectDetail,
  targetNames?: GraphTargetNames,
) {
  const operation = effectiveNodeType(node);
  const kind: GraphStartGroupKind | undefined =
    start?.contract !== 'PRESET'
      ? undefined
      : isReleaseNode(node)
        ? 'release'
        : operation === 'CHECKOUT' ||
            (operation === 'BUILD' &&
              bindings?.repository &&
              !bindings.source &&
              !bindings.workspace)
          ? 'source'
          : undefined;
  const groupConfig = kind && graphStartGroupFields[kind];
  const summary: GraphActionSource[] = [];
  if (kind && groupConfig && start) {
    const groups = getGraphStartGroups(start, kind);
    const group = selectedGraphStartGroup(kind, groups, bindings);
    if (group) {
      const companion = graphStartGroupCompanion(
        start,
        kind,
        groups,
        group,
        bindings?.[groupConfig.pairedInput],
      );
      const details = graphStartGroupDetails(kind, { ...group, companion }, project, targetNames);
      summary.push({
        label: groupConfig.label,
        grouped: true,
        sources: [
          {
            name: [groups.length > 1 ? group.label : undefined, ...details]
              .filter(Boolean)
              .join(' · '),
            nodeId: start.id,
            fieldId: group.primary.id,
            section: 'input',
          },
        ],
      });
    }
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const resolve = (binding: GraphBinding): GraphActionSource['sources'] => {
    if (binding.kind === 'INPUT') {
      const field = start?.inputs?.find(({ id }) => id === binding.fieldId);
      return [
        {
          name: field ? '开始 · ' + field.name : '开始字段不可用',
          nodeId: start?.id,
          fieldId: binding.fieldId,
          section: 'input',
        },
      ];
    }
    if (binding.kind === 'OUTPUT') {
      const upstream = byId.get(binding.nodeId);
      return [
        {
          name: upstream?.name || '上游节点不可用',
          nodeId: upstream?.id,
          fieldId: binding.fieldId,
          section: 'output',
        },
      ];
    }
    if (binding.kind === 'FIRST_AVAILABLE') return binding.sources.flatMap(resolve);
    if (binding.kind === 'AS_GIT_REF' || binding.kind === 'PROJECT_VALUE')
      return resolve(binding.source);
    if (binding.kind === 'VALUE') return [{ name: '固定配置' }];
    return [];
  };
  return summary.concat(
    Object.entries(bindings ?? {}).flatMap(([id, binding]): GraphActionSource[] => {
      if (
        groupConfig &&
        summary.length &&
        (id === groupConfig.input || id === groupConfig.pairedInput)
      )
        return [];
      const label = captions[id];
      const sources = label ? resolve(binding) : [];
      return label && sources.length ? [{ label, sources }] : [];
    }),
  );
}

export function actionCardText(entries: GraphActionSource[]) {
  return entries
    .filter(({ label }) => label !== 'Git 版本' && label !== 'Git 来源')
    .slice(0, 2)
    .map(
      ({ label, sources, grouped }) =>
        label +
        (grouped ? ' · ' : '来自') +
        (sources.length > 1 ? `${sources.length} 个候选` : sources[0]?.name),
    )
    .join(' · ');
}

export function startCardText(start: GraphNode, project: ProjectDetail, triggerCount = 0) {
  const fields = start.inputs ?? [];
  const sources = getGraphStartGroups(start, 'source').filter(
    ({ primary }) => primary.defaultValue !== undefined,
  );
  const selectionCount = fields.reduce((count, field) => {
    if (field.type !== 'TARGETS' || !field.defaultValue) return count;
    const target = field.defaultValue as DeploymentSelection;
    return count + (target.serverIds?.length ?? 0) + (target.groupIds?.length ?? 0);
  }, 0);
  return [
    sources.length > 1
      ? sources.length + ' 组源码'
      : sources[0] && graphStartGroupDetails('source', sources[0], project)[0],
    selectionCount > 0 ? selectionCount + ' 个目标选择' : undefined,
    triggerCount > 0 ? triggerCount + ' 条自动触发' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
