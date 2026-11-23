import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { redactTaskLog } from '../tasks/task-log.service';
import { flowCandidateCatalog } from './graph-binding-validation';
import {
  annotateGraphIssue,
  graphDynamicOutlets,
  orderedFlowNodes,
  runtimeGraphNode,
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
  safeGraphReference,
  type GraphDiagnostic,
} from './graph-fields';

const reservedReferenceNames = new Set(['start', 'env', 'trigger', 'context']);

function withNodeReferences(canvas: GraphCanvas) {
  const used = new Set([
    ...reservedReferenceNames,
    ...[...canvas.nodes, ...canvas.templates].flatMap(({ referenceName }) =>
      typeof referenceName === 'string' ? [referenceName.toLowerCase()] : [],
    ),
  ]);
  const assign = (node: GraphNode) => {
    if (node.referenceName) return node;
    const slug = node.type.toLowerCase().replace(/_/g, '-');
    const base = slug + '-' + node.id.slice(0, 20);
    let referenceName = base;
    let suffix = 2;
    while (used.has(referenceName.toLowerCase())) referenceName = base + '-' + suffix++;
    used.add(referenceName.toLowerCase());
    return { ...node, referenceName };
  };
  return { ...canvas, nodes: canvas.nodes.map(assign), templates: canvas.templates.map(assign) };
}

function validateNodeReferences(canvas: GraphCanvas, flows: GraphFlow[]) {
  for (const node of [...canvas.nodes, ...canvas.templates]) {
    if (!safeGraphReference(node.referenceName) || reservedReferenceNames.has(node.referenceName!.toLowerCase()))
      throw new GraphCompileError({
        flowId: flows.find((flow) => flow.nodes.some(({ id }) => id === node.id))?.id,
        nodeId: node.id,
        fieldId: 'referenceName',
        severity: 'ERROR',
        message: '节点引用名无效或已被系统保留',
      });
  }
}

/** Present older drafts as one canvas while keeping the published flow IDs addressable. */
export function withDraftCanvas(
  definition: GraphDefinition,
): GraphDefinition & { canvas: GraphCanvas } {
  if (definition.canvas) return { ...definition, canvas: withNodeReferences(definition.canvas) };
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
  return { ...definition, canvas: withNodeReferences(canvas) };
}

function validateCanvas(canvas: GraphCanvas) {
  const byId = new Map(canvas.nodes.map((node) => [node.id, runtimeGraphNode(node)]));
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
    if (outgoing.some((existing) => existing.to === to.id && existing.when === edge.when))
      throw new GraphCompileError({ nodeId: from.id, edge, message: '相同出口不能重复连接同一节点' });
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
      ...(node.branch?.cases ?? []).map(({ value, label }) => [value, label]).flat(),
      node.shell?.command,
      node.build?.installCommand,
      node.build?.buildCommand,
      node.deploy?.startCommand,
      node.deploy?.stopCommand,
      node.deploy?.healthCheckCommand,
      JSON.stringify(node.inputDefaults),
      JSON.stringify(node.environmentDefaults),
      ...(node.type === 'FUNCTION'
        ? [...(node.inputs ?? []), ...(node.outputs ?? [])].map(({ defaultValue }) =>
            JSON.stringify(defaultValue),
          )
        : []),
      ...(node.switch?.cases ?? []),
    ];
    if (text.some((value) => value && redactTaskLog(value) !== value))
      throw new BadRequestException('节点配置包含明文凭据，请移除敏感值');
  }
  canvas.templates.forEach(runtimeGraphNode);
  return { byId, edges };
}

function flowScope(endpoint: GraphEndpoint, edges: ReadonlyMap<string, GraphEdge[]>) {
  const selections = graphRecord(endpoint.edgeSelections) ? endpoint.edgeSelections : {};
  const allowed = (id: string) => {
    const selected = selections[id];
    const outgoing = edges.get(id) ?? [];
    return Array.isArray(selected) ? outgoing.filter(({ to }) => selected.includes(to)) : outgoing;
  };
  const reverse = new Map<string, string[]>();
  for (const id of edges.keys())
    for (const { to } of allowed(id)) {
      const predecessors = reverse.get(to) ?? [];
      predecessors.push(id);
      reverse.set(to, predecessors);
    }
  const toEnd = new Set([endpoint.endId]);
  for (const id of toEnd)
    for (const source of reverse.get(id) ?? []) toEnd.add(source);

  const route = new Set([endpoint.startId]);
  const included = new Set<GraphEdge>();
  for (const id of route)
    for (const edge of allowed(id)) {
      if (!toEnd.has(edge.to)) continue;
      route.add(edge.to);
      included.add(edge);
    }
  return { allowed, toEnd, included };
}

