import { pipelineNodeLabels, type PipelineNodeType } from './PipelineNodeGraph';

export interface NodeVariable {
  key: string;
  value?: string;
  credentialId?: string;
}

export interface PipelineNode {
  id: string;
  name: string;
  type: PipelineNodeType;
  repositoryId?: string;
  branch?: string;
  environmentBranches?: Record<string, string>;
  directory?: string;
  command?: string;
  timeout?: number;
  variables?: NodeVariable[];
  envFile?: string;
}

export interface PipelineNodeSource {
  id: string;
  repositoryId: string;
  commitSha: string;
  branch?: string;
}

export const commandTypes: PipelineNodeType[] = ['INSTALL', 'BUILD', 'TEST', 'SHELL'];

export function newNode(type: PipelineNodeType): PipelineNode {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (part) =>
    part.toString(16).padStart(2, '0'),
  ).join('');
  return { id, type, name: pipelineNodeLabels[type] };
}

export function nodesFromLegacy(definition: {
  installCommand?: string;
  buildCommand?: string;
  steps?: { name: string; command: string; timeout?: number }[];
}): PipelineNode[] {
  return [
    newNode('CHECKOUT'),
    ...(definition.installCommand?.trim()
      ? [{ ...newNode('INSTALL'), command: definition.installCommand }]
      : []),
    {
      ...newNode('BUILD'),
      command: definition.buildCommand?.trim() ? definition.buildCommand : ':',
    },
    ...(definition.steps ?? []).map((step) => ({
      ...newNode('SHELL'),
      name: step.name,
      command: step.command,
      timeout: step.timeout,
    })),
    newNode('PACKAGE'),
    newNode('DEPLOY'),
  ];
}

export function ordered(nodes: PipelineNode[]) {
  const phases = nodes.map(({ type }) =>
    type === 'CHECKOUT' ? 0 : type === 'PACKAGE' ? 2 : type === 'DEPLOY' ? 3 : 1,
  );
  return phases.every((phase, index) => index === 0 || phase >= phases[index - 1]!);
}

export function nodeConfigurationError(nodes: PipelineNode[], primaryRepositoryId: string) {
  if (
    nodes[0]?.type !== 'CHECKOUT' ||
    !ordered(nodes) ||
    nodes.filter(({ type }) => type === 'PACKAGE').length !== 1
  )
    return '请将源码获取放在最前，构建步骤放在打包前，部署放在最后。流程需要一个打包节点。';
  const checkouts = nodes.filter(({ type }) => type === 'CHECKOUT');
  const directories = checkouts.map((node) => node.directory?.trim() || '.');
  if (new Set(directories).size !== directories.length) return '各源码节点必须使用不同的检出目录。';
  for (const node of nodes) {
    const label = node.name.trim();
    if (!label) return `请填写${pipelineNodeLabels[node.type]}节点名称。`;
    if (commandTypes.includes(node.type) && !node.command?.trim())
      return `请为「${label}」填写命令。`;
    if (
      node.timeout !== undefined &&
      (!Number.isInteger(node.timeout) || node.timeout < 1 || node.timeout > 3600)
    )
      return `「${label}」的超时必须在 1–3600 秒之间。`;
    if (
      node.type === 'CHECKOUT' &&
      node.repositoryId &&
      node.repositoryId !== primaryRepositoryId &&
      !node.branch?.trim() &&
      !Object.keys(node.environmentBranches ?? {}).length
    )
      return `请为「${label}」选择仓库分支。`;
    if (node.type !== 'ENVIRONMENT') continue;
    const variables = node.variables ?? [];
    if (!variables.length && !node.envFile?.trim())
      return `请为「${label}」选择环境文件或添加变量。`;
    if (
      variables.some(
        (variable) =>
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(variable.key) ||
          /^VEYOPS_/i.test(variable.key) ||
          (variable.value === undefined && !variable.credentialId),
      )
    )
      return `请检查「${label}」中的变量名和值或凭据。`;
    if (new Set(variables.map(({ key }) => key)).size !== variables.length)
      return `「${label}」中的变量名不能重复。`;
  }
  return '';
}
