import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Copy, Plus, Trash2, ArrowRight, ArrowLeft, ChevronDown } from 'lucide-react';
import { post, useResource, type GraphIssueLocation } from '../../../api';
import { ErrorBanner, Field } from '../../../components';
import type { ProjectDetail, Server } from '../../../models';
import { graphDragType, NodeMap } from './ExecutionGraphCanvas';
import { ArtifactOutputEditor, BuildFields, DeployFields } from './ExecutionGraphPresets';
import { GraphFieldEditor, useProjectEnvironmentSets } from './ExecutionGraphFields';
import {
  canCreateStartParameter,
  ExecutionGraphBindings,
  GraphFlowBranches,
  suggestedGraphPortReference,
} from './ExecutionGraphBindings';
import {
  branchOptions,
  effectiveNodeType,
  graphKey,
  graphNodeLabels,
  graphNodeFamily,
  graphNodeTypeLabel,
  graphOperations,
  isReleaseNode,
} from '../execution-graph-definition';
import type {
  GraphCanvas,
  GraphCatalog,
  GraphEdge,
  GraphEndpoint,
  GraphField,
  GraphIssue,
  GraphNode,
  GraphOperation,
} from '../execution-graph-definition';
import {
  changedNodeContract,
  changedTopologyFlows,
  flowsUsingNode,
  pathHighlight,
  reachable,
} from './execution-graph-draft-impact';
import { authoredNode, makeNode } from './graph-presets';
import './execution-graph-editor.css';

type NodeType = GraphNode['type'];
type Position = NonNullable<GraphNode['position']>;
type Selection = { kind: 'node' | 'template'; id: string } | { kind: 'edge'; index: number };
type Connector = Pick<GraphEdge, 'from' | 'to'>;
type FieldFocus = GraphIssueLocation & { nodeId: string; fieldId: string; preferBinding?: boolean };
type ParameterRepair = { consumerId: string; startId: string; portId: string; field: GraphField };
type DraftImpact = {
  canvas: GraphCanvas;
  message: string;
  flows: { id: string; name: string }[];
  nodeId?: string;
};
const functionalTabs = {
  input: '输入',
  execution: '执行',
  output: '输出',
  environment: '环境变量',
};
const systemNodePresets = graphOperations.filter((type) => type !== 'SHELL' && type !== 'DELAY');
type FunctionalTab = keyof typeof functionalTabs;

function focusInspectorField(inspector: HTMLElement, focus: FieldFocus, bound: boolean) {
  const escaped = CSS.escape(focus.fieldId);
  const section = inspector.querySelector('.graph-inspector-panel') ?? inspector;
  const binding = section.querySelector<HTMLElement>(
    `.graph-binding-field[data-graph-field="${escaped}"]`,
  );
  const configured = section.querySelector<HTMLElement>(`[data-graph-node-field="${escaped}"]`);
  const declaration = section.querySelector<HTMLDetailsElement>(
    `details[data-graph-field="${escaped}"]`,
  );
  const artifactControl =
    focus.artifactField &&
    declaration?.querySelector<HTMLElement>(
      `[data-graph-artifact-field="${CSS.escape(focus.artifactField)}"]`,
    );
  const field =
    (focus.fieldSection === 'output' ? artifactControl || declaration : undefined) ??
    (bound ? (binding ?? configured) : (configured ?? binding)) ??
    declaration ??
    inspector.querySelector<HTMLElement>('h3');
  if (!field) return;
  if (field instanceof HTMLDetailsElement) field.open = true;
  for (
    let details = field.parentElement?.closest('details');
    details;
    details = details.parentElement?.closest('details')
  )
    details.open = true;
  const controls = 'select:enabled, input:enabled, textarea:enabled';
  const control = field.matches(controls) ? field : field.querySelector<HTMLElement>(controls);
  field.scrollIntoView({ block: 'nearest' });
  (control ?? inspector.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true });
}

