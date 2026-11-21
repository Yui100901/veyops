import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Copy, Plus, Trash2, ArrowRight, ArrowLeft } from 'lucide-react';
import { useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type { ProjectDetail, Server } from '../models';
import { graphDragType, NodeMap } from './ExecutionGraphCanvas';
import {
  ArtifactOutputEditor,
  BuildFields,
  DeployFields,
  graphTemplates,
} from './ExecutionGraphPresets';
import { GraphFieldEditor } from './ExecutionGraphFields';
import {
  ExecutionGraphBindings,
  GraphFlowBranches,
  GraphTemplatePicker,
} from './ExecutionGraphBindings';
import { BranchSyncControls, useRepositoryBranches } from './RepositoryBranches';
import { branchOptions, graphKey, graphNodeLabels } from './execution-graph-definition';
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
  const controls = 'select:enabled, input:enabled, textarea:enabled';
  const control = field.matches(controls) ? field : field.querySelector<HTMLElement>(controls);
  field.scrollIntoView({ block: 'nearest' });
  (control ?? inspector.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true });
}

const palette: { name: string; types: NodeType[] }[] = [
  { name: '开始与结束', types: ['START', 'END'] },
  {
    name: '功能节点',
    types: [
      'CHECKOUT',
      'LOAD_ENV',
      'SHELL',
      'CHECK',
      'BUILD',
      'REGISTER_ARTIFACT',
      'DEPLOY_ARTIFACT',
      'LOG',
    ],
  },
  {
    name: '流程控制',
    types: ['CONDITION', 'SWITCH', 'PARALLEL', 'JOIN', 'DELAY', 'APPROVAL', 'FLOW_CALL'],
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
    ...(type === 'CHECKOUT' &&
      repo && {
        checkout: {
          repositoryId: repo.id,
          mode: 'BRANCH',
          ...(repo.defaultBranch && { branch: repo.defaultBranch }),
        },
      }),
    ...(type === 'SHELL' || type === 'CHECK'
      ? { shell: { location: 'TARGET' as const, timeout: 180 } }
      : {}),
    ...(type === 'BUILD' ? { build: { repositoryId: repo?.id } } : {}),
    ...(type === 'DEPLOY_ARTIFACT' ? { deploy: {} } : {}),
    ...(type === 'CONDITION' && { condition: { key: 'input', value: 'yes' } }),
    ...(type === 'SWITCH' && { switch: { key: 'input', cases: ['release'] } }),
    ...(type === 'DELAY' && { delaySeconds: 5 }),
    ...(type === 'APPROVAL' && { approval: { timeoutSeconds: 3600 } }),
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
    const removedParameters = new Set(
      fields.shell?.params
        ? (inspected.shell?.params ?? [])
            .filter(({ id }) => !fields.shell?.params?.some((field) => field.id === id))
            .map(({ id }) => id)
        : [],
    );
    const endpoints = canvas.endpoints.map((pair) => {
      if (nextOutputs && pair.endId === inspected.id)
        return {
          ...pair,
          outputBindings: Object.fromEntries(
            Object.entries(pair.outputBindings ?? {}).filter(([id]) => nextOutputs.has(id)),
          ),
        };
      if (removedParameters.size && pair.inputBindings?.[inspected.id])
        return {
          ...pair,
          inputBindings: {
            ...pair.inputBindings,
            [inspected.id]: Object.fromEntries(
              Object.entries(pair.inputBindings[inspected.id]).filter(
                ([id]) => !removedParameters.has(id),
              ),
            ),
          },
        };
      return pair;
    });
    onChange(
      template
        ? { ...canvas, templates: canvas.templates.map(change) }
        : { ...canvas, nodes: canvas.nodes.map(change), endpoints },
    );
  }
  function addNode(raw: GraphNode, position?: Position) {
    if (!canEdit) return;
    const copy = { ...structuredClone(raw), id: graphKey('node'), position };
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
    const build = nodes.find((node) => node.type === 'BUILD');
    const deploy = nodes.find((node) => node.type === 'DEPLOY_ARTIFACT');
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
    const outputBindings = { ...pair.outputBindings };
    if (build || deploy) {
      const environment = addField(inputs, {
        id: 'environment',
        name: '环境',
        type: 'ENVIRONMENT',
        required: true,
      });
      const targets = addField(inputs, {
        id: 'targets',
        name: '部署目标',
        type: 'TARGETS',
        required: false,
      });
      const service = pair.serviceId
        ? undefined
        : addField(inputs, { id: 'service', name: '服务', type: 'SERVICE', required: true });
      for (const node of nodes.filter(
        ({ type }) => type === 'BUILD' || type === 'DEPLOY_ARTIFACT',
      )) {
        const bindings: Record<string, GraphBinding> = {
          environment: { kind: 'INPUT', fieldId: environment },
          targets: { kind: 'INPUT', fieldId: targets },
        };
        if (service) bindings.service = { kind: 'INPUT', fieldId: service };
        inputBindings[node.id] = bindings;
      }
    }
    if (build) {
      if (!build.build?.repositoryId) {
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
      if (build)
        inputBindings[deploy.id].artifact = {
          kind: 'OUTPUT',
          nodeId: build.id,
          fieldId: 'artifacts',
        };
      else {
        const id = addField(inputs, {
          id: 'artifact',
          name: '构建产物',
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
        item.startId === start.id ? { ...item, inputBindings, outputBindings } : item,
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
          const edgeSelections = Object.fromEntries(
            Object.entries(pair.edgeSelections ?? {}).filter(
              ([from, targets]) => from !== id && !targets.includes(id),
            ),
          );
          return { ...pair, inputBindings, edgeSelections };
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
      const copy = { ...structuredClone(template), id: graphKey('template') };
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
                    fields={activeNode.inputs ?? []}
                    change={(inputs) => patch({ inputs })}
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

function NodeFields({ node, project, canvas, canEdit, patch, catalog }: FieldsProps) {
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
        <CheckoutFields project={project} node={node} canEdit={canEdit} patch={patch} />
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
      {node.type === 'DEPLOY_ARTIFACT' && (
        <DeployFields
          value={node.deploy ?? {}}
          canEdit={canEdit}
          change={(deploy) => patch({ deploy })}
        />
      )}
      {node.type === 'REGISTER_ARTIFACT' && (
        <ArtifactOutputEditor
          value={node.registerArtifacts?.artifacts ?? []}
          canEdit={canEdit}
          onChange={(artifacts) => patch({ registerArtifacts: { artifacts } })}
        />
      )}
      {node.type === 'LOAD_ENV' && (
        <>
          <Field label="环境文件（可选）" hint="留空沿用环境配置。">
            <input
              disabled={!canEdit}
              value={node.loadEnvironment?.envFile ?? ''}
              onChange={(event) =>
                patch({
                  loadEnvironment: {
                    ...node.loadEnvironment,
                    envFile: event.target.value || undefined,
                  },
                })
              }
              placeholder=".env.test"
            />
          </Field>
          <Field label="工作区相对目录（可选）">
            <input
              disabled={!canEdit}
              value={node.loadEnvironment?.directory ?? ''}
              onChange={(event) =>
                patch({
                  loadEnvironment: {
                    ...node.loadEnvironment,
                    directory: event.target.value || undefined,
                  },
                })
              }
              placeholder="."
            />
          </Field>
        </>
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
        <Field label="审批超时（秒）" hint="留空默认 86400 秒。">
          <input
            type="number"
            min={1}
            max={604800}
            readOnly={!canEdit}
            value={node.approval?.timeoutSeconds ?? ''}
            onChange={(event) =>
              patch({
                approval: event.target.value ? { timeoutSeconds: Number(event.target.value) } : {},
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

function CheckoutFields({ project, node, canEdit, patch }: Omit<FieldsProps, 'canvas'>) {
  const settings = node.checkout ?? { repositoryId: '', mode: 'BRANCH' as const };
  const repo = project.repositories.find(({ id }) => id === settings.repositoryId);
  const path = repo
    ? '/projects/' + encodeURIComponent(project.id) + '/repositories/' + encodeURIComponent(repo.id)
    : null;
  const branches = useRepositoryBranches(path && settings.mode === 'BRANCH' ? path : null);
  const choices = new Set([
    ...(repo?.defaultBranch ? [repo.defaultBranch] : []),
    ...(branches.data?.branches.map(({ name }) => name) ?? []),
    ...(settings.branch ? [settings.branch] : []),
  ]);
  return (
    <>
      <Field
        label="项目仓库"
        hint={project.repositories.length ? undefined : '请先在项目中登记仓库。'}
      >
        <select
          data-graph-node-field="repository"
          disabled={!canEdit}
          value={settings.repositoryId}
          onChange={(event) => {
            const selected = project.repositories.find(({ id }) => id === event.target.value);
            patch({
              checkout: selected
                ? {
                    repositoryId: selected.id,
                    mode: settings.mode,
                    ...(settings.mode === 'BRANCH' && selected.defaultBranch
                      ? { branch: selected.defaultBranch }
                      : {}),
                    fullClone: settings.fullClone,
                  }
                : undefined,
            });
          }}
        >
          <option value="">选择仓库</option>
          {project.repositories.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="代码版本">
        <select
          disabled={!canEdit}
          value={settings.mode}
          onChange={(event) =>
            patch({
              checkout: {
                repositoryId: settings.repositoryId,
                mode: event.target.value as typeof settings.mode,
                fullClone: settings.fullClone,
                ...(event.target.value === 'BRANCH' && repo?.defaultBranch
                  ? { branch: repo.defaultBranch }
                  : {}),
              },
            })
          }
        >
          <option value="BRANCH">分支最新提交</option>
          <option value="TAG">Git 标签</option>
          <option value="COMMIT">指定提交哈希</option>
        </select>
      </Field>
      {repo && settings.mode === 'BRANCH' && (
        <>
          <Field label="仓库分支" hint="运行预览时解析分支最新提交。">
            <select
              disabled={!canEdit}
              value={settings.branch ?? ''}
              onChange={(event) =>
                patch({ checkout: { ...settings, branch: event.target.value || undefined } })
              }
            >
              <option value="">{branches.loading ? '读取分支…' : '选择分支'}</option>
              {[...choices].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          {canEdit && <BranchSyncControls branches={branches} />}
        </>
      )}
      {settings.mode === 'TAG' && (
        <Field label="Git 标签">
          <input
            readOnly={!canEdit}
            value={settings.tag ?? ''}
            onChange={(event) =>
              patch({ checkout: { ...settings, tag: event.target.value.trim() || undefined } })
            }
          />
        </Field>
      )}
      {settings.mode === 'COMMIT' && (
        <Field label="Git 提交哈希" hint="填写完整 SHA。">
          <input
            readOnly={!canEdit}
            maxLength={64}
            value={settings.commitSha ?? ''}
            onChange={(event) =>
              patch({
                checkout: { ...settings, commitSha: event.target.value.trim() || undefined },
              })
            }
          />
        </Field>
      )}
      {
        <label className="checkbox-row">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={Boolean(settings.fullClone)}
            onChange={(event) =>
              patch({ checkout: { ...settings, fullClone: event.target.checked } })
            }
          />{' '}
          拉取完整历史
        </label>
      }
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
