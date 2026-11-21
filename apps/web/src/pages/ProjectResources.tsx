import { useState, type FormEvent } from 'react';
import { Box, FolderGit2, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { InlineEditor } from '../InlineEditor';
import { api, formatTime, message, navigate, post, remove, useResource } from '../api';
import { Confirm, ErrorBanner, Field, Form, Loading, Section, Status } from '../components';
import type {
  Credential,
  DeploymentSummary,
  Environment,
  ProjectDetail,
  Repository,
  Service,
  User,
} from '../models';
import { EnvironmentConfigEditor, RepositoryBinding } from './DeploymentConfig';
import { ExecutionGraphStartList } from './ExecutionGraphStartStatus';
import { ProjectEnvironment } from './ProjectEnvironment';
import { ProjectRelations } from './ProjectRelations';
import { ProjectServerInventory } from './ProjectServerInventory';
import { RepositoryDetails } from './RepositoryBrowser';
import { repositoryBranchLabel } from './RepositoryBranches';
import { DeploymentHistory } from './ServerResources';
import { deliveryPath } from './delivery-route';
import type { GraphDocument } from './execution-graph-definition';
import { graphResourcePanel, graphStartHref } from './graph-workbench-context';
import {
  graphResourceReturnHref,
  projectGraphPath,
  projectResourcePath,
  projectResources,
  type GraphResourceReturn,
  type ProjectScope,
  type ResourceLocation as Location,
  type ResourceKind,
} from './project-workspace-route';

const resourceKinds = ['repositories', 'services', 'environments'] as const;
const icons = { repositories: FolderGit2, services: Box, environments: Layers };
type EditableKind = (typeof resourceKinds)[number];
type Resource = Repository | Service | Environment;
type Props = { project: ProjectDetail; user: User; reload: () => Promise<void> };

function editable(kind: ResourceKind): kind is EditableKind {
  return kind === 'repositories' || kind === 'services' || kind === 'environments';
}

function detail(kind: EditableKind, id: string, view?: string): Location {
  if (kind === 'repositories') return { resource: kind, repositoryId: id, view };
  if (kind === 'environments') return { resource: kind, environmentId: id, view };
  return { resource: kind, serviceId: id, view };
}

export function ProjectResources({
  project,
  user,
  reload,
  location,
}: Props & { location: Location }) {
  const { id } = project;
  const {
    view,
    resource,
    serviceId,
    environmentId,
    repositoryId,
    serverId,
    groupId,
    panel,
    graphPane,
    graphVersion,
    graphNode,
    graphFlow,
    graphStart,
    graphField,
    graphServiceId,
    graphEnvironmentId,
    graphResourcePanel: originalPanel,
  } = location;
  const graphBack = {
    graphPane,
    graphVersion,
    graphNode,
    graphFlow,
    graphStart,
    graphField,
    graphServiceId,
    graphEnvironmentId,
    graphResourcePanel: originalPanel,
  };
  const canEdit = user.role !== 'VIEWER' && !project.archived;
  const [editing, setEditor] = useState<{ kind: EditableKind; item?: Resource }>();
  const [deleting, setDeleting] = useState<{ kind: EditableKind; item: Resource }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const service =
    resource === 'services' ? project.services.find((row) => row.id === serviceId) : undefined;
  const environment = project.environments.find((row) => row.id === environmentId);
  const repository =
    resource === 'repositories'
      ? project.repositories.find((row) => row.id === repositoryId)
      : undefined;
  const missing =
    (resource === 'services' && ((serviceId && !service) || (environmentId && !environment))) ||
    (resource === 'environments' && environmentId && !environment) ||
    (resource === 'repositories' && repositoryId && !repository);
  const selected = Boolean(service || (resource === 'environments' && environment) || repository);
  const addingRepository =
    canEdit && resource === 'repositories' && !repositoryId && panel === 'new';
  const editor =
    editing ?? (addingRepository ? { kind: 'repositories' as const, item: undefined } : undefined);
  const resourceHref = (kind?: ResourceKind) =>
    '#' + projectResourcePath(id, { ...graphBack, view, resource: kind });
  async function archive() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/projects/${id}/${deleting.kind}/${deleting.item.id}`);
      const archivedDetail = [service?.id, environment?.id, repository?.id].includes(
        deleting.item.id,
      );
      if (archivedDetail)
        navigate(projectResourcePath(id, { ...graphBack, view, resource: deleting.kind }));
      setDeleting(undefined);
      await reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  function itemActions(kind: EditableKind, item: Resource) {
    if (!canEdit) return;
    const label = projectResources[kind];
    return (
      <span className="row-actions">
        <button
          className="button secondary small"
          type="button"
          aria-label={`编辑${label} ${item.name}`}
          onClick={() => setEditor({ kind, item })}
        >
          <Pencil size={14} /> 编辑
        </button>
        <button
          className="icon-button bare muted"
          type="button"
          aria-label={`移除${label} ${item.name}`}
          onClick={() => {
            setError('');
            setDeleting({ kind, item });
          }}
        >
          <Trash2 size={15} />
        </button>
      </span>
    );
  }
  return (
    <div className="project-resources">
      {!resource && <ProjectResourceSummary project={project} view={view} />}
      {graphPane && (
        <a className="back-link" href={graphResourceReturnHref(id, graphBack, view)}>
          {graphPane === 'run' && graphStart ? '← 返回运行参数' : '← 返回执行图'}
        </a>
      )}
      <nav className="resource-section-switcher" aria-label="项目资源分类">
        <a href={resourceHref()} aria-current={!resource ? 'page' : undefined}>
          全部资源
        </a>
        {(Object.keys(projectResources) as ResourceKind[]).map((kind) => (
          <a
            key={kind}
            href={resourceHref(kind)}
            aria-current={resource === kind ? 'page' : undefined}
          >
            {projectResources[kind]}
          </a>
        ))}
      </nav>
      {missing ? (
        <ErrorBanner error="该资源已归档或不属于当前项目。" />
      ) : canEdit && editor ? (
        <ProjectResourceEditor
          key={editor.item?.id ?? editor.kind}
          project={project}
          user={user}
          adding={editor.kind}
          editingResource={editor.item}
          onClose={() => {
            setEditor(undefined);
            if (addingRepository)
              navigate(projectResourcePath(id, { ...graphBack, view, resource }));
          }}
          onSaved={async (item) => {
            setEditor(undefined);
            await reload();
            if (!editor.item)
              navigate(
                projectResourcePath(id, { ...detail(editor.kind, item.id, view), ...graphBack }),
              );
          }}
        />
      ) : (
        <>
          {!selected && (!resource || editable(resource)) && (
            <div className={resource ? undefined : 'project-detail-grid'}>
              {resourceKinds
                .filter((kind) => !resource || kind === resource)
                .map((kind) => {
                  const Icon = icons[kind];
                  const label = projectResources[kind];
                  return (
                    <Section
                      key={kind}
                      title={label}
                      action={
                        canEdit && (
                          <button
                            className="button secondary small"
                            type="button"
                            onClick={() => setEditor({ kind })}
                          >
                            <Plus size={14} /> 添加{label}
                          </button>
                        )
                      }
                    >
                      {project[kind].length ? (
                        <div className="resource-list">
                          {project[kind].map((item) => (
                            <div key={item.id}>
                              <span className="resource-avatar">
                                <Icon size={17} />
                              </span>
                              <div>
                                <a
                                  className="text-link"
                                  href={
                                    '#' +
                                    projectResourcePath(id, {
                                      ...detail(kind, item.id, view),
                                      ...graphBack,
                                    })
                                  }
                                >
                                  {item.name}
                                </a>
                                <small>{'cloneUrl' in item ? item.cloneUrl : item.slug}</small>
                              </div>
                              <span className="tag">
                                {'cloneUrl' in item
                                  ? repositoryBranchLabel(item)
                                  : 'serviceType' in item
                                    ? item.serviceType
                                    : item.environmentType}
                              </span>
                              {itemActions(kind, item)}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="mini-empty">尚未添加{label}</p>
                      )}
                    </Section>
                  );
                })}
            </div>
          )}
          {service && (
            <ServiceDetails
              project={project}
              user={user}
              reload={reload}
              service={service}
              environment={environment}
              view={view}
              panel={panel}
              graphBack={graphBack}
              actions={itemActions('services', service)}
            />
          )}
          {resource === 'environments' && environment && (
            <ProjectEnvironment
              project={project}
              user={user}
              environment={environment}
              panel={panel}
              view={view}
              graphBack={graphBack}
              reload={reload}
              actions={itemActions('environments', environment)}
            />
          )}
          {repository && (
            <RepositoryDetails
              projectId={id}
              user={user}
              repository={repository}
              view={view}
              panel={panel}
              graphBack={graphBack}
              services={project.services}
              environments={project.environments}
              onSynced={reload}
              onClose={() =>
                navigate(projectResourcePath(id, { ...graphBack, view, resource: 'repositories' }))
              }
              actions={itemActions('repositories', repository)}
            />
          )}
          {(!resource || resource === 'servers') && (
            <ProjectServerInventory
              project={project}
              view={view}
              serverId={serverId}
              groupId={groupId}
            />
          )}
          {(!resource || resource === 'relations') && (
            <ProjectRelations project={project} user={user} reload={reload} />
          )}
        </>
      )}
      {deleting && (
        <Confirm
          title={`移除${projectResources[deleting.kind]}`}
          description={`归档「${deleting.item.name}」。配置、可运行图版本或在途任务仍引用它时会阻止归档。`}
          label="移除"
          destructive
          busy={busy}
          error={error}
          onClose={() => !busy && setDeleting(undefined)}
          onConfirm={archive}
        />
      )}
    </div>
  );
}

function ProjectResourceSummary({ project, view }: { project: ProjectDetail; view?: string }) {
  const runs = useResource<{ id: string; flowName: string; status: string; createdAt: number }[]>(
    `/projects/${project.id}/execution-graph/runs`,
  );
  const latest = runs.data?.[0];
  return (
    <div className="project-workspace-summary">
      <Status value={project.status} />
      {resourceKinds.map((kind) => (
        <a
          className="text-link"
          key={kind}
          href={'#' + projectResourcePath(project.id, { resource: kind, view })}
        >
          {projectResources[kind]} <strong>{project[kind].length}</strong>
        </a>
      ))}
      <a
        className="text-link"
        href={'#' + projectGraphPath(project.id, { view, pane: 'history', run: latest?.id })}
      >
        {latest ? `最近运行 · ${latest.flowName} · ${formatTime(latest.createdAt)}` : '运行记录'}
      </a>
      {latest && <Status value={latest.status} />}
    </div>
  );
}

function ServiceDetails({
  project,
  user,
  reload,
  service,
  environment,
  view,
  panel,
  actions,
  graphBack,
}: Props & {
  service: Service;
  environment?: Environment;
  view?: string;
  panel?: string;
  actions: React.ReactNode;
  graphBack: GraphResourceReturn;
}) {
  const { id } = project;
  const serviceId = service.id;
  const environmentId = environment?.id;
  const scope: ProjectScope = { serviceId, environmentId, view };
  const graphScope = { ...scope, resourcePanel: graphResourcePanel(panel) };
  const path = (env?: string, subpanel?: string) =>
    projectResourcePath(id, {
      ...graphBack,
      view,
      resource: 'services',
      serviceId,
      environmentId: env,
      panel: subpanel,
    });
  const graph = useResource<GraphDocument>(`/projects/${id}/execution-graph`);
  const version = graph.data?.publishedVersion;
  const published = useResource<{ version: number; definition: GraphDocument['draft'] }>(
    version ? `/projects/${id}/execution-graph/versions/${version}` : null,
  );
  const activePublished = published.data?.version === version ? published.data : undefined;
  const repos = useResource<{ repositoryId: string; repoPath: string; isPrimary: boolean }[]>(
    `/services/${serviceId}/repositories`,
  );
  const deployments = useResource<DeploymentSummary[]>(
    `/projects/${id}/services/${serviceId}/recent-deployments` +
      (environmentId ? `?environmentId=${encodeURIComponent(environmentId)}` : ''),
  );
  const graphError = graph.error || published.error;
  return (
    <>
      <Section
        title={service.name}
        subtitle={service.description || service.slug}
        action={actions}
        className="project-service-detail"
      >
        <nav className="resource-section-switcher" aria-label="服务环境">
          <a href={'#' + path()} aria-current={!environmentId ? 'page' : undefined}>
            服务概览
          </a>
          {project.environments.map((env) => (
            <a
              key={env.id}
              href={'#' + path(env.id)}
              aria-current={env.id === environmentId ? 'page' : undefined}
            >
              {env.name}
            </a>
          ))}
        </nav>
        <div className="row-actions">
          <a className="button secondary small" href={'#' + deliveryPath(id, 'artifacts', scope)}>
            交付记录
          </a>
          {environment && (
            <a
              className="button secondary small"
              href={
                '#' +
                projectResourcePath(id, {
                  ...detail('environments', environment.id, view),
                  ...graphBack,
                })
              }
            >
              环境详情
            </a>
          )}
        </div>
      </Section>
      <Section
        title="已发布执行流"
        className="project-service-starts"
        action={
          <a className="text-link" href={'#' + projectGraphPath(id, scope)}>
            查看执行图 →
          </a>
        }
      >
        {graphError ? (
          <ErrorBanner error={graphError} retry={graph.error ? graph.reload : published.reload} />
        ) : graph.loading || (version && !activePublished) ? (
          <Loading />
        ) : activePublished ? (
          <ExecutionGraphStartList
            project={project}
            scope={graphScope}
            flows={activePublished.definition.flows}
            version={activePublished.version}
            canRepair={user.role !== 'VIEWER' && !project.archived}
            href={(flow) => graphStartHref(id, flow.id, graphScope)}
          />
        ) : (
          <p className="mini-empty">项目尚未发布执行图。</p>
        )}
      </Section>
      {environment ? (
        <EnvironmentConfigEditor
          key={serviceId + ':' + environment.id}
          project={project}
          user={user}
          serviceId={serviceId}
          environmentId={environment.id}
          panel={panel}
          view={view}
          graphBack={graphBack}
          onSaved={() => void reload()}
          onClose={() => navigate(path())}
        />
      ) : panel === 'repositories' && user.role !== 'VIEWER' ? (
        <RepositoryBinding
          project={project}
          serviceId={serviceId}
          onClose={() => navigate(path())}
        />
      ) : (
        <Section
          title="关联仓库"
          action={
            user.role !== 'VIEWER' && (
              <a className="button secondary small" href={'#' + path(undefined, 'repositories')}>
                设置仓库关联
              </a>
            )
          }
        >
          <ErrorBanner error={repos.error} retry={repos.reload} />
          {repos.loading ? (
            <Loading />
          ) : repos.data?.length ? (
            <div className="project-resource-links">
              {repos.data.map((link) => (
                <a
                  className="button secondary small"
                  key={link.repositoryId}
                  href={
                    '#' + projectResourcePath(id, detail('repositories', link.repositoryId, view))
                  }
                >
                  {project.repositories.find(({ id }) => id === link.repositoryId)?.name ||
                    link.repositoryId}
                  {link.isPrimary && <span className="tag">主仓库</span>}
                  <code>{link.repoPath}</code>
                </a>
              ))}
            </div>
          ) : (
            <p className="mini-empty">这个服务尚未关联仓库。</p>
          )}
        </Section>
      )}
      <Section
        title="最近发布"
        action={
          <a className="text-link" href={'#' + deliveryPath(id, 'deployments', scope)}>
            查看全部部署与回滚 →
          </a>
        }
      >
        <ErrorBanner error={deployments.error} retry={deployments.reload} />
        {deployments.loading ? (
          <Loading />
        ) : (
          !deployments.error && (
            <DeploymentHistory
              rows={deployments.data ?? []}
              resolveName={(row) =>
                project.environments.find(({ id }) => id === row.environmentId)?.name || '查看任务'
              }
            />
          )
        )}
      </Section>
    </>
  );
}

function ProjectResourceEditor({
  project,
  user,
  adding,
  editingResource,
  onClose,
  onSaved,
}: {
  project: ProjectDetail;
  user: User;
  adding: EditableKind;
  editingResource?: Resource;
  onClose: () => void;
  onSaved: (item: Resource) => Promise<void>;
}) {
  const credentials = useResource<Credential[]>(
    adding === 'repositories' && user.role === 'ADMIN' ? '/credentials' : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const labels = projectResources;
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const payload: Record<string, string | null> = {
      name: text('name'),
      description: text('description'),
    };
    if (adding === 'repositories') {
      payload.cloneUrl = text('cloneUrl');
      payload.provider = text('provider');
      if (user.role === 'ADMIN') payload.credentialId = text('credentialId') || null;
    } else {
      payload.slug = text('slug');
      if (adding === 'services') payload.serviceType = text('serviceType');
      else {
        payload.environmentType = text('environmentType');
      }
    }
    setBusy(true);
    setError('');
    const path = '/projects/' + project.id + '/' + adding;
    try {
      const result = editingResource
        ? await api<Resource>(path + '/' + editingResource.id, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await post<Resource>(path, payload);
      await onSaved(result);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor
      key={editingResource?.id ?? adding}
      busy={busy}
      title={`${editingResource ? '编辑' : '添加'}${labels[adding]}`}
      onClose={() => !busy && onClose()}
    >
      <Form
        onSubmit={add}
        error={error}
        busy={busy}
        submit={editingResource ? '保存' : `添加${labels[adding]}`}
        onCancel={() => onClose()}
      >
        <Field label="名称" required>
          <input
            name="name"
            required
            autoFocus
            defaultValue={editingResource?.name}
            maxLength={100}
          />
        </Field>
        {adding === 'repositories' ? (
          <>
            <Field label="Git 仓库地址" required hint="使用仓库的 HTTP(S) 克隆地址。">
              <input
                name="cloneUrl"
                placeholder="https://github.com/team/repository.git"
                type="url"
                pattern="https?://.+"
                defaultValue={(editingResource as Repository | undefined)?.cloneUrl}
                required
              />
            </Field>
            {user.role === 'ADMIN' && (
              <Field label="Git 认证凭据（可选）">
                <select
                  name="credentialId"
                  defaultValue={(editingResource as Repository | undefined)?.credentialId ?? ''}
                >
                  <option value="">公开仓库，无需认证</option>
                  {(editingResource as Repository | undefined)?.credentialId &&
                    !(credentials.data ?? []).some(
                      (item) =>
                        item.id === (editingResource as Repository).credentialId &&
                        item.status === 'ACTIVE',
                    ) && (
                      <option value={(editingResource as Repository).credentialId!}>
                        保留当前凭据
                      </option>
                    )}
                  {credentials.data
                    ?.filter(
                      (c) =>
                        ['GIT_TOKEN', 'GIT_PASSWORD'].includes(c.type) && c.status === 'ACTIVE',
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <p className="field-note">保存后会读取远端默认分支、分支列表和最新提交。</p>
            <Field label="代码托管平台">
              <select
                name="provider"
                defaultValue={(editingResource as Repository | undefined)?.provider ?? 'CUSTOM'}
              >
                <option value="CUSTOM">自建或其他</option>
                <option value="GITHUB">GitHub</option>
                <option value="GITLAB">GitLab</option>
                <option value="GITEA">Gitea</option>
                <option value="BITBUCKET">Bitbucket</option>
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="标识" required>
              <input
                name="slug"
                defaultValue={(editingResource as Service | Environment | undefined)?.slug}
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder={adding === 'services' ? 'web' : 'production'}
              />
            </Field>
            {adding === 'services' ? (
              <Field label="服务类型">
                <select
                  name="serviceType"
                  defaultValue={(editingResource as Service | undefined)?.serviceType ?? 'API'}
                >
                  <option value="WEB">Web</option>
                  <option value="API">API</option>
                  <option value="WORKER">Worker</option>
                  <option value="SCHEDULED_JOB">定时任务</option>
                  <option value="STATIC_SITE">静态站点</option>
                  <option value="DOCKER_SERVICE">Docker 服务</option>
                  <option value="CUSTOM">自定义</option>
                </select>
              </Field>
            ) : (
              <>
                <Field label="环境类型">
                  <select
                    name="environmentType"
                    defaultValue={
                      (editingResource as Environment | undefined)?.environmentType ?? 'DEVELOPMENT'
                    }
                  >
                    <option value="DEVELOPMENT">开发环境</option>
                    <option value="TESTING">测试环境</option>
                    <option value="STAGING">预发布环境</option>
                    <option value="PRODUCTION">生产环境</option>
                    <option value="CUSTOM">自定义</option>
                  </select>
                </Field>
              </>
            )}
          </>
        )}
        <Field label="说明">
          <textarea
            name="description"
            defaultValue={editingResource?.description}
            maxLength={2000}
            rows={2}
          />
        </Field>
      </Form>
    </InlineEditor>
  );
}
