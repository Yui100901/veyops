import type { GraphIssueLocation } from '../../api';

export const graphNodeLabels = {
  START: '开始',
  LOG: '记录日志',
  CHECKOUT: '代码拉取',
  LOAD_ENV: '加载变量文件',
  SHELL: 'Shell 脚本',
  CHECK: '检查与测试',
  BUILD: '构建',
  REGISTER_ARTIFACT: '登记产物',
  SOURCE_REVIEW: '源码审核',
  DEPLOY_ARTIFACT: '部署',
  HEALTH_CHECK: '发布健康检查',
  ROLLBACK_ARTIFACT: '按产物回滚',
  CONDITION: '条件分支',
  SWITCH: '多路判断',
  DELAY: '固定延时',
  APPROVAL: '人工审批',
  PARALLEL: '并行分支',
  JOIN: '汇合',
  FLOW_CALL: '调用执行流',
  END: '结束',
  FUNCTION: '自定义节点',
};
export type GraphOperation = Exclude<
  keyof typeof graphNodeLabels,
  'FUNCTION' | 'START' | 'END' | 'CONDITION' | 'SWITCH'
>;
export const graphOperations = Object.keys(graphNodeLabels).filter(
  (type) =>
    ![
      'FUNCTION',
      'START',
      'END',
      'CONDITION',
      'SWITCH',
      'LOG',
      'REGISTER_ARTIFACT',
      'PARALLEL',
      'JOIN',
      'FLOW_CALL',
    ].includes(type),
) as GraphOperation[];
export interface GraphEdge {
  from: string;
  to: string;
  when?: 'TRUE' | 'FALSE' | 'DEFAULT' | 'SUCCESS' | 'PARTIAL_SUCCESS' | `CASE:${string}`;
}
export type GraphFieldType =
  | 'TEXT'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'REPOSITORY'
  | 'GIT_REF'
  | 'GIT_FETCH_MODE'
  | 'ENVIRONMENT'
  | 'ENVIRONMENT_SET'
  | 'SERVICE'
  | 'TARGETS'
  | 'ARTIFACT'
  | 'PATH'
  | 'IMAGE'
  | 'WORKSPACE'
  | 'SOURCE'
  | 'RELEASE'
  | 'REVIEW'
  | 'REPORT'
  | 'CREDENTIAL'
  | 'VARIABLES';
export type GraphArtifactType = 'FILE' | 'DIRECTORY' | 'DOCKER_IMAGE';
export interface GraphField {
  id: string;
  name: string;
  referenceName?: string;
  exportName?: string;
  type: GraphFieldType;
  required?: boolean;
  multiple?: boolean;
  runtimeOverride?: boolean;
  purpose?: 'BUILD_TARGETS' | 'RELEASE_TARGETS';
  defaultValue?: unknown;
  selection?: 'LATEST_COMPATIBLE';
  artifactType?: GraphArtifactType;
  acceptedArtifactTypes?: GraphArtifactType[];
  source?: 'CURRENT_RUN';
  options?: (string | number | boolean)[];
  acceptedTypes?: GraphFieldType[];
}
export type GraphMissingPolicy = 'ERROR' | 'OMIT' | 'USE_DEFAULT' | 'REPOSITORY_DEFAULT';
export type GraphValueProjection =
  'WORKSPACE_PATH' | 'ARTIFACT_PATH' | 'IMAGE_NAME' | 'IMAGE_ID' | 'IMAGE_DIGEST';
export const graphProjectionLabels: Record<GraphValueProjection, string> = {
  WORKSPACE_PATH: '代码目录',
  ARTIFACT_PATH: '产物路径',
  IMAGE_NAME: '镜像名称',
  IMAGE_ID: '镜像 ID',
  IMAGE_DIGEST: '镜像 Digest',
};
export type GraphBinding = { onMissing?: GraphMissingPolicy } & (
  | { kind: 'INPUT' | 'CONTEXT' | 'NODE_INPUT'; fieldId: string }
  | { kind: 'OUTPUT'; nodeId: string; fieldId: string }
  | { kind: 'VALUE'; value: unknown }
  | { kind: 'ENVIRONMENT_KEY'; key: string }
  | { kind: 'CREDENTIAL'; credentialId: string }
  | { kind: 'AS_GIT_REF'; refKind: 'BRANCH' | 'TAG'; source: GraphBinding }
  | {
      kind: 'PROJECT_VALUE';
      source: { kind: 'OUTPUT'; nodeId: string; fieldId: string };
      projection: GraphValueProjection;
      serverId?: string;
    }
  | { kind: 'FIRST_AVAILABLE'; sources: GraphBinding[] }
);
export interface GraphCandidate {
  label: string;
  referenceName: string;
  field: GraphField;
  binding: GraphBinding;
  availability: 'ALWAYS' | 'CONDITIONAL';
  branches: string[];
}
export interface GraphNodeDirectory {
  inputs: GraphField[];
  outputs: GraphField[];
  candidates: GraphCandidate[];
  automaticInputBindings?: Record<string, GraphBinding>;
}
export interface GraphFieldSource {
  kind: string;
  nodeId?: string;
  fieldId?: string;
  key?: string;
  eventField?: string;
  transform?: 'BRANCH' | 'TAG';
}
export interface GraphFieldEvidence {
  fieldId: string;
  name: string;
  type: GraphFieldType;
  state: 'RESOLVED' | 'DEFERRED' | 'OMITTED' | 'DEFAULTED' | 'ERROR';
  source?: GraphFieldSource;
  onMissing?: GraphMissingPolicy;
  value?: unknown;
  sensitive?: boolean;
  message?: string;
}
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
  scriptInputTypes?: GraphFieldType[];
  scriptOutputTypes?: GraphFieldType[];
  contextFields?: GraphField[];
  modules: Partial<Record<GraphNode['type'], GraphModule>>;
  flows?: Record<string, { nodes: Record<string, GraphNodeDirectory> }>;
  flowTemplates?: GraphFlowTemplate[];
}
export interface GraphFlowTemplate {
  id: string;
  name: string;
  steps: string[];
  artifactTypes: GraphArtifactType[];
}
export interface GraphFlowExpansion {
  startId: string;
  canvas: GraphCanvas;
}
export interface GraphIssue extends GraphIssueLocation {
  flowId?: string;
  nodeId?: string;
  fieldId?: string;
  sourceNodeId?: string;
  sourceFieldId?: string;
  branchId?: string;
  edge?: GraphEdge;
  code?: string;
  severity?: 'ERROR' | 'WARNING' | 'INFO';
  message: string;
}
export interface GraphArtifactOutput {
  id?: string;
  name: string;
  referenceName?: string;
  type: GraphArtifactType;
  path?: string;
  pathInput?: string;
  imageReference?: string;
  composeFilePath?: string;
  required?: boolean;
  persist?: boolean;
}
export interface FlowBuildDefinition {
  dependencies?: string[];
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
  method?: 'FILE' | 'COMPOSE';
  composeSource?:
    | { kind: 'ARTIFACT' }
    | { kind: 'REPOSITORY_FILE'; repositoryId: string; commitSha: string; path: string };
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
  artifacts?: GraphArtifactOutput[];
}
export type GraphEnvironmentSet =
  | { mode: 'NONE' }
  | { mode: 'FIXED'; environmentSetId?: string }
  | { mode: 'INPUT'; fieldId?: string };

