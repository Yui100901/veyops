import { InlineEditor, useInlineEditor } from '../InlineEditor';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowRight,
  CheckCheck,
  FolderGit2,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import { api, ApiError, formatTime, message, post, remove, useResource } from '../api';
import { ServerGroups, ServerOverview } from './ServerResources';
import { ServerComparison } from './ServerComparison';
import { MonitorSummary } from './ServerMonitoring';
import { metricNames, metricValue } from './monitoring-data';
import type { MetricKey, MonitorRow } from './monitoring-data';
import { ProjectBasicsFields, projectBasicsValues } from './ProjectConfiguration';
import { ProjectAccessLinks, type ProjectAccessLink } from './ProjectAccessLinks';
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
import type { Credential, Project, Server, ServerGroup, User } from '../models';
import './resources-workspace.css';

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
  const metrics = useResource<MonitorRow[]>('/monitoring/servers?summary=true', 30000);
  const groups = useResource<ServerGroup[]>('/server-groups');
  const canEdit = user.role !== 'VIEWER';
  const [compare, setCompare] = useInlineEditor<true>();
  const [openMetrics, setOpenMetrics] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [tag, setTag] = useState('');
  const [sortBy, setSortBy] = useState<MetricKey | ''>('');
  const [section, setSection] = useState<'servers' | 'groups'>('servers');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useInlineEditor<Server | 'new'>();
  const [checkingKey, setCheckingKey] = useState<Server>();
  const [keyMismatch, setKeyMismatch] = useState<Server>();
  const [inspecting, setInspecting] = useInlineEditor<Server>();
  const [deleting, setDeleting] = useState<Server>();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const byServer = new Map((metrics.data ?? []).map((row) => [row.serverId, row]));
  const memberIds = new Set(groups.data?.find((item) => item.id === groupId)?.serverIds);
  const list = (resource.data ?? []).filter(
    (server) =>
      (!groupId || memberIds.has(server.id)) &&
      (!tag || server.tags.includes(tag)) &&
      `${server.name} ${server.host} ${server.tags.join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  if (sortBy) {
    const value = (id: string) => {
      const row = byServer.get(id);
      return metricValue(row?.metrics, sortBy, row?.interfaceName) ?? -1;
    };
    list.sort((left, right) => value(right.id) - value(left.id));
  }
  const panelOpen = Boolean(editor || inspecting || compare);
  function inspect(server: Server, showMetrics: boolean) {
    setOpenMetrics(showMetrics);
    setInspecting(server);
  }
  function reloadServers() {
    void resource.reload();
    void metrics.reload();
    void groups.reload();
  }
  async function test(server: Server, saved = false) {
    setTesting(server.id);
    setNotice('');
    setError('');
    setKeyMismatch(undefined);
    try {
      const result = await post<{
        success?: boolean;
        message?: string;
        error?: string;
        osType?: string;
        status?: string;
        server?: Server;
      }>(`/servers/${server.id}/test`);
      if (result.success === false || (result.status ?? result.server?.status) === 'OFFLINE') {
        const reason = result.error ?? result.message ?? 'SSH 连接失败，请核对凭据和网络。';
        setError(saved ? `已保存 ${server.name}，登录验证失败。${reason}` : reason);
      } else {
        const os = result.osType ?? result.server?.osType;
        setNotice(`${server.name} 连接正常${os ? ` · ${os}` : ''}`);
      }
    } catch (err) {
      const reason = message(err);
      if (err instanceof ApiError && err.status === 409 && reason.includes('指纹')) {
        setKeyMismatch(server);
      }
      setError(saved ? `已保存 ${server.name}，登录验证失败。${reason}` : reason);
    } finally {
      await resource.reload();
      setTesting('');
    }
  }
  function saved(server: Server, verify: boolean) {
    setEditor(undefined);
    setCheckingKey(undefined);
    setError('');
    setKeyMismatch(undefined);
    void resource.reload();
    if (verify) void test(server, true);
    else {
      setNotice(`已保存 ${server.name}`);
    }
  }
  async function deleteServer() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/servers/${deleting.id}`);
      if (keyMismatch?.id === deleting.id) setKeyMismatch(undefined);
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
        description="管理 SSH 主机与服务器分组。"
        action={
          <div hidden={panelOpen}>
            <div className="row-actions">
              {section === 'servers' && <RefreshButton onClick={reloadServers} />}
              {section === 'servers' && canEdit && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={(resource.data?.length ?? 0) < 2}
                  onClick={() => setCompare(true)}
                >
                  配置对比
                </button>
              )}
              {canEdit && section === 'servers' && (
                <button
                  className="button primary"
                  onClick={() => {
                    setError('');
                    setEditor('new');
                  }}
                >
                  <Plus size={17} />
                  接入服务器
                </button>
              )}
            </div>
          </div>
        }
      />
      <div hidden={panelOpen}>
        <nav className="resource-section-switcher" aria-label="服务器资源">
          <button
            type="button"
            aria-pressed={section === 'servers'}
            onClick={() => {
              setSection('servers');
              void groups.reload();
            }}
          >
            服务器
          </button>
          <button
            type="button"
            aria-pressed={section === 'groups'}
            onClick={() => setSection('groups')}
          >
            服务器分组
          </button>
        </nav>
        <ErrorBanner
          error={resource.error || (!editor && !deleting && !checkingKey ? error : '')}
          retry={resource.error ? resource.reload : undefined}
        />
        {keyMismatch && section === 'servers' && (
          <div className="server-key-action">
            <button
              className="button secondary"
              type="button"
              onClick={() => setCheckingKey(keyMismatch)}
            >
              <ShieldCheck size={18} /> 核对 {keyMismatch.name} 的 SSH 指纹
            </button>
          </div>
        )}
        {notice && (
          <div className="success-banner" role="status">
            <CheckCheck size={17} />
            {notice}
          </div>
        )}
        {section === 'servers' ? (
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
            {Boolean(resource.data?.length) && (
              <div className="monitor-list-filters monitor-toolbar">
                <select
                  aria-label="筛选服务器分组"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                >
                  <option value="">全部分组</option>
                  {groups.data?.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="筛选服务器标签"
                  value={tag}
                  onChange={(e) => setTag(e.target.value)}
                >
                  <option value="">全部标签</option>
                  {[...new Set(resource.data?.flatMap((s) => s.tags))].sort().map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <select
                  aria-label="按资源占用排序"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as MetricKey | '')}
                >
                  <option value="">默认排序</option>
                  {Object.entries(metricNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}从高到低
                    </option>
                  ))}
                </select>
              </div>
            )}
            <ErrorBanner error={groups.error || metrics.error} retry={reloadServers} />
            {resource.loading ? (
              <Loading />
            ) : !resource.data?.length ? (
              <Empty
                icon={<ServerIcon size={25} />}
                title="接入你的第一台服务器"
                description="填写服务器地址，探测并确认 SSH 主机指纹。"
                action={
                  canEdit && (
                    <button className="button primary" onClick={() => setEditor('new')}>
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
                      <th>SSH 状态</th>
                      <th>资源监控</th>
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
                              <button
                                className="text-button"
                                type="button"
                                onClick={() => inspect(server, false)}
                              >
                                {server.name}
                              </button>
                              <small>
                                {server.osType ||
                                  (server.hostKeyFingerprint ? '操作系统待检测' : '主机指纹待确认')}
                              </small>
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
                          <MonitorSummary
                            row={byServer.get(server.id)}
                            open={() => inspect(server, true)}
                          />
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
                                  disabled={Boolean(testing) || !server.hostKeyFingerprint}
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
                                    setEditor(server);
                                  }}
                                >
                                  <Pencil size={15} />
                                </button>
                                <button
                                  className="icon-button bare muted"
                                  aria-label={`核对服务器 ${server.name} 的 SSH 指纹`}
                                  title="核对 SSH 指纹"
                                  onClick={() => setCheckingKey(server)}
                                >
                                  <ShieldCheck size={17} />
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
        ) : (
          <ServerGroups
            servers={resource.data ?? []}
            canEdit={canEdit}
            serversLoading={resource.loading}
          />
        )}
      </div>
      {editor && (
        <ServerEditor
          editing={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(undefined)}
          onSaved={saved}
        />
      )}
      {checkingKey && (
        <ServerHostKeyDialog
          server={checkingKey}
          onClose={() => setCheckingKey(undefined)}
          onSaved={saved}
        />
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
      {inspecting && (
        <ServerOverview
          key={inspecting.id}
          monitorRow={byServer.get(inspecting.id)}
          server={inspecting}
          initialMetrics={openMetrics}
          canEdit={canEdit}
          onMonitorChange={metrics.reload}
          onClose={() => setInspecting(undefined)}
        />
      )}
      {compare && (
        <ServerComparison servers={resource.data ?? []} onClose={() => setCompare(undefined)} />
      )}
    </>
  );
}

