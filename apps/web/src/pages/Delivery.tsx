import { InlineEditor, useInlineEditor } from '../InlineEditor';
import { useState } from 'react';
import type { ComponentProps, FormEvent } from 'react';
import { Boxes, Layers3, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, formatTime, message, post, remove, useResource } from '../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  Modal,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type {
  Credential,
  DeploymentRecord,
  DeploymentSelection,
  ProjectDetail,
  Server,
  User,
} from '../models';
import { ReleaseApprovals, RollbackRelease } from './ReleaseOperations';
import { ArtifactCleanup, ArtifactRetentionPolicy } from './ArtifactRetention';
import { deliveryPath } from './delivery-route';

interface Registry {
  id: string;
  name: string;
  registryUrl: string;
  credentialId: string | null;
}
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

export type Artifact = {
  id: string;
  projectId?: string;
  artifactType: string;
  name?: string | null;
  kind?: string;
  graphRunId?: string | null;
  graphNodeRunId?: string | null;
  storageType: string;
  storageKey: string;
  downloadAvailable: boolean;
  sourceCommit?: string;
  checksum?: string;
  imageDigest?: string;
  imageId?: string;
  imageRepository?: string;
  sizeBytes?: number;
  createdAt: number;
  serviceId: string;
  pipelineRunId?: string;
  serverId?: string | null;
  environmentId?: string;
  targetSelection?: DeploymentSelection | null;
  deployable?: boolean;
  pinnedAt?: number | null;
  prunedAt?: number | null;
};
export function isDeployableArtifact(artifact: Artifact) {
  return Boolean(
    artifact.deployable &&
    artifact.projectId &&
    artifact.pipelineRunId &&
    artifact.environmentId &&
    artifact.prunedAt == null,
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
                    <strong>{artifact.artifactType === 'FILE' ? '文件产物' : 'Docker 镜像'}</strong>
                    {artifact.artifactType === 'DOCKER_IMAGE' && (
                      <small className="cell-detail mono">{artifact.storageKey}</small>
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

function ArtifactDownload({ artifact }: { artifact: Artifact }) {
  if (artifact.prunedAt != null) return <span className="muted">归档已清理</span>;
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
  return <span className="muted">—</span>;
}

export function DeliveryRecordsPage({
  type,
  user,
  project,
  query = '',
}: {
  type: 'artifacts' | 'deployments';
  user: User;
  project?: ProjectDetail;
  query?: string;
}) {
  const records = useResource<(Artifact & DeploymentRecord)[]>(`/${type}?${query}`);
  const servers = useResource<Server[]>(type === 'deployments' ? '/servers' : null);
  const [rollback, setRollback] = useState<DeploymentRecord>();
  const [retention, setRetention] = useState<'policy' | 'cleanup'>();
  const [pinning, setPinning] = useState<string>();
  const [pinError, setPinError] = useState('');
  const canWrite = user.role !== 'VIEWER' && !project?.archived;
  const scopeParams = new URLSearchParams(query);
  const serviceId = scopeParams.get('serviceId');
  const environmentId = scopeParams.get('environmentId');
  const retentionScope =
    project && serviceId && environmentId ? { serviceId, environmentId } : undefined;

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
            : '每台服务器独立记录部署与健康检查结果。'
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
      {!project && type === 'deployments' && user.role === 'ADMIN' && <ReleaseApprovals />}
      <Section
        title={type === 'artifacts' ? '产物历史' : '部署历史'}
        subtitle="由构建与部署执行流生成"
      >
        {records.loading ? (
          <Loading />
        ) : !records.data?.length ? (
          <Empty
            icon={<Boxes size={26} />}
            title="暂无交付记录"
            description="运行项目的构建或部署执行流后，结果会出现在这里。"
            action={
              <a
                className="button secondary"
                href={project ? `#/projects/${project.id}/execution-graph` : '#/projects'}
              >
                {project ? '打开执行图' : '打开项目列表'}
              </a>
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
                      {canWrite && <th>操作</th>}
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {records.data.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.projectId && (
                        <a
                          className="text-link"
                          href={
                            '#' +
                            deliveryPath(r.projectId, type, {
                              serviceId: r.serviceId,
                              recordId: r.id,
                            })
                          }
                        >
                          {project?.services.find((s) => s.id === r.serviceId)?.name ||
                            (project ? r.serviceId : '查看所属项目')}
                        </a>
                      )}
                      <small className="cell-detail">
                        {project?.environments.find((e) => e.id === r.environmentId)?.name ||
                          r.environmentId ||
                          '—'}
                      </small>
                    </td>
                    {type === 'artifacts' ? (
                      <>
                        <td>
                          <strong className="table-name">
                            {r.artifactType === 'FILE' ? '文件产物' : 'Docker 镜像'}
                          </strong>
                          <small className="cell-detail mono" title={r.storageKey}>
                            {r.storageKey}
                          </small>
                          {r.taskId && (
                            <a className="text-link" href={`#/tasks/${r.taskId}`}>
                              构建日志
                            </a>
                          )}
                        </td>
                        <td>
                          <span className="tag">
                            {storageLabels[r.storageType] || r.storageType}
                          </span>
                          {r.sizeBytes != null && (
                            <small className="cell-detail">
                              {(r.sizeBytes / 1024).toFixed(1)} KiB
                            </small>
                          )}
                          {r.pinnedAt != null && <small className="cell-detail">已固定</small>}
                        </td>
                        <td className="mono" title={r.sourceCommit}>
                          {r.sourceCommit?.slice(0, 12) || '—'}
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
                          {r.taskId ? (
                            <a href={`#/tasks/${r.taskId}`} className="text-link">
                              {r.releaseVersion || r.id.slice(0, 8)}
                            </a>
                          ) : (
                            r.releaseVersion || r.id.slice(0, 8)
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
                          {servers.data?.find((server) => server.id === r.serverId)?.name ||
                            r.serverId ||
                            '—'}
                        </td>
                        <td className="mono" title={r.sourceCommit}>
                          {r.sourceCommit?.slice(0, 12) || '—'}
                        </td>
                        <td className="mono truncate" title={r.deployPath}>
                          {r.deployPath || '—'}
                        </td>
                        <td>
                          <Status value={r.status} />
                          {r.rollbackStatus && (
                            <small className="cell-detail">
                              回滚 <Status value={r.rollbackStatus} />
                            </small>
                          )}
                        </td>
                        <td>{healthStatusLabels[r.healthStatus] || r.healthStatus || '未配置'}</td>
                        <td className="nowrap muted">{formatTime(r.finishedAt)}</td>
                        {canWrite && (
                          <td>
                            {r.isCurrent ? null : r.rollbackAvailable ? (
                              <button
                                className="button secondary small"
                                onClick={() => setRollback(r)}
                              >
                                回滚到此版本
                              </button>
                            ) : r.status === 'SUCCESS' ? (
                              <span className="muted">
                                {r.rollbackUnavailableReason || '缺少可用的回滚快照'}
                              </span>
                            ) : null}
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {type === 'deployments' && rollback && (
        <RollbackRelease record={rollback} onClose={() => setRollback(undefined)} />
      )}
      {type === 'artifacts' && retention === 'policy' && (
        <ArtifactRetentionPolicy scope={retentionScope} onClose={() => setRetention(undefined)} />
      )}
      {type === 'artifacts' && retention === 'cleanup' && (
        <ArtifactCleanup onClose={() => setRetention(undefined)} onPruned={records.reload} />
      )}
    </>
  );
}

export function RegistriesPage({ user }: { user: User }) {
  const registries = useResource<Registry[]>('/registries');
  const canManage = user.role === 'ADMIN';
  const credentials = useResource<Credential[]>(canManage ? '/credentials' : null);
  const [editing, setEditing] = useInlineEditor<Registry | 'new'>();
  const [address, setAddress] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Registry | null>(null);
  const [outcome, setOutcome] = useState<{
    registry: Registry;
    success: boolean;
    message: string;
  }>();
  const current = editing && editing !== 'new' ? editing : undefined;
  const availableCredentials = credentials.data?.filter(
    (c) => ['DOCKER_REGISTRY', 'USERNAME_PASSWORD'].includes(c.type) && c.status === 'ACTIVE',
  );

  function open(registry: Registry | 'new') {
    setError('');
    setAddress(registry === 'new' ? '' : registry.registryUrl);
    setCredentialId(registry === 'new' ? '' : (registry.credentialId ?? ''));
    setEditing(registry);
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    const definition = {
      name: String(f.get('name') ?? '').trim(),
      registryUrl: String(f.get('registryUrl') ?? '').trim(),
      credentialId: f.get('credentialId') || null,
    };
    try {
      if (current) {
        await api(`/registries/${current.id}`, {
          method: 'PATCH',
          body: JSON.stringify(definition),
        });
      } else {
        await post('/registries', definition);
      }
      setEditing(undefined);
      void registries.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function check(registry: Registry) {
    if (checking) return;
    setChecking(registry.id);
    setOutcome(undefined);
    try {
      const result = await post<{ success: boolean; message: string }>(
        `/registries/${registry.id}/test`,
      );
      setOutcome({ registry, ...result });
    } catch (err) {
      setOutcome({ registry, success: false, message: message(err) });
    } finally {
      setChecking(null);
    }
  }

  async function deleteRegistry(registry: Registry) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/registries/${registry.id}`);
      setDeleting(null);
      void registries.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="editor-origin" hidden={Boolean(editing)}>
        <PageHeader
          eyebrow="IMAGE DISTRIBUTION"
          title="镜像仓库"
          description="配置 Registry 地址与凭据引用，为管理端镜像构建和多服务器部署提供分发通道。"
          action={
            canManage && (
              <button className="button primary" onClick={() => open('new')}>
                <Plus size={16} />
                添加 Registry
              </button>
            )
          }
        />
        <ErrorBanner error={registries.error} />
        <Section title="Registry" subtitle="连接测试从管理端访问 Registry V2">
          {registries.loading ? (
            <Loading />
          ) : !registries.data?.length ? (
            <Empty
              title="暂无镜像仓库"
              description="文件部署无需配置 Registry；Docker 镜像分发时再添加。"
            />
          ) : (
            <div className="resource-list">
              {registries.data.map((r) => (
                <div className="resource-row registry-row" key={r.id}>
                  <span className="resource-avatar">
                    <Boxes size={20} />
                  </span>
                  <div>
                    <strong>{r.name}</strong>
                    <small>{r.registryUrl}</small>
                  </div>
                  <span className="tag">{r.credentialId ? '已关联凭据' : '匿名访问'}</span>
                  {canManage && (
                    <span className="row-actions">
                      <button
                        className="button compact"
                        disabled={checking !== null}
                        onClick={() => void check(r)}
                      >
                        <ShieldCheck size={14} /> {checking === r.id ? '测试中…' : '测试连接'}
                      </button>
                      <button
                        className="button compact"
                        disabled={checking !== null}
                        onClick={() => open(r)}
                      >
                        <Pencil size={14} /> 编辑
                      </button>
                      <button
                        className="button compact"
                        aria-label={`删除 ${r.name}`}
                        disabled={checking !== null}
                        onClick={() => {
                          setError('');
                          setDeleting(r);
                        }}
                      >
                        <Trash2 size={14} /> 删除
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
        {deleting && (
          <Confirm
            title="删除镜像仓库"
            description={`从 VeyOps 移除 ${deleting.name} 的连接配置。`}
            onClose={() => !busy && setDeleting(null)}
            onConfirm={() => void deleteRegistry(deleting)}
            busy={busy}
            error={error}
            label="删除仓库"
            destructive
          />
        )}
      </div>
      {outcome && (
        <Modal title={`${outcome.registry.name} · 连接测试`} onClose={() => setOutcome(undefined)}>
          {outcome.success ? (
            <p role="status">{outcome.message}</p>
          ) : (
            <ErrorBanner error={outcome.message} />
          )}
        </Modal>
      )}
      {editing && (
        <InlineEditor
          busy={busy}
          title={current ? '编辑镜像仓库' : '添加镜像仓库'}
          onClose={() => !busy && setEditing(undefined)}
        >
          <Form
            onSubmit={save}
            onCancel={() => setEditing(undefined)}
            error={error || credentials.error}
            busy={busy || credentials.loading}
          >
            <Field label="名称" required>
              <input name="name" required maxLength={120} defaultValue={current?.name} />
            </Field>
            <Field
              label="Registry 地址"
              required
              hint="填写主机名和可选端口，不带协议或路径，例如 registry.example.com"
            >
              <input
                name="registryUrl"
                required
                maxLength={259}
                placeholder="registry.example.com"
                value={address}
                onChange={(event) => {
                  if (current && address === current.registryUrl && event.target.value !== address)
                    setCredentialId('');
                  setAddress(event.target.value);
                }}
              />
            </Field>
            <Field
              label="Registry 凭据"
              hint={
                current?.credentialId && address !== current.registryUrl
                  ? '地址已变更，请确认新地址使用的凭据。'
                  : undefined
              }
            >
              <select
                name="credentialId"
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
              >
                <option value="">匿名访问</option>
                {current?.credentialId &&
                  !availableCredentials?.some((c) => c.id === current.credentialId) && (
                    <option value={current.credentialId}>原凭据不可用</option>
                  )}
                {availableCredentials?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <p className="muted">需要认证时，请先在凭据中心创建 Docker Registry 凭据。</p>
          </Form>
        </InlineEditor>
      )}
    </>
  );
}
