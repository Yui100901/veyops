import { useExecutionDefaults } from './useExecutionDefaults';
import { InlineEditor, useInlineEditor } from '../InlineEditor';
import { Fragment, lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { ComponentProps, FormEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Boxes,
  CalendarClock,
  Copy,
  GitBranch,
  History,
  Layers3,
  Pencil,
  Play,
  Plus,
  ShieldCheck,
  Trash2,
  Webhook,
  Workflow,
} from 'lucide-react';
import { ApiError, api, formatTime, message, navigate, post, remove, useResource } from '../api';
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
  Project,
  ProjectDetail,
  Server,
  Task,
  User,
} from '../models';
import { RepositoryBrowser } from './RepositoryBrowser';
import { ReleaseApprovals, RollbackRelease } from './ReleaseOperations';
import { ArtifactCleanup, ArtifactRetentionPolicy } from './ArtifactRetention';
import {
  DeploymentSelectionPicker,
  deploymentSelection,
  hasDeploymentSelection,
  selectedDeploymentServers,
  useDeploymentInventory,
} from './DeploymentSelection';
import {
  nodeConfigurationError,
  nodesFromLegacy,
  type PipelineNode,
  type PipelineNodeSource,
} from './pipeline-node-definition';
import { PipelineNodeGraph } from './PipelineNodeGraph';
import { PipelineAiDraft } from './PipelineAiDraft';
import { deliveryPath } from './delivery-route';
import { ContextAIButton } from './AI';
import './pipeline-nodes.css';

const PipelineNodesEditor = lazy(() => import('./PipelineNodes'));
const PipelineTriggers = lazy(() =>
  import('./PipelineTriggers').then((module) => ({ default: module.PipelineTriggers })),
);

