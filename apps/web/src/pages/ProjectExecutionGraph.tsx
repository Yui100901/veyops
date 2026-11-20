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
import type {
  GraphCanvas,
  GraphDocument,
  GraphEdge,
  GraphFlow,
  GraphIssue,
} from './execution-graph-definition';
import './execution-graph.css';
import './graph-start.css';

type Pane = 'run' | 'draft' | 'published' | 'history';
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
  const [pane, setPane] = useState<Pane>(
    runId || new URLSearchParams(window.location.hash.split('?')[1]).get('pane') === 'history'
      ? 'history'
      : 'run',
  );
  const [version, setVersion] = useState<number | null>(initial.publishedVersion);
  const [selectedRun, setSelectedRun] = useState(runId);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issues, setIssues] = useState<GraphIssue[]>([]);
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

  async function persist(action: 'save' | 'publish' | 'reload' | 'validate') {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (action === 'publish' || action === 'validate') {
        const result = await post<{ issues: GraphIssue[] }>(path + '/validate', {
          definition: { flows: [], canvas },
        });
        setIssues(result.issues);
        if (result.issues.length) return;
        if (action === 'validate') {
          setNotice('发布检查通过');
          return;
        }
      }
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
      setIssues([]);
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
    setIssues([]);
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
            : '在发布的执行图上选择开始节点运行执行流。'
        }
      />
      <nav className="resource-section-switcher" aria-label="执行图视图">
        {(
          [
            ['run', '运行执行流'],
            ['draft', canEdit ? '编辑草稿' : '查看草稿'],
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
      {pane === 'run' && (
        <Section
          title="已发布执行图"
          subtitle={graph.publishedVersion ? '版本 v' + graph.publishedVersion : undefined}
        >
          <div className="graph-fields">
            <ErrorBanner error={latest.error} retry={() => void latest.reload()} />
            {graph.publishedVersion && latest.loading ? (
              <Loading />
            ) : latest.data && latest.data.version === graph.publishedVersion ? (
              <PublishedRun
                key={latest.data.version}
                published={latest.data}
                project={project}
                path={path}
                canRun={canEdit}
                startId={
                  new URLSearchParams(window.location.hash.split('?')[1]).get('start') ?? undefined
                }
                onRun={openRun}
              />
            ) : (
              !graph.publishedVersion && (
                <>
                  <p>发布执行图后，开始节点会在这里提供运行入口。</p>
                  {canEdit && (
                    <div>
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => setPane('draft')}
                      >
                        编辑执行图
                      </button>
                    </div>
                  )}
                </>
              )
            )}
          </div>
        </Section>
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
                  className="button secondary"
                  disabled={busy || conflict}
                  onClick={() => void persist('validate')}
                >
                  检查发布条件
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
            issues={issues}
            renderStart={(startId) =>
              !project.archived && (
                <StartTriggers
                  key={startId + '-' + graph.publishedVersion}
                  startId={startId}
                  path={path}
                  project={project}
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

function PublishedRun({
  published,
  project,
  path,
  canRun,
  startId,
  onRun,
}: {
  published: PublishedGraph;
  project: ProjectDetail;
  path: string;
  canRun: boolean;
  startId?: string;
  onRun: (id: string) => void;
}) {
  const [flow, setFlow] = useState<GraphFlow | undefined>(() =>
    published.definition.flows.find(({ id }) => id === startId),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  function chooseFlow(next: GraphFlow | undefined) {
    setFlow(next);
    if (next) window.requestAnimationFrame(() => heading.current?.focus());
  }
  return (
    <>
      {canRun && <p>点击带有「手动运行」标识的开始节点，填写运行参数。</p>}
      <PublishedNodes
        definition={published.definition}
        initialNodeId={startId}
        onChooseFlow={canRun ? chooseFlow : undefined}
      />
      {canRun && flow && (
        <div className="graph-properties graph-manual-start" key={flow.id}>
          <div className="heading-actions">
            <h3 ref={heading} tabIndex={-1}>
              <Play size={17} aria-hidden="true" /> 运行 {flow.name}
            </h3>
          </div>
          <ExecutionGraphStart
            project={project}
            path={path}
            flow={flow}
            version={published.version}
            onRun={onRun}
          />
        </div>
      )}
    </>
  );
}

function StartTriggers({
  startId,
  path,
  project,
  published,
  publishedVersion,
  loading,
  error,
  canRun,
  canManage,
  onRun,
}: {
  startId: string;
  path: string;
  project: ProjectDetail;
  published?: PublishedGraph;
  publishedVersion: number | null;
  loading: boolean;
  error: string;
  canRun: boolean;
  canManage: boolean;
  onRun: (id: string) => void;
}) {
  const flow = published?.definition.flows.find(({ id }) => id === startId);
  const [open, setOpen] = useState(false);
  return (
    <div className="graph-properties graph-start-actions">
      <h4>触发器</h4>
      <ErrorBanner error={error} />
      {loading ? (
        <Loading />
      ) : (
        <p className="field-note">
          {flow && published
            ? '触发器运行已发布的 v' + published.version + '。'
            : '绑定可达的结束节点并发布后，即可添加触发器。'}
        </p>
      )}
      <div className="heading-actions">
        {publishedVersion && (
          <button
            type="button"
            className="button secondary small"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            附加触发器
          </button>
        )}
      </div>
      {open && (
        <ExecutionGraphTriggers
          path={path}
          project={project}
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
  path,
  canRestore,
  revision,
  dirty,
  version,
  setVersion,
  onRestored,
  onConflict,
}: {
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
                <PublishedNodes key={live.version} definition={live.definition} />
              </>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

function edgeKey({ from, to, when }: GraphEdge) {
  return JSON.stringify([from, to, when]);
}

function PublishedNodes({
  definition,
  onChooseFlow,
  initialNodeId,
}: {
  definition: GraphDocument['draft'];
  onChooseFlow?: (flow: GraphFlow | undefined) => void;
  initialNodeId?: string;
}) {
  const [selected, setSelected] = useState(initialNodeId ?? '');
  const [hovered, setHovered] = useState<string>();
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
  const flowsByStart = new Map(
    definition.flows.map((item) => [item.nodes.find(({ type }) => type === 'START')?.id, item]),
  );
  const selectedFlow = onChooseFlow && flowsByStart.get(selected);
  const highlight = flowsByStart.get(hovered ?? selected);
  const highlightedEdges = new Set(highlight?.edges.map(edgeKey));
  return (
    <>
      {!definition.canvas && definition.flows.length > 1 && (
        <Field label="已发布执行流">
          <select
            value={flow.id}
            onChange={(e) => {
              setLegacyId(e.target.value);
              setSelected('');
              onChooseFlow?.(undefined);
            }}
          >
            {definition.flows.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <NodeMap
        flow={flow}
        selected={selected ? [selected] : []}
        highlighted={new Set(highlight?.nodes.map(({ id }) => id))}
        highlightEdges={
          new Set(flow.edges.flatMap((edge, i) => (highlightedEdges.has(edgeKey(edge)) ? [i] : [])))
        }
        onHighlight={setHovered}
        isRunnableStart={onChooseFlow ? (id) => flowsByStart.has(id) : undefined}
        onSelect={(id) => {
          setSelected(id);
          onChooseFlow?.(flowsByStart.get(id));
        }}
      />
      {node && !selectedFlow && (
        <div className="graph-properties">
          <strong>
            {node.name} · {graphNodeLabels[node.type]}
          </strong>
          {node.message && <p>{node.message}</p>}
          {node.checkout && (
            <p>
              {node.checkout.mode === 'COMMIT'
                ? '提交 · ' + node.checkout.commitSha
                : node.checkout.mode === 'TAG'
                  ? '标签 · ' + node.checkout.tag
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
          {node.inputs?.length ? (
            <p>声明输入 · {node.inputs.map(({ name }) => name).join('、')}</p>
          ) : null}
          {node.outputs?.length ? (
            <p>声明输出 · {node.outputs.map(({ name }) => name).join('、')}</p>
          ) : null}
        </div>
      )}
    </>
  );
}