export type GraphEnvironmentSetSummary = { id: string; name: string; revision: number };

export interface GraphNode {
  id: string;
  type: keyof typeof graphNodeLabels;
  contract?: 'PRESET';
  operation?: GraphOperation;
  inputDefaults?: Record<string, unknown>;
  environmentDefaults?: Record<string, string>;
  name: string;
  referenceName?: string;
  message?: string;
  checkout?: {
    repositoryId?: string;
    mode?: 'BRANCH' | 'TAG' | 'COMMIT';
    branch?: string;
    tag?: string;
    commitSha?: string;
    fullClone?: boolean;
  };
  shell?: GraphShell;
  loadEnvironment?: {
    envFile?: string;
    directory?: string;
    required?: boolean;
    pathRule?: { key: string; paths: Record<string, string> };
  };
  environmentSet?: GraphEnvironmentSet;
  registerArtifacts?: { artifacts?: GraphArtifactOutput[] };
  build?: FlowBuildDefinition;
  deploy?: FlowDeployDefinition;
  inputs?: GraphField[];
  outputs?: GraphField[];
  moduleId?: string;
  moduleVersion?: number;
  condition?: { key: 'input' | 'commitSha'; value: string };
  branch?: { cases: { id: string; value: string; label?: string }[] };
  switch?: { key: 'input' | 'commitSha'; cases: string[] };
  delaySeconds?: number;
  approval?: { timeoutSeconds?: number; releaseNodeId?: string; buildNodeId?: string };
  healthCheck?: { command?: string; timeoutSeconds?: number; requireHealthy?: boolean };
  flowId?: string;
  position?: { x: number; y: number };
}

export function effectiveNodeType(node: Pick<GraphNode, 'type' | 'operation'>) {
  return node.type === 'FUNCTION' ? (node.operation ?? 'SHELL') : node.type;
}

export function graphNodeTypeLabel(node: Pick<GraphNode, 'type' | 'operation'>) {
  return graphNodeLabels[effectiveNodeType(node)];
}

export function graphNodeFamily(node: Pick<GraphNode, 'type'>) {
  if (node.type === 'START' || node.type === 'END') return 'boundary';
  if (node.type === 'CONDITION' || node.type === 'SWITCH') return 'condition';
  return 'function';
}
export interface FlowBindings {
  serviceId?: string;
  inputBindings?: Record<string, Record<string, GraphBinding>>;
  environmentBindings?: Record<string, Record<string, GraphBinding>>;
  outputBindings?: Record<string, GraphBinding>;
  edgeSelections?: Record<string, string[]>;
}
export interface GraphFlow extends FlowBindings {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  compiled?: { nodes: Record<string, { inputBindings?: Record<string, GraphBinding> }> };
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
  return effectiveNodeType(node) === 'BUILD' || isReleaseNode(node);
}

export function isReleaseNode(node: { type: string; operation?: GraphOperation }) {
  const type = node.type === 'FUNCTION' ? node.operation : node.type;
  return type === 'DEPLOY_ARTIFACT' || type === 'ROLLBACK_ARTIFACT';
}

export function graphDynamicOutlets(node: GraphNode, edges: readonly GraphEdge[]) {
  return (
    ['CONDITION', 'SWITCH', 'PARALLEL'].includes(effectiveNodeType(node)) ||
    (isReleaseNode(node) &&
      edges.some(({ when }) => when === 'SUCCESS' || when === 'PARTIAL_SUCCESS'))
  );
}

export function branchOptions(
  node?: GraphNode,
): { value: NonNullable<GraphEdge['when']>; label: string }[] {
  if (node && isReleaseNode(node))
    return [
      { value: 'SUCCESS', label: '全部发布成功' },
      { value: 'PARTIAL_SUCCESS', label: '部分发布成功' },
    ];
  if (node?.type === 'CONDITION' && node.branch)
    return [
      ...node.branch.cases.map(({ id, label, value }, index) => ({
        value: `CASE:${id}` as const,
        label: label || value || `规则 ${index + 1}`,
      })),
      { value: 'DEFAULT', label: '默认' },
    ];
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