export interface PipelineDefinition {
  defaultMode?: ExecutionMode;
  repositoryId: string;
  inheritBuildLocation?: boolean;
  buildLocation: 'TARGET' | 'MANAGER';
  artifactType: 'FILE' | 'DOCKER_IMAGE';
  buildImage: string;
  repoPath: string;
  installCommand: string;
  buildCommand: string;
  outputPath: string;
  deployPath: string;
  startCommand: string;
  stopCommand?: string;
  healthCheckCommand: string;
  dockerfilePath: string;
  composeFilePath: string;
  registryId?: string;
  imageRepository: string;
  steps?: { name: string; type: string; command: string; timeout?: number; location?: string }[];
  nodes?: PipelineNode[];
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
type PipelineDraft = Omit<Partial<Pipeline>, 'definition'> & {
  definition?: Partial<PipelineDefinition>;
};
interface Registry {
  id: string;
  name: string;
  registryUrl: string;
  credentialId: string | null;
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

export function PipelinesPage({
  user,
  repositoryScope,
  project,
}: {
  user: User;
  repositoryScope?: string;
  project?: ProjectDetail;
}) {
  const scope = new URLSearchParams(repositoryScope);
  const projectId = scope.get('projectId');
  const repositoryId = scope.get('repositoryId');
  const serviceId = scope.get('serviceId');
  const focusedId = scope.get('recordId');
  const scopedRepository = project?.repositories.find(
    (repository) => repository.id === repositoryId,
  );
  const listQuery = new URLSearchParams();
  if (projectId) listQuery.set('projectId', projectId);
  if (serviceId) listQuery.set('serviceId', serviceId);
  const pipelines = useResource<Pipeline[]>(`/pipelines?${listQuery}`);
  const projects = useResource<Project[]>(project ? null : '/projects');
  const projectList = project ? [project] : projects.data || [];
  const visiblePipelines = (pipelines.data || []).filter(
    (pipeline) =>
      (!focusedId || pipeline.id === focusedId) &&
      (!repositoryId ||
        pipeline.definition?.repositoryId === repositoryId ||
        pipeline.definition?.nodes?.some(
          (node) => node.type === 'CHECKOUT' && node.repositoryId === repositoryId,
        )),
  );
  const [editing, setEditing] = useInlineEditor<PipelineDraft>();
  const [running, setRunning] = useInlineEditor<Pipeline>();
  const [versions, setVersions] = useState<Pipeline>();
  const [webhook, setWebhook] = useInlineEditor<Pipeline>();
  const [triggerPipeline, setTriggerPipeline] = useInlineEditor<Pipeline>();
  const canEdit = user.role !== 'VIEWER' && !project?.archived;
  useEffect(() => {
    function openDraft() {
      const raw = sessionStorage.getItem('veyops:pipeline-draft');
      if (!raw || !canEdit) return;
      try {
        const value = JSON.parse(raw) as PipelineDraft;
        if (
          (projectId && value.projectId && projectId !== value.projectId) ||
          (serviceId && value.serviceId && serviceId !== value.serviceId)
        )
          return;
        sessionStorage.removeItem('veyops:pipeline-draft');
        setEditing({
          ...value,
          projectId: projectId || value.projectId,
          serviceId: serviceId || value.serviceId,
        });
      } catch {
        /* draft is optional */
      }
    }
    openDraft();
    window.addEventListener('veyops:pipeline-draft', openDraft);
    return () => window.removeEventListener('veyops:pipeline-draft', openDraft);
  }, [canEdit, projectId, serviceId, repositoryScope]);
  return (
    <>
      <div
        className="editor-origin"
        hidden={Boolean(editing || running || webhook || triggerPipeline)}
      >
        <DeliveryHeading
          compact={Boolean(project)}
          eyebrow="CONTINUOUS DELIVERY"
          title="Pipeline"
          description="从固定 Commit 到部署结果，让每次交付都有版本、有产物、可追踪。"
          action={
            <>
              <RefreshButton onClick={pipelines.reload} />
              {serviceId && !project?.archived && (
                <ContextAIButton
                  user={user}
                  projectId={projectId ?? undefined}
                  context={{ kind: 'SERVICE', serviceId }}
                  objectName={project?.services.find((service) => service.id === serviceId)?.name}
                />
              )}
              {canEdit && (
                <button
                  className="button primary"
                  onClick={() =>
                    setEditing({
                      projectId: projectId || undefined,
                      serviceId: serviceId || undefined,
                      definition: repositoryId ? { repositoryId } : undefined,
                    })
                  }
                >
                  <Plus size={16} />
                  创建 Pipeline
                </button>
              )}
            </>
          }
        />
        <ErrorBanner
          error={pipelines.error || projects.error}
          retry={() => {
            void pipelines.reload();
            void projects.reload();
          }}
        />
        {repositoryId && (
          <div className="repository-detail-actions">
            <span className="tag">仓库 · {scopedRepository?.name || repositoryId}</span>
            <a
              href={
                projectId
                  ? '#' + deliveryPath(projectId, 'pipelines', { serviceId })
                  : '#/pipelines'
              }
              className="text-link"
            >
              查看全部 Pipeline
            </a>
          </div>
        )}
        {!project && (
          <div className="delivery-banner">
            <span className="resource-avatar">
              <Workflow size={25} />
            </span>
            <div>
              <strong>一个流程，两种构建位置</strong>
              <p>
                目标端就地构建，或管理端在独立容器中构建一次、分发同一产物。运行时固定配置与版本。
              </p>
            </div>
            <a className="text-link" href="#/servers">
              管理服务器与分组 →
            </a>
          </div>
        )}
        {pipelines.loading ? (
          <Loading />
        ) : !visiblePipelines.length ? (
          <div className="panel">
            <Empty
              icon={<GitBranch size={27} />}
              title={repositoryId ? '此仓库暂无 Pipeline' : '建立第一条交付流程'}
              description={
                repositoryId
                  ? '创建 Pipeline 时会预填当前仓库，再选择服务和构建方式。'
                  : '先创建项目、仓库和服务，再选择服务器或服务器分组执行。'
              }
              action={
                <a
                  href={project ? '#/projects/' + project.id : '#/projects'}
                  className="button secondary"
                >
                  前往项目管理
                </a>
              }
            />
          </div>
        ) : (
          <div className="pipeline-grid">
            {visiblePipelines.map((p) => (
              <section className="panel pipeline-card" key={p.id}>
                <div className="pipeline-card-top">
                  <span className="resource-avatar">
                    <GitBranch size={22} />
                  </span>
                  <span className="tag">v{p.currentVersion}</span>
                </div>
                <h2>{p.name}</h2>
                <p>
                  <a
                    className="text-link"
                    href={
                      '#' +
                      deliveryPath(p.projectId, 'pipelines', {
                        serviceId: p.serviceId,
                        recordId: p.id,
                      })
                    }
                  >
                    {projectList.find((v) => v.id === p.projectId)?.name || '项目'} ·{' '}
                    {project?.services.find((s) => s.id === p.serviceId)?.name || '所属服务'}
                  </a>
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
                  <span>
                    {p.definition?.inheritBuildLocation
                      ? '沿用项目默认构建位置'
                      : buildLabels[p.definition?.buildLocation] || '目标服务器构建'}
                  </span>
                  <Status value={p.enabled ? 'ACTIVE' : 'DISABLED'} />
                </div>
                <div className="pipeline-card-actions">
                  <ContextAIButton
                    user={user}
                    projectId={p.projectId}
                    context={{ kind: 'PIPELINE', pipelineId: p.id }}
                    objectName={p.name}
                  />
                  <button className="text-button" onClick={() => setVersions(p)}>
                    <History size={15} />
                    版本
                  </button>
                  <button
                    className="text-button"
                    aria-label={`查看 ${p.name} 的自动触发`}
                    onClick={() => setTriggerPipeline(p)}
                  >
                    <CalendarClock size={15} /> 自动触发
                  </button>
                  {user.role === 'ADMIN' && canEdit && (
                    <button
                      className="text-button"
                      aria-label={`配置 ${p.name} 的 Gitea Webhook`}
                      title="配置 Gitea Webhook"
                      onClick={() => setWebhook(p)}
                    >
                      <Webhook size={15} />
                      Webhook
                    </button>
                  )}
                  {canEdit && (
                    <>
                      <button className="text-button" onClick={() => setEditing(p)}>
                        <Pencil size={15} />
                        编辑
                      </button>
                      <button
                        className="button primary small"
                        aria-label={`运行 ${p.name}`}
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
      </div>
      {editing && (
        <PipelineEditor
          pipeline={editing}
          canConfigureTriggers={user.role === 'ADMIN'}
          projects={projectList}
          lockProject={Boolean(projectId)}
          lockService={Boolean(serviceId)}
          onClose={() => setEditing(undefined)}
          onSaved={() => void pipelines.reload()}
        />
      )}
      {running && <RunPipeline pipeline={running} onClose={() => setRunning(undefined)} />}
      {versions && <PipelineVersions pipeline={versions} onClose={() => setVersions(undefined)} />}
      {triggerPipeline && (
        <TriggerSettings
          pipeline={triggerPipeline}
          canManage={user.role === 'ADMIN' && canEdit}
          onClose={() => setTriggerPipeline(undefined)}
        />
      )}
      {webhook && <PipelineWebhook pipeline={webhook} onClose={() => setWebhook(undefined)} />}
    </>
  );
}

function TriggerPanel({
  embedded,
  ...props
}: ComponentProps<typeof InlineEditor> & { embedded?: boolean }) {
  if (!embedded) return <InlineEditor {...props} />;
  return (
    <section className="subpanel">
      <h3>{props.title}</h3>
      {props.description && <p className="field-note">{props.description}</p>}
      {props.children}
    </section>
  );
}

function TriggerSettings({
  pipeline,
  canManage,
  embedded,
  versionReady = true,
  onClose,
}: {
  pipeline: Pipeline;
  canManage: boolean;
  embedded?: boolean;
  versionReady?: boolean;
  onClose: () => void;
}) {
  const project = useResource<ProjectDetail>(`/projects/${pipeline.projectId}/delivery-context`);
  const repositoryId = pipeline.definition.repositoryId;
  const cache = useResource<{ branches: { name: string }[]; defaultBranch: string | null }>(
    canManage && repositoryId
      ? `/projects/${pipeline.projectId}/repositories/${repositoryId}/branch-cache`
      : null,
  );
  const [selectedEnv, setSelectedEnv] = useState<string>();
  const [selectedBranch, setSelectedBranch] = useState<string>();
  const environmentId = selectedEnv ?? project.data?.environments[0]?.id ?? '';
  const primary = pipeline.definition.nodes?.[0];
  const configuredBranch = primary?.environmentBranches?.[environmentId] || primary?.branch;
  const branch =
    configuredBranch ||
    (selectedBranch ??
      cache.data?.defaultBranch ??
      project.data?.repositories.find((r) => r.id === repositoryId)?.defaultBranch ??
      '');
  return (
    <TriggerPanel embedded={embedded} title="定时与分支轮询" wide onClose={onClose}>
      <div className="form-body">
        <ErrorBanner error={project.error || cache.error} />
        {canManage && (
          <div className="form-grid">
            <Field label="触发环境">
              <select
                value={environmentId}
                onChange={(event) => {
                  setSelectedEnv(event.target.value);
                  setSelectedBranch(undefined);
                }}
              >
                {!project.data?.environments.length && <option value="">暂无环境</option>}
                {project.data?.environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="触发分支"
              hint={configuredBranch ? '当前环境的源码节点已固定此分支。' : undefined}
            >
              <input
                list="trigger-branches"
                value={branch}
                disabled={Boolean(configuredBranch)}
                onChange={(event) => setSelectedBranch(event.target.value)}
              />
              <datalist id="trigger-branches">
                {cache.data?.branches.map((b) => (
                  <option key={b.name} value={b.name} />
                ))}
              </datalist>
            </Field>
          </div>
        )}
        <Suspense fallback={<Loading />}>
          <PipelineTriggers
            projectId={pipeline.projectId}
            pipelineId={pipeline.id}
            version={pipeline.currentVersion}
            versionReady={versionReady}
            environmentId={environmentId}
            branch={branch}
            canManage={canManage}
          />
        </Suspense>
      </div>
    </TriggerPanel>
  );
}

type WebhookInput = DeploymentSelection & {
  followMode?: boolean;
  environmentId: string;
  branch: string;
  secretCredentialId: string;
  enabled: boolean;
};
type WebhookConfig = WebhookInput & {
  mode?: ExecutionMode;
  endpoint: string;
  version?: number;
};

function PipelineWebhook({
  pipeline,
  embedded,
  versionReady = true,
  onClose,
}: {
  pipeline: Pipeline;
  embedded?: boolean;
  versionReady?: boolean;
  onClose: () => void;
}) {
  const path = `/pipelines/${pipeline.id}/webhook`;
  const fresh = useRef(!pipeline.id).current;
  const configuration = useResource<WebhookConfig | null>(pipeline.id ? path : null);
  const project = useResource<ProjectDetail>(`/projects/${pipeline.projectId}`);
  const inventory = useDeploymentInventory();
  const credentials = useResource<Credential[]>('/credentials');
  const [selection, setSelection] = useState<DeploymentSelection>(() => deploymentSelection());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [review, setReview] = useState<{
    input: WebhookInput;
    result: {
      version: number;
      mode: ExecutionMode;
      serverIds: string[];
      requireApproval: boolean;
      bindingHash: string;
    };
  }>();
  const loading = (!fresh && configuration.loading) || project.loading || credentials.loading;
  const loadError = configuration.error || project.error || credentials.error;
  const config = configuration.data;
  const [inheritTargets, setInheritTargets] = useState(true);
  const [hookEnabled, setHookEnabled] = useState(!!embedded);
  useEffect(() => {
    if (!config) return;
    setSelection(deploymentSelection(config));
    setInheritTargets(!config?.targetId && !hasDeploymentSelection(deploymentSelection(config)));
    setHookEnabled(config.enabled);
  }, [config]);
  useEffect(() => setReview(undefined), [pipeline.id, pipeline.currentVersion, versionReady]);
  const sharedSecrets = credentials.data?.filter(
    (c) => c.type === 'CUSTOM_SECRET' && c.status === 'ACTIVE',
  );
  const endpoint = config ? new URL(config.endpoint, window.location.origin).href : '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setNotice('已复制 Webhook URL。');
    } catch {
      setNotice('请选中 URL 并手动复制。');
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !versionReady) return;
    if (!inheritTargets && !hasDeploymentSelection(selection)) {
      setError('请选择服务器或服务器分组。');
      return;
    }
    const values = new FormData(event.currentTarget);
    const input: WebhookInput = {
      ...(!inheritTargets && selection),
      environmentId: String(values.get('environmentId')),
      branch: String(values.get('branch')).trim(),
      secretCredentialId: String(values.get('secretCredentialId')),
      enabled: values.get('enabled') === 'on',
      followMode: config?.followMode !== false || values.has('followMode'),
    };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (input.enabled) {
        const result = await post<NonNullable<typeof review>['result']>(path + '/preview', input);
        if (result.version !== pipeline.currentVersion) {
          setError(`流水线已有新版本 v${result.version}，请返回列表重新打开后核对绑定。`);
          return;
        }
        setReview({ input, result });
        return;
      }
      await api(path, { method: 'PUT', body: JSON.stringify(input) });
      await configuration.reload();
      setNotice('Webhook 配置已保存。');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function confirmBinding(event: FormEvent) {
    event.preventDefault();
    if (!review || busy || !versionReady) return;
    setBusy(true);
    try {
      await api(path, {
        method: 'PUT',
        body: JSON.stringify({ ...review.input, expectedBindingHash: review.result.bindingHash }),
      });
      await configuration.reload();
      setNotice('Webhook 配置已保存。');
      setError('');
      setReview(undefined);
    } catch (err) {
      setReview(undefined);
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <TriggerPanel
      embedded={embedded}
      title="Gitea Webhook"
      wide
      description={`匹配的 Push 事件会在专用构建环境中构建 ${pipeline.name}。生效的构建位置须为管理端，环境须适合自动构建且不含敏感变量。`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {loading ? (
        <Loading />
      ) : loadError ? (
        <div className="form-body">
          <ErrorBanner
            error={loadError}
            retry={() => {
              void configuration.reload();
              void project.reload();
              void credentials.reload();
            }}
          />
        </div>
      ) : (
        <>
          {review && (
            <Form
              onSubmit={confirmBinding}
              onCancel={() => setReview(undefined)}
              submit="确认启用"
              busy={busy}
              error={error}
            >
              <p>
                将对 {review.input.branch} 的推送运行 v{review.result.version}，在管理端隔离构建。
              </p>
              <p>
                {review.result.mode === 'BUILD_ONLY'
                  ? '仅构建并归档产物'
                  : review.result.requireApproval
                    ? '构建后申请发布审批'
                    : '构建成功后自动部署'}{' '}
                ·{' '}
                {review.result.serverIds
                  .map(
                    (id) => inventory.servers.data?.find((server) => server.id === id)?.name ?? id,
                  )
                  .join('、')}
              </p>
            </Form>
          )}
          <div hidden={!!review}>
            <Form
              onSubmit={save}
              onCancel={onClose}
              submit={hookEnabled ? '预览 Webhook 绑定' : '保存停用的 Webhook'}
              submitDisabled={!versionReady}
              busy={busy}
              error={error}
            >
              {endpoint && (
                <div className="webhook-url">
                  <Field
                    label="Webhook URL"
                    hint="Gitea 中选择 Push Events，内容类型设为 application/json，并填写同一共享密钥。URL 需能从 Gitea 访问。"
                  >
                    <input
                      value={endpoint}
                      readOnly
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </Field>
                  <button
                    className="button secondary small"
                    type="button"
                    onClick={() => void copy()}
                  >
                    <Copy size={14} />
                    复制 URL
                  </button>
                </div>
              )}
              {notice && (
                <p className="success-notice" role="status">
                  {notice}
                </p>
              )}
              {config?.version && (
                <p className="field-note">
                  已固定 Pipeline v{config.version} ·{' '}
                  {config.mode === 'DEPLOY' ? '构建并部署' : '仅构建'}
                  。如需切换到当前版本，请重新保存。
                </p>
              )}
              <Field label="环境" required>
                <select name="environmentId" required defaultValue={config?.environmentId || ''}>
                  <option value="">选择项目环境</option>
                  {project.data?.environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={inheritTargets}
                  onChange={(event) => setInheritTargets(event.target.checked)}
                />
                沿用服务环境的服务器或分组
              </label>
              {!inheritTargets && config?.targetId && !hasDeploymentSelection(selection) && (
                <p className="field-note">请重新选择触发时使用的服务器或服务器分组。</p>
              )}
              {!inheritTargets && (
                <DeploymentSelectionPicker
                  projectId={pipeline.projectId}
                  inventory={inventory}
                  value={selection}
                  onChange={setSelection}
                  disabled={busy}
                />
              )}
              <Field label="Webhook 分支" required>
                <input
                  name="branch"
                  required
                  defaultValue={
                    config?.branch ||
                    pipeline.definition.nodes?.[0]?.branch ||
                    project.data?.repositories.find(
                      (r) => r.id === pipeline.definition.repositoryId,
                    )?.defaultBranch ||
                    ''
                  }
                  placeholder="例如 main"
                />
              </Field>
              <Field label="签名密钥" required hint="Gitea 使用共享密钥生成 SHA-256 签名。">
                <select
                  name="secretCredentialId"
                  required
                  defaultValue={config?.secretCredentialId || ''}
                >
                  <option value="">选择共享密钥凭据</option>
                  {sharedSecrets?.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.name}
                    </option>
                  ))}
                </select>
              </Field>
              {!sharedSecrets?.length && (
                <p className="field-note">
                  先在
                  <a className="text-link" href="#/credentials">
                    凭据中心
                  </a>
                  创建共享密钥。
                </p>
              )}
              {config?.followMode === false && (
                <label className="checkbox-row">
                  <input type="checkbox" name="followMode" />
                  将旧版仅构建绑定切换为跟随服务环境和流水线配置
                </label>
              )}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  name="enabled"
                  checked={hookEnabled}
                  onChange={(event) => setHookEnabled(event.target.checked)}
                />
                启用 Push 触发
              </label>
            </Form>
          </div>
        </>
      )}
    </TriggerPanel>
  );
}

function PipelineEditor({
  pipeline,
  canConfigureTriggers,
  projects,
  lockProject,
  lockService,
  onClose,
  onSaved,
}: {
  pipeline: PipelineDraft;
  canConfigureTriggers: boolean;
  projects: Project[];
  lockProject: boolean;
  lockService: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [projectId, setProjectId] = useState(pipeline.projectId || '');
  const [name, setName] = useState(pipeline.name || '');
  const [serviceId, setServiceId] = useState(pipeline.serviceId || '');
  const [enabled, setEnabled] = useState(pipeline.enabled ?? true);
  const [definition, setDefinition] = useState<
    Omit<PipelineDefinition, 'buildLocation'> & Partial<Pick<PipelineDefinition, 'buildLocation'>>
  >(() => {
    const initial = {
      ...emptyDefinition,
      ...pipeline.definition,
      buildLocation: pipeline.definition?.inheritBuildLocation
        ? undefined
        : pipeline.definition?.buildLocation,
    };
    if (!pipeline.id && !pipeline.definition?.artifactType && !initial.nodes)
      initial.nodes = nodesFromLegacy(initial);
    return initial;
  });
  const defaults = useExecutionDefaults(projectId);
  const defaultBuildLocation = defaults.data?.defaultBuildLocation;
  const buildLocation = definition.buildLocation ?? defaultBuildLocation ?? 'TARGET';
  const project = useResource<ProjectDetail>(projectId ? `/projects/${projectId}` : null);
  const links = useResource<{ repositoryId: string; isPrimary: boolean }[]>(
    serviceId ? `/services/${serviceId}/repositories` : null,
  );
  const linked = new Map(links.data?.map((link) => [link.repositoryId, link.isPrimary ? 0 : 1]));
  const orderedProject = project.data && {
    ...project.data,
    repositories: [...project.data.repositories].sort(
      (a, b) => (linked.get(a.id) ?? 2) - (linked.get(b.id) ?? 2),
    ),
  };
  const preferred = orderedProject?.repositories.find((r) => linked.has(r.id));
  const primaryRepositoryId = definition.repositoryId || (!pipeline.id && preferred?.id) || '';
  const sourceBranch = definition.nodes?.[0]?.branch;
  const draftMode =
    definition.nodes && !definition.nodes.some(({ type }) => type === 'DEPLOY')
      ? 'BUILD_ONLY'
      : (definition.defaultMode ?? 'DEPLOY');
  const [adoptedDraft, setAdoptedDraft] = useState<{ nodes: PipelineNode[]; undo: () => void }>();
  const checkoutBranches = useRef(
    new Map<string, Map<string, Pick<PipelineNode, 'branch' | 'environmentBranches'>>>(),
  );
  const registries = useResource<Registry[]>('/registries');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formId = useId();
  const saving = useRef(false);
  // Use getRandomValues so a test instance served over LAN HTTP can also retry the same creation.
  const [creationId] = useState(() => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  });
  type Panel = 'NONE' | 'TIMING' | 'WEBHOOK';
  const [triggerPanel, setTriggerPanel] = useState<Panel>('NONE');
  const [visitedPanels, setVisitedPanels] = useState<Panel[]>([]);
  function selectTriggerPanel(next: Panel) {
    setTriggerPanel(next);
    if (next !== 'NONE')
      setVisitedPanels((current) => (current.includes(next) ? current : [...current, next]));
  }
  const versionKey = JSON.stringify([
    projectId,
    serviceId,
    name,
    enabled,
    primaryRepositoryId,
    definition,
  ]);
  const [saved, setSaved] = useState(() =>
    pipeline.id && pipeline.currentVersion
      ? { id: pipeline.id, version: pipeline.currentVersion, key: versionKey }
      : undefined,
  );
  const versionReady = saved?.key === versionKey;
  const triggerPipeline: Pipeline = {
    projectId,
    serviceId,
    name,
    enabled,
    id: saved?.id || '',
    currentVersion: saved?.version ?? 0,
    definition: { ...definition, buildLocation, repositoryId: primaryRepositoryId },
  };
  function field<K extends keyof typeof definition>(key: K, value: (typeof definition)[K]) {
    setDefinition((v) => ({ ...v, [key]: value }));
  }
  function changeProject(id: string) {
    checkoutBranches.current.clear();
    setProjectId(id);
    setServiceId('');
    setVisitedPanels(triggerPanel === 'NONE' ? [] : [triggerPanel]);
    setDefinition((current) => ({
      ...current,
      repositoryId: '',
      nodes: current.nodes?.map((node) =>
        node.type === 'CHECKOUT'
          ? {
              ...node,
              repositoryId: undefined,
              branch: undefined,
              environmentBranches: undefined,
            }
          : node,
      ),
    }));
  }
  function changeRepository(repositoryId: string) {
    const nextPrimary = repositoryId || (!pipeline.id && preferred?.id) || '';
    if (nextPrimary === primaryRepositoryId) return;
    const followsPrimary = (node: PipelineNode, index: number) =>
      node.type === 'CHECKOUT' && (index === 0 || !node.repositoryId);
    checkoutBranches.current.set(
      primaryRepositoryId,
      new Map(
        definition.nodes?.filter(followsPrimary).map((node) => [
          node.id,
          {
            branch: node.branch,
            environmentBranches: node.environmentBranches,
          },
        ]),
      ),
    );
    const restored = checkoutBranches.current.get(nextPrimary);
    setDefinition((current) => ({
      ...current,
      repositoryId,
      nodes: current.nodes?.map((node, index) =>
        followsPrimary(node, index)
          ? {
              ...node,
              repositoryId: undefined,
              branch: restored?.get(node.id)?.branch,
              environmentBranches: restored?.get(node.id)?.environmentBranches,
            }
          : node,
      ),
    }));
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving.current) return;
    if (versionReady) {
      if (triggerPanel === 'NONE') onClose();
      return;
    }
    if (definition.nodes) {
      const invalid = nodeConfigurationError(definition.nodes, primaryRepositoryId);
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const body = {
        name,
        ...(saved ? {} : { projectId, serviceId, creationId }),
        enabled,
        definition: {
          ...definition,
          inheritBuildLocation: !definition.buildLocation,
          defaultMode:
            definition.nodes && !definition.nodes.some((n) => n.type === 'DEPLOY')
              ? 'BUILD_ONLY'
              : (definition.defaultMode ?? 'DEPLOY'),
          repositoryId: primaryRepositoryId,
          ...(definition.nodes && { installCommand: '', buildCommand: '', steps: [] }),
          registryId: definition.registryId || undefined,
          imageRepository: definition.imageRepository || undefined,
        },
      };
      const result = await api<Pipeline>(`/pipelines${saved ? `/${saved.id}` : ''}`, {
        method: saved ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      setSaved({ id: result.id, version: result.currentVersion, key: versionKey });
      onSaved();
      if (triggerPanel === 'NONE') onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <InlineEditor
      busy={busy}
      title={saved ? '编辑 Pipeline' : '创建 Pipeline'}
      description={
        saved
          ? `当前版本 v${saved.version}。修改流水线会追加版本，已启用的触发绑定继续使用原版本。`
          : '关联项目与服务，定义构建和部署过程。'
      }
      onClose={onClose}
      wide
    >
      <Form
        id={formId}
        onSubmit={save}
        onCancel={onClose}
        busy={busy}
        error={error}
        submit={
          triggerPanel !== 'NONE'
            ? versionReady
              ? `v${saved?.version} 已保存`
              : '保存版本并继续配置触发'
            : saved
              ? '保存流水线'
              : '创建 Pipeline'
        }
        submitDisabled={triggerPanel !== 'NONE' && versionReady}
      >
        <ErrorBanner error={project.error || registries.error || links.error} />
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
              disabled={!!saved || lockProject}
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
              disabled={!!saved || lockService}
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
          <Field label={definition.nodes ? '主仓库' : '仓库'} required>
            <select
              value={primaryRepositoryId}
              required
              onChange={(e) => changeRepository(e.target.value)}
            >
              <option value="">选择仓库</option>
              {orderedProject?.repositories.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name}
                  {linked.has(r.id) ? ' · 服务已关联' : ''}
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
              value={definition.buildLocation ?? ''}
              onChange={(event) =>
                field(
                  'buildLocation',
                  (event.target.value as 'TARGET' | 'MANAGER' | '') || undefined,
                )
              }
            >
              <option value="">
                {!defaultBuildLocation
                  ? '沿用项目默认'
                  : defaultBuildLocation === 'MANAGER'
                    ? '沿用项目默认（管理端隔离构建）'
                    : '沿用项目默认（目标服务器构建）'}
              </option>
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
        {buildLocation === 'MANAGER' && (
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
        <Field label="默认运行模式" hint="服务环境可以覆盖此设置。">
          <select
            value={
              definition.nodes && !definition.nodes.some((n) => n.type === 'DEPLOY')
                ? 'BUILD_ONLY'
                : (definition.defaultMode ?? 'DEPLOY')
            }
            onChange={(e) => field('defaultMode', e.target.value as ExecutionMode)}
          >
            <option value="BUILD_ONLY">仅构建</option>
            {(!definition.nodes || definition.nodes.some((n) => n.type === 'DEPLOY')) && (
              <option value="DEPLOY">构建并部署</option>
            )}
          </select>
        </Field>
        <PipelineAiDraft
          key={JSON.stringify([
            projectId,
            serviceId,
            primaryRepositoryId,
            definition.repoPath,
            sourceBranch,
            buildLocation,
            definition.artifactType,
            draftMode,
          ])}
          projectId={projectId}
          serviceId={serviceId}
          repositoryId={primaryRepositoryId}
          repoPath={definition.repoPath}
          initialBranch={sourceBranch}
          currentNodes={definition.nodes}
          onUndo={adoptedDraft?.nodes === definition.nodes ? adoptedDraft?.undo : undefined}
          pipeline={
            definition.buildLocation || defaultBuildLocation
              ? { buildLocation, artifactType: definition.artifactType, defaultMode: draftMode }
              : undefined
          }
          onApply={(suggestedName, fields) => {
            const keys = Object.keys(fields) as (keyof typeof fields)[];
            setAdoptedDraft({
              nodes: fields.nodes,
              undo: () => {
                if (!name.trim())
                  setName((current) => (current === suggestedName ? name : current));
                setDefinition((current) => ({
                  ...current,
                  ...Object.fromEntries(
                    keys
                      .filter((key) => current[key] === fields[key])
                      .map((key) => [key, definition[key]]),
                  ),
                }));
                setAdoptedDraft(undefined);
              },
            });
            if (!name.trim()) setName(suggestedName);
            setDefinition((current) => ({ ...current, ...fields }));
          }}
        />
        <div className="pipeline-nodes-heading">
          <h3>流水线节点</h3>
          {!definition.nodes && (
            <button
              className="button secondary small"
              type="button"
              onClick={() => field('nodes', nodesFromLegacy(definition))}
            >
              <Workflow size={18} /> 转为节点编排
            </button>
          )}
        </div>
        {definition.nodes ? (
          <Suspense fallback={<Loading />}>
            <PipelineNodesEditor
              nodes={definition.nodes}
              project={orderedProject}
              primaryRepositoryId={primaryRepositoryId}
              onChange={(nodes) => field('nodes', nodes)}
            />
          </Suspense>
        ) : (
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
        )}
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
              <Field
                label="镜像仓库名称"
                hint="发布镜像时可指定仓库。仅构建可留空，由平台生成本地镜像标签。"
              >
                <input
                  value={definition.imageRepository}
                  placeholder="registry.example.com/team/service"
                  onChange={(e) => field('imageRepository', e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Registry"
              hint="管理端构建并部署镜像时需要 Registry。仅构建将镜像保留在构建端。"
            >
              <select
                value={definition.registryId || ''}
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
          hint="部署需要填写专属目录，例如 /opt/veyops/my-service。仅构建可留空。"
        >
          <input
            value={definition.deployPath}
            placeholder="/opt/veyops/my-service"
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
        {definition.artifactType === 'FILE' && (
          <Field label="停止命令（可选）" hint="替换该版本时执行。命令应只停止本服务。">
            <textarea
              className="mono"
              rows={2}
              value={definition.stopCommand ?? ''}
              onChange={(event) => field('stopCommand', event.target.value)}
            />
          </Field>
        )}
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
        {!definition.nodes && (
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
        )}
        <label className="checkbox-row">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用此 Pipeline
        </label>
        {canConfigureTriggers && (
          <Field
            label="自动触发配置"
            hint="可同时启用 Webhook、定时和轮询。选择要编辑的配置，已启用的规则会保留。"
          >
            <select
              value={triggerPanel}
              onChange={(event) => selectTriggerPanel(event.target.value as Panel)}
            >
              <option value="NONE">仅保存流水线</option>
              <option value="WEBHOOK">Webhook 推送</option>
              <option value="TIMING">定时构建 / 分支轮询</option>
            </select>
          </Field>
        )}
      </Form>
      {canConfigureTriggers && visitedPanels.length > 0 && (
        <div hidden={triggerPanel === 'NONE'}>
          <div className="form-body">
            <p className="field-note" role="status">
              {versionReady
                ? `当前流水线版本 v${saved?.version} 已保存。预览绑定后可以确认启用。`
                : '可先填写触发配置。保存流水线版本后，即可预览并确认启用。'}
            </p>
            {!projectId && <p>请先选择流水线所属项目。</p>}
            {projectId && visitedPanels.includes('WEBHOOK') && (
              <div hidden={triggerPanel !== 'WEBHOOK'}>
                <PipelineWebhook
                  key={projectId}
                  pipeline={triggerPipeline}
                  embedded
                  versionReady={versionReady}
                  onClose={() => selectTriggerPanel('NONE')}
                />
              </div>
            )}
            {projectId && visitedPanels.includes('TIMING') && (
              <div hidden={triggerPanel !== 'TIMING'}>
                <TriggerSettings
                  key={projectId}
                  pipeline={triggerPipeline}
                  embedded
                  canManage
                  versionReady={versionReady}
                  onClose={() => selectTriggerPanel('NONE')}
                />
              </div>
            )}
            <div className="actions">
              {!versionReady && (
                <button type="submit" form={formId} className="button primary" disabled={busy}>
                  保存流水线版本以预览
                </button>
              )}
              {saved && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy}
                  onClick={onClose}
                >
                  返回流水线列表
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </InlineEditor>
  );
}

type ExecutionMode = 'BUILD_ONLY' | 'DEPLOY';
type PipelinePreview = {
  targetWorkspaceRoot?: string;
  mode: ExecutionMode;
  environmentId: string;
  targetSelection?: DeploymentSelection | null;
  version: number;
  commitSha: string;
  definition: PipelineDefinition;
  serverIds: string[];
  configurationHash: string;
  aiApprovalHash?: string;
  allowPartialDeploy?: boolean;
  requireApproval?: boolean;
  nodeSources?: PipelineNodeSource[];
};

function RunPipeline({ pipeline, onClose }: { pipeline: Pipeline; onClose: () => void }) {
  const project = useResource<ProjectDetail>(`/projects/${pipeline.projectId}`);
  const inventory = useDeploymentInventory();
  const versions = useResource<{ version: number; definition: PipelineDefinition }[]>(
    `/pipelines/${pipeline.id}/versions`,
  );
  const [environmentId, setEnvironmentId] = useState('');
  const environmentConfig = useResource<
    (DeploymentSelection & { executionMode?: ExecutionMode }) | null
  >(environmentId ? `/services/${pipeline.serviceId}/environments/${environmentId}/config` : null);
  const [selection, setSelection] = useState<DeploymentSelection>(() => deploymentSelection());
  const [commitSha, setCommitSha] = useState('');
  const [version, setVersion] = useState(pipeline.currentVersion);
  const [browsing, setBrowsing] = useState(false);
  const [commitOrigin, setCommitOrigin] = useState<{ branch: string; subject: string }>();
  const [mode, setMode] = useState<ExecutionMode | ''>('');
  const [allowPartialDeploy, setAllowPartialDeploy] = useState(false);
  const [preview, setPreview] = useState<PipelinePreview>();
  const [copyNotice, setCopyNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(
    () => setSelection(deploymentSelection(environmentConfig.data)),
    [environmentConfig.data],
  );
  const versionDefinition =
    versions.data?.find((entry) => entry.version === version)?.definition ??
    (version === pipeline.currentVersion ? pipeline.definition : undefined);
  const primarySource = versionDefinition?.nodes?.[0];
  const configuredBranch =
    primarySource?.environmentBranches?.[environmentId] || primarySource?.branch;
  const onlyBuild = Boolean(
    versionDefinition?.nodes && !versionDefinition.nodes.some(({ type }) => type === 'DEPLOY'),
  );
  const inheritedMode =
    environmentConfig.data?.executionMode ??
    versionDefinition?.defaultMode ??
    (onlyBuild ? 'BUILD_ONLY' : 'DEPLOY');
  const requestedMode = mode || inheritedMode;
  const repositoryId = versionDefinition?.repositoryId;
  const repository = project.data?.repositories.find((entry) => entry.id === repositoryId);
  async function run(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!preview && !hasDeploymentSelection(selection)) {
      setError('请选择服务器或服务器分组。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (!preview) {
        const result = await post<PipelinePreview>(`/pipelines/${pipeline.id}/preview`, {
          ...selection,
          environmentId,
          commitSha: configuredBranch ? undefined : commitSha,
          version,
          mode: mode || undefined,
          allowPartialDeploy: requestedMode === 'DEPLOY' && allowPartialDeploy,
          confirmed: true,
        });
        setCopyNotice('');
        setPreview(result);
        return;
      }
      const task = await post<Task>(`/pipelines/${pipeline.id}/run`, {
        ...deploymentSelection(preview.targetSelection ?? selection),
        environmentId: preview.environmentId,
        commitSha: configuredBranch ? undefined : preview.commitSha,
        version: preview.version,
        mode: mode || undefined,
        allowPartialDeploy:
          preview.allowPartialDeploy ?? (preview.mode === 'DEPLOY' && allowPartialDeploy),
        expectedConfigurationHash: preview.configurationHash,
        expectedServerIds: preview.serverIds,
        confirmed: true,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setPreview(undefined);
        void inventory.servers.reload();
        void inventory.groups.reload();
      }
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const buildOnly = (preview?.mode ?? requestedMode) === 'BUILD_ONLY';
  const definition = preview?.definition;
  const environmentName = project.data?.environments.find(
    (e) => e.id === preview?.environmentId,
  )?.name;
  return (
    <InlineEditor
      title={`运行 · ${pipeline.name}`}
      wide
      description="选择版本和目标，预览执行节点及每个仓库的固定提交。"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Form
        onSubmit={run}
        onCancel={() => {
          if (preview) {
            setPreview(undefined);
            setError('');
          } else onClose();
        }}
        submit={
          preview
            ? buildOnly
              ? '确认仅构建'
              : preview.requireApproval
                ? '确认构建并提交发布审批'
                : '确认构建并部署'
            : buildOnly
              ? '预览构建'
              : '预览部署'
        }
        busy={busy}
        error={error}
      >
        <ErrorBanner error={project.error || versions.error} />
        {!preview || !definition ? (
          <fieldset disabled={busy}>
            <Field label="运行模式" required>
              <select value={mode} onChange={(e) => setMode(e.target.value as ExecutionMode)}>
                <option value="">
                  沿用配置（{inheritedMode === 'BUILD_ONLY' ? '仅构建' : '构建并部署'}）
                </option>
                {!onlyBuild && <option value="DEPLOY">构建并部署</option>}
                <option value="BUILD_ONLY">仅构建</option>
              </select>
            </Field>
            {buildOnly && (
              <p className="field-note">构建完成后可下载归档，或从已归档的产物发起独立部署。</p>
            )}
            <Field label="环境" required>
              <select
                value={environmentId}
                required
                onChange={(e) => {
                  setEnvironmentId(e.target.value);
                  setSelection(deploymentSelection());
                }}
              >
                <option value="">选择项目环境</option>
                {project.data?.environments.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </Field>
            <ErrorBanner error={environmentConfig.error} retry={environmentConfig.reload} />
            {environmentId && environmentConfig.loading ? (
              <Loading />
            ) : (
              <DeploymentSelectionPicker
                projectId={pipeline.projectId}
                inventory={inventory}
                value={selection}
                onChange={setSelection}
                disabled={busy}
              />
            )}
            {!buildOnly && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={allowPartialDeploy}
                  onChange={(e) => setAllowPartialDeploy(e.target.checked)}
                />
                允许只部署构建和归档成功的目标
              </label>
            )}
            <Field label="Pipeline 版本">
              <select
                required
                value={version}
                onChange={(e) => {
                  setVersion(Number(e.target.value));
                  setMode('');
                  setAllowPartialDeploy(false);
                  setCommitSha('');
                  setCommitOrigin(undefined);
                  setBrowsing(false);
                }}
              >
                {versions.data?.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                    {v.version === pipeline.currentVersion ? ' · 当前版本' : ''}
                  </option>
                ))}
              </select>
            </Field>
            {!configuredBranch && repository && (
              <div className="repository-run-picker">
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setBrowsing(!browsing)}
                  aria-expanded={browsing}
                >
                  <GitBranch size={15} />
                  {browsing ? '收起提交列表' : '从仓库选择提交'}
                </button>
                <span className="muted">{repository.name}</span>
              </div>
            )}
            {!configuredBranch && browsing && repository && (
              <RepositoryBrowser
                key={repository.id}
                projectId={pipeline.projectId}
                repository={repository}
                selectedSha={commitSha}
                onSelect={(commit, branch) => {
                  setCommitSha(commit.sha);
                  setCommitOrigin({ branch, subject: commit.subject });
                  setBrowsing(false);
                }}
              />
            )}
            {configuredBranch ? (
              <p className="field-note">
                预览时锁定主仓库分支 <code>{configuredBranch}</code> 的最新提交。
              </p>
            ) : (
              <Field
                label="Git Commit SHA"
                required
                hint={
                  commitOrigin
                    ? `已选 ${commitOrigin.branch} 上的提交。`
                    : '可手动输入完整的 40 或 64 位十六进制 SHA。'
                }
              >
                <input
                  className="mono"
                  value={commitSha}
                  onChange={(e) => {
                    setCommitSha(e.target.value.trim());
                    setCommitOrigin(undefined);
                  }}
                  required
                  pattern="(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})"
                  placeholder="选择提交或输入完整 SHA"
                />
              </Field>
            )}
          </fieldset>
        ) : (
          <>
            <div className="confirmation-summary">
              <ShieldCheck size={24} />
              <div>
                <strong>
                  {buildOnly
                    ? '仅构建并保留产物'
                    : `将对 ${preview.serverIds.length} 台服务器执行构建与部署`}
                </strong>
                <p>
                  {[environmentName, `Pipeline v${preview.version}`].filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>
            <div className="deployment-review">
              {repository && (
                <>
                  <span>仓库</span>
                  <span>{repository.name}</span>
                </>
              )}
              {!configuredBranch && commitOrigin && (
                <>
                  <span>所选提交</span>
                  <span>
                    {commitOrigin.branch} · {commitOrigin.subject || '无提交说明'}
                  </span>
                </>
              )}
              <span>固定 Commit</span>
              <code>{preview.commitSha}</code>
              <span>构建方式</span>
              <strong>{buildLabels[definition.buildLocation]}</strong>
              {preview.targetWorkspaceRoot && (
                <>
                  <span>目标端工作目录</span>
                  <code>{preview.targetWorkspaceRoot}</code>
                </>
              )}
              <span>产物类型</span>
              <strong>{definition.artifactType === 'FILE' ? '文件' : 'Docker 镜像'}</strong>
              <span>
                {buildOnly && definition.buildLocation === 'MANAGER' ? '关联服务器' : '目标服务器'}
              </span>
              <span>
                {preview.serverIds
                  .map(
                    (id) => inventory.servers.data?.find((server) => server.id === id)?.name || id,
                  )
                  .join('、')}
              </span>
              {!buildOnly && (
                <>
                  <span>发布范围</span>
                  <span>
                    {(preview.allowPartialDeploy ?? allowPartialDeploy)
                      ? '部署构建和归档成功的目标'
                      : '全部目标的产物就绪后部署'}
                  </span>
                  <span>部署目录</span>
                  <code>{definition.deployPath}</code>
                </>
              )}
            </div>
            {definition.nodes && (
              <section className="pipeline-nodes-editor" aria-label="执行节点预览">
                <h3 className="field-title">执行节点</h3>
                <PipelineNodeGraph
                  items={definition.nodes.map((node) => ({
                    ...node,
                    ...(node.type === 'DEPLOY' && buildOnly && { statusLabel: '本次跳过' }),
                  }))}
                />
                {!!preview.nodeSources?.length && (
                  <ul className="pipeline-node-sources" aria-label="固定源码提交">
                    {preview.nodeSources.map((source) => {
                      const node = definition.nodes?.find(({ id }) => id === source.id);
                      const sourceRepository = project.data?.repositories.find(
                        ({ id }) => id === source.repositoryId,
                      );
                      return (
                        <li key={source.id}>
                          <strong>
                            {[node?.name, sourceRepository?.name, source.branch]
                              .filter(Boolean)
                              .join(' · ')}
                          </strong>
                          <code>{source.commitSha}</code>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
            {!buildOnly && definition.startCommand && (
              <>
                <h3 className="field-title">启动命令</h3>
                <pre className="code-preview">{definition.startCommand}</pre>
              </>
            )}
            {preview.aiApprovalHash && (
              <details className="advanced-options">
                <summary>AI 执行指纹</summary>
                <p className="field-note">
                  管理员可将当前执行指纹填入 AI 权限策略，授权此版本和范围内的运行。
                </p>
                <pre className="code-preview">{preview.aiApprovalHash}</pre>
                <button
                  className="button secondary small"
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(preview.aiApprovalHash!);
                      setCopyNotice('已复制执行指纹。');
                    } catch {
                      setCopyNotice('无法复制，请手动选择指纹。');
                    }
                  }}
                >
                  复制指纹
                </button>
                {!!copyNotice && (
                  <p className="field-note" role="status">
                    {copyNotice}
                  </p>
                )}
              </details>
            )}
            <p className="muted">
              {buildOnly
                ? '构建完成后可在构建产物中查看结果。'
                : preview.requireApproval
                  ? '产物通过校验后会创建部署任务，等待管理员批准。'
                  : '归档和校验通过后会创建独立部署任务，可从构建任务跳转查看。'}
            </p>
          </>
        )}
      </Form>
    </InlineEditor>
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
              {v.definition.nodes && <PipelineNodeGraph items={v.definition.nodes} />}
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
  projectId?: string;
  artifactType: string;
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
  pipelineId?: string;
  pipelineVersion?: number;
  serverId?: string | null;
  environmentId?: string;
  targetSelection?: DeploymentSelection | null;
  deployable?: boolean;
  pinnedAt?: number | null;
  prunedAt?: number | null;
};
type DeployableArtifact = Artifact & {
  projectId: string;
  pipelineRunId: string;
  pipelineId: string;
  pipelineVersion: number;
  environmentId: string;
};
type ArtifactDeployPreview = Omit<PipelinePreview, 'mode'> & {
  mode: 'DEPLOY_ARTIFACT';
  artifactIds: string[];
};

function isDeployableArtifact(artifact: Artifact): artifact is DeployableArtifact {
  return Boolean(
    artifact.deployable &&
    artifact.projectId &&
    artifact.pipelineRunId &&
    artifact.pipelineId &&
    artifact.pipelineVersion &&
    artifact.environmentId,
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

export function RunArtifacts({
  runId,
  polling,
  canDeploy,
}: {
  runId: string;
  polling: boolean;
  canDeploy: boolean;
}) {
  const artifacts = useResource<Artifact[]>(
    `/artifacts?pipelineRunId=${encodeURIComponent(runId)}`,
    polling ? 2000 : 0,
  );
  const [selection, setSelection] = useState<DeployableArtifact>();
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
                    <ArtifactActions
                      artifact={artifact}
                      onDeploy={canDeploy && !polling ? setSelection : undefined}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="field-note">{polling ? '等待构建生成产物' : '本次运行暂无产物'}</p>
      )}
      {selection && (
        <DeployArtifacts artifact={selection} onClose={() => setSelection(undefined)} />
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

function ArtifactActions({
  artifact,
  onDeploy,
}: {
  artifact: Artifact;
  onDeploy?: (artifact: DeployableArtifact) => void;
}) {
  return (
    <div className="row-actions">
      <ArtifactDownload artifact={artifact} />
      {onDeploy && isDeployableArtifact(artifact) && (
        <button className="button secondary small" type="button" onClick={() => onDeploy(artifact)}>
          {artifact.serverId ? '部署同次构建产物' : '部署产物'}
        </button>
      )}
    </div>
  );
}

function DeployArtifacts({
  artifact,
  onClose,
}: {
  artifact: DeployableArtifact;
  onClose: () => void;
}) {
  const project = useResource<ProjectDetail>(`/projects/${artifact.projectId}`);
  const inventory = useDeploymentInventory();
  const versions = useResource<{ version: number; definition: PipelineDefinition }[]>(
    `/pipelines/${artifact.pipelineId}/versions`,
  );
  const batch = useResource<Artifact[]>(
    `/artifacts?pipelineRunId=${encodeURIComponent(artifact.pipelineRunId)}`,
  );
  const [selection, setSelection] = useState<DeploymentSelection>(() => {
    const source = deploymentSelection(artifact.targetSelection);
    return !hasDeploymentSelection(source) && artifact.serverId
      ? { ...source, serverIds: [artifact.serverId] }
      : source;
  });
  const [version, setVersion] = useState(artifact.pipelineVersion);
  const [preview, setPreview] = useState<ArtifactDeployPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selectedServers = selectedDeploymentServers(selection, inventory.groups.data ?? []);
  const groupsLoading = Boolean(selection.groupIds?.length && inventory.groups.loading);
  const environment = project.data?.environments.find(
    (entry) => entry.id === artifact.environmentId,
  );
  const serverNames = new Map(inventory.servers.data?.map((server) => [server.id, server.name]));
  const deployableArtifacts = batch.data?.filter(isDeployableArtifact) ?? [];
  const matchingArtifacts = artifact.serverId
    ? deployableArtifacts.filter(
        (entry) => entry.serverId && selectedServers.includes(entry.serverId),
      )
    : deployableArtifacts.filter((entry) => entry.id === artifact.id);
  const coveredServers = new Set(matchingArtifacts.map((entry) => entry.serverId));
  const missingServers = artifact.serverId
    ? selectedServers.filter((id) => !coveredServers.has(id))
    : [];
  const resourceError = project.error || versions.error || batch.error;

  async function deploy(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (
      !preview &&
      (!environment ||
        groupsLoading ||
        !selectedServers.length ||
        !versions.data?.some((entry) => entry.version === version) ||
        !matchingArtifacts.length ||
        missingServers.length)
    ) {
      setError('请确认环境、部署配置版本，并选择产物齐全的服务器或服务器分组。');
      return;
    }
    setBusy(true);
    setError('');
    const path = `/pipelines/${artifact.pipelineId}/artifact-deploy`;
    try {
      if (!preview) {
        const result = await post<ArtifactDeployPreview>(`${path}/preview`, {
          ...selection,
          artifactIds: matchingArtifacts.map((entry) => entry.id),
          environmentId: artifact.environmentId,
          version,
        });
        setPreview(result);
        return;
      }
      const task = await post<Task>(path, {
        ...deploymentSelection(preview.targetSelection ?? selection),
        artifactIds: preview.artifactIds,
        environmentId: preview.environmentId,
        version: preview.version,
        expectedServerIds: preview.serverIds,
        expectedConfigurationHash: preview.configurationHash,
        confirmed: true,
      });
      onClose();
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setPreview(undefined);
        void inventory.servers.reload();
        void inventory.groups.reload();
        void batch.reload();
      }
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="部署已归档产物"
      wide
      description="核对发布目标和部署配置，使用同一次构建中已校验的归档。"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Form
        submit={preview ? (preview.requireApproval ? '提交发布审批' : '确认部署') : '预览部署'}
        onSubmit={deploy}
        onCancel={() => {
          if (preview) {
            setPreview(undefined);
            setError('');
          } else onClose();
        }}
        busy={busy}
        error={error}
      >
        <ErrorBanner error={resourceError} />
        {preview ? (
          <>
            <div className="confirmation-summary">
              <ShieldCheck size={24} />
              <div>
                <strong>
                  将使用 {preview.artifactIds.length} 份归档部署到 {preview.serverIds.length}{' '}
                  台服务器
                </strong>
                <p>
                  {[environment?.name, `Pipeline v${preview.version}`].filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>
            <div className="deployment-review">
              <span>固定 Commit</span>
              <code>{preview.commitSha}</code>
              <span>产物类型</span>
              <strong>{preview.definition.artifactType === 'FILE' ? '文件' : 'Docker 镜像'}</strong>
              <span>目标服务器</span>
              <span>{preview.serverIds.map((id) => serverNames.get(id) ?? id).join('、')}</span>
              <span>部署目录</span>
              <code>{preview.definition.deployPath}</code>
            </div>
            <details className="advanced-options">
              <summary>产物校验值</summary>
              <div className="deployment-review">
                {preview.artifactIds.map((id) => {
                  const entry = matchingArtifacts.find((artifact) => artifact.id === id);
                  return (
                    <Fragment key={id}>
                      <span>
                        {entry?.serverId
                          ? (serverNames.get(entry.serverId) ?? entry.serverId)
                          : '归档'}
                      </span>
                      <code>{entry?.checksum || entry?.imageDigest || id}</code>
                    </Fragment>
                  );
                })}
              </div>
            </details>
            {preview.definition.startCommand && (
              <>
                <h3 className="field-title">启动命令</h3>
                <pre className="code-preview">{preview.definition.startCommand}</pre>
              </>
            )}
            {preview.requireApproval && <p className="field-note">管理员批准后开始部署。</p>}
          </>
        ) : (
          <fieldset disabled={busy}>
            <Field label="构建提交">
              <output className="mono">{artifact.sourceCommit || '—'}</output>
            </Field>
            <Field label="环境" hint="沿用构建时的服务环境。">
              <output>{environment?.name || (project.loading ? '加载中…' : '原环境不可用')}</output>
            </Field>
            <DeploymentSelectionPicker
              projectId={artifact.projectId}
              inventory={inventory}
              value={selection}
              onChange={setSelection}
              disabled={busy}
            />
            {missingServers.length > 0 && !batch.loading && !groupsLoading && (
              <p className="field-note">
                本次构建缺少以下目标的归档：
                {missingServers.map((id) => serverNames.get(id) ?? id).join('、')}
              </p>
            )}
            <Field label="部署配置版本" required>
              <select
                required
                value={version}
                onChange={(event) => setVersion(Number(event.target.value))}
              >
                {versions.data?.map((entry) => (
                  <option key={entry.version} value={entry.version}>
                    v{entry.version}
                    {entry.version === artifact.pipelineVersion ? ' · 构建时版本' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </fieldset>
        )}
      </Form>
    </Modal>
  );
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
  const [selection, setSelection] = useState<DeployableArtifact>();
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
              <a
                className="button secondary"
                href={
                  project
                    ? '#' +
                      deliveryPath(project.id, 'pipelines', {
                        serviceId: new URLSearchParams(query).get('serviceId'),
                      })
                    : '#/pipelines'
                }
              >
                前往 Pipeline
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
                          <ArtifactActions
                            artifact={r}
                            onDeploy={canWrite ? setSelection : undefined}
                          />
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
      {type === 'artifacts' && selection && (
        <DeployArtifacts artifact={selection} onClose={() => setSelection(undefined)} />
      )}
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
