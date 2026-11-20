import { useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Copy, Plus, Trash2, ArrowRight, ArrowLeft } from 'lucide-react';
import { useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type { ProjectDetail, Server } from '../models';
import { graphDragType, NodeMap } from './ExecutionGraphCanvas';
import { StartDeliveryFields } from './ExecutionGraphPresets';
import { BranchSyncControls, useRepositoryBranches } from './RepositoryBranches';
import { branchOptions, graphKey, graphNodeLabels } from './execution-graph-definition';
import type { GraphCanvas, GraphEdge, GraphNode } from './execution-graph-definition';
import './execution-graph-editor.css';

type NodeType = GraphNode['type'];
type Position = NonNullable<GraphNode['position']>;
type Selection = { kind: 'node' | 'template'; id: string } | { kind: 'edge'; index: number };
type Connector = Pick<GraphEdge, 'from' | 'to'>;

const palette: { name: string; types: NodeType[] }[] = [
  { name: '开始与结束', types: ['START', 'END'] },
  { name: '功能节点', types: ['CHECKOUT', 'SHELL', 'BUILD', 'DEPLOY_ARTIFACT', 'LOG'] },
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
  const forward = reachable(canvas, pair.startId);
  if (!forward.has(pair.endId)) return undefined;
  const ancestors = reachable(canvas, pair.endId, true);
  const nodes = new Set([...forward].filter((id) => ancestors.has(id)));
  const edges = new Set<number>();
  canvas.edges.forEach((edge, index) => {
    if (
      nodes.has(edge.from) &&
      nodes.has(edge.to) &&
      edge.from !== pair.endId &&
      edge.to !== pair.startId
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
}: {
  canvas: GraphCanvas;
  project: ProjectDetail;
  canEdit: boolean;
  onChange: (canvas: GraphCanvas) => void;
  renderStart?: (startId: string) => ReactNode;
}) {
  const [selection, select] = useState<Selection>();
  const [hovered, hover] = useState<string>();
  const [source, setSource] = useState<string>();
  const [connector, setConnector] = useState<Connector>();
  const [templateType, setTemplateType] = useState<NodeType>('CHECKOUT');
  const [error, setError] = useState('');
  const activeNode =
    selection?.kind === 'node' ? canvas.nodes.find(({ id }) => id === selection.id) : undefined;
  const template =
    selection?.kind === 'template'
      ? canvas.templates.find(({ id }) => id === selection.id)
      : undefined;
  const inspected = activeNode ?? template;
  const activeEdge = selection?.kind === 'edge' ? canvas.edges[selection.index] : undefined;
  const highlight = pathHighlight(canvas, hovered);
  const flow = { id: project.id, name: project.name, nodes: canvas.nodes, edges: canvas.edges };
  function patch(fields: Partial<GraphNode>) {
    if (!inspected || !canEdit) return;
    const change = (item: GraphNode) => (item.id === inspected.id ? { ...item, ...fields } : item);
    onChange(
      template
        ? { ...canvas, templates: canvas.templates.map(change) }
        : { ...canvas, nodes: canvas.nodes.map(change) },
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
    onChange({
      ...canvas,
      endpoints: [
        ...canvas.endpoints.filter((pair) => pair.startId !== startId),
        ...(endId ? [{ startId, endId }] : []),
      ],
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
    const nodes = types.map((type) => makeNode(type, project));
    const path = [activeNode.id, ...nodes.map(({ id }) => id), presetEnd];
    onChange({
      ...canvas,
      nodes: [...canvas.nodes, ...nodes],
      edges: [
        ...canvas.edges.filter(({ from, to }) => from !== activeNode.id || to !== presetEnd),
        ...path.slice(1).map((to, i) => ({ from: path[i]!, to })),
      ],
    });
  }
  function detachEdge(index: number) {
    if (!canEdit) return;
    onChange({ ...canvas, edges: canvas.edges.filter((_, i) => index !== i) });
    select(undefined);
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
      const id = activeNode.id;
      onChange({
        ...canvas,
        nodes: canvas.nodes.filter((item) => item.id !== id),
        edges: canvas.edges.filter((edge) => edge.from !== id && edge.to !== id),
        endpoints: canvas.endpoints.filter((pair) => pair.startId !== id && pair.endId !== id),
      });
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
    setConnector(undefined);
    setSource(undefined);
    setError('');
  }
  function duplicate() {
    if (!inspected) return;
    if (template) {
      const copy = { ...structuredClone(template), id: graphKey('template') };
      onChange({ ...canvas, templates: [...canvas.templates, copy] });
      select({ kind: 'template', id: copy.id });
      return;
    }
    addNode(
      inspected,
      inspected.position && {
        x: Math.min(30000, inspected.position.x + 30),
        y: Math.min(30000, inspected.position.y + 30),
      },
    );
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
          {canEdit && <p>拖节点到画布，点击两端连接点连线。选中连线后可点 × 删除。</p>}
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
        <aside className="graph-inspector graph-properties" aria-label="选中项属性">
          {inspected && (
            <>
              <h3>
                {template ? '模板属性' : '节点属性'} · {graphNodeLabels[inspected.type]}
              </h3>
              <NodeFields
                key={inspected.id}
                project={project}
                node={inspected}
                canvas={canvas}
                canEdit={canEdit}
                patch={patch}
              />
              {activeNode?.type === 'START' && (
                <>
                  <StartPair
                    node={activeNode}
                    canvas={canvas}
                    canEdit={canEdit}
                    assign={assignEnd}
                  />
                  <StartDeliveryFields
                    project={project}
                    value={activeNode.delivery}
                    canEdit={canEdit}
                    change={(delivery) => patch({ delivery })}
                    insert={canInsertPreset ? insertPreset : undefined}
                  />
                  {renderStart?.(activeNode.id)}
                </>
              )}
              {activeNode?.type === 'END' && (
                <EndPairs
                  key={activeNode.id}
                  canvas={canvas}
                  node={activeNode}
                  canEdit={canEdit}
                  assign={assignEnd}
                />
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
}

function NodeFields({ node, project, canvas, canEdit, patch }: FieldsProps) {
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
      {node.type === 'SHELL' && <ShellFields node={node} canEdit={canEdit} patch={patch} />}
      {(node.type === 'BUILD' || node.type === 'DEPLOY_ARTIFACT') && (
        <p className="field-note">此节点使用开始节点配置的服务和执行流预设。</p>
      )}
      {node.type === 'CONDITION' && (
        <div className="form-grid">
          <Field label="判断依据">
            <select
              disabled={!canEdit}
              value={node.condition?.key ?? 'input'}
              onChange={(event) =>
                patch({
                  condition: {
                    key: event.target.value as 'input' | 'commitSha',
                    value: node.condition?.value ?? '',
                  },
                })
              }
            >
              <option value="input">运行参数</option>
              <option value="commitSha">提交 SHA</option>
            </select>
          </Field>
          <Field label="等于">
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
      <Field label="多路判断依据">
        <select
          disabled={!canEdit}
          value={config.key}
          onChange={(event) =>
            patch({ switch: { ...config, key: event.target.value as typeof config.key } })
          }
        >
          <option value="input">运行参数</option>
          <option value="commitSha">提交 SHA</option>
        </select>
      </Field>
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
          disabled={!canEdit || !repo}
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
      {repo && settings.mode === 'COMMIT' && (
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
      {repo && (
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
      <Field label="执行服务器">
        <select
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
