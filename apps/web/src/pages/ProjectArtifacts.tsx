import { useEffect, useState, type FormEvent } from 'react';
import { ClipboardCheck, Trash2 } from 'lucide-react';
import { api, formatTime, message, navigate, post, useResource } from '../api';
import { Empty, ErrorBanner, Loading, RefreshButton, Section } from '../components';
import type { ProjectDetail, Server, User } from '../models';
import {
  ArtifactDownload,
  ArtifactOrigins,
  ArtifactStatus,
  artifactInstanceId,
  artifactKindLabel,
  artifactLogicalId,
  artifactVerificationLabels,
  type Artifact,
  type ArtifactRef,
} from './Delivery';
import { deliveryPath, type DeliveryScope } from './delivery-route';
import { ArtifactRetentionPolicy } from './ArtifactRetention';
import { graphKey } from './execution-graph-definition';
import { graphWorkbenchPath } from './graph-workbench-context';
import type { EnvironmentSetSummary } from './ProjectEnvironmentSets';
import { serverResourceHref } from './server-resource-route';
import './project-artifacts.css';

interface ArtifactDetail {
  artifactId: string;
  instances: Artifact[];
}

interface CleanupInstance {
  artifactId: string;
  instanceId: string;
  location?: string | { path?: string; kind?: string };
  path?: string | null;
  ownership?: 'MANAGED' | 'EXTERNAL';
  action?: 'REMOVE' | 'DETACH';
  eligible?: boolean;
  status: string;
  reason?: string;
}

interface CleanupPlan {
  planDigest: string;
  instances: CleanupInstance[];
  eligibleCount: number;
}

interface CleanupJob {
  id: string;
  status: string;
  instances: CleanupInstance[];
}

const cleanupLabels: Record<string, string> = {
  QUEUED: '待处理',
  PENDING: '待处理',
  RUNNING: '清理中',
  CLEANING: '清理中',
  DELETED: '已清理',
  RETAINED: '已保留',
  DETACHED: '已解除引用',
  SUCCESS: '已完成',
  COMPLETE: '已完成',
  FAILED: '清理失败',
  PARTIAL_FAILED: '部分失败',
  NEEDS_ATTENTION: '待核查',
  RETRY: '可重试',
  RETRYABLE: '可重试',
  ...artifactVerificationLabels,
};

function artifactPath(projectId: string, scope: DeliveryScope) {
  return deliveryPath(projectId, 'artifacts', scope);
}

function sourceHref(projectId: string, artifact: Artifact, scope: DeliveryScope) {
  if (!artifact.graphRunId) return undefined;
  return (
    '#' +
    graphWorkbenchPath(projectId, {
      run: artifact.graphRunId,
      node: artifact.graphNodeId ?? undefined,
      recordId: artifactLogicalId(artifact),
      deliveryTab: 'artifacts',
      view: scope.view ?? undefined,
      viewSearch: scope.viewSearch ?? undefined,
    })
  );
}

function artifactTitle(artifact: Artifact) {
  return artifact.name || artifactKindLabel(artifact.kind ?? artifact.artifactType);
}

function serviceName(project: ProjectDetail, id?: string | null) {
  if (!id) return '无关联服务';
  return (
    [...project.services, ...(project.archivedServices ?? [])].find((service) => service.id === id)
      ?.name ?? id
  );
}

function artifactLocation(artifact: Artifact, serverNames?: ReadonlyMap<string, string>) {
  const physical = artifact.physical;
  if (physical?.location === 'REGISTRY') return 'Registry';
  const serverId = artifact.serverId ?? physical?.serverId;
  return serverId ? artifact.serverName || serverNames?.get(serverId) || serverId : '管理端';
}

const filters = [
  'serviceId',
  'environmentSetId',
  'serverId',
  'kind',
  'verificationStatus',
  'ref',
  'repositoryId',
] as const;
const artifactPageSize = 100;

