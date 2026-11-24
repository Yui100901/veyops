import { useState } from 'react';
import { Box, FolderGit2, Pencil, Plus, Trash2 } from 'lucide-react';
import { formatTime, message, navigate, remove, useResource } from '../../api';
import { Confirm, ErrorBanner, Loading, Section, Status } from '../../components';
import type { DeploymentSummary, ProjectDetail, Repository, Service, User } from '../../models';
import { RepositoryBinding } from './repositories/RepositoryBinding';
import { ExecutionGraphStartList } from '../execution-graph/run/ExecutionGraphStartStatus';
import { ProjectEnvironment } from './environments/ProjectEnvironment';
import { ProjectEnvironmentSets } from './environments/ProjectEnvironmentSets';
import { ProjectAccessLinks } from './ProjectAccessLinks';
import { ProjectRepositoryEditor } from './repositories/ProjectRepositoryEditor';
import { ProjectServiceEditor } from './ProjectServiceEditor';
import { RepositoryDetails } from './repositories/RepositoryBrowser';
import { repositoryBranchLabel } from './repositories/RepositoryBranches';
import { DeploymentHistory } from '../infrastructure/ServerResources';
import { deliveryPath } from '../delivery/delivery-route';
import type { GraphDocument, GraphRun } from '../execution-graph/execution-graph-definition';
import { graphResourcePanel, graphStartHref } from '../execution-graph/graph-workbench-context';
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

const resourceKinds = ['services', 'repositories'] as const;
const icons = { repositories: FolderGit2, services: Box };
type EditableKind = (typeof resourceKinds)[number];
type Resource = Repository | Service;
type Props = { project: ProjectDetail; user: User; reload: () => Promise<void> };

function editable(kind: ResourceKind): kind is EditableKind {
  return kind === 'repositories' || kind === 'services';
}

