import { useRef, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { ApiError, api, message, post, useResource } from '../../api';
import { Field, Form, Modal } from '../../components';
import { InlineEditor } from '../../InlineEditor';
import type { Server, Service, ServiceAddressBinding } from '../../models';
import { ProjectAccessLinks, projectAccessUrl } from './ProjectAccessLinks';

type AddressDraft = {
  id?: string;
  key: string;
  name: string;
  url: string;
  binding?: ServiceAddressBinding;
};
type AddressField = 'name' | 'url' | 'id' | 'binding';
type AddressErrors = Record<string, Partial<Record<AddressField, string>>>;

function fieldErrors(details: Record<string, unknown> | undefined, rows: AddressDraft[]) {
  const errors: AddressErrors = {};
  if (!Array.isArray(details?.fieldErrors)) return errors;
  for (const issue of details.fieldErrors) {
    const path = issue?.path;
    if (!Array.isArray(path) || path[0] !== 'addresses' || !Number.isInteger(path[1])) continue;
    const field = path[2];
    if (field !== 'name' && field !== 'url' && field !== 'id' && field !== 'binding') continue;
    const row = rows[path[1]];
    if (row && typeof issue.message === 'string') {
      errors[row.key] = { ...errors[row.key], [field as AddressField]: issue.message };
    }
  }
  return errors;
}

function focusAddress(form: HTMLFormElement, errors: AddressErrors) {
  const first = Object.entries(errors)[0];
  if (!first) return;
  const [key, fields] = first;
  const field = fields.name || fields.id ? 'name' : fields.binding ? 'binding' : 'url';
  form
    .querySelector<HTMLInputElement>(`[data-address-row="${key}"] [data-address-field="${field}"]`)
    ?.focus();
}

function previewAddress(binding: ServiceAddressBinding, serverHost = '') {
  const host = binding.host?.trim() || serverHost;
  if (!host || !binding.port || /[\s/@?#\\]/.test(host)) return;
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const parsed = URL.parse(
    `${binding.protocol}://${authority}:${binding.externalPort ?? binding.port}`,
  );
  if (!parsed || (binding.path && (!binding.path.startsWith('/') || /[?#\\]/.test(binding.path))))
    return;
  if (binding.path) parsed.pathname = binding.path;
  return parsed.href;
}

export function ProjectServiceEditor({
  projectId,
  service,
  modal = false,
  onClose,
  onSaved,
}: {
  projectId: string;
  service?: Service;
  modal?: boolean;
  onClose: () => void;
  onSaved: (service: Service) => void | Promise<void>;
}) {
  const nextRow = useRef(0);
  const [rows, setRows] = useState<AddressDraft[]>(() =>
    (service?.addresses ?? []).map((address) => ({ ...address, key: address.id })),
  );
  const [revision, setRevision] = useState(service?.revision);
  const [latest, setLatest] = useState<Service>();
  const [conflict, setConflict] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<AddressErrors>({});
  const hasBinding = rows.some((row) => row.binding);
  const servers = useResource<Server[]>(hasBinding ? '/servers' : null);
  const path = `/projects/${projectId}/services`;
  const itemPath = service ? `${path}/${service.id}` : undefined;

  async function readLatest() {
    if (!itemPath || busy) return;
    setBusy(true);
    setError('');
    try {
      setLatest(await api<Service>(itemPath));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, offset: -1 | 1) {
    setRows((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  }

  function change(key: string, field: 'name' | 'url', value: string) {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, [field]: value } : row)),
    );
    setErrors((current) => ({ ...current, [key]: { ...current[key], [field]: undefined } }));
  }

  function setBinding(key: string, binding?: ServiceAddressBinding) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, binding } : row)));
    setErrors((current) => ({
      ...current,
      [key]: { ...current[key], binding: undefined, url: undefined },
    }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (modal) event.stopPropagation();
    if (busy || conflict !== undefined) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const fields = {
      name: value('name'),
      slug: value('slug'),
      serviceType: value('serviceType'),
      description: value('description'),
    };
    const addresses = rows.map(({ id, name, url, binding }) => ({
      id,
      name: name.trim(),
      url: url.trim(),
      binding,
    }));
    const invalid = Object.fromEntries(
      addresses.flatMap(({ name, url, binding }, index) => {
        const issues = {
          ...(!name && { name: '请输入地址名称。' }),
          ...(!binding && !projectAccessUrl(url) && { url: '请输入不含登录凭据的 HTTP(S) 地址。' }),
          ...(binding &&
            (!binding.serverId || !binding.port) && { binding: '请选择服务器并填写监听端口。' }),
        };
        return Object.keys(issues).length ? [[rows[index].key, issues]] : [];
      }),
    );
    setErrors(invalid);
    setError('');
    if (Object.keys(invalid).length) {
      focusAddress(element, invalid);
      return;
    }
    setBusy(true);
    try {
      const modified = service
        ? Object.fromEntries(
            Object.entries(fields).filter(
              ([key, val]) => val !== (service[key as keyof typeof fields] ?? ''),
            ),
          )
        : fields;
      const initialAddresses = service?.addresses ?? [];
      const changedAddresses =
        addresses.length !== initialAddresses.length ||
        addresses.some((row, index) => {
          const initial = initialAddresses[index];
          return (
            row.id !== initial.id ||
            row.name !== initial.name ||
            row.url !== initial.url ||
            JSON.stringify(row.binding) !== JSON.stringify(initial.binding)
          );
        });
      const saved = itemPath
        ? await api<Service>(itemPath, {
            method: 'PATCH',
            body: JSON.stringify({
              ...modified,
              expectedRevision: revision,
              ...(changedAddresses && { addresses }),
            }),
          })
        : await post<Service>(path, { ...fields, addresses });
      await onSaved(saved);
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof ApiError) {
        const serverErrors = fieldErrors(cause.details, rows);
        setErrors(serverErrors);
        focusAddress(element, serverErrors);
        const current = cause.details?.currentRevision;
        if (cause.status === 409 && typeof current === 'number') {
          setConflict(current);
          setLatest(undefined);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  const Editor = modal ? Modal : InlineEditor;
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Editor
      title={service ? '编辑服务' : '添加服务'}
      onClose={close}
      wide
      {...(!modal && { busy })}
    >
      <Form
        onSubmit={save}
        busy={busy}
        error={error}
        onCancel={close}
        submitDisabled={conflict !== undefined}
      >
        <div className="form-grid">
          <Field label="名称" required>
            <input name="name" required autoFocus defaultValue={service?.name} maxLength={100} />
          </Field>
          <Field label="标识" required>
            <input
              name="slug"
              required
              defaultValue={service?.slug}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              placeholder="web"
            />
          </Field>
          <Field label="服务类型">
            <select name="serviceType" defaultValue={service?.serviceType ?? 'API'}>
              <option value="WEB">Web</option>
              <option value="API">API</option>
              <option value="WORKER">Worker</option>
              <option value="SCHEDULED_JOB">定时任务</option>
              <option value="STATIC_SITE">静态站点</option>
              <option value="DOCKER_SERVICE">Docker 服务</option>
              <option value="CUSTOM">自定义</option>
            </select>
          </Field>
        </div>
        <Field label="说明">
          <textarea
            name="description"
            defaultValue={service?.description}
            maxLength={2000}
            rows={2}
          />
        </Field>
        <fieldset className="service-address-editor">
          <legend>访问地址</legend>
          {!rows.length && <p className="muted">暂无访问地址</p>}
          {rows.map((row, index) => {
            const binding = row.binding;
            const host = servers.data?.find(({ id }) => id === binding?.serverId)?.host;
            const preview = binding && previewAddress(binding, host);
            return (
              <div
                key={row.key}
                className="service-address-editor-row"
                data-address-row={row.key}
                role="group"
                aria-label={`第 ${index + 1} 条地址`}
              >
                <Field label="地址名称">
                  <input
                    value={row.name}
                    data-address-field="name"
                    maxLength={100}
                    onChange={(event) => change(row.key, 'name', event.target.value)}
                    aria-invalid={Boolean(errors[row.key]?.name)}
                  />
                  {errors[row.key]?.name && (
                    <small className="error-text" role="alert">
                      {errors[row.key].name}
                    </small>
                  )}
                </Field>
                <div className="service-address-fields">
                  <Field label="地址来源">
                    <select
                      value={binding ? 'PORT' : 'URL'}
                      disabled={busy}
                      onChange={(event) => {
                        setBinding(
                          row.key,
                          event.target.value === 'PORT'
                            ? { serverId: '', protocol: 'http', port: 0 }
                            : undefined,
                        );
                      }}
                    >
                      <option value="URL">手动填写完整 URL</option>
                      <option value="PORT">按服务器和端口生成</option>
                    </select>
                  </Field>
                  {binding ? (
                    <>
                      <div className="service-address-binding">
                        <Field label="服务器">
                          <select
                            data-address-field="binding"
                            value={binding.serverId}
                            disabled={busy || servers.loading}
                            onChange={(event) =>
                              setBinding(row.key, { ...binding, serverId: event.target.value })
                            }
                          >
                            <option value="">选择服务器</option>
                            {binding.serverId &&
                              !servers.data?.some(({ id }) => id === binding.serverId) && (
                                <option value={binding.serverId}>已关联服务器</option>
                              )}
                            {servers.data?.map((server) => (
                              <option key={server.id} value={server.id}>
                                {server.name} · {server.host}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="监听端口">
                          <input
                            type="number"
                            min={1}
                            max={65535}
                            value={binding.port || ''}
                            onChange={(event) =>
                              setBinding(row.key, { ...binding, port: Number(event.target.value) })
                            }
                          />
                        </Field>
                        <Field label="协议">
                          <select
                            value={binding.protocol}
                            onChange={(event) =>
                              setBinding(row.key, {
                                ...binding,
                                protocol: event.target.value === 'https' ? 'https' : 'http',
                              })
                            }
                          >
                            <option value="http">HTTP</option>
                            <option value="https">HTTPS</option>
                          </select>
                        </Field>
                        <Field label="访问主机（可选）">
                          <input
                            value={binding.host ?? ''}
                            placeholder={host ?? '默认使用服务器地址'}
                            maxLength={253}
                            onChange={(event) =>
                              setBinding(row.key, {
                                ...binding,
                                host: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                        <Field label="对外端口（可选）">
                          <input
                            type="number"
                            min={1}
                            max={65535}
                            value={binding.externalPort ?? ''}
                            onChange={(event) =>
                              setBinding(row.key, {
                                ...binding,
                                externalPort: Number(event.target.value) || undefined,
                              })
                            }
                          />
                        </Field>
                        <Field label="路径（可选）">
                          <input
                            value={binding.path ?? ''}
                            placeholder="/"
                            maxLength={1024}
                            onChange={(event) =>
                              setBinding(row.key, {
                                ...binding,
                                path: event.target.value || undefined,
                              })
                            }
                          />
                        </Field>
                      </div>
                      <p className="muted">
                        SSH 地址与服务入口不同时，可填写实际访问主机及对外端口。
                      </p>
                      {preview && (
                        <p className="service-address-preview">
                          <code>{preview}</code>
                        </p>
                      )}
                      {(errors[row.key]?.binding || servers.error) && (
                        <small className="error-text" role="alert">
                          {errors[row.key]?.binding || servers.error}
                        </small>
                      )}
                    </>
                  ) : (
                    <Field label="访问 URL">
                      <input
                        value={row.url}
                        data-address-field="url"
                        maxLength={2048}
                        inputMode="url"
                        onChange={(event) => change(row.key, 'url', event.target.value)}
                        aria-invalid={Boolean(errors[row.key]?.url)}
                      />
                      {errors[row.key]?.url && (
                        <small className="error-text" role="alert">
                          {errors[row.key].url}
                        </small>
                      )}
                    </Field>
                  )}
                </div>
                <div className="row-actions service-address-order">
                  <button
                    type="button"
                    className="button secondary small"
                    aria-label={`上移第 ${index + 1} 条地址`}
                    title="上移"
                    disabled={busy || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    aria-label={`下移第 ${index + 1} 条地址`}
                    title="下移"
                    disabled={busy || index === rows.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    aria-label={`删除第 ${index + 1} 条地址`}
                    title="删除地址"
                    disabled={busy}
                    onClick={() =>
                      setRows((current) => current.filter((item) => item.key !== row.key))
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                {errors[row.key]?.id && (
                  <small className="error-text" role="alert">
                    {errors[row.key].id}
                  </small>
                )}
              </div>
            );
          })}
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => {
              const key = `new-${nextRow.current++}`;
              setRows((current) => [...current, { key, name: '', url: '' }]);
            }}
          >
            <Plus size={16} /> 添加地址
          </button>
        </fieldset>
        {conflict !== undefined && (
          <div className="service-revision-conflict">
            <strong>服务已更新到修订 {latest?.revision ?? conflict}，本次输入已保留。</strong>
            {latest ? (
              <>
                <p>
                  {latest.name} · {latest.slug} · {latest.serviceType}
                </p>
                {latest.description && <p>{latest.description}</p>}
                <ProjectAccessLinks addresses={latest.addresses} showEmpty />
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => {
                    setRevision(latest.revision);
                    setConflict(undefined);
                    setLatest(undefined);
                    setError('');
                  }}
                >
                  保留草稿并使用当前修订
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() => void readLatest()}
              >
                查看当前版本
              </button>
            )}
          </div>
        )}
      </Form>
    </Editor>
  );
}
