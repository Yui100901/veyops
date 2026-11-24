import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ListPlus, Play, Redo2, Save, Undo2, Upload } from 'lucide-react';
import {
  api,
  ApiError,
  formatTime,
  message,
  navigate,
  post,
  readGraphIssueLocation,
  useResource,
  useRouteBlocker,
  type RouteTransition,
} from '../../api';
import { Confirm, ErrorBanner, Field, Loading, Modal, PageHeader, Section } from '../../components';
import type { ProjectDetail, User } from '../../models';
import { NodeMap } from './editor/ExecutionGraphCanvas';
import { ProjectGraphEditor } from './editor/ExecutionGraphEditor';
import { ExecutionGraphMigration } from './ExecutionGraphMigration';
import { PublishedNodeDetails, showSelectedNode } from './editor/ExecutionGraphNodeDetails';
import { ExecutionGraphResourceLinks } from './ExecutionGraphResourceLinks';
import {
  ExecutionGraphHistory,
  ExecutionGraphStart,
  type GraphRunDrafts,
} from './run/ExecutionGraphRun';
import {
  ExecutionGraphStartList,
  ExecutionGraphStartStatus,
} from './run/ExecutionGraphStartStatus';
import {
  ExecutionGraphStickyCanvas,
  scrollBelowGraphCanvas,
} from './run/ExecutionGraphStickyCanvas';
import { ExecutionGraphTemplateDialog } from './editor/ExecutionGraphTemplateDialog';
import { ExecutionGraphTriggers } from './editor/ExecutionGraphTriggers';
import { triggerFlows, type TriggerPreflightIssue } from './editor/graph-trigger-model';
import { GraphVersionTools } from './ExecutionGraphVersions';
import { effectiveNodeType, graphNodeTypeLabel } from './execution-graph-definition';
import { GraphResourceContext } from './graph-resource-context';
import type {
  GraphCanvas,
  GraphCatalog,
  GraphDocument,
  GraphEdge,
  GraphFlow,
  GraphFlowExpansion,
  GraphIssue,
  GraphNode,
} from './execution-graph-definition';
import { appendFlowTemplate } from './editor/graph-presets';
import {
  graphResourcePanel,
  graphReturnDelivery,
  graphScopeBackHref,
  graphStartReadiness,
  graphWorkbenchPath,
  type GraphPane,
  type GraphWorkbenchScope,
} from './graph-workbench-context';
import { readProjectWorkspace } from '../projects/project-workspace-route';
import './execution-graph.css';
import './run/graph-start.css';

type PublishedGraph = {
  version: number;
  definition: GraphDocument['draft'];
  retiredAt?: number | null;
};

const emptyCanvas: GraphCanvas = { nodes: [], edges: [], endpoints: [], templates: [] };

export default function ProjectExecutionGraph({
  id,
  user,
  runId,
  search,
  embedded,
  runDrafts,
  project: providedProject,
  reloadProject,
}: {
  id: string;
  user: User;
  runId?: string;
  search?: string;
  embedded?: boolean;
  runDrafts?: GraphRunDrafts;
  project?: ProjectDetail;
  reloadProject?: () => void | Promise<void>;
}) {
  const base = `/projects/${encodeURIComponent(id)}`;
  const projectResource = useResource<ProjectDetail>(
    providedProject ? null : base + '/delivery-context',
  );
  const project = providedProject ?? projectResource.data;
  const params = new URLSearchParams(search);
  const view = params.get('view') || undefined;
  const canMigrate = user.role !== 'VIEWER' && !!project && !project.archived;
  const showMigration = canMigrate && params.get('pane') === 'migration';
  const graph = useResource<GraphDocument>(showMigration ? null : base + '/execution-graph');
  if (!providedProject && projectResource.loading) return <Loading />;
  if (showMigration && project)
    return <ExecutionGraphMigration project={project} user={user} view={view} />;
  if (graph.loading) return <Loading />;
  if (!project || !graph.data)
    return (
      <>
        <ErrorBanner
          error={projectResource.error || graph.error || '项目执行图不可用'}
          retry={() => {
            if (!providedProject) void projectResource.reload();
            void graph.reload();
          }}
        />
        {canMigrate && (
          <a
            className="button secondary"
            href={'#' + graphWorkbenchPath(id, { view, pane: 'migration' })}
          >
            执行图迁移
          </a>
        )}
      </>
    );
  return (
    <GraphResourceContext.Provider
      value={{ role: user.role, reload: reloadProject ?? projectResource.reload }}
    >
      <Workspace
        key={id}
        project={project}
        initial={graph.data}
        path={base + '/execution-graph'}
        canEdit={user.role !== 'VIEWER' && !project.archived}
        isAdmin={user.role === 'ADMIN'}
        userId={user.id}
        runId={runId}
        search={search}
        embedded={embedded}
        runDrafts={runDrafts}
      />
    </GraphResourceContext.Provider>
  );
}

