import { useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Radio } from 'lucide-react';
import { api, formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field, Loading, RefreshButton, Section, Status } from '../components';
import type { Credential } from '../models';
import type { GraphDocument, GraphFlow } from './execution-graph-definition';
import { graphKey, isDeliveryNode } from './execution-graph-definition';

const kindNames = {
  CRON: '定时',
  WEBHOOK: '签名 Webhook',
  API: '认证 API',
  UPSTREAM: '上游执行流',
};
interface TriggerConfig {
  name: string;
  kind: keyof typeof kindNames;
  flowId: string;
  version: number;
  enabled: boolean;
  inputValue?: string | null;
  cron?: string | null;
  timeZone?: string | null;
  credentialId?: string | null;
  upstreamFlowId?: string | null;
  upstreamStatus?: 'SUCCESS' | 'FAILED' | 'ANY' | null;
}
interface TriggerRule extends TriggerConfig {
  id: string;
  nextAt: number | null;
}
interface TriggerEvent {
  id: string;
  eventId: string;
  status: 'PENDING' | 'QUEUED' | 'REJECTED';
  runId?: string | null;
  error?: string | null;
  createdAt: number;
  finishedAt?: number | null;
}

function unavailableReason(flow: GraphFlow, flows: GraphFlow[]) {
  const visited = new Set<string>();
  const pending = [flow];
  for (const item of pending) {
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    if (item.nodes.some(isDeliveryNode)) return '含交付节点';
    if (item.nodes.some((node) => (node.condition?.key ?? node.switch?.key) === 'commitSha'))
      return '需要指定提交';
    pending.push(
      ...flows.filter((candidate) =>
        item.nodes.some((node) => node.type === 'FLOW_CALL' && node.flowId === candidate.id),
      ),
    );
  }
  return '';
}

export function ExecutionGraphTriggers({
  path,
  canManage,
  canInvoke,
  onRun,
}: {
  path: string;
  canManage: boolean;
  canInvoke: boolean;
  onRun: (id: string) => void;
}) {
  const rulesPath = path + '/triggers';
  const rules = useResource<TriggerRule[]>(rulesPath, 8000);
  const versions = useResource<{ version: number }[]>(path + '/versions');
  const [editing, setEditing] = useState<TriggerRule | 'create'>();
  const [selected, setSelected] = useState<string>();
  const rule = rules.data?.find(({ id }) => id === selected);
  return (
    <Section
      title="执行流触发器"
      action={
        <div className="heading-actions">
          <RefreshButton onClick={rules.reload} />
          {canManage && !editing && (
            <button
              type="button"
              className="button primary"
              onClick={() => setEditing('create')}
              disabled={!versions.data?.length}
            >
              <Plus size={16} /> 新建触发器
            </button>
          )}
        </div>
      }
    >
      <div className="graph-fields">
        <ErrorBanner error={rules.error || versions.error} />
        {!versions.loading && !versions.data?.length && <p>发布执行图后可配置触发器。</p>}
        {Boolean(versions.data?.length) && (
          <p className="field-note">
            自动触发固定已发布版本。含交付节点或需要提交 SHA
            的执行流可在「发布版本与运行」手动启动。
          </p>
        )}
        {editing && versions.data && versions.data.length > 0 && (
          <TriggerEditor
            key={editing === 'create' ? 'create' : editing.id}
            path={path}
            rule={editing === 'create' ? undefined : editing}
            versions={versions.data}
            onCancel={() => setEditing(undefined)}
            onSaved={(saved) => {
              setSelected(saved.id);
              setEditing(undefined);
              void rules.reload();
            }}
          />
        )}
        {rules.loading ? (
          <Loading />
        ) : rules.data?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>触发器</th>
                  <th>执行流</th>
                  <th>状态</th>
                  <th>下次触发</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rules.data.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.name}</strong>
                      <small className="cell-detail">{kindNames[item.kind]}</small>
                    </td>
                    <td>
                      {item.flowId} · v{item.version}
                    </td>
                    <td>
                      <Status value={item.enabled ? 'ACTIVE' : 'DISABLED'} />
                    </td>
                    <td>{formatTime(item.nextAt)}</td>
                    <td>
                      <div className="heading-actions">
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => setSelected(item.id)}
                        >
                          查看触发
                        </button>
                        {canManage && (
                          <button
                            type="button"
                            className="button secondary small"
                            onClick={() => setEditing(item)}
                          >
                            编辑
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !editing && <div className="mini-empty">尚无触发规则。</div>
        )}
        {rule && (
          <TriggerDetails
            key={rule.id}
            path={rulesPath + '/' + rule.id}
            rule={rule}
            canInvoke={canInvoke}
            onRun={onRun}
          />
        )}
      </div>
    </Section>
  );
}

