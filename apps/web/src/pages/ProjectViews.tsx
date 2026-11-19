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
import type { DeploymentSummary, Environment, Project, User } from '../models';
import { ProjectAccessLinks, type ProjectAccessLink } from './ProjectAccessLinks';

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
  environments: Pick<Environment, 'id' | 'name' | 'environmentType'>[];
  deploymentStatus: keyof typeof deploymentStates;
  recentDeployments: (Omit<DeploymentSummary, 'serverId' | 'releaseVersion'> & {
    serverId: string | null;
    releaseVersion: string | null;
    serviceName?: string | null;
    environmentName?: string | null;
    serverName?: string | null;
  })[];
  addresses: ProjectAccessLink[];
}

interface ViewDetail extends ViewSummary {
  projects: ViewProject[];
}

function ProjectViewCard({ project, viewId }: { project: ViewProject; viewId: string }) {
  const deploymentState = deploymentStates[project.deploymentStatus];
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
              href={`#/projects/${encodeURIComponent(project.id)}?view=${encodeURIComponent(viewId)}`}
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
      {project.environments.length > 0 && (
        <div className="tags project-view-environments" aria-label="运行环境">
          {project.environments.map((environment) => (
            <span key={environment.id} className="tag">
              {environment.name}
            </span>
          ))}
        </div>
      )}
      <ProjectAccessLinks addresses={project.addresses} />
      <div className="project-view-card-section">
        <h4>最近部署</h4>
        {!project.recentDeployments.length ? (
          <p className="muted">暂无部署记录</p>
        ) : (
          <ul className="project-view-deployments">
            {project.recentDeployments.map((deployment) => {
              const context = [
                deployment.environmentName ??
                  project.environments.find(({ id }) => id === deployment.environmentId)?.name,
                deployment.serviceName,
                deployment.serverName,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={deployment.id}>
                  <div>
                    <a
                      className="text-link"
                      href={`#/tasks/${encodeURIComponent(deployment.taskId)}`}
                    >
                      {context || '查看部署任务'}
                    </a>
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

export function ProjectViewsPage({ user, id }: { user: User; id?: string }) {
  const catalog = useResource<{ views: ViewSummary[]; defaultViewId: string }>('/views');
  const selectedId = id || catalog.data?.defaultViewId;
  const detail = useResource<ViewDetail>(
    selectedId ? `/views/${encodeURIComponent(selectedId)}` : null,
  );
  const selected = detail.data?.id === selectedId ? detail.data : undefined;
  const [editor, setEditor] = useInlineEditor<ViewSummary | 'new'>();
  const [deleting, setDeleting] = useState<ViewSummary>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEdit = user.role !== 'VIEWER';

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
        description="按环境、部署状态或自选项目查看最近交付。"
        action={
          <>
            <RefreshButton
              onClick={() => {
                void catalog.reload();
                void detail.reload();
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
                  {selected.projects.length ? (
                    <div className="project-views-grid">
                      {selected.projects.map((project) => (
                        <ProjectViewCard key={project.id} project={project} viewId={selected.id} />
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
