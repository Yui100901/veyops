import { useState } from 'react';
import { Plus, Scissors } from 'lucide-react';
import { message, post } from '../api';
import { ErrorBanner, Field } from '../components';
import type { ProjectDetail } from '../models';
import { NodeMap } from './ExecutionGraphCanvas';
import { PipelineReference } from './ExecutionGraphPipelineReference';
import { graphKey, graphNodeLabels } from './execution-graph-definition';
import type { GraphDocument, GraphEdge, GraphFlow, GraphNode } from './execution-graph-definition';

function makeNode(type: GraphNode['type'], name = graphNodeLabels[type]): GraphNode {
  return {
    id: graphKey('node'),
    type,
    name,
    ...(type === 'LOG' ? { message: name } : {}),
    ...(type === 'CONDITION' ? { condition: { key: 'input', value: 'yes' } } : {}),
  };
}

export function FlowEditor({
  project,
  flow,
  flows,
  canEdit,
  path,
  revision,
  dirty,
  onChange,
  onExtracted,
  onRemoveFlow,
}: {
  project: ProjectDetail;
  flow: GraphFlow;
  flows: GraphFlow[];
  canEdit: boolean;
  path: string;
  revision: number;
  dirty: boolean;
  onChange: (flow: GraphFlow) => void;
  onExtracted: (graph: GraphDocument, newFlowId: string) => void;
  onRemoveFlow?: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([flow.nodes[0].id]);
  const [multiple, setMultiple] = useState(false);
  const [moving, setMoving] = useState(false);
  const [adding, setAdding] = useState<GraphNode['type']>('LOG');
  const [insertEdge, setInsertEdge] = useState<number>();
  const [openConnector, setOpenConnector] = useState(false);
  const [edgeIndex, setEdgeIndex] = useState<number>();
  const node = flow.nodes.find((n) => n.id === selected.at(-1));
  const edge =
    flow.edges[
      insertEdge ??
        flow.edges.findIndex(({ to }) => flow.nodes.find(({ id }) => id === to)?.type === 'END')
    ];
  const nameOf = (id: string) => flow.nodes.find((n) => n.id === id)?.name ?? id;
  const patch = (fields: Partial<GraphNode>) =>
    onChange({
      ...flow,
      nodes: flow.nodes.map((n) => (n.id === node?.id ? { ...n, ...fields } : n)),
    });
  const limit = (adding === 'CONDITION' || adding === 'PARALLEL') && edge ? 96 : 99;

  function add() {
    const item = makeNode(adding);
    const newNodes = [item];
    const edges = flow.edges.flatMap((current) => {
      if (current !== edge) return [current];
      const before = { ...current, to: item.id };
      if (adding !== 'CONDITION' && adding !== 'PARALLEL')
        return [before, { from: item.id, to: current.to }];
      const branches = [
        makeNode('LOG', adding === 'CONDITION' ? '条件成立' : '并行路径 A'),
        makeNode('LOG', adding === 'CONDITION' ? '条件不成立' : '并行路径 B'),
      ];
      const join = makeNode('JOIN');
      newNodes.push(...branches, join);
      return [
        before,
        ...branches.flatMap((branch, i): GraphEdge[] => [
          {
            from: item.id,
            to: branch.id,
            ...(adding === 'CONDITION' ? { when: i === 0 ? 'TRUE' : 'FALSE' } : {}),
          },
          { from: branch.id, to: join.id },
        ]),
        { from: join.id, to: current.to },
      ];
    });
    onChange({ ...flow, nodes: [...flow.nodes, ...newNodes], edges });
    setSelected([item.id]);
    setInsertEdge(undefined);
    setEdgeIndex(undefined);
  }

  function removeNode(id: string) {
    const incoming = flow.edges.filter((e) => e.to === id);
    const outgoing = flow.edges.filter((e) => e.from === id);
    const edges = flow.edges.filter((e) => e.from !== id && e.to !== id);
    if (
      incoming.length === 1 &&
      outgoing.length === 1 &&
      !outgoing[0].when &&
      !edges.some(({ from, to }) => from === incoming[0].from && to === outgoing[0].to)
    )
      edges.push({ ...incoming[0], to: outgoing[0].to });
    onChange({ ...flow, nodes: flow.nodes.filter((n) => n.id !== id), edges });
    setSelected((all) => all.filter((value) => value !== id));
    setInsertEdge(undefined);
    setEdgeIndex(undefined);
  }

  function select(id: string, additive: boolean) {
    setSelected((current) =>
      additive ? (current.includes(id) ? current.filter((v) => v !== id) : [...current, id]) : [id],
    );
  }
  const extractIds = selected.filter((id) => {
    const type = flow.nodes.find((item) => item.id === id)?.type;
    return type && type !== 'START' && type !== 'END';
  });
  return (
    <>
      {canEdit && (
        <div className="graph-flow-select">
          <Field label="执行流名称">
            <input
              value={flow.name}
              maxLength={100}
              onChange={(e) => onChange({ ...flow, name: e.target.value })}
            />
          </Field>
          {onRemoveFlow && (
            <button type="button" className="button secondary" onClick={onRemoveFlow}>
              从草稿移除执行流
            </button>
          )}
        </div>
      )}
      {canEdit && (
        <div className="heading-actions">
          <button
            type="button"
            className="button secondary small"
            aria-pressed={multiple}
            onClick={() => {
              setMultiple(!multiple);
              setMoving(false);
            }}
          >
            多选节点
          </button>
          <button
            type="button"
            className="button secondary small"
            aria-pressed={moving}
            onClick={() => {
              setMoving(!moving);
              setMultiple(false);
            }}
          >
            移动节点
          </button>
          {flow.nodes.some((node) => node.position) && (
            <button
              type="button"
              className="button secondary small"
              onClick={() =>
                onChange({
                  ...flow,
                  nodes: flow.nodes.map((node) => ({ ...node, position: undefined })),
                })
              }
            >
              恢复自动布局
            </button>
          )}
          {multiple && <span className="field-note">可逐个选择节点，或在画布空白处拖动框选。</span>}
          {selected.length > 1 && <span>{selected.length} 个节点已选</span>}
        </div>
      )}
      <NodeMap
        flow={flow}
        selected={selected}
        onSelect={select}
        multiple={multiple}
        onBox={setSelected}
        onMove={
          moving && canEdit
            ? (id, position) =>
                onChange({
                  ...flow,
                  nodes: flow.nodes.map((item) => (item.id === id ? { ...item, position } : item)),
                })
            : undefined
        }
        onEdgeSelect={
          canEdit
            ? (index) => {
                setOpenConnector(true);
                setEdgeIndex(index);
              }
            : undefined
        }
      />
      {canEdit && extractIds.length > 0 && selected.length === extractIds.length && (
        <ExtractSelection
          key={extractIds.join(',')}
          flow={flow}
          path={path}
          nodeIds={extractIds}
          revision={revision}
          dirty={dirty}
          onExtracted={onExtracted}
        />
      )}
      {node && (
        <div className="graph-properties">
          <h3>节点属性 · {graphNodeLabels[node.type]}</h3>
          <Field label="节点名称">
            <input
              readOnly={!canEdit}
              maxLength={100}
              value={node.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          {node.type === 'LOG' && (
            <Field label="日志内容">
              <textarea
                readOnly={!canEdit}
                maxLength={2000}
                value={node.message ?? ''}
                onChange={(e) => patch({ message: e.target.value })}
              />
            </Field>
          )}
          {(node.type === 'BUILD' || node.type === 'DEPLOY_ARTIFACT') && (
            <PipelineReference project={project} node={node} canEdit={canEdit} onChange={patch} />
          )}
          {node.type === 'CONDITION' && (
            <div className="form-grid">
              <Field label="判断依据">
                <select
                  disabled={!canEdit}
                  value={node.condition?.key ?? 'input'}
                  onChange={(e) =>
                    patch({
                      condition: {
                        key: e.target.value as 'input' | 'commitSha',
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
                  onChange={(e) =>
                    patch({
                      condition: { key: node.condition?.key ?? 'input', value: e.target.value },
                    })
                  }
                />
              </Field>
            </div>
          )}
          {node.type === 'FLOW_CALL' && (
            <Field label="子执行流">
              <select
                disabled={!canEdit}
                value={node.flowId ?? ''}
                onChange={(e) => patch({ flowId: e.target.value || undefined })}
              >
                <option value="">选择执行流</option>
                {flows
                  .filter((child) => child.id !== flow.id)
                  .map((child) => (
                    <option key={child.id} value={child.id}>
                      {child.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {canEdit && node.type !== 'START' && node.type !== 'END' && (
            <div>
              <button
                type="button"
                className="button secondary small"
                onClick={() => removeNode(node.id)}
              >
                移除节点
              </button>
            </div>
          )}
        </div>
      )}
      {canEdit && (
        <>
          <div className="graph-flow-select">
            <Field label="新节点类型">
              <select
                value={adding}
                onChange={(e) => setAdding(e.target.value as GraphNode['type'])}
              >
                {Object.entries(graphNodeLabels)
                  .filter(([type]) => type !== 'START' && type !== 'END')
                  .map(([type, label]) => (
                    <option key={type} value={type}>
                      {label}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="插入到连线">
              <select
                value={edge ? flow.edges.indexOf(edge) : -1}
                onChange={(e) => setInsertEdge(Number(e.target.value))}
              >
                <option value={-1}>添加后手动连接</option>
                {flow.edges.map((item, i) => (
                  <option key={i} value={i}>
                    {nameOf(item.from)}
                    {item.when ? (item.when === 'TRUE' ? '（成立）' : '（不成立）') : ''} →{' '}
                    {nameOf(item.to)}
                  </option>
                ))}
              </select>
            </Field>
            <button
              type="button"
              className="button secondary"
              disabled={flow.nodes.length > limit}
              onClick={add}
            >
              <Plus size={16} />
              添加节点
            </button>
          </div>
          <div className="heading-actions">
            <button
              type="button"
              className="button secondary"
              aria-expanded={openConnector}
              onClick={() => {
                setEdgeIndex(undefined);
                setOpenConnector(!openConnector);
              }}
            >
              {openConnector ? '收起连线编辑' : '编辑连线'}
            </button>
          </div>
          {openConnector && (
            <EdgeEditor
              key={edgeIndex ?? 'new'}
              flow={flow}
              index={edgeIndex}
              choose={setEdgeIndex}
              commit={(edges) => {
                onChange({ ...flow, edges });
                setOpenConnector(false);
                setEdgeIndex(undefined);
                setInsertEdge(undefined);
              }}
            />
          )}
        </>
      )}
    </>
  );
}

function EdgeEditor({
  flow,
  index,
  choose,
  commit,
}: {
  flow: GraphFlow;
  index?: number;
  choose: (index?: number) => void;
  commit: (edges: GraphEdge[]) => void;
}) {
  const edge = index === undefined ? undefined : flow.edges[index];
  const [from, setFrom] = useState(edge?.from ?? '');
  const [to, setTo] = useState(edge?.to ?? '');
  const [when, setWhen] = useState<GraphEdge['when']>(edge?.when);
  const conditional = flow.nodes.find((node) => node.id === from)?.type === 'CONDITION';
  const eligible = Boolean(
    from &&
    to &&
    from !== to &&
    (!conditional || when) &&
    !flow.edges.some((current, i) => i !== index && current.from === from && current.to === to),
  );
  function save() {
    if (!eligible) return;
    const next = { from, to, ...(conditional ? { when } : {}) };
    commit(edge ? flow.edges.map((old, i) => (i === index ? next : old)) : [...flow.edges, next]);
  }
  return (
    <div className="graph-properties">
      <h3>{edge ? '调整连线' : '添加连线'}</h3>
      <div className="form-grid">
        <Field label="上游节点">
          <select
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setWhen(undefined);
            }}
          >
            <option value="">选择节点</option>
            {flow.nodes
              .filter((n) => n.type !== 'END')
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="下游节点">
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">选择节点</option>
            {flow.nodes
              .filter((n) => n.type !== 'START' && n.id !== from)
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
          </select>
        </Field>
        {conditional && (
          <Field label="选择条件结果">
            <select
              value={when ?? ''}
              onChange={(e) => setWhen((e.target.value || undefined) as GraphEdge['when'])}
            >
              <option value="">选择结果</option>
              <option value="TRUE">成立</option>
              <option value="FALSE">不成立</option>
            </select>
          </Field>
        )}
      </div>
      <div className="heading-actions">
        <button type="button" className="button primary small" disabled={!eligible} onClick={save}>
          {edge ? '更新连线' : '添加连线'}
        </button>
        {edge && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => commit(flow.edges.filter((_, i) => i !== index))}
          >
            移除连线
          </button>
        )}
        {edge && (
          <button type="button" className="button secondary small" onClick={() => choose()}>
            返回添加连线
          </button>
        )}
      </div>
      {flow.edges.length > 0 && (
        <ul className="graph-edge-list">
          {flow.edges.map((current, i) => (
            <li key={i}>
              <button
                type="button"
                className="button secondary small"
                aria-pressed={i === index}
                onClick={() => choose(i)}
              >
                {flow.nodes.find((n) => n.id === current.from)?.name}
                {current.when === 'TRUE'
                  ? '（成立）'
                  : current.when === 'FALSE'
                    ? '（不成立）'
                    : ''}{' '}
                → {flow.nodes.find((n) => n.id === current.to)?.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ExtractPreview {
  nodeCount: number;
  entryNodeIds: string[];
  exitNodeIds: string[];
  createdFlowId: string;
}

function ExtractSelection({
  flow,
  path,
  nodeIds,
  revision,
  dirty,
  onExtracted,
}: {
  flow: GraphFlow;
  path: string;
  nodeIds: string[];
  revision: number;
  dirty: boolean;
  onExtracted: (graph: GraphDocument, newFlowId: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const [name, setName] = useState('提取的执行流');
  const [mode, setMode] = useState<'COPY' | 'REPLACE'>('REPLACE');
  const [review, setReview] = useState<{ revision: number; result: ExtractPreview }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const displayNodes = (ids: string[]) =>
    ids.map((id) => flow.nodes.find((n) => n.id === id)?.name ?? id).join('、');
  const body = { expectedRevision: revision, flowId: flow.id, nodeIds, mode, name };
  const preview = review?.revision === revision ? review.result : undefined;
  async function submit() {
    if (dirty || busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (preview) {
        const graph = await post<GraphDocument>(path + '/extract', body);
        const existing = new Set(graph.draft.flows.map(({ id }) => id));
        onExtracted(
          graph,
          existing.has(preview.createdFlowId)
            ? preview.createdFlowId
            : (graph.draft.flows.at(-1)?.id ?? flow.id),
        );
      } else setReview({ revision, result: await post<ExtractPreview>(path + '/extract/preview', body) });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  if (!shown)
    return (
      <div>
        <button type="button" className="button secondary small" onClick={() => setShown(true)}>
          <Scissors size={15} />
          提取所选节点
        </button>
      </div>
    );
  return (
    <div className="graph-properties">
      <h3>将 {nodeIds.length} 个节点提取为执行流</h3>
      {dirty && <p className="field-note">请先保存画布草稿，再预览提取。</p>}
      <div className="form-grid">
        <Field label="新执行流名称">
          <input
            disabled={busy}
            maxLength={100}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setReview(undefined);
            }}
          />
        </Field>
        <Field label="提取方式">
          <select
            disabled={busy}
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as 'COPY' | 'REPLACE');
              setReview(undefined);
            }}
          >
            <option value="REPLACE">提取并替换为调用节点</option>
            <option value="COPY">复制为独立执行流</option>
          </select>
        </Field>
      </div>
      <ErrorBanner error={error} />
      {preview && (
        <p role="status">
          节点 {preview.nodeCount} 个 · 入口 {displayNodes(preview.entryNodeIds)} · 出口{' '}
          {displayNodes(preview.exitNodeIds)}
        </p>
      )}
      <div className="heading-actions">
        <button
          type="button"
          className="button primary small"
          disabled={dirty || busy || !name.trim()}
          onClick={() => void submit()}
        >
          {preview ? '确认提取' : '预览提取'}
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => {
            setShown(false);
            setReview(undefined);
            setError('');
          }}
        >
          取消提取
        </button>
      </div>
    </div>
  );
}
