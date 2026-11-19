export const graphNodeLabels = {
  START: '开始',
  LOG: '记录日志',
  BUILD: '构建并归档',
  DEPLOY_ARTIFACT: '部署历史产物',
  CONDITION: '条件判断',
  PARALLEL: '并行分支',
  JOIN: '汇合',
  FLOW_CALL: '调用执行流',
  END: '结束',
};
export interface GraphEdge {
  from: string;
  to: string;
  when?: 'TRUE' | 'FALSE';
}
export interface GraphNode {
  id: string;
  type: keyof typeof graphNodeLabels;
  name: string;
  message?: string;
  pipelineId?: string;
  pipelineVersion?: number;
  condition?: { key: 'input' | 'commitSha'; value: string };
  flowId?: string;
  position?: { x: number; y: number };
}
export interface GraphFlow {
  id: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface GraphDocument {
  revision: number;
  publishedVersion: number | null;
  draft: { flows: GraphFlow[] };
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
