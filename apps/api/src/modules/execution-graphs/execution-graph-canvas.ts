import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { redactTaskLog } from '../tasks/task-log.service';
import {
  orderedFlowNodes,
  validateGraphDefinition,
  type GraphCanvas,
  type GraphDefinition,
  type GraphEdge,
  type GraphFlow,
  type GraphNode,
} from './execution-graph-definition';

/** Present older drafts as one canvas while keeping the published flow IDs addressable. */
export function withDraftCanvas(
  definition: GraphDefinition,
): GraphDefinition & { canvas: GraphCanvas } {
  if (definition.canvas) return { ...definition, canvas: definition.canvas };
  const canvas: GraphCanvas = { nodes: [], edges: [], endpoints: [], templates: [] };
  const taken = new Set(definition.flows.map(({ id }) => id));
  for (const flow of definition.flows) {
    const ids = new Map<string, string>();
    for (const node of flow.nodes) {
      let id = node.id;
      if (node.type === 'START') {
        id = flow.id;
      } else {
        if (taken.has(id)) {
          const key = createHash('sha256')
            .update(JSON.stringify([flow.id, id]))
            .digest('hex')
            .slice(0, 24);
          let suffix = 1;
          do id = `canvas-${key}-${suffix++}`;
          while (taken.has(id));
        }
        taken.add(id);
      }
      ids.set(node.id, id);
      canvas.nodes.push({
        ...node,
        id,
        name: node.type === 'START' ? flow.name : node.name,
      });
      if (node.type === 'END') canvas.endpoints.push({ startId: flow.id, endId: id });
    }
    for (const edge of flow.edges)
      canvas.edges.push({ ...edge, from: ids.get(edge.from)!, to: ids.get(edge.to)! });
  }
  return { ...definition, canvas };
}

function validateCanvas(canvas: GraphCanvas) {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const ids = new Set([...canvas.nodes, ...canvas.templates].map(({ id }) => id));
  if (ids.size !== canvas.nodes.length + canvas.templates.length)
    throw new BadRequestException('画布节点和功能节点库中的 ID 必须唯一');
  const edges = new Map<string, GraphEdge[]>();
  for (const edge of canvas.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to || from.id === to.id)
      throw new BadRequestException('连线必须连接画布中两个不同的节点');
    if (to.type === 'START' || from.type === 'END')
      throw new BadRequestException('开始节点只允许出线，结束节点只允许入线');
    const outgoing = edges.get(from.id) ?? [];
    if (outgoing.some((existing) => existing.to === to.id))
      throw new BadRequestException('两个节点之间只能连接一条线');
    outgoing.push(edge);
    edges.set(from.id, outgoing);
  }
  const starts = new Set<string>();
  for (const { startId, endId } of canvas.endpoints) {
    if (byId.get(startId)?.type !== 'START' || byId.get(endId)?.type !== 'END')
      throw new BadRequestException('执行流必须配对画布中的开始节点和结束节点');
    if (starts.has(startId)) throw new BadRequestException('一个开始节点只能配对一个结束节点');
    starts.add(startId);
  }
  for (const node of [...canvas.nodes, ...canvas.templates]) {
    const text = [
      node.message,
      node.condition?.value,
      node.shell?.command,
      ...(node.switch?.cases ?? []),
    ];
    if (text.some((value) => value && redactTaskLog(value) !== value))
      throw new BadRequestException('节点配置包含明文凭据，请移除敏感值');
  }
  return { byId, edges };
}

function deriveFlow(
  start: GraphNode,
  endId: string,
  byId: ReadonlyMap<string, GraphNode>,
  edges: ReadonlyMap<string, GraphEdge[]>,
) {
  const visited = new Set<string>();
  const pending = [start.id];
  const flow: GraphFlow = { id: start.id, name: start.name, nodes: [], edges: [] };
  for (const id of pending) {
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id)!;
    flow.nodes.push(node);
    if (id === endId) continue;
    const outgoing = edges.get(id);
    if (node.type === 'END' || !outgoing?.length)
      throw new BadRequestException(
        `「${start.name}」的路径必须全部到达已配对的结束节点，请检查「${node.name}」`,
      );
    flow.edges.push(...outgoing);
    pending.push(...outgoing.map(({ to }) => to));
  }
  if (!visited.has(endId))
    throw new BadRequestException(`「${start.name}」没有通往所选结束节点的路径`);
  orderedFlowNodes(flow);
  return flow;
}

/** Derive runnable projections from canvas data without trusting client-supplied flows. */
export function compileCanvas(canvas: GraphCanvas, publish: boolean): GraphDefinition {
  const { byId, edges } = validateCanvas(canvas);
  const flows: GraphFlow[] = [];
  for (const { startId, endId } of canvas.endpoints) {
    try {
      flows.push(deriveFlow(byId.get(startId)!, endId, byId, edges));
    } catch (error) {
      if (publish || !(error instanceof BadRequestException)) throw error;
    }
  }
  const definition = { canvas, flows };
  if (publish) validateGraphDefinition(definition);
  return definition;
}
