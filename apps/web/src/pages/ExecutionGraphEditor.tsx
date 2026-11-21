import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Copy, Plus, Trash2, ArrowRight, ArrowLeft } from 'lucide-react';
import { post, useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type { ProjectDetail, Server } from '../models';
import { graphDragType, NodeMap } from './ExecutionGraphCanvas';
import {
  ArtifactOutputEditor,
  BuildFields,
  DeployFields,
  graphTemplates,
} from './ExecutionGraphPresets';
import { GraphFieldEditor, useProjectEnvironmentSets } from './ExecutionGraphFields';
import {
  ExecutionGraphBindings,
  GraphFlowBranches,
  GraphTemplatePicker,
} from './ExecutionGraphBindings';
import {
  branchOptions,
  graphKey,
  graphNodeLabels,
  isReleaseNode,
} from './execution-graph-definition';
import type {
  GraphBinding,
  GraphCanvas,
  GraphCatalog,
  GraphEdge,
  GraphEndpoint,
  GraphField,
  GraphIssue,
  GraphNode,
} from './execution-graph-definition';
import './execution-graph-editor.css';

type NodeType = GraphNode['type'];
type Position = NonNullable<GraphNode['position']>;
type Selection = { kind: 'node' | 'template'; id: string } | { kind: 'edge'; index: number };
type Connector = Pick<GraphEdge, 'from' | 'to'>;
type FieldFocus = { nodeId: string; fieldId: string };

function focusInspectorField(inspector: HTMLElement, fieldId: string, bound: boolean) {
  const escaped = CSS.escape(fieldId);
  const binding = inspector.querySelector<HTMLElement>(
    `.graph-binding-field[data-graph-field="${escaped}"]`,
  );
  const configured = inspector.querySelector<HTMLElement>(`[data-graph-node-field="${escaped}"]`);
  const declaration = inspector.querySelector<HTMLDetailsElement>(
    `details[data-graph-field="${escaped}"]`,
  );
  const field =
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

const palette: { name: string; types: NodeType[] }[] = [
  { name: '开始与结束', types: ['START', 'END'] },
  {
    name: '功能节点',
    types: ['CHECKOUT', 'LOAD_ENV', 'SHELL', 'CHECK', 'BUILD', 'REGISTER_ARTIFACT', 'LOG'],
  },
  {
    name: '发布与验证',
    types: ['SOURCE_REVIEW', 'APPROVAL', 'DEPLOY_ARTIFACT', 'HEALTH_CHECK', 'ROLLBACK_ARTIFACT'],
  },
  {
    name: '流程控制',
    types: ['CONDITION', 'SWITCH', 'PARALLEL', 'JOIN', 'DELAY', 'FLOW_CALL'],
  },
];
const templateTypes = palette
  .flatMap(({ types }) => types)
  .filter((type) => !['START', 'END'].includes(type));

function makeNode(type: NodeType, project: ProjectDetail): GraphNode {
  const name = graphNodeLabels[type];
  const repo = project.repositories.length === 1 ? project.repositories[0] : undefined;
  return {
    id: graphKey('node'),
    type,
    name,
    ...(type === 'LOG' && { message: name }),
    ...(type === 'CHECKOUT' && { checkout: { fullClone: false } }),
    ...(type === 'SHELL' || type === 'CHECK'
      ? { shell: { location: 'TARGET' as const, timeout: 180 } }
      : {}),
    ...(type === 'BUILD' ? { build: { repositoryId: repo?.id } } : {}),
    ...(type === 'LOAD_ENV' ? { loadEnvironment: { required: true } } : {}),
    ...(type === 'DEPLOY_ARTIFACT' || type === 'ROLLBACK_ARTIFACT'
      ? { deploy: { method: 'FILE' as const } }
      : {}),
    ...(type === 'HEALTH_CHECK' ? { healthCheck: { command: '', timeoutSeconds: 30 } } : {}),
    ...(type === 'CONDITION' && { condition: { key: 'input', value: 'yes' } }),
    ...(type === 'SWITCH' && { switch: { key: 'input', cases: ['release'] } }),
    ...(type === 'DELAY' && { delaySeconds: 5 }),
    ...((type === 'APPROVAL' || type === 'SOURCE_REVIEW') && {
      approval: { timeoutSeconds: 3600 },
    }),
  };
}

function reachable(canvas: GraphCanvas, origin: string, reversed = false, stopAtBoundary = true) {
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

function pathHighlight(canvas: GraphCanvas, startId?: string) {
  const pair = canvas.endpoints.find((value) => value.startId === startId);
  if (!pair) return undefined;
  const accepts = (edge: GraphEdge) =>
    !pair.edgeSelections?.[edge.from]?.length || pair.edgeSelections[edge.from].includes(edge.to);
  const pathCanvas = { ...canvas, edges: canvas.edges.filter(accepts) };
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
      accepts(edge)
    )
      edges.add(index);
  });
  return { nodes, edges };
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
}) {
  const [selection, select] = useState<Selection | undefined>(
    initialNodeId ? { kind: 'node', id: initialNodeId } : undefined,
  );
  const [hovered, hover] = useState<string>();
  const [source, setSource] = useState<string>();
  const [connector, setConnector] = useState<Connector>();
  const [startId, setStartId] = useState<string | undefined>(initialFlowId);
  const [templateType, setTemplateType] = useState<NodeType>('CHECKOUT');
  const [error, setError] = useState('');
  const [focusRequest, setFocusRequest] = useState<FieldFocus | undefined>(() =>
    initialNodeId && initialFieldId
      ? { nodeId: initialNodeId, fieldId: initialFieldId }
      : undefined,
  );
  const handledFocus = useRef<FieldFocus>(undefined);
  const inspector = useRef<HTMLElement>(null);
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
  const activeEdge = selection?.kind === 'edge' ? canvas.edges[selection.index] : undefined;
  const selectedPair = canvas.endpoints.find((pair) => pair.startId === startId);
  const selectedPath = pathHighlight(canvas, selectedPair?.startId);
  const [catalogSnapshot, setCatalogSnapshot] = useState<{
    canvas: GraphCanvas;
    flows: GraphCatalog['flows'];
  }>();
  const hasActiveFlowNode = Boolean(activeNode && selectedPath?.nodes.has(activeNode.id));
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
  const flow = { id: project.id, name: project.name, nodes: canvas.nodes, edges: canvas.edges };
  const boundField = Boolean(
    focusRequest && selectedPair?.inputBindings?.[focusRequest.nodeId]?.[focusRequest.fieldId],
  );
  const pendingBindings = Boolean(
    activeNode && selectedPath?.nodes.has(activeNode.id) && catalog.loading,
  );
  useEffect(() => {
    if (!focusRequest || focusRequest === handledFocus.current || pendingBindings) return;
    if (inspected?.id !== focusRequest.nodeId) return;
    const frame = window.requestAnimationFrame(() => {
      if (!inspector.current) return;
      focusInspectorField(inspector.current, focusRequest.fieldId, boundField);
      handledFocus.current = focusRequest;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, inspected?.id, pendingBindings, boundField]);

  function patch(fields: Partial<GraphNode>) {
    if (!inspected || !canEdit) return;
    const change = (item: GraphNode) => (item.id === inspected.id ? { ...item, ...fields } : item);
    const nextOutputs =
      inspected.type === 'END' && fields.outputs
        ? new Set(fields.outputs.map(({ id }) => id))
        : undefined;
    const removedBindings = new Set(
      fields.shell?.params
        ? (inspected.shell?.params ?? [])
            .filter(({ id }) => !fields.shell?.params?.some((field) => field.id === id))
            .map(({ id }) => id)
        : [],
    );
    const nextBuild = inspected.type === 'SOURCE_REVIEW' ? fields.approval?.buildNodeId : undefined;
    const oldBuild =
      nextBuild && nextBuild !== inspected.approval?.buildNodeId
        ? inspected.approval?.buildNodeId
        : undefined;
    if (nextBuild) {
      removedBindings.add('source');
      removedBindings.add('artifact');
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
    onChange(
      template
        ? { ...canvas, templates: canvas.templates.map(change) }
        : { ...canvas, nodes: canvas.nodes.map(change), endpoints },
    );
  }
  function addNode(raw: GraphNode, position?: Position) {
    if (!canEdit) return;
    const copy = {
      ...structuredClone(raw),
      id: graphKey('node'),
      referenceName: undefined,
      position,
    };
    onChange({ ...canvas, nodes: [...canvas.nodes, copy] });
    select({ kind: 'node', id: copy.id });
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
    onChange({
      ...canvas,
      endpoints: [
        ...canvas.endpoints.filter((pair) => pair.startId !== startId),
        ...(endId ? [{ ...retained, startId, endId }] : []),
      ],
    });
    if (endId) setStartId(startId);
  }
  function updatePair(next: GraphEndpoint) {
    onChange({
      ...canvas,
      endpoints: canvas.endpoints.map((pair) => (pair.startId === next.startId ? next : pair)),
    });
  }
  const presetEnd =
    activeNode && canvas.endpoints.find(({ startId }) => startId === activeNode.id)?.endId;
  const canInsertPreset =
    activeNode?.type === 'START' &&
    Boolean(presetEnd) &&
    canvas.edges.filter(({ from }) => from === activeNode.id).length === 1 &&
    canvas.edges.some(({ from, to }) => from === activeNode.id && to === presetEnd);
  function insertPreset(types: NodeType[]) {
    if (!activeNode || !presetEnd || !canInsertPreset || !canEdit) return;
    const start = activeNode;
    const nodes = types.map((type) => makeNode(type, project));
    const checkout = nodes.find(({ type }) => type === 'CHECKOUT');
    const script = nodes.find(({ type }) => type === 'SHELL');
    const build = nodes.find((node) => node.type === 'BUILD');
    const review = nodes.find(({ type }) => type === 'SOURCE_REVIEW');
    const approval = nodes.find(({ type }) => type === 'APPROVAL');
    const deploy = nodes.find(isReleaseNode);
    const end = canvas.nodes.find((node) => node.id === presetEnd)!;
    const inputs = [...(start.inputs ?? [])];
    const outputs = [...(end.outputs ?? [])];
    const pair = canvas.endpoints.find(({ startId }) => startId === start.id)!;
    const addField = (fields: GraphField[], next: GraphField) => {
      const existing = fields.find(({ id }) => id === next.id);
      if (existing?.type === next.type) return existing.id;
      const id = existing ? graphKey('field') : next.id;
      fields.push({ ...next, id });
      return id;
    };
    const inputBindings = { ...pair.inputBindings };
    const environmentBindings = { ...pair.environmentBindings };
    const outputBindings = { ...pair.outputBindings };
    if (checkout) {
      const chosen = project.repositories.length === 1 ? project.repositories[0] : undefined;
      const repository: GraphBinding = chosen
        ? { kind: 'VALUE', value: chosen.id }
        : {
            kind: 'INPUT',
            fieldId: addField(inputs, {
              id: 'repository',
              name: '仓库',
              type: 'REPOSITORY',
              required: true,
            }),
          };
      const version = addField(inputs, {
        id: 'gitVersion',
        name: 'Git 版本',
        type: 'GIT_REF',
        required: false,
      });
      inputBindings[checkout.id] = {
        repository,
        version: {
          kind: 'INPUT',
          fieldId: version,
          onMissing: 'REPOSITORY_DEFAULT',
        },
      };
    }
    if (checkout && script) {
      inputBindings[script.id] = {
        source: { kind: 'OUTPUT', nodeId: checkout.id, fieldId: 'source' },
        workspace: { kind: 'OUTPUT', nodeId: checkout.id, fieldId: 'workspace' },
      };
      script.shell = {
        ...script.shell,
        location: 'MANAGER',
        command: 'printf \'VEYOPS_OUTPUT={"commit":"%s"}\\n\' "$VEYOPS_GIT_COMMIT_SHA"',
      };
      script.outputs = [{ id: 'commit', name: '实际提交 SHA', type: 'TEXT', required: true }];
      const result = addField(outputs, {
        id: 'commit',
        name: '实际提交 SHA',
        type: 'TEXT',
        required: true,
      });
      outputBindings[result] = { kind: 'OUTPUT', nodeId: script.id, fieldId: 'commit' };
    }
    if (build || deploy) {
      const service = pair.serviceId
        ? undefined
        : addField(inputs, { id: 'service', name: '服务', type: 'SERVICE', required: !!deploy });
      const releaseTargets =
        deploy &&
        addField(inputs, {
          id: 'releaseTargets',
          name: deploy.type === 'ROLLBACK_ARTIFACT' ? '回滚目标' : '发布目标',
          type: 'TARGETS',
          required: true,
        });
      for (const node of [build, deploy]) {
        if (!node) continue;
        const bindings: Record<string, GraphBinding> = {};
        const targets =
          releaseTargets ||
          addField(inputs, {
            id: 'buildTargets',
            name: '目标端构建服务器',
            type: 'TARGETS',
            required: false,
          });
        bindings.targets = { kind: 'INPUT', fieldId: targets };
        if (service) bindings.service = { kind: 'INPUT', fieldId: service };
        inputBindings[node.id] = bindings;
      }
    }
    if (build) {
      build.build = { ...build.build, buildLocation: deploy ? 'TARGET' : 'MANAGER' };
      if (checkout && review) {
        review.approval = { ...review.approval, buildNodeId: build.id };
        inputBindings[build.id].source = { kind: 'OUTPUT', nodeId: checkout.id, fieldId: 'source' };
        inputBindings[build.id].workspace = {
          kind: 'OUTPUT',
          nodeId: checkout.id,
          fieldId: 'workspace',
        };
        inputBindings[build.id].review = { kind: 'OUTPUT', nodeId: review.id, fieldId: 'review' };
        environmentBindings[build.id] = {
          GIT_SHA: { kind: 'OUTPUT', nodeId: checkout.id, fieldId: 'commitSha' },
        };
      } else if (!build.build.repositoryId) {
        const repo = addField(inputs, {
          id: 'repository',
          name: '仓库',
          type: 'REPOSITORY',
          required: true,
        });
        inputBindings[build.id].repository = { kind: 'INPUT', fieldId: repo };
      }
      const id = addField(outputs, {
        id: 'buildArtifacts',
        name: '构建产物',
        type: 'ARTIFACT',
        multiple: true,
        source: 'CURRENT_RUN',
        required: true,
      });
      outputBindings[id] = { kind: 'OUTPUT', nodeId: build.id, fieldId: 'artifacts' };
    }
    if (deploy) {
      if (approval) approval.approval = { ...approval.approval, releaseNodeId: deploy.id };
      if (build)
        inputBindings[deploy.id].artifact = {
          kind: 'OUTPUT',
          nodeId: build.id,
          fieldId: 'artifacts',
        };
      else {
        const id = addField(inputs, {
          id: 'artifact',
          name: deploy.type === 'ROLLBACK_ARTIFACT' ? '历史构建产物' : '构建产物',
          type: 'ARTIFACT',
          multiple: true,
          required: true,
        });
        inputBindings[deploy.id].artifact = { kind: 'INPUT', fieldId: id };
      }
      const id = addField(outputs, {
        id: 'release',
        name: '服务发布结果',
        type: 'RELEASE',
        required: true,
      });
      outputBindings[id] = { kind: 'OUTPUT', nodeId: deploy.id, fieldId: 'release' };
    }
    const path = [activeNode.id, ...nodes.map(({ id }) => id), presetEnd];
    onChange({
      ...canvas,
      nodes: [
        ...canvas.nodes.map((node) =>
          node.id === start.id
            ? { ...node, inputs }
            : node.id === end.id
              ? { ...node, outputs }
              : node,
        ),
        ...nodes,
      ],
      endpoints: canvas.endpoints.map((item) =>
        item.startId === start.id
          ? { ...item, inputBindings, environmentBindings, outputBindings }
          : item,
      ),
      edges: [
        ...canvas.edges.filter(({ from, to }) => from !== activeNode.id || to !== presetEnd),
        ...path.slice(1).map((to, i) => ({ from: path[i]!, to })),
      ],
    });
  }
  function detachEdge(index: number) {
    if (!canEdit) return;
    const edge = canvas.edges[index];
    if (!edge) return;
    const affected = canvas.endpoints.filter((pair) =>
      pathHighlight(canvas, pair.startId)?.edges.has(index),
    );
    onChange({
      ...canvas,
      edges: canvas.edges.filter((_, i) => index !== i),
      endpoints: canvas.endpoints.map((pair) => {
        if (!pair.edgeSelections?.[edge.from]?.includes(edge.to)) return pair;
        const selected = { ...pair.edgeSelections };
        delete selected[edge.from];
        return { ...pair, edgeSelections: selected };
      }),
    });
    select(undefined);
    if (affected.length)
      setError('连线变更影响 ' + affected.length + ' 条执行流，请重新检查数据来源。');
  }
  function deleteNode(id: string) {
    if (!canEdit) return;
    const affected = canvas.endpoints.filter((pair) =>
      pathHighlight(canvas, pair.startId)?.nodes.has(id),
    );
    onChange({
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
            Object.entries(pair.edgeSelections ?? {}).filter(
              ([from, targets]) => from !== id && !targets.includes(id),
            ),
          );
          return { ...pair, inputBindings, environmentBindings, edgeSelections };
        }),
    });
    select(undefined);
    setSource(undefined);
    setConnector(undefined);
    if (affected.length)
      setError('节点变更影响 ' + affected.length + ' 条执行流，请重新检查数据来源。');
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
  function beginConnection(id: string) {
    setSource((current) => (current === id ? undefined : id));
    setConnector(undefined);
    select(undefined);
    setError('');
  }
  function connect(target: string) {
    if (!source || !canEdit) return;
    setSource(undefined);
    if (canvas.edges.some(({ from, to }) => from === source && to === target)) {
      setError('这两个节点已经连接。');
      return;
    }
    if (reachable(canvas, target, false, false).has(source)) {
      setError('这条连线会形成循环。');
      return;
    }
    const owner = canvas.nodes.find(({ id }) => id === source);
    const options = branchOptions(owner).filter(
      ({ value }) => !canvas.edges.some(({ from, when }) => from === source && when === value),
    );
    if (owner && branchOptions(owner).length && !options.length) {
      setError('这个节点的每个分支都有了连线，请先删除或调整已有连线。');
      return;
    }
    if (options.length > 1) {
      setConnector({ from: source, to: target });
      return;
    }
    addEdge({ from: source, to: target, ...(options[0] && { when: options[0].value }) });
  }
  function addEdge(edge: GraphEdge, index?: number) {
    onChange({
      ...canvas,
      edges:
        index === undefined
          ? [...canvas.edges, edge]
          : canvas.edges.map((item, i) => (i === index ? edge : item)),
    });
    setConnector(undefined);
    setError('');
  }
  function selectNode(id: string) {
    select({ kind: 'node', id });
    setFocusRequest(undefined);
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
      {canEdit && (
        <aside className="graph-palette" aria-label="节点库">
          <h3>节点库</h3>
          {palette.map(({ name, types }) => (
            <div className="graph-palette-group" key={name}>
              <h4>{name}</h4>
              {types.map((type) => (
                <button
                  type="button"
                  key={type}
                  draggable
                  className="graph-palette-node"
                  onDragStart={(event) => drag(event, 'type:' + type)}
                  onClick={() => addNode(makeNode(type, project))}
                >
                  <Plus size={14} />
                  {graphNodeLabels[type]}
                </button>
              ))}
            </div>
          ))}
          <div className="graph-palette-group">
            <h4>预设功能节点</h4>
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
                  setConnector(undefined);
                  setSource(undefined);
                }}
              >
                <Copy size={14} />
                {item.name || '未命名模板'}
              </button>
            ))}
            <label className="graph-palette-input">
              <span>模板类型</span>
              <select
                value={templateType}
                onChange={(event) => setTemplateType(event.target.value as NodeType)}
              >
                {templateTypes.map((type) => (
                  <option key={type} value={type}>
                    {graphNodeLabels[type]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                const item = { ...makeNode(templateType, project), id: graphKey('template') };
                onChange({ ...canvas, templates: [...canvas.templates, item] });
                select({ kind: 'template', id: item.id });
                setConnector(undefined);
                setSource(undefined);
              }}
            >
              <Plus size={15} />
              新建模板
            </button>
          </div>
        </aside>
      )}
      <div className="graph-canvas-column">
        <div className="graph-canvas-help">
          {canEdit && <p>拖节点到画布，点击两端连接点连线。右键节点或连线打开操作菜单。</p>}
          {source && (
            <p role="status">
              从「{canvas.nodes.find(({ id }) => id === source)?.name}」连线，选择一个下游连接点。{' '}
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
              onChange={(event) => setStartId(event.target.value || undefined)}
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
                    onClick={() => {
                      const nodeId = issue.nodeId ?? issue.flowId;
                      if (nodeId && canvas.nodes.some(({ id }) => id === nodeId)) {
                        selectNode(nodeId);
                        if (issue.fieldId) setFocusRequest({ nodeId, fieldId: issue.fieldId });
                      }
                      if (issue.flowId) setStartId(issue.flowId);
                    }}
                  >
                    {issue.flowId &&
                      canvas.nodes.find(({ id }) => id === issue.flowId)?.name + ' · '}
                    {issue.message}
                    {issue.branchId ? ' · ' + issue.branchId : ''}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <ErrorBanner error={catalog.error} retry={catalog.reload} />
        {missingRepairNode && <ErrorBanner error="运行问题关联的节点已不在当前草稿中。" />}
        <ErrorBanner error={error} />
        <NodeMap
          flow={flow}
          selected={activeNode ? [activeNode.id] : []}
          selectedEdge={activeEdge && selection?.kind === 'edge' ? selection.index : undefined}
          highlighted={highlight?.nodes}
          highlightEdges={highlight?.edges}
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
          onEdgeSelect={
            canEdit
              ? (index) => {
                  select({ kind: 'edge', index });
                  setSource(undefined);
                  setConnector(undefined);
                  setError('');
                }
              : undefined
          }
          onEdgeDelete={canEdit ? detachEdge : undefined}
          connecting={source}
          onConnectSource={canEdit ? beginConnection : undefined}
          onConnectTarget={canEdit ? connect : undefined}
        />
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
      </div>
      {(inspected || activeEdge || connector) && (
        <aside ref={inspector} className="graph-inspector graph-properties" aria-label="选中项属性">
          {inspected && (
            <>
              <h3 tabIndex={-1}>
                {template ? '模板属性' : '节点属性'} · {graphNodeLabels[inspected.type]}
              </h3>
              <NodeFields
                key={inspected.id}
                project={project}
                node={inspected}
                canvas={canvas}
                canEdit={canEdit}
                patch={patch}
                catalog={catalog.data}
              />
              {activeNode?.type === 'CHECKOUT' && !hasActiveFlowNode && (
                <p className="field-note">选择包含此节点的执行流，即可绑定仓库和 Git 版本。</p>
              )}
              {activeNode &&
                renderResources?.(
                  activeNode,
                  selectedPath?.nodes.has(activeNode.id) ? selectedPair : undefined,
                )}
              {activeNode?.type === 'START' && (
                <>
                  <StartPair
                    node={activeNode}
                    canvas={canvas}
                    canEdit={canEdit}
                    assign={assignEnd}
                  />
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
                  {canEdit && canInsertPreset && (
                    <GraphTemplatePicker templates={graphTemplates} add={insertPreset} />
                  )}
                  {renderStart?.(activeNode.id)}
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
              {activeNode && selectedPair && (
                <>
                  <GraphFlowBranches
                    node={activeNode}
                    canvas={canvas}
                    outgoing={canvas.edges
                      .filter(
                        ({ from, to }) =>
                          from === activeNode.id &&
                          reachable(canvas, to, false).has(selectedPair.endId),
                      )
                      .map(({ to }) => to)}
                    endpoint={selectedPair}
                    update={updatePair}
                    canEdit={canEdit}
                  />
                  {selectedPath?.nodes.has(activeNode.id) && (
                    <ExecutionGraphBindings
                      canvas={canvas}
                      node={activeNode}
                      endpoint={selectedPair}
                      flowEdgeIndexes={selectedPath.edges}
                      catalog={catalog.data}
                      directory={
                        catalogSnapshot?.canvas === canvas ? catalogSnapshot.flows : undefined
                      }
                      project={project}
                      canEdit={canEdit}
                      update={updatePair}
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
                  <button type="button" className="button secondary small" onClick={duplicate}>
                    <Copy size={15} />
                    {template ? '复制模板' : '复制节点'}
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={removeSelection}
                  >
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
        </aside>
      )}
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
            <option value="">选择分支</option>
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
            disabled={!options.some(({ value }) => value === when)}
            onClick={() => commit({ ...edge, when }, index)}
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
      <h4>环境变量</h4>
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
      <Field label="环境文件来源">
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

function NodeFields({ node, project, canvas, canEdit, patch, catalog }: FieldsProps) {
  const downstream =
    node.type === 'APPROVAL' || node.type === 'SOURCE_REVIEW'
      ? reachable(canvas, node.id)
      : undefined;
  const downstreamReleases = canvas.nodes.filter(
    (candidate) => downstream?.has(candidate.id) && isReleaseNode(candidate),
  );
  const downstreamBuilds = canvas.nodes.filter(
    (candidate) => downstream?.has(candidate.id) && candidate.type === 'BUILD',
  );
  return (
    <>
      <Field label="节点名称">
        <input
          readOnly={!canEdit}
          maxLength={100}
          value={node.name}
          onChange={(event) => patch({ name: event.target.value })}
        />
      </Field>
      <Field label="节点引用名" hint="留空时系统分配。修改引用名后仍使用原有绑定。">
        <input
          readOnly={!canEdit}
          maxLength={64}
          value={node.referenceName ?? ''}
          onChange={(event) => patch({ referenceName: event.target.value || undefined })}
        />
      </Field>
      {node.type === 'LOG' && (
        <Field label="日志内容">
          <textarea
            readOnly={!canEdit}
            maxLength={2000}
            value={node.message ?? ''}
            onChange={(event) => patch({ message: event.target.value || undefined })}
          />
        </Field>
      )}
      {node.type === 'CHECKOUT' && (
        <label className="checkbox-row">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={Boolean(node.checkout?.fullClone)}
            onChange={(event) =>
              patch({ checkout: { ...node.checkout, fullClone: event.target.checked } })
            }
          />{' '}
          拉取完整历史
        </label>
      )}
      {(node.type === 'SHELL' || node.type === 'CHECK') && (
        <>
          <ShellFields node={node} canEdit={canEdit} patch={patch} />
          <p className="field-note">
            用端口标识读取环境变量。脚本可按 <code>{'VEYOPS_OUTPUT={"REPORT_CODE":"ok"}'}</code>{' '}
            输出结构化值。
          </p>
          <GraphFieldEditor
            title="脚本输入端口"
            scriptPort
            project={project}
            catalog={catalog}
            type="input"
            disabled={!canEdit}
            fields={node.shell?.params ?? []}
            change={(params) => patch({ shell: { ...node.shell, params } })}
          />
          <GraphFieldEditor
            title="脚本输出端口"
            scriptPort
            project={project}
            catalog={catalog}
            type="output"
            disabled={!canEdit}
            fields={node.outputs ?? []}
            change={(outputs) => patch({ outputs })}
          />
        </>
      )}
      {node.type === 'BUILD' && (
        <BuildFields
          project={project}
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
      {node.type === 'SOURCE_REVIEW' && (
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
      {node.type === 'ROLLBACK_ARTIFACT' && (
        <p className="field-note">
          选择要恢复的历史产物。自动回滚须绑定明确报告应用不健康的检查结果，用它确认逐台服务器的回滚基线。
        </p>
      )}
      {node.type === 'HEALTH_CHECK' && (
        <>
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
                    command: node.healthCheck?.command ?? '',
                    timeoutSeconds: event.target.value ? Number(event.target.value) : undefined,
                  },
                })
              }
            />
          </Field>
        </>
      )}
      {node.type === 'REGISTER_ARTIFACT' && (
        <ArtifactOutputEditor
          value={node.registerArtifacts?.artifacts ?? []}
          canEdit={canEdit}
          onChange={(artifacts) => patch({ registerArtifacts: { artifacts } })}
        />
      )}
      {node.type === 'LOAD_ENV' && (
        <LoadEnvironmentFields key={node.id} node={node} canEdit={canEdit} patch={patch} />
      )}
      {node.type === 'CONDITION' && (
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
      {node.type === 'SWITCH' && <SwitchFields node={node} canEdit={canEdit} patch={patch} />}
      {node.type === 'DELAY' && (
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
      {node.type === 'APPROVAL' && (
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
      {(node.type === 'APPROVAL' || node.type === 'SOURCE_REVIEW') && (
        <Field
          label={node.type === 'SOURCE_REVIEW' ? '审核超时（秒）' : '审批超时（秒）'}
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
      {node.type === 'FLOW_CALL' && (
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
      {node.type === 'CHECK' && (
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
      <Field label="Shell 脚本">
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