function Workspace({
  project,
  initial,
  path,
  canEdit,
  isAdmin,
  userId,
  runId,
  search,
  embedded,
  runDrafts,
}: {
  project: ProjectDetail;
  initial: GraphDocument;
  path: string;
  canEdit: boolean;
  isAdmin: boolean;
  userId: string;
  runId?: string;
  search?: string;
  embedded?: boolean;
  runDrafts?: GraphRunDrafts;
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
  const linkedField = params.get('field') ?? undefined;
  const linkedFieldLocation = readGraphIssueLocation(
    params.get('fieldSection'),
    params.get('artifactField'),
  );
  const returnStart = pane === 'draft' ? params.get('returnStart') || undefined : undefined;
  const returnField = returnStart ? params.get('returnField') || undefined : undefined;
  const scope: GraphWorkbenchScope = {
    serviceId: params.get('serviceId') || undefined,
    environmentId: params.get('environmentId') || undefined,
    view: params.get('view') || undefined,
    viewSearch: readProjectWorkspace('/projects/' + project.id, search)?.location.viewSearch,
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
  const [canvas, setCanvasState] = useState(initial.draft.canvas ?? emptyCanvas);
  const latestCanvas = useRef(canvas);
  const [undo, setUndo] = useState<GraphCanvas[]>([]);
  const [redo, setRedo] = useState<GraphCanvas[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [issues, setIssues] = useState<GraphIssue[]>([]);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState<RouteTransition | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [insertedStart, setInsertedStart] = useState<string>();
  const saving = useRef(false);
  const dirty = canvas !== (graph.draft.canvas ?? emptyCanvas);
  useRouteBlocker(canEdit && dirty, setLeaving);
  const latest = useResource<PublishedGraph>(
    graph.publishedVersion ? path + '/versions/' + graph.publishedVersion : null,
  );
  const runVersion = linkedVersion ?? graph.publishedVersion;
  const previous = useResource<PublishedGraph>(
    pane === 'run' && runVersion && runVersion !== graph.publishedVersion
      ? path + '/versions/' + runVersion
      : null,
  );
  const publishedRun = runVersion === graph.publishedVersion ? latest : previous;

  function setCanvas(next: GraphCanvas) {
    latestCanvas.current = next;
    setCanvasState(next);
  }

  function panePath(next: GraphPane) {
    if (next === 'run' && returnStart) {
      return graphWorkbenchPath(project.id, {
        ...scope,
        start: returnStart,
        field: returnField,
        version: linkedVersion,
      });
    }
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
        field: linkedField,
        ...linkedFieldLocation,
        returnStart,
        returnField,
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
        if (result.issues.some(({ severity }) => severity !== 'WARNING' && severity !== 'INFO'))
          return;
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
      return saved;
    } catch (err) {
      setError(message(err));
      setConflict(err instanceof ApiError && err.status === 409);
      if (
        err instanceof ApiError &&
        err.planIssue &&
        (action === 'publish' || action === 'validate')
      )
        setIssues([{ ...err.planIssue, severity: 'ERROR' }]);
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function prepareTriggerDraft() {
    if (!dirty) return graph.revision;
    const saved = await persist('save');
    if (!saved) throw new Error('请先解决画布草稿的保存问题。');
    return saved.revision;
  }

  function triggerIssueHref(issue: TriggerPreflightIssue) {
    return (
      '#' +
      graphWorkbenchPath(project.id, {
        ...scope,
        pane: 'draft',
        flow: issue.flowId,
        node: issue.nodeId,
        field: issue.fieldId,
        fieldSection: issue.fieldSection,
        artifactField: issue.artifactField,
      })
    );
  }

  function stayInDraft() {
    if (saving.current || !leaving) return;
    leaving.cancel();
    setLeaving(null);
  }

  async function leaveDraft(save: boolean) {
    if (saving.current || !leaving) return;
    if (save) {
      if (!(await persist('save'))) return;
    } else {
      setCanvas(graph.draft.canvas ?? emptyCanvas);
      setUndo([]);
      setRedo([]);
      setIssues([]);
      setError('');
      setNotice('');
    }
    leaving.proceed();
    setLeaving(null);
  }

  function edit(next: GraphCanvas) {
    const previous = latestCanvas.current;
    if (next === previous || saving.current) return;
    setUndo((history) => [...history.slice(-49), previous]);
    setRedo([]);
    setCanvas(next);
    setIssues([]);
    setNotice('');
  }

  function insertTemplate(expansion: GraphFlowExpansion) {
    if (!canEdit || saving.current) throw new Error('此草稿暂时无法编辑，请稍后重试。');
    edit(appendFlowTemplate(latestCanvas.current, expansion));
    setInsertedStart(expansion.startId);
  }

  function stepDraft(direction: 'undo' | 'redo') {
    const history = direction === 'undo' ? undo : redo;
    const next = history.at(-1);
    if (!next || saving.current) return;
    setCanvas(next);
    setIssues([]);
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
      {leaving && (
        <Modal
          title="草稿有未保存的更改"
          description="可以保存当前草稿后离开，放弃本次更改，或返回画布继续编辑。"
          onClose={stayInDraft}
        >
          {error && (
            <div className="form-body">
              <ErrorBanner error={error} />
            </div>
          )}
          <div className="modal-footer">
            <button
              type="button"
              className="button secondary"
              onClick={stayInDraft}
              disabled={busy}
            >
              继续编辑
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => void leaveDraft(false)}
              disabled={busy}
            >
              放弃更改
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => void leaveDraft(true)}
              disabled={busy || conflict}
            >
              {busy ? '正在保存…' : '保存并离开'}
            </button>
          </div>
        </Modal>
      )}
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
        {canEdit && (
          <a href={'#' + graphWorkbenchPath(project.id, { view: scope.view, pane: 'migration' })}>
            执行图迁移
          </a>
        )}
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
          className="graph-run-section"
          title="已发布执行图"
          subtitle={runVersion ? '版本 v' + runVersion : undefined}
        >
          <div className="graph-fields">
            <ErrorBanner error={publishedRun.error} retry={() => void publishedRun.reload()} />
            {invalidScope ? (
              <ErrorBanner error="所选服务或环境不在当前项目的可用资源中。" />
            ) : runVersion && publishedRun.loading ? (
              <Loading />
            ) : publishedRun.data && publishedRun.data.version === runVersion ? (
              <PublishedRun
                key={`${publishedRun.data.version}:${linkedStart ?? ''}:${linkedNode ?? ''}:${linkedFlow ?? ''}:${scope.serviceId ?? ''}:${scope.environmentId ?? ''}`}
                published={publishedRun.data}
                project={project}
                path={path}
                canRun={canEdit && !publishedRun.data.retiredAt}
                showTriggers={
                  publishedRun.data.version === graph.publishedVersion && !project.archived
                }
                canManageTriggers={canEdit && isAdmin}
                triggerIssueHref={triggerIssueHref}
                startId={linkedStart}
                focusFieldId={linkedField}
                inspectNodeId={linkedNode}
                inspectFlowId={linkedFlow}
                scope={scope}
                drafts={runDrafts}
                onRun={openRun}
              />
            ) : (
              !runVersion && (
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
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setTemplateOpen(true)}
                >
                  <ListPlus size={16} /> 插入流程模板
                </button>
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
          {canEdit && templateOpen && (
            <ExecutionGraphTemplateDialog
              path={path}
              insert={insertTemplate}
              close={() => setTemplateOpen(false)}
            />
          )}
          {returnStart && (
            <div className="graph-fields graph-setup-return">
              <div className="heading-actions">
                <a className="button secondary small" href={'#' + panePath('run')}>
                  ← 返回运行参数
                </a>
                <p className="field-note">发布修复后的草稿，运行入口会使用新版本。</p>
              </div>
            </div>
          )}
          <ProjectGraphEditor
            key={`${linkedNode ?? ''}:${linkedFlow ?? ''}:${linkedField ?? ''}:${linkedFieldLocation.fieldSection ?? ''}:${linkedFieldLocation.artifactField ?? ''}`}
            project={project}
            canvas={canvas}
            canEdit={canEdit && !busy}
            onChange={edit}
            issues={issues}
            initialNodeId={linkedNode}
            initialFlowId={linkedFlow}
            initialFieldId={linkedField}
            initialFieldLocation={linkedFieldLocation}
            insertedStartId={insertedStart}
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
                <ExecutionGraphTriggers
                  key={startId}
                  startId={startId}
                  path={path}
                  project={project}
                  latestVersion={
                    latest.data?.version === graph.publishedVersion &&
                    latest.data.definition.flows.some(({ id }) => id === startId)
                      ? graph.publishedVersion
                      : null
                  }
                  flows={triggerFlows({ flows: [], canvas })}
                  canInvoke={canEdit}
                  canManage={canEdit && isAdmin}
                  onPrepareDraft={prepareTriggerDraft}
                  issueHref={triggerIssueHref}
                  manualHref={'#' + graphWorkbenchPath(project.id, { ...scope, start: startId })}
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
          project={project}
          canCancel={canEdit}
          canApprove={canEdit && isAdmin}
          userId={userId}
          selected={selectedRun}
          selectedNodeId={linkedNode}
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
  showTriggers,
  canManageTriggers,
  triggerIssueHref,
  startId,
  focusFieldId,
  inspectNodeId,
  inspectFlowId,
  scope,
  drafts,
  onRun,
}: {
  published: PublishedGraph;
  project: ProjectDetail;
  path: string;
  canRun: boolean;
  showTriggers: boolean;
  canManageTriggers: boolean;
  triggerIssueHref: (issue: TriggerPreflightIssue) => string;
  startId?: string;
  focusFieldId?: string;
  inspectNodeId?: string;
  inspectFlowId?: string;
  scope: GraphWorkbenchScope;
  drafts?: GraphRunDrafts;
  onRun: (id: string) => void;
}) {
  const scoped = Boolean(scope.serviceId || scope.environmentId);
  const { flows } = published.definition;
  const starts = new Map(
    flows.map((entry) => [entry.id, graphStartReadiness(entry, scope, project)]),
  );
  const selected = flows.find(
    (item) =>
      item.id === startId ||
      item.nodes.some((node) => node.type === 'START' && node.id === startId),
  );
  const readiness = selected && starts.get(selected.id);
  const flow = readiness && readiness.status !== 'CONTEXT_MISMATCH' ? selected : undefined;
  const initialInputs = readiness && 'parameters' in readiness ? readiness.parameters : undefined;
  const start = selected?.nodes.find(({ type }) => type === 'START');
  const heading = useRef<HTMLHeadingElement>(null);
  const stickyCanvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (canRun && flow && !focusFieldId && !inspectNodeId)
      heading.current?.focus({ preventScroll: true });
  }, [canRun, flow, focusFieldId, inspectNodeId]);
  return (
    <>
      {scoped && (
        <div className="graph-fields graph-scoped-starts">
          <h3>关联的开始节点</h3>
          <ExecutionGraphStartList
            flows={flows}
            project={project}
            scope={scope}
            href={(entry) =>
              '#' +
              graphWorkbenchPath(project.id, {
                ...scope,
                start: entry.id,
                version: published.version,
              })
            }
            selectedId={selected?.id}
            canRepair={canRun}
            version={published.version}
          />
        </div>
      )}
      {startId && !selected && <ErrorBanner error="当前发布版本中找不到此开始节点。" />}
      {published.retiredAt && <p className="field-note">此版本已停用，可查看节点配置。</p>}
      <PublishedNodes
        definition={published.definition}
        path={path}
        project={project}
        version={published.version}
        initialNodeId={inspectNodeId ?? start?.id}
        scrollToInitialNode={Boolean(inspectNodeId && !focusFieldId)}
        initialFlowId={inspectFlowId ?? selected?.id}
        runFlowId={canRun ? flow?.id : undefined}
        stickyCanvas={stickyCanvas}
        onRunSetup={
          canRun && flow
            ? () => {
                scrollBelowGraphCanvas(heading.current, stickyCanvas.current);
                heading.current?.focus({ preventScroll: true });
              }
            : undefined
        }
        runnableFlowIds={
          new Set(
            flows
              .filter(({ id }) => starts.get(id)?.status !== 'CONTEXT_MISMATCH')
              .map(({ id }) => id),
          )
        }
        onChooseFlow={
          canRun
            ? (item) =>
                navigate(
                  graphWorkbenchPath(project.id, {
                    ...scope,
                    start: item.id,
                    node: item.nodes.find(({ type }) => type === 'START')?.id,
                    version: published.version,
                  }),
                )
            : undefined
        }
        renderResources={(node, inspectedFlow) => {
          const startStatus =
            node.type === 'START' && inspectedFlow && starts.get(inspectedFlow.id);
          return (
            <>
              {startStatus && inspectedFlow && (
                <ExecutionGraphStartStatus
                  readiness={startStatus}
                  flow={inspectedFlow}
                  project={project}
                  repairStart={
                    canRun
                      ? { ...scope, start: inspectedFlow.id, version: published.version }
                      : undefined
                  }
                />
              )}
              <ExecutionGraphResourceLinks
                node={node}
                start={inspectedFlow?.nodes.find(({ type }) => type === 'START')}
                flow={inspectedFlow}
                flowId={inspectedFlow?.id}
                version={published.version}
                pane="run"
                project={project}
                scope={scope}
              />
              {showTriggers && node.type === 'START' && inspectedFlow && (
                <ExecutionGraphTriggers
                  key={inspectedFlow.id}
                  startId={inspectedFlow.id}
                  path={path}
                  project={project}
                  latestVersion={published.version}
                  flows={triggerFlows(published.definition)}
                  canInvoke={canRun}
                  canManage={canManageTriggers}
                  issueHref={triggerIssueHref}
                  manualHref={
                    flow?.id !== inspectedFlow.id
                      ? '#' + graphWorkbenchPath(project.id, { ...scope, start: inspectedFlow.id })
                      : undefined
                  }
                  onRun={onRun}
                />
              )}
            </>
          );
        }}
      >
        {canRun && flow && readiness && (
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
                version={published.version}
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
              workbenchScope={scope}
              drafts={drafts}
              focusFieldId={focusFieldId}
              onRun={onRun}
            />
          </div>
        )}
      </PublishedNodes>
    </>
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
                {!retiredAt && canRestore && !!live.definition.flows.length && (
                  <details className="graph-field-card">
                    <summary>从此版本发起运行</summary>
                    <ul className="graph-edge-list">
                      {live.definition.flows.map((flow) => (
                        <li key={flow.id}>
                          <a
                            className="text-link"
                            href={
                              '#' +
                              graphWorkbenchPath(project.id, {
                                ...scope,
                                start: flow.id,
                                version: live.version,
                              })
                            }
                          >
                            {flow.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <PublishedNodes
                  key={`${live.version}:${linkedNode ?? ''}:${linkedFlow ?? ''}`}
                  definition={live.definition}
                  path={path}
                  project={project}
                  version={live.version}
                  initialNodeId={linkedNode}
                  scrollToInitialNode={Boolean(linkedNode)}
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
  path,
  project,
  version,
  onChooseFlow,
  initialNodeId,
  scrollToInitialNode,
  initialFlowId,
  runnableFlowIds,
  runFlowId,
  stickyCanvas,
  onRunSetup,
  renderResources,
  children,
}: {
  definition: GraphDocument['draft'];
  path: string;
  project: ProjectDetail;
  version: number;
  onChooseFlow?: (flow: GraphFlow) => void;
  initialNodeId?: string;
  scrollToInitialNode?: boolean;
  initialFlowId?: string;
  runnableFlowIds?: ReadonlySet<string>;
  runFlowId?: string;
  stickyCanvas?: RefObject<HTMLDivElement | null>;
  onRunSetup?: () => void;
  renderResources?: (node: GraphNode, flow?: GraphFlow) => React.ReactNode;
  children?: React.ReactNode;
}) {
  const catalog = useResource<GraphCatalog>(path + '/catalog');
  const [selected, setSelected] = useState(initialNodeId ?? '');
  const [hovered, setHovered] = useState<string>();
  const [legacyId, setLegacyId] = useState(initialFlowId ?? '');
  const [inspectionFlowId, setInspectionFlowId] = useState(initialFlowId);
  const nodeDetail = useRef<HTMLElement>(null);
  const reveal = useMemo(() => (selected ? { nodeId: selected } : undefined), [selected]);
  useEffect(() => {
    if (!scrollToInitialNode) return;
    const frame = window.requestAnimationFrame(() => {
      if (stickyCanvas) scrollBelowGraphCanvas(nodeDetail.current, stickyCanvas.current);
      else showSelectedNode(nodeDetail.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollToInitialNode, stickyCanvas]);
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
  const flowsWithNode = definition.flows.filter(({ nodes }) =>
    nodes.some(({ id }) => id === selected),
  );
  const inspectedFlow =
    flowsByStart.get(selected) ??
    flowsWithNode.find(({ id }) => id === (definition.canvas ? inspectionFlowId : flow.id)) ??
    flowsWithNode[0];
  const inspectedNode = inspectedFlow?.nodes.find(({ id }) => id === selected) ?? node;
  const highlight = (hovered && flowsByStart.get(hovered)) || flowsByStart.get(selected);
  const highlightedEdges = new Set(highlight?.edges.map(edgeKey));
  function selectNode(id: string) {
    setSelected(id);
    const start = runnable(id);
    if (onChooseFlow && start && start.id !== runFlowId) {
      onChooseFlow(start);
      return;
    }
    window.requestAnimationFrame(() => {
      if (stickyCanvas) scrollBelowGraphCanvas(nodeDetail.current, stickyCanvas.current);
      else showSelectedNode(nodeDetail.current);
    });
  }
  const renderCanvas = (expanded: boolean) => (
    <NodeMap
      flow={flow}
      selected={selected ? [selected] : []}
      highlighted={new Set(highlight?.nodes.map(({ id }) => id))}
      highlightEdges={
        new Set(flow.edges.flatMap((edge, i) => (highlightedEdges.has(edgeKey(edge)) ? [i] : [])))
      }
      onHighlight={setHovered}
      isRunnableStart={onChooseFlow ? (id) => Boolean(runnable(id)) : undefined}
      onSelect={selectNode}
      reveal={stickyCanvas && expanded ? reveal : undefined}
    />
  );
  return (
    <>
      {!definition.canvas && definition.flows.length > 1 && (
        <Field label="已发布执行流">
          <select
            value={flow.id}
            onChange={(e) => {
              setLegacyId(e.target.value);
              setSelected('');
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
      <div className={stickyCanvas ? 'graph-node-layout graph-run-layout' : 'graph-node-layout'}>
        <div className="graph-node-layout-inner">
          {stickyCanvas ? (
            <ExecutionGraphStickyCanvas
              containerRef={stickyCanvas}
              controls={
                <>
                  <Field label="定位节点">
                    <select
                      value={node ? selected : ''}
                      onChange={(e) => selectNode(e.target.value)}
                    >
                      <option value="" disabled>
                        选择节点
                      </option>
                      {flow.nodes.map(({ id, name }) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {onRunSetup && (
                    <button type="button" className="button primary small" onClick={onRunSetup}>
                      <Play size={15} aria-hidden="true" /> 填写运行参数
                    </button>
                  )}
                </>
              }
              renderCanvas={renderCanvas}
            />
          ) : (
            renderCanvas(true)
          )}
          <article ref={nodeDetail} className="graph-node-detail" aria-label="发布节点详情">
            {node && inspectedNode ? (
              <>
                <header>
                  <div>
                    <h3 aria-live="polite">{node.name}</h3>
                    <small>
                      {graphNodeTypeLabel(node)} · v{version}
                    </small>
                  </div>
                </header>
                {definition.canvas &&
                flowsWithNode.length > 1 &&
                effectiveNodeType(node) !== 'START' ? (
                  <Field label="执行流">
                    <select
                      value={inspectedFlow?.id ?? ''}
                      onChange={(e) => setInspectionFlowId(e.target.value)}
                    >
                      {flowsWithNode.map(({ id, name }) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : (
                  inspectedFlow && <p className="field-note">所属执行流 · {inspectedFlow.name}</p>
                )}
                {renderResources?.(inspectedNode, inspectedFlow)}
                {catalog.error && <ErrorBanner error={catalog.error} retry={catalog.reload} />}
                <PublishedNodeDetails
                  node={inspectedNode}
                  flow={inspectedFlow}
                  definition={definition}
                  catalog={catalog.data}
                  project={project}
                />
              </>
            ) : (
              <>
                <h3>节点详情</h3>
                <p className="field-note">
                  {selected ? '此版本中找不到所选节点。' : '在画布上选择节点查看配置。'}
                </p>
              </>
            )}
          </article>
          {children}
        </div>
      </div>
    </>
  );
}
