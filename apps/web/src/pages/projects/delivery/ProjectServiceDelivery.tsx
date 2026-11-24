import { formatTime, useResource } from '../../../api';
import { ErrorBanner, Loading, Section, Status } from '../../../components';
import { deliveryPath, deliveryTaskPath } from '../../delivery/delivery-route';
import { graphWorkbenchPath } from '../../execution-graph/graph-workbench-context';
import { serverResourceHref } from '../../infrastructure/server-resource-route';
import { projectResourcePath } from '../project-workspace-route';
import './project-service-delivery.css';

interface Release {
  id: string;
  deploymentRecordId: string | null;
  status: string;
  phase: 'PREPARE' | 'RELEASE';
  errorSummary: string | null;
  healthStatus: string | null;
  healthObservedAt: number | null;
  activatedAt: number | null;
  startedAt: number;
  finishedAt: number | null;
  releaseVersion?: string | null;
  commitSha?: string | null;
  releaseTaskId?: string | null;
  releaseRunId?: string | null;
  releaseNodeId?: string | null;
  buildRunId?: string | null;
  buildTaskId?: string | null;
  artifactId?: string | null;
  artifactInstanceId?: string | null;
  artifactName?: string | null;
  environmentName?: string | null;
  sources: {
    repositoryId: string;
    repositoryName: string | null;
    commitSha: string;
    ref: string | null;
  }[];
}

interface Target {
  serverId: string;
  serverName: string | null;
  environmentId: string;
  scopeKey: string;
  method?: 'FILE' | 'COMPOSE';
  location?: string;
  current: Release | null;
  latestAttempt: Release;
}

