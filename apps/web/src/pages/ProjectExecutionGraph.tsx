import { useEffect, useState } from 'react';
import { Plus, Redo2, Save, Undo2, Upload } from 'lucide-react';
import { api, ApiError, formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field, Loading, PageHeader, Section } from '../components';
import type { ProjectDetail, User } from '../models';
import { NodeMap } from './ExecutionGraphCanvas';
import { FlowEditor } from './ExecutionGraphEditor';
import { ExecutionGraphHistory, ExecutionGraphStart } from './ExecutionGraphRun';
import { graphKey, graphNodeLabels, sequence } from './execution-graph-definition';
import type { GraphDocument, GraphFlow } from './execution-graph-definition';
import { deliveryPath } from './delivery-route';
import './execution-graph.css';

type Pane = 'draft' | 'published' | 'history';

export default function ProjectExecutionGraph({
  id,
  user,
  runId,
}: {
  id: string;
  user: User;
  runId?: string;
}) {
  const base = `/projects/${encodeURIComponent(id)}`;
  const project = useResource<ProjectDetail>(base + '/delivery-context');
  const graph = useResource<GraphDocument>(base + '/execution-graph');
  if (project.loading || graph.loading) return <Loading />;
  if (!project.data || !graph.data)
    return (
      <ErrorBanner
        error={project.error || graph.error || '项目执行图不可用'}
        retry={() => {
          void project.reload();
          void graph.reload();
        }}
      />
    );
  return (
    <Workspace
      key={id}
      project={project.data}
      initial={graph.data}
      path={base + '/execution-graph'}
      canEdit={user.role !== 'VIEWER' && !project.data.archived}
      runId={runId}
    />
  );
}

