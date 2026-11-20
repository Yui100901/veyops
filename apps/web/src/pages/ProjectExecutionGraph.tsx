import { useEffect, useRef, useState } from 'react';
import { Play, Redo2, Save, Undo2, Upload } from 'lucide-react';
import { api, ApiError, formatTime, message, navigate, post, useResource } from '../api';
import { Confirm, ErrorBanner, Field, Loading, PageHeader, Section } from '../components';
import type { ProjectDetail, User } from '../models';
import { NodeMap } from './ExecutionGraphCanvas';
import { ProjectGraphEditor } from './ExecutionGraphEditor';
import { ExecutionGraphResourceLinks } from './ExecutionGraphResourceLinks';
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
  GraphNode,
} from './execution-graph-definition';
import {
  flowMatchesScope,
  graphFlowScope,
  graphResourcePanel,
  graphReturnDelivery,
  graphScopeBackHref,
  graphStartHref,
  graphWorkbenchPath,
  type GraphPane,
  type GraphWorkbenchScope,
} from './graph-workbench-context';
import './execution-graph.css';
import './graph-start.css';

type PublishedGraph = { version: number; definition: GraphDocument['draft'] };

const emptyCanvas: GraphCanvas = { nodes: [], edges: [], endpoints: [], templates: [] };

