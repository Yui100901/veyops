import { useEffect, useRef, useState } from 'react';
import { Play, Redo2, Save, Undo2, Upload } from 'lucide-react';
import { api, ApiError, formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field, Loading, PageHeader, Section } from '../components';
import type { ProjectDetail, User } from '../models';
import { NodeMap } from './ExecutionGraphCanvas';
import { ProjectGraphEditor } from './ExecutionGraphEditor';
import { ExecutionGraphHistory, ExecutionGraphStart } from './ExecutionGraphRun';
import { ExecutionGraphTriggers } from './ExecutionGraphTriggers';
import { GraphVersionTools } from './ExecutionGraphVersions';
import { graphNodeLabels } from './execution-graph-definition';
import type { GraphCanvas, GraphDocument, GraphFlow } from './execution-graph-definition';
import { deliveryPath } from './delivery-route';
import './execution-graph.css';
import './graph-start.css';

type Pane = 'draft' | 'published' | 'history';
type PublishedGraph = { version: number; definition: GraphDocument['draft'] };

const emptyCanvas: GraphCanvas = { nodes: [], edges: [], endpoints: [], templates: [] };

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
      isAdmin={user.role === 'ADMIN'}
      runId={runId}
    />
  );
}

function Workspace({
  project,
  initial,
  path,
  canEdit,
  isAdmin,
  runId,
}: {
  project: ProjectDetail;
  initial: GraphDocument;
  path: string;
  canEdit: boolean;
  isAdmin: boolean;
  runId?: string;
}) {
  const [graph, setGraph] = useState(initial);
  const [canvas, setCanvas] = useState(initial.draft.canvas ?? emptyCanvas);
  const [undo, setUndo] = useState<GraphCanvas[]>([]);
  const [redo, setRedo] = useState<GraphCanvas[]>([]);
  const [pane, setPane] = useState<Pane>(runId ? 'history' : 'draft');
  const [version, setVersion] = useState<number | null>(initial.publishedVersion);
  const [selectedRun, setSelectedRun] = useState(runId);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const dirty = canvas !== (graph.draft.canvas ?? emptyCanvas);
  const latest = useResource<PublishedGraph>(
    graph.publishedVersion ? path + '/versions/' + graph.publishedVersion : null,
  );

  useEffect(() => {
    if (runId) {
      setSelectedRun(runId);
      setPane('history');
    }
  }, [runId]);

  async function persist(action: 'save' | 'publish' | 'reload') {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let saved: GraphDocument;
      if (action === 'save')
        saved = await api(path + '/draft', {
          method: 'PUT',
          body: JSON.stringify({
            expectedRevision: graph.revision,
            definition: { flows: [], canvas },
          }),
        });
      else if (action === 'publish')
        saved = await post(path + '/publish', { expectedRevision: graph.revision });
      else saved = await api(path);
      setGraph(saved);
      setCanvas(saved.draft.canvas ?? emptyCanvas);
      if (action === 'reload') {
        setUndo([]);
        setRedo([]);
      }
      setConflict(false);
      if (action === 'publish') setVersion(saved.publishedVersion);
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
      saving.current = false;
      setBusy(false);
    }
  }

  function edit(next: GraphCanvas) {
    if (next === canvas || saving.current) return;
    setUndo((history) => [...history.slice(-49), canvas]);
    setRedo([]);
    setCanvas(next);
    setNotice('');
  }

  function stepDraft(direction: 'undo' | 'redo') {
    const history = direction === 'undo' ? undo : redo;
    const next = history.at(-1);
    if (!next || saving.current) return;
    setCanvas(next);
    setNotice('');
    if (direction === 'undo') {
      setUndo(undo.slice(0, -1));
      setRedo([...redo, canvas]);
    } else {
      setRedo(redo.slice(0, -1));
      setUndo([...undo, canvas]);
    }
  }

  function openRun(id: string) {
    setSelectedRun(id);
    setPane('history');
    setNotice('');
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
            : '连线后为开始节点选择可达的结束节点，即可定义执行流。'
        }
      />
      <nav className="resource-section-switcher" aria-label="执行图视图">
        {(
          [
            ['draft', '草稿画布'],
            ['published', '版本历史'],
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
                  <Undo2 size={16} /> 撤销
                </button>
                <button
                  type="button"
                  className="button secondary compact"
                  disabled={!redo.length || busy}
                  onClick={() => stepDraft('redo')}
                >
                  <Redo2 size={16} /> 重做
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={!dirty || busy || conflict}
                  onClick={() => void persist('save')}
                >
                  <Save size={16} /> 保存草稿
                </button>
                <button
                  type="button"
                  className="button primary"
                  disabled={dirty || busy || conflict}
                  onClick={() => void persist('publish')}
                >
                  <Upload size={16} /> 发布版本
                </button>
              </div>
            )
          }
        >
          <ProjectGraphEditor
            project={project}
            canvas={canvas}
            canEdit={canEdit && !busy}
            onChange={edit}
            renderStart={(startId) =>
              !project.archived && (
                <StartActions
                  key={startId + '-' + graph.publishedVersion}
                  startId={startId}
                  project={project}
                  path={path}
                  published={
                    latest.data?.version === graph.publishedVersion ? latest.data : undefined
                  }
                  publishedVersion={graph.publishedVersion}
                  loading={Boolean(graph.publishedVersion && latest.loading)}
                  error={latest.error}
                  canRun={canEdit && !busy}
                  canManage={canEdit && isAdmin && !busy}
                  onRun={openRun}
                />
              )
            }
          />
        </Section>
      )}
      {pane === 'published' && (
        <PublishedVersions
          key={graph.publishedVersion}
          projectId={project.id}
          path={path}
          canRestore={canEdit}
          revision={graph.revision}
          dirty={dirty || conflict}
          version={version ?? graph.publishedVersion}
          setVersion={setVersion}
          onRestored={(saved, restored) => {
            setUndo((history) => [...history.slice(-49), canvas]);
            setRedo([]);
            setGraph(saved);
            setCanvas(saved.draft.canvas ?? emptyCanvas);
            setPane('draft');
            setError('');
            setNotice('已将 v' + restored + ' 恢复到草稿');
          }}
          onConflict={() => setConflict(true)}
        />
      )}
      {pane === 'history' && (
        <ExecutionGraphHistory
          path={path}
          projectId={project.id}
          canCancel={canEdit}
          canApprove={canEdit && isAdmin}
          selected={selectedRun}
          onSelect={setSelectedRun}
        />
      )}
    </div>
  );
}