export function ProjectGraphEditor({
  canvas,
  project,
  canEdit,
  onChange,
  renderStart,
  renderResources,
  issues = [],
  initialNodeId,
  initialFlowId,
  initialFieldId,
  initialFieldLocation,
  insertedStartId,
}: {
  canvas: GraphCanvas;
  project: ProjectDetail;
  canEdit: boolean;
  onChange: (canvas: GraphCanvas) => void;
  renderStart?: (startId: string) => ReactNode;
  renderResources?: (node: GraphNode, endpoint?: GraphEndpoint) => ReactNode;
  issues?: GraphIssue[];
  initialNodeId?: string;
  initialFlowId?: string;
  initialFieldId?: string;
  initialFieldLocation?: GraphIssueLocation;
  insertedStartId?: string;
}) {
  const [selection, select] = useState<Selection | undefined>(
    initialNodeId ? { kind: 'node', id: initialNodeId } : undefined,
  );
  const [hovered, hover] = useState<string>();
  const [source, setSource] = useState<string>();
  const [connector, setConnector] = useState<Connector>();
  const [startId, setStartId] = useState<string | undefined>(initialFlowId);
  const [templateType, setTemplateType] = useState<NodeType>('FUNCTION');
  const [paletteExpanded, setPaletteExpanded] = useState(false);
  const [tab, setTab] = useState<FunctionalTab>('input');
  const [error, setError] = useState('');
  const [parameterRepair, setParameterRepair] = useState<ParameterRepair>();
  const [impact, setImpact] = useState<DraftImpact>();
  const [reveal, setReveal] = useState<{ nodeId: string } | { edge: GraphEdge } | undefined>(() =>
    initialNodeId ? { nodeId: initialNodeId } : undefined,
  );
  const [diagnosticEdge, setDiagnosticEdge] = useState<GraphEdge>();
  const [focusRequest, setFocusRequest] = useState<FieldFocus | undefined>(() =>
    initialNodeId && initialFieldId
      ? { nodeId: initialNodeId, fieldId: initialFieldId, ...initialFieldLocation }
      : undefined,
  );
  const handledFocus = useRef<FieldFocus>(undefined);
  const inspector = useRef<HTMLElement>(null);
  const inspectorId = useId();
  useEffect(() => {
    if (!insertedStartId) return;
    select({ kind: 'node', id: insertedStartId });
    setStartId(insertedStartId);
    setReveal({ nodeId: insertedStartId });
    setSource(undefined);
    setConnector(undefined);
    setFocusRequest(undefined);
  }, [insertedStartId]);
  const catalog = useResource<GraphCatalog>('/projects/' + project.id + '/execution-graph/catalog');
  const activeNode =
    selection?.kind === 'node' ? canvas.nodes.find(({ id }) => id === selection.id) : undefined;
  const missingRepairNode = Boolean(
    initialFieldId && selection?.kind === 'node' && selection.id === initialNodeId && !activeNode,
  );
  const template =
    selection?.kind === 'template'
      ? canvas.templates.find(({ id }) => id === selection.id)
      : undefined;
  const inspected = activeNode ?? template;
  const isFunction = inspected && graphNodeFamily(inspected) === 'function';
  const activeEdge = selection?.kind === 'edge' ? canvas.edges[selection.index] : undefined;
  const selectedPair = canvas.endpoints.find((pair) => pair.startId === startId);
  const selectedPath = pathHighlight(canvas, selectedPair?.startId);
  const [catalogSnapshot, setCatalogSnapshot] = useState<{
    canvas: GraphCanvas;
    flows: GraphCatalog['flows'];
  }>();
  const activePair =
    activeNode && selectedPath?.nodes.has(activeNode.id) ? selectedPair : undefined;
  const repairBinding =
    parameterRepair && activePair?.startId === parameterRepair.startId
      ? activePair.inputBindings?.[parameterRepair.consumerId]?.[parameterRepair.portId]
      : undefined;
  const repairFieldIds = new Set(
    issues.flatMap(({ flowId, nodeId, fieldId, severity }) =>
      activePair &&
      activeNode &&
      (!flowId || flowId === activePair.startId) &&
      nodeId === activeNode.id &&
      fieldId &&
      severity !== 'INFO' &&
      severity !== 'WARNING'
        ? [fieldId]
        : [],
    ),
  );
  if (activeNode && focusRequest?.nodeId === activeNode.id)
    repairFieldIds.add(focusRequest.fieldId);
  const hasActiveFlowNode = Boolean(activePair);
  const catalogNodeId = activeNode?.id;
  const catalogFlowId = selectedPair?.startId;
  useEffect(() => {
    if (!hasActiveFlowNode || !catalogNodeId || !catalogFlowId) return;
    const query = new URLSearchParams({ flow: catalogFlowId, node: catalogNodeId });
    let current = true;
    const timer = window.setTimeout(() => {
      void post<GraphCatalog>('/projects/' + project.id + '/execution-graph/catalog?' + query, {
        definition: { canvas, flows: [] },
      }).then(
        ({ flows }) => {
          if (current) setCatalogSnapshot({ canvas, flows });
        },
        () => {
          if (current) setCatalogSnapshot({ canvas, flows: undefined });
        },
      );
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [project.id, canvas, hasActiveFlowNode, catalogFlowId, catalogNodeId]);
  const highlight = pathHighlight(canvas, hovered) ?? selectedPath;
  const diagnosticEdgeIndex = diagnosticEdge
    ? canvas.edges.findIndex(
        ({ from, to, when }) =>
          from === diagnosticEdge.from && to === diagnosticEdge.to && when === diagnosticEdge.when,
      )
    : -1;
  const highlightEdges =
    diagnosticEdgeIndex >= 0
      ? new Set([...(highlight?.edges ?? []), diagnosticEdgeIndex])
      : highlight?.edges;
  const flow = { id: project.id, name: project.name, nodes: canvas.nodes, edges: canvas.edges };
  const boundField = Boolean(
    focusRequest &&
    (!focusRequest.fieldSection || focusRequest.fieldSection === 'input') &&
    (focusRequest.preferBinding ||
      selectedPair?.inputBindings?.[focusRequest.nodeId]?.[focusRequest.fieldId]),
  );
  const pendingBindings = Boolean(
    activeNode && selectedPath?.nodes.has(activeNode.id) && catalog.loading,
  );
  useEffect(() => {
    if (!focusRequest || focusRequest === handledFocus.current) return;
    if (inspected?.id !== focusRequest.nodeId) return;
    const executionFields = [
      'buildNodeId',
      'releaseNodeId',
      'command',
      'buildCommand',
      'dockerfilePath',
      'timeoutSeconds',
      'envFile',
      'deployPath',
      'composeSource',
    ];
    const targetArtifact = (
      inspected.build?.artifacts ??
      inspected.shell?.artifacts ??
      inspected.registerArtifacts?.artifacts
    )?.some(({ id, name }) => (id ?? name) === focusRequest.fieldId);
    const repairTab =
      focusRequest.fieldSection ??
      (targetArtifact && !boundField
        ? 'output'
        : executionFields.includes(focusRequest.fieldId)
          ? 'execution'
          : 'input');
    if (repairTab === 'input' && pendingBindings) return;
    if (isFunction && tab !== repairTab) {
      setTab(repairTab);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (!inspector.current) return;
      focusInspectorField(inspector.current, focusRequest, boundField);
      handledFocus.current = focusRequest;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, inspected, pendingBindings, boundField, isFunction, tab]);

  function recordImpact(next: GraphCanvas, message: string, startIds: string[], nodeId?: string) {
    const flows = [...new Set(startIds)].map((id) => ({
      id,
      name:
        next.nodes.find((node) => node.id === id)?.name ??
        canvas.nodes.find((node) => node.id === id)?.name ??
        id,
    }));
    setImpact(flows.length ? { canvas: next, message, flows, nodeId } : undefined);
  }

  function patch(fields: Partial<GraphNode>) {
    if (!inspected || !canEdit) return;
    const operationChanged = fields.operation && fields.operation !== effectiveNodeType(inspected);
    const nextOutputs =
      inspected.type === 'END' && fields.outputs
        ? new Set(fields.outputs.map(({ id }) => id))
        : undefined;
    const removedBindings = new Set(
      fields.shell?.params
        ? (inspected.shell?.params ?? [])
            .filter(
              (parameter) =>
                !fields.shell?.params?.some(
                  (field) =>
                    field.id === parameter.id &&
                    field.type === parameter.type &&
                    Boolean(field.multiple) === Boolean(parameter.multiple),
                ),
            )
            .map(({ id }) => id)
        : [],
    );
    if (fields.inputs && graphNodeFamily(inspected) === 'function') {
      const operation = effectiveNodeType(inspected);
      const native = catalog.data?.modules[operation]?.inputs ?? [];
      for (const input of inspected.inputs ?? []) {
        if (native.some(({ id }) => id === input.id)) continue;
        if (!fields.inputs.some(({ id, type }) => id === input.id && type === input.type))
          removedBindings.add(input.id);
      }
    }
    const nextBuild =
      effectiveNodeType(inspected) === 'SOURCE_REVIEW' ? fields.approval?.buildNodeId : undefined;
    const oldBuild =
      nextBuild && nextBuild !== inspected.approval?.buildNodeId
        ? inspected.approval?.buildNodeId
        : undefined;
    if (nextBuild) {
      removedBindings.add('source');
      removedBindings.add('artifact');
    }
    function change(item: GraphNode) {
      if (item.id !== inspected?.id) return item;
      const next = { ...item, ...fields };
      if (removedBindings.size && next.inputDefaults)
        next.inputDefaults = Object.fromEntries(
          Object.entries(next.inputDefaults).filter(([id]) => !removedBindings.has(id)),
        );
      return authoredNode(next);
    }
    const endpoints = canvas.endpoints.map((pair) => {
      if (nextOutputs && pair.endId === inspected.id)
        return {
          ...pair,
          outputBindings: Object.fromEntries(
            Object.entries(pair.outputBindings ?? {}).filter(([id]) => nextOutputs.has(id)),
          ),
        };
      const previousBindings = pair.inputBindings?.[inspected.id];
      if (operationChanged) {
        const inputBindings = { ...pair.inputBindings };
        const environmentBindings = { ...pair.environmentBindings };
        delete inputBindings[inspected.id];
        delete environmentBindings[inspected.id];
        return { ...pair, inputBindings, environmentBindings };
      }
      const oldBuildBinding = oldBuild ? pair.inputBindings?.[oldBuild] : undefined;
      const previousReview = oldBuildBinding?.review;
      const unbindOldReview =
        oldBuild &&
        previousReview?.kind === 'OUTPUT' &&
        previousReview.nodeId === inspected.id &&
        previousReview.fieldId === 'review';
      if ((!removedBindings.size || !previousBindings) && !unbindOldReview) return pair;
      const inputBindings = { ...pair.inputBindings };
      if (removedBindings.size && previousBindings)
        inputBindings[inspected.id] = Object.fromEntries(
          Object.entries(previousBindings).filter(([id]) => !removedBindings.has(id)),
        );
      if (unbindOldReview) {
        const buildBindings = { ...oldBuildBinding };
        delete buildBindings.review;
        inputBindings[oldBuild] = buildBindings;
      }
      return { ...pair, inputBindings };
    });
    const updated = change(inspected);
    const removedRules = new Set(
      (inspected.branch?.cases ?? [])
        .filter(({ id }) => !updated.branch?.cases.some((rule) => rule.id === id))
        .map(({ id }) => `CASE:${id}`),
    );
    const next = template
      ? {
          ...canvas,
          templates: canvas.templates.map((item) => (item.id === updated.id ? updated : item)),
        }
      : {
          ...canvas,
          nodes: canvas.nodes.map((item) => (item.id === updated.id ? updated : item)),
          edges: removedRules.size
            ? canvas.edges.filter(
                ({ from, when }) => from !== updated.id || !when || !removedRules.has(when),
              )
            : canvas.edges,
          endpoints,
        };
    if (!template && changedNodeContract(inspected, updated)) {
      recordImpact(
        next,
        '节点的字段或执行动作已变更，请复核以下执行流的绑定。',
        flowsUsingNode(canvas, inspected.id),
        inspected.id,
      );
    }
    onChange(next);
  }
  function addNode(raw: GraphNode, position?: Position) {
    if (!canEdit) return;
    const copy = {
      ...authoredNode(structuredClone(raw)),
      id: graphKey('node'),
      referenceName: undefined,
      position,
    };
    onChange({ ...canvas, nodes: [...canvas.nodes, copy] });
    select({ kind: 'node', id: copy.id });
    setTab(effectiveNodeType(copy) === 'SHELL' ? 'execution' : 'input');
    setConnector(undefined);
  }
  function drag(event: DragEvent<HTMLButtonElement>, payload: string) {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(graphDragType, payload);
  }
  function drop(payload: string, position: Position) {
    const kind = payload.startsWith('type:') ? (payload.slice(5) as NodeType) : undefined;
    const node =
      kind && Object.hasOwn(graphNodeLabels, kind)
        ? makeNode(kind, project)
        : canvas.templates.find(({ id }) => payload === 'template:' + id);
    if (node) addNode(node, position);
  }
  function assignEnd(startId: string, endId?: string) {
    if (!canEdit) return;
    if (endId && !reachable(canvas, startId).has(endId)) return;
    const previous = canvas.endpoints.find((pair) => pair.startId === startId);
    const retained =
      previous?.endId === endId
        ? previous
        : {
            ...previous,
            outputBindings: undefined,
            edgeSelections: undefined,
          };
    const next = {
      ...canvas,
      endpoints: [
        ...canvas.endpoints.filter((pair) => pair.startId !== startId),
        ...(endId ? [{ ...retained, startId, endId }] : []),
      ],
    };
    recordImpact(next, '开始与结束节点的配对已更新。', changedTopologyFlows(canvas, next), startId);
    onChange(next);
    if (endId) setStartId(startId);
  }
  function updatePair(next: GraphEndpoint) {
    const updated = {
      ...canvas,
      endpoints: canvas.endpoints.map((pair) => (pair.startId === next.startId ? next : pair)),
    };
    recordImpact(updated, '此流的绑定或选路已更新。', [next.startId], activeNode?.id);
    onChange(updated);
    setDiagnosticEdge(undefined);
  }
  function createStartParameter(port: GraphField) {
    if (!canEdit || !activePair || !activeNode || !canCreateStartParameter(port)) return;
    const start = canvas.nodes.find(
      ({ id, type }) => id === activePair.startId && type === 'START',
    );
    if (!start) return;
    const inputs = start.inputs ?? [];
    if (inputs.length >= 30) {
      setError('当前开始节点已声明 30 个参数，请先调整已有参数。');
      return;
    }
    const baseReference = (port.referenceName?.trim() || suggestedGraphPortReference(port.id))
      .replace(/[^A-Za-z0-9_-]/g, '_')
      .toUpperCase()
      .slice(0, 59);
    let referenceName = /^[A-Za-z_]/.test(baseReference)
      ? baseReference
      : 'INPUT_' + baseReference.slice(0, 53);
    const referenceStem = referenceName;
    for (
      let index = 2;
      inputs.some(({ id, referenceName: ref }) => (ref ?? id) === referenceName);
      index++
    ) {
      referenceName = referenceStem + '_' + index;
    }
    const field: GraphField = {
      id: inputs.some(({ id }) => id === port.id) ? graphKey('param') : port.id,
      name: port.name,
      type: port.type,
      referenceName,
      required: true,
      ...(port.type === 'ARTIFACT' && { artifactType: port.artifactType, multiple: port.multiple }),
    };
    const bindings = activePair.inputBindings ?? {};
    const endpoint: GraphEndpoint = {
      ...activePair,
      inputBindings: {
        ...bindings,
        [activeNode.id]: {
          ...bindings[activeNode.id],
          [port.id]: { kind: 'INPUT', fieldId: field.id },
        },
      },
    };
    onChange({
      ...canvas,
      nodes: canvas.nodes.map((node) =>
        node.id === start.id ? { ...node, inputs: [...inputs, field] } : node,
      ),
      endpoints: canvas.endpoints.map((pair) => (pair.startId === start.id ? endpoint : pair)),
    });
    setParameterRepair({ consumerId: activeNode.id, startId: start.id, portId: port.id, field });
    setDiagnosticEdge(undefined);
    setError('');
  }
  function detachEdge(index: number) {
    if (!canEdit) return;
    const edge = canvas.edges[index];
    if (!edge) return;
    const next = {
      ...canvas,
      edges: canvas.edges.filter((_, i) => index !== i),
      endpoints: canvas.endpoints.map((pair) => {
        if (!pair.edgeSelections?.[edge.from]?.includes(edge.to)) return pair;
        const selected = { ...pair.edgeSelections };
        const remaining = selected[edge.from]!.filter((to) => to !== edge.to);
        if (remaining.length) selected[edge.from] = remaining;
        else delete selected[edge.from];
        return { ...pair, edgeSelections: selected };
      }),
    };
    recordImpact(
      next,
      '连线已断开，请复核以下执行流。',
      changedTopologyFlows(canvas, next),
      edge.to,
    );
    onChange(next);
    select(undefined);
    setError('');
  }
  function deleteNode(id: string) {
    if (!canEdit) return;
    const next = {
      ...canvas,
      nodes: canvas.nodes.filter((item) => item.id !== id),
      edges: canvas.edges.filter((edge) => edge.from !== id && edge.to !== id),
      endpoints: canvas.endpoints
        .filter((pair) => pair.startId !== id && pair.endId !== id)
        .map((pair) => {
          const inputBindings = { ...pair.inputBindings };
          delete inputBindings[id];
          const environmentBindings = { ...pair.environmentBindings };
          delete environmentBindings[id];
          const edgeSelections = Object.fromEntries(
            Object.entries(pair.edgeSelections ?? {}).flatMap(([from, targets]) => {
              const remaining = targets.filter((to) => to !== id);
              return from !== id && remaining.length ? [[from, remaining]] : [];
            }),
          );
          return { ...pair, inputBindings, environmentBindings, edgeSelections };
        }),
    };
    recordImpact(next, '节点已删除，请复核以下执行流。', [
      ...flowsUsingNode(canvas, id),
      ...changedTopologyFlows(canvas, next),
    ]);
    onChange(next);
    select(undefined);
    setSource(undefined);
    setConnector(undefined);
    setError('');
  }
  function removeSelection() {
    if (!canEdit) return;
    if (selection?.kind === 'edge' && activeEdge) {
      detachEdge(selection.index);
      return;
    }
    if (template) {
      onChange({ ...canvas, templates: canvas.templates.filter(({ id }) => id !== template.id) });
    } else if (activeNode) {
      deleteNode(activeNode.id);
      return;
    }
    select(undefined);
    setSource(undefined);
    setConnector(undefined);
    setError('');
  }
  function revealInspector() {
    inspector.current?.scrollIntoView({ block: 'start' });
    inspector.current?.focus({ preventScroll: true });
  }

  function beginConnection(id: string) {
    setSource((current) => (current === id ? undefined : id));
    setConnector(undefined);
    select(undefined);
    setError('');
  }
  function connect(target: string) {
    if (!source || !canEdit) return;
    setSource(undefined);
    if (reachable(canvas, target, false, false).has(source)) {
      setError('这条连线会形成循环。');
      return;
    }
    const owner = canvas.nodes.find(({ id }) => id === source);
    const existing = canvas.edges.filter(({ from }) => from === source);
    const choices =
      owner && isReleaseNode(owner) && existing.some(({ when }) => !when)
        ? []
        : branchOptions(owner);
    if (!choices.length && existing.some(({ to }) => to === target)) {
      setError('这两个节点已经连接。');
      return;
    }
    const options = choices.filter(({ value }) => !existing.some(({ when }) => when === value));
    if (choices.length && !options.length) {
      setError('这个节点的每个分支都有了连线，请先删除或调整已有连线。');
      return;
    }
    if (options.length > 1) {
      setConnector({ from: source, to: target });
      window.requestAnimationFrame(revealInspector);
      return;
    }
    addEdge({ from: source, to: target, ...(options[0] && { when: options[0].value }) });
  }
  function addEdge(edge: GraphEdge, index?: number) {
    const next: GraphCanvas = {
      ...canvas,
      edges:
        index === undefined
          ? [...canvas.edges, edge]
          : canvas.edges.map((item, i) => (i === index ? edge : item)),
    };
    if (edge.when === 'SUCCESS' || edge.when === 'PARTIAL_SUCCESS') {
      next.endpoints = next.endpoints.map((pair) => {
        if (!pair.edgeSelections?.[edge.from]) return pair;
        const edgeSelections = { ...pair.edgeSelections };
        delete edgeSelections[edge.from];
        return { ...pair, edgeSelections };
      });
    }
    const paired = new Set(next.endpoints.map(({ startId }) => startId));
    const ends = next.nodes.filter(({ type }) => type === 'END');
    const endpoints = next.nodes.flatMap(({ id, type }) => {
      if (type !== 'START' || paired.has(id)) return [];
      const available = reachable(next, id);
      const reached = ends.filter((end) => available.has(end.id));
      const end = reached.length === 1 ? reached[0] : undefined;
      return end && !reachable(canvas, id).has(end.id) ? [{ startId: id, endId: end.id }] : [];
    });
    next.endpoints = [...next.endpoints, ...endpoints];
    recordImpact(
      next,
      '连线已更新，请复核以下执行流。',
      changedTopologyFlows(canvas, next),
      edge.to,
    );
    onChange(next);
    setConnector(undefined);
    setError('');
  }
  function selectNode(id: string) {
    select({ kind: 'node', id });
    if (activeNode?.id !== id) setTab('input');
    setFocusRequest(undefined);
    setDiagnosticEdge(undefined);
    setReveal(undefined);
    if (canvas.endpoints.some((pair) => pair.startId === id)) setStartId(id);
    else if (!selectedPath?.nodes.has(id)) {
      const affected = canvas.endpoints.filter((pair) =>
        pathHighlight(canvas, pair.startId)?.nodes.has(id),
      );
      setStartId(affected.length === 1 ? affected[0]?.startId : undefined);
    }
    setConnector(undefined);
    setSource(undefined);
    setError('');
  }
  function selectEdge(index: number) {
    select({ kind: 'edge', index });
    setSource(undefined);
    setConnector(undefined);
    setFocusRequest(undefined);
    setDiagnosticEdge(undefined);
    setReveal(undefined);
    setError('');
  }
  function openIssue(issue: GraphIssue) {
    const nodeId = issue.nodeId ?? issue.flowId;
    const edge = issue.edge;
    const edgeIndex = edge
      ? canvas.edges.findIndex(
          ({ from, to, when }) => from === edge.from && to === edge.to && when === edge.when,
        )
      : -1;
    if (edge && edgeIndex >= 0 && !issue.fieldId) {
      selectEdge(edgeIndex);
      setReveal({ edge });
    } else if (nodeId && canvas.nodes.some(({ id }) => id === nodeId)) {
      selectNode(nodeId);
      setReveal({ nodeId });
      if (issue.fieldId) {
        setFocusRequest({
          nodeId,
          fieldId: issue.fieldId,
          fieldSection: issue.fieldSection,
          artifactField: issue.artifactField,
          preferBinding:
            issue.fieldSection === 'input' || Boolean(issue.sourceNodeId || issue.edge),
        });
      }
      if (edgeIndex >= 0) setDiagnosticEdge(edge);
    }
    if (issue.flowId) setStartId(issue.flowId);
  }
  function copyNode(id: string, position?: Position) {
    const node = canvas.nodes.find((item) => item.id === id);
    if (!node) return;
    const origin = position ?? node.position;
    addNode(
      node,
      origin && {
        x: Math.min(30000, origin.x + 30),
        y: Math.min(30000, origin.y + 30),
      },
    );
  }
  function duplicate() {
    if (!inspected || !canEdit) return;
    if (template) {
      const copy = {
        ...structuredClone(template),
        id: graphKey('template'),
        referenceName: undefined,
      };
      onChange({ ...canvas, templates: [...canvas.templates, copy] });
      select({ kind: 'template', id: copy.id });
      return;
    }
    copyNode(inspected.id);
  }

  function renderBranches(node: GraphNode, endpoint: GraphEndpoint) {
    return (
      <GraphFlowBranches
        node={node}
        canvas={canvas}
        endpoint={endpoint}
        update={updatePair}
        canEdit={canEdit}
      />
    );
  }

  function paletteButton(type: NodeType, label = graphNodeLabels[type]) {
    return (
      <button
        type="button"
        key={type}
        draggable
        className="graph-palette-node"
        onDragStart={(event) => drag(event, 'type:' + type)}
        onClick={() => addNode(makeNode(type, project))}
      >
        <Plus size={14} />
        {label}
      </button>
    );
  }

  function createTemplate(node: GraphNode) {
    const item = {
      ...authoredNode(structuredClone(node)),
      id: graphKey('template'),
      position: undefined,
    };
    onChange({ ...canvas, templates: [...canvas.templates, item] });
    select({ kind: 'template', id: item.id });
    setTab(effectiveNodeType(item) === 'SHELL' ? 'execution' : 'input');
    setConnector(undefined);
    setSource(undefined);
  }

  return (
    <div
      className="project-graph-editor"
      onKeyDown={(event) => {
        if (
          !canEdit ||
          (event.key !== 'Delete' && event.key !== 'Backspace') ||
          !(event.target instanceof Element && event.target.closest('.graph-canvas'))
        )
          return;
        if (!activeEdge && !inspected) return;
        event.preventDefault();
        removeSelection();
      }}
    >
      <section className="graph-editing-area" aria-label="图编辑区">
        {canEdit && (
          <aside className="graph-palette" aria-label="节点库" data-expanded={paletteExpanded}>
            <h3>节点库</h3>
            <button
              type="button"
              className="graph-palette-toggle"
              aria-expanded={paletteExpanded}
              onClick={() => setPaletteExpanded((expanded) => !expanded)}
            >
              节点库
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            <div className="graph-palette-group">
              <h4>开始与结束</h4>
              {paletteButton('START')}
              {paletteButton('END')}
            </div>
            <div className="graph-palette-group">
              <h4>功能节点</h4>
              {paletteButton('FUNCTION', '新建自定义节点')}
              <details className="graph-palette-templates">
                <summary>系统模板</summary>
                <div className="graph-palette-group">
                  {systemNodePresets.map((operation) => paletteButton(operation))}
                </div>
              </details>
              <details className="graph-palette-templates">
                <summary>高级节点</summary>
                <div className="graph-palette-group">{paletteButton('DELAY')}</div>
              </details>
              <details className="graph-palette-templates" open={template ? true : undefined}>
                <summary>
                  项目模板{canvas.templates.length ? ' · ' + canvas.templates.length : ''}
                </summary>
                <div className="graph-palette-group">
                  {canvas.templates.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      draggable
                      aria-pressed={template?.id === item.id}
                      className="graph-palette-node"
                      onDragStart={(event) => drag(event, 'template:' + item.id)}
                      onClick={() => {
                        select({ kind: 'template', id: item.id });
                        setTab('input');
                        setConnector(undefined);
                        setSource(undefined);
                      }}
                    >
                      <Copy size={14} />
                      {item.name || '未命名模板'}
                    </button>
                  ))}
                  <Field label="起始模板">
                    <select
                      value={templateType}
                      onChange={(event) => setTemplateType(event.target.value as NodeType)}
                    >
                      <option value="FUNCTION">空白功能节点</option>
                      {graphOperations.map((type) => (
                        <option key={type} value={type}>
                          {graphNodeLabels[type]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => createTemplate(makeNode(templateType, project))}
                  >
                    <Plus size={15} />
                    新建项目模板
                  </button>
                </div>
              </details>
            </div>
            <div className="graph-palette-group">
              <h4>条件节点</h4>
              {paletteButton('CONDITION')}
            </div>
          </aside>
        )}
        <div className="graph-canvas-column">
          <div className="graph-editor-toolbar">
            <div className="graph-canvas-help">
              {canEdit && <p>拖节点到画布，点击两端连接点连线。右键节点或连线打开操作菜单。</p>}
              {source && (
                <p role="status">
                  从「{canvas.nodes.find(({ id }) => id === source)?.name}
                  」连线，选择一个下游连接点。{' '}
                  <button
                    className="button secondary small"
                    type="button"
                    onClick={() => setSource(undefined)}
                  >
                    取消连线
                  </button>
                </p>
              )}
            </div>
            {!!canvas.endpoints.length && (
              <Field label="查看执行流">
                <select
                  value={selectedPair?.startId ?? ''}
                  onChange={(event) => {
                    setStartId(event.target.value || undefined);
                    setFocusRequest(undefined);
                    setDiagnosticEdge(undefined);
                    setReveal(undefined);
                  }}
                >
                  <option value="">查看完整执行图</option>
                  {canvas.endpoints.map((pair) => (
                    <option value={pair.startId} key={pair.startId}>
                      {canvas.nodes.find(({ id }) => id === pair.startId)?.name ?? pair.startId}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {!!issues.length && (
              <section className="graph-fields graph-validation" aria-label="发布检查问题">
                <h4>发布检查</h4>
                <ul className="graph-edge-list">
                  {issues.map((issue, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => openIssue(issue)}
                      >
                        {issue.message}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {impact?.canvas === canvas && (
              <section className="graph-editor-impact" aria-label="受影响的执行流">
                <p className="field-note" role="status">
                  {impact.message}
                </p>
                <ul className="graph-edge-list">
                  {impact.flows.map(({ id, name }) => (
                    <li key={id}>
                      {canvas.nodes.some((node) => node.id === id) ? (
                        <button
                          className="button secondary small"
                          type="button"
                          onClick={() => {
                            const path = pathHighlight(canvas, id);
                            const nodeId =
                              impact.nodeId && path?.nodes.has(impact.nodeId) ? impact.nodeId : id;
                            selectNode(nodeId);
                            setStartId(id);
                            setReveal({ nodeId });
                          }}
                        >
                          {name}
                        </button>
                      ) : (
                        <span>{name}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <ErrorBanner error={catalog.error} retry={catalog.reload} />
            {missingRepairNode && <ErrorBanner error="运行问题关联的节点已不在当前草稿中。" />}
            <ErrorBanner error={error} />
          </div>
          <NodeMap
            flow={flow}
            selected={activeNode ? [activeNode.id] : []}
            selectedEdge={activeEdge && selection?.kind === 'edge' ? selection.index : undefined}
            highlighted={highlight?.nodes}
            highlightEdges={highlightEdges}
            reveal={reveal}
            onHighlight={hover}
            onSelect={selectNode}
            onMove={
              canEdit
                ? (id, position) =>
                    onChange({
                      ...canvas,
                      nodes: canvas.nodes.map((item) =>
                        item.id === id ? { ...item, position } : item,
                      ),
                    })
                : undefined
            }
            onDropNode={canEdit ? drop : undefined}
            onNodeCopy={canEdit ? copyNode : undefined}
            onNodeDelete={canEdit ? deleteNode : undefined}
            onEdgeSelect={canEdit ? selectEdge : undefined}
            onEdgeDelete={canEdit ? detachEdge : undefined}
            connecting={source}
            onConnectSource={canEdit ? beginConnection : undefined}
            onConnectTarget={canEdit ? connect : undefined}
          />
          <div className="graph-canvas-actions heading-actions">
            {canEdit && canvas.nodes.some(({ position }) => position) && (
              <button
                className="button secondary small"
                type="button"
                onClick={() =>
                  onChange({
                    ...canvas,
                    nodes: canvas.nodes.map((item) => ({ ...item, position: undefined })),
                  })
                }
              >
                恢复自动布局
              </button>
            )}
            {(inspected || activeEdge || connector) && (
              <button
                className="button secondary small"
                type="button"
                aria-controls={inspectorId}
                onClick={revealInspector}
              >
                <ChevronDown size={15} aria-hidden="true" />
                查看详情
              </button>
            )}
          </div>
        </div>
      </section>
      <section
        id={inspectorId}
        ref={inspector}
        className="graph-inspector graph-properties"
        aria-label="节点与连线详情"
        tabIndex={-1}
      >
        {!inspected && !activeEdge && !connector && (
          <header className="graph-inspector-title">
            <h3>节点详情</h3>
            <p>选择画布中的节点查看详情。</p>
          </header>
        )}
        {inspected && (
          <>
            <header className="graph-inspector-title">
              <p>{template ? '项目模板' : isFunction ? '功能节点' : '节点属性'}</p>
              <h3 tabIndex={-1}>{inspected.name || graphNodeTypeLabel(inspected)}</h3>
            </header>
            <NodeIdentity node={inspected} canEdit={canEdit} patch={patch} />
            {parameterRepair?.consumerId === inspected.id &&
              repairBinding?.kind === 'INPUT' &&
              repairBinding.fieldId === parameterRepair.field.id && (
                <div className="graph-editor-repair">
                  <p className="field-note" role="status">
                    已创建并绑定开始参数「{parameterRepair.field.name}」。
                  </p>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => {
                      selectNode(parameterRepair.startId);
                      setReveal({ nodeId: parameterRepair.startId });
                      setFocusRequest({
                        nodeId: parameterRepair.startId,
                        fieldId: parameterRepair.field.id,
                      });
                    }}
                  >
                    查看新建参数
                  </button>
                </div>
              )}
            {isFunction ? (
              <>
                <nav className="graph-inspector-tabs" aria-label="功能节点配置">
                  {(Object.keys(functionalTabs) as FunctionalTab[]).map((item) => (
                    <button
                      type="button"
                      key={item}
                      aria-pressed={tab === item}
                      onClick={() => setTab(item)}
                    >
                      {functionalTabs[item]}
                    </button>
                  ))}
                </nav>
                <div className="graph-inspector-panel" key={inspected.id + ':' + tab}>
                  {tab === 'execution' ? (
                    <NodeOperationFields
                      project={project}
                      node={inspected}
                      canvas={canvas}
                      canEdit={canEdit}
                      patch={patch}
                      selectOperation={(operation) =>
                        patch(changeOperation(inspected, operation, project))
                      }
                    />
                  ) : (
                    <>
                      <ExecutionGraphBindings
                        canvas={canvas}
                        node={inspected}
                        endpoint={activePair}
                        flowEdgeIndexes={selectedPath?.edges}
                        catalog={catalog.data}
                        directory={
                          catalogSnapshot?.canvas === canvas ? catalogSnapshot.flows : undefined
                        }
                        project={project}
                        canEdit={canEdit}
                        update={updatePair}
                        patchNode={patch}
                        section={tab}
                        createStartParameter={createStartParameter}
                        repairFieldIds={repairFieldIds}
                      />
                      {tab === 'input' && activeNode && renderResources?.(activeNode, activePair)}
                      <FunctionPortFields
                        node={inspected}
                        section={tab}
                        canEdit={canEdit}
                        patch={patch}
                      />
                    </>
                  )}
                  {tab === 'execution' &&
                    activeNode &&
                    activePair &&
                    renderBranches(activeNode, activePair)}
                </div>
              </>
            ) : (
              <>
                <NodeOperationFields
                  node={inspected}
                  project={project}
                  canvas={canvas}
                  canEdit={canEdit}
                  patch={patch}
                />
                {activeNode && renderResources?.(activeNode, activePair)}
              </>
            )}
            {activeNode?.type === 'START' && (
              <>
                <GraphFieldEditor
                  project={project}
                  catalog={catalog.data}
                  type="input"
                  disabled={!canEdit}
                  title="触发器与手动运行参数"
                  fields={activeNode.inputs ?? []}
                  change={(inputs) => patch({ inputs })}
                />
                <StartEnvironmentFields
                  projectId={project.id}
                  node={activeNode}
                  canEdit={canEdit}
                  patch={patch}
                />
                {renderStart?.(activeNode.id)}
                <details className="graph-field-card">
                  <summary>画布结构设置</summary>
                  <StartPair
                    node={activeNode}
                    canvas={canvas}
                    canEdit={canEdit}
                    assign={assignEnd}
                  />
                  {selectedPair?.startId === activeNode.id && (
                    <Field label="此流关联发布的服务（可选）">
                      <select
                        value={selectedPair.serviceId ?? ''}
                        disabled={!canEdit}
                        onChange={(event) =>
                          updatePair({
                            ...selectedPair,
                            serviceId: event.target.value || undefined,
                          })
                        }
                      >
                        <option value="">无固定关联</option>
                        {project.services.map(({ id, name }) => (
                          <option value={id} key={id}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </details>
              </>
            )}
            {activeNode?.type === 'END' && (
              <>
                <EndPairs
                  key={activeNode.id}
                  canvas={canvas}
                  node={activeNode}
                  canEdit={canEdit}
                  assign={assignEnd}
                />
                <GraphFieldEditor
                  project={project}
                  catalog={catalog.data}
                  type="output"
                  disabled={!canEdit}
                  fields={activeNode.outputs ?? []}
                  change={(outputs) => patch({ outputs })}
                />
              </>
            )}
            {!isFunction && activeNode && activePair && (
              <>
                {renderBranches(activeNode, activePair)}
                {activeNode.type !== 'START' && (
                  <ExecutionGraphBindings
                    canvas={canvas}
                    node={activeNode}
                    endpoint={activePair}
                    flowEdgeIndexes={selectedPath?.edges}
                    catalog={catalog.data}
                    directory={
                      catalogSnapshot?.canvas === canvas ? catalogSnapshot.flows : undefined
                    }
                    project={project}
                    canEdit={canEdit}
                    update={updatePair}
                    createStartParameter={
                      activeNode.type === 'END' ? undefined : createStartParameter
                    }
                    repairFieldIds={repairFieldIds}
                  />
                )}
              </>
            )}
            {canEdit && (
              <div className="heading-actions">
                {template && (
                  <button
                    type="button"
                    className="button primary small"
                    onClick={() => addNode(template)}
                  >
                    <Plus size={15} />
                    添加到画布
                  </button>
                )}
                {isFunction && activeNode && (
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => createTemplate(activeNode)}
                  >
                    保存为项目模板
                  </button>
                )}
                <button type="button" className="button secondary small" onClick={duplicate}>
                  <Copy size={15} />
                  {template ? '复制模板' : '复制节点'}
                </button>
                <button type="button" className="button secondary small" onClick={removeSelection}>
                  <Trash2 size={15} />
                  {template ? '删除模板' : '删除节点'}
                </button>
              </div>
            )}
          </>
        )}
        {connector && (
          <ConnectorFields
            key={connector.from + '/' + connector.to}
            canvas={canvas}
            edge={connector}
            commit={addEdge}
            onClose={() => setConnector(undefined)}
          />
        )}
        {activeEdge && selection?.kind === 'edge' && (
          <ConnectorFields
            key={selection.index + ':' + activeEdge.from + '/' + activeEdge.to}
            canvas={canvas}
            edge={activeEdge}
            index={selection.index}
            commit={addEdge}
            onClose={() => detachEdge(selection.index)}
          />
        )}
      </section>
    </div>
  );
}

function StartPair({ node, canvas, canEdit, assign }: PairProps) {
  const valid = reachable(canvas, node.id);
  const ends = canvas.nodes.filter((item) => item.type === 'END' && valid.has(item.id));
  const selected = canvas.endpoints.find(({ startId }) => startId === node.id)?.endId ?? '';
  const stale = selected && !valid.has(selected);
  return (
    <Field
      label="对应结束节点"
      hint={
        !ends.length ? '先连通开始节点与结束节点，再声明执行流。' : '此开始节点的名称即执行流名称。'
      }
    >
      <select
        value={selected}
        disabled={!canEdit}
        onChange={(event) => assign(node.id, event.target.value || undefined)}
      >
        <option value="">未声明</option>
        {stale && (
          <option value={selected} disabled>
            当前绑定的路径已断开
          </option>
        )}
        {ends.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

interface PairProps {
  node: GraphNode;
  canvas: GraphCanvas;
  canEdit: boolean;
  assign: (startId: string, endId?: string) => void;
}

function EndPairs({ node, canvas, canEdit, assign }: PairProps) {
  const [candidate, setCandidate] = useState('');
  const [existing, setExisting] = useState('');
  const reachableStarts = reachable(canvas, node.id, true);
  const starts = canvas.nodes.filter(({ type }) => type === 'START');
  const chosen = new Set(
    canvas.endpoints.filter(({ endId }) => endId === node.id).map(({ startId }) => startId),
  );
  const available = starts.filter(({ id }) => reachableStarts.has(id) && !chosen.has(id));
  const configured = starts.filter(({ id }) => chosen.has(id));
  return (
    <div className="graph-end-pairs">
      <Field label="可添加的开始节点">
        <select
          size={3}
          disabled={!canEdit}
          value={candidate}
          onChange={(event) => setCandidate(event.target.value)}
        >
          {available.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
              {canvas.endpoints.some(({ startId }) => startId === id) ? '（改为此结束）' : ''}
            </option>
          ))}
        </select>
      </Field>
      {canEdit && (
        <div className="graph-pair-buttons">
          <button
            type="button"
            className="button secondary small"
            aria-label="添加对应开始节点"
            disabled={!available.some(({ id }) => id === candidate)}
            onClick={() => {
              assign(candidate, node.id);
              setCandidate('');
            }}
          >
            <ArrowRight size={16} />
          </button>
          <button
            type="button"
            className="button secondary small"
            aria-label="移除对应开始节点"
            disabled={!chosen.has(existing)}
            onClick={() => {
              assign(existing);
              setExisting('');
            }}
          >
            <ArrowLeft size={16} />
          </button>
        </div>
      )}
      <Field label="已声明的开始节点">
        <select
          size={3}
          disabled={!canEdit}
          value={existing}
          onChange={(event) => setExisting(event.target.value)}
        >
          {configured.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
              {!reachableStarts.has(id) ? '（路径已断开）' : ''}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function ConnectorFields({
  canvas,
  edge,
  index,
  commit,
  onClose,
}: {
  canvas: GraphCanvas;
  edge: GraphEdge;
  index?: number;
  commit: (edge: GraphEdge, index?: number) => void;
  onClose: () => void;
}) {
  const [when, setWhen] = useState(edge.when);
  const source = canvas.nodes.find(({ id }) => id === edge.from);
  const to = canvas.nodes.find(({ id }) => id === edge.to);
  const canUseOrdinary =
    source &&
    isReleaseNode(source) &&
    !canvas.edges.some((item, i) => item.from === edge.from && index !== i);
  const options = branchOptions(source).filter(
    ({ value }) =>
      !canvas.edges.some(
        (item, i) => item.from === edge.from && item.when === value && index !== i,
      ),
  );
  return (
    <>
      <h3>{index === undefined ? '添加连线' : '连线属性'}</h3>
      <p>
        {source?.name} → {to?.name}
      </p>
      {options.length > 0 && (
        <Field label="条件分支">
          <select
            value={when ?? ''}
            onChange={(event) => setWhen(event.target.value as GraphEdge['when'])}
          >
            <option value="">{canUseOrdinary ? '普通连线 · 全部成功后继续' : '选择分支'}</option>
            {options.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="heading-actions">
        {options.length > 0 && (
          <button
            type="button"
            className="button primary small"
            disabled={!(!when && canUseOrdinary) && !options.some(({ value }) => value === when)}
            onClick={() => commit({ ...edge, when: when || undefined }, index)}
          >
            {index === undefined ? '连接' : '更新分支'}
          </button>
        )}
        <button type="button" className="button secondary small" onClick={onClose}>
          {index === undefined ? '取消' : '删除连线'}
        </button>
      </div>
    </>
  );
}

interface FieldsProps {
  node: GraphNode;
  project: ProjectDetail;
  canvas: GraphCanvas;
  canEdit: boolean;
  patch: (fields: Partial<GraphNode>) => void;
  catalog?: GraphCatalog;
}

function StartEnvironmentFields({
  node,
  projectId,
  canEdit,
  patch,
}: Pick<FieldsProps, 'node' | 'canEdit' | 'patch'> & { projectId: string }) {
  const configuration = node.environmentSet ?? { mode: 'NONE' as const };
  const sets = useProjectEnvironmentSets(projectId, configuration.mode !== 'NONE');
  const fields = (node.inputs ?? []).filter(
    ({ type, multiple }) => type === 'ENVIRONMENT_SET' && !multiple,
  );
  const field =
    configuration.mode === 'INPUT'
      ? fields.find(({ id }) => id === configuration.fieldId)
      : undefined;
  function addParameter() {
    const id = node.inputs?.some((input) => input.id === 'environmentSetId')
      ? graphKey('field')
      : 'environmentSetId';
    patch({
      inputs: [
        ...(node.inputs ?? []),
        { id, name: '变量集合', type: 'ENVIRONMENT_SET', required: true },
      ],
      environmentSet: { mode: 'INPUT', fieldId: id },
    });
  }
  return (
    <section className="graph-fields">
      <h4>变量集合</h4>
      <Field label="变量集合引用" hint="变量集合仅提供变量。构建和发布目标在各自节点配置。">
        <select
          data-graph-node-field="environmentSet"
          disabled={!canEdit}
          value={configuration.mode}
          onChange={(event) => {
            if (event.target.value === 'NONE') patch({ environmentSet: { mode: 'NONE' } });
            else if (event.target.value === 'FIXED') patch({ environmentSet: { mode: 'FIXED' } });
            else if (fields.length)
              patch({ environmentSet: { mode: 'INPUT', fieldId: fields[0].id } });
            else addParameter();
          }}
        >
          <option value="NONE">无引用，使用项目公共变量</option>
          <option value="FIXED">固定变量集合</option>
          <option value="INPUT">由运行或触发器选择</option>
        </select>
      </Field>
      {configuration.mode === 'FIXED' && (
        <Field label="固定变量集合">
          <select
            disabled={!canEdit || sets.loading}
            value={configuration.environmentSetId ?? ''}
            onChange={(event) =>
              patch({
                environmentSet: {
                  mode: 'FIXED',
                  environmentSetId: event.target.value || undefined,
                },
              })
            }
          >
            <option value="">请选择</option>
            {configuration.environmentSetId &&
              !sets.data?.some(({ id }) => id === configuration.environmentSetId) && (
                <option value={configuration.environmentSetId} disabled>
                  原有变量集合不可用
                </option>
              )}
            {sets.data?.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {configuration.mode === 'INPUT' && (
        <>
          <Field label="变量集合参数">
            <select
              disabled={!canEdit}
              value={field?.id ?? ''}
              onChange={(event) =>
                patch({
                  environmentSet: { mode: 'INPUT', fieldId: event.target.value || undefined },
                })
              }
            >
              <option value="">请选择</option>
              {fields.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          {!fields.length && canEdit && (
            <button className="button secondary small" type="button" onClick={addParameter}>
              添加变量集合参数
            </button>
          )}
          {field && (
            <Field label="允许选择的集合" hint="可多选，清空表示允许本项目的所有集合。">
              <select
                multiple
                size={Math.max(2, Math.min(5, (sets.data ?? []).length))}
                disabled={!canEdit || sets.loading}
                value={field.options?.map(String) ?? []}
                onChange={(event) => {
                  const ids = Array.from(event.target.selectedOptions, ({ value }) => value);
                  patch({
                    inputs: node.inputs?.map((item) =>
                      item.id === field.id
                        ? {
                            ...item,
                            options: ids.length ? ids : undefined,
                            defaultValue:
                              !ids.length || ids.includes(String(item.defaultValue))
                                ? item.defaultValue
                                : undefined,
                          }
                        : item,
                    ),
                  });
                }}
              >
                {sets.data?.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      <ErrorBanner error={sets.error} retry={sets.reload} />
    </section>
  );
}

function LoadEnvironmentFields({
  node,
  canEdit,
  patch,
}: Pick<FieldsProps, 'node' | 'canEdit' | 'patch'>) {
  const config = node.loadEnvironment;
  const mapping = config?.pathRule;
  const update = (next: NonNullable<GraphNode['loadEnvironment']>) =>
    patch({ loadEnvironment: { ...config, ...next } });
  return (
    <>
      <Field label="变量文件路径来源" hint="使用已绑定工作区的固定 Git 提交读取仓库内文件。">
        <select
          data-graph-node-field="envFile"
          disabled={!canEdit}
          value={mapping ? 'mapping' : 'path'}
          onChange={(event) =>
            update(
              event.target.value === 'mapping'
                ? { envFile: undefined, pathRule: { key: 'ENV', paths: {} } }
                : { pathRule: undefined },
            )
          }
        >
          <option value="path">固定文件路径</option>
          <option value="mapping">按入口参数或变量集合映射</option>
        </select>
      </Field>
      {mapping ? (
        <>
          <Field label="映射键" hint="先查开始参数的稳定 ID，再查已选集合中的普通变量。">
            <input
              disabled={!canEdit}
              value={mapping.key}
              placeholder="ENV"
              onChange={(event) => update({ pathRule: { ...mapping, key: event.target.value } })}
            />
          </Field>
          <Field label="文件映射" hint="每行填写 值=仓库相对路径，例如 test=.env.test。">
            <textarea
              disabled={!canEdit}
              rows={4}
              defaultValue={Object.entries(mapping.paths)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n')}
              onBlur={(event) => {
                const entries = event.target.value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean);
                const paths = new Map<string, string>();
                for (const line of entries) {
                  const split = line.indexOf('=');
                  const key = line.slice(0, Math.max(0, split)).trim();
                  const file = line.slice(split + 1).trim();
                  if (!key || !file || paths.has(key)) {
                    event.target.setCustomValidity('每行须有唯一的映射值及相对文件路径。');
                    event.target.reportValidity();
                    return;
                  }
                  paths.set(key, file);
                }
                event.target.setCustomValidity('');
                update({ pathRule: { ...mapping, paths: Object.fromEntries(paths) } });
              }}
            />
          </Field>
        </>
      ) : (
        <Field label="仓库相对文件路径">
          <input
            disabled={!canEdit}
            value={config?.envFile ?? ''}
            placeholder=".env.test"
            onChange={(event) => update({ envFile: event.target.value || undefined })}
          />
        </Field>
      )}
      <label className="checkbox-row">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={config?.required !== false}
          onChange={(event) => update({ required: event.target.checked })}
        />{' '}
        文件必须存在
      </label>
      <Field label="工作区相对目录（可选）">
        <input
          disabled={!canEdit}
          value={config?.directory ?? ''}
          placeholder="."
          onChange={(event) => update({ directory: event.target.value || undefined })}
        />
      </Field>
    </>
  );
}

function NodeIdentity({ node, canEdit, patch }: Pick<FieldsProps, 'node' | 'canEdit' | 'patch'>) {
  return (
    <div className="graph-inspector-identity">
      <Field label="节点名称">
        <input
          readOnly={!canEdit}
          maxLength={100}
          value={node.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>
      <Field label="节点引用名" hint="留空时系统分配。">
        <input
          readOnly={!canEdit}
          maxLength={64}
          value={node.referenceName ?? ''}
          onChange={(event) => patch({ referenceName: event.target.value || undefined })}
        />
      </Field>
    </div>
  );
}

function changeOperation(
  node: GraphNode,
  operation: GraphOperation,
  project: ProjectDetail,
): Partial<GraphNode> {
  const next = makeNode(operation, project, false);
  return {
    type: 'FUNCTION',
    operation,
    inputDefaults: next.inputDefaults,
    environmentDefaults: undefined,
    moduleId: undefined,
    moduleVersion: undefined,
    message: next.message,
    checkout: next.checkout,
    shell: next.shell,
    loadEnvironment: next.loadEnvironment,
    registerArtifacts: next.registerArtifacts,
    build: next.build,
    deploy: next.deploy,
    inputs: next.inputs,
    outputs: next.outputs,
    delaySeconds: next.delaySeconds,
    approval: next.approval,
    healthCheck: next.healthCheck,
    flowId: next.flowId,
    ...(node.name === graphNodeTypeLabel(node) && { name: next.name }),
  };
}

function FunctionPortFields({
  node,
  canEdit,
  patch,
  section,
}: Pick<FieldsProps, 'node' | 'canEdit' | 'patch'> & {
  section: Exclude<FunctionalTab, 'execution'>;
}) {
  const operation = effectiveNodeType(node);
  if (operation === 'BUILD' && (section === 'input' || section === 'output'))
    return (
      <BuildFields
        section={section}
        value={node.build ?? {}}
        canEdit={canEdit}
        change={(build) => patch({ build })}
      />
    );
  if (section === 'output' && (operation === 'SHELL' || operation === 'CHECK'))
    return (
      <ArtifactOutputEditor
        value={node.shell?.artifacts ?? []}
        pathInputs={(node.inputs ?? node.shell?.params ?? []).filter(
          ({ type, multiple }) => type === 'PATH' && !multiple,
        )}
        canEdit={canEdit}
        onChange={(artifacts) => patch({ shell: { ...node.shell, artifacts } })}
      />
    );
  if (section === 'output' && operation === 'REGISTER_ARTIFACT')
    return (
      <ArtifactOutputEditor
        value={node.registerArtifacts?.artifacts ?? []}
        canEdit={canEdit}
        onChange={(artifacts) => patch({ registerArtifacts: { artifacts } })}
      />
    );
  return null;
}

function NodeOperationFields({
  node,
  project,
  canvas,
  canEdit,
  patch,
  selectOperation,
}: Omit<FieldsProps, 'catalog'> & {
  selectOperation?: (operation: GraphOperation) => void;
}) {
  const operation = effectiveNodeType(node);
  const downstream =
    operation === 'APPROVAL' || operation === 'SOURCE_REVIEW'
      ? reachable(canvas, node.id)
      : undefined;
  const downstreamReleases = canvas.nodes.filter(
    (candidate) => downstream?.has(candidate.id) && isReleaseNode(candidate),
  );
  const downstreamBuilds = canvas.nodes.filter(
    (candidate) => downstream?.has(candidate.id) && effectiveNodeType(candidate) === 'BUILD',
  );
  return (
    <>
      {selectOperation && (
        <Field label="执行操作" hint="更换操作会重置节点输入、执行配置、输出和环境变量。">
          <select
            disabled={!canEdit}
            value={operation}
            onChange={(event) => selectOperation(event.target.value as GraphOperation)}
          >
            {!graphOperations.some((type) => type === operation) && (
              <option value={operation}>{graphNodeLabels[operation]}</option>
            )}
            {graphOperations.map((item) => (
              <option key={item} value={item}>
                {graphNodeLabels[item]}
              </option>
            ))}
          </select>
        </Field>
      )}
      {operation === 'LOG' && (
        <Field label="日志内容">
          <textarea
            readOnly={!canEdit}
            maxLength={2000}
            value={node.message ?? ''}
            onChange={(event) => patch({ message: event.target.value || undefined })}
          />
        </Field>
      )}
      {operation === 'CHECKOUT' && (
        <p className="field-note">
          仓库、Git 版本和拉取方式在「输入」中声明，实际检出的提交会写入输出。
        </p>
      )}
      {(operation === 'SHELL' || operation === 'CHECK') && (
        <ShellFields node={node} canEdit={canEdit} patch={patch} />
      )}
      {operation === 'BUILD' && (
        <BuildFields
          section="execution"
          value={node.build ?? {}}
          canEdit={canEdit}
          change={(build) => patch({ build })}
        />
      )}
      {isReleaseNode(node) && (
        <DeployFields
          project={project}
          value={node.deploy ?? {}}
          canEdit={canEdit}
          change={(deploy) => patch({ deploy })}
        />
      )}
      {operation === 'SOURCE_REVIEW' && (
        <Field
          label="源码审核范围"
          hint="选择构建节点后，审核覆盖其实际使用的主仓库、源码依赖和环境文件。切换到此模式会清除手动指定的源码和产物；请在构建节点的审核输入选择本节点的审核输出。"
        >
          <select
            data-graph-node-field="buildNodeId"
            disabled={!canEdit}
            value={node.approval?.buildNodeId ?? ''}
            onChange={(event) =>
              patch({
                approval: { ...node.approval, buildNodeId: event.target.value || undefined },
              })
            }
          >
            <option value="">使用绑定的源码或产物</option>
            {node.approval?.buildNodeId &&
              !downstreamBuilds.some(({ id }) => id === node.approval?.buildNodeId) && (
                <option value={node.approval.buildNodeId} disabled>
                  所选构建节点已断开或不可用
                </option>
              )}
            {downstreamBuilds.map(({ id, name }) => (
              <option key={id} value={id}>
                构建 · {name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {operation === 'ROLLBACK_ARTIFACT' && (
        <p className="field-note">
          选择要恢复的历史产物。自动回滚须绑定明确报告应用不健康的检查结果，用它确认逐台服务器的回滚基线。
        </p>
      )}
      {operation === 'HEALTH_CHECK' && (
        <>
          <Field
            label="健康判定"
            hint="健康才通过会阻止后续节点。报告模式可把健康结果接到条件分支。"
          >
            <select
              data-graph-node-field="requireHealthy"
              disabled={!canEdit}
              value={node.healthCheck?.requireHealthy ? 'required' : 'report'}
              onChange={(event) =>
                patch({
                  healthCheck: {
                    ...node.healthCheck,
                    requireHealthy: event.target.value === 'required',
                  },
                })
              }
            >
              <option value="report">报告健康状态</option>
              <option value="required">健康才通过</option>
            </select>
          </Field>
          <Field
            label="检查命令"
            hint="在发布版本目录执行。退出码 0 表示健康，10 表示已确认应用不健康，其余结果需要人工核查。"
          >
            <textarea
              data-graph-node-field="command"
              rows={3}
              maxLength={65536}
              readOnly={!canEdit}
              value={node.healthCheck?.command ?? ''}
              onChange={(event) =>
                patch({ healthCheck: { ...node.healthCheck, command: event.target.value } })
              }
            />
          </Field>
          <Field label="检查超时（秒）">
            <input
              type="number"
              min={1}
              max={180}
              data-graph-node-field="timeoutSeconds"
              readOnly={!canEdit}
              value={node.healthCheck?.timeoutSeconds ?? ''}
              onChange={(event) =>
                patch({
                  healthCheck: {
                    ...node.healthCheck,
                    timeoutSeconds: event.target.value ? Number(event.target.value) : undefined,
                  },
                })
              }
            />
          </Field>
        </>
      )}
      {operation === 'LOAD_ENV' && (
        <LoadEnvironmentFields key={node.id} node={node} canEdit={canEdit} patch={patch} />
      )}
      {operation === 'CONDITION' && node.branch && (
        <ConditionBranchFields node={node} canEdit={canEdit} patch={patch} />
      )}
      {operation === 'CONDITION' && !node.branch && (
        <div className="form-grid">
          <Field label="等于" hint="在当前流绑定比较值。">
            <input
              readOnly={!canEdit}
              value={node.condition?.value ?? ''}
              maxLength={500}
              onChange={(event) =>
                patch({
                  condition: { key: node.condition?.key ?? 'input', value: event.target.value },
                })
              }
            />
          </Field>
        </div>
      )}
      {operation === 'SWITCH' && <SwitchFields node={node} canEdit={canEdit} patch={patch} />}
      {operation === 'DELAY' && (
        <Field label="等待时间（秒）">
          <input
            type="number"
            min={1}
            max={86400}
            readOnly={!canEdit}
            value={node.delaySeconds ?? ''}
            onChange={(event) =>
              patch({ delaySeconds: event.target.value ? Number(event.target.value) : undefined })
            }
          />
        </Field>
      )}
      {operation === 'APPROVAL' && (
        <Field
          label="审批对应的发布节点"
          hint="选择下游部署或回滚时，审批会固定实际服务、目标和产物。"
        >
          <select
            data-graph-node-field="releaseNodeId"
            disabled={!canEdit}
            value={node.approval?.releaseNodeId ?? ''}
            onChange={(event) =>
              patch({
                approval: { ...node.approval, releaseNodeId: event.target.value || undefined },
              })
            }
          >
            <option value="">普通流程审批</option>
            {node.approval?.releaseNodeId &&
              !downstreamReleases.some(({ id }) => id === node.approval?.releaseNodeId) && (
                <option value={node.approval.releaseNodeId} disabled>
                  所选节点已断开或不可用
                </option>
              )}
            {downstreamReleases.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {(operation === 'APPROVAL' || operation === 'SOURCE_REVIEW') && (
        <Field
          label={operation === 'SOURCE_REVIEW' ? '审核超时（秒）' : '审批超时（秒）'}
          hint="留空默认 86400 秒。"
        >
          <input
            type="number"
            min={1}
            max={604800}
            data-graph-node-field="timeoutSeconds"
            readOnly={!canEdit}
            value={node.approval?.timeoutSeconds ?? ''}
            onChange={(event) =>
              patch({
                approval: {
                  ...node.approval,
                  timeoutSeconds: event.target.value ? Number(event.target.value) : undefined,
                },
              })
            }
          />
        </Field>
      )}
      {operation === 'FLOW_CALL' && (
        <Field label="子执行流">
          <select
            disabled={!canEdit}
            value={node.flowId ?? ''}
            onChange={(event) => patch({ flowId: event.target.value || undefined })}
          >
            <option value="">选择开始节点</option>
            {canvas.nodes
              .filter(
                (item) =>
                  item.type === 'START' &&
                  canvas.endpoints.some(({ startId }) => startId === item.id),
              )
              .map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        </Field>
      )}
    </>
  );
}

function ConditionBranchFields({
  node,
  canEdit,
  patch,
}: Pick<FieldsProps, 'node' | 'canEdit' | 'patch'>) {
  const cases = node.branch?.cases ?? [];
  const save = (next: typeof cases) => patch({ branch: { cases: next } });
  const edit = (id: string, changes: Partial<(typeof cases)[number]>) =>
    save(cases.map((rule) => (rule.id === id ? { ...rule, ...changes } : rule)));
  function moveUp(index: number) {
    const reordered = [...cases];
    reordered.splice(index - 1, 2, cases[index]!, cases[index - 1]!);
    save(reordered);
  }
  return (
    <div className="graph-fields">
      {cases.map(({ id, value, label }, index) => (
        <section className="graph-field-card" key={id}>
          <div className="graph-field-pair">
            <Field label="匹配值">
              <input
                value={value}
                maxLength={500}
                readOnly={!canEdit}
                onChange={(event) => edit(id, { value: event.target.value })}
              />
            </Field>
            <Field label="出口名称">
              <input
                value={label ?? ''}
                maxLength={100}
                readOnly={!canEdit}
                onChange={(event) => edit(id, { label: event.target.value })}
              />
            </Field>
          </div>
          {canEdit && (
            <div className="heading-actions">
              <button
                type="button"
                className="button secondary small"
                disabled={index === 0}
                onClick={() => moveUp(index)}
              >
                上移
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={cases.length === 1}
                onClick={() => save(cases.filter((rule) => rule.id !== id))}
              >
                删除规则
              </button>
            </div>
          )}
        </section>
      ))}
      <p className="field-note">比较值未命中任何规则时走默认出口。</p>
      {canEdit && (
        <button
          type="button"
          className="button secondary small"
          disabled={cases.length >= 10}
          onClick={() => save([...cases, { id: graphKey('rule'), value: '' }])}
        >
          添加匹配规则
        </button>
      )}
    </div>
  );
}

function SwitchFields({ node, canEdit, patch }: Pick<FieldsProps, 'node' | 'canEdit' | 'patch'>) {
  const config = node.switch ?? { key: 'input', cases: [] };
  return (
    <>
      <p className="field-note">设置下面的匹配项，并在当前流绑定比较值。</p>
      {config.cases.map((value, index) => (
        <Field label={'选项 ' + (index + 1)} key={index}>
          <input
            readOnly={!canEdit}
            maxLength={500}
            value={value}
            onChange={(event) =>
              patch({
                switch: {
                  ...config,
                  cases: config.cases.map((item, i) => (i === index ? event.target.value : item)),
                },
              })
            }
          />
        </Field>
      ))}
      {canEdit && (
        <div className="heading-actions">
          <button
            type="button"
            className="button secondary small"
            disabled={config.cases.length >= 10}
            onClick={() =>
              patch({
                switch: {
                  ...config,
                  cases: [...config.cases, 'branch-' + (config.cases.length + 1)],
                },
              })
            }
          >
            添加匹配项
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={config.cases.length <= 1}
            onClick={() => patch({ switch: { ...config, cases: config.cases.slice(0, -1) } })}
          >
            移除末尾匹配项
          </button>
        </div>
      )}
    </>
  );
}

function ShellFields({ node, canEdit, patch }: Pick<FieldsProps, 'node' | 'canEdit' | 'patch'>) {
  const servers = useResource<Server[]>('/servers');
  const shell = node.shell ?? {};
  return (
    <>
      <ErrorBanner error={servers.error} retry={servers.reload} />
      <Field label="执行位置">
        <select
          disabled={!canEdit}
          value={shell.location ?? 'TARGET'}
          onChange={(event) =>
            patch({ shell: { ...shell, location: event.target.value as 'MANAGER' | 'TARGET' } })
          }
        >
          <option value="MANAGER">管理端</option>
          <option value="TARGET">目标服务器</option>
        </select>
      </Field>
      {shell.location !== 'MANAGER' && (
        <Field label="执行服务器" hint="可在当前流绑定目标。">
          <select
            data-graph-node-field="targets"
            disabled={!canEdit}
            value={shell.serverId ?? ''}
            onChange={(event) =>
              patch({ shell: { ...shell, serverId: event.target.value || undefined } })
            }
          >
            <option value="">{servers.loading ? '读取服务器…' : '选择服务器'}</option>
            {servers.data?.map(({ id, name, host }) => (
              <option key={id} value={id}>
                {name} · {host}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="工作区相对目录">
        <input
          disabled={!canEdit}
          placeholder="."
          value={shell.directory ?? ''}
          onChange={(event) =>
            patch({ shell: { ...shell, directory: event.target.value || undefined } })
          }
        />
      </Field>
      <Field label="超时（秒）">
        <input
          type="number"
          min={1}
          max={86400}
          disabled={!canEdit}
          value={shell.timeout ?? ''}
          onChange={(event) =>
            patch({
              shell: {
                ...shell,
                timeout: event.target.value ? Number(event.target.value) : undefined,
              },
            })
          }
        />
      </Field>
      {effectiveNodeType(node) === 'CHECK' && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={Boolean(shell.continueOnFailure)}
            onChange={(event) =>
              patch({ shell: { ...shell, continueOnFailure: event.target.checked } })
            }
          />{' '}
          检查失败时由后续节点判断
        </label>
      )}
      <Field label="Shell 脚本" hint="脚本输入和节点环境变量会注入执行进程。">
        <textarea
          readOnly={!canEdit}
          rows={5}
          className="mono"
          spellCheck={false}
          maxLength={25000}
          value={shell.command ?? ''}
          onChange={(event) => patch({ shell: { ...shell, command: event.target.value } })}
        />
      </Field>
    </>
  );
}
