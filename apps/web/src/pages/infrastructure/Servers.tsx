import { InlineEditor, useInlineEditor } from '../../InlineEditor';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  CheckCheck,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Trash2,
  Wifi,
} from 'lucide-react';
import { api, ApiError, formatTime, message, navigate, post, remove, useResource } from '../../api';
import { ServerGroupOverview, ServerGroups, ServerOverview } from './ServerResources';
import { ServerComparison } from './ServerComparison';
import { MonitorSummary } from './ServerMonitoring';
import { metricNames, metricValue } from './monitoring-data';
import type { MetricKey, MonitorRow } from './monitoring-data';
import { readServerResourceLocation, serverResourceHref } from './server-resource-route';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  Modal,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../../components';
import type { Credential, Server, ServerDetail, ServerGroup, User } from '../../models';
import './server-access.css';
import { submittedForm, trimmedFormValue } from '../../form-data';

function tags(value: string) {
  return value
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function ServersPage({ user, search: routeSearch }: { user: User; search?: string }) {
  const view = readServerResourceLocation(routeSearch);
  const { serverId, groupId: detailGroupId } = view;
  const resource = useResource<Server[]>('/servers');
  const metrics = useResource<MonitorRow[]>('/monitoring/servers?summary=true', 30000);
  const groups = useResource<ServerGroup[]>('/server-groups');
  const detail = useResource<ServerDetail>(
    serverId ? `/servers/${encodeURIComponent(serverId)}` : null,
  );
  const detailGroup = useResource<ServerGroup>(
    detailGroupId && !serverId ? `/server-groups/${encodeURIComponent(detailGroupId)}` : null,
  );
  const canEdit = user.role === 'ADMIN';
  const canTest = user.role !== 'VIEWER';
  const [compare, setCompare] = useInlineEditor<true>();
  const [groupId, setGroupId] = useState('');
  const [tag, setTag] = useState('');
  const [sortBy, setSortBy] = useState<MetricKey | ''>('');
  const [section, setSection] = useState<'servers' | 'groups'>('servers');
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useInlineEditor<Server | 'new'>();
  const [checkingKey, setCheckingKey] = useState<Server>();
  const [keyMismatch, setKeyMismatch] = useState<Server>();
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
  const panelOpen = Boolean(editor || serverId || detailGroupId || compare);
  function inspect(server: Server, showMetrics: boolean) {
    navigate(
      serverResourceHref({ serverId: server.id, panel: showMetrics ? 'metrics' : undefined }).slice(
        1,
      ),
    );
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
              {section === 'servers' && canTest && (
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
        {canEdit && keyMismatch && section === 'servers' && (
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
                              <a
                                className="text-link"
                                href={serverResourceHref({ serverId: server.id })}
                              >
                                {server.name}
                              </a>
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
                            {canTest && (
                              <button
                                className="text-button"
                                disabled={Boolean(testing) || !server.hostKeyFingerprint}
                                onClick={() => test(server)}
                              >
                                <Wifi size={14} />
                                {testing === server.id ? '检测中…' : '测试连接'}
                              </button>
                            )}
                            {canEdit && (
                              <>
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
      {(serverId || detailGroupId) && (
        <>
          <a className="back-link" href={view.returnPath ? '#' + view.returnPath : '#/servers'}>
            {view.returnPath ? '← 返回来源' : '← 返回服务器'}
          </a>
          <ErrorBanner
            error={serverId ? detail.error : detailGroup.error}
            retry={serverId ? detail.reload : detailGroup.reload}
          />
          {(serverId ? detail.loading : detailGroup.loading) && <Loading />}
          {serverId && detail.data?.id === serverId && (
            <ServerOverview
              key={`${serverId}:${view.panel ?? ''}`}
              monitorRow={byServer.get(serverId)}
              server={detail.data}
              initialMetrics={view.panel === 'metrics'}
              canEdit={canEdit && detail.data.active !== false}
              onMonitorChange={metrics.reload}
              onAuthorizationChange={() => {
                void detail.reload();
                void resource.reload();
              }}
              onClose={() => navigate(view.returnPath ?? '/servers')}
            />
          )}
          {!serverId && detailGroupId && detailGroup.data?.id === detailGroupId && (
            <ServerGroupOverview
              group={detailGroup.data}
              search={routeSearch}
              servers={resource.data ?? []}
              onClose={() => {
                setSection('groups');
                navigate(view.returnPath ?? '/servers');
              }}
            />
          )}
        </>
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
    const form = submittedForm(event);
    if (busy || !usableCredential || (requiresKey && !trusted)) return;
    setSaving(true);
    setError('');
    const username = trimmedFormValue(form, 'username');
    const payload = {
      name: trimmedFormValue(form, 'name'),
      host: host.trim(),
      port: Number(port),
      username,
      credentialId,
      tags: tags(trimmedFormValue(form, 'tags')),
      description: trimmedFormValue(form, 'description'),
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