function SelectFilter({
  label,
  name,
  value,
  options,
}: {
  label: string;
  name: string;
  value?: string | null;
  options: { id: string; name: string }[];
}) {
  return (
    <label>
      {label}
      <select name={name} defaultValue={value ?? ''}>
        <option value="">全部</option>
        {value && !options.some(({ id }) => id === value) && (
          <option value={value}>历史引用</option>
        )}
        {options.map(({ id, name }) => (
          <option value={id} key={id}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ProjectArtifactList({
  project,
  user,
  scope,
}: {
  project: ProjectDetail;
  user: User;
  scope: DeliveryScope;
}) {
  const [policy, setPolicy] = useState(false);
  const suites = useResource<EnvironmentSetSummary[]>(
    '/projects/' + project.id + '/environment-sets',
  );
  const servers = useResource<Server[]>('/servers');
  const query = new URLSearchParams({ projectId: project.id, limit: String(artifactPageSize) });
  for (const key of [...filters, 'environmentId', 'pipelineRunId', 'taskId', 'cursor'] as const)
    if (scope[key]) query.set(key, scope[key]);
  if (scope.commit) query.set('commitSha', scope.commit);
  const records = useResource<Artifact[]>('/artifacts?' + query);
  const groups = new Map<string, Artifact[]>();
  for (const artifact of records.data ?? []) {
    const id = artifactLogicalId(artifact);
    const group = groups.get(id);
    if (group) group.push(artifact);
    else groups.set(id, [artifact]);
  }
  const serverNames = new Map((servers.data ?? []).map(({ id, name }) => [id, name]));
  const routeScope = { view: scope.view, viewSearch: scope.viewSearch };

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const values = Object.fromEntries(
      [...filters, 'commit'].map((key) => [key, String(fields.get(key) ?? '').trim()]),
    );
    navigate(artifactPath(project.id, { ...scope, ...values, cursor: undefined }));
  }
  return (
    <Section
      title="构建产物"
      action={
        <div className="heading-actions">
          {!project.archived && user.role === 'ADMIN' && (
            <button
              className="button secondary small"
              type="button"
              onClick={() => setPolicy(true)}
            >
              {scope.serviceId ? '服务保留策略' : '项目保留策略'}
            </button>
          )}
          <RefreshButton onClick={records.reload} />
        </div>
      }
      className="project-artifacts"
    >
      <form className="delivery-filters artifact-filters" onSubmit={apply} key={query.toString()}>
        <SelectFilter
          label="服务"
          name="serviceId"
          value={scope.serviceId}
          options={[...project.services, ...(project.archivedServices ?? [])]}
        />
        <SelectFilter
          label="变量集合"
          name="environmentSetId"
          value={scope.environmentSetId}
          options={suites.data ?? []}
        />
        <SelectFilter
          label="源码仓库"
          name="repositoryId"
          value={scope.repositoryId}
          options={project.repositories}
        />
        <SelectFilter
          label="实物服务器"
          name="serverId"
          value={scope.serverId}
          options={servers.data ?? []}
        />
        <SelectFilter
          label="类型"
          name="kind"
          value={scope.kind}
          options={['FILE', 'DIRECTORY', 'DOCKER_IMAGE'].map((id) => ({
            id,
            name: artifactKindLabel(id),
          }))}
        />
        <SelectFilter
          label="验证状态"
          name="verificationStatus"
          value={scope.verificationStatus}
          options={Object.entries(artifactVerificationLabels).map(([id, name]) => ({ id, name }))}
        />
        <label>
          Git ref <input name="ref" defaultValue={scope.ref ?? ''} placeholder="refs/heads/main" />
        </label>
        <label>
          提交 SHA{' '}
          <input name="commit" pattern="[0-9a-fA-F]{1,64}" defaultValue={scope.commit ?? ''} />
        </label>
        <button className="button secondary small" type="submit">
          应用筛选
        </button>
        {query.size > 2 && (
          <a className="text-link" href={'#' + artifactPath(project.id, routeScope)}>
            清除筛选
          </a>
        )}
      </form>
      <ErrorBanner error={records.error} retry={records.reload} />
      {records.loading ? (
        <Loading />
      ) : !groups.size ? (
        <Empty
          title="没有匹配的产物"
          description={
            query.size > 2 ? '可调整筛选条件后重新查看。' : '完成登记的构建产物将在这里显示。'
          }
        />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>产物</th>
                <th>服务 / 变量集合</th>
                <th>实际位置和状态</th>
                <th>源码</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {[...groups].map(([id, instances]) => {
                const artifact = instances[0]!;
                const source = sourceHref(project.id, artifact, scope);
                return (
                  <tr key={id}>
                    <td>
                      <strong className="table-name">{artifactTitle(artifact)}</strong>
                      <small className="cell-detail">
                        {artifactKindLabel(artifact.kind ?? artifact.artifactType)} ·{' '}
                        {instances.length} 个实例
                      </small>
                      {artifact.temporary && <span className="tag">运行内临时产物</span>}
                    </td>
                    <td>
                      {serviceName(project, artifact.serviceId)}
                      {artifact.environmentSet && (
                        <small className="cell-detail">
                          {artifact.environmentSet.name} · 修订 {artifact.environmentSet.revision}
                        </small>
                      )}
                    </td>
                    <td>
                      {instances.slice(0, 3).map((item) => (
                        <div className="artifact-instance-line" key={artifactInstanceId(item)}>
                          <span>{artifactLocation(item, serverNames)}</span>
                          <ArtifactStatus artifact={item} />
                        </div>
                      ))}
                      {instances.length > 3 && (
                        <small className="muted">还有 {instances.length - 3} 个实例</small>
                      )}
                    </td>
                    <td>
                      {artifact.sourceCommit ? (
                        <code title={artifact.sourceCommit}>
                          {artifact.sourceCommit.slice(0, 12)}
                        </code>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="nowrap">{formatTime(artifact.createdAt)}</td>
                    <td>
                      <div className="heading-actions">
                        <a
                          className="button secondary small"
                          href={'#' + artifactPath(project.id, { ...scope, recordId: id })}
                        >
                          查看详情
                        </a>
                        {source && (
                          <a className="text-link" href={source}>
                            来源运行
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(scope.cursor || records.data?.length === artifactPageSize) && (
        <div className="heading-actions">
          {scope.cursor && (
            <a
              className="button secondary small"
              href={'#' + artifactPath(project.id, { ...scope, cursor: undefined })}
            >
              返回第一页
            </a>
          )}
          {records.data?.length === artifactPageSize && (
            <a
              className="button secondary small"
              href={
                '#' +
                artifactPath(project.id, {
                  ...scope,
                  cursor: artifactInstanceId(records.data.at(-1)!),
                })
              }
            >
              下一页
            </a>
          )}
        </div>
      )}
      {policy && (
        <ArtifactRetentionPolicy
          scope={{ projectId: project.id, serviceId: scope.serviceId ?? undefined }}
          onClose={() => setPolicy(false)}
        />
      )}
    </Section>
  );
}

function Details({
  project,
  user,
  scope,
  id,
}: {
  project: ProjectDetail;
  user: User;
  scope: DeliveryScope;
  id: string;
}) {
  const detail = useResource<ArtifactDetail>('/artifacts/' + encodeURIComponent(id));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<{ data: CleanupPlan; refs: ArtifactRef[]; key: string }>();
  const [latestJob, setLatestJob] = useState<CleanupJob>();
  const [settledJobId, setSettledJobId] = useState<string>();
  const canVerify = !project.archived && user.role !== 'VIEWER';
  const canManage = canVerify && user.role === 'ADMIN';
  const jobId = canManage ? scope.cleanupJob || latestJob?.id : undefined;
  const jobPath = jobId ? '/artifact-retention/jobs/' + encodeURIComponent(jobId) : null;
  const jobResource = useResource<CleanupJob>(jobPath, jobId && settledJobId !== jobId ? 2000 : 0);
  const job = jobResource.data ?? latestJob;
  const jobState = job?.status;
  const reloadDetail = detail.reload;
  useEffect(() => {
    if (
      jobId &&
      settledJobId !== jobId &&
      jobState &&
      !['QUEUED', 'PENDING', 'RUNNING'].includes(jobState)
    ) {
      setSettledJobId(jobId);
      void reloadDetail();
    }
  }, [jobId, jobState, reloadDetail, settledJobId]);
  const instances = detail.data?.instances ?? [];
  const artifactId = detail.data?.artifactId ?? id;
  const artifact = instances[0];

  async function submit(key: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy('');
    }
  }

  const back = (
    <a
      className="button secondary small"
      href={
        '#' +
        artifactPath(project.id, {
          ...scope,
          recordId: undefined,
          cleanupJob: undefined,
        })
      }
    >
      返回产物列表
    </a>
  );
  if (detail.loading && !artifact) return <Loading />;
  if (!artifact || instances.some((item) => item.projectId !== project.id))
    return (
      <Section title="产物详情" action={back}>
        <ErrorBanner error={detail.error || '当前项目内没有这条产物记录。'} retry={detail.reload} />
      </Section>
    );

  const active = instances.filter(
    (item) => (!item.lifecycleState || item.lifecycleState === 'ACTIVE') && item.prunedAt == null,
  );
  const pinned = active.length > 0 && active.every((item) => item.pinnedAt != null);
  const source = sourceHref(project.id, artifact, scope);
  const verify = (instanceId?: string) =>
    submit(instanceId ?? 'verify', async () => {
      await post<ArtifactDetail>('/artifacts/' + encodeURIComponent(artifactId) + '/verify', {
        ...(instanceId ? { instanceIds: [instanceId] } : {}),
      });
      await detail.reload();
    });
  const previewCleanup = (instanceId?: string) =>
    submit('preview', async () => {
      setPlan(undefined);
      const refs = [{ artifactId, instanceId }];
      const data = await post<CleanupPlan>('/artifact-retention/preview', { artifacts: refs });
      setPlan({ data, refs, key: graphKey('artifact-cleanup') });
    });

  return (
    <>
      <Section title={artifactTitle(artifact)} action={back} className="project-artifacts">
        <div className="artifact-detail-summary">
          <span>{artifactKindLabel(artifact.kind ?? artifact.artifactType)}</span>
          <span>{serviceName(project, artifact.serviceId)}</span>
          {artifact.environmentSet && (
            <span>
              {artifact.environmentSet.name} · 修订 {artifact.environmentSet.revision}
            </span>
          )}
          {artifact.temporary && <span className="tag">运行内临时产物</span>}
          {pinned && <span className="tag">已固定</span>}
        </div>
        <dl className="graph-field-values">
          <div>
            <dt>产物 ID</dt>
            <dd>
              <code>{artifactId}</code>
            </dd>
          </div>
          <div>
            <dt>生产节点</dt>
            <dd>
              {source ? (
                <a className="text-link" href={source}>
                  {[artifact.graphFlowName, artifact.graphNodeName].filter(Boolean).join(' / ') ||
                    '查看来源运行'}
                </a>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>源码</dt>
            <dd>
              <ArtifactOrigins artifact={artifact} project={project} scope={scope} />
            </dd>
          </div>
        </dl>
        <div className="heading-actions">
          {canVerify && active.some(({ physical }) => physical) && (
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy}
              onClick={() => void verify()}
            >
              <ClipboardCheck size={15} />
              {busy === 'verify' ? '验证中…' : '验证全部实例'}
            </button>
          )}
          {canManage && active.length > 0 && !artifact.temporary && (
            <>
              <button
                className="button secondary small"
                type="button"
                disabled={!!busy}
                onClick={() =>
                  void submit('pin', async () => {
                    await api(
                      '/artifact-retention/artifacts/' + encodeURIComponent(artifactId) + '/pin',
                      {
                        method: 'PUT',
                        body: JSON.stringify({ pinned: !pinned }),
                      },
                    );
                    await detail.reload();
                  })
                }
              >
                {pinned ? '取消固定' : '固定保留'}
              </button>
              <button
                className="button secondary small"
                type="button"
                disabled={!!busy}
                onClick={() => void previewCleanup()}
              >
                <Trash2 size={15} />
                清理预览
              </button>
            </>
          )}
        </div>
        <ErrorBanner error={error || detail.error} />
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>实物位置</th>
                <th>身份</th>
                <th>验证</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((item) => {
                const instanceId = artifactInstanceId(item);
                const physical = item.physical;
                const serverId = item.serverId ?? physical?.serverId;
                const digest =
                  physical?.sha256 ??
                  physical?.imageId ??
                  physical?.digest ??
                  item.checksum ??
                  item.imageId ??
                  item.imageDigest;
                return (
                  <tr key={instanceId}>
                    <td>
                      {serverId ? (
                        <a
                          className="text-link"
                          href={serverResourceHref({
                            serverId,
                            projectId: project.id,
                            returnPath: artifactPath(project.id, scope),
                          })}
                        >
                          {artifactLocation(item)}
                        </a>
                      ) : (
                        artifactLocation(item)
                      )}
                      <small className="cell-detail mono artifact-object-name">
                        {physical?.path || physical?.imageReference || item.storageKey}
                      </small>
                      {physical?.owner && (
                        <small className="cell-detail">
                          {physical.owner === 'MANAGED' ? '平台托管' : '外部引用'}
                        </small>
                      )}
                    </td>
                    <td>
                      <code className="artifact-object-name">{digest ?? '—'}</code>
                      {physical?.platform && (
                        <small className="cell-detail">{physical.platform}</small>
                      )}
                      <small className="cell-detail mono" title={instanceId}>
                        实例 {instanceId.slice(0, 8)}
                      </small>
                    </td>
                    <td>
                      <ArtifactStatus artifact={item} />
                      {item.verifiedAt && (
                        <small className="cell-detail">{formatTime(item.verifiedAt)}</small>
                      )}
                      {item.verificationReason && (
                        <small className="cell-detail">{item.verificationReason}</small>
                      )}
                    </td>
                    <td>
                      <ArtifactDownload artifact={item} />
                      {canVerify && physical && active.includes(item) && (
                        <button
                          className="button secondary small"
                          type="button"
                          disabled={!!busy}
                          onClick={() => void verify(instanceId)}
                        >
                          {busy === instanceId ? '验证中…' : '验证实例'}
                        </button>
                      )}
                      {canManage && !item.temporary && active.includes(item) && (
                        <button
                          className="button secondary small"
                          type="button"
                          disabled={!!busy}
                          onClick={() => void previewCleanup(instanceId)}
                        >
                          清理实例
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
      {canManage && plan && (
        <Section title="核对清理影响">
          <p className="field-note">清理会再次检查引用和所有权，并保留产物和实例的历史记录。</p>
          <CleanupRows instances={plan.data.instances} />
          <div className="heading-actions">
            <button
              className="button danger small"
              type="button"
              disabled={!!busy || !plan.data.eligibleCount}
              onClick={() =>
                void submit('cleanup', async () => {
                  const result = await post<CleanupJob>('/artifact-retention/prune', {
                    artifacts: plan.refs,
                    planDigest: plan.data.planDigest,
                    idempotencyKey: plan.key,
                  });
                  setPlan(undefined);
                  setLatestJob(result);
                  navigate(
                    artifactPath(project.id, {
                      ...scope,
                      cleanupJob: result.id,
                      recordId: artifactId,
                    }),
                  );
                  await detail.reload();
                })
              }
            >
              确认清理 {plan.data.eligibleCount} 个实例
            </button>
            <button
              className="button secondary small"
              type="button"
              disabled={!!busy}
              onClick={() => setPlan(undefined)}
            >
              取消
            </button>
          </div>
        </Section>
      )}
      {canManage && jobPath && (
        <Section
          title="清理结果"
          action={
            <RefreshButton
              onClick={() => {
                void jobResource.reload();
                void detail.reload();
              }}
            />
          }
        >
          <ErrorBanner error={jobResource.error} retry={jobResource.reload} />
          {job ? (
            <>
              <p role="status">{cleanupLabels[job.status] ?? job.status}</p>
              <CleanupRows instances={job.instances} />
              {job.instances.some(({ status }) =>
                ['FAILED', 'RETRY', 'RETRYABLE', 'UNVERIFIABLE', 'NEEDS_ATTENTION'].includes(
                  status,
                ),
              ) && (
                <button
                  className="button secondary small"
                  type="button"
                  disabled={!!busy}
                  onClick={() =>
                    void submit('retry', async () => {
                      setLatestJob(await post<CleanupJob>(jobPath + '/retry'));
                      setSettledJobId(undefined);
                      await jobResource.reload();
                    })
                  }
                >
                  重试未完成实例
                </button>
              )}
            </>
          ) : jobResource.loading ? (
            <Loading />
          ) : null}
        </Section>
      )}
    </>
  );
}

function CleanupRows({ instances }: { instances: CleanupInstance[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>实例</th>
            <th>位置</th>
            <th>处置</th>
            <th>原因</th>
          </tr>
        </thead>
        <tbody>
          {instances.map((item) => (
            <tr key={item.instanceId}>
              <td>
                <code>{item.instanceId.slice(0, 8)}</code>
              </td>
              <td className="artifact-object-name">
                {item.path ||
                  (typeof item.location === 'string'
                    ? item.location
                    : item.location?.path || item.location?.kind || '—')}
              </td>
              <td>
                {item.eligible === undefined
                  ? (cleanupLabels[item.status] ?? item.status)
                  : item.eligible
                    ? item.action === 'DETACH'
                      ? '解除引用'
                      : '删除实物'
                    : '保留'}
              </td>
              <td>{item.reason || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectArtifacts({
  project,
  user,
  scope,
}: {
  project: ProjectDetail;
  user: User;
  scope: DeliveryScope;
}) {
  return scope.recordId ? (
    <Details key={scope.recordId} project={project} user={user} scope={scope} id={scope.recordId} />
  ) : (
    <ProjectArtifactList project={project} user={user} scope={scope} />
  );
}