function Workspace({
  project,
  initial,
  path,
  canEdit,
  runId,
}: {
  project: ProjectDetail;
  initial: GraphDocument;
  path: string;
  canEdit: boolean;
  runId?: string;
}) {
  const [graph, setGraph] = useState(initial);
  const [draft, setDraft] = useState(initial.draft);
  const [undo, setUndo] = useState<GraphDocument['draft'][]>([]);
  const [redo, setRedo] = useState<GraphDocument['draft'][]>([]);
  const [flowId, setFlowId] = useState(draft.flows[0]?.id);
  const [pane, setPane] = useState<Pane>(runId ? 'history' : 'draft');
  const [version, setVersion] = useState<number | null>(initial.publishedVersion);
  const [selectedRun, setSelectedRun] = useState(runId);
  useEffect(() => {
    if (runId) {
      setSelectedRun(runId);
      setPane('history');
    }
  }, [runId]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = draft !== graph.draft;
  const flow = draft.flows.find((item) => item.id === flowId) ?? draft.flows[0];
  async function persist(action: 'save' | 'publish' | 'reload') {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let saved: GraphDocument;
      if (action === 'save')
        saved = await api(path + '/draft', {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision: graph.revision, definition: draft }),
        });
      else if (action === 'publish')
        saved = await post(path + '/publish', { expectedRevision: graph.revision });
      else saved = await api(path);
      setGraph(saved);
      setDraft(saved.draft);
      if (action === 'reload') {
        setUndo([]);
        setRedo([]);
      }
      setConflict(false);
      if (action === 'publish') {
        setVersion(saved.publishedVersion);
        setPane('published');
      }
      setNotice(
        action === 'publish'
          ? '已发布 v' + saved.publishedVersion
          : action === 'save'
            ? '草稿已保存'
            : '已载入服务器草稿',
      );
    } catch (err) {
      setError(message(err));
      setConflict(err instanceof ApiError && err.status === 409);
    } finally {
      setBusy(false);
    }
  }
  function updateDraft(next: GraphDocument['draft']) {
    setUndo((previous) => [...previous.slice(-49), draft]);
    setRedo([]);
    setDraft(next);
    setNotice('');
  }
  function stepDraft(direction: 'undo' | 'redo') {
    const history = direction === 'undo' ? undo : redo;
    const next = history.at(-1);
    if (!next) return;
    setDraft(next);
    setNotice('');
    if (direction === 'undo') {
      setUndo(undo.slice(0, -1));
      setRedo([...redo, draft]);
    } else {
      setRedo(redo.slice(0, -1));
      setUndo([...undo, draft]);
    }
  }
  function change(flow: GraphFlow) {
    updateDraft({ flows: draft.flows.map((item) => (item.id === flow.id ? flow : item)) });
  }
  function addFlow() {
    const id = graphKey('flow');
    const flow = {
      id,
      name: '新执行流',
      ...sequence(
        (['START', 'END'] as const).map((type) => ({
          id: graphKey('node'),
          type,
          name: graphNodeLabels[type],
        })),
      ),
    };
    updateDraft({ flows: [...draft.flows, flow] });
    setFlowId(id);
  }
  return (
    <div className="project-workspace execution-graph">
      <a className="back-link" href={project.archived ? '#/projects' : '#/projects/' + project.id}>
        ← {project.archived ? '项目列表' : project.name}
      </a>
      <PageHeader
        eyebrow={project.name}
        title="项目执行图"
        description={
          project.archived
            ? '本项目已归档，可查阅发布版本与运行记录。'
            : '发布执行流后，可以按固定版本运行并查看每个节点的结果。'
        }
      />
      <nav className="resource-section-switcher" aria-label="执行图视图">
        {(
          [
            ['draft', '草稿画布'],
            ['published', '发布版本与运行'],
            ['history', '运行记录'],
          ] as const
        ).map(([key, label]) => (
          <button type="button" key={key} aria-pressed={pane === key} onClick={() => setPane(key)}>
            {label}
          </button>
        ))}
      </nav>
      <ErrorBanner error={error} />
      {conflict && (
        <button className="button secondary" disabled={busy} onClick={() => void persist('reload')}>
          放弃本地更改，载入服务器草稿
        </button>
      )}
      {notice && (
        <p className="graph-notice" role="status">
          {notice}
        </p>
      )}
      {pane === 'draft' && (
        <Section
          title="草稿画布"
          subtitle={`修订 ${graph.revision} · ${dirty ? '有未保存的更改' : '已保存'} · ${graph.publishedVersion ? '最新发布 v' + graph.publishedVersion : '尚未发布'}`}
          action={
            canEdit && (
              <div className="heading-actions">
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={!undo.length || busy}
                  onClick={() => stepDraft('undo')}
                >
                  <Undo2 size={16} />
                  撤销
                </button>
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={!redo.length || busy}
                  onClick={() => stepDraft('redo')}
                >
                  <Redo2 size={16} />
                  重做
                </button>
                <button
                  className="button secondary"
                  disabled={!dirty || busy || conflict}
                  onClick={() => void persist('save')}
                >
                  <Save size={16} />
                  保存草稿
                </button>
                <button
                  className="button primary"
                  disabled={dirty || busy || conflict}
                  onClick={() => void persist('publish')}
                >
                  <Upload size={16} />
                  发布版本
                </button>
              </div>
            )
          }
        >
          <fieldset className="graph-fields" disabled={busy}>
            <div className="graph-flow-select">
              <Field label="选择执行流">
                <select value={flow?.id ?? ''} onChange={(e) => setFlowId(e.target.value)}>
                  {draft.flows.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name || '未命名执行流'}
                    </option>
                  ))}
                </select>
              </Field>
              {canEdit && (
                <button
                  className="button secondary"
                  disabled={draft.flows.length >= 50}
                  onClick={addFlow}
                >
                  <Plus size={16} />
                  新建执行流
                </button>
              )}
            </div>
            {flow && (
              <FlowEditor
                key={flow.id}
                project={project}
                flow={flow}
                flows={draft.flows}
                canEdit={canEdit}
                path={path}
                revision={graph.revision}
                dirty={dirty}
                onChange={change}
                onExtracted={(saved, newFlowId) => {
                  setUndo((history) => [...history.slice(-49), draft]);
                  setRedo([]);
                  setGraph(saved);
                  setDraft(saved.draft);
                  setFlowId(newFlowId);
                  setNotice('已提取执行流并保存草稿');
                }}
                onRemoveFlow={
                  draft.flows.length > 1 &&
                  !draft.flows.some((other) => other.nodes.some((node) => node.flowId === flow.id))
                    ? () => {
                        updateDraft({ flows: draft.flows.filter((item) => item.id !== flow.id) });
                      }
                    : undefined
                }
              />
            )}
          </fieldset>
        </Section>
      )}
      {pane === 'published' && (
        <PublishedVersions
          key={graph.publishedVersion}
          project={project}
          path={path}
          canRun={canEdit}
          version={version ?? graph.publishedVersion}
          setVersion={setVersion}
          onRun={(id) => {
            setSelectedRun(id);
            setPane('history');
            setNotice('');
          }}
        />
      )}
      {pane === 'history' && (
        <ExecutionGraphHistory
          path={path}
          projectId={project.id}
          canCancel={canEdit}
          selected={selectedRun}
          onSelect={setSelectedRun}
        />
      )}
    </div>
  );
}

