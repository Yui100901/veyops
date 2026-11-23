import { useState } from 'react';
import { formatTime, message, post } from '../api';
import { ErrorBanner, Status } from '../components';
import { deliveryPath, type DeliveryScope, type DeliveryTab } from './delivery-route';
import { projectResourcePath } from './project-workspace-route';
import { serverResourceHref } from './server-resource-route';

export type ReviewScope =
  | {
      kind: 'SOURCE_REVIEW';
      sources: { repositoryId: string; commitSha: string }[];
      artifactIds: string[];
      buildNodeId?: string;
    }
  | {
      kind: 'RELEASE';
      releaseNodeId: string;
      serviceId: string;
      serverIds: string[];
      artifactIds: string[];
      rollbackBaseline?: Record<string, string>;
    };

type ReleaseTarget = {
  serverId: string;
  deploymentId?: string;
  rollbackOfDeploymentId?: string;
  artifactInstanceId?: string;
  plannedArtifactInstanceId?: string;
  status: string;
  health?: string;
  reason?: string;
  errorSummary?: string;
  healthReason?: string;
  consumedArtifacts?: { artifactId?: string; instanceId?: string; temporaryArtifactId?: string }[];
};

export type ReleaseContext = {
  projectId: string;
  deliveryScope: DeliveryScope;
  returnPath: string;
  nodeHref: (id: string) => string;
  nodeName: (id: string) => string | undefined;
  repositoryName: (id: string) => string | undefined;
  serviceName: (id: string) => string | undefined;
};

export type ReleaseInspection = {
  status: 'CURRENT' | 'PREVIOUS' | 'NO_ACTIVE_RELEASE' | 'UNKNOWN';
  checkedAt: number;
  serverId: string;
  releaseId?: string;
  previousReleaseId?: string;
  activeReleaseId?: string;
  currentPath?: string;
  reason?: string;
  locksPresent?: boolean;
  canReplan?: boolean;
};

const inspectionLabels: Record<ReleaseInspection['status'], string> = {
  CURRENT: '当前发布链接匹配本次记录',
  PREVIOUS: '当前发布链接指向上一版本',
  NO_ACTIVE_RELEASE: '未发现活动发布链接',
  UNKNOWN: '实际发布状态仍待核查',
};

const healthLabels: Record<string, string> = {
  HEALTHY: '检查通过',
  UNHEALTHY: '检查失败',
  UNKNOWN: '检查结果未知',
  NOT_CHECKED: '尚未检查',
};

function recordHref(
  { projectId, deliveryScope }: ReleaseContext,
  tab: DeliveryTab,
  recordId: string,
) {
  return (
    '#' +
    deliveryPath(projectId, tab, {
      view: deliveryScope.view,
      viewSearch: deliveryScope.viewSearch,
      recordId,
    })
  );
}

function ArtifactLink({ id, context }: { id: string; context: ReleaseContext }) {
  return (
    <a className="text-link" href={recordHref(context, 'artifacts', id)}>
      产物 <code>{id.slice(0, 12)}</code>
    </a>
  );
}

