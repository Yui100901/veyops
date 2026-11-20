import { useEffect } from 'react';
import type { FormEvent } from 'react';
import { navigate, useResource } from '../api';
import { ErrorBanner, Loading } from '../components';
import type { ProjectDetail, User } from '../models';
import { DeliveryRecordsPage } from './Delivery';
import { ReleaseApprovals } from './ReleaseOperations';
import { deliveryPath, deliveryTabs, type DeliveryScope, type DeliveryTab } from './delivery-route';

export function ProjectDelivery({
  id,
  tab,
  search,
  user,
}: {
  id: string;
  tab: DeliveryTab;
  search?: string;
  user: User;
}) {
  const resource = useResource<ProjectDetail>(
    `/projects/${encodeURIComponent(id)}/delivery-context`,
  );
  const params = new URLSearchParams(search);
  const serviceId = params.get('serviceId');
  const environmentId = params.get('environmentId');
  const commit = params.get('commit');
  const recordId = params.get('recordId');
  const pipelineRunId = params.get('pipelineRunId');
  const taskId = params.get('taskId');
  const repositoryId = params.get('repositoryId');
  if (resource.loading) return <Loading />;
  if (!resource.data)
    return <ErrorBanner error={resource.error || '找不到这个项目。'} retry={resource.reload} />;
  const project = resource.data;
  const canApprove = !project.archived && user.role === 'ADMIN';
  const service = project.services.find((s) => s.id === serviceId);
  if (
    (serviceId && !service) ||
    (environmentId && !project.environments.some((e) => e.id === environmentId)) ||
    (repositoryId && !project.repositories.some((r) => r.id === repositoryId))
  )
    return <ErrorBanner error="所选服务、环境或仓库不属于当前项目。" />;
  const filters: DeliveryScope = { serviceId, environmentId, commit };
  const query = new URLSearchParams();
  if (serviceId) query.set('serviceId', serviceId);
  if (environmentId) query.set('environmentId', environmentId);
  if (commit) query.set('commit', commit);
  query.set('projectId', id);
  if (recordId) query.set('recordId', recordId);
  if (pipelineRunId) query.set('pipelineRunId', pipelineRunId);
  if (taskId) query.set('taskId', taskId);
  const searchQuery = query.toString();
  const filter = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    navigate(
      deliveryPath(id, tab, {
        serviceId: String(values.get('serviceId') || ''),
        environmentId: String(values.get('environmentId') || ''),
        commit: String(values.get('commit') || '').trim(),
      }),
    );
  };
  return (
    <div className="project-workspace">
      <a className="back-link" href={project.archived ? '#/projects' : `#/projects/${id}`}>
        ← {project.archived ? '返回项目列表' : project.name}
      </a>
      <h1>{service ? service.name : project.name} · 项目交付</h1>
      {project.archived && (
        <p className="field-note">{project.name} 已归档，可查看历史交付记录。</p>
      )}
      <nav className="record-tabs" aria-label="项目交付">
        <a href={`#/projects/${id}/execution-graph`}>执行图</a>
        {(Object.keys(deliveryTabs) as DeliveryTab[])
          .filter((key) => key !== 'approvals' || canApprove)
          .map((key) => (
            <a
              key={key}
              className={key === tab ? 'active' : ''}
              aria-current={key === tab ? 'page' : undefined}
              href={'#' + deliveryPath(id, key, filters)}
            >
              {deliveryTabs[key]}
            </a>
          ))}
      </nav>
      <form className="delivery-filters" onSubmit={filter}>
        <label>
          服务
          <select name="serviceId" defaultValue={serviceId || ''}>
            <option value="">全部服务</option>
            {project.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
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
          <a className="text-link" href={'#' + deliveryPath(id, tab)}>
            清除筛选
          </a>
        )}
      </form>
      {(recordId || pipelineRunId || taskId) && (
        <p className="field-note">
          已定位{recordId ? '历史记录' : '执行'} ·{' '}
          <code>{recordId || pipelineRunId || taskId}</code>
        </p>
      )}
      {(tab === 'artifacts' || tab === 'deployments') && (
        <DeliveryRecordsPage type={tab} user={user} project={project} query={searchQuery} />
      )}
      {tab === 'approvals' &&
        (canApprove ? (
          <ReleaseApprovals query={searchQuery} />
        ) : (
          <ErrorBanner error="仅管理员可审批发布。" />
        ))}
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
    params.get(
      { artifacts: 'artifactId', deployments: 'deploymentId' }[tab],
    );
  const query = new URLSearchParams();
  if (recordId) query.set('recordId', recordId);
  const runId = params.get('pipelineRunId');
  if (runId) query.set('pipelineRunId', runId);
  const lookup = !projectId && query.size ? `/${tab}?${query}` : null;
  type Owner = { projectId: string; serviceId: string };
  const owner = useResource<Owner | Owner[]>(lookup);
  const value = Array.isArray(owner.data) ? owner.data[0] : owner.data;
  const destination = projectId || value?.projectId;
  const scope = {
    serviceId: params.get('serviceId') || value?.serviceId,
    environmentId: params.get('environmentId'),
    commit: params.get('commit'),
    repositoryId: params.get('repositoryId'),
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