function StartActions({
  startId,
  project,
  path,
  published,
  publishedVersion,
  loading,
  error,
  canRun,
  canManage,
  onRun,
}: {
  startId: string;
  project: ProjectDetail;
  path: string;
  published?: PublishedGraph;
  publishedVersion: number | null;
  loading: boolean;
  error: string;
  canRun: boolean;
  canManage: boolean;
  onRun: (id: string) => void;
}) {
  const flow = published?.definition.flows.find(({ id }) => id === startId);
  const [open, setOpen] = useState<'manual' | 'rules'>();
  return (
    <div className="graph-properties graph-start-actions">
      <h4>开始方式</h4>
      <ErrorBanner error={error} />
      {loading ? (
        <Loading />
      ) : (
        <p className="field-note">
          {flow && published
            ? '手动运行使用已发布的 v' + published.version + '。'
            : '绑定可达的结束节点并发布后，即可从这里运行和添加触发器。'}
        </p>
      )}
      <div className="heading-actions">
        {canRun && flow && (
          <button
            type="button"
            className="button primary small"
            aria-expanded={open === 'manual'}
            onClick={() => setOpen(open === 'manual' ? undefined : 'manual')}
          >
            <Play size={15} /> 手动运行
          </button>
        )}
        {publishedVersion && (
          <button
            type="button"
            className="button secondary small"
            aria-expanded={open === 'rules'}
            onClick={() => setOpen(open === 'rules' ? undefined : 'rules')}
          >
            附加触发器
          </button>
        )}
      </div>
      {open === 'manual' && canRun && published && flow && (
        <ExecutionGraphStart
          project={project}
          path={path}
          flow={flow}
          flows={published.definition.flows}
          version={published.version}
          onRun={onRun}
        />
      )}
      {open === 'rules' && (
        <ExecutionGraphTriggers
          path={path}
          startId={startId}
          latestVersion={flow ? publishedVersion : null}
          canManage={canManage}
          canInvoke={canRun}
          onRun={onRun}
        />
      )}
    </div>
  );
}