function deriveFlow(
  start: GraphNode,
  endpoint: GraphEndpoint,
  byId: ReadonlyMap<string, GraphNode>,
  edges: ReadonlyMap<string, GraphEdge[]>,
  scope: ReturnType<typeof flowScope>,
  owners: ReadonlySet<GraphEdge>,
) {
  const { endId, inputBindings, environmentBindings, outputBindings, edgeSelections, serviceId } =
    endpoint;
  const flow: GraphFlow = {
    id: start.id,
    name: start.name,
    nodes: [],
    edges: [],
    ...(serviceId !== undefined && { serviceId }),
    ...(inputBindings !== undefined && { inputBindings }),
    ...(environmentBindings !== undefined && { environmentBindings }),
    ...(outputBindings !== undefined && { outputBindings }),
    ...(edgeSelections !== undefined && { edgeSelections }),
  };
  const selections = edgeSelections ?? {};
  const issue = (node: GraphNode, message: string, edge?: GraphEdge): never => {
    throw new GraphCompileError({
      flowId: flow.id,
      nodeId: node.id,
      edge,
      message: `「${flow.name}」 → 「${node.name}」 · ${message}`,
    });
  };
  if (!graphRecord(selections)) issue(start, '选线配置无效');
  for (const [id, targets] of Object.entries(selections)) {
    const node = byId.get(id);
    if (
      !safeGraphId(id) ||
      !node ||
      graphDynamicOutlets(node, edges.get(id)) ||
      node.type === 'END' ||
      !Array.isArray(targets) ||
      !targets.length ||
      targets.length !== new Set(targets).size ||
      !targets.every((target) => edges.get(id)?.some((edge) => edge.to === target && !edge.when))
    )
      issue(node ?? start, '固定选线必须指向一条或多条已有的普通出线');
  }
  const { allowed, toEnd } = scope;
  const visited = new Set<string>();
  const pending = [start.id];
  for (const id of pending) {
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id)!;
    flow.nodes.push(node);
    if (id === endId) continue;
    const outgoing = allowed(id);
    const dynamic = graphDynamicOutlets(node, edges.get(id));
    const outside = outgoing.find(
      (edge) => !toEnd.has(edge.to) && (dynamic || Object.hasOwn(selections, id) || !owners.has(edge)),
    );
    if (outside)
      issue(node, `通往「${byId.get(outside.to)!.name}」的出线无法到达已配对的结束节点。路径必须全部到达对应结束，请检查连线或配置执行流范围`, outside);
    const included = outgoing.filter((edge) => toEnd.has(edge.to));
    if (node.type === 'END' || !included.length)
      issue(node, '路径必须全部到达已配对的结束节点，请检查连线');
    flow.edges.push(...included);
    pending.push(...included.map(({ to }) => to));
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
export function compileCanvas(input: GraphCanvas, publish: boolean): GraphDefinition {
  const canvas = withNodeReferences(input);
  const { byId, edges } = validateCanvas(canvas);
  const scopes = canvas.endpoints.map((endpoint) => flowScope(endpoint, edges));
  const owners = new Set(scopes.flatMap(({ included }) => [...included]));
  const flows: GraphFlow[] = [];
  for (const [index, endpoint] of canvas.endpoints.entries()) {
    try {
      flows.push(deriveFlow(byId.get(endpoint.startId)!, endpoint, byId, edges, scopes[index]!, owners));
    } catch (error) {
      if (publish || !(error instanceof BadRequestException)) throw error;
    }
  }
  const definition = { canvas, flows };
  if (publish) {
    validateNodeReferences(canvas, flows);
    const compiled = validateGraphDefinition(definition);
    for (const flow of flows) {
      flow.compiled = compiled[flow.id];
      flow.nodes = flow.nodes.map((node) => {
        const module = graphModulePorts(node);
        return module ? { ...node, moduleId: module.id, moduleVersion: module.version } : node;
      });
    }
  }
  return definition;
}

export function canvasCatalog(canvas: GraphCanvas, flowId: string, nodeId: string) {
  const { flows } = compileCanvas(canvas, false);
  const flow = flows.find(({ id }) => id === flowId);
  return flow
    ? { [flow.id]: flowCandidateCatalog(flow, flows, orderedFlowNodes(flow), nodeId) }
    : {};
}

export function canvasIssues(canvas: GraphCanvas): GraphDiagnostic[] {
  try {
    compileCanvas(canvas, true);
    return [];
  } catch (error) {
    if (error instanceof GraphCompileError) return error.issues;
    if (!(error instanceof BadRequestException)) throw error;
    return [{ message: error.message }];
  }
}