function TriggerEditor({
  path,
  rule,
  versions,
  onCancel,
  onSaved,
}: {
  path: string;
  rule?: TriggerRule;
  versions: { version: number }[];
  onCancel: () => void;
  onSaved: (rule: TriggerRule) => void;
}) {
  const [form, setForm] = useState<TriggerConfig>(() => ({
    name: '',
    kind: 'API',
    flowId: '',
    version: versions[0].version,
    enabled: true,
    cron: '0 * * * *',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    upstreamStatus: 'SUCCESS',
    ...rule,
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const definition = useResource<{ version: number; definition: GraphDocument['draft'] }>(
    path + '/versions/' + form.version,
  );
  const credentials = useResource<Credential[]>(form.kind === 'WEBHOOK' ? '/credentials' : null);
  const flows = definition.data?.version === form.version ? definition.data.definition.flows : [];
  const blocked = new Map(flows.map((flow) => [flow.id, unavailableReason(flow, flows)]));
  const valid = Boolean(
    form.name.trim() &&
    blocked.has(form.flowId) &&
    !blocked.get(form.flowId) &&
    (form.kind !== 'WEBHOOK' || form.credentialId) &&
    (form.kind !== 'CRON' || (form.cron?.trim() && form.timeZone?.trim())) &&
    (form.kind !== 'UPSTREAM' ||
      (form.upstreamFlowId && form.upstreamFlowId !== form.flowId && form.upstreamStatus)),
  );
  const patch = (value: Partial<TriggerConfig>) =>
    setForm((previous) => ({ ...previous, ...value }));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !valid) return;
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      version: form.version,
      flowId: form.flowId,
      enabled: form.enabled,
      ...(form.inputValue ? { inputValue: form.inputValue } : {}),
      ...(form.kind === 'CRON' ? { cron: form.cron?.trim(), timeZone: form.timeZone?.trim() } : {}),
      ...(form.kind === 'WEBHOOK' ? { credentialId: form.credentialId } : {}),
      ...(form.kind === 'UPSTREAM'
        ? { upstreamFlowId: form.upstreamFlowId, upstreamStatus: form.upstreamStatus }
        : {}),
    };
    setBusy(true);
    setError('');
    try {
      const saved = rule
        ? await api<TriggerRule>(path + '/triggers/' + rule.id, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await post<TriggerRule>(path + '/triggers', body);
      onSaved(saved);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="graph-properties" onSubmit={(event) => void save(event)}>
      <h3>{rule ? '编辑触发器' : '新建触发器'}</h3>
      <ErrorBanner error={error || definition.error || credentials.error} />
      <fieldset disabled={busy}>
        <div className="form-grid">
          <Field label="名称">
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="触发类型">
            <select
              value={form.kind}
              onChange={(e) => patch({ kind: e.target.value as TriggerConfig['kind'] })}
            >
              {Object.entries(kindNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="固定发布版本">
            <select
              value={form.version}
              onChange={(e) =>
                patch({ version: Number(e.target.value), flowId: '', upstreamFlowId: '' })
              }
            >
              {versions.map(({ version }) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
            </select>
          </Field>
          <Field label="目标执行流">
            <select
              required
              value={form.flowId}
              onChange={(e) =>
                patch({
                  flowId: e.target.value,
                  ...(e.target.value === form.upstreamFlowId && { upstreamFlowId: '' }),
                })
              }
            >
              <option value="">请选择</option>
              {flows.map((flow) => (
                <option key={flow.id} value={flow.id} disabled={Boolean(blocked.get(flow.id))}>
                  {flow.name}
                  {blocked.get(flow.id) ? ' · ' + blocked.get(flow.id) : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="默认运行参数">
            <input
              maxLength={500}
              value={form.inputValue ?? ''}
              onChange={(e) => patch({ inputValue: e.target.value })}
            />
          </Field>
          {form.kind === 'CRON' && (
            <>
              <Field label="Cron 表达式" hint="5 段表达式，例如 0 9 * * 1-5。">
                <input
                  required
                  value={form.cron ?? ''}
                  maxLength={100}
                  onChange={(e) => patch({ cron: e.target.value })}
                />
              </Field>
              <Field label="时区" hint="IANA 时区，例如 Asia/Shanghai。">
                <input
                  required
                  value={form.timeZone ?? ''}
                  maxLength={80}
                  onChange={(e) => patch({ timeZone: e.target.value })}
                />
              </Field>
            </>
          )}
          {form.kind === 'WEBHOOK' && (
            <Field label="签名凭据" hint="从凭据管理创建并选择已启用的自定义密钥。">
              <select
                required
                value={form.credentialId ?? ''}
                onChange={(e) => patch({ credentialId: e.target.value })}
              >
                <option value="">请选择</option>
                {credentials.data
                  ?.filter(({ type, status }) => type === 'CUSTOM_SECRET' && status === 'ACTIVE')
                  .map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {form.kind === 'UPSTREAM' && (
            <>
              <Field label="上游执行流">
                <select
                  required
                  value={form.upstreamFlowId ?? ''}
                  onChange={(e) => patch({ upstreamFlowId: e.target.value })}
                >
                  <option value="">请选择</option>
                  {flows
                    .filter(({ id }) => id !== form.flowId)
                    .map(({ id, name }) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="上游结果">
                <select
                  value={form.upstreamStatus ?? 'SUCCESS'}
                  onChange={(e) =>
                    patch({ upstreamStatus: e.target.value as TriggerConfig['upstreamStatus'] })
                  }
                >
                  <option value="SUCCESS">成功</option>
                  <option value="FAILED">失败</option>
                  <option value="ANY">无论结果</option>
                </select>
              </Field>
            </>
          )}
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          启用触发器
        </label>
        <div className="heading-actions">
          <button type="submit" className="button primary" disabled={!valid || busy}>
            {busy ? '保存中…' : '保存触发器'}
          </button>
          <button type="button" className="button secondary" onClick={onCancel}>
            关闭编辑
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function TriggerDetails({
  path,
  rule,
  canInvoke,
  onRun,
}: {
  path: string;
  rule: TriggerRule;
  canInvoke: boolean;
  onRun: (id: string) => void;
}) {
  const events = useResource<TriggerEvent[]>(path + '/events', 5000);
  const [eventId, setEventId] = useState(() => graphKey('event'));
  const [inputValue, setInputValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invoked, setInvoked] = useState<TriggerEvent>();
  const latest = events.data?.find((item) => item.id === invoked?.id) ?? invoked;
  async function invoke(event: FormEvent) {
    event.preventDefault();
    if (busy || !eventId.trim()) return;
    setBusy(true);
    setError('');
    try {
      setInvoked(
        await post<TriggerEvent>(path + '/invoke', {
          eventId: eventId.trim(),
          ...(inputValue && { inputValue }),
        }),
      );
      await events.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const endpoint =
    rule.kind === 'WEBHOOK'
      ? '/api/v1/graph-webhooks/' + rule.id
      : rule.kind === 'API'
        ? '/api/v1' + path + '/invoke'
        : undefined;
  return (
    <div className="graph-properties">
      <h3>{rule.name} · 触发详情</h3>
      {endpoint && (
        <Field label={rule.kind === 'WEBHOOK' ? 'Webhook 地址' : 'API 地址'}>
          <input
            readOnly
            value={new URL(endpoint, window.location.origin).href}
            onFocus={(e) => e.target.select()}
          />
        </Field>
      )}
      {rule.kind === 'WEBHOOK' && (
        <p className="field-note">
          用 POST 发送 JSON。对 <code>timestamp.deliveryId.rawJSON</code> 计算 HMAC-SHA256，按
          <code>sha256=十六进制摘要</code> 格式传入 <code>X-Veyops-Signature</code>。时间戳使用秒，
          通过 <code>X-Veyops-Timestamp</code> 和 <code>X-Veyops-Delivery</code>{' '}
          传入时间戳与投递编号。
        </p>
      )}
      {rule.kind === 'API' && canInvoke && rule.enabled && (
        <form className="graph-properties" onSubmit={(event) => void invoke(event)}>
          <h4>测试 API 触发</h4>
          <div className="form-grid">
            <Field label="事件 ID">
              <input
                required
                maxLength={120}
                value={eventId}
                onChange={(e) => setEventId(e.target.value)}
              />
            </Field>
            <Field label="本次运行参数">
              <input
                maxLength={500}
                value={inputValue}
                placeholder="沿用规则默认值"
                onChange={(e) => setInputValue(e.target.value)}
              />
            </Field>
          </div>
          <div className="heading-actions">
            <button type="submit" className="button primary small" disabled={busy}>
              <Radio size={15} /> {busy ? '发送中…' : '发送触发请求'}
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => setEventId(graphKey('event'))}
            >
              生成新事件 ID
            </button>
          </div>
          <ErrorBanner error={error} />
          {latest && (
            <p role="status">
              事件 {latest.eventId} · <Status value={latest.status} />{' '}
              {latest.runId && (
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => {
                    if (latest.runId) onRun(latest.runId);
                  }}
                >
                  查看本次运行
                </button>
              )}
            </p>
          )}
        </form>
      )}
      <h4>最近触发事件</h4>
      <ErrorBanner error={events.error} retry={events.reload} />
      {events.loading ? (
        <Loading />
      ) : events.data?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>事件</th>
                <th>结果</th>
                <th>运行</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((item) => {
                const id = item.runId;
                return (
                  <tr key={item.id}>
                    <td>{formatTime(item.createdAt)}</td>
                    <td>{item.eventId}</td>
                    <td>
                      <Status value={item.status} />
                      {item.error && <small className="cell-detail">{item.error}</small>}
                    </td>
                    <td>
                      {id ? (
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => onRun(id)}
                        >
                          查看运行
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mini-empty">尚无触发事件。</div>
      )}
    </div>
  );
}
