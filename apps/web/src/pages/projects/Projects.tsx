import { useEffect, useRef, useState, type FormEvent } from 'react';
import { FolderGit2, Play, Plus } from 'lucide-react';
import { ActionMenu } from '../../ActionMenu';
import { InlineEditor, useInlineEditor } from '../../InlineEditor';
import { ApiError, formatTime, message, navigate, post, useResource } from '../../api';
import { Empty, ErrorBanner, Form, Loading, PageHeader, Status } from '../../components';
import { submittedForm } from '../../form-data';
import type { Project, User } from '../../models';
import { workspaceOrigin, type EntryOrigin } from '../../workspace-navigation';
import { graphKey } from '../execution-graph/execution-graph-definition';
import { graphWorkbenchPath } from '../execution-graph/graph-workbench-context';
import { ProjectAccessLinks, type ProjectAccessLink } from './ProjectAccessLinks';
import { projectResourcePath } from './project-workspace-route';
import { ProjectBasicsFields, projectBasicsValues } from './settings/ProjectConfiguration';
import './project-cards.css';

type ListedProject = Project & { addresses: ProjectAccessLink[] };
type Flow = {
  id: string;
  name: string;
  version?: number;
  inDraft: boolean;
  hasRuntimeInputs?: boolean;
  needsArtifactInput?: boolean;
  latestRun?: { id: string; status: string; createdAt: number };
};
type ProjectFlows = { projectId: string; hasDraftChanges: boolean; flows: Flow[] };

function projectListPath(query: string) {
  return '/projects' + (query ? '?' + new URLSearchParams({ q: query }) : '');
}

function matchesProject(project: Pick<Project, 'name' | 'slug'>, query: string) {
  return [project.name, project.slug].some((value) => value.toLowerCase().includes(query));
}

