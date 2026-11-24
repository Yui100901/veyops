import { InlineEditor, useInlineEditor } from '../../InlineEditor';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, formatTime, message, post, remove, useResource } from '../../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  PageHeader,
  Section,
  Status,
} from '../../components';
import type { Credential, User } from '../../models';
import { submittedForm, trimmedFormValue } from '../../form-data';

const credentialLabels: Record<string, string> = {
  SSH_PASSWORD: 'SSH 密码',
  SSH_KEY: 'SSH 私钥',
  SSH_PRIVATE_KEY: 'SSH 私钥',
  GIT_TOKEN: 'Git Token',
  API_KEY: 'API Key',
  DOCKER_REGISTRY: 'Docker Registry 密码',
  GIT_PASSWORD: 'Git 账号密码',
  CUSTOM_SECRET: '共享密钥',
};
export function CredentialsPage({ user }: { user: User }) {
  const resource = useResource<Credential[]>('/credentials');
  const [creating, setCreating] = useInlineEditor<true>();
  const [managing, setManaging] = useInlineEditor<Credential>();
  const [deleting, setDeleting] = useState<Credential>();
  const [type, setType] = useState('SSH_PASSWORD');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function create(event: FormEvent<HTMLFormElement>) {
    const form = submittedForm(event);
    setBusy(true);
    setError('');
    const secret: Record<string, string> = {};
    if (type === 'SSH_KEY') {
      secret.privateKey = String(form.get('secret') ?? '');
      if (form.get('passphrase')) secret.passphrase = String(form.get('passphrase'));
    } else if (['DOCKER_REGISTRY', 'GIT_PASSWORD'].includes(type)) {
      secret.username = trimmedFormValue(form, 'username');
      secret.password = String(form.get('secret') ?? '');
    } else if (type === 'CUSTOM_SECRET') {
      secret.value = String(form.get('secret') ?? '');
    } else
      secret[type === 'SSH_PASSWORD' ? 'password' : type === 'GIT_TOKEN' ? 'token' : 'apiKey'] =
        String(form.get('secret') ?? '');
    try {
      await post('/credentials', {
        name: trimmedFormValue(form, 'name'),
        type,
        secret,
        metadata: {},
      });
      setCreating(undefined);
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
    const form = submittedForm(event);
    if (!managing) return;
    setBusy(true);
    setError('');
    const replacement = String(form.get('secret') ?? '');
    const payload: { name: string; status: string; secret?: Record<string, string> } = {
      name: trimmedFormValue(form, 'name'),
      status: trimmedFormValue(form, 'status'),
    };
    if (replacement && ['DOCKER_REGISTRY', 'GIT_PASSWORD'].includes(managing.type)) {
      if (!trimmedFormValue(form, 'username')) {
        setError('更换密码时需要同时提供用户名');
        setBusy(false);
        return;
      }
      payload.secret = { username: trimmedFormValue(form, 'username'), password: replacement };
    } else if (replacement && managing.type === 'CUSTOM_SECRET') {
      payload.secret = { value: replacement };
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
      <div className="editor-origin" hidden={Boolean(creating || managing)}>
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
      </div>
      {creating && (
        <InlineEditor
          busy={busy}
          title="创建安全凭据"
          description="敏感内容只用于加密保存，API 不会返回明文。"
          onClose={() => setCreating(undefined)}
        >
          <Form
            onSubmit={create}
            busy={busy}
            error={error}
            submit="加密并保存"
            onCancel={() => setCreating(undefined)}
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
                <option value="CUSTOM_SECRET">共享密钥</option>
              </select>
            </Field>
            {['DOCKER_REGISTRY', 'GIT_PASSWORD'].includes(type) && (
              <Field label="用户名" required>
                <input name="username" required autoComplete="off" />
              </Field>
            )}
            <Field
              label={type === 'SSH_KEY' ? '私钥内容' : credentialLabels[type]}
              hint={
                type === 'CUSTOM_SECRET'
                  ? '用于 Gitea Webhook 时，请使用至少 32 字节的随机密钥。'
                  : undefined
              }
              required
            >
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
        </InlineEditor>
      )}
      {managing && (
        <InlineEditor
          busy={busy}
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
              'CUSTOM_SECRET',
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
        </InlineEditor>
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