function PublishedVersions({
  projectId,
  path,
  canRestore,
  revision,
  dirty,
  version,
  setVersion,
  onRestored,
  onConflict,
}: {
  projectId: string;
  path: string;
  canRestore: boolean;
  revision: number;
  dirty: boolean;
  version: number | null;
  setVersion: (v: number) => void;
  onRestored: (graph: GraphDocument, version: number) => void;
  onConflict: () => void;
}) {
  const list = useResource<{ version: number; createdAt: number }[]>(path + '/versions');
  const activeVersion = version ?? list.data?.[0]?.version;
  const item = useResource<PublishedGraph>(
    activeVersion ? path + '/versions/' + activeVersion : null,
  );
  const live = item.data?.version === activeVersion ? item.data : undefined;
  return (
    <Section title="发布版本">
      <div className="graph-fields">
        <ErrorBanner error={list.error || item.error} />
        {list.loading ? (
          <Loading />
        ) : !list.data?.length ? (
          <p>尚无发布版本。请先在草稿画布发布。</p>
        ) : (
          <>
            <Field label="执行图版本">
              <select
                value={activeVersion ?? ''}
                onChange={(event) => setVersion(Number(event.target.value))}
              >
                {list.data.map(({ version, createdAt }) => (
                  <option key={version} value={version}>
                    v{version} · {formatTime(createdAt)}
                  </option>
                ))}
              </select>
            </Field>
            {live && (
              <>
                <GraphVersionTools
                  key={live.version}
                  path={path}
                  live={live}
                  versions={list.data}
                  revision={revision}
                  canRestore={canRestore}
                  dirty={dirty}
                  onRestored={onRestored}
                  onConflict={onConflict}
                />
                <PublishedNodes
                  key={live.version}
                  definition={live.definition}
                  projectId={projectId}
                />
              </>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

function PublishedNodes({
  definition,
  projectId,
}: {
  definition: GraphDocument['draft'];
  projectId: string;
}) {
  const [selected, setSelected] = useState('');
  const [legacyId, setLegacyId] = useState('');
  const flow: GraphFlow | undefined = definition.canvas
    ? {
        id: 'canvas',
        name: '执行图',
        nodes: definition.canvas.nodes,
        edges: definition.canvas.edges,
      }
    : (definition.flows.find(({ id }) => id === legacyId) ?? definition.flows[0]);
  if (!flow) return null;
  const node = flow.nodes.find((item) => item.id === selected);
  return (
    <>
      {!definition.canvas && definition.flows.length > 1 && (
        <Field label="已发布执行流">
          <select value={flow.id} onChange={(e) => setLegacyId(e.target.value)}>
            {definition.flows.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <NodeMap flow={flow} selected={selected ? [selected] : []} onSelect={setSelected} />
      {node && (
        <div className="graph-properties">
          <strong>
            {node.name} · {graphNodeLabels[node.type]}
          </strong>
          {node.message && <p>{node.message}</p>}
          {node.checkout && (
            <p>
              {node.checkout.mode === 'COMMIT'
                ? '提交 · ' + node.checkout.commitSha
                : '分支 · ' + node.checkout.branch}
              {' · '}
              {node.checkout.fullClone ? '全量历史' : '浅拉取'}
            </p>
          )}
          {node.shell?.command && <pre>{node.shell.command}</pre>}
          {node.condition && (
            <p>
              {node.condition.key === 'input' ? '运行参数' : '提交 SHA'} 等于 {node.condition.value}
            </p>
          )}
          {node.switch && (
            <p>
              {node.switch.key === 'input' ? '运行参数' : '提交 SHA'} · 匹配项{' '}
              {node.switch.cases.join('、')}
            </p>
          )}
          {node.type === 'DELAY' && <p>等待 {node.delaySeconds} 秒</p>}
          {node.type === 'APPROVAL' && (
            <p>管理员审批 · {node.approval?.timeoutSeconds ?? 86400} 秒后超时</p>
          )}
          {node.flowId && (
            <p>
              子执行流 ·{' '}
              {definition.flows.find((item) => item.id === node.flowId)?.name ?? node.flowId}
            </p>
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
