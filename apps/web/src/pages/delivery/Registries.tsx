import { InlineEditor, useInlineEditor } from '../../InlineEditor';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Boxes, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { api, message, post, remove, useResource } from '../../api';
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
} from '../../components';
import type { Credential, User } from '../../models';

interface Registry {
  id: string;
  name: string;
  registryUrl: string;
  credentialId: string | null;
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
