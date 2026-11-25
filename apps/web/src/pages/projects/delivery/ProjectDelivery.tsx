import '../../delivery/delivery-filters.css';
import { useEffect } from 'react';
import type { FormEvent } from 'react';
import { navigate, useResource } from '../../../api';
import { ErrorBanner, Loading, Section } from '../../../components';
import type { ProjectDetail, User } from '../../../models';
import { DeliveryRecordsPage } from '../../delivery/Delivery';
import { ProjectArtifacts } from './ProjectArtifacts';
import {
  deliveryPath,
  deliveryTabs,
  readDeliveryScope,
  type DeliveryScope,
  type DeliveryTab,
} from '../../delivery/delivery-route';
import { projectGraphPath, projectResourcePath } from '../project-workspace-route';

export function ProjectDelivery({
  id,
  tab,
  search,
  user,
  embedded = false,
  project: providedProject,
}: {
  id: string;
  tab: DeliveryTab;
  search?: string;
  user: User;
  embedded?: boolean;
  project?: ProjectDetail;
}) {
  const resource = useResource<ProjectDetail>(
    providedProject ? null : `/projects/${encodeURIComponent(id)}/delivery-context`,
  );
  const scope = readDeliveryScope(new URLSearchParams(search));
  const {
    serviceId,
    environmentId,
    commit,
    recordId,
    pipelineRunId,
    taskId,
    repositoryId,
    origin,
    originQuery,
  } = scope;
  if (!providedProject && resource.loading) return <Loading />;
  const project = providedProject ?? resource.data;
  if (!project)
    return <ErrorBanner error={resource.error || '找不到这个项目。'} retry={resource.reload} />;
  if (tab === 'artifacts') return <ProjectArtifacts project={project} user={user} scope={scope} />;
  const services = [...project.services, ...(project.archivedServices ?? [])];
  const environments = [...project.environments, ...(project.archivedEnvironments ?? [])];
  const service = services.find((s) => s.id === serviceId);
  if (
    (serviceId && !service) ||
    (environmentId && !environments.some((e) => e.id === environmentId)) ||
    (repositoryId &&
      !project.repositories.some((r) => r.id === repositoryId) &&
      !project.archivedRepositories?.includes(repositoryId))
  )
    return (
      <>
        <ErrorBanner error="所选服务、环境或仓库不属于当前项目。" />
        <a
          className="button secondary small"
          href={'#' + deliveryPath(id, tab, { origin, originQuery })}
        >
          返回项目交付记录
        </a>
      </>
    );
  const filters: DeliveryScope = {
    serviceId,
    environmentId,
    commit,
    repositoryId,
    origin,
    originQuery,
  };
  const historyHref =
    '#' +
    projectGraphPath(id, {
      serviceId: serviceId ?? undefined,
      environmentId: environmentId ?? undefined,
      origin: origin ?? undefined,
      originQuery: originQuery ?? undefined,
      pane: 'history',
    });
  if (tab === 'approvals') {
    return (
      <Section title="执行流审批">
        <p>在运行记录中打开等待中的源码审核或发布审批节点。</p>
        <a className="button primary small" href={historyHref}>
          查看执行流运行
        </a>
      </Section>
    );
  }
  const returnFilters = recordId ? { ...filters, pipelineRunId, taskId } : filters;
  const query = new URLSearchParams({ projectId: id });
  if (serviceId) query.set('serviceId', serviceId);
  if (environmentId) query.set('environmentId', environmentId);
  if (commit) query.set('commit', commit);
  if (repositoryId) query.set('repositoryId', repositoryId);
  if (recordId) query.set('recordId', recordId);
  if (pipelineRunId) query.set('pipelineRunId', pipelineRunId);
  if (taskId) query.set('taskId', taskId);
  const searchQuery = query.toString();
  const filter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    navigate(
      deliveryPath(id, tab, {
        origin,
        originQuery,
        serviceId: String(values.get('serviceId') || ''),
        environmentId: String(values.get('environmentId') || ''),
        commit: String(values.get('commit') || '').trim(),
        repositoryId: String(values.get('repositoryId') || ''),
      }),
    );
  };
  const activeService = serviceId && project.services.some((item) => item.id === serviceId);
  const activeEnvironment =
    !environmentId || project.environments.some((item) => item.id === environmentId);
  const hasLocator = Boolean(recordId || pipelineRunId || taskId);
  return (
    <div className={embedded ? 'project-delivery' : 'project-workspace'}>
      {!embedded && (
        <>
          <a className="back-link" href={project.archived ? '#/projects' : `#/projects/${id}`}>
            ← {project.archived ? '返回项目列表' : project.name}
          </a>
          <h1>{service ? service.name : project.name} · 交付记录</h1>
        </>
      )}
      {project.archived && (
        <p className="field-note">{project.name} 已归档，可查看历史交付记录。</p>
      )}
      {!project.archived && activeService && activeEnvironment && (
        <a
          className="back-link"
          href={
            '#' +
            projectResourcePath(id, {
              resource: 'services',
              serviceId,
              environmentId: environmentId || undefined,
              origin: origin || undefined,
              originQuery: originQuery || undefined,
            })
          }
        >
          ← 返回服务配置
        </a>
      )}
      {
        <nav className="record-tabs" aria-label="交付记录分类">
          {!project.archived && <a href={historyHref}>执行流运行</a>}
          {(['artifacts', 'deployments'] as const).map((key) => (
            <a
              key={key}
              className={key === tab ? 'active' : ''}
              aria-current={key === tab ? 'page' : undefined}
              href={'#' + deliveryPath(id, key, key === tab ? scope : filters)}
            >
              {deliveryTabs[key]}
            </a>
          ))}
        </nav>
      }
      <form
        className="delivery-filters"
        onSubmit={filter}
        key={[serviceId, environmentId, commit, repositoryId].join('|')}
      >
        <label>
          服务
          <select name="serviceId" defaultValue={serviceId || ''}>
            <option value="">全部服务</option>
            {project.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            {project.archivedServices?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（已归档）
              </option>
            ))}
          </select>
        </label>
        <label>
          环境
          <select name="environmentId" defaultValue={environmentId || ''}>
            <option value="">全部环境</option>
            {project.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
            {project.archivedEnvironments?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（已归档）
              </option>
            ))}
          </select>
        </label>
        <label>
          源码仓库
          <select name="repositoryId" defaultValue={repositoryId || ''}>
            <option value="">全部仓库</option>
            {project.repositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.name}
              </option>
            ))}
            {project.archivedRepositories?.map((repository) => (
              <option key={repository} value={repository}>
                {repository}（已归档）
              </option>
            ))}
          </select>
        </label>
        <label>
          固定 Commit
          <input
            name="commit"
            defaultValue={commit || ''}
            pattern="[a-fA-F0-9]{1,64}"
            placeholder="完整 SHA 或前缀"
          />
        </label>
        <button className="button secondary small" type="submit">
          应用筛选
        </button>
        {(serviceId ||
          environmentId ||
          commit ||
          recordId ||
          pipelineRunId ||
          taskId ||
          repositoryId) && (
          <a className="text-link" href={'#' + deliveryPath(id, tab, { origin, originQuery })}>
            清除筛选
          </a>
        )}
      </form>
      {hasLocator && (
        <div className="heading-actions">
          <a className="button secondary small" href={'#' + deliveryPath(id, tab, returnFilters)}>
            返回筛选结果
          </a>
          <span className="field-note">
            {recordId ? '历史记录' : '关联执行'} ·{' '}
            <code>{recordId || pipelineRunId || taskId}</code>
          </span>
        </div>
      )}
      {tab === 'deployments' && (
        <DeliveryRecordsPage
          key={tab + searchQuery}
          type={tab}
          user={user}
          project={project}
          query={searchQuery}
          scope={scope}
          readOnly
        />
      )}
    </div>
  );
}

