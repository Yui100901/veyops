import './delivery-filters.css';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { Boxes, Layers3 } from 'lucide-react';
import { api, formatTime, message, useResource } from '../../api';
import {
  Empty,
  ErrorBanner,
  Loading,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../../components';
import type { DeploymentRecord, DeploymentSelection, ProjectDetail, User } from '../../models';
import { ArtifactCleanup, ArtifactRetentionPolicy } from './ArtifactRetention';
import {
  deliveryGraphRunPath,
  deliveryPath,
  deliveryTaskPath,
  type DeliveryScope,
  type DeliveryTab,
} from './delivery-route';
import { projectGraphPath } from '../projects/project-workspace-route';
import { serverResourceHref } from '../infrastructure/server-resource-route';

function DeliveryHeading({
  compact,
  ...props
}: ComponentProps<typeof PageHeader> & { compact: boolean }) {
  return compact ? (
    <div className="delivery-section-actions">{props.action}</div>
  ) : (
    <PageHeader {...props} />
  );
}

export const artifactVerificationLabels = {
  NOT_CHECKED: '待验证',
  AVAILABLE: '可用',
  MISSING: '实物缺失',
  CHANGED: '实物已变化',
  UNVERIFIABLE: '无法验证',
};
export type ArtifactKind = 'FILE' | 'DIRECTORY' | 'DOCKER_IMAGE';
export type ArtifactVerification = keyof typeof artifactVerificationLabels;
export type ArtifactLifecycle = 'STAGING' | 'ACTIVE' | 'CLEANING' | 'DELETED';
export type ArtifactPhysical = {
  location: 'SERVER_PATH' | 'BUILDER_PATH' | 'DOCKER_ENGINE' | 'REGISTRY';
  owner?: 'MANAGED' | 'EXTERNAL';
  serverId?: string;
  path?: string;
  sha256?: string;
  sizeBytes?: number;
  imageId?: string;
  platform?: string;
  imageReference?: string;
  digest?: string;
};
export type Artifact = {
  id: string;
  artifactId?: string | null;
  instanceId?: string;
  projectId?: string;
  artifactType: string;
  name?: string | null;
  kind?: string;
  graphRunId?: string | null;
  graphNodeRunId?: string | null;
  graphNodeId?: string | null;
  graphVersion?: number | null;
  graphFlowName?: string | null;
  graphNodeName?: string | null;
  storageType: string;
  storageKey: string;
  downloadAvailable: boolean;
  sourceCommit?: string;
  sources?: {
    repositoryId: string;
    commitSha: string;
    ref?: string;
    subject?: string;
    workspace?: { runId: string; nodeRunId: string };
    path?: string;
  }[];
  sourceEvent?: { eventId?: string; repositoryId?: string; commitSha?: string; ref?: string };
  composeTemplate?: { source: 'ARCHIVE'; path?: string; checksum: string };
  imageOrigin?: 'REGISTERED_IMAGE' | 'BUILD';
  sourceImageReference?: string;
  checksum?: string;
  imageDigest?: string;
  imageId?: string;
  imageRepository?: string;
  sizeBytes?: number;
  createdAt: number;
  serviceId?: string | null;
  pipelineRunId?: string;
  serverId?: string | null;
  serverName?: string | null;
  environmentId?: string;
  targetSelection?: DeploymentSelection | null;
  deployable?: boolean;
  pinnedAt?: number | null;
  prunedAt?: number | null;
  physical?: ArtifactPhysical | null;
  verificationStatus?: ArtifactVerification;
  verificationReason?: string | null;
  verifiedAt?: number | null;
  lifecycleState?: ArtifactLifecycle;
  temporary?: boolean;
  environmentSet?: { id: string; name: string; revision: number } | null;
};
export type ArtifactRef = { artifactId: string; instanceId?: string };
export const artifactKindLabel = (kind: string) =>
  kind === 'FILE'
    ? '文件'
    : kind === 'DIRECTORY'
      ? '目录'
      : kind === 'DOCKER_IMAGE'
        ? 'Docker 镜像'
        : kind;

export const artifactLogicalId = (artifact: Artifact) => artifact.artifactId ?? artifact.id;
export const artifactInstanceId = (artifact: Artifact) => artifact.instanceId ?? artifact.id;

export function isDeployableArtifact(artifact: Artifact) {
  return Boolean(
    artifact.deployable &&
    artifact.projectId &&
    artifact.pipelineRunId &&
    artifact.prunedAt == null &&
    !artifact.temporary &&
    (!artifact.lifecycleState || artifact.lifecycleState === 'ACTIVE') &&
    (!artifact.verificationStatus ||
      ['NOT_CHECKED', 'AVAILABLE'].includes(artifact.verificationStatus)),
  );
}

export function ArtifactStatus({ artifact }: { artifact: Artifact }) {
  const lifecycle = artifact.lifecycleState;
  const verification = artifact.verificationStatus ?? 'NOT_CHECKED';
  const label =
    lifecycle === 'DELETED' || artifact.prunedAt != null
      ? '已清理'
      : lifecycle === 'STAGING'
        ? '登记中'
        : lifecycle === 'CLEANING'
          ? '清理中'
          : artifactVerificationLabels[verification];
  return (
    <span className="tag" title={artifact.verificationReason ?? undefined}>
      {label}
    </span>
  );
}

const storageLabels: Record<string, string> = {
  LOCAL_FILE: '平台文件',
  REMOTE_FILE: '服务器文件',
  LOCAL_IMAGE: '管理端镜像',
  REMOTE_IMAGE: '目标端镜像',
  REGISTRY_IMAGE: 'Registry 镜像',
};
const healthStatusLabels: Record<string, string> = {
  HEALTHY: '通过',
  FAILED: '失败',
  NOT_CHECKED: '未检查',
  UNKNOWN: '待核查',
};

export function RunArtifacts({ runId, polling }: { runId: string; polling: boolean }) {
  const artifacts = useResource<Artifact[]>(
    `/artifacts?pipelineRunId=${encodeURIComponent(runId)}`,
    polling ? 2000 : 0,
  );
  return (
    <Section title="本次构建产物" action={<RefreshButton onClick={artifacts.reload} />}>
      <ErrorBanner error={artifacts.error} />
      {artifacts.loading ? (
        <Loading />
      ) : artifacts.data?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>产物</th>
                <th>校验 / Digest</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.data.map((artifact) => (
                <tr key={artifact.id}>
                  <td>
                    <strong>
                      {artifact.name ?? artifactKindLabel(artifact.kind ?? artifact.artifactType)}
                    </strong>
                    <small className="cell-detail">
                      <ArtifactStatus artifact={artifact} />
                      {artifact.temporary && <span className="tag">运行内临时产物</span>}
                    </small>
                    {artifact.artifactType === 'DOCKER_IMAGE' && (
                      <small className="cell-detail mono">{artifact.storageKey}</small>
                    )}
                    {artifact.projectId && (
                      <a
                        className="text-link"
                        href={
                          '#' +
                          deliveryPath(artifact.projectId, 'artifacts', {
                            recordId: artifactLogicalId(artifact),
                          })
                        }
                      >
                        查看详情
                      </a>
                    )}
                  </td>
                  <td className="mono">
                    {artifact.checksum || artifact.imageDigest || artifact.imageId || '—'}
                  </td>
                  <td>
                    <ArtifactDownload artifact={artifact} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="field-note">{polling ? '等待构建生成产物' : '本次运行暂无产物'}</p>
      )}
    </Section>
  );
}

export function ArtifactDownload({ artifact }: { artifact: Artifact }) {
  if (artifact.lifecycleState === 'DELETED' || artifact.prunedAt != null)
    return <span className="muted">已清理</span>;
  if (artifact.downloadAvailable)
    return (
      <a
        className="button secondary small"
        href={`/api/v1/artifacts/${artifact.id}/download`}
        download
      >
        下载
      </a>
    );
  if (artifact.storageType === 'REGISTRY_IMAGE')
    return <span className="muted">从 Registry 拉取</span>;
  if (artifact.physical?.location === 'SERVER_PATH')
    return <span className="muted">保存在构建服务器</span>;
  return <span className="muted">—</span>;
}

function GraphOrigin({
  record,
  tab,
  scope,
  archived,
}: {
  record: Pick<
    Artifact,
    'projectId' | 'graphRunId' | 'graphVersion' | 'graphFlowName' | 'graphNodeName'
  >;
  tab: DeliveryTab;
  scope: DeliveryScope;
  archived?: boolean;
}) {
  if (!record.graphRunId || !record.projectId) return null;
  const name = record.graphFlowName || '执行流运行';
  const version = record.graphVersion != null ? ` · v${record.graphVersion}` : '';
  return (
    <small className="cell-detail">
      {archived ? (
        <span>
          {name}
          {version}
        </span>
      ) : (
        <a
          className="text-link"
          href={'#' + deliveryGraphRunPath(record.projectId, record.graphRunId, tab, scope)}
        >
          {name}
          {version}
        </a>
      )}
      {record.graphNodeName && <span> · {record.graphNodeName}</span>}
    </small>
  );
}

export function ArtifactOrigins({
  artifact,
  project,
  scope,
}: {
  artifact: Artifact;
  project?: ProjectDetail;
  scope: DeliveryScope;
}) {
  const { sources, sourceEvent, sourceCommit, projectId } = artifact;
  return (
    <div className="cell-detail">
      {sources?.length ? (
        <details>
          <summary>{sources.length} 项源码来源</summary>
          <ul>
            {sources.map((source, index) => {
              const label =
                project?.repositories.find(({ id }) => id === source.repositoryId)?.name ||
                source.repositoryId;
              return (
                <li key={index}>
                  {projectId ? (
                    <a
                      className="text-link"
                      href={
                        '#' +
                        deliveryPath(projectId, 'artifacts', {
                          serviceId: scope.serviceId,
                          environmentId: scope.environmentId,
                          view: scope.view,
                          repositoryId: source.repositoryId,
                          commit: source.commitSha,
                        })
                      }
                    >
                      {label}
                    </a>
                  ) : (
                    label
                  )}
                  <small className="cell-detail mono">{source.ref || source.commitSha}</small>
                  {source.ref !== source.commitSha && (
                    <small className="cell-detail mono">{source.commitSha}</small>
                  )}
                  {source.subject && <small className="cell-detail">{source.subject}</small>}
                  {source.path && <small className="cell-detail mono">{source.path}</small>}
                  {source.workspace && projectId && (
                    <a
                      className="text-link"
                      href={
                        '#' +
                        deliveryGraphRunPath(projectId, source.workspace.runId, 'artifacts', scope)
                      }
                      title={source.workspace.nodeRunId}
                    >
                      工作区来源
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      ) : (
        <>
          {sourceCommit && sources === undefined && (
            <code title={sourceCommit}>{sourceCommit.slice(0, 12)}</code>
          )}
          <small className="cell-detail muted">
            {sources === undefined ? '历史记录缺少仓库溯源' : '缺少可验证的源码来源'}
          </small>
        </>
      )}
      {sourceEvent && (
        <small className="cell-detail" title={sourceEvent.eventId}>
          触发提交 ·{' '}
          <code title={sourceEvent.commitSha}>
            {sourceEvent.commitSha?.slice(0, 12) || sourceEvent.ref || '—'}
          </code>
        </small>
      )}
    </div>
  );
}

export function DeliveryRecordsPage({
  type,
  user,
  project,
  query = '',
  scope = {},
  readOnly = false,
}: {
  type: 'artifacts' | 'deployments';
  user: User;
  project?: ProjectDetail;
  query?: string;
  scope?: DeliveryScope;
  readOnly?: boolean;
}) {
  const records = useResource<
    (Artifact &
      DeploymentRecord & {
        serverName?: string | null;
        serverHost?: string | null;
        serverPort?: number | null;
      })[]
  >(`/${type}?${query}`);
  const [retention, setRetention] = useState<'policy' | 'cleanup'>();
  const [pinning, setPinning] = useState<string>();
  const [pinError, setPinError] = useState('');
  const canWrite = !readOnly && user.role !== 'VIEWER' && !project?.archived;
  const scopeParams = new URLSearchParams(query);
  const serviceId = scopeParams.get('serviceId');
  const environmentId = scopeParams.get('environmentId');
  const retentionScope =
    serviceId &&
    environmentId &&
    project?.services.some(({ id }) => id === serviceId) &&
    project.environments.some(({ id }) => id === environmentId)
      ? { serviceId, environmentId }
      : undefined;

  async function togglePin(artifact: Artifact) {
    setPinning(artifact.id);
    setPinError('');
    try {
      await api(`/artifact-retention/artifacts/${artifact.id}/pin`, {
        method: 'PUT',
        body: JSON.stringify({ pinned: artifact.pinnedAt == null }),
      });
      await records.reload();
    } catch (cause) {
      setPinError(message(cause));
    } finally {
      setPinning(undefined);
    }
  }

  return (
    <>
      <DeliveryHeading
        compact={Boolean(project)}
        eyebrow="DELIVERY TRACEABILITY"
        title={type === 'artifacts' ? '构建产物' : '部署记录'}
        description={
          type === 'artifacts'
            ? '记录构建来源、存储位置和校验信息，追踪每一份交付物。'
            : '每台服务器独立记录部署与健康检查结果。审批和回滚在项目执行图中完成。'
        }
        action={
          <div className="row-actions">
            {type === 'artifacts' && user.role === 'ADMIN' && canWrite && (
              <>
                {(!project || retentionScope) && (
                  <button className="button secondary" onClick={() => setRetention('policy')}>
                    {retentionScope ? '服务环境保留策略' : '全局保留策略'}
                  </button>
                )}
                {!project && (
                  <button className="button secondary" onClick={() => setRetention('cleanup')}>
                    全局清理预览
                  </button>
                )}
              </>
            )}
            <RefreshButton onClick={records.reload} />
          </div>
        }
      />
      {!project && (
        <div className="record-tabs">
          <a className={type === 'artifacts' ? 'active' : ''} href="#/artifacts">
            <Boxes size={16} />
            产物
          </a>
          <a className={type === 'deployments' ? 'active' : ''} href="#/deployments">
            <Layers3 size={16} />
            部署
          </a>
        </div>
      )}
      <ErrorBanner error={records.error} retry={records.reload} />
      {type === 'artifacts' && <ErrorBanner error={pinError} />}
      <Section
        title={type === 'artifacts' ? '产物历史' : '部署历史'}
        subtitle="由构建与部署执行流生成"
      >
        {records.loading ? (
          <Loading />
        ) : !records.data?.length ? (
          <Empty
            icon={<Boxes size={26} />}
            title={scope.recordId ? '找不到这条交付记录' : '暂无交付记录'}
            description={
              scope.recordId
                ? '请核对记录所属项目和当前筛选条件。'
                : '运行项目的构建或部署执行流后，结果会出现在这里。'
            }
            action={
              project?.archived ? undefined : (
                <a
                  className="button secondary"
                  href={
                    project
                      ? '#' +
                        projectGraphPath(project.id, {
                          serviceId: scope.serviceId || undefined,
                          environmentId: scope.environmentId || undefined,
                          view: scope.view || undefined,
                        })
                      : '#/projects'
                  }
                >
                  {project ? '打开执行图' : '打开项目列表'}
                </a>
              )
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>服务 / 环境</th>
                  {type === 'artifacts' ? (
                    <>
                      <th>产物</th>
                      <th>存储方式</th>
                      <th>固定 Commit</th>
                      <th>校验 / Digest</th>
                      <th>创建时间</th>
                      <th>操作</th>
                    </>
                  ) : (
                    <>
                      <th>部署</th>
                      <th>服务器</th>
                      <th>固定 Commit</th>
                      <th>部署目录</th>
                      <th>结果</th>
                      <th>健康检查</th>
                      <th>结束时间</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {records.data.map((r) => {
                  const rowScope = project
                    ? scope
                    : { serviceId: r.serviceId, environmentId: r.environmentId };
                  const serverHref =
                    r.serverId &&
                    serverResourceHref({
                      serverId: r.serverId,
                      projectId: r.projectId ?? undefined,
                      returnPath: r.projectId
                        ? deliveryPath(r.projectId, type, { ...rowScope, recordId: r.id })
                        : undefined,
                    });
                  const taskHref =
                    r.taskId &&
                    '#' +
                      (r.projectId
                        ? deliveryTaskPath(r.taskId, type, rowScope)
                        : `/tasks/${r.taskId}`);
                  const label =
                    project?.services.find(({ id }) => id === r.serviceId)?.name ||
                    project?.archivedServices?.find(({ id }) => id === r.serviceId)?.name ||
                    (project ? r.serviceId : '查看所属项目');
                  return (
                    <tr key={r.id}>
                      <td>
                        {r.projectId && scope.recordId !== r.id ? (
                          <a
                            className="text-link"
                            aria-label={`${label} · 查看交付详情`}
                            href={
                              '#' +
                              deliveryPath(r.projectId, type, {
                                ...rowScope,
                                recordId: r.id,
                              })
                            }
                          >
                            {label}
                          </a>
                        ) : (
                          label
                        )}
                        <small className="cell-detail">
                          {project?.environments.find((e) => e.id === r.environmentId)?.name ||
                            project?.archivedEnvironments?.find((e) => e.id === r.environmentId)
                              ?.name ||
                            r.environmentId ||
                            '—'}
                        </small>
                      </td>
                      {type === 'artifacts' ? (
                        <>
                          <td>
                            <strong className="table-name">
                              {r.name || (r.artifactType === 'FILE' ? '文件产物' : 'Docker 镜像')}
                            </strong>
                            <ArtifactStatus artifact={r} />
                            <small className="cell-detail mono" title={r.storageKey}>
                              {r.storageKey}
                            </small>
                            <GraphOrigin
                              record={r}
                              tab={type}
                              scope={rowScope}
                              archived={project?.archived}
                            />
                            {taskHref && (
                              <a className="text-link" href={taskHref}>
                                构建日志
                              </a>
                            )}
                          </td>
                          <td>
                            <span className="tag">
                              {storageLabels[r.storageType] || r.storageType}
                            </span>
                            {serverHref && (
                              <a className="cell-detail text-link" href={serverHref}>
                                {r.serverName || '源服务器'}
                              </a>
                            )}
                            {r.sizeBytes != null && (
                              <small className="cell-detail">
                                {(r.sizeBytes / 1024).toFixed(1)} KiB
                              </small>
                            )}
                            {r.pinnedAt != null && <small className="cell-detail">已固定</small>}
                            {r.imageOrigin === 'REGISTERED_IMAGE' && (
                              <small className="cell-detail">
                                登记的现有镜像{' '}
                                {r.sourceImageReference && <code>{r.sourceImageReference}</code>}
                              </small>
                            )}
                            {r.composeTemplate && (
                              <small className="cell-detail">
                                Compose 归档 {r.composeTemplate.path} ·{' '}
                                <code title={r.composeTemplate.checksum}>
                                  {r.composeTemplate.checksum.slice(0, 12)}
                                </code>
                              </small>
                            )}
                          </td>
                          <td>
                            <ArtifactOrigins artifact={r} project={project} scope={rowScope} />
                          </td>
                          <td
                            className="mono truncate"
                            title={r.checksum || r.imageDigest || r.imageId}
                          >
                            {r.checksum || r.imageDigest || r.imageId || '—'}
                          </td>
                          <td className="nowrap muted">{formatTime(r.createdAt)}</td>
                          <td>
                            <ArtifactDownload artifact={r} />
                            {r.projectId && (
                              <a
                                className="button secondary small"
                                href={
                                  '#' +
                                  deliveryPath(r.projectId, 'artifacts', {
                                    ...rowScope,
                                    recordId: artifactLogicalId(r),
                                  })
                                }
                              >
                                查看详情
                              </a>
                            )}
                            {user.role === 'ADMIN' &&
                              canWrite &&
                              r.prunedAt == null &&
                              (r.downloadAvailable || r.deployable || r.pinnedAt != null) && (
                                <button
                                  className="button secondary small"
                                  type="button"
                                  disabled={pinning != null}
                                  onClick={() => void togglePin(r)}
                                >
                                  {pinning === r.id
                                    ? '正在更新…'
                                    : r.pinnedAt != null
                                      ? '取消固定'
                                      : '固定产物'}
                                </button>
                              )}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="mono">
                            {taskHref ? (
                              <a href={taskHref} className="text-link">
                                {r.releaseVersion || r.id.slice(0, 8)}
                              </a>
                            ) : (
                              r.releaseVersion || r.id.slice(0, 8)
                            )}
                            <GraphOrigin
                              record={r}
                              tab={type}
                              scope={rowScope}
                              archived={project?.archived}
                            />
                            {r.projectId && r.artifactId && (
                              <small className="cell-detail">
                                <a
                                  className="text-link"
                                  href={
                                    '#' +
                                    deliveryPath(r.projectId, 'artifacts', {
                                      serviceId: scope.serviceId,
                                      environmentId: scope.environmentId,
                                      commit: scope.commit,
                                      view: scope.view,
                                      recordId: r.artifactId,
                                    })
                                  }
                                >
                                  使用的产物 {r.artifactId.slice(0, 8)}
                                </a>
                              </small>
                            )}
                            {r.previousDeploymentId && (
                              <small className="cell-detail" title={r.previousDeploymentId}>
                                上一成功部署 {r.previousDeploymentId.slice(0, 8)}
                              </small>
                            )}
                            {r.isCurrent && <small className="cell-detail">当前发布</small>}
                            {r.rollbackOfDeploymentId && (
                              <small className="cell-detail" title={r.rollbackOfDeploymentId}>
                                回滚基线 {r.rollbackOfDeploymentId.slice(0, 8)}
                              </small>
                            )}
                          </td>
                          <td className="truncate" title={r.serverId}>
                            {serverHref ? (
                              <a className="text-link" href={serverHref}>
                                {r.serverName || r.serverId}
                              </a>
                            ) : (
                              '—'
                            )}
                            {r.serverHost && (
                              <small className="cell-detail mono">
                                {r.serverHost}
                                {r.serverPort ? ` · ${r.serverPort}` : ''}
                              </small>
                            )}
                          </td>
                          <td className="mono" title={r.sourceCommit}>
                            {r.sourceCommit?.slice(0, 12) || '—'}
                          </td>
                          <td className="mono truncate" title={r.deployPath}>
                            {r.deployPath || '—'}
                            {r.composeRelease && (
                              <>
                                <small
                                  className="cell-detail"
                                  title={r.composeRelease.template.checksum}
                                >
                                  Compose {r.composeRelease.template.path ?? '产物归档'}{' '}
                                  {r.composeRelease.template.source === 'SERVICE_ENVIRONMENT' &&
                                    `v${r.composeRelease.template.version} · `}
                                  {r.composeRelease.template.source === 'REPOSITORY_FILE' &&
                                    `${r.composeRelease.template.commitSha.slice(0, 12)} · `}
                                  {r.composeRelease.template.checksum.slice(0, 12)}
                                </small>
                                <small
                                  className="cell-detail"
                                  title={
                                    r.composeRelease.imageReference +
                                    ' · ' +
                                    r.composeRelease.imageId
                                  }
                                >
                                  镜像 {r.composeRelease.imageId.slice(0, 19)}
                                </small>
                              </>
                            )}
                          </td>
                          <td>
                            <Status value={r.status} />
                            {r.rollbackStatus && (
                              <small className="cell-detail">
                                回滚 <Status value={r.rollbackStatus} />
                              </small>
                            )}
                          </td>
                          <td>
                            {healthStatusLabels[r.healthStatus] || r.healthStatus || '未配置'}
                          </td>
                          <td className="nowrap muted">{formatTime(r.finishedAt)}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {type === 'artifacts' && retention === 'policy' && (
        <ArtifactRetentionPolicy scope={retentionScope} onClose={() => setRetention(undefined)} />
      )}
      {type === 'artifacts' && retention === 'cleanup' && (
        <ArtifactCleanup onClose={() => setRetention(undefined)} onPruned={records.reload} />
      )}
    </>
  );
}
