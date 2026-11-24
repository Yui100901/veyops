import type { DeploymentSelection, ProjectDetail } from '../../../models';
import type { GraphBinding, GraphNode } from '../execution-graph-definition';

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
  sources: { name: string; nodeId?: string; fieldId?: string; section?: 'input' | 'output' }[];
};

export function graphActionSources(
  start: GraphNode | undefined,
  nodes: GraphNode[],
  bindings: Record<string, GraphBinding> | undefined,
) {
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
  return Object.entries(bindings ?? {}).flatMap(([id, binding]): GraphActionSource[] => {
    const label = captions[id];
    const sources = label ? resolve(binding) : [];
    return label && sources.length ? [{ label, sources }] : [];
  });
}

export function actionCardText(entries: GraphActionSource[]) {
  return entries
    .filter(({ label }) => label !== 'Git 版本' && label !== 'Git 来源')
    .slice(0, 2)
    .map(
      ({ label, sources }) =>
        label + '来自' + (sources.length > 1 ? `${sources.length} 个候选` : sources[0]?.name),
    )
    .join(' · ');
}

export function startCardText(start: GraphNode, project: ProjectDetail, triggerCount = 0) {
  const fields = start.inputs ?? [];
  const repoField = fields.find(({ id, type }) => id === 'repository' && type === 'REPOSITORY');
  const repo = project.repositories.find(
    ({ id, cloneUrl }) => id === repoField?.defaultValue || cloneUrl === repoField?.defaultValue,
  );
  const repoCount = fields.filter(
    ({ type, defaultValue }) => type === 'REPOSITORY' && defaultValue !== undefined,
  ).length;
  const selectionCount = fields.reduce((count, field) => {
    if (field.type !== 'TARGETS' || !field.defaultValue) return count;
    const target = field.defaultValue as DeploymentSelection;
    return count + (target.serverIds?.length ?? 0) + (target.groupIds?.length ?? 0);
  }, 0);
  return [
    repoCount > 1 ? repoCount + ' 个仓库' : repo?.name,
    selectionCount > 0 ? selectionCount + ' 个目标选择' : undefined,
    triggerCount > 0 ? triggerCount + ' 条自动触发' : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