function ReleaseEvidence({
  projectId,
  serviceId,
  label,
  release,
  serverId,
  attempt = false,
}: {
  projectId: string;
  serviceId: string;
  label: string;
  release: Release | null;
  serverId: string;
  attempt?: boolean;
}) {
  if (!release)
    return (
      <section className="service-release-evidence">
        <h4>{label}</h4>
        <p className="mini-empty">暂无已激活记录</p>
      </section>
    );
  const scope = { serviceId, recordId: release.deploymentRecordId ?? undefined };
  const graphLink = (run: string, node?: string | null) =>
    '#' +
    graphWorkbenchPath(projectId, {
      run,
      node: node ?? undefined,
      deliveryTab: 'deployments',
      ...scope,
    });
  const checked =
    release.healthStatus && !['NOT_CHECKED', 'PENDING'].includes(release.healthStatus);
  return (
    <section className="service-release-evidence">
      <div className="heading-actions">
        <h4>{label}</h4>
        <Status value={release.status} />
      </div>
      <dl className="graph-field-values">
        <div>
          <dt>{attempt || !release.activatedAt ? '开始时间' : '激活时间'}</dt>
          <dd>
            {formatTime(attempt ? release.startedAt : (release.activatedAt ?? release.startedAt))}
          </dd>
        </div>
        {attempt && release.finishedAt != null && (
          <div>
            <dt>结束时间</dt>
            <dd>{formatTime(release.finishedAt)}</dd>
          </div>
        )}
        {attempt && (release.phase === 'PREPARE' || release.errorSummary) && (
          <div>
            <dt>{release.phase === 'PREPARE' ? '准备阶段' : '发布结果'}</dt>
            <dd>
              {release.errorSummary ||
                (release.status === 'RUNNING' ? '正在准备目标及产物' : '准备阶段已结束')}
            </dd>
          </div>
        )}
        {release.deploymentRecordId && (
          <div>
            <dt>健康检查</dt>
            <dd>
              {checked ? (
                <Status
                  value={
                    release.healthStatus === 'UNKNOWN'
                      ? 'NEEDS_ATTENTION'
                      : (release.healthStatus ?? 'UNKNOWN')
                  }
                />
              ) : (
                '未检测'
              )}
              {checked && (
                <small>
                  {release.healthObservedAt
                    ? formatTime(release.healthObservedAt)
                    : '历史记录未提供检查时间'}
                </small>
              )}
            </dd>
          </div>
        )}
        {release.releaseVersion && (
          <div>
            <dt>发布版本</dt>
            <dd>
              <code>{release.releaseVersion}</code>
            </dd>
          </div>
        )}
        {release.artifactId && (
          <div>
            <dt>产物</dt>
            <dd>
              <a
                className="text-link"
                href={
                  '#' +
                  deliveryPath(projectId, 'artifacts', {
                    serviceId,
                    recordId: release.artifactId,
                  })
                }
              >
                {release.artifactName || '查看产物'}
              </a>
              <small>
                <code>{release.artifactId}</code>
              </small>
              {release.artifactInstanceId && release.artifactInstanceId !== release.artifactId && (
                <small>
                  实例 <code>{release.artifactInstanceId}</code>
                </small>
              )}
            </dd>
          </div>
        )}
        {(release.sources.length > 0 || release.commitSha) && (
          <div>
            <dt>实际源码</dt>
            <dd>
              {release.sources.length ? (
                <ul className="service-release-sources">
                  {release.sources.map((source, index) => (
                    <li key={`${source.repositoryId}:${source.commitSha}:${index}`}>
                      <a
                        className="text-link"
                        href={
                          '#' +
                          projectResourcePath(projectId, {
                            resource: 'repositories',
                            repositoryId: source.repositoryId,
                          })
                        }
                      >
                        {source.repositoryName ?? source.repositoryId}
                      </a>
                      {source.ref && <small>{source.ref}</small>}
                      <code>{source.commitSha}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <code>{release.commitSha}</code>
              )}
            </dd>
          </div>
        )}
      </dl>
      <div className="row-actions">
        {release.deploymentRecordId && (
          <a className="text-link" href={'#' + deliveryPath(projectId, 'deployments', scope)}>
            发布详情
          </a>
        )}
        {release.releaseRunId && (
          <a className="text-link" href={graphLink(release.releaseRunId, release.releaseNodeId)}>
            发布运行
          </a>
        )}
        {release.buildTaskId ? (
          <a
            className="text-link"
            href={'#' + deliveryTaskPath(release.buildTaskId, 'deployments', scope)}
          >
            构建日志
          </a>
        ) : (
          release.buildRunId && (
            <a className="text-link" href={graphLink(release.buildRunId)}>
              来源构建
            </a>
          )
        )}
        {release.releaseTaskId && (
          <a
            className="text-link"
            href={
              '#' + deliveryTaskPath(release.releaseTaskId, 'deployments', { ...scope, serverId })
            }
          >
            发布日志
          </a>
        )}
      </div>
    </section>
  );
}

export function ProjectServiceDelivery({
  projectId,
  serviceId,
}: {
  projectId: string;
  serviceId: string;
}) {
  const resource = useResource<Target[]>(
    `/projects/${projectId}/services/${serviceId}/delivery-status`,
    5000,
  );
  return (
    <Section
      title="服务发布状态"
      action={
        <a className="text-link" href={'#' + deliveryPath(projectId, 'deployments', { serviceId })}>
          查看部署历史 →
        </a>
      }
    >
      <ErrorBanner error={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : resource.data?.length ? (
        <div className="service-release-targets">
          {resource.data.map((target) => (
            <details
              key={`${target.serverId}:${target.scopeKey}`}
              open={resource.data?.length === 1}
            >
              <summary>
                <span>
                  {target.serverName ?? target.serverId}
                  {target.latestAttempt.environmentName
                    ? ` · ${target.latestAttempt.environmentName}`
                    : ''}
                </span>
                <span>
                  最近发布 <Status value={target.latestAttempt.status} />
                </span>
              </summary>
              <div className="service-release-target">
                <a
                  className="text-link"
                  href={serverResourceHref({ serverId: target.serverId, projectId })}
                >
                  查看服务器
                </a>
                {target.location && (
                  <div className="field-note">
                    {target.method === 'COMPOSE' ? 'Compose 项目' : '部署路径'} ·{' '}
                    <code>{target.location}</code>
                  </div>
                )}
                <div className="service-release-grid">
                  <ReleaseEvidence
                    projectId={projectId}
                    serviceId={serviceId}
                    label="当前已激活版本"
                    release={target.current}
                    serverId={target.serverId}
                  />
                  {target.current?.deploymentRecordId === target.latestAttempt.deploymentRecordId &&
                  target.current?.status === target.latestAttempt.status &&
                  !target.latestAttempt.errorSummary ? (
                    <section className="service-release-evidence">
                      <h4>最近发布尝试</h4>
                      <p>
                        本次发布已激活 ·{' '}
                        {formatTime(
                          target.latestAttempt.finishedAt ?? target.latestAttempt.startedAt,
                        )}
                      </p>
                    </section>
                  ) : (
                    <ReleaseEvidence
                      projectId={projectId}
                      serviceId={serviceId}
                      label="最近发布尝试"
                      release={target.latestAttempt}
                      serverId={target.serverId}
                      attempt
                    />
                  )}
                </div>
              </div>
            </details>
          ))}
        </div>
      ) : (
        !resource.error && <p className="mini-empty">暂无发布记录</p>
      )}
    </Section>
  );
}
