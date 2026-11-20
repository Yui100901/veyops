export const graphNodeLabels = {
  START: '开始',
  LOG: '记录日志',
  CHECKOUT: '代码拉取',
  SHELL: 'Shell 脚本',
  BUILD: '构建并归档',
  DEPLOY_ARTIFACT: '部署历史产物',
  CONDITION: '条件判断',
  SWITCH: '多路判断',
  DELAY: '等待',
  APPROVAL: '人工审批',
  PARALLEL: '并行分支',
  JOIN: '汇合',
  FLOW_CALL: '调用执行流',
  END: '结束',
};
export interface GraphEdge {
  from: string;
  to: string;
  when?: 'TRUE' | 'FALSE' | 'DEFAULT' | `CASE:${number}`;
}
export const flowPresetLabels = {
  CUSTOM: '自定义',
  BUILD: '构建归档',
  DEPLOY: '部署构建产物',
  BUILD_DEPLOY: '构建并部署',
  VERIFY: '验证',
  MAINTENANCE: '维护',
  RELEASE_REVIEW: '发布审核',
} as const;
export type FlowPreset = keyof typeof flowPresetLabels;
export interface FlowBuildDefinition {
  repositoryId?: string;
  branch?: string;
  commitSha?: string;
  buildLocation?: 'TARGET' | 'MANAGER';
  artifactType?: 'FILE' | 'DOCKER_IMAGE';
  buildImage?: string;
  repoPath?: string;
  installCommand?: string;
  buildCommand?: string;
  outputPath?: string;
  dockerfilePath?: string;
  imageRepository?: string;
  registryId?: string;
}
export interface FlowDeployDefinition {
  deployPath?: string;
  startCommand?: string;
  stopCommand?: string;
  healthCheckCommand?: string;
  composeFilePath?: string;
}
export interface FlowDelivery {
  kind: FlowPreset;
  serviceId?: string;
  build?: FlowBuildDefinition;
  deploy?: FlowDeployDefinition;
}
export interface GraphNode {
  id: string;
  type: keyof typeof graphNodeLabels;
  name: string;
  message?: string;
  checkout?: {
    repositoryId?: string;
    mode: 'BRANCH' | 'COMMIT';
    branch?: string;
    commitSha?: string;
    fullClone?: boolean;
  };
  shell?: { command?: string; serverId?: string };
  delivery?: FlowDelivery;
  condition?: { key: 'input' | 'commitSha'; value: string };
  switch?: { key: 'input' | 'commitSha'; cases: string[] };
  delaySeconds?: number;
  approval?: { timeoutSeconds?: number };
  flowId?: string;
  position?: { x: number; y: number };
}
export interface GraphFlow {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphCanvas {
  nodes: GraphNode[];
  edges: GraphEdge[];
  endpoints: { startId: string; endId: string }[];
  templates: GraphNode[];
}
export interface GraphDocument {
  revision: number;
  publishedVersion: number | null;
  draft: { flows: GraphFlow[]; canvas?: GraphCanvas };
}
export interface GraphRun {
  id: string;
  flowId: string;
  flowName: string;
  version: number;
  status: string;
  taskId?: string;
  parentRunId?: string | null;
  createdAt: number;
  finishedAt: number | null;
}
export function graphKey(prefix: string) {
  // getRandomValues is available on the LAN HTTP test instance.
  return (
    prefix +
    '-' +
    Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
      n.toString(16).padStart(8, '0'),
    ).join('')
  );
}
export function sequence(nodes: GraphNode[]) {
  return { nodes, edges: nodes.slice(1).map((node, i) => ({ from: nodes[i].id, to: node.id })) };
}
export function orderedNodes(flow: GraphFlow) {
  const incoming = new Map(flow.nodes.map(({ id }) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const { from, to } of flow.edges) {
    if (!incoming.has(from) || !incoming.has(to)) continue;
    incoming.set(to, incoming.get(to)! + 1);
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }
  const ordered: GraphNode[] = [];
  const pending = flow.nodes.filter(({ id }) => !incoming.get(id));
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  for (const node of pending) {
    ordered.push(node);
    for (const target of outgoing.get(node.id) ?? []) {
      const left = incoming.get(target)! - 1;
      incoming.set(target, left);
      if (left === 0) pending.push(byId.get(target)!);
    }
  }
  const seen = new Set(ordered.map((n) => n.id));
  return [...ordered, ...flow.nodes.filter((n) => !seen.has(n.id))];
}

export function isDeliveryNode(node: GraphNode) {
  return node.type === 'BUILD' || node.type === 'DEPLOY_ARTIFACT';
}

export function branchOptions(
  node?: GraphNode,
): { value: NonNullable<GraphEdge['when']>; label: string }[] {
  if (node?.type === 'CONDITION')
    return [
      { value: 'TRUE', label: '成立' },
      { value: 'FALSE', label: '不成立' },
    ];
  if (node?.type === 'SWITCH')
    return [
      ...(node.switch?.cases ?? []).map((value, i) => ({
        value: `CASE:${i}` as const,
        label: value || `选项 ${i + 1}`,
      })),
      { value: 'DEFAULT', label: '默认' },
    ];
  return [];
}

export function branchLabel(when: GraphEdge['when'], node?: GraphNode) {
  return branchOptions(node).find((item) => item.value === when)?.label ?? when;
}