function PublishedVersions({
  project,
  path,
  canRun,
  version,
  setVersion,
  onRun,
}: {
  project: ProjectDetail;
  path: string;
  canRun: boolean;
  version: number | null;
  setVersion: (v: number) => void;
  onRun: (id: string) => void;
}) {
  const list = useResource<{ version: number; createdAt: number }[]>(path + '/versions');
  const activeVersion = version ?? list.data?.[0]?.version;
  const item = useResource<{ version: number; definition: GraphDocument['draft'] }>(
    activeVersion ? path + '/versions/' + activeVersion : null,
  );
  const [flowId, setFlowId] = useState('');
  const flow =
    item.data?.definition.flows.find((f) => f.id === flowId) ?? item.data?.definition.flows[0];
  return (
    <Section title="发布版本与运行">
      <div className="graph-fields">
        <ErrorBanner error={list.error || item.error} />
        {list.loading ? (
          <Loading />
        ) : !list.data?.length ? (
          <p>尚无发布版本。请先在草稿画布发布。</p>
        ) : (
          <>
            <div className="form-grid">
              <Field label="执行图版本">
                <select
                  value={activeVersion ?? ''}
                  onChange={(e) => setVersion(Number(e.target.value))}
                >
                  {list.data.map((v) => (
                    <option key={v.version} value={v.version}>
                      v{v.version} · {formatTime(v.createdAt)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="已发布执行流">
                <select value={flow?.id ?? ''} onChange={(e) => setFlowId(e.target.value)}>
                  {item.data?.definition.flows.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {flow && activeVersion && item.data?.version === activeVersion && (
              <>
                <PublishedNodes
                  key={activeVersion + '-' + flow.id}
                  flow={flow}
                  flows={item.data.definition.flows}
                  projectId={project.id}
                />
                {canRun && (
                  <ExecutionGraphStart
                    key={activeVersion + '-' + flow.id}
                    project={project}
                    path={path}
                    flow={flow}
                    flows={item.data.definition.flows}
                    version={activeVersion}
                    onRun={onRun}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

function PublishedNodes({
  flow,
  flows,
  projectId,
}: {
  flow: GraphFlow;
  flows: GraphFlow[];
  projectId: string;
}) {
  const [selected, setSelected] = useState('');
  const node = flow.nodes.find((n) => n.id === selected);
  return (
    <>
      <NodeMap flow={flow} selected={selected ? [selected] : []} onSelect={setSelected} />
      {node && (
        <div className="graph-properties">
          <strong>
            {node.name} · {graphNodeLabels[node.type]}
          </strong>
          {node.message && <p>{node.message}</p>}
          {node.condition && (
            <p>
              {node.condition.key === 'input' ? '运行参数' : '提交 SHA'} 等于 {node.condition.value}
            </p>
          )}
          {node.flowId && (
            <p>子执行流 · {flows.find((item) => item.id === node.flowId)?.name ?? node.flowId}</p>
          )}
          {node.pipelineId && (
            <a
              className="text-link"
              href={'#' + deliveryPath(projectId, 'pipelines', { recordId: node.pipelineId })}
            >
              查看服务流水线 · 固定 v{node.pipelineVersion}
            </a>
          )}
        </div>
      )}
    </>
  );
}
