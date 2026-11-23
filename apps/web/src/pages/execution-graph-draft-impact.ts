import { effectiveNodeType } from './execution-graph-definition';
import type {
  GraphBinding,
  GraphCanvas,
  GraphEdge,
  GraphEndpoint,
  GraphField,
  GraphNode,
} from './execution-graph-definition';

export function reachable(
  canvas: GraphCanvas,
  origin: string,
  reversed = false,
  stopAtBoundary = true,
) {
  const boundaries = new Set(
    canvas.nodes.filter(({ type }) => type === 'START' || type === 'END').map(({ id }) => id),
  );
  const pending = [origin];
  const visited = new Set(pending);
  const next = new Map<string, string[]>();
  for (const edge of canvas.edges) {
    const from = reversed ? edge.to : edge.from;
    const to = reversed ? edge.from : edge.to;
    const neighbors = next.get(from);
    if (neighbors) neighbors.push(to);
    else next.set(from, [to]);
  }
  for (const from of pending) {
    if (stopAtBoundary && from !== origin && boundaries.has(from)) continue;
    for (const to of next.get(from) ?? []) {
      if (visited.has(to)) continue;
      visited.add(to);
      pending.push(to);
    }
  }
  return visited;
}

function selectedEdge(pair: GraphEndpoint, edge: GraphEdge) {
  const selection = pair.edgeSelections?.[edge.from];
  return !selection?.length || selection.includes(edge.to);
}

export function pathHighlight(canvas: GraphCanvas, startId?: string) {
  const pair = canvas.endpoints.find((value) => value.startId === startId);
  if (!pair) return undefined;
  const pathCanvas = { ...canvas, edges: canvas.edges.filter((edge) => selectedEdge(pair, edge)) };
  const forward = reachable(pathCanvas, pair.startId);
  if (!forward.has(pair.endId)) return undefined;
  const ancestors = reachable(pathCanvas, pair.endId, true);
  const nodes = new Set([...forward].filter((id) => ancestors.has(id)));
  const edges = new Set<number>();
  canvas.edges.forEach((edge, index) => {
    if (
      nodes.has(edge.from) &&
      nodes.has(edge.to) &&
      edge.from !== pair.endId &&
      edge.to !== pair.startId &&
      selectedEdge(pair, edge)
    )
      edges.add(index);
  });
  return { nodes, edges };
}

function flowRoute(canvas: GraphCanvas, pair: GraphEndpoint) {
  const allowed = canvas.edges.filter((edge) => selectedEdge(pair, edge));
  const ancestors = reachable({ ...canvas, edges: allowed }, pair.endId, true);
  const types = new Map(canvas.nodes.map((node) => [node.id, effectiveNodeType(node)]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of allowed) {
    const choices = outgoing.get(edge.from);
    if (choices) choices.push(edge);
    else outgoing.set(edge.from, [edge]);
  }
  const nodes = new Set([pair.startId, pair.endId]);
  const edges: GraphEdge[] = [];
  const pending = new Set([pair.startId]);
  for (const from of pending) {
    const type = types.get(from);
    if (!type || from === pair.endId || type === 'END') continue;
    const choices = outgoing.get(from) ?? [];
    const toEnd = choices.filter(({ to }) => ancestors.has(to));
    // Dynamic branches must reach the paired end even when one branch is unfinished.
    const dynamic = type === 'CONDITION' || type === 'SWITCH' || type === 'PARALLEL';
    const active = dynamic || !toEnd.length ? choices : toEnd;
    for (const edge of active) {
      edges.push(edge);
      nodes.add(edge.to);
      pending.add(edge.to);
    }
  }
  return { nodes, edges };
}

function topology(canvas: GraphCanvas, pair: GraphEndpoint) {
  const route = flowRoute(canvas, pair);
  return JSON.stringify([
    pair.endId,
    route.edges.map(({ from, to, when }) => JSON.stringify([from, to, when])).sort(),
    Object.entries(pair.edgeSelections ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

export function changedTopologyFlows(before: GraphCanvas, after: GraphCanvas): string[] {
  const previous = new Map(before.endpoints.map((pair) => [pair.startId, topology(before, pair)]));
  const next = new Map(after.endpoints.map((pair) => [pair.startId, topology(after, pair)]));
  return [...new Set([...previous.keys(), ...next.keys()])].filter(
    (startId) => previous.get(startId) !== next.get(startId),
  );
}

function refersToOutput(binding: GraphBinding, nodeId: string): boolean {
  switch (binding.kind) {
    case 'OUTPUT':
      return binding.nodeId === nodeId;
    case 'AS_GIT_REF':
    case 'PROJECT_VALUE':
      return refersToOutput(binding.source, nodeId);
    case 'FIRST_AVAILABLE':
      return binding.sources.some((source) => refersToOutput(source, nodeId));
    default:
      return false;
  }
}

function bindingsUseNode(pair: GraphEndpoint, nodeId: string) {
  if (
    pair.inputBindings?.[nodeId] ||
    pair.environmentBindings?.[nodeId] ||
    pair.edgeSelections?.[nodeId]
  )
    return true;
  const nodes = [
    ...Object.values(pair.inputBindings ?? {}),
    ...Object.values(pair.environmentBindings ?? {}),
  ];
  return [
    ...nodes.flatMap((bindings) => Object.values(bindings)),
    ...Object.values(pair.outputBindings ?? {}),
  ].some((binding) => refersToOutput(binding, nodeId));
}

export function flowsUsingNode(canvas: GraphCanvas, nodeId: string): string[] {
  return canvas.endpoints
    .filter((pair) => bindingsUseNode(pair, nodeId) || flowRoute(canvas, pair).nodes.has(nodeId))
    .map(({ startId }) => startId);
}

function fieldContracts(fields: readonly GraphField[] = []) {
  return fields.map((field) => [
    field.id,
    field.type,
    field.referenceName ?? field.id,
    field.exportName ?? field.id,
    field.required !== false,
    Boolean(field.multiple),
    field.artifactType,
    field.selection,
    field.source,
    field.options,
  ]);
}

function nodeContract(node: GraphNode) {
  const artifacts = node.build?.artifacts ?? node.registerArtifacts?.artifacts ?? [];
  return JSON.stringify([
    effectiveNodeType(node),
    node.moduleId,
    node.moduleVersion,
    fieldContracts(node.inputs),
    fieldContracts(node.outputs),
    fieldContracts(node.shell?.params),
    node.shell?.location,
    node.build?.buildLocation,
    node.build?.dependencies ?? [],
    artifacts.map(({ name, type, required, persist }) => [name, type, required, persist]),
    node.approval?.buildNodeId,
    node.approval?.releaseNodeId,
    node.switch?.cases,
    node.flowId,
  ]);
}

export function changedNodeContract(before: GraphNode, after: GraphNode): boolean {
  return nodeContract(before) !== nodeContract(after);
}
