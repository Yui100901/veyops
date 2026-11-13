import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, Network, Pencil, Plus, Server as ServerIcon, Trash2 } from 'lucide-react';
import { api, message, post, remove, useResource } from '../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  Modal,
  PageHeader,
  Section,
} from '../components';
import type { ProjectDetail, Server, User } from '../models';
import type { DeploymentTarget } from './Delivery';

export function DeploymentTargetsPage({ user }: { user: User }) {
  const targets = useResource<DeploymentTarget[]>('/deployment-targets');
  const servers = useResource<Server[]>('/servers');
  const [editing, setEditing] = useState<Partial<DeploymentTarget>>();
  const [deleting, setDeleting] = useState<DeploymentTarget>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function deleteTarget() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/deployment-targets/${deleting.id}`);
      setDeleting(undefined);
      void targets.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="DEPLOYMENT RESOURCES"
        title="部署目标"
        description="将多台服务器组织成可复用的发布目标，并固定执行顺序、并发和失败策略。"
        action={
          user.role !== 'VIEWER' && (
            <button
              className="button primary"
              onClick={() => {
                setError('');
                setEditing({});
              }}
            >
              <Plus size={16} />
              创建部署目标
            </button>
          )
        }
      />
      <ErrorBanner error={targets.error || servers.error} retry={targets.reload} />
      <Section title="目标集合" subtitle="运行任务时保存目标快照，后续修改不会改变已经启动的任务">
        {targets.loading ? (
          <Loading />
        ) : !targets.data?.length ? (
          <Empty
            icon={<Network size={26} />}
            title="创建第一个部署目标"
            description="明确选择成员服务器，再设置并行或顺序部署策略。"
          />
        ) : (
          <div className="target-grid">
            {targets.data.map((t) => (
              <div className="target-card" key={t.id}>
                <div className="target-card-top">
                  <span className="resource-avatar">
                    <Network size={22} />
                  </span>
                  <strong>{t.name}</strong>
                  <span className="tag">{t.serverIds.length} 台</span>
                </div>
                <p>{t.description || '可复用的服务器执行集合'}</p>
                <div className="target-members">
                  {t.serverIds.map((id) => (
                    <span key={id}>
                      <ServerIcon size={13} />
                      {servers.data?.find((s) => s.id === id)?.name || id.slice(0, 8)}
                    </span>
                  ))}
                </div>
                <div className="target-card-footer">
                  <small>
                    {t.strategy === 'SEQUENTIAL' ? '顺序执行' : `并行 · 最大 ${t.maxParallel} 台`} ·{' '}
                    {t.failurePolicy === 'STOP' ? '失败停止' : '失败继续'}
                  </small>
                  {user.role !== 'VIEWER' && (
                    <div>
                      <button
                        className="text-button"
                        onClick={() => {
                          setError('');
                          setEditing(t);
                        }}
                      >
                        <Pencil size={14} />
                        编辑
                      </button>
                      <button
                        className="text-button danger-text"
                        onClick={() => {
                          setError('');
                          setDeleting(t);
                        }}
                        aria-label={`删除目标 ${t.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
      {editing && (
        <TargetEditor
          target={editing}
          servers={servers.data || []}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void targets.reload();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="删除部署目标"
          description={`确认删除“${deleting.name}”？已经保存的任务历史会保留。被环境配置引用的目标需先解除关联。`}
          destructive
          onClose={() => setDeleting(undefined)}
          onConfirm={deleteTarget}
          busy={busy}
          error={error}
        />
      )}
    </>
  );
}
function TargetEditor({
  target,
  servers,
  onClose,
  onSaved,
}: {
  target: Partial<DeploymentTarget>;
  servers: Server[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [ids, setIds] = useState(target.serverIds || []);
  const [strategy, setStrategy] = useState(target.strategy || 'PARALLEL');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ids.length) {
      setError('请至少选择一台服务器');
      return;
    }
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      const body = {
        name: String(f.get('name')),
        description: String(f.get('description')),
        serverIds: ids,
        strategy,
        maxParallel: strategy === 'SEQUENTIAL' ? 1 : Number(f.get('maxParallel')),
        failurePolicy: f.get('failurePolicy'),
      };
      if (target.id)
        await api(`/deployment-targets/${target.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      else await post('/deployment-targets', body);
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={target.id ? '编辑部署目标' : '创建部署目标'} onClose={onClose}>
      <Form onSubmit={save} onCancel={onClose} busy={busy} error={error}>
        <Field label="名称" required>
          <input name="name" defaultValue={target.name} required maxLength={100} autoFocus />
        </Field>
        <Field label="描述">
          <input name="description" defaultValue={target.description} maxLength={2000} />
        </Field>
        <h3 className="field-title">成员服务器 · 已选择 {ids.length} 台</h3>
        <p className="muted">按选择顺序执行。取消后重新选择可调整成员顺序。</p>
        <div className="server-picker">
          {servers.map((s) => (
            <label className={`server-option ${ids.includes(s.id) ? 'selected' : ''}`} key={s.id}>
              <input
                type="checkbox"
                checked={ids.includes(s.id)}
                onChange={(e) =>
                  setIds(e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id))
                }
              />
              <ServerIcon size={16} />
              <span>
                <strong>{s.name}</strong>
                <small>{s.host}</small>
              </span>
              {ids.includes(s.id) && <span className="tag">{ids.indexOf(s.id) + 1}</span>}
            </label>
          ))}
        </div>
        <div className="form-grid">
          <Field label="执行方式">
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as 'PARALLEL' | 'SEQUENTIAL')}
            >
              <option value="PARALLEL">并行执行</option>
              <option value="SEQUENTIAL">顺序执行</option>
            </select>
          </Field>
          <Field label="最大并发">
            <input
              type="number"
              name="maxParallel"
              disabled={strategy === 'SEQUENTIAL'}
              min={1}
              max={10}
              defaultValue={target.maxParallel || 3}
            />
          </Field>
        </div>
        <Field label="失败策略">
          <select name="failurePolicy" defaultValue={target.failurePolicy || 'CONTINUE'}>
            <option value="CONTINUE">继续其他目标</option>
            <option value="STOP">停止派发剩余目标</option>
          </select>
        </Field>
      </Form>
    </Modal>
  );
}

type EnvironmentConfig = {
  targetId: string;
  buildLocation: string;
  artifactType: string;
  deployMethod: string;
  deployPath?: string;
  workingDirectory?: string;
  buildCommand?: string;
  outputPath?: string;
  composeFilePath?: string;
  startCommand?: string;
  healthCheckCommand?: string;
};
export function ProjectDeploymentConfig({ project, user }: { project: ProjectDetail; user: User }) {
  const [selected, setSelected] = useState<{ serviceId: string; environmentId: string }>();
  const [binding, setBinding] = useState<string>();
  return (
    <Section
      title="服务与部署配置"
      subtitle="绑定代码仓库，并为每个服务和环境设置可独立覆盖的部署配置"
      action={
        <a className="text-link" href="#/pipelines">
          打开 Pipeline →
        </a>
      }
    >
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
      {selected && (
        <EnvironmentConfigEditor
          key={`${selected.serviceId}:${selected.environmentId}`}
          project={project}
          serviceId={selected.serviceId}
          environmentId={selected.environmentId}
          user={user}
          onClose={() => setSelected(undefined)}
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
}: {
  project: ProjectDetail;
  serviceId: string;
  environmentId: string;
  user: User;
  onClose: () => void;
}) {
  const config = useResource<EnvironmentConfig | null>(
    `/services/${serviceId}/environments/${environmentId}/config`,
  );
  const targets = useResource<DeploymentTarget[]>('/deployment-targets');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [artifactType, setArtifactType] = useState('FILE');
  useEffect(() => {
    setArtifactType(config.data?.artifactType || 'FILE');
  }, [config.data]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api(`/services/${serviceId}/environments/${environmentId}/config`, {
        method: 'PUT',
        body: JSON.stringify({
          targetId: f.get('targetId'),
          buildLocation: f.get('buildLocation'),
          artifactType: f.get('artifactType'),
          deployMethod: f.get('deployMethod'),
          deployPath: f.get('deployPath'),
          workingDirectory: f.get('workingDirectory'),
          buildCommand: f.get('buildCommand'),
          outputPath: f.get('outputPath'),
          composeFilePath: f.get('composeFilePath'),
          startCommand: f.get('startCommand'),
          healthCheckCommand: f.get('healthCheckCommand'),
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
    <Modal
      title={`${project.services.find((s) => s.id === serviceId)?.name} · ${project.environments.find((e) => e.id === environmentId)?.name}`}
      description="此处配置覆盖 Pipeline 对应字段；留空的命令或路径由流程配置提供。"
      onClose={onClose}
      wide
    >
      {config.loading ? (
        <Loading />
      ) : (
        <Form
          onSubmit={save}
          onCancel={onClose}
          busy={busy || user.role === 'VIEWER'}
          error={error}
          submit={user.role === 'VIEWER' ? '只读用户' : '保存环境配置'}
        >
          <ErrorBanner error={config.error || targets.error} />
          <fieldset disabled={user.role === 'VIEWER'}>
            <Field label="部署目标" required>
              <select name="targetId" required defaultValue={config.data?.targetId || ''}>
                <option value="">选择目标集合</option>
                {targets.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.serverIds.length} 台
                  </option>
                ))}
              </select>
            </Field>
            <div className="form-grid">
              <Field label="构建位置">
                <select name="buildLocation" defaultValue={config.data?.buildLocation || 'TARGET'}>
                  <option value="TARGET">目标服务器</option>
                  <option value="MANAGER">管理端隔离环境</option>
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
              <Field label="工作目录">
                <input
                  name="workingDirectory"
                  defaultValue={config.data?.workingDirectory}
                  placeholder="继承 Pipeline"
                />
              </Field>
            </div>
            <Field label="部署目录">
              <input
                name="deployPath"
                defaultValue={config.data?.deployPath}
                placeholder="继承 Pipeline"
              />
            </Field>
            <Field label="构建命令">
              <input
                className="mono"
                name="buildCommand"
                defaultValue={config.data?.buildCommand}
                placeholder="继承 Pipeline"
              />
            </Field>
            <div className="form-grid">
              <Field label="产物目录">
                <input
                  name="outputPath"
                  defaultValue={config.data?.outputPath}
                  placeholder="继承 Pipeline"
                />
              </Field>
              <Field label="Compose 文件路径">
                <input
                  name="composeFilePath"
                  defaultValue={config.data?.composeFilePath}
                  placeholder="继承 Pipeline"
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
            <Field label="健康检查命令">
              <textarea
                className="mono"
                name="healthCheckCommand"
                rows={2}
                defaultValue={config.data?.healthCheckCommand}
              />
            </Field>
          </fieldset>
        </Form>
      )}
    </Modal>
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
    <Modal
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
    </Modal>
  );
}