function detail(kind: EditableKind, id: string, view?: string, viewSearch?: string): Location {
  if (kind === 'repositories') return { resource: kind, repositoryId: id, view, viewSearch };
  return { resource: kind, serviceId: id, view, viewSearch };
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
    viewSearch,
    resource,
    serviceId,
    environmentId,
    repositoryId,
    environmentSetId,
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
    (resource === 'services' && serviceId && !service) ||
    (resource === 'environments' && environmentId && !environment) ||
    (resource === 'repositories' && repositoryId && !repository);
  const selected = Boolean(service || (resource === 'environments' && environment) || repository);
  const addingRepository =
    canEdit && resource === 'repositories' && !repositoryId && panel === 'new';
  const editor =
    editing ?? (addingRepository ? { kind: 'repositories' as const, item: undefined } : undefined);
  const cardRuns = useResource<Record<string, GraphRun>>(
    !selected && !editor && (!resource || resource === 'services') && project.services.length
      ? `/projects/${id}/recent-service-graph-runs`
      : null,
  );
  const resourceHref = (kind?: ResourceKind) =>
    '#' + projectResourcePath(id, { ...graphBack, view, viewSearch, resource: kind });
  async function archive() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/projects/${id}/${deleting.kind}/${deleting.item.id}`);
      const archivedDetail = [service?.id, repository?.id].includes(deleting.item.id);
      if (archivedDetail)
        navigate(
          projectResourcePath(id, { ...graphBack, view, viewSearch, resource: deleting.kind }),
        );
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
      {!resource && (
        <ProjectResourceSummary project={project} view={view} viewSearch={viewSearch} />
      )}
      {graphPane && (
        <a className="back-link" href={graphResourceReturnHref(id, graphBack, view, viewSearch)}>
          {graphPane === 'run' && graphStart ? '← 返回运行参数' : '← 返回执行图'}
        </a>
      )}
      <nav className="resource-section-switcher" aria-label="项目资源分类">
        <a href={resourceHref()} aria-current={!resource ? 'page' : undefined}>
          全部资源
        </a>
        {(Object.keys(projectResources) as (keyof typeof projectResources)[]).map((kind) => (
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
        editor.kind === 'services' ? (
          <ProjectServiceEditor
            key={editor.item?.id ?? 'new-service'}
            projectId={id}
            service={editor.item as Service | undefined}
            onClose={() => setEditor(undefined)}
            onSaved={async (item) => {
              setEditor(undefined);
              await reload();
              if (!editor.item)
                navigate(
                  projectResourcePath(id, {
                    ...detail('services', item.id, view, viewSearch),
                    ...graphBack,
                  }),
                );
            }}
          />
        ) : (
          <ProjectRepositoryEditor
            key={editor.item?.id ?? editor.kind}
            projectId={id}
            role={user.role}
            repository={editor.item as Repository | undefined}
            onClose={() => {
              setEditor(undefined);
              if (addingRepository)
                navigate(projectResourcePath(id, { ...graphBack, view, viewSearch, resource }));
            }}
            onSaved={async (item) => {
              setEditor(undefined);
              await reload();
              if (!editor.item)
                navigate(
                  projectResourcePath(id, {
                    ...detail(editor.kind, item.id, view, viewSearch),
                    ...graphBack,
                  }),
                );
            }}
          />
        )
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
                      {kind === 'services' && (
                        <ErrorBanner error={cardRuns.error} retry={cardRuns.reload} />
                      )}
                      {project[kind].length ? (
                        <div className="resource-list">
                          {project[kind].map((item) => {
                            const latest =
                              kind === 'services' ? cardRuns.data?.[item.id] : undefined;
                            return (
                              <div
                                key={item.id}
                                className={kind === 'services' ? 'project-service-card' : undefined}
                              >
                                <span className="resource-avatar">
                                  <Icon size={17} />
                                </span>
                                <div>
                                  <a
                                    className="text-link"
                                    href={
                                      '#' +
                                      projectResourcePath(id, {
                                        ...detail(kind, item.id, view, viewSearch),
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
                                    : item.serviceType}
                                </span>
                                {itemActions(kind, item)}
                                {'serviceType' in item && (
                                  <div className="project-service-card-addresses">
                                    <ProjectAccessLinks
                                      addresses={item.addresses ?? []}
                                      showEmpty
                                    />
                                    {latest && (
                                      <div className="heading-actions">
                                        <a
                                          className="button secondary small"
                                          href={
                                            '#' +
                                            projectGraphPath(id, {
                                              serviceId: item.id,
                                              view,
                                              viewSearch,
                                              pane: 'history',
                                              run: latest.id,
                                            })
                                          }
                                        >
                                          最近运行 · {latest.flowName}
                                        </a>
                                        <Status value={latest.status} />
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
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
              service={service}
              view={view}
              viewSearch={viewSearch}
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
              viewSearch={viewSearch}
              graphBack={graphBack}
            />
          )}
          {resource === 'environments' && !environment && (
            <Section title="历史环境" subtitle="项目环境配置保留供历史记录查阅。">
              {project.environments.length ? (
                <ul>
                  {project.environments.map((entry) => (
                    <li key={entry.id}>
                      <a
                        className="text-link"
                        href={
                          '#' +
                          projectResourcePath(id, {
                            ...graphBack,
                            view,
                            viewSearch,
                            resource,
                            environmentId: entry.id,
                          })
                        }
                      >
                        {entry.name}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">没有历史环境记录。</p>
              )}
              <a className="button secondary small" href={resourceHref('environment-sets')}>
                查看变量集合
              </a>
            </Section>
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
                navigate(
                  projectResourcePath(id, {
                    ...graphBack,
                    view,
                    viewSearch,
                    resource: 'repositories',
                  }),
                )
              }
              actions={itemActions('repositories', repository)}
            />
          )}
          {resource === 'environment-sets' && (
            <ProjectEnvironmentSets
              projectId={id}
              projectArchived={project.archived}
              user={user}
              environmentSetId={environmentSetId}
              view={view}
              viewSearch={viewSearch}
            />
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

function ProjectResourceSummary({
  project,
  view,
  viewSearch,
}: {
  project: ProjectDetail;
  view?: string;
  viewSearch?: string;
}) {
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
          href={'#' + projectResourcePath(project.id, { resource: kind, view, viewSearch })}
        >
          {projectResources[kind]} <strong>{project[kind].length}</strong>
        </a>
      ))}
      <a
        className="text-link"
        href={
          '#' + projectResourcePath(project.id, { resource: 'environment-sets', view, viewSearch })
        }
      >
        变量集合 <strong>{project.environmentSetCount ?? 0}</strong>
      </a>
      <a
        className="text-link"
        href={
          '#' + projectGraphPath(project.id, { view, viewSearch, pane: 'history', run: latest?.id })
        }
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
  service,
  view,
  viewSearch,
  panel,
  actions,
  graphBack,
}: Pick<Props, 'project' | 'user'> & {
  service: Service;
  view?: string;
  viewSearch?: string;
  panel?: string;
  actions: React.ReactNode;
  graphBack: GraphResourceReturn;
}) {
  const { id } = project;
  const serviceId = service.id;
  const scope: ProjectScope = { serviceId, view, viewSearch };
  const graphScope = { ...scope, resourcePanel: graphResourcePanel(panel) };
  const path = (subpanel?: string) =>
    projectResourcePath(id, {
      ...graphBack,
      view,
      viewSearch,
      resource: 'services',
      serviceId,
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
    `/projects/${id}/services/${serviceId}/recent-deployments`,
  );
  const recentRuns = useResource<GraphRun[]>(
    `/projects/${id}/services/${serviceId}/recent-graph-runs`,
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
        <div className="project-service-detail-addresses">
          <ProjectAccessLinks addresses={service.addresses ?? []} showEmpty />
        </div>
        <div className="row-actions">
          <a className="button secondary small" href={'#' + deliveryPath(id, 'artifacts', scope)}>
            查看服务产物
          </a>
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
      {panel === 'repositories' && user.role !== 'VIEWER' && !project.archived ? (
        <RepositoryBinding
          project={project}
          serviceId={serviceId}
          onClose={() => navigate(path())}
        />
      ) : (
        <Section
          title="关联仓库"
          action={
            user.role !== 'VIEWER' &&
            !project.archived && (
              <a className="button secondary small" href={'#' + path('repositories')}>
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
                    '#' +
                    projectResourcePath(
                      id,
                      detail('repositories', link.repositoryId, view, viewSearch),
                    )
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
        title="最近执行流运行"
        action={
          <a className="text-link" href={'#' + projectGraphPath(id, { ...scope, pane: 'history' })}>
            查看项目运行记录 →
          </a>
        }
      >
        <ErrorBanner error={recentRuns.error} retry={recentRuns.reload} />
        {recentRuns.loading ? (
          <Loading />
        ) : recentRuns.data?.length ? (
          <ul className="graph-edge-list">
            {recentRuns.data.map((run) => (
              <li key={run.id}>
                <div className="heading-actions">
                  <a
                    className="text-link"
                    href={'#' + projectGraphPath(id, { ...scope, pane: 'history', run: run.id })}
                  >
                    {run.flowName}
                  </a>
                  <Status value={run.status} />
                  <small>
                    v{run.version} · {formatTime(run.createdAt)}
                  </small>
                </div>
              </li>
            ))}
          </ul>
        ) : !recentRuns.error ? (
          <p className="mini-empty">这个服务还没有执行流运行记录。</p>
        ) : null}
      </Section>
      <Section
        title="最近发布"
        action={
          <a className="text-link" href={'#' + deliveryPath(id, 'deployments', scope)}>
            查看部署历史 →
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
