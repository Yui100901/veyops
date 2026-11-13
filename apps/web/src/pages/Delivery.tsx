import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  GitBranch,
  History,
  Layers3,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
  Workflow,
} from 'lucide-react';
import { api, formatTime, message, navigate, post, useResource } from '../api';
import {
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
import type { Credential, Project, ProjectDetail, Task, User } from '../models';

export interface DeploymentTarget {
  id: string;
  name: string;
  description?: string;
  serverIds: string[];
  strategy: 'PARALLEL' | 'SEQUENTIAL';
  maxParallel: number;
  failurePolicy: 'CONTINUE' | 'STOP';
}
export interface PipelineDefinition {
  repositoryId: string;
  buildLocation: 'TARGET' | 'MANAGER';
  artifactType: 'FILE' | 'DOCKER_IMAGE';
  buildImage: string;
  repoPath: string;
  installCommand: string;
  buildCommand: string;
  outputPath: string;
  deployPath: string;
  startCommand: string;
  healthCheckCommand: string;
  dockerfilePath: string;
  composeFilePath: string;
  registryId?: string;
  imageRepository: string;
  steps?: { name: string; type: string; command: string; timeout?: number; location?: string }[];
}
export interface Pipeline {
  id: string;
  name: string;
  projectId: string;
  serviceId: string;
  currentVersion: number;
  enabled: boolean;
  definition: PipelineDefinition;
  createdAt?: number;
}
interface Registry {
  id: string;
  name: string;
  registryUrl: string;
  credentialId?: string;
}
const emptyDefinition: PipelineDefinition = {
  repositoryId: '',
  buildLocation: 'TARGET',
  artifactType: 'FILE',
  buildImage: 'node:22-bookworm',
  repoPath: '.',
  installCommand: 'npm ci',
  buildCommand: 'npm run build',
  outputPath: 'dist',
  deployPath: '',
  startCommand: '',
  healthCheckCommand: '',
  dockerfilePath: 'Dockerfile',
  composeFilePath: 'compose.yaml',
  imageRepository: '',
};
const buildLabels = { TARGET: '目标服务器构建', MANAGER: '管理端隔离构建' };

export function PipelinesPage({ user }: { user: User }) {
  const pipelines = useResource<Pipeline[]>('/pipelines');
  const projects = useResource<Project[]>('/projects');
  const [editing, setEditing] = useState<Partial<Pipeline>>();
  const [running, setRunning] = useState<Pipeline>();
  const [versions, setVersions] = useState<Pipeline>();
  useEffect(() => {
    const raw = sessionStorage.getItem('veyops:pipeline-draft');
    if (!raw || user.role === 'VIEWER') return;
    sessionStorage.removeItem('veyops:pipeline-draft');
    try {
      const value = JSON.parse(raw) as Partial<Pipeline>;
      setEditing(value);
    } catch {
      /* draft is optional */
    }
  }, [user.role]);
  return (
    <>
      <PageHeader
        eyebrow="CONTINUOUS DELIVERY"
        title="Pipeline"
        description="从固定 Commit 到部署结果，让每次交付都有版本、有产物、可追踪。"
        action={
          <>
            <RefreshButton onClick={pipelines.reload} />
            {user.role !== 'VIEWER' && (
              <button className="button primary" onClick={() => setEditing({})}>
                <Plus size={16} />
                创建 Pipeline
              </button>
            )}
          </>
        }
      />
      <ErrorBanner error={pipelines.error || projects.error} retry={pipelines.reload} />
      <div className="delivery-banner">
        <span className="resource-avatar">
          <Workflow size={25} />
        </span>
        <div>
          <strong>一个流程，两种构建位置</strong>
          <p>目标端就地构建，或管理端在独立容器中构建一次、分发同一产物。运行时固定配置与版本。</p>
        </div>
        <a className="text-link" href="#/targets">
          管理部署目标 →
        </a>
      </div>
      {pipelines.loading ? (
        <Loading />
      ) : !pipelines.data?.length ? (
        <div className="panel">
          <Empty
            icon={<GitBranch size={27} />}
            title="建立第一条交付流程"
            description="先创建项目、仓库、服务和部署目标，再定义构建与发布方式。"
            action={
              <a href="#/projects" className="button secondary">
                前往项目管理
              </a>
            }
          />
        </div>
      ) : (
        <div className="pipeline-grid">
          {pipelines.data.map((p) => (
            <section className="panel pipeline-card" key={p.id}>
              <div className="pipeline-card-top">
                <span className="resource-avatar">
                  <GitBranch size={22} />
                </span>
                <span className="tag">v{p.currentVersion}</span>
              </div>
              <h2>{p.name}</h2>
              <p>
                {projects.data?.find((v) => v.id === p.projectId)?.name || '项目'}
                <span className="muted">
                  {' '}
                  · {p.definition?.artifactType === 'DOCKER_IMAGE' ? 'Docker 镜像' : '文件产物'}
                </span>
              </p>
              <div className="pipeline-route">
                <span>检出代码</span>
                <i />
                <span>构建产物</span>
                <i />
                <span>部署验证</span>
              </div>
              <div className="pipeline-meta">
                <span>{buildLabels[p.definition?.buildLocation] || '目标服务器构建'}</span>
                <Status value={p.enabled ? 'ACTIVE' : 'DISABLED'} />
              </div>
              <div className="pipeline-card-actions">
                <button className="text-button" onClick={() => setVersions(p)}>
                  <History size={15} />
                  版本
                </button>
                {user.role !== 'VIEWER' && (
                  <>
                    <button className="text-button" onClick={() => setEditing(p)}>
                      <Pencil size={15} />
                      编辑
                    </button>
                    <button
                      className="button primary small"
                      disabled={!p.enabled}
                      onClick={() => setRunning(p)}
                    >
                      <Play size={14} />
                      运行
                    </button>
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
      {editing && (
        <PipelineEditor
          pipeline={editing}
          projects={projects.data || []}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void pipelines.reload();
          }}
        />
      )}
      {running && <RunPipeline pipeline={running} onClose={() => setRunning(undefined)} />}
      {versions && <PipelineVersions pipeline={versions} onClose={() => setVersions(undefined)} />}
    </>
  );
}

function PipelineEditor({
  pipeline,
  projects,
  onClose,
  onSaved,
}: {
  pipeline: Partial<Pipeline>;
  projects: Project[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [projectId, setProjectId] = useState(pipeline.projectId || '');
  const [name, setName] = useState(pipeline.name || '');
  const [serviceId, setServiceId] = useState(pipeline.serviceId || '');
  const [enabled, setEnabled] = useState(pipeline.enabled ?? true);
  const [definition, setDefinition] = useState<PipelineDefinition>({
    ...emptyDefinition,
    ...pipeline.definition,
  });
  const project = useResource<ProjectDetail>(projectId ? `/projects/${projectId}` : null);
  const registries = useResource<Registry[]>('/registries');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function field<K extends keyof PipelineDefinition>(key: K, value: PipelineDefinition[K]) {
    setDefinition((v) => ({ ...v, [key]: value }));
  }
  function changeProject(id: string) {
    setProjectId(id);
    setServiceId('');
    field('repositoryId', '');
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        name,
        ...(pipeline.id ? {} : { projectId, serviceId }),
        enabled,
        definition: {
          ...definition,
          registryId: definition.registryId || undefined,
          imageRepository: definition.imageRepository || undefined,
        },
      };
      await api(`/pipelines${pipeline.id ? `/${pipeline.id}` : ''}`, {
        method: pipeline.id ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={pipeline.id ? '编辑 Pipeline' : '创建 Pipeline'}
      description={
        pipeline.id
          ? '保存后追加新版本，已经启动的任务继续使用原版本。'
          : '关联项目与服务，定义构建和部署过程。'
      }
      onClose={onClose}
      wide
    >
      <Form
        onSubmit={save}
        onCancel={onClose}
        busy={busy}
        error={error}
        submit={pipeline.id ? '保存新版本' : '创建 Pipeline'}
      >
        <ErrorBanner error={project.error || registries.error} />
        <div className="form-section-heading">
          <span>01</span>
          <h3>关联资源</h3>
        </div>
        <Field label="流程名称" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
            autoFocus
          />
        </Field>
        <div className="form-grid">
          <Field label="项目" required>
            <select
              value={projectId}
              disabled={!!pipeline.id}
              required
              onChange={(e) => changeProject(e.target.value)}
            >
              <option value="">选择项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="服务" required>
            <select
              value={serviceId}
              disabled={!!pipeline.id}
              required
              onChange={(e) => setServiceId(e.target.value)}
            >
              <option value="">选择服务</option>
              {project.data?.services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label="仓库" required>
            <select
              value={definition.repositoryId}
              required
              onChange={(e) => field('repositoryId', e.target.value)}
            >
              <option value="">选择仓库</option>
              {project.data?.repositories.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="仓库子目录" hint="Monorepo 子目录，默认 .">
            <input
              value={definition.repoPath}
              onChange={(e) => field('repoPath', e.target.value)}
              required
            />
          </Field>
        </div>
        <div className="form-section-heading">
          <span>02</span>
          <h3>构建方式</h3>
        </div>
        <div className="form-grid">
          <Field label="构建位置">
            <select
              value={definition.buildLocation}
              onChange={(e) => field('buildLocation', e.target.value as 'TARGET' | 'MANAGER')}
            >
              <option value="TARGET">目标服务器构建</option>
              <option value="MANAGER">管理端隔离构建</option>
            </select>
          </Field>
          <Field label="产物类型">
            <select
              value={definition.artifactType}
              onChange={(e) => field('artifactType', e.target.value as 'FILE' | 'DOCKER_IMAGE')}
            >
              <option value="FILE">文件产物</option>
              <option value="DOCKER_IMAGE">Docker 镜像</option>
            </select>
          </Field>
        </div>
        {definition.buildLocation === 'MANAGER' && (
          <Field
            label="隔离构建镜像"
            hint="管理端需要配置可用的 Docker；不在平台进程执行仓库脚本。"
          >
            <input
              value={definition.buildImage}
              required
              onChange={(e) => field('buildImage', e.target.value)}
            />
          </Field>
        )}
        <div className="form-grid">
          <Field label="依赖安装命令" hint="可留空，跳过依赖安装。">
            <input
              className="mono"
              value={definition.installCommand}
              onChange={(e) => field('installCommand', e.target.value)}
            />
          </Field>
          <Field label="构建命令" hint="以构建环境用户身份执行。">
            <input
              className="mono"
              value={definition.buildCommand}
              onChange={(e) => field('buildCommand', e.target.value)}
            />
          </Field>
        </div>
        {definition.artifactType === 'FILE' ? (
          <Field label="产物目录" required hint="相对于仓库子目录，例如 dist、build。">
            <input
              value={definition.outputPath}
              required
              onChange={(e) => field('outputPath', e.target.value)}
            />
          </Field>
        ) : (
          <>
            <div className="form-grid">
              <Field label="Dockerfile 路径">
                <input
                  value={definition.dockerfilePath}
                  onChange={(e) => field('dockerfilePath', e.target.value)}
                  required
                />
              </Field>
              <Field label="镜像仓库名称" required>
                <input
                  value={definition.imageRepository}
                  placeholder="registry.example.com/team/service"
                  required
                  onChange={(e) => field('imageRepository', e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Registry"
              hint="管理端构建镜像需要推送 Registry，目标端从 Registry 拉取。"
            >
              <select
                value={definition.registryId || ''}
                required={definition.buildLocation === 'MANAGER'}
                onChange={(e) => field('registryId', e.target.value)}
              >
                <option value="">不使用 Registry</option>
                {registries.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.registryUrl}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
        <div className="form-section-heading">
          <span>03</span>
          <h3>部署与检查</h3>
        </div>
        <Field
          label="部署根目录"
          required
          hint="使用专属目录，例如 /opt/veyops/my-service；发布到版本目录后切换 current。"
        >
          <input
            value={definition.deployPath}
            placeholder="/opt/veyops/my-service"
            required
            onChange={(e) => field('deployPath', e.target.value)}
          />
        </Field>
        {definition.artifactType === 'DOCKER_IMAGE' && (
          <Field label="Compose 文件路径" required>
            <input
              value={definition.composeFilePath}
              required
              onChange={(e) => field('composeFilePath', e.target.value)}
            />
          </Field>
        )}
        <Field label="启动命令（可选）" hint="文件部署完成后执行。请确认仅影响本服务。">
          <textarea
            className="mono"
            rows={2}
            value={definition.startCommand}
            onChange={(e) => field('startCommand', e.target.value)}
          />
        </Field>
        <Field
          label="健康检查命令（可选）"
          hint="退出码 0 表示健康，例如 curl --fail http://127.0.0.1:8080/health。"
        >
          <textarea
            className="mono"
            rows={2}
            value={definition.healthCheckCommand}
            onChange={(e) => field('healthCheckCommand', e.target.value)}
          />
        </Field>
        <details className="advanced-options">
          <summary>自定义 Shell 步骤 · {definition.steps?.length || 0} 步</summary>
          <p className="muted">按顺序追加自定义步骤。每次修改生成新版本。</p>
          {(definition.steps || []).map((step, index) => (
            <div className="custom-step" key={index}>
              <div className="form-grid">
                <Field label={`步骤 ${index + 1} 名称`}>
                  <input
                    required
                    value={step.name}
                    onChange={(e) =>
                      field(
                        'steps',
                        definition.steps!.map((s, i) =>
                          i === index ? { ...s, name: e.target.value } : s,
                        ),
                      )
                    }
                  />
                </Field>
                <Field label="超时（秒）">
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    value={step.timeout || 300}
                    onChange={(e) =>
                      field(
                        'steps',
                        definition.steps!.map((s, i) =>
                          i === index ? { ...s, timeout: Number(e.target.value) } : s,
                        ),
                      )
                    }
                  />
                </Field>
              </div>
              <textarea
                aria-label={`步骤 ${index + 1} 命令`}
                required
                rows={2}
                className="mono"
                value={step.command}
                onChange={(e) =>
                  field(
                    'steps',
                    definition.steps!.map((s, i) =>
                      i === index ? { ...s, command: e.target.value } : s,
                    ),
                  )
                }
              />
              <div className="step-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={index === 0}
                  aria-label="上移步骤"
                  onClick={() => {
                    const arr = [...definition.steps!];
                    [arr[index - 1], arr[index]] = [arr[index]!, arr[index - 1]!];
                    field('steps', arr);
                  }}
                >
                  <ArrowUp size={14} />
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={index === definition.steps!.length - 1}
                  aria-label="下移步骤"
                  onClick={() => {
                    const arr = [...definition.steps!];
                    [arr[index + 1], arr[index]] = [arr[index]!, arr[index + 1]!];
                    field('steps', arr);
                  }}
                >
                  <ArrowDown size={14} />
                </button>
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() =>
                    field(
                      'steps',
                      definition.steps!.filter((_, i) => i !== index),
                    )
                  }
                >
                  <Trash2 size={14} />
                  移除
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="button secondary small"
            onClick={() =>
              field('steps', [
                ...(definition.steps || []),
                { name: '自定义步骤', type: 'SHELL', command: '', timeout: 300 },
              ])
            }
          >
            <Plus size={14} />
            添加步骤
          </button>
        </details>
        <label className="checkbox-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用此 Pipeline
        </label>
      </Form>
    </Modal>
  );
}

function RunPipeline({ pipeline, onClose }: { pipeline: Pipeline; onClose: () => void }) {
  const project = useResource<ProjectDetail>(`/projects/${pipeline.projectId}`);
  const targets = useResource<DeploymentTarget[]>('/deployment-targets');
  const versions = useResource<{ version: number; definition: PipelineDefinition }[]>(
    `/pipelines/${pipeline.id}/versions`,
  );
  const [environmentId, setEnvironmentId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [commitSha, setCommitSha] = useState('');
  const [version, setVersion] = useState(pipeline.currentVersion);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const config = useResource<Partial<PipelineDefinition> | null>(
    environmentId ? `/services/${pipeline.serviceId}/environments/${environmentId}/config` : null,
  );
  const versionDefinition =
    versions.data?.find((v) => v.version === version)?.definition || pipeline.definition;
  const effectiveDefinition = { ...versionDefinition };
  for (const key of [
    'buildLocation',
    'artifactType',
    'buildCommand',
    'outputPath',
    'deployPath',
    'composeFilePath',
    'startCommand',
    'healthCheckCommand',
    'dockerfilePath',
  ] as const) {
    const value = config.data?.[key];
    if (typeof value === 'string' && value)
      (effectiveDefinition as unknown as Record<string, unknown>)[key] = value;
  }
  const target = targets.data?.find((t) => t.id === targetId);
  async function run(e: FormEvent) {
    e.preventDefault();
    if (!review) {
      setReview(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const task = await post<Task>(`/pipelines/${pipeline.id}/run`, {
        environmentId,
        targetId,
        commitSha,
        version,
        confirmed: true,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`运行 · ${pipeline.name}`}
      description="固定 Git Commit、Pipeline 版本和执行目标，再提交至统一任务队列。"
      onClose={onClose}
    >
      <Form
        onSubmit={run}
        onCancel={() => (review ? setReview(false) : onClose())}
        submit={review ? '确认构建并部署' : '预览部署'}
        busy={
          busy ||
          versions.loading ||
          (!!environmentId && config.loading) ||
          !!versions.error ||
          !!config.error
        }
        error={error}
      >
        <ErrorBanner error={project.error || targets.error || versions.error || config.error} />
        {!review ? (
          <>
            <Field label="环境" required>
              <select
                value={environmentId}
                required
                onChange={(e) => setEnvironmentId(e.target.value)}
              >
                <option value="">选择项目环境</option>
                {project.data?.environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="部署目标" required>
              <select value={targetId} required onChange={(e) => setTargetId(e.target.value)}>
                <option value="">明确选择目标</option>
                {targets.data?.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.serverIds?.length || 0} 台
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Git Commit SHA"
              required
              hint="填写完整 40 或 64 位十六进制 Commit，不接受浮动分支。"
            >
              <input
                className="mono"
                value={commitSha}
                onChange={(e) => setCommitSha(e.target.value.trim())}
                required
                pattern="(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})"
                placeholder="完整 Commit SHA"
              />
            </Field>
            <Field label="Pipeline 版本">
              <select required value={version} onChange={(e) => setVersion(Number(e.target.value))}>
                {versions.data?.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                    {v.version === pipeline.currentVersion ? ' · 当前版本' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <>
            <div className="confirmation-summary">
              <ShieldCheck size={24} />
              <div>
                <strong>将对 {target?.serverIds?.length || 0} 台服务器执行构建与部署</strong>
                <p>
                  {target?.name} ·{' '}
                  {project.data?.environments.find((e) => e.id === environmentId)?.name} · Pipeline
                  v{version}
                </p>
              </div>
            </div>
            <div className="deployment-review">
              <span>固定 Commit</span>
              <code>{commitSha}</code>
              <span>构建方式</span>
              <strong>{buildLabels[effectiveDefinition.buildLocation]}</strong>
              <span>产物类型</span>
              <strong>
                {effectiveDefinition.artifactType === 'FILE' ? '文件' : 'Docker 镜像'}
              </strong>
              <span>部署目录</span>
              <code>{effectiveDefinition.deployPath}</code>
            </div>
            {config.data && (
              <p className="field-note">以上预览已合并该服务在当前环境中的配置覆盖。</p>
            )}
            {effectiveDefinition.startCommand && (
              <>
                <h3 className="field-title">启动命令</h3>
                <pre className="code-preview">{effectiveDefinition.startCommand}</pre>
              </>
            )}
            <p className="muted">
              执行将写入目标目录，并可能运行配置的启动命令。请确认该目录与命令属于此次部署的服务。
            </p>
          </>
        )}
      </Form>
    </Modal>
  );
}
function PipelineVersions({ pipeline, onClose }: { pipeline: Pipeline; onClose: () => void }) {
  const versions = useResource<
    { id: string; version: number; createdAt: number; definition: PipelineDefinition }[]
  >(`/pipelines/${pipeline.id}/versions`);
  return (
    <Modal
      title={`${pipeline.name} · 版本记录`}
      description="历史版本不可原地修改，任务始终使用启动时选定的版本。"
      onClose={onClose}
      wide
    >
      <div className="form-body">
        <ErrorBanner error={versions.error} />
        {versions.loading ? (
          <Loading />
        ) : (
          versions.data?.map((v) => (
            <details className="version-entry" key={v.id}>
              <summary>
                <span className="tag">v{v.version}</span>
                <span>{formatTime(v.createdAt)}</span>
                {v.version === pipeline.currentVersion && <span className="muted">当前版本</span>}
              </summary>
              <pre className="code-preview">{JSON.stringify(v.definition, null, 2)}</pre>
            </details>
          ))
        )}
      </div>
    </Modal>
  );
}

type Artifact = {
  id: string;
  artifactType: string;
  storageType: string;
  storageKey: string;
  sourceCommit?: string;
  checksum?: string;
  imageDigest?: string;
  imageRepository?: string;
  sizeBytes?: number;
  createdAt: number;
  serviceId: string;
  pipelineRunId?: string;
};
type Deployment = {
  id: string;
  status: string;
  serviceId: string;
  environmentId: string;
  serverId: string;
  deployPath?: string;
  releaseVersion?: string;
  healthStatus?: string;
  startedAt?: number;
  finishedAt?: number;
  taskId?: string;
};
export function DeliveryRecordsPage({ type }: { type: 'artifacts' | 'deployments' }) {
  const records = useResource<(Artifact & Deployment)[]>(`/${type}`);
  return (
    <>
      <PageHeader
        eyebrow="DELIVERY TRACEABILITY"
        title={type === 'artifacts' ? '构建产物' : '部署记录'}
        description={
          type === 'artifacts'
            ? '记录构建来源、存储位置和校验信息，追踪每一份交付物。'
            : '每台服务器独立记录部署与健康检查结果。'
        }
        action={<RefreshButton onClick={records.reload} />}
      />
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
      <ErrorBanner error={records.error} retry={records.reload} />
      <Section
        title={type === 'artifacts' ? '产物历史' : '部署历史'}
        subtitle="由 Pipeline 执行引擎生成"
      >
        {records.loading ? (
          <Loading />
        ) : !records.data?.length ? (
          <Empty
            icon={<Boxes size={26} />}
            title="暂无交付记录"
            description="完成首次 Pipeline 构建部署后，结果会出现在这里。"
            action={
              <a className="button secondary" href="#/pipelines">
                前往 Pipeline
              </a>
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {type === 'artifacts' ? (
                    <>
                      <th>产物</th>
                      <th>存储方式</th>
                      <th>固定 Commit</th>
                      <th>校验 / Digest</th>
                      <th>创建时间</th>
                    </>
                  ) : (
                    <>
                      <th>部署</th>
                      <th>服务器</th>
                      <th>部署目录</th>
                      <th>结果</th>
                      <th>健康检查</th>
                      <th>结束时间</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {records.data.map((r) => (
                  <tr key={r.id}>
                    {type === 'artifacts' ? (
                      <>
                        <td>
                          <strong className="table-name">
                            {r.artifactType === 'FILE' ? '文件产物' : 'Docker 镜像'}
                          </strong>
                          <small className="cell-detail mono" title={r.storageKey}>
                            {r.storageKey}
                          </small>
                        </td>
                        <td>
                          <span className="tag">{r.storageType}</span>
                          {r.sizeBytes != null && (
                            <small className="cell-detail">
                              {(r.sizeBytes / 1024).toFixed(1)} KiB
                            </small>
                          )}
                        </td>
                        <td className="mono" title={r.sourceCommit}>
                          {r.sourceCommit?.slice(0, 12) || '—'}
                        </td>
                        <td className="mono truncate" title={r.checksum || r.imageDigest}>
                          {r.checksum || r.imageDigest || '—'}
                        </td>
                        <td className="nowrap muted">{formatTime(r.createdAt)}</td>
                      </>
                    ) : (
                      <>
                        <td className="mono">{r.releaseVersion || r.id.slice(0, 8)}</td>
                        <td className="mono truncate" title={r.serverId}>
                          {r.serverId || '—'}
                        </td>
                        <td className="mono truncate" title={r.deployPath}>
                          {r.deployPath || '—'}
                        </td>
                        <td>
                          <Status value={r.status} />
                        </td>
                        <td>{r.healthStatus || '未配置'}</td>
                        <td className="nowrap muted">{formatTime(r.finishedAt)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

export function RegistriesPage({ user }: { user: User }) {
  const registries = useResource<Registry[]>('/registries');
  const credentials = useResource<Credential[]>('/credentials');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      await post('/registries', {
        name: f.get('name'),
        registryUrl: f.get('registryUrl'),
        credentialId: f.get('credentialId') || undefined,
      });
      setAdding(false);
      void registries.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="IMAGE DISTRIBUTION"
        title="镜像仓库"
        description="配置 Registry 地址与凭据引用，为管理端镜像构建和多服务器部署提供分发通道。"
        action={
          user.role === 'ADMIN' && (
            <button className="button primary" onClick={() => setAdding(true)}>
              <Plus size={16} />
              添加 Registry
            </button>
          )
        }
      />
      <ErrorBanner error={registries.error} />
      <Section title="Registry" subtitle="凭据在凭据中心加密保存">
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
              <div className="resource-row" key={r.id}>
                <span className="resource-avatar">
                  <Boxes size={20} />
                </span>
                <div>
                  <strong>{r.name}</strong>
                  <small>{r.registryUrl}</small>
                </div>
                <span className="tag">{r.credentialId ? '已关联凭据' : '匿名访问'}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
      {adding && (
        <Modal title="添加镜像仓库" onClose={() => setAdding(false)}>
          <Form onSubmit={save} onCancel={() => setAdding(false)} error={error} busy={busy}>
            <Field label="名称" required>
              <input name="name" required maxLength={100} />
            </Field>
            <Field
              label="Registry 地址"
              required
              hint="填写主机名和可选端口，不带协议或路径，例如 registry.example.com"
            >
              <input
                name="registryUrl"
                required
                pattern="[a-zA-Z0-9.-]+(?::[0-9]+)?"
                placeholder="registry.example.com"
              />
            </Field>
            <Field label="Registry 凭据">
              <select name="credentialId">
                <option value="">匿名访问</option>
                {credentials.data
                  ?.filter(
                    (c) =>
                      ['DOCKER_REGISTRY', 'USERNAME_PASSWORD'].includes(c.type) &&
                      c.status === 'ACTIVE',
                  )
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </Field>
            <p className="muted">需要认证时，请先在凭据中心创建 Docker Registry 凭据。</p>
          </Form>
        </Modal>
      )}
    </>
  );
}