/** Links with a record ID predate the project workspace. Resolve its owner before rendering actions. */
export function LegacyDeliveryLink({
  tab,
  search,
  id,
}: {
  tab: 'artifacts' | 'deployments';
  search?: string;
  id?: string;
}) {
  const params = new URLSearchParams(search);
  const projectId = params.get('projectId');
  const recordId =
    id ||
    params.get('recordId') ||
    params.get({ artifacts: 'artifactId', deployments: 'deploymentId' }[tab]);
  const query = new URLSearchParams();
  if (recordId) query.set('recordId', recordId);
  const runId = params.get('pipelineRunId');
  if (runId) query.set('pipelineRunId', runId);
  const taskId = params.get('taskId');
  if (taskId) query.set('taskId', taskId);
  const lookup = !projectId && query.size ? `/${tab}?${query}` : null;
  type Owner = { projectId: string; serviceId: string };
  const owner = useResource<Owner | Owner[]>(lookup);
  const value = Array.isArray(owner.data) ? owner.data[0] : owner.data;
  const destination = projectId || value?.projectId;
  const scope: DeliveryScope = {
    ...readDeliveryScope(params),
    serviceId: params.get('serviceId') || value?.serviceId,
    pipelineRunId: runId,
    recordId,
  };
  const path = destination && deliveryPath(destination, tab, scope);
  useEffect(() => {
    if (path) window.location.replace('#' + path);
  }, [path]);
  if (path || owner.loading) return <Loading />;
  return <ErrorBanner error={owner.error || '找不到这条历史交付记录。'} retry={owner.reload} />;
}
