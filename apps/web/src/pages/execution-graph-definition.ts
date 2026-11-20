export const graphNodeLabels = {
  START: '开始',
  LOG: '记录日志',
  CHECKOUT: '代码拉取',
  LOAD_ENV: '加载环境',
  SHELL: 'Shell 脚本',
  CHECK: '代码检查',
  BUILD: '构建并归档',
  REGISTER_ARTIFACT: '登记产物',
  DEPLOY_ARTIFACT: '部署产物',
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
export type GraphFieldType =
  | 'TEXT'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'REPOSITORY'
  | 'GIT_REF'
  | 'ENVIRONMENT'
  | 'SERVICE'
  | 'TARGETS'
  | 'ARTIFACT'
  | 'PATH'
  | 'IMAGE'
  | 'WORKSPACE'
  | 'SOURCE'
  | 'RELEASE'
  | 'REPORT'
  | 'CREDENTIAL'
  | 'VARIABLES';
export type GraphArtifactType = 'FILE' | 'DIRECTORY' | 'DOCKER_IMAGE';
export interface GraphField {
  id: string;
  name: string;
  type: GraphFieldType;
  required?: boolean;
  multiple?: boolean;
  defaultValue?: unknown;
  selection?: 'LATEST_COMPATIBLE';
  artifactType?: GraphArtifactType;
  source?: 'CURRENT_RUN';
  options?: (string | number | boolean)[];
  acceptedTypes?: GraphFieldType[];
}
export type GraphBinding =
  | { kind: 'INPUT' | 'CONTEXT'; fieldId: string }
  | { kind: 'OUTPUT'; nodeId: string; fieldId: string }
  | { kind: 'VALUE'; value: unknown }
  | { kind: 'FIRST_AVAILABLE'; sources: GraphBinding[] };
export interface GraphModule {
  id: string;
  version: number;
  inputs: GraphField[];
  outputs: GraphField[];
}
export interface GraphCatalog {
  fieldTypes: Record<GraphFieldType, string>;
  inputPresets: GraphField[];
  outputPresets: GraphField[];
  contextFields?: GraphField[];
  modules: Partial<Record<GraphNode['type'], GraphModule>>;
}
export interface GraphIssue {
  flowId?: string;
  nodeId?: string;
  fieldId?: string;
  message: string;
}
export interface GraphArtifactOutput {
  name: string;
  type: GraphArtifactType;
  path?: string;
  imageReference?: string;
  composeFilePath?: string;
  required?: boolean;
}
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
  artifacts?: GraphArtifactOutput[];
}
export interface FlowDeployDefinition {
  deployPath?: string;
  startCommand?: string;
  stopCommand?: string;
  healthCheckCommand?: string;
  composeFilePath?: string;
}
interface GraphShell {
  command?: string;
  serverId?: string;
  timeout?: number;
  location?: 'MANAGER' | 'TARGET';
  directory?: string;
  continueOnFailure?: boolean;
  params?: GraphField[];
}
export interface GraphNode {
  id: string;
  type: keyof typeof graphNodeLabels;
  name: string;
  message?: string;
  checkout?: {
    repositoryId?: string;
    mode: 'BRANCH' | 'TAG' | 'COMMIT';
    branch?: string;
    tag?: string;
    commitSha?: string;
    fullClone?: boolean;
  };
  shell?: GraphShell;
  loadEnvironment?: { envFile?: string; directory?: string };
  registerArtifacts?: { artifacts?: GraphArtifactOutput[] };
  build?: FlowBuildDefinition;
  deploy?: FlowDeployDefinition;
  inputs?: GraphField[];
  outputs?: GraphField[];
  moduleId?: string;
  moduleVersion?: number;
  condition?: { key: 'input' | 'commitSha'; value: string };
  switch?: { key: 'input' | 'commitSha'; cases: string[] };
  delaySeconds?: number;
  approval?: { timeoutSeconds?: number };
  flowId?: string;
  position?: { x: number; y: number };
}
export interface FlowBindings {
  serviceId?: string;
  inputBindings?: Record<string, Record<string, GraphBinding>>;
  outputBindings?: Record<string, GraphBinding>;
  edgeSelections?: Record<string, string[]>;
}
export interface GraphFlow extends FlowBindings {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphEndpoint extends FlowBindings {
  startId: string;
  endId: string;
}
export interface GraphCanvas {
  nodes: GraphNode[];
  edges: GraphEdge[];
  endpoints: GraphEndpoint[];
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
  outputs?: Record<string, unknown>;
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
