import { InlineEditor, useInlineEditor } from '../InlineEditor';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check } from 'lucide-react';
import { api, formatTime, message, useResource } from '../api';
import { Empty, ErrorBanner, Field, Form, Loading, Section } from '../components';
import type {
  DeploymentRecord,
  DeploymentSelection,
  ProjectDetail,
  ReleasePolicy,
  User,
} from '../models';
import { ArtifactRetentionPolicy } from './ArtifactRetention';
import { FailureHandling } from './FailureHandling';
import { ProjectServerInventory, type ServiceEnvironmentContext } from './ProjectServerInventory';
import {
  DeploymentSelectionPicker,
  deploymentSelection,
  hasDeploymentSelection,
  useDeploymentInventory,
} from './DeploymentSelection';

type EnvironmentConfig = DeploymentSelection & {
  executionMode?: 'DEPLOY' | 'BUILD_ONLY' | null;
  buildLocation: string | null;
  artifactType: string;
  deployMethod: string;
  deployPath?: string;
  workingDirectory?: string;
  buildCommand?: string;
  outputPath?: string;
  composeFilePath?: string;
  startCommand?: string;
  stopCommand?: string;
  healthCheckCommand?: string;
  releasePolicy?: ReleasePolicy;
};
export function ProjectDeploymentConfig({
  project,
  user,
  reloadProject,
  initialEnvironment,
}: {
  project: ProjectDetail;
  user: User;
  reloadProject: () => Promise<void>;
  initialEnvironment?: ServiceEnvironmentContext;
}) {
  const [selected, setSelected] = useInlineEditor<ServiceEnvironmentContext>(initialEnvironment);
  const [binding, setBinding] = useInlineEditor<string>();
  return (
    <Section
      title="服务与部署配置"
      subtitle="绑定代码仓库，并为每个服务和环境设置可独立覆盖的部署配置"
      action={
        <a className="text-link" href={`#/projects/${project.id}/execution-graph`}>
          打开 执行流 →
        </a>
      }
    >
      <div hidden={Boolean(selected || binding)}>
        {!project.services.length ? (
          <Empty
            title="先创建服务"
            description="创建服务与环境后，可在这里设置仓库关联和部署配置。"
          />
        ) : (
          <div className="resource-list">
            {project.services.map((s) => (
              <div className="deployment-service-row" key={s.id}>
                <div>
                  <strong>{s.name}</strong>
                  <span className="tag">{s.serviceType}</span>
                </div>
                <div className="deployment-service-actions">
                  {project.environments.map((e) => (
                    <button
                      className="button secondary small"
                      key={e.id}
                      onClick={() => setSelected({ serviceId: s.id, environmentId: e.id })}
                    >
                      {e.name} 配置
                    </button>
                  ))}
                  {user.role !== 'VIEWER' && (
                    <button className="text-button" onClick={() => setBinding(s.id)}>
                      关联仓库
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {selected && (
        <EnvironmentConfigEditor
          key={`${selected.serviceId}:${selected.environmentId}`}
          project={project}
          serviceId={selected.serviceId}
          environmentId={selected.environmentId}
          user={user}
          onClose={() => setSelected(undefined)}
          onSaved={() => {
            setSelected(undefined);
            void reloadProject();
          }}
        />
      )}
      {binding && (
        <RepositoryBinding
          project={project}
          serviceId={binding}
          onClose={() => setBinding(undefined)}
        />
      )}
    </Section>
  );
}
function EnvironmentConfigEditor({
  project,
  serviceId,
  environmentId,
  user,
  onClose,
  onSaved,
}: {
  project: ProjectDetail;
  serviceId: string;
  environmentId: string;
  user: User;
  onClose: () => void;
  onSaved: () => void;
}) {
  const config = useResource<EnvironmentConfig | null>(
    `/services/${serviceId}/environments/${environmentId}/config`,
  );
  const inventory = useDeploymentInventory();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [artifactType, setArtifactType] = useState('FILE');
  const [selection, setSelection] = useState<DeploymentSelection>(() => deploymentSelection());
  const [editRetention, setEditRetention] = useState(false);
  const [tab, setTab] = useState<'settings' | 'servers' | 'reviews' | 'failure'>('settings');
  useEffect(() => {
    setArtifactType(config.data?.artifactType || 'FILE');
    setSelection(deploymentSelection(config.data));
  }, [config.data]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || user.role === 'VIEWER') return;
    if (!hasDeploymentSelection(selection)) {
      setError('请选择服务器或服务器分组。');
      return;
    }
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api(`/services/${serviceId}/environments/${environmentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          ...selection,
          buildLocation: f.get('buildLocation') || null,
          executionMode: f.get('executionMode') || null,
          artifactType: f.get('artifactType'),
          deployMethod: f.get('deployMethod'),
          deployPath: f.get('deployPath'),
          workingDirectory: f.get('workingDirectory'),
          buildCommand: f.get('buildCommand'),
          outputPath: f.get('outputPath'),
          composeFilePath: f.get('composeFilePath'),
          startCommand: f.get('startCommand'),
          stopCommand: f.get('stopCommand') ?? undefined,
          healthCheckCommand: f.get('healthCheckCommand'),
          ...(user.role === 'ADMIN' && {
            releasePolicy: {
              requireApproval: f.has('requireReleaseApproval'),
              requireCodeReview: f.has('requireCodeReview'),
              rollbackMode: f.get('rollbackMode'),
              pinnedDeploymentId: f.get('pinnedDeploymentId') || undefined,
              archivePushedImage: f.has('archivePushedImage'),
              healthCheck: {
                httpUrl: String(f.get('healthHttpUrl') || '').trim() || undefined,
                compose: f.has('healthCompose'),
                attempts: Number(f.get('healthAttempts')),
                intervalSeconds: Number(f.get('healthIntervalSeconds')),
                timeoutSeconds: Number(f.get('healthTimeoutSeconds')),
              },
            },
          }),
        }),
      });
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor
      busy={busy}
      title={`${project.services.find((s) => s.id === serviceId)?.name} · ${project.environments.find((e) => e.id === environmentId)?.name}`}
      description="此处配置覆盖 执行流 对应字段；留空的命令或路径由流程配置提供。"
      onClose={onClose}
      wide
    >
      <nav className="resource-section-switcher" aria-label="服务环境配置">
        <button type="button" aria-pressed={tab === 'settings'} onClick={() => setTab('settings')}>
          部署设置
        </button>
        <button type="button" aria-pressed={tab === 'servers'} onClick={() => setTab('servers')}>
          服务器及来源
        </button>
        <button type="button" aria-pressed={tab === 'reviews'} onClick={() => setTab('reviews')}>
          代码审核
        </button>
        <button type="button" aria-pressed={tab === 'failure'} onClick={() => setTab('failure')}>
          故障处理
        </button>
      </nav>
      {tab === 'servers' && (
        <ProjectServerInventory project={project} scope={{ serviceId, environmentId }} />
      )}
      {tab === 'failure' && (
        <FailureHandling user={user} serviceId={serviceId} environmentId={environmentId} />
      )}
      {tab === 'reviews' && (
        <SourceReviews
          projectId={project.id}
          serviceId={serviceId}
          environmentId={environmentId}
          canReview={user.role === 'ADMIN'}
          required={config.data?.releasePolicy?.requireCodeReview === true}
        />
      )}
      <div hidden={tab !== 'settings'}>
        {config.loading ? (
          <Loading />
        ) : config.error ? (
          <div className="form-body">
            <ErrorBanner error={config.error} retry={config.reload} />
          </div>
        ) : (
          <Form
            onSubmit={save}
            onCancel={onClose}
            busy={busy || user.role === 'VIEWER'}
            error={error}
            submit={user.role === 'VIEWER' ? '只读用户' : '保存环境配置'}
          >
            <fieldset disabled={user.role === 'VIEWER'}>
              {config.data?.targetId && !hasDeploymentSelection(selection) && (
                <p className="field-note">请重新选择此环境的服务器或服务器分组。</p>
              )}
              <DeploymentSelectionPicker
                projectId={project.id}
                inventory={inventory}
                value={selection}
                onChange={setSelection}
                disabled={busy || user.role === 'VIEWER'}
              />
              <div className="form-grid">
                <Field label="构建位置">
                  <select name="buildLocation" defaultValue={config.data?.buildLocation || ''}>
                    <option value="">沿用执行流构建位置</option>
                    <option value="TARGET">目标服务器</option>
                    <option value="MANAGER">管理端隔离环境</option>
                  </select>
                </Field>
                <Field label="运行模式">
                  <select name="executionMode" defaultValue={config.data?.executionMode || ''}>
                    <option value="">沿用执行流默认模式</option>
                    <option value="BUILD_ONLY">仅构建</option>
                    <option value="DEPLOY">构建并部署</option>
                  </select>
                </Field>
                <Field label="产物类型">
                  <select
                    name="artifactType"
                    value={artifactType}
                    onChange={(e) => setArtifactType(e.target.value)}
                  >
                    <option value="FILE">文件产物</option>
                    <option value="DOCKER_IMAGE">Docker 镜像</option>
                  </select>
                </Field>
              </div>
              <div className="form-grid">
                <Field label="部署方式">
                  <select
                    name="deployMethod"
                    value={artifactType === 'FILE' ? 'FILE' : 'DOCKER_COMPOSE'}
                    onChange={() => undefined}
                  >
                    <option value="FILE">文件部署</option>
                    <option value="DOCKER_COMPOSE">Docker Compose</option>
                  </select>
                </Field>
                <Field label="仓库工作目录">
                  <input
                    name="workingDirectory"
                    defaultValue={config.data?.workingDirectory}
                    placeholder="如 apps/web，留空继承 执行流"
                  />
                </Field>
              </div>
              <Field label="部署目录">
                <input
                  name="deployPath"
                  defaultValue={config.data?.deployPath}
                  placeholder="继承 执行流"
                />
              </Field>
              <Field label="构建命令">
                <input
                  className="mono"
                  name="buildCommand"
                  defaultValue={config.data?.buildCommand}
                  placeholder="继承 执行流"
                />
              </Field>
              <div className="form-grid">
                <Field label="产物目录">
                  <input
                    name="outputPath"
                    defaultValue={config.data?.outputPath}
                    placeholder="继承 执行流"
                  />
                </Field>
                <Field label="Compose 文件路径">
                  <input
                    name="composeFilePath"
                    defaultValue={config.data?.composeFilePath}
                    placeholder="继承 执行流"
                  />
                </Field>
              </div>
              <Field label="启动命令">
                <textarea
                  className="mono"
                  name="startCommand"
                  rows={2}
                  defaultValue={config.data?.startCommand}
                />
              </Field>
              {artifactType === 'FILE' && (
                <Field label="停止命令" hint="替换该版本时执行。命令应只停止本服务。">
                  <textarea
                    className="mono"
                    name="stopCommand"
                    rows={2}
                    defaultValue={config.data?.stopCommand}
                    placeholder="继承 执行流"
                  />
                </Field>
              )}
              <Field label="健康检查命令">
                <textarea
                  className="mono"
                  name="healthCheckCommand"
                  rows={2}
                  defaultValue={config.data?.healthCheckCommand}
                />
              </Field>
              <fieldset disabled={user.role !== 'ADMIN'}>
                <ReleasePolicyFields
                  policy={config.data?.releasePolicy}
                  projectId={project.id}
                  serviceId={serviceId}
                  environmentId={environmentId}
                  composeDeployment={artifactType === 'DOCKER_IMAGE'}
                />
                {user.role === 'ADMIN' && (
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => setEditRetention(true)}
                  >
                    环境产物保留策略
                  </button>
                )}
              </fieldset>
            </fieldset>
          </Form>
        )}
      </div>
      {editRetention && (
        <ArtifactRetentionPolicy
          scope={{ serviceId, environmentId }}
          onClose={() => setEditRetention(false)}
        />
      )}
    </InlineEditor>
  );
}
function ReleasePolicyFields({
  policy,
  projectId,
  serviceId,
  environmentId,
  composeDeployment,
}: {
  policy?: ReleasePolicy;
  projectId: string;
  serviceId: string;
  environmentId: string;
  composeDeployment: boolean;
}) {
  const [mode, setMode] = useState<ReleasePolicy['rollbackMode']>(policy?.rollbackMode ?? 'OFF');
  const history = useResource<DeploymentRecord[]>(
    mode === 'PINNED' ? `/deployments?projectId=${encodeURIComponent(projectId)}` : null,
  );
  const candidates = history.data?.filter(
    (record) =>
      record.serviceId === serviceId &&
      record.environmentId === environmentId &&
      record.healthStatus === 'HEALTHY' &&
      record.rollbackAvailable,
  );
  const pinned = policy?.pinnedDeploymentId;
  return (
    <>
      <h3 className="field-title">发布保护</h3>
      <label className="checkbox-row">
        <input
          name="requireReleaseApproval"
          type="checkbox"
          defaultChecked={policy?.requireApproval}
        />
        <span>部署前需要审批</span>
      </label>
      <label className="checkbox-row">
        <input
          name="requireCodeReview"
          type="checkbox"
          defaultChecked={policy?.requireCodeReview}
        />
        <span>要求产物的 Git 提交通过代码审核</span>
      </label>
      {composeDeployment && (
        <label className="checkbox-row">
          <input
            name="archivePushedImage"
            type="checkbox"
            defaultChecked={policy?.archivePushedImage}
          />
          <span>推送 Registry 后保留离线镜像归档</span>
        </label>
      )}
      <Field label="自动回滚策略" hint="发布激活后确认失败时按此策略恢复。">
        <select
          name="rollbackMode"
          value={mode}
          onChange={(event) => setMode(event.target.value as ReleasePolicy['rollbackMode'])}
        >
          <option value="OFF">关闭</option>
          <option value="PREVIOUS_HEALTHY">恢复目标上一次健康发布</option>
          <option value="PINNED">恢复指定的历史发布</option>
        </select>
      </Field>
      {mode === 'PINNED' && (
        <>
          <ErrorBanner error={history.error} retry={history.reload} />
          <Field label="回滚基线" required>
            <select name="pinnedDeploymentId" defaultValue={pinned ?? ''} required>
              <option value="">{history.loading ? '正在查询发布历史' : '选择历史发布'}</option>
              {pinned && !candidates?.some((record) => record.id === pinned) && (
                <option value={pinned}>当前已固定 · {pinned.slice(0, 8)}</option>
              )}
              {candidates?.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.releaseVersion?.slice(0, 12) || record.id.slice(0, 8)} ·{' '}
                  {formatTime(record.finishedAt)} · {record.serverId.slice(0, 8)}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <h3 className="field-title">发布健康检查</h3>
      <Field label="HTTP 检查地址" hint="由目标服务器请求，使用不含凭据的 HTTP 或 HTTPS 地址。">
        <input
          name="healthHttpUrl"
          type="url"
          placeholder="http://127.0.0.1:8080/health"
          defaultValue={policy?.healthCheck.httpUrl ?? ''}
        />
      </Field>
      {composeDeployment && (
        <label className="checkbox-row">
          <input
            name="healthCompose"
            type="checkbox"
            defaultChecked={policy?.healthCheck.compose}
          />
          <span>检查 Compose 容器的健康状态</span>
        </label>
      )}
      <div className="form-grid">
        <Field label="检查次数" required>
          <input
            name="healthAttempts"
            type="number"
            min={1}
            max={20}
            defaultValue={policy?.healthCheck.attempts ?? 1}
            required
          />
        </Field>
        <Field label="重试间隔（秒）" required>
          <input
            name="healthIntervalSeconds"
            type="number"
            min={0}
            max={60}
            defaultValue={policy?.healthCheck.intervalSeconds ?? 0}
            required
          />
        </Field>
        <Field label="单次超时（秒）" required>
          <input
            name="healthTimeoutSeconds"
            type="number"
            min={1}
            max={300}
            defaultValue={policy?.healthCheck.timeoutSeconds ?? 120}
            required
          />
        </Field>
      </div>
    </>
  );
}
interface SourceReview {
  id: string;
  commitSha: string;
  decision: 'APPROVED' | 'REVOKED';
  reason?: string | null;
  reviewer?: string;
  updatedAt: number;
}

function SourceReviews({
  projectId,
  serviceId,
  environmentId,
  canReview,
  required,
}: {
  projectId: string;
  serviceId: string;
  environmentId: string;
  canReview: boolean;
  required: boolean;
}) {
  const path = `/projects/${projectId}/services/${serviceId}/environments/${environmentId}/source-reviews`;
  const reviews = useResource<SourceReview[]>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canReview) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const sha = String(values.get('commitSha') || '')
      .trim()
      .toLowerCase();
    const decision = values.get('decision');
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = await api<SourceReview>(path + '/' + encodeURIComponent(sha), {
        method: 'PUT',
        body: JSON.stringify({ decision, reason: String(values.get('reason') || '').trim() }),
      });
      form.reset();
      setNotice(saved.decision === 'APPROVED' ? '已记录代码审核通过。' : '已撤销代码审核。');
      await reviews.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-body">
      <p className="field-note">
        {required
          ? '本服务环境只允许发布已通过代码审核的 Git 提交。'
          : '可预先记录审核结论。在部署设置启用代码审核后，系统会按产物的 Git 提交检查。'}
      </p>
      {canReview && (
        <form onSubmit={(event) => void save(event)} className="resource-form">
          <fieldset disabled={busy}>
            <Field label="已审核的完整 Git 提交 SHA" required>
              <input
                name="commitSha"
                className="mono"
                pattern="[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64}"
                maxLength={64}
                spellCheck={false}
                required
              />
            </Field>
            <Field label="审核结论">
              <select name="decision">
                <option value="APPROVED">审核通过</option>
                <option value="REVOKED">撤销审核通过</option>
              </select>
            </Field>
            <Field label="审核说明">
              <textarea name="reason" rows={2} maxLength={1000} />
            </Field>
            <button type="submit" className="button primary small">
              <Check size={16} /> 保存审核结论
            </button>
          </fieldset>
        </form>
      )}
      <ErrorBanner error={error} />
      {notice && <p role="status">{notice}</p>}
      <ErrorBanner error={reviews.error} retry={reviews.reload} />
      {reviews.loading && <Loading />}
      {reviews.data?.length === 0 && <p className="muted">暂无代码审核记录。</p>}
      {!!reviews.data?.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Git 提交</th>
                <th>结论</th>
                <th>审核人</th>
                <th>更新时间</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {reviews.data.map((row) => (
                <tr key={row.id}>
                  <td>
                    <code>{row.commitSha}</code>
                  </td>
                  <td>{row.decision === 'APPROVED' ? '已通过' : '已撤销'}</td>
                  <td>{row.reviewer || '—'}</td>
                  <td>{formatTime(row.updatedAt)}</td>
                  <td>{row.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RepositoryBinding({
  project,
  serviceId,
  onClose,
}: {
  project: ProjectDetail;
  serviceId: string;
  onClose: () => void;
}) {
  const existing = useResource<{ repositoryId: string; repoPath: string; isPrimary: boolean }[]>(
    `/services/${serviceId}/repositories`,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (existing.data) {
      const ordered = [...existing.data].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      setSelected(ordered.map((r) => r.repositoryId));
      setPaths(Object.fromEntries(ordered.map((r) => [r.repositoryId, r.repoPath])));
    }
  }, [existing.data]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!selected.length) {
      setError('请至少选择一个仓库');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/services/${serviceId}/repositories`, {
        method: 'PUT',
        body: JSON.stringify({
          repositories: selected.map((id, i) => ({
            repositoryId: id,
            repoPath: paths[id] || '.',
            isPrimary: i === 0,
          })),
        }),
      });
      onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor
      busy={busy}
      title="设置服务仓库关联"
      description="保存将替换该服务的仓库关联。第一个选中的仓库作为主仓库。"
      onClose={onClose}
    >
      <Form
        onSubmit={save}
        onCancel={onClose}
        error={error}
        busy={busy || existing.loading || !!existing.error}
      >
        <ErrorBanner error={existing.error} retry={existing.reload} />
        {project.repositories.map((r) => (
          <div className="repository-binding" key={r.id}>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id),
                  )
                }
              />
              {r.name}
              {selected[0] === r.id && (
                <span className="tag">
                  <Check size={11} />
                  主仓库
                </span>
              )}
            </label>
            {selected.includes(r.id) && (
              <Field label={`${r.name} 子目录`}>
                <input
                  value={paths[r.id] || '.'}
                  onChange={(e) => setPaths((v) => ({ ...v, [r.id]: e.target.value }))}
                />
              </Field>
            )}
          </div>
        ))}
        {!project.repositories.length && <p className="muted">请先在项目中添加仓库。</p>}
      </Form>
    </InlineEditor>
  );
}