function ProjectEditor({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    const payload = projectBasicsValues(submittedForm(event));
    setBusy(true);
    setError('');
    try {
      onSaved(await post<Project>('/projects', payload));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor title="新建项目" onClose={onClose} busy={busy}>
      <Form onSubmit={save} error={error} busy={busy} submit="创建项目" onCancel={onClose}>
        <ProjectBasicsFields autoFocus />
      </Form>
    </InlineEditor>
  );
}

function ProjectFlowRow({
  projectId,
  flow,
  origin,
  canEdit,
  busy,
  start,
}: {
  projectId: string;
  flow: Flow;
  origin: EntryOrigin;
  canEdit: boolean;
  busy: string;
  start: (projectId: string, flow: Flow) => Promise<void>;
}) {
  const { id, name, version, latestRun, inDraft } = flow;
  const href = (options: Parameters<typeof graphWorkbenchPath>[1]) =>
    '#' + graphWorkbenchPath(projectId, { ...origin, ...options });
  const draftHref = href({ pane: 'draft', start: id, node: id });
  const secondary = [];
  if (version && flow.hasRuntimeInputs && !flow.needsArtifactInput)
    secondary.push({ label: '带参数运行', href: href({ pane: 'run', start: id, version }) });
  if (version && inDraft) secondary.push({ label: '配置画布', href: draftHref });

  return (
    <li>
      <div className="project-flow-summary">
        <strong>{name}</strong>
        {version ? (
          <a
            className="text-link project-flow-version"
            href={href({ pane: 'published', flow: id, node: id, version })}
          >
            已发布 v{version}
          </a>
        ) : (
          <span className="tag">草稿</span>
        )}
        {latestRun && (
          <a
            className="project-flow-result"
            aria-label={`${name}的最近运行`}
            href={href({ pane: 'history', run: latestRun.id })}
          >
            <Status value={latestRun.status} />
            <span>{formatTime(latestRun.createdAt)}</span>
          </a>
        )}
      </div>
      {canEdit && (
        <div className="workbench-actions project-flow-actions">
          {version && flow.needsArtifactInput ? (
            <a
              className="button primary small"
              href={href({ pane: 'run', start: id, version, field: 'artifactId' })}
            >
              <Play size={15} aria-hidden="true" /> 选择产物
            </a>
          ) : version ? (
            <button
              type="button"
              className="button primary small"
              disabled={!!busy}
              onClick={() => void start(projectId, flow)}
            >
              <Play size={15} aria-hidden="true" />
              {busy === [projectId, id, version].join('/') ? '正在启动' : '运行'}
            </button>
          ) : inDraft ? (
            <a className="button primary small" href={draftHref}>
              配置画布
            </a>
          ) : null}
          <ActionMenu label={`${name}的更多操作`} links={secondary} />
        </div>
      )}
    </li>
  );
}

export function ProjectsPage({ user, search }: { user: User; search?: string }) {
  const projects = useResource<ListedProject[]>('/projects?include=addresses');
  const catalog = useResource<ProjectFlows[]>('/delivery-flows', 15000);
  const byProject = new Map((catalog.data ?? []).map((entry) => [entry.projectId, entry]));
  const routeQuery = (new URLSearchParams(search).get('q') ?? '').slice(0, 160);
  const [searchDraft, setSearchDraft] = useState<string>();
  const query = searchDraft ?? routeQuery;
  const effectiveQuery = query.trim();
  const origin = workspaceOrigin('projects', new URLSearchParams({ q: effectiveQuery }).toString());
  const keyword = effectiveQuery.toLowerCase();
  const canEdit = user.role !== 'VIEWER';
  const [creating, setCreating] = useInlineEditor<true>();
  const [focusProject, setFocusProject] = useState<string>();
  const [busy, setBusy] = useState('');
  const [runError, setRunError] = useState<{ projectId: string; message: string }>();
  const active = useRef(false);
  const requestKeys = useRef(new Map<string, string>());
  const list = (projects.data ?? [])
    .filter((project) => matchesProject(project, keyword))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, 'zh-CN') || left.id.localeCompare(right.id),
    );

  useEffect(() => setSearchDraft(undefined), [routeQuery]);

  useEffect(() => {
    if (!focusProject) return;
    const title = document.getElementById('project-title-' + focusProject);
    if (!title) return;
    title.scrollIntoView({ block: 'nearest' });
    title.focus({ preventScroll: true });
    setFocusProject(undefined);
  }, [focusProject, projects.data, query]);

  function saved(project: Project) {
    setCreating(undefined);
    setFocusProject(project.id);
    if (!matchesProject(project, keyword)) clearSearch();
    void projects.reload();
    void catalog.reload();
  }

  function clearSearch() {
    setSearchDraft(undefined);
    if (routeQuery) navigate('/projects');
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchDraft(undefined);
    if (routeQuery !== effectiveQuery) navigate(projectListPath(effectiveQuery));
  }

  async function start(projectId: string, flow: Flow) {
    if (!canEdit || !flow.version || active.current) return;
    active.current = true;
    const key = [projectId, flow.id, flow.version].join('/');
    setBusy(key);
    setRunError(undefined);
    const idempotencyKey = requestKeys.current.get(key) ?? graphKey('defaults');
    requestKeys.current.set(key, idempotencyKey);
    const runPath = (field?: string) =>
      graphWorkbenchPath(projectId, {
        ...origin,
        pane: 'run',
        start: flow.id,
        version: flow.version,
        field,
      });
    try {
      const result = await post<
        { outcome: 'STARTED'; runId: string } | { outcome: 'NEEDS_CONFIRMATION' }
      >(
        `/projects/${encodeURIComponent(projectId)}/execution-graph/flows/${encodeURIComponent(flow.id)}/run-defaults`,
        { version: flow.version, idempotencyKey },
      );
      requestKeys.current.delete(key);
      navigate(
        result.outcome === 'STARTED'
          ? graphWorkbenchPath(projectId, { ...origin, pane: 'history', run: result.runId })
          : runPath(),
      );
    } catch (err) {
      const issue = err instanceof ApiError ? err.planIssue : undefined;
      if (
        issue?.code === 'INPUT' ||
        (flow.needsArtifactInput && issue?.code === 'RELEASE_TARGET')
      ) {
        const field = issue.parameterId ?? (flow.needsArtifactInput ? 'artifactId' : issue.fieldId);
        requestKeys.current.delete(key);
        navigate(runPath(field));
      } else {
        setRunError({ projectId, message: message(err) });
        if (err instanceof ApiError && err.status === 409) await catalog.reload();
      }
    } finally {
      active.current = false;
      setBusy('');
    }
  }

  return (
    <div className="workbench-stack">
      <PageHeader
        title="项目发布"
        description=""
        action={
          canEdit && (
            <button
              className="button primary"
              disabled={creating}
              onClick={(event) => setCreating(true, event.currentTarget)}
            >
              <Plus size={17} aria-hidden="true" /> 新建项目
            </button>
          )
        }
      />
      {creating && <ProjectEditor onClose={() => setCreating(undefined)} onSaved={saved} />}
      <form className="workbench-filterbar project-search" onSubmit={submitSearch}>
        <input
          type="search"
          aria-label="搜索项目"
          maxLength={160}
          value={query}
          onChange={(event) => setSearchDraft(event.target.value)}
          placeholder="项目名称或标识"
        />
        <div className="workbench-actions">
          <button type="submit" className="button secondary">
            应用筛选
          </button>
          {(keyword || routeQuery) && (
            <button type="button" className="button secondary" onClick={clearSearch}>
              清除
            </button>
          )}
        </div>
      </form>
      <ErrorBanner error={projects.error} retry={projects.reload} />
      <ErrorBanner
        error={catalog.error && '执行流目录加载失败。' + catalog.error}
        retry={catalog.reload}
      />
      {projects.loading && <Loading />}
      {!projects.loading &&
        projects.data &&
        (list.length === 0 ? (
          <Empty
            icon={<FolderGit2 size={25} />}
            title={keyword ? '没有匹配的项目' : '暂无项目'}
            description={keyword ? '可以更换项目名称或标识。' : '创建项目后可配置执行流和服务。'}
            action={
              keyword && (
                <button type="button" className="button secondary" onClick={clearSearch}>
                  清除搜索
                </button>
              )
            }
          />
        ) : (
          <div className="workbench-stack project-catalog">
            {list.map((project) => {
              const entry = catalog.error ? undefined : byProject.get(project.id);
              return (
                <article key={project.id} className="panel project-card">
                  <div className="project-card-top">
                    <span className="project-avatar" aria-hidden="true">
                      <FolderGit2 size={22} />
                    </span>
                    <div className="project-card-heading">
                      <h2>
                        <a
                          id={'project-title-' + project.id}
                          className="text-link"
                          href={'#' + projectResourcePath(project.id, origin)}
                        >
                          {project.name}
                        </a>
                      </h2>
                      <span className="project-slug mono">{project.slug}</span>
                    </div>
                    {entry?.hasDraftChanges && <span className="tag">有未发布修改</span>}
                  </div>
                  {project.tags.length > 0 && (
                    <div className="tags">
                      {project.tags.map((tag) => (
                        <span className="tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="project-card-body">
                    <section className="project-card-flows" aria-label={project.name + '的执行流'}>
                      <h3>执行流</h3>
                      {catalog.loading && (
                        <div className="project-flow-empty" role="status">
                          正在加载执行流…
                        </div>
                      )}
                      {catalog.error && <div className="project-flow-empty">执行流暂不可用</div>}
                      <ErrorBanner
                        error={runError?.projectId === project.id ? runError.message : undefined}
                      />
                      {!catalog.loading && !catalog.error && !entry?.flows.length && (
                        <div className="project-flow-empty">
                          <span>暂无执行流</span>
                          {canEdit && (
                            <a
                              className="button secondary small"
                              href={
                                '#' + graphWorkbenchPath(project.id, { ...origin, pane: 'draft' })
                              }
                            >
                              配置画布
                            </a>
                          )}
                        </div>
                      )}
                      {Boolean(entry?.flows.length) && (
                        <ul className="project-flow-list">
                          {entry?.flows.map((flow) => (
                            <ProjectFlowRow
                              key={flow.id}
                              projectId={project.id}
                              flow={flow}
                              origin={origin}
                              canEdit={canEdit}
                              busy={busy}
                              start={start}
                            />
                          ))}
                        </ul>
                      )}
                    </section>
                    <ProjectAccessLinks
                      showEmpty
                      density="compact"
                      title="服务访问"
                      addresses={project.addresses ?? []}
                      serviceHref={(serviceId) =>
                        '#' +
                        projectResourcePath(project.id, {
                          ...origin,
                          resource: 'services',
                          serviceId,
                        })
                      }
                    />
                  </div>
                </article>
              );
            })}
          </div>
        ))}
    </div>
  );
}
