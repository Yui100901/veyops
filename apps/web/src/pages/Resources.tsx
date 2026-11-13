import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowRight,
  CheckCheck,
  FolderGit2,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import { api, formatTime, message, post, remove, useResource } from '../api';
import { ProjectDeploymentConfig } from './DeploymentConfig';
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
  Environment,
  Project,
  ProjectDetail,
  Repository,
  Server,
  Service,
  User,
} from '../models';

function values(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return new FormData(event.currentTarget);
}
function text(form: FormData, key: string) {
  return String(form.get(key) ?? '').trim();
}
function tags(value: string) {
  return value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function ServersPage({ user }: { user: User }) {
  const resource = useResource<Server[]>('/servers');
  const credentials = useResource<Credential[]>('/credentials');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Server>();
  const [deleting, setDeleting] = useState<Server>();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canEdit = user.role !== 'VIEWER';
  const list = (resource.data ?? []).filter((server) =>
    `${server.name} ${server.host} ${server.tags.join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const available = (credentials.data ?? []).filter(
    (item) =>
      ['SSH_PASSWORD', 'SSH_KEY', 'SSH_PRIVATE_KEY'].includes(item.type) &&
      item.status === 'ACTIVE',
  );
  async function create(event: FormEvent<HTMLFormElement>) {
    const form = values(event);
    setBusy(true);
    setError('');
    try {
      const payload = {
        name: text(form, 'name'),
        host: text(form, 'host'),
        port: Number(form.get('port')),
        username: text(form, 'username'),
        credentialId: text(form, 'credentialId'),
        hostKeyFingerprint: text(form, 'hostKeyFingerprint'),
        tags: tags(text(form, 'tags')),
      };
      if (editing)
        await api(`/servers/${editing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await post('/servers', payload);
      setCreating(false);
      setEditing(undefined);
      await resource.reload();
      setNotice('服务器已保存。请测试连接以获取最近状态。');
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function test(server: Server) {
    setTesting(server.id);
    setNotice('');
    setError('');
    try {
      const result = await post<{
        success?: boolean;
        message?: string;
        error?: string;
        osType?: string;
        status?: string;
      }>(`/servers/${server.id}/test`);
      if (result.success === false || result.status === 'OFFLINE')
        setError(result.error ?? result.message ?? 'SSH 连接失败，请核对凭据、指纹和网络。');
      else setNotice(`${server.name} 连接正常${result.osType ? ` · ${result.osType}` : ''}`);
      await resource.reload();
    } catch (err) {
      setError(message(err));
      await resource.reload();
    } finally {
      setTesting('');
    }
  }
  async function deleteServer() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/servers/${deleting.id}`);
      setDeleting(undefined);
      await resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="INFRASTRUCTURE"
        title="服务器"
        description="通过 SSH 集中管理你的服务器，无需安装 Agent。"
        action={
          <>
            <RefreshButton onClick={resource.reload} />
            {canEdit && (
              <button
                className="button primary"
                onClick={() => {
                  setError('');
                  setEditing(undefined);
                  setCreating(true);
                }}
              >
                <Plus size={17} />
                接入服务器
              </button>
            )}
          </>
        }
      />
      <ErrorBanner
        error={resource.error || (!creating && !deleting ? error : '')}
        retry={resource.error ? resource.reload : undefined}
      />
      {notice && (
        <div className="success-banner" role="status">
          <CheckCheck size={17} />
          {notice}
        </div>
      )}
      <Section
        title="服务器资源"
        subtitle={`共 ${resource.data?.length ?? 0} 台服务器`}
        action={
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索服务器"
              placeholder="搜索名称、地址或标签"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        }
      >
        {resource.loading ? (
          <Loading />
        ) : !resource.data?.length ? (
          <Empty
            icon={<ServerIcon size={25} />}
            title="接入你的第一台服务器"
            description="先创建 SSH 凭据，再填入服务器地址和可信主机指纹。"
            action={
              canEdit && (
                <button className="button primary" onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  接入服务器
                </button>
              )
            }
          />
        ) : !list.length ? (
          <Empty title="没有匹配的服务器" description="尝试其他名称、IP 地址或标签。" />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>服务器</th>
                  <th>连接地址</th>
                  <th>最近状态</th>
                  <th>标签</th>
                  <th>最近检测</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map((server) => (
                  <tr key={server.id}>
                    <td>
                      <div className="table-name">
                        <span className="resource-avatar">
                          <ServerIcon size={18} />
                        </span>
                        <div>
                          <strong>{server.name}</strong>
                          <small>{server.osType || '操作系统待检测'}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="mono">
                        {server.host}:{server.port}
                      </span>
                      <small className="cell-sub">{server.username}</small>
                    </td>
                    <td>
                      <Status value={server.status} />
                    </td>
                    <td>
                      <div className="tags">
                        {server.tags.length ? (
                          server.tags.map((tag) => (
                            <span className="tag" key={tag}>
                              {tag}
                            </span>
                          ))
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                    </td>
                    <td className="muted nowrap">{formatTime(server.lastCheckedAt)}</td>
                    <td>
                      <div className="row-actions">
                        {canEdit && (
                          <>
                            <button
                              className="text-button"
                              disabled={Boolean(testing)}
                              onClick={() => test(server)}
                            >
                              <Wifi size={14} />
                              {testing === server.id ? '检测中…' : '测试连接'}
                            </button>
                            <button
                              className="icon-button bare muted"
                              aria-label={`编辑服务器 ${server.name}`}
                              onClick={() => {
                                setError('');
                                setEditing(server);
                                setCreating(true);
                              }}
                            >
                              <Pencil size={15} />
                            </button>
                            <button
                              className="icon-button bare muted"
                              aria-label={`删除服务器 ${server.name}`}
                              onClick={() => {
                                setError('');
                                setDeleting(server);
                              }}
                            >
                              <Trash2 size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <div className="info-strip">
        <ShieldCheck size={18} />
        <p>
          <strong>可信连接，从主机指纹开始。</strong> 通过可信渠道获取 SHA256
          指纹；每次连接都会校验，平台不会自动信任未知主机。
        </p>
      </div>
      {creating && (
        <Modal
          title={editing ? '编辑服务器' : '接入服务器'}
          description="先建立身份与信任，再连接你的基础设施。"
          onClose={() => setCreating(false)}
        >
          <Form
            onSubmit={create}
            busy={busy}
            error={error}
            submit="保存服务器"
            onCancel={() => setCreating(false)}
          >
            <Field label="服务器名称" required>
              <input
                name="name"
                defaultValue={editing?.name}
                placeholder="例如 production-web-01"
                required
                maxLength={100}
                autoFocus
              />
            </Field>
            <div className="form-grid">
              <Field label="主机地址" required>
                <input
                  name="host"
                  defaultValue={editing?.host}
                  placeholder="IP 地址或域名"
                  required
                />
              </Field>
              <Field label="SSH 端口" required>
                <input
                  name="port"
                  type="number"
                  defaultValue={editing?.port ?? 22}
                  min={1}
                  max={65535}
                  required
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label="登录用户名" required>
                <input name="username" defaultValue={editing?.username ?? 'deploy'} required />
              </Field>
              <Field label="SSH 凭据" required>
                <select name="credentialId" required defaultValue={editing?.credentialId ?? ''}>
                  <option value="">选择凭据</option>
                  {available.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {!available.length && (
              <p className="inline-note">
                还没有可用 SSH 凭据。
                <a href="#/credentials" onClick={() => setCreating(false)}>
                  前往凭据中心创建
                </a>
              </p>
            )}
            <ErrorBanner error={credentials.error} />
            <Field
              label="SSH 主机指纹"
              required
              hint="从服务器管理员或可信控制台获取，格式为 SHA256:…"
            >
              <input
                name="hostKeyFingerprint"
                defaultValue={editing?.hostKeyFingerprint}
                placeholder="SHA256:主机公钥的指纹"
                required
                className="mono"
              />
            </Field>
            <Field label="标签" hint="多个标签使用逗号分隔。">
              <input
                name="tags"
                defaultValue={editing?.tags.join(', ')}
                placeholder="production, web"
              />
            </Field>
          </Form>
        </Modal>
      )}
      {deleting && (
        <Confirm
          title="移除服务器？"
          description={`即将从可用资源中移除「${deleting.name}」，已有任务和历史记录会保留。`}
          onClose={() => setDeleting(undefined)}
          onConfirm={deleteServer}
          busy={busy}
          error={error}
          destructive
          label="移除服务器"
        />
      )}
    </>
  );
}

const credentialLabels: Record<string, string> = {
  SSH_PASSWORD: 'SSH 密码',
  SSH_KEY: 'SSH 私钥',
  SSH_PRIVATE_KEY: 'SSH 私钥',
  GIT_TOKEN: 'Git Token',
  API_KEY: 'API Key',
  DOCKER_REGISTRY: 'Docker Registry 密码',
  GIT_PASSWORD: 'Git 账号密码',
};
export function CredentialsPage({ user }: { user: User }) {
  const resource = useResource<Credential[]>('/credentials');
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<Credential>();
  const [deleting, setDeleting] = useState<Credential>();
  const [type, setType] = useState('SSH_PASSWORD');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    const form = values(event);
    setBusy(true);
    setError('');
    const secret: Record<string, string> = {};
    if (type === 'SSH_KEY') {
      secret.privateKey = String(form.get('secret') ?? '');
      if (form.get('passphrase')) secret.passphrase = String(form.get('passphrase'));
    } else if (['DOCKER_REGISTRY', 'GIT_PASSWORD'].includes(type)) {
      secret.username = text(form, 'username');
      secret.password = String(form.get('secret') ?? '');
    } else
      secret[type === 'SSH_PASSWORD' ? 'password' : type === 'GIT_TOKEN' ? 'token' : 'apiKey'] =
        String(form.get('secret') ?? '');
    try {
      await post('/credentials', { name: text(form, 'name'), type, secret, metadata: {} });
      setCreating(false);
      await resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function deleteCredential() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/credentials/${deleting.id}`);
      setDeleting(undefined);
      await resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function updateCredential(event: FormEvent<HTMLFormElement>) {
    const form = values(event);
    if (!managing) return;
    setBusy(true);
    setError('');
    const replacement = String(form.get('secret') ?? '');
    const payload: { name: string; status: string; secret?: Record<string, string> } = {
      name: text(form, 'name'),
      status: text(form, 'status'),
    };
    if (replacement && ['DOCKER_REGISTRY', 'GIT_PASSWORD'].includes(managing.type)) {
      if (!text(form, 'username')) {
        setError('更换密码时需要同时提供用户名');
        setBusy(false);
        return;
      }
      payload.secret = { username: text(form, 'username'), password: replacement };
    } else if (replacement) {
      const key =
        managing.type === 'SSH_KEY'
          ? 'privateKey'
          : managing.type === 'SSH_PASSWORD'
            ? 'password'
            : managing.type === 'GIT_TOKEN'
              ? 'token'
              : 'apiKey';
      payload.secret = { [key]: replacement };
      if (managing.type === 'SSH_KEY' && form.get('passphrase'))
        payload.secret.passphrase = String(form.get('passphrase'));
    }
    try {
      await api(`/credentials/${managing.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      setManaging(undefined);
      await resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="SECURITY"
        title="凭据中心"
        description="安全保存认证信息，让资源通过引用使用凭据。"
        action={
          user.role === 'ADMIN' && (
            <button
              className="button primary"
              onClick={() => {
                setError('');
                setCreating(true);
              }}
            >
              <Plus size={17} />
              创建凭据
            </button>
          )
        }
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      <div className="security-banner">
        <span className="security-icon">
          <ShieldCheck size={25} />
        </span>
        <div>
          <h3>凭据在使用时解密，保存后不可查看明文</h3>
          <p>AES-256-GCM 加密 · 密钥保存在数据库之外 · 凭据引用检查</p>
        </div>
        <span className="small-tag">加密存储</span>
      </div>
      <Section title="认证凭据" subtitle={`共 ${resource.data?.length ?? 0} 项凭据`}>
        {resource.loading ? (
          <Loading />
        ) : !resource.data?.length ? (
          <Empty
            icon={<KeyRound size={25} />}
            title="创建第一个安全凭据"
            description="添加 SSH 密码或私钥，即可用于连接服务器。只有管理员可以管理凭据。"
            action={
              user.role === 'ADMIN' && (
                <button className="button primary" onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  创建凭据
                </button>
              )
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>凭据名称</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>创建时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {resource.data.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="table-name">
                        <span className="resource-avatar">
                          <KeyRound size={18} />
                        </span>
                        <strong>{item.name}</strong>
                      </div>
                    </td>
                    <td>{credentialLabels[item.type] ?? item.type}</td>
                    <td>
                      <Status value={item.status} />
                    </td>
                    <td className="muted">{formatTime(item.createdAt)}</td>
                    <td>
                      {user.role === 'ADMIN' && (
                        <div className="row-actions">
                          <button
                            className="text-button"
                            onClick={() => {
                              setError('');
                              setManaging(item);
                            }}
                          >
                            <Pencil size={13} />
                            管理
                          </button>
                          <button
                            className="icon-button bare muted"
                            aria-label={`删除凭据 ${item.name}`}
                            onClick={() => {
                              setError('');
                              setDeleting(item);
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {creating && (
        <Modal
          title="创建安全凭据"
          description="敏感内容只用于加密保存，API 不会返回明文。"
          onClose={() => setCreating(false)}
        >
          <Form
            onSubmit={create}
            busy={busy}
            error={error}
            submit="加密并保存"
            onCancel={() => setCreating(false)}
          >
            <Field label="凭据名称" required>
              <input
                name="name"
                required
                autoFocus
                placeholder="例如 production SSH"
                maxLength={100}
              />
            </Field>
            <Field label="凭据类型" required>
              <select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="SSH_PASSWORD">SSH 密码</option>
                <option value="SSH_KEY">SSH 私钥</option>
                <option value="GIT_TOKEN">Git Token</option>
                <option value="API_KEY">API Key</option>
                <option value="DOCKER_REGISTRY">Docker Registry 账号密码</option>
                <option value="GIT_PASSWORD">Git 账号密码</option>
              </select>
            </Field>
            {['DOCKER_REGISTRY', 'GIT_PASSWORD'].includes(type) && (
              <Field label="用户名" required>
                <input name="username" required autoComplete="off" />
              </Field>
            )}
            <Field label={type === 'SSH_KEY' ? '私钥内容' : credentialLabels[type]} required>
              {type === 'SSH_KEY' ? (
                <textarea
                  key={type}
                  name="secret"
                  required
                  rows={7}
                  className="mono"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : (
                <input
                  key={type}
                  name="secret"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder="输入需要安全保存的认证信息"
                />
              )}
            </Field>
            {type === 'SSH_KEY' && (
              <Field label="私钥口令（可选）">
                <input name="passphrase" type="password" autoComplete="new-password" />
              </Field>
            )}
          </Form>
        </Modal>
      )}
      {managing && (
        <Modal
          title="管理凭据"
          description="可以重命名、禁用或替换敏感内容，原有明文不会显示。"
          onClose={() => setManaging(undefined)}
        >
          <Form
            onSubmit={updateCredential}
            busy={busy}
            error={error}
            submit="保存变更"
            onCancel={() => setManaging(undefined)}
          >
            <Field label="凭据名称" required>
              <input name="name" defaultValue={managing.name} required maxLength={100} autoFocus />
            </Field>
            <Field label="状态" hint="禁用后，引用此凭据的后续连接或任务将无法使用它。">
              <select name="status" defaultValue={managing.status}>
                <option value="ACTIVE">已启用</option>
                <option value="DISABLED">已禁用</option>
              </select>
            </Field>
            {[
              'SSH_KEY',
              'SSH_PASSWORD',
              'GIT_TOKEN',
              'API_KEY',
              'DOCKER_REGISTRY',
              'GIT_PASSWORD',
            ].includes(managing.type) && (
              <>
                {['DOCKER_REGISTRY', 'GIT_PASSWORD'].includes(managing.type) && (
                  <Field label="新用户名" hint="仅在同时替换密码时生效；原用户名不会回显。">
                    <input name="username" autoComplete="off" />
                  </Field>
                )}
                <Field
                  label={`替换${credentialLabels[managing.type]}（可选）`}
                  hint="留空表示保留原有敏感内容。"
                >
                  {managing.type === 'SSH_KEY' ? (
                    <textarea
                      name="secret"
                      rows={6}
                      className="mono"
                      autoComplete="off"
                      placeholder="粘贴新的私钥"
                      spellCheck={false}
                    />
                  ) : (
                    <input
                      name="secret"
                      type="password"
                      autoComplete="new-password"
                      placeholder="留空保留原值"
                    />
                  )}
                </Field>
                {managing.type === 'SSH_KEY' && (
                  <Field label="新私钥口令（可选）" hint="仅在同时替换私钥时生效。">
                    <input name="passphrase" type="password" autoComplete="new-password" />
                  </Field>
                )}
              </>
            )}
          </Form>
        </Modal>
      )}
      {deleting && (
        <Confirm
          title="删除凭据？"
          description={`删除「${deleting.name}」。正在被服务器等资源引用的凭据无法删除。`}
          onClose={() => setDeleting(undefined)}
          onConfirm={deleteCredential}
          busy={busy}
          error={error}
          destructive
          label="删除凭据"
        />
      )}
    </>
  );
}

export function ProjectsPage({ user }: { user: User }) {
  const resource = useResource<Project[]>('/projects');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create(event: FormEvent<HTMLFormElement>) {
    const form = values(event);
    setBusy(true);
    setError('');
    try {
      await post('/projects', {
        name: text(form, 'name'),
        slug: text(form, 'slug'),
        description: text(form, 'description'),
        tags: tags(text(form, 'tags')),
      });
      setCreating(false);
      await resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const list = (resource.data ?? []).filter((project) =>
    `${project.name} ${project.slug}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="PROJECT WORKSPACE"
        title="项目管理"
        description="以项目组织代码仓库、应用服务与运行环境。"
        action={
          user.role !== 'VIEWER' && (
            <button
              className="button primary"
              onClick={() => {
                setError('');
                setCreating(true);
              }}
            >
              <Plus size={17} />
              创建项目
            </button>
          )
        }
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      <div className="project-toolbar">
        <span>{resource.data?.length ?? 0} 个项目</span>
        <div className="search-input">
          <Search size={16} />
          <input
            aria-label="搜索项目"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索项目"
          />
        </div>
      </div>
      {resource.loading ? (
        <Loading />
      ) : !resource.data?.length ? (
        <div className="panel">
          <Empty
            icon={<FolderGit2 size={25} />}
            title="让项目成为运维的组织中心"
            description="创建项目后，可添加多个仓库、服务和独立环境。"
            action={
              user.role !== 'VIEWER' && (
                <button className="button primary" onClick={() => setCreating(true)}>
                  <Plus size={16} />
                  创建项目
                </button>
              )
            }
          />
        </div>
      ) : !list.length ? (
        <Empty title="没有匹配的项目" description="尝试其他项目名称或标识。" />
      ) : (
        <div className="project-grid">
          {list.map((project) => (
            <a key={project.id} href={`#/projects/${project.id}`} className="project-card">
              <div className="project-card-top">
                <span className="project-avatar">
                  <FolderGit2 size={23} />
                </span>
                <span className="tag mono">{project.slug}</span>
                <ArrowRight size={18} />
              </div>
              <h2>{project.name}</h2>
              <p>{project.description || '这个项目还没有添加描述。'}</p>
              <div className="tags">
                {project.tags.map((tag) => (
                  <span className="tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
              <div className="project-card-footer">
                <span>{project.serviceCount ?? 0} 个服务</span>
                <span>{project.environmentCount ?? 0} 个环境</span>
                <span>
                  查看项目
                  <ArrowRight size={13} />
                </span>
              </div>
            </a>
          ))}
        </div>
      )}
      {creating && (
        <Modal
          title="创建项目"
          description="以项目关联仓库、服务、环境和部署配置。"
          onClose={() => setCreating(false)}
        >
          <Form
            onSubmit={create}
            error={error}
            busy={busy}
            submit="创建项目"
            onCancel={() => setCreating(false)}
          >
            <Field label="项目名称" required>
              <input
                name="name"
                required
                autoFocus
                maxLength={100}
                placeholder="例如 核心业务平台"
              />
            </Field>
            <Field label="唯一标识" required hint="使用小写字母、数字和连字符。">
              <input
                name="slug"
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                placeholder="core-platform"
              />
            </Field>
            <Field label="项目描述">
              <textarea name="description" rows={3} placeholder="这个项目用来做什么？" />
            </Field>
            <Field label="标签">
              <input name="tags" placeholder="多个标签使用逗号分隔" />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  );
}

export function ProjectPage({ id, user }: { id: string; user: User }) {
  const resource = useResource<ProjectDetail>(`/projects/${id}`);
  const credentials = useResource<Credential[]>('/credentials');
  const [adding, setAdding] = useState<'repositories' | 'services' | 'environments'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function add(event: FormEvent<HTMLFormElement>) {
    const form = values(event);
    setBusy(true);
    setError('');
    let payload: Record<string, string> = { name: text(form, 'name') };
    if (adding === 'repositories')
      payload = {
        ...payload,
        cloneUrl: text(form, 'cloneUrl'),
        defaultBranch: text(form, 'defaultBranch'),
        ...(text(form, 'credentialId') ? { credentialId: text(form, 'credentialId') } : {}),
      };
    if (adding === 'services')
      payload = { ...payload, slug: text(form, 'slug'), serviceType: text(form, 'serviceType') };
    if (adding === 'environments')
      payload = {
        ...payload,
        slug: text(form, 'slug'),
        environmentType: text(form, 'environmentType'),
      };
    try {
      await post(`/projects/${id}/${adding}`, payload);
      setAdding(undefined);
      await resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  if (!resource.data)
    return <ErrorBanner error={resource.error || '找不到这个项目。'} retry={resource.reload} />;
  const project = resource.data;
  const labels = { repositories: '仓库', services: '服务', environments: '环境' };
  return (
    <>
      <a href="#/projects" className="back-link">
        ← 返回项目列表
      </a>
      <PageHeader
        eyebrow={project.slug.toUpperCase()}
        title={project.name}
        description={project.description || '统一组织这个项目的代码、服务与环境。'}
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      <div className="detail-stats">
        <span>
          <strong>{project.repositories?.length ?? 0}</strong>代码仓库
        </span>
        <span>
          <strong>{project.services?.length ?? 0}</strong>应用服务
        </span>
        <span>
          <strong>{project.environments?.length ?? 0}</strong>运行环境
        </span>
      </div>
      <div className="project-detail-grid">
        {(['repositories', 'services', 'environments'] as const).map((key) => (
          <Section
            key={key}
            title={labels[key]}
            subtitle={
              {
                repositories: '一个项目可关联多个代码仓库',
                services: '构建和部署的基本单位',
                environments: '隔离不同环境的配置',
              }[key]
            }
            action={
              user.role !== 'VIEWER' && (
                <button
                  className="button secondary small"
                  onClick={() => {
                    setError('');
                    setAdding(key);
                  }}
                >
                  <Plus size={14} />
                  添加{labels[key]}
                </button>
              )
            }
          >
            {!project[key]?.length ? (
              <div className="mini-empty">尚未添加{labels[key]}</div>
            ) : (
              <div className="resource-list">
                {project[key].map((item: Repository | Service | Environment) => (
                  <div key={item.id}>
                    <span className="resource-avatar">
                      <FolderGit2 size={17} />
                    </span>
                    <div>
                      <strong>{item.name}</strong>
                      <small>
                        {key === 'repositories'
                          ? (item as Repository).cloneUrl
                          : (item as Service | Environment).slug}
                      </small>
                    </div>
                    <span className="tag">
                      {key === 'repositories'
                        ? (item as Repository).defaultBranch
                        : key === 'services'
                          ? (item as Service).serviceType
                          : (item as Environment).environmentType}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        ))}
      </div>
      <div className="info-strip">
        <FolderGit2 size={18} />
        <p>为服务绑定仓库，并在不同环境配置部署目标。构建与发布由 Pipeline 统一执行。</p>
      </div>
      <ProjectDeploymentConfig project={project} user={user} />
      {adding && (
        <Modal title={`添加${labels[adding]}`} onClose={() => setAdding(undefined)}>
          <Form
            onSubmit={add}
            error={error}
            busy={busy}
            submit={`添加${labels[adding]}`}
            onCancel={() => setAdding(undefined)}
          >
            <Field label="名称" required>
              <input name="name" required autoFocus />
            </Field>
            {adding === 'repositories' ? (
              <>
                <Field label="Git 仓库地址" required>
                  <input
                    name="cloneUrl"
                    placeholder="https://github.com/team/repository.git"
                    required
                  />
                </Field>
                <Field label="Git 认证凭据（可选）">
                  <select name="credentialId">
                    <option value="">公开仓库，无需认证</option>
                    {credentials.data
                      ?.filter(
                        (c) =>
                          ['GIT_TOKEN', 'GIT_PASSWORD'].includes(c.type) && c.status === 'ACTIVE',
                      )
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="默认分支" required>
                  <input name="defaultBranch" defaultValue="main" required />
                </Field>
              </>
            ) : (
              <>
                <Field label="标识" required>
                  <input
                    name="slug"
                    required
                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                    placeholder={adding === 'services' ? 'web' : 'production'}
                  />
                </Field>
                {adding === 'services' ? (
                  <Field label="服务类型">
                    <select name="serviceType">
                      <option value="WEB">Web</option>
                      <option value="API">API</option>
                      <option value="WORKER">Worker</option>
                      <option value="STATIC_SITE">静态站点</option>
                      <option value="DOCKER_SERVICE">Docker 服务</option>
                      <option value="CUSTOM">自定义</option>
                    </select>
                  </Field>
                ) : (
                  <Field label="环境类型">
                    <select name="environmentType">
                      <option value="DEVELOPMENT">开发环境</option>
                      <option value="TESTING">测试环境</option>
                      <option value="STAGING">预发布环境</option>
                      <option value="PRODUCTION">生产环境</option>
                      <option value="CUSTOM">自定义</option>
                    </select>
                  </Field>
                )}
              </>
            )}
          </Form>
        </Modal>
      )}
    </>
  );
}

// Keep API-only resources discoverable without suggesting unsupported deployment behavior.
export async function fetchProject(id: string) {
  return api<ProjectDetail>(`/projects/${id}`);
}
