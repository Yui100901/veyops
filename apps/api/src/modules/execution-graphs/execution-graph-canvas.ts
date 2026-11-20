import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { redactTaskLog } from '../tasks/task-log.service';
import {
  annotateGraphIssue,
  orderedFlowNodes,
  validateGraphDefinition,
  type GraphCanvas,
  type GraphDefinition,
  type GraphEdge,
  type GraphEndpoint,
  type GraphFlow,
  type GraphNode,
} from './execution-graph-definition';
import {
  GraphCompileError,
  graphModulePorts,
  graphRecord,
  safeGraphId,
  type GraphDiagnostic,
} from './graph-fields';

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
      node.build?.installCommand,
      node.build?.buildCommand,
      node.deploy?.startCommand,
      node.deploy?.stopCommand,
      node.deploy?.healthCheckCommand,
      ...(node.switch?.cases ?? []),
    ];
    if (text.some((value) => value && redactTaskLog(value) !== value))
      throw new BadRequestException('节点配置包含明文凭据，请移除敏感值');
  }
  return { byId, edges };
}

const dynamicBranch = (node: GraphNode) =>
  node.type === 'CONDITION' || node.type === 'SWITCH' || node.type === 'PARALLEL';

function deriveFlow(
  start: GraphNode,
  endpoint: GraphEndpoint,
  byId: ReadonlyMap<string, GraphNode>,
  edges: ReadonlyMap<string, GraphEdge[]>,
) {
  const { endId, inputBindings, outputBindings, edgeSelections, serviceId } = endpoint;
  const flow: GraphFlow = {
    id: start.id,
    name: start.name,
    nodes: [],
    edges: [],
    ...(serviceId !== undefined && { serviceId }),
    ...(inputBindings !== undefined && { inputBindings }),
    ...(outputBindings !== undefined && { outputBindings }),
    ...(edgeSelections !== undefined && { edgeSelections }),
  };
  // Sibling paths can lead to other flows' END nodes. Fixed selections further
  // constrain ordinary branches; control nodes retain all declared outcomes.
  const selections = edgeSelections ?? {};
  const issue = (node: GraphNode, message: string): never => {
    throw new GraphCompileError({
      flowId: flow.id,
      nodeId: node.id,
      message: `「${flow.name}」 → 「${node.name}」 · ${message}`,
    });
  };
  if (!graphRecord(selections)) issue(start, '选线配置无效');
  for (const [id, targets] of Object.entries(selections)) {
    const node = byId.get(id);
    if (
      !safeGraphId(id) ||
      !node ||
      dynamicBranch(node) ||
      node.type === 'END' ||
      !Array.isArray(targets) ||
      targets.length !== 1 ||
      !edges.get(id)?.some((edge) => edge.to === targets[0])
    )
      issue(node ?? start, '固定选线必须指向已有的一条普通出线');
  }
  const allowed = (id: string) =>
    Object.hasOwn(selections, id)
      ? (edges.get(id) ?? []).filter((edge) => edge.to === selections[id]?.[0])
      : (edges.get(id) ?? []);
  const reverse = new Map<string, string[]>();
  for (const id of byId.keys())
    for (const { to } of allowed(id)) {
      const predecessors = reverse.get(to) ?? [];
      predecessors.push(id);
      reverse.set(to, predecessors);
    }
  const toEnd = new Set([endId]);
  const incoming = [endId];
  for (const id of incoming)
    for (const source of reverse.get(id) ?? []) {
      if (!toEnd.has(source)) {
        toEnd.add(source);
        incoming.push(source);
      }
    }
  const visited = new Set<string>();
  const pending = [start.id];
  for (const id of pending) {
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id)!;
    flow.nodes.push(node);
    if (id === endId) continue;
    const outgoing = dynamicBranch(node)
      ? allowed(id)
      : allowed(id).filter((edge) => toEnd.has(edge.to));
    if (node.type === 'END' || !outgoing.length)
      issue(node, '路径必须全部到达已配对的结束节点，请检查连线');
    if (!dynamicBranch(node) && outgoing.length > 1)
      issue(node, '多条出线均可到达所选结束节点，请在此执行流明确选择出线');
    flow.edges.push(...outgoing);
    pending.push(...outgoing.map(({ to }) => to));
  }
  if (!visited.has(endId))
    throw new BadRequestException(`「${start.name}」没有通往所选结束节点的路径`);
  for (const id of Object.keys(selections))
    if (!visited.has(id)) issue(byId.get(id)!, '固定选线所属节点不在此执行流的有效路径中');
  try {
    orderedFlowNodes(flow);
  } catch (error) {
    annotateGraphIssue(error, flow);
  }
  return flow;
}

/** Derive runnable projections from canvas data without trusting client-supplied flows. */
export function compileCanvas(canvas: GraphCanvas, publish: boolean): GraphDefinition {
  const { byId, edges } = validateCanvas(canvas);
  const flows: GraphFlow[] = [];
  for (const endpoint of canvas.endpoints) {
    try {
      flows.push(deriveFlow(byId.get(endpoint.startId)!, endpoint, byId, edges));
    } catch (error) {
      if (publish || !(error instanceof BadRequestException)) throw error;
    }
  }
  const definition = { canvas, flows };
  if (publish) {
    validateGraphDefinition(definition);
    for (const flow of flows) {
      flow.nodes = flow.nodes.map((node) => {
        const module = graphModulePorts(node);
        return module ? { ...node, moduleId: module.id, moduleVersion: module.version } : node;
      });
    }
  }
  return definition;
}

export function canvasIssues(canvas: GraphCanvas): GraphDiagnostic[] {
  try {
    compileCanvas(canvas, true);
    return [];
  } catch (error) {
    if (error instanceof GraphCompileError) return [error.issue];
    if (!(error instanceof BadRequestException)) throw error;
    return [{ message: error.message }];
  }
}
