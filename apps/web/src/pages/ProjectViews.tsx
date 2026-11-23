import { useState } from 'react';
import { InlineEditor, useInlineEditor } from '../InlineEditor';
import type { FormEvent } from 'react';
import { ArrowDown, ArrowUp, FolderGit2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { api, formatTime, message, navigate, post, remove, useResource } from '../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type { DeploymentSummary, Project, Server, ServerGroup, Service, User } from '../models';
import { ProjectAccessLinks, projectAccessUrl, type ProjectAccessLink } from './ProjectAccessLinks';
import { graphWorkbenchPath } from './graph-workbench-context';
import { projectResourcePath } from './project-workspace-route';
import { serverResourceHref } from './server-resource-route';

interface ViewSummary {
  id: string;
  name: string;
  description: string;
  kind: 'ALL' | 'PRODUCTION' | 'TESTING' | 'ABNORMAL' | 'CUSTOM';
  isDefault: boolean;
  projectIds: string[];
}

const deploymentStates = {
  NOT_DEPLOYED: { label: '未部署', tone: 'gray' },
  RUNNING: { label: '部署中', tone: 'amber' },
  HEALTHY: { label: '健康', tone: 'green' },
  UNVERIFIED: { label: '未验证', tone: 'gray' },
  ABNORMAL: { label: '异常', tone: 'red' },
};

interface ViewProject extends Pick<
  Project,
  'id' | 'name' | 'slug' | 'description' | 'status' | 'tags'
> {
  services: Pick<Service, 'id' | 'name'>[];
  deploymentStatus: keyof typeof deploymentStates;
  recentDeployments: (Omit<DeploymentSummary, 'serverId' | 'releaseVersion'> & {
    serverId: string | null;
    releaseVersion: string | null;
    serviceName?: string | null;
    environmentName?: string | null;
    serverName?: string | null;
    graphRunId?: string | null;
    graphFlowId?: string | null;
    graphNodeId?: string | null;
    graphVersion?: number | null;
  })[];
  addresses: ProjectAccessLink[];
}

interface ViewDetail extends ViewSummary {
  projects: ViewProject[];
}

function ProjectViewCard({
  project,
  viewId,
  viewSearch,
}: {
  project: ViewProject;
  viewId: string;
  viewSearch?: string;
}) {
  const deploymentState = deploymentStates[project.deploymentStatus];
  const serviceHref = (serviceId: string) =>
    '#' +
    projectResourcePath(project.id, { resource: 'services', serviceId, view: viewId, viewSearch });
  const linkedServices = new Set(
    project.addresses.filter(({ url }) => projectAccessUrl(url)).map(({ serviceId }) => serviceId),
  );
  const servicesWithoutAddresses = (project.services ?? []).filter(
    ({ id }) => !linkedServices.has(id),
  );
  return (
    <article className="project-view-card">
      <header className="project-view-card-header">
        <span className="project-avatar" aria-hidden="true">
          <FolderGit2 size={20} />
        </span>
        <div>
          <h3>
            <a
              className="text-link"
              href={'#' + projectResourcePath(project.id, { view: viewId, viewSearch })}
            >
              {project.name}
            </a>
          </h3>
          <span className="muted mono">{project.slug}</span>
        </div>
        <span
          className={`status ${deploymentState.tone}`}
          aria-label={`部署状态：${deploymentState.label}`}
        >
          <span />
          {deploymentState.label}
        </span>
      </header>
      {project.description && <p className="project-view-description">{project.description}</p>}
      {servicesWithoutAddresses.length > 0 && (
        <div className="tags project-view-environments" aria-label="项目服务">
          {servicesWithoutAddresses.map((service) => (
            <a key={service.id} className="tag text-link" href={serviceHref(service.id)}>
              {service.name}
            </a>
          ))}
        </div>
      )}
      <ProjectAccessLinks addresses={project.addresses} serviceHref={serviceHref} />
      <div className="project-view-card-section">
        <h4>最近部署</h4>
        {!project.recentDeployments.length ? (
          <p className="muted">暂无部署记录</p>
        ) : (
          <ul className="project-view-deployments">
            {project.recentDeployments.map((deployment) => {
              return (
                <li key={deployment.id}>
                  <div>
                    <a
                      className="text-link"
                      href={
                        deployment.graphRunId
                          ? '#' +
                            graphWorkbenchPath(project.id, {
                              pane: 'history',
                              serviceId: deployment.serviceId,
                              view: viewId,
                              viewSearch,
                              run: deployment.graphRunId,
                              flow: deployment.graphFlowId ?? undefined,
                              node: deployment.graphNodeId ?? undefined,
                              version: deployment.graphVersion ?? undefined,
                            })
                          : `#/tasks/${encodeURIComponent(deployment.taskId)}`
                      }
                    >
                      {deployment.serviceName ||
                        (deployment.graphRunId ? '查看发布节点' : '查看部署任务')}
                    </a>
                    {deployment.serverId && (
                      <a
                        className="text-link project-view-server-link"
                        href={serverResourceHref({ serverId: deployment.serverId })}
                      >
                        {deployment.serverName || deployment.serverId}
                      </a>
                    )}
                    <small className="muted">
                      {formatTime(deployment.finishedAt ?? deployment.startedAt)}
                      {deployment.releaseVersion && (
                        <code> · {deployment.releaseVersion.slice(0, 12)}</code>
                      )}
                    </small>
                  </div>
                  <Status
                    value={deployment.healthStatus === 'FAILED' ? 'FAILED' : deployment.status}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}

function ViewEditor({
  view,
  onClose,
  onSave,
}: {
  view?: ViewSummary;
  onClose: () => void;
  onSave: (id: string) => void;
}) {
  const projects = useResource<Pick<Project, 'id' | 'name' | 'slug'>[]>('/projects');
  const [projectIds, setProjectIds] = useState(view?.projectIds ?? []);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const byId = new Map(projects.data?.map((project) => [project.id, project]));
  const query = search.trim().toLocaleLowerCase();
  const options = projects.data?.filter(({ name, slug }) =>
    `${name} ${slug}`.toLocaleLowerCase().includes(query),
  );

  function move(index: number, offset: -1 | 1) {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= projectIds.length) return;
    const next = [...projectIds];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setProjectIds(next);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !projects.data) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) {
      setError('请输入视图名称。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const body = {
        name,
        description: String(form.get('description') ?? '').trim(),
        isDefault: form.has('default'),
        projectIds,
      };
      const saved = view
        ? await api<ViewSummary>(`/views/${encodeURIComponent(view.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await post<ViewSummary>('/views', body);
      onSave(saved.id);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <InlineEditor
      busy={busy}
      title={view ? '编辑项目视图' : '新建项目视图'}
      onClose={() => !busy && onClose()}
      wide
    >
      {!projects.data ? (
        <div className="form-body">
          {projects.loading ? (
            <Loading />
          ) : (
            <ErrorBanner error={projects.error} retry={projects.reload} />
          )}
        </div>
      ) : (
        <Form onSubmit={save} busy={busy} error={error} onCancel={onClose} submit="保存视图">
          <Field label="视图名称" required>
            <input name="name" defaultValue={view?.name} maxLength={100} required autoFocus />
          </Field>
          <Field label="视图描述">
            <textarea
              name="description"
              defaultValue={view?.description}
              rows={2}
              maxLength={2000}
            />
          </Field>
          <label className="checkbox-row project-view-default">
            <input type="checkbox" name="default" defaultChecked={view?.isDefault} />
            设为我的默认视图
          </label>
          <div className="project-view-editor-grid">
            <fieldset>
              <legend>可选项目</legend>
              <Field label="搜索项目">
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </Field>
              {options?.length ? (
                <div className="project-view-picker">
                  {options.map((project) => (
                    <label className="checkbox-row" key={project.id}>
                      <input
                        type="checkbox"
                        aria-label={project.name}
                        checked={projectIds.includes(project.id)}
                        disabled={busy}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setProjectIds((current) =>
                            checked
                              ? [...current, project.id]
                              : current.filter((id) => id !== project.id),
                          );
                        }}
                      />
                      <span>
                        {project.name}
                        <small>{project.slug}</small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="muted">{query ? '没有匹配的项目' : '暂无可选项目'}</p>
              )}
            </fieldset>
            <fieldset>
              <legend>视图内排序</legend>
              {projectIds.length ? (
                <ol className="project-view-order">
                  {projectIds.map((id, index) => {
                    const name = byId.get(id)?.name ?? '不可用的项目';
                    return (
                      <li key={id}>
                        <span>{name}</span>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="icon-button bare"
                            aria-label={`${name} 上移`}
                            onClick={() => move(index, -1)}
                            disabled={busy || index === 0}
                          >
                            <ArrowUp size={15} />
                          </button>
                          <button
                            type="button"
                            className="icon-button bare"
                            aria-label={`${name} 下移`}
                            onClick={() => move(index, 1)}
                            disabled={busy || index === projectIds.length - 1}
                          >
                            <ArrowDown size={15} />
                          </button>
                          {!byId.has(id) && (
                            <button
                              type="button"
                              className="icon-button bare"
                              aria-label={`移除${name}`}
                              onClick={() =>
                                setProjectIds((current) =>
                                  current.filter((member) => member !== id),
                                )
                              }
                              disabled={busy}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="muted">尚未选择项目</p>
              )}
            </fieldset>
          </div>
        </Form>
      )}
    </InlineEditor>
  );
}

export function ProjectViewsPage({
  user,
  id,
  search,
}: {
  user: User;
  id?: string;
  search?: string;
}) {
  const catalog = useResource<{ views: ViewSummary[]; defaultViewId: string }>('/views');
  const selectedId = id || catalog.data?.defaultViewId;
  const filters = new URLSearchParams(search);
  const serviceId = filters.get('serviceId') ?? '';
  const serverId = filters.get('serverId') ?? '';
  const groupId = filters.get('groupId') ?? '';
  const viewPath = selectedId ? `/views/${encodeURIComponent(selectedId)}` : null;
  const viewSearch = filters.toString();
  const unfiltered = useResource<ViewDetail>(viewSearch ? viewPath : null);
  const detail = useResource<ViewDetail>(
    viewPath && viewSearch ? `${viewPath}?${viewSearch}` : viewPath,
  );
  const servers = useResource<Server[]>('/servers');
  const groups = useResource<ServerGroup[]>('/server-groups');
  const selected = detail.data?.id === selectedId ? detail.data : undefined;
  const serviceProjects = (unfiltered.data ?? selected)?.projects ?? [];
  const [editor, setEditor] = useInlineEditor<ViewSummary | 'new'>();
  const [deleting, setDeleting] = useState<ViewSummary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEdit = user.role !== 'VIEWER';

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    const service = String(data.get('service') ?? '');
    const [kind, target] = String(data.get('target') ?? '').split(':');
    if (service) params.set('serviceId', service);
    if (target && (kind === 'serverId' || kind === 'groupId')) params.set(kind, target);
    if (viewPath) navigate(viewPath + (params.size ? '?' + params : ''));
  }

  async function deleteView() {
    if (!deleting || busy) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/views/${encodeURIComponent(deleting.id)}`);
      setDeleting(undefined);
      navigate('/views');
      await catalog.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function viewLinks(views: ViewSummary[]) {
    return views.map((view) => (
      <a
        key={view.id}
        href={`#/views/${encodeURIComponent(view.id)}`}
        aria-current={selectedId === view.id ? 'page' : undefined}
        aria-description={view.isDefault ? '默认视图' : undefined}
      >
        <span>{view.name}</span>
        {view.isDefault && <Star size={13} aria-hidden="true" />}
      </a>
    ));
  }

  return (
    <>
      <PageHeader
        title="项目视图"
        description="按项目服务、服务器分组或实际服务器查看最近发布。"
        action={
          <>
            <RefreshButton
              onClick={() => {
                void catalog.reload();
                void detail.reload();
                if (viewSearch) void unfiltered.reload();
              }}
            />
            {canEdit && (
              <button className="button primary" onClick={() => setEditor('new')}>
                <Plus size={16} />
                新建视图
              </button>
            )}
          </>
        }
      />
      {editor && (
        <ViewEditor
          key={editor === 'new' ? 'new' : editor.id}
          view={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(undefined)}
          onSave={(viewId) => {
            setEditor(undefined);
            navigate(`/views/${encodeURIComponent(viewId)}`);
            void catalog.reload();
            if (selectedId === viewId) void detail.reload();
          }}
        />
      )}
      <ErrorBanner error={catalog.error} retry={catalog.reload} />
      {catalog.loading ? (
        <Loading />
      ) : (
        catalog.data && (
          <div className="project-views-layout">
            <nav className="panel project-views-nav" aria-label="项目视图">
              <div>
                <h2>预设视图</h2>
                {viewLinks(catalog.data.views.filter(({ kind }) => kind !== 'CUSTOM'))}
              </div>
              <div>
                <h2>我的视图</h2>
                {catalog.data.views.some(({ kind }) => kind === 'CUSTOM') ? (
                  viewLinks(catalog.data.views.filter(({ kind }) => kind === 'CUSTOM'))
                ) : (
                  <p className="muted">暂无自定义视图</p>
                )}
              </div>
            </nav>
            <div className="project-views-content">
              <ErrorBanner error={detail.error} retry={detail.reload} />
              {selected ? (
                <Section
                  title={selected.name}
                  subtitle={selected.description || undefined}
                  action={
                    canEdit &&
                    selected.kind === 'CUSTOM' && (
                      <div className="heading-actions">
                        <button
                          className="button secondary small"
                          onClick={() => setEditor(selected)}
                        >
                          <Pencil size={14} /> 编辑视图
                        </button>
                        <button
                          className="button secondary small"
                          onClick={() => {
                            setError('');
                            setDeleting(selected);
                          }}
                        >
                          <Trash2 size={14} /> 删除视图
                        </button>
                      </div>
                    )
                  }
                >
                  <form
                    className="delivery-filters project-view-filters"
                    key={viewSearch}
                    onSubmit={applyFilters}
                  >
                    <label>
                      服务
                      <select name="service" defaultValue={serviceId}>
                        <option value="">全部服务</option>
                        {serviceId &&
                          !serviceProjects.some((project) =>
                            project.services?.some(({ id }) => id === serviceId),
                          ) && <option value={serviceId}>所选服务</option>}
                        {serviceProjects.map((project) => (
                          <optgroup key={project.id} label={project.name}>
                            {project.services?.map((service) => (
                              <option key={service.id} value={service.id}>
                                {service.name}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </label>
                    <label>
                      部署目标
                      <select
                        name="target"
                        defaultValue={
                          serverId ? `serverId:${serverId}` : groupId ? `groupId:${groupId}` : ''
                        }
                      >
                        <option value="">全部目标</option>
                        {serverId && !servers.data?.some(({ id }) => id === serverId) && (
                          <option value={`serverId:${serverId}`}>所选服务器</option>
                        )}
                        {groupId && !groups.data?.some(({ id }) => id === groupId) && (
                          <option value={`groupId:${groupId}`}>所选分组</option>
                        )}
                        <optgroup label="服务器分组">
                          {groups.data?.map((group) => (
                            <option key={group.id} value={`groupId:${group.id}`}>
                              {group.name}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="服务器">
                          {servers.data?.map((server) => (
                            <option key={server.id} value={`serverId:${server.id}`}>
                              {server.name}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </label>
                    <button type="submit" className="button secondary small">
                      筛选
                    </button>
                    {viewSearch && (
                      <a className="text-link" href={'#' + viewPath}>
                        清除筛选
                      </a>
                    )}
                  </form>
                  <ErrorBanner
                    error={servers.error || groups.error || unfiltered.error}
                    retry={() => {
                      void servers.reload();
                      void groups.reload();
                      if (viewSearch) void unfiltered.reload();
                    }}
                  />
                  {selected.projects.length ? (
                    <div className="project-views-grid">
                      {selected.projects.map((project) => (
                        <ProjectViewCard
                          key={project.id}
                          project={project}
                          viewId={selected.id}
                          viewSearch={viewSearch || undefined}
                        />
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<FolderGit2 size={24} />}
                      title={selected.kind === 'ABNORMAL' ? '暂无异常项目' : '暂无项目'}
                      description={
                        selected.kind === 'CUSTOM' && canEdit
                          ? '编辑视图以添加项目。'
                          : '当前没有项目符合此视图。'
                      }
                    />
                  )}
                </Section>
              ) : (
                !detail.error && <Loading />
              )}
            </div>
          </div>
        )
      )}
      {deleting && (
        <Confirm
          title="删除视图"
          description={`删除「${deleting.name}」只会移除视图及其排序。`}
          label="删除视图"
          destructive
          busy={busy}
          error={error}
          onClose={() => !busy && setDeleting(undefined)}
          onConfirm={() => void deleteView()}
        />
      )}
    </>
  );
}
