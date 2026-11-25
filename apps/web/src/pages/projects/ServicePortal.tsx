import { useState, type FormEvent } from 'react';
import { Search, X } from 'lucide-react';
import { formatTime, navigate, useResource } from '../../api';
import { portalFilterParams, workspaceOrigin } from '../../workspace-navigation';
import {
  Empty,
  ErrorBanner,
  Field,
  Loading,
  PageHeader,
  RefreshButton,
  Section,
} from '../../components';
import { ProjectAccessLinks, type ProjectAccessLink } from './ProjectAccessLinks';
import { projectResourcePath } from './project-workspace-route';
import './service-portal.css';

type PortalTarget = {
  current: string | null;
  health: string | null;
  healthObservedAt: number | null;
  lastAttempt: string;
  at: number | null;
};

interface PortalResult {
  projects: {
    id: string;
    name: string;
    tags: string[];
    services: {
      id: string;
      name: string;
      addresses: ProjectAccessLink[];
      targets: PortalTarget[];
    }[];
  }[];
  tags: string[];
}

const failed = new Set(['FAILED', 'PARTIAL_FAILED', 'TIMED_OUT']);

function DeliveryStatus({ targets }: { targets: PortalTarget[] }) {
  if (!targets.length) return <span>暂无发布记录</span>;
  const current = targets.filter(({ current }) => current != null);
  const uncertain = targets.filter(
    ({ current, health }) => current === 'NEEDS_ATTENTION' || health === 'UNKNOWN',
  );
  const unhealthy = current.filter(({ health }) => health === 'FAILED' || health === 'UNHEALTHY');
  const healthy = current.filter(({ health }) => health === 'HEALTHY');
  const unchecked = current.filter(
    ({ health }) => !health || ['PENDING', 'NOT_CHECKED'].includes(health),
  );
  const latestFailure = targets.filter(({ lastAttempt }) => failed.has(lastAttempt));
  const latestUncertain = targets.filter(({ lastAttempt }) => lastAttempt === 'NEEDS_ATTENTION');
  const running = targets.filter(({ lastAttempt }) => lastAttempt === 'RUNNING');
  const cancelled = targets.filter(({ lastAttempt }) => lastAttempt === 'CANCELLED');
  const checkedAt = Math.max(0, ...healthy.map(({ healthObservedAt }) => healthObservedAt ?? 0));
  const failedAt = Math.max(0, ...latestFailure.map(({ at }) => at ?? 0));
  return (
    <ul className="portal-delivery-summary">
      <li>{current.length ? `${current.length} 处已激活` : '暂无已激活版本'}</li>
      {healthy.length > 0 && (
        <li>
          {healthy.length} 处已健康{checkedAt > 0 && <> · {formatTime(checkedAt)}</>}
        </li>
      )}
      {unchecked.length > 0 && <li>{unchecked.length} 处未检测</li>}
      {unhealthy.length > 0 && <li>{unhealthy.length} 处健康检查失败</li>}
      {uncertain.length > 0 && <li>{uncertain.length} 处待核查</li>}
      {running.length > 0 && <li>{running.length} 次发布执行中</li>}
      {cancelled.length > 0 && <li>{cancelled.length} 次最近发布已取消</li>}
      {latestFailure.length > 0 && (
        <li>
          {latestFailure.length} 次最近发布失败{failedAt > 0 && <> · {formatTime(failedAt)}</>}
        </li>
      )}
      {latestUncertain.length > 0 && <li>{latestUncertain.length} 次最近发布待核查</li>}
    </ul>
  );
}

export function ServicePortal({ search }: { search?: string }) {
  const query = portalFilterParams(search);
  const [keyword, setKeyword] = useState(query.get('q') ?? '');
  const [tag, setTag] = useState(query.get('tag') ?? '');
  const [abnormal, setAbnormal] = useState(query.get('abnormal') === 'true');
  const resource = useResource<PortalResult>(`/portal${query.size ? '?' + query : ''}`);
  const source = workspaceOrigin('portal', query.toString());

  function applyFilters(onlyAbnormal: boolean) {
    const next = new URLSearchParams(query);
    next.set('q', keyword);
    next.set('tag', tag);
    next.set('abnormal', String(onlyAbnormal));
    const filters = portalFilterParams(next.toString());
    navigate(`/portal${filters.size ? '?' + filters : ''}`);
  }

  function searchServices(event: FormEvent) {
    event.preventDefault();
    applyFilters(abnormal);
  }

  return (
    <div className="workbench-stack">
      <PageHeader
        title="服务门户"
        description={
          query.has('serviceId') ? '仅显示所选服务' : query.has('projectId') ? '仅显示所选项目' : ''
        }
        action={<RefreshButton onClick={resource.reload} />}
      />
      <form className="panel workbench-filterbar portal-filters" onSubmit={searchServices}>
        <div className="portal-filter-keyword">
          <Field label="搜索服务">
            <input
              type="search"
              value={keyword}
              maxLength={160}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="项目、服务、地址名称或标签"
            />
          </Field>
        </div>
        <div className="workbench-actions portal-filter-actions">
          <button type="submit" className="button primary">
            <Search size={16} aria-hidden="true" /> 搜索
          </button>
          {!!query.size && (
            <a
              className="button secondary portal-clear-filters"
              href="#/portal"
              title="清除筛选"
              aria-label="清除筛选"
            >
              <X size={16} aria-hidden="true" />
              <span>清除筛选</span>
            </a>
          )}
        </div>
        <div className="portal-filter-tag">
          <Field label="项目标签">
            <select value={tag} onChange={(event) => setTag(event.target.value)}>
              <option value="">全部标签</option>
              {tag && !resource.data?.tags.includes(tag) && <option>{tag}</option>}
              {resource.data?.tags.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="portal-filter-abnormal">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={abnormal}
              onChange={(event) => {
                setAbnormal(event.target.checked);
                applyFilters(event.target.checked);
              }}
            />
            仅看异常
          </label>
        </div>
      </form>
      <ErrorBanner error={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : (
        !resource.error &&
        (resource.data?.projects.length ? (
          <div className="workbench-stack">
            {resource.data.projects.map((project) => (
              <Section
                key={project.id}
                title={project.name}
                body="regular"
                subtitle={project.tags.length ? project.tags.join(' · ') : undefined}
                action={
                  <a className="text-link" href={'#' + projectResourcePath(project.id, source)}>
                    查看项目
                  </a>
                }
              >
                {project.services.length ? (
                  <div className="portal-services">
                    {project.services.map((service) => (
                      <div className="portal-service" key={service.id}>
                        <div className="portal-service-header">
                          <h3>
                            <a
                              className="text-link"
                              href={
                                '#' +
                                projectResourcePath(project.id, {
                                  ...source,
                                  resource: 'services',
                                  serviceId: service.id,
                                })
                              }
                            >
                              {service.name}
                            </a>
                          </h3>
                          <DeliveryStatus targets={service.targets} />
                        </div>
                        <ProjectAccessLinks addresses={service.addresses} density="compact" showEmpty />
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mini-empty">暂无服务</p>
                )}
              </Section>
            ))}
          </div>
        ) : (
          <Empty
            title={query.size ? '没有找到匹配的服务' : '暂无项目和服务'}
            description={
              query.size ? '更换关键词或清除筛选。' : '项目中的服务和访问地址登记后会在这里显示。'
            }
          />
        ))
      )}
    </div>
  );
}