export function ExecutionGraphReviewScope({
  review,
  context,
}: {
  review: ReviewScope;
  context: ReleaseContext;
}) {
  const { projectId, deliveryScope, returnPath, nodeHref, nodeName, repositoryName, serviceName } =
    context;
  return (
    <dl className="graph-field-values">
      {review.kind === 'SOURCE_REVIEW' ? (
        <>
          {review.buildNodeId && (
            <div>
              <dt>审核关联的构建节点</dt>
              <dd>
                <a className="text-link" href={nodeHref(review.buildNodeId)}>
                  {nodeName(review.buildNodeId) ?? review.buildNodeId}
                </a>
              </dd>
            </div>
          )}
          <div>
            <dt>审核提交</dt>
            <dd>
              <ul className="execution-plan-list">
                {review.sources.map(({ repositoryId, commitSha }) => (
                  <li key={repositoryId + ':' + commitSha}>
                    <a
                      className="text-link"
                      href={
                        '#' +
                        projectResourcePath(projectId, {
                          resource: 'repositories',
                          repositoryId,
                          view: deliveryScope.view ?? undefined,
                          viewSearch: deliveryScope.viewSearch ?? undefined,
                        })
                      }
                    >
                      {repositoryName(repositoryId) ?? `仓库 ${repositoryId.slice(0, 12)}`}
                    </a>{' '}
                    <code>{commitSha}</code>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        </>
      ) : (
        <>
          <div>
            <dt>发布节点</dt>
            <dd>
              <a className="text-link" href={nodeHref(review.releaseNodeId)}>
                {nodeName(review.releaseNodeId) ?? review.releaseNodeId}
              </a>
            </dd>
          </div>
          <div>
            <dt>服务</dt>
            <dd>
              <a
                className="text-link"
                href={
                  '#' +
                  projectResourcePath(projectId, {
                    resource: 'services',
                    serviceId: review.serviceId,
                    view: deliveryScope.view ?? undefined,
                    viewSearch: deliveryScope.viewSearch ?? undefined,
                  })
                }
              >
                {serviceName(review.serviceId) ?? `服务 ${review.serviceId.slice(0, 12)}`}
              </a>
            </dd>
          </div>
          <div>
            <dt>目标服务器</dt>
            <dd className="heading-actions">
              {review.serverIds.map((serverId) => (
                <a
                  key={serverId}
                  className="text-link"
                  href={serverResourceHref({ serverId, projectId, returnPath })}
                >
                  {serverId}
                </a>
              ))}
            </dd>
          </div>
          {review.rollbackBaseline && Object.keys(review.rollbackBaseline).length > 0 && (
            <div>
              <dt>回滚基线</dt>
              <dd className="heading-actions">
                {Object.entries(review.rollbackBaseline).map(([serverId, recordId]) => (
                  <a
                    key={serverId}
                    className="text-link"
                    href={recordHref(context, 'deployments', recordId)}
                  >
                    部署 {recordId.slice(0, 12)}
                  </a>
                ))}
              </dd>
            </div>
          )}
        </>
      )}
      {!!review.artifactIds.length && (
        <div>
          <dt>已确定的产物</dt>
          <dd className="heading-actions">
            {review.artifactIds.map((id) => (
              <ArtifactLink key={id} id={id} context={context} />
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}

function isReleaseTarget(value: unknown): value is ReleaseTarget {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'serverId' in value &&
    typeof value.serverId === 'string' &&
    'status' in value &&
    typeof value.status === 'string',
  );
}

function releaseTargets(value: unknown) {
  return value && typeof value === 'object' && 'targets' in value && Array.isArray(value.targets)
    ? value.targets.filter(isReleaseTarget)
    : undefined;
}

export function releaseTargetHealthUnknown(value: unknown, serverId: string) {
  return releaseTargets(value)?.some(
    (target) => target.serverId === serverId && target.health === 'UNKNOWN',
  );
}

export function ExecutionGraphReleaseInspection({
  context,
  path,
  latest,
  canInspect,
  replanHref,
  onChange,
}: {
  context: ReleaseContext;
  path: string;
  latest?: ReleaseInspection;
  canInspect: boolean;
  replanHref?: string;
  onChange: () => void;
}) {
  const [result, setResult] = useState<ReleaseInspection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inspection = result && result.checkedAt >= (latest?.checkedAt ?? 0) ? result : latest;

  async function inspect() {
    if (!canInspect || busy) return;
    setError('');
    setBusy(true);
    try {
      setResult(await post<ReleaseInspection>(path));
      onChange();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const linkedReleases = inspection
    ? [
        ['本次关联发布', inspection.releaseId],
        ['上一版本', inspection.previousReleaseId],
      ]
    : [];
  return (
    <div className="graph-release-inspection">
      <div className="heading-actions">
        {canInspect && (
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void inspect()}
          >
            {busy ? '正在核查…' : inspection ? '再次核查发布' : '只读核查发布'}
          </button>
        )}
        {inspection?.canReplan && replanHref && (
          <a className="button secondary small" href={replanHref}>
            打开原版本重新预览
          </a>
        )}
      </div>
      <ErrorBanner error={error} />
      <div aria-live="polite" aria-atomic="true">
        {inspection ? (
          <dl className="graph-field-values">
            <div>
              <dt>最近一次只读核查</dt>
              <dd>{formatTime(inspection.checkedAt)}</dd>
            </div>
            <div>
              <dt>核查结果</dt>
              <dd>
                <strong>{inspectionLabels[inspection.status]}</strong>
                {inspection.reason && <small>{inspection.reason}</small>}
              </dd>
            </div>
            {inspection.locksPresent !== undefined && (
              <div>
                <dt>发布锁</dt>
                <dd>{inspection.locksPresent ? '检测到发布锁' : '本次核查未检测到发布锁'}</dd>
              </div>
            )}
            {inspection.currentPath && (
              <div>
                <dt>核查路径</dt>
                <dd>
                  <code>{inspection.currentPath}</code>
                </dd>
              </div>
            )}
            {linkedReleases.map(
              ([label, id]) =>
                id && (
                  <div key={label}>
                    <dt>
                      {label}
                      {id === inspection.activeReleaseId && ' · 本次核查的活动版本'}
                    </dt>
                    <dd>
                      <a className="text-link" href={recordHref(context, 'deployments', id)}>
                        <code>{id.slice(0, 12)}</code>
                      </a>
                    </dd>
                  </div>
                ),
            )}
          </dl>
        ) : (
          <p className="field-note">待核查此目标的活动发布。</p>
        )}
      </div>
      {canInspect && (
        <p className="field-note">
          核查读取目标的发布状态和发布锁。应用健康见对应检查节点。再次运行需重新预览并确认。
        </p>
      )}
    </div>
  );
}

export function ExecutionGraphReleaseResults({
  value,
  type,
  context,
  serverName,
}: {
  value: unknown;
  type: string;
  context: ReleaseContext;
  serverName: (id: string) => string | undefined;
}) {
  const targets = releaseTargets(value);
  if (!targets || !value || typeof value !== 'object') return null;
  const { projectId, returnPath } = context;
  return (
    <details className="graph-field-card" open>
      <summary>
        {type === 'HEALTH_CHECK'
          ? '健康检查结果'
          : type === 'ROLLBACK_ARTIFACT'
            ? '回滚结果'
            : '发布结果'}{' '}
        · {targets.length} 台服务器
      </summary>
      {'healthStatus' in value && typeof value.healthStatus === 'string' ? (
        <strong>{healthLabels[value.healthStatus] ?? value.healthStatus}</strong>
      ) : 'status' in value && typeof value.status === 'string' ? (
        <Status value={value.status} />
      ) : null}
      <ul className="graph-edge-list">
        {targets.map((target) => (
          <li key={target.serverId}>
            <div className="heading-actions">
              <a
                className="text-link"
                href={serverResourceHref({ serverId: target.serverId, projectId, returnPath })}
              >
                {serverName(target.serverId) ?? target.serverId}
              </a>
              <Status value={target.status} />
              {target.health &&
                (target.health === 'UNKNOWN' ? (
                  <small>{healthLabels.UNKNOWN}</small>
                ) : (
                  <Status value={target.health} />
                ))}
              {target.deploymentId && (
                <a
                  className="text-link"
                  href={recordHref(context, 'deployments', target.deploymentId)}
                >
                  部署记录
                </a>
              )}
              {target.rollbackOfDeploymentId && (
                <a
                  className="text-link"
                  href={recordHref(context, 'deployments', target.rollbackOfDeploymentId)}
                >
                  被回滚的部署
                </a>
              )}
              {(target.consumedArtifacts?.length
                ? target.consumedArtifacts
                : [{ instanceId: target.artifactInstanceId }]
              ).map((ref, index) => {
                const id = ref.instanceId ?? ref.artifactId ?? ref.temporaryArtifactId;
                return id && <ArtifactLink key={id + ':' + index} id={id} context={context} />;
              })}
              {!target.artifactInstanceId && target.plannedArtifactInstanceId && (
                <a
                  className="text-link"
                  href={recordHref(context, 'artifacts', target.plannedArtifactInstanceId)}
                >
                  计划产物 <code>{target.plannedArtifactInstanceId.slice(0, 12)}</code>
                </a>
              )}
            </div>
            {[
              ...new Set([target.errorSummary, target.healthReason, target.reason].filter(Boolean)),
            ].map((reason) => (
              <p className="field-note" key={reason}>
                {reason}
              </p>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}