type HostKeyProbe = {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  acceptanceToken: string;
  expiresAt: number;
  previousFingerprint?: string;
  matchesPrevious?: boolean;
};

function sshHostIdentity(host: string) {
  const value = host.trim().toLowerCase();
  if (value.includes(':')) {
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch {
      return value;
    }
  }
  return value;
}

function useHostKeyProbe(serverId?: string) {
  const [result, setResult] = useState<HostKeyProbe>();
  const [accepted, setAccepted] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  function reset() {
    setResult(undefined);
    setAccepted(false);
    setError('');
  }
  async function check(host: string, port: number) {
    reset();
    if (!host.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
      setError('请输入主机地址和有效的 SSH 端口。');
      return;
    }
    setChecking(true);
    try {
      setResult(
        await post<HostKeyProbe>('/servers/host-key/probe', { host: host.trim(), port, serverId }),
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(
      () => {
        setResult(undefined);
        setAccepted(false);
        setError('本次探测已过期，请重新探测。');
      },
      Math.max(0, result.expiresAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [result]);
  return { result, accepted, setAccepted, checking, error, reset, check };
}

function HostKeyReview({ probe }: { probe: ReturnType<typeof useHostKeyProbe> }) {
  const result = probe.result;
  if (!result) return null;
  return (
    <div className="server-key-review" aria-live="polite">
      <div className="server-key-title">
        <ShieldCheck size={19} />
        <div>
          <strong>
            {result.host} · {result.port}
          </strong>
          <span>{result.algorithm}</span>
        </div>
      </div>
      {result.previousFingerprint && !result.matchesPrevious && (
        <div className="server-key-value">
          <span>原指纹</span>
          <code>{result.previousFingerprint}</code>
        </div>
      )}
      <div className="server-key-value">
        <span>{result.previousFingerprint && !result.matchesPrevious ? '新指纹' : '主机指纹'}</span>
        <code>{result.fingerprint}</code>
      </div>
      {result.matchesPrevious === true ? (
        <p>当前主机指纹与已信任记录一致。</p>
      ) : (
        <>
          <p>请与服务器控制台或管理员提供的指纹核对。</p>
          <label className="server-key-acknowledgement">
            <input
              type="checkbox"
              checked={probe.accepted}
              onChange={(event) => probe.setAccepted(event.target.checked)}
            />
            {result.previousFingerprint ? '确认接受新的主机指纹' : '确认接受此主机指纹'}
          </label>
        </>
      )}
    </div>
  );
}

function HostKeyProbeButton({
  checking,
  disabled,
  run,
}: {
  checking: boolean;
  disabled?: boolean;
  run: () => void;
}) {
  return (
    <button
      className="button secondary"
      type="button"
      disabled={checking || disabled}
      onClick={run}
    >
      {checking ? <LoaderCircle className="spin" size={18} /> : <Wifi size={18} />}
      {checking ? '探测中…' : '探测 SSH 指纹'}
    </button>
  );
}

function ServerEditor({
  editing,
  onClose,
  onSaved,
}: {
  editing?: Server;
  onClose: () => void;
  onSaved: (server: Server, verify: boolean) => void;
}) {
  const credentials = useResource<Credential[]>('/credentials');
  const [host, setHost] = useState(editing?.host ?? '');
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [credentialId, setCredentialId] = useState(editing?.credentialId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const probe = useHostKeyProbe(editing?.id);
  const available = (credentials.data ?? []).filter(
    (item) =>
      ['SSH_PASSWORD', 'SSH_KEY', 'SSH_PRIVATE_KEY'].includes(item.type) &&
      item.status === 'ACTIVE',
  );
  const usableCredential = available.some((item) => item.id === credentialId);
  const requiresKey =
    !editing ||
    sshHostIdentity(host) !== sshHostIdentity(editing.host) ||
    Number(port) !== editing.port;
  const busy = probe.checking || saving;
  const trusted = Boolean(probe.accepted && probe.result && probe.result.expiresAt > Date.now());
  async function save(event: FormEvent<HTMLFormElement>) {
    const form = values(event);
    if (busy || !usableCredential || (requiresKey && !trusted)) return;
    setSaving(true);
    setError('');
    const username = text(form, 'username');
    const payload = {
      name: text(form, 'name'),
      host: host.trim(),
      port: Number(port),
      username,
      credentialId,
      tags: tags(text(form, 'tags')),
      description: text(form, 'description'),
      ...(requiresKey && { hostKeyAcceptanceToken: probe.result?.acceptanceToken }),
    };
    try {
      const server = editing
        ? await api<Server>(`/servers/${editing.id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await post<Server>('/servers', payload);
      onSaved(
        server,
        Boolean(
          requiresKey ||
          (server.hostKeyFingerprint &&
            (username !== editing?.username || credentialId !== editing?.credentialId)),
        ),
      );
    } catch (err) {
      if (requiresKey && err instanceof ApiError && err.status === 409) probe.reset();
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <InlineEditor title={editing ? '编辑服务器' : '接入服务器'} busy={busy} onClose={onClose}>
      <form onSubmit={save}>
        <div className="form-body">
          <Field label="服务器名称" required>
            <input
              name="name"
              defaultValue={editing?.name}
              placeholder="例如 web-01"
              required
              maxLength={100}
              autoFocus={Boolean(editing)}
            />
          </Field>
          <div className="form-grid">
            <Field label="主机地址" required>
              <input
                name="host"
                value={host}
                placeholder="IP 地址或域名"
                required
                maxLength={253}
                disabled={busy}
                autoFocus={!editing}
                onChange={(event) => {
                  setHost(event.target.value);
                  probe.reset();
                  setError('');
                }}
              />
            </Field>
            <Field label="SSH 端口" required>
              <input
                name="port"
                type="number"
                value={port}
                min={1}
                max={65535}
                required
                disabled={busy}
                onChange={(event) => {
                  setPort(event.target.value);
                  probe.reset();
                  setError('');
                }}
              />
            </Field>
          </div>
          {requiresKey ? (
            <div className="server-key-action">
              <HostKeyProbeButton
                checking={probe.checking}
                disabled={saving}
                run={() => void probe.check(host, Number(port))}
              />
              <ErrorBanner error={probe.error} />
              <HostKeyReview probe={probe} />
            </div>
          ) : (
            <div className="server-key-value server-key-value-saved">
              <span>
                {editing?.hostKeyFingerprint
                  ? '已信任的 SSH 指纹'
                  : 'SSH 指纹待确认，可从服务器列表核对'}
              </span>
              {editing?.hostKeyFingerprint && <code>{editing.hostKeyFingerprint}</code>}
            </div>
          )}
          <div className="form-grid">
            <Field label="登录用户名" required>
              <input name="username" defaultValue={editing?.username ?? 'deploy'} required />
            </Field>
            <Field label="SSH 凭据" required>
              <select
                name="credentialId"
                required
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
              >
                <option value="">选择凭据</option>
                {credentialId && !usableCredential && (
                  <option value={credentialId} disabled>
                    {credentials.loading ? '正在加载凭据…' : '当前凭据不可用'}
                  </option>
                )}
                {available.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {!available.length && !credentials.loading && !credentials.error && (
            <p className="inline-note">
              暂无可用 SSH 凭据。
              <a href="#/credentials" onClick={onClose}>
                打开凭据中心
              </a>
            </p>
          )}
          <ErrorBanner error={credentials.error} retry={credentials.reload} />
          <Field label="标签" hint="多个标签使用逗号分隔。">
            <input
              name="tags"
              defaultValue={editing?.tags.join(', ')}
              placeholder="production, web"
            />
          </Field>
          <Field label="说明">
            <textarea
              name="description"
              defaultValue={editing?.description}
              maxLength={2000}
              rows={2}
            />
          </Field>
          <ErrorBanner error={error} />
        </div>
        <div className="modal-footer">
          <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !usableCredential || (requiresKey && !trusted)}
          >
            {saving ? <LoaderCircle className="spin" size={18} /> : <CheckCheck size={18} />}
            {saving ? '保存中…' : requiresKey ? '保存并验证登录' : '保存服务器'}
          </button>
        </div>
      </form>
    </InlineEditor>
  );
}

function ServerHostKeyDialog({
  server,
  onClose,
  onSaved,
}: {
  server: Server;
  onClose: () => void;
  onSaved: (server: Server, verify: boolean) => void;
}) {
  const probe = useHostKeyProbe(server.id);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = probe.checking || saving;
  async function save() {
    const result = probe.result;
    if (
      busy ||
      !probe.accepted ||
      !result ||
      result.matchesPrevious ||
      result.expiresAt <= Date.now()
    )
      return;
    setSaving(true);
    setError('');
    try {
      const updated = await post<Server>(`/servers/${server.id}/host-key/accept`, {
        hostKeyAcceptanceToken: result.acceptanceToken,
      });
      onSaved(updated, true);
    } catch (err) {
      probe.reset();
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="核对 SSH 指纹"
      description={`${server.name} · ${server.host} · ${server.port}`}
      onClose={() => !busy && onClose()}
    >
      <div className="form-body">
        <div className="server-key-action">
          <HostKeyProbeButton
            checking={probe.checking}
            disabled={saving}
            run={() => {
              setError('');
              void probe.check(server.host, server.port);
            }}
          />
          <ErrorBanner error={probe.error || error} />
          <HostKeyReview probe={probe} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="button secondary" type="button" onClick={onClose} disabled={busy}>
          关闭
        </button>
        {probe.result && !probe.result.matchesPrevious && (
          <button
            className="button primary"
            type="button"
            onClick={() => void save()}
            disabled={busy || !probe.accepted}
          >
            {saving ? '保存中…' : '更新指纹并验证登录'}
          </button>
        )}
      </div>
    </Modal>
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
    } else if (type === 'CUSTOM_SECRET') {
      secret.value = String(form.get('secret') ?? '');
    } else
      secret[type === 'SSH_PASSWORD' ? 'password' : type === 'GIT_TOKEN' ? 'token' : 'apiKey'] =
        String(form.get('secret') ?? '');
    try {
      await post('/credentials', { name: text(form, 'name'), type, secret, metadata: {} });
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

function ProjectEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    const payload = projectBasicsValues(values(event));
    setBusy(true);
    setError('');
    try {
      await post('/projects', payload);
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor title="创建项目" onClose={onClose} busy={busy}>
      <Form onSubmit={save} error={error} busy={busy} submit="创建项目" onCancel={onClose}>
        <ProjectBasicsFields autoFocus />
      </Form>
    </InlineEditor>
  );
}

export function ProjectsPage({ user }: { user: User }) {
  const resource = useResource<(Project & { addresses: ProjectAccessLink[] })[]>(
    '/projects?include=addresses',
  );
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useInlineEditor<true>();
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
              disabled={creating}
              onClick={() => setCreating(true)}
            >
              <Plus size={17} />
              创建项目
            </button>
          )
        }
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      {creating && (
        <ProjectEditor
          onClose={() => setCreating(undefined)}
          onSaved={() => {
            setCreating(undefined);
            void resource.reload();
          }}
        />
      )}
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
                <button
                  className="button primary"
                  disabled={creating}
                  onClick={() => setCreating(true)}
                >
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
        <div className="project-grid project-catalog">
          {list.map((project) => (
            <article key={project.id} className="project-card">
              <div className="project-card-top">
                <span className="project-avatar" aria-hidden="true">
                  <FolderGit2 size={23} />
                </span>
                <div>
                  <h2>{project.name}</h2>
                  <span className="project-slug mono">{project.slug}</span>
                </div>
              </div>
              {project.description && <p>{project.description}</p>}
              {project.tags.length > 0 && (
                <div className="tags">
                  {project.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <ProjectAccessLinks addresses={project.addresses ?? []} />
              <div className="project-card-footer">
                <span>{project.serviceCount ?? 0} 个服务</span>
                <span>{project.environmentCount ?? 0} 个环境</span>
                <a
                  href={`#/projects/${encodeURIComponent(project.id)}`}
                  className="button secondary small"
                  aria-label={`查看项目：${project.name}`}
                >
                  项目详情 <ArrowRight size={15} aria-hidden="true" />
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