export default function ProjectExecutionGraph({
  id,
  user,
  runId,
  search,
  embedded,
  project: providedProject,
}: {
  id: string;
  user: User;
  runId?: string;
  search?: string;
  embedded?: boolean;
  project?: ProjectDetail;
}) {
  const base = `/projects/${encodeURIComponent(id)}`;
  const projectResource = useResource<ProjectDetail>(
    providedProject ? null : base + '/delivery-context',
  );
  const project = providedProject ?? projectResource.data;
  const graph = useResource<GraphDocument>(base + '/execution-graph');
  if ((!providedProject && projectResource.loading) || graph.loading) return <Loading />;
  if (!project || !graph.data)
    return (
      <ErrorBanner
        error={projectResource.error || graph.error || '项目执行图不可用'}
        retry={() => {
          if (!providedProject) void projectResource.reload();
          void graph.reload();
        }}
      />
    );
  return (
    <Workspace
      key={id}
      project={project}
      initial={graph.data}
      path={base + '/execution-graph'}
      canEdit={user.role !== 'VIEWER' && !project.archived}
      isAdmin={user.role === 'ADMIN'}
      runId={runId}
      search={search}
      embedded={embedded}
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
  search,
  embedded,
}: {
  project: ProjectDetail;
  initial: GraphDocument;
  path: string;
  canEdit: boolean;
  isAdmin: boolean;
  runId?: string;
  search?: string;
  embedded?: boolean;
}) {
  const params = new URLSearchParams(search);
  const paneParam = params.get('pane');
  const selectedRun = runId ?? params.get('run') ?? undefined;
  const pane: GraphPane = selectedRun
    ? 'history'
    : paneParam === 'draft' || paneParam === 'published' || paneParam === 'history'
      ? paneParam
      : 'run';
  const rawVersion = Number(params.get('version'));
  const linkedVersion = Number.isSafeInteger(rawVersion) && rawVersion > 0 ? rawVersion : undefined;
  const linkedNode = params.get('node') ?? undefined;
  const linkedFlow = params.get('flow') ?? undefined;
  const linkedStart = params.get('start') ?? undefined;
  const scope: GraphWorkbenchScope = {
    serviceId: params.get('serviceId') || undefined,
    environmentId: params.get('environmentId') || undefined,
    view: params.get('view') || undefined,
    resourcePanel: graphResourcePanel(params.get('resourcePanel')),
  };
  const delivery = graphReturnDelivery(params);
  const service = project.services.find(({ id }) => id === scope.serviceId);
  const environment = project.environments.find(({ id }) => id === scope.environmentId);
  const scoped = Boolean(scope.serviceId || scope.environmentId);
  const invalidScope = Boolean(
    (scope.serviceId && !service) || (scope.environmentId && !environment),
  );
  const [graph, setGraph] = useState(initial);
  const [canvas, setCanvas] = useState(initial.draft.canvas ?? emptyCanvas);
  const [undo, setUndo] = useState<GraphCanvas[]>([]);
  const [redo, setRedo] = useState<GraphCanvas[]>([]);
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

  function panePath(next: GraphPane) {
    return graphWorkbenchPath(project.id, {
      ...scope,
      ...(next === 'history' && delivery),
      pane: next === 'run' ? undefined : next,
      ...(pane === next && {
        start: linkedStart,
        run: selectedRun,
        version: linkedVersion,
        node: linkedNode,
        flow: linkedFlow,
      }),
    });
  }

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
    navigate(graphWorkbenchPath(project.id, { ...scope, ...delivery, run: id }));
    setNotice('');
  }

  return (
    <div className="project-workspace execution-graph">
      {!embedded && (
        <>
          <a
            className="back-link"
            href={project.archived ? '#/projects' : '#/projects/' + project.id}
          >
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
        </>
      )}
      {scoped && (
        <div className="heading-actions graph-scope-links">
          <a className="button secondary small" href={graphScopeBackHref(project.id, scope)}>
            ← {service ? (environment ? '返回服务环境' : '返回服务详情') : '返回环境详情'}
          </a>
          <span className="field-note">
            {[service?.name, environment?.name].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
      <nav className="record-tabs" aria-label="执行图视图">
        {(
          [
            ['run', '运行执行流'],
            ['draft', canEdit ? '编辑草稿' : '查看草稿'],
            ['published', '版本历史'],
            ['history', '运行记录'],
          ] as const
        ).map(([key, label]) => (
          <a
            className={pane === key ? 'active' : undefined}
            key={key}
            aria-current={pane === key ? 'page' : undefined}
            href={'#' + panePath(key)}
          >
            {label}
          </a>
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
            {invalidScope ? (
              <ErrorBanner error="所选服务或环境不在当前项目的可用资源中。" />
            ) : graph.publishedVersion && latest.loading ? (
              <Loading />
            ) : latest.data && latest.data.version === graph.publishedVersion ? (
              <PublishedRun
                key={`${latest.data.version}:${linkedStart ?? ''}:${linkedNode ?? ''}:${linkedFlow ?? ''}:${scope.serviceId ?? ''}:${scope.environmentId ?? ''}`}
                published={latest.data}
                project={project}
                path={path}
                canRun={canEdit}
                startId={linkedStart}
                inspectNodeId={linkedNode}
                inspectFlowId={linkedFlow}
                scope={scope}
                onRun={openRun}
              />
            ) : (
              !graph.publishedVersion && (
                <>
                  <p>发布执行图后，开始节点会在这里提供运行入口。</p>
                  {canEdit && (
                    <div>
                      <a className="button primary" href={'#' + panePath('draft')}>
                        编辑执行图
                      </a>
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
            key={`${linkedNode ?? ''}:${linkedFlow ?? ''}`}
            project={project}
            canvas={canvas}
            canEdit={canEdit && !busy}
            onChange={edit}
            issues={issues}
            initialNodeId={linkedNode}
            initialFlowId={linkedFlow}
            renderResources={(node, pair) => (
              <ExecutionGraphResourceLinks
                node={node}
                start={canvas.nodes.find(({ id }) => id === pair?.startId)}
                flow={pair}
                flowId={pair?.startId}
                pane="draft"
                project={project}
                scope={scope}
              />
            )}
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
          latestVersion={graph.publishedVersion}
          linkedNode={linkedNode}
          linkedFlow={linkedFlow}
          project={project}
          scope={scope}
          revision={graph.revision}
          dirty={dirty || conflict}
          version={linkedVersion ?? graph.publishedVersion}
          setVersion={(version) =>
            navigate(graphWorkbenchPath(project.id, { ...scope, pane: 'published', version }))
          }
          onRestored={(saved, restored) => {
            setUndo((history) => [...history.slice(-49), canvas]);
            setRedo([]);
            setGraph(saved);
            setCanvas(saved.draft.canvas ?? emptyCanvas);
            navigate(panePath('draft'));
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
          onSelect={openRun}
          scope={scope}
          delivery={delivery}
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
  inspectNodeId,
  inspectFlowId,
  scope,
  onRun,
}: {
  published: PublishedGraph;
  project: ProjectDetail;
  path: string;
  canRun: boolean;
  startId?: string;
  inspectNodeId?: string;
  inspectFlowId?: string;
  scope: GraphWorkbenchScope;
  onRun: (id: string) => void;
}) {
  const scoped = Boolean(scope.serviceId || scope.environmentId);
  const available = published.definition.flows.filter((flow) => flowMatchesScope(flow, scope));
  const flow = available.find(
    (item) =>
      item.id === startId ||
      item.nodes.some((node) => node.type === 'START' && node.id === startId),
  );
  const initialInputs = flow ? graphFlowScope(flow, scope) : undefined;
  const start = flow?.nodes.find(({ type }) => type === 'START');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (canRun && flow) heading.current?.focus();
  }, [canRun, flow]);
  return (
    <>
      {scoped && (
        <div className="graph-fields graph-scoped-starts">
          <h3>关联的开始节点</h3>
          {available.length ? (
            <div className="heading-actions">
              {available.map((item) => (
                <a
                  className={`button ${flow?.id === item.id ? 'primary' : 'secondary'} small`}
                  key={item.id}
                  href={graphStartHref(project.id, item.id, scope)}
                  aria-current={flow?.id === item.id ? 'true' : undefined}
                >
                  {item.name}
                </a>
              ))}
            </div>
          ) : (
            <p className="field-note">这个服务环境暂无可用的已发布开始节点。</p>
          )}
        </div>
      )}
      {startId && !flow && <ErrorBanner error="当前发布版本中没有适用于此范围的开始节点。" />}
      {canRun && !scoped && <p>点击带有「手动运行」标识的开始节点，填写运行参数。</p>}
      {canRun && flow && (
        <div className="graph-properties graph-manual-start" key={flow.id}>
          <div className="heading-actions">
            <h3 ref={heading} tabIndex={-1}>
              <Play size={17} aria-hidden="true" /> 运行 {flow.name}
            </h3>
          </div>
          {start && (
            <ExecutionGraphResourceLinks
              node={start}
              start={start}
              flow={flow}
              flowId={flow.id}
              pane="run"
              project={project}
              scope={scope}
            />
          )}
          <ExecutionGraphStart
            project={project}
            path={path}
            flow={flow}
            version={published.version}
            initialInputs={initialInputs}
            onRun={onRun}
          />
        </div>
      )}
      <PublishedNodes
        definition={published.definition}
        initialNodeId={inspectNodeId ?? start?.id}
        initialFlowId={inspectFlowId ?? flow?.id}
        runFlowId={flow?.id}
        runnableFlowIds={new Set(available.map(({ id }) => id))}
        onChooseFlow={
          canRun
            ? (item) =>
                item && navigate(graphWorkbenchPath(project.id, { ...scope, start: item.id }))
            : undefined
        }
        renderResources={(node, inspectedFlow) => (
          <ExecutionGraphResourceLinks
            node={node}
            start={inspectedFlow?.nodes.find(({ type }) => type === 'START')}
            flow={inspectedFlow}
            flowId={inspectedFlow?.id}
            pane="run"
            project={project}
            scope={scope}
          />
        )}
      />
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
  latestVersion,
  linkedNode,
  linkedFlow,
  project,
  scope,
  revision,
  dirty,
  version,
  setVersion,
  onRestored,
  onConflict,
}: {
  path: string;
  canRestore: boolean;
  latestVersion: number | null;
  linkedNode?: string;
  linkedFlow?: string;
  project: ProjectDetail;
  scope: GraphWorkbenchScope;
  revision: number;
  dirty: boolean;
  version: number | null;
  setVersion: (v: number) => void;
  onRestored: (graph: GraphDocument, version: number) => void;
  onConflict: () => void;
}) {
  const list = useResource<{ version: number; createdAt: number; retiredAt?: number | null }[]>(
    path + '/versions',
  );
  const [retiring, setRetiring] = useState<number>();
  const [retireError, setRetireError] = useState('');
  const [retireBusy, setRetireBusy] = useState(false);
  const activeVersion = version ?? list.data?.[0]?.version;
  const item = useResource<PublishedGraph>(
    activeVersion ? path + '/versions/' + activeVersion : null,
  );
  const live = item.data?.version === activeVersion ? item.data : undefined;
  const retiredAt = list.data?.find((entry) => entry.version === activeVersion)?.retiredAt;

  async function retireVersion() {
    if (retiring === undefined || retireBusy) return;
    setRetireBusy(true);
    setRetireError('');
    try {
      await post(`${path}/versions/${retiring}/retire`);
      await list.reload();
      setRetiring(undefined);
    } catch (error) {
      setRetireError(message(error));
    } finally {
      setRetireBusy(false);
    }
  }
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
                {list.data.map(({ version, createdAt, retiredAt }) => (
                  <option key={version} value={version}>
                    v{version} · {formatTime(createdAt)}
                    {retiredAt ? ' · 已停用' : ''}
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
                {retiredAt ? (
                  <p className="field-note">运行入口已于 {formatTime(retiredAt)} 停用。</p>
                ) : (
                  canRestore &&
                  live.version !== latestVersion && (
                    <div>
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => {
                          setRetireError('');
                          setRetiring(live.version);
                        }}
                      >
                        停用此版本
                      </button>
                    </div>
                  )
                )}
                <PublishedNodes
                  key={`${live.version}:${linkedNode ?? ''}:${linkedFlow ?? ''}`}
                  definition={live.definition}
                  initialNodeId={linkedNode}
                  initialFlowId={linkedFlow}
                  renderResources={(node, flow) => (
                    <ExecutionGraphResourceLinks
                      node={node}
                      start={flow?.nodes.find(({ type }) => type === 'START')}
                      flow={flow}
                      flowId={flow?.id}
                      version={live.version}
                      pane="published"
                      project={project}
                      scope={scope}
                    />
                  )}
                />
              </>
            )}
          </>
        )}
        {retiring !== undefined && (
          <Confirm
            title={`停用 v${retiring}`}
            description="停止从此版本发起新运行。请先关闭绑定此版本的已启用触发器。"
            label="停用版本"
            onClose={() => !retireBusy && setRetiring(undefined)}
            onConfirm={retireVersion}
            busy={retireBusy}
            error={retireError}
          />
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
  initialFlowId,
  runnableFlowIds,
  runFlowId,
  renderResources,
}: {
  definition: GraphDocument['draft'];
  onChooseFlow?: (flow: GraphFlow | undefined) => void;
  initialNodeId?: string;
  initialFlowId?: string;
  runnableFlowIds?: ReadonlySet<string>;
  runFlowId?: string;
  renderResources?: (node: GraphNode, flow?: GraphFlow) => React.ReactNode;
}) {
  const [selected, setSelected] = useState(initialNodeId ?? '');
  const [hovered, setHovered] = useState<string>();
  const [legacyId, setLegacyId] = useState(initialFlowId ?? '');
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
  function runnable(id: string) {
    const found = flowsByStart.get(id);
    return found && (!runnableFlowIds || runnableFlowIds.has(found.id)) ? found : undefined;
  }
  const selectedFlow = runFlowId && runnable(selected)?.id === runFlowId;
  const flowsWithNode = definition.flows.filter(({ nodes }) =>
    nodes.some(({ id }) => id === selected),
  );
  const inspectedFlow =
    flowsByStart.get(selected) ??
    flowsWithNode.find(({ id }) => id === (definition.canvas ? initialFlowId : flow.id)) ??
    (flowsWithNode.length === 1 ? flowsWithNode[0] : undefined);
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
        isRunnableStart={onChooseFlow ? (id) => Boolean(runnable(id)) : undefined}
        onSelect={(id) => {
          setSelected(id);
          onChooseFlow?.(runnable(id));
        }}
      />
      {node && !selectedFlow && (
        <div className="graph-properties">
          <strong>
            {node.name} · {graphNodeLabels[node.type]}
          </strong>
          {renderResources?.(node, inspectedFlow)}
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
