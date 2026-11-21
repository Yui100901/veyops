import { useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Radio } from 'lucide-react';
import { api, formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field, Loading, RefreshButton, Status } from '../components';
import type { Credential, ProjectDetail } from '../models';
import { GraphFieldValue } from './ExecutionGraphFields';
import type { GraphDocument, GraphField } from './execution-graph-definition';
import { graphKey } from './execution-graph-definition';

const kindNames = {
  CRON: '定时',
  WEBHOOK: '签名 Webhook',
  API: '认证 API',
  UPSTREAM: '上游执行流',
};
const events = {
  repository: '仓库',
  commit: '实际提交 SHA',
  ref: 'Git 引用',
  eventId: '事件 ID',
  scheduledAt: '计划触发时间',
  upstreamRunId: '上游运行 ID',
  upstreamStatus: '上游状态',
} as const;
type EventField = keyof typeof events;
type ParameterMapping =
  | { source: 'EVENT'; field: EventField }
  | { source: 'VALUE'; value: unknown }
  | { source: 'UPSTREAM_OUTPUT'; fieldId: string };

const hasGitEvent = (kind: TriggerConfig['kind']) => kind === 'WEBHOOK' || kind === 'API';

function compatibleUpstream(source: GraphField, consumer: GraphField) {
  return (
    !['CREDENTIAL', 'WORKSPACE', 'VARIABLES'].includes(source.type) &&
    source.type === consumer.type &&
    Boolean(source.multiple) === Boolean(consumer.multiple) &&
    (!consumer.artifactType ||
      !source.artifactType ||
      source.artifactType === consumer.artifactType)
  );
}

interface TriggerConfig {
  name: string;
  kind: keyof typeof kindNames;
  flowId: string;
  version: number;
  enabled: boolean;
  parameterMappings?: Record<string, ParameterMapping>;
  repositoryId?: string;
  refPrefix?: string;
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

export function ExecutionGraphTriggers({
  path,
  project,
  startId,
  latestVersion,
  canManage,
  canInvoke,
  onRun,
}: {
  path: string;
  project: ProjectDetail;
  startId: string;
  latestVersion: number | null;
  canManage: boolean;
  canInvoke: boolean;
  onRun: (id: string) => void;
}) {
  const rulesPath = path + '/triggers';
  const rules = useResource<TriggerRule[]>(rulesPath, 8000);
  const versions = useResource<{ version: number }[]>(path + '/versions');
  const [editing, setEditing] = useState<TriggerRule | 'create'>();
  const [selected, setSelected] = useState<string>();
  const scopedRules = rules.data?.filter(({ flowId }) => flowId === startId) ?? [];
  const rule = scopedRules.find(({ id }) => id === selected);
  return (
    <section className="graph-start-rules" aria-label="开始节点的附加触发器">
      <div className="heading-actions">
        <h4>附加触发器</h4>
        <div className="heading-actions">
          <RefreshButton onClick={rules.reload} />
          {canManage && latestVersion && !editing && (
            <button
              type="button"
              className="button primary small"
              onClick={() => setEditing('create')}
              disabled={!versions.data?.length}
            >
              <Plus size={16} /> 新建触发器
            </button>
          )}
        </div>
      </div>
      <div className="graph-fields">
        <ErrorBanner error={rules.error || versions.error} />
        {Boolean(versions.data?.length) && (
          <p className="field-note">触发器绑定此开始节点及指定发布版本。</p>
        )}
        {editing && versions.data && versions.data.length > 0 && (
          <TriggerEditor
            key={editing === 'create' ? 'create' : editing.id}
            path={path}
            project={project}
            startId={startId}
            latestVersion={latestVersion}
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
        ) : scopedRules.length ? (
          <ul className="graph-start-rule-list">
            {scopedRules.map((item) => (
              <li key={item.id} className="graph-properties">
                <div className="heading-actions">
                  <strong>{item.name}</strong>
                  <Status value={item.enabled ? 'ACTIVE' : 'DISABLED'} />
                </div>
                <small className="cell-detail">
                  {kindNames[item.kind]} · v{item.version}
                </small>
                {item.nextAt !== null && (
                  <small className="cell-detail">下次触发 · {formatTime(item.nextAt)}</small>
                )}
                <div className="heading-actions">
                  <button
                    type="button"
                    className="button secondary small"
                    aria-expanded={selected === item.id}
                    onClick={() => setSelected(selected === item.id ? undefined : item.id)}
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
              </li>
            ))}
          </ul>
        ) : (
          !editing && <div className="mini-empty">此开始节点尚无触发规则。</div>
        )}
        {rule && (
          <TriggerDetails
            key={rule.id}
            path={rulesPath + '/' + rule.id}
            rule={rule}
            project={project}
            canInvoke={canInvoke}
            onRun={onRun}
          />
        )}
      </div>
    </section>
  );
}

function TriggerEditor({
  path,
  project,
  startId,
  latestVersion,
  rule,
  versions,
  onCancel,
  onSaved,
}: {
  path: string;
  project: ProjectDetail;
  startId: string;
  latestVersion: number | null;
  rule?: TriggerRule;
  versions: { version: number }[];
  onCancel: () => void;
  onSaved: (rule: TriggerRule) => void;
}) {
  const [form, setForm] = useState<TriggerConfig>(() => ({
    name: '',
    kind: 'API',
    flowId: startId,
    version: latestVersion ?? versions[0].version,
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
  const target = flows.find(({ id }) => id === startId);
  const fields = target?.nodes.find(({ type }) => type === 'START')?.inputs ?? [];
  const upstreamOutputs =
    form.kind === 'UPSTREAM' && form.upstreamStatus === 'SUCCESS'
      ? (flows
          .find(({ id }) => id === form.upstreamFlowId)
          ?.nodes.find(({ type }) => type === 'END')?.outputs ?? [])
      : [];
  const unavailableOutput = fields.find((field) => {
    const mapping = form.parameterMappings?.[field.id];
    return (
      mapping?.source === 'UPSTREAM_OUTPUT' &&
      !upstreamOutputs.some(
        (source) => source.id === mapping.fieldId && compatibleUpstream(source, field),
      )
    );
  });
  const missing = fields.filter(
    (field) =>
      field.required &&
      field.defaultValue === undefined &&
      !field.selection &&
      !form.parameterMappings?.[field.id],
  );
  const blocked = !target
    ? '此发布版本没有由该开始节点定义的执行流。'
    : form.enabled && missing.length
      ? '请为必填参数配置来源 · ' + missing.map(({ name }) => name).join('、')
      : unavailableOutput
        ? '参数「' + unavailableOutput.name + '」的上游输出已不可用，请重新选择。'
        : '';
  const valid = Boolean(
    form.name.trim() &&
    target &&
    !blocked &&
    (form.kind !== 'WEBHOOK' || form.credentialId) &&
    (form.kind !== 'CRON' || (form.cron?.trim() && form.timeZone?.trim())) &&
    (form.kind !== 'UPSTREAM' ||
      (form.upstreamFlowId && form.upstreamFlowId !== startId && form.upstreamStatus)),
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
      flowId: startId,
      enabled: form.enabled,
      ...(form.parameterMappings && { parameterMappings: form.parameterMappings }),
      ...(form.kind === 'CRON' ? { cron: form.cron?.trim(), timeZone: form.timeZone?.trim() } : {}),
      ...(form.kind === 'WEBHOOK'
        ? {
            credentialId: form.credentialId,
            ...(form.repositoryId && { repositoryId: form.repositoryId }),
            ...(form.refPrefix?.trim() && { refPrefix: form.refPrefix.trim() }),
          }
        : {}),
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
              onChange={(e) =>
                patch({ kind: e.target.value as TriggerConfig['kind'], parameterMappings: {} })
              }
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
                patch({
                  version: Number(e.target.value),
                  upstreamFlowId: '',
                  parameterMappings: {},
                })
              }
            >
              {versions.map(({ version }) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
            </select>
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
                    .filter(({ id }) => id !== startId)
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
        {form.kind === 'WEBHOOK' && (
          <div className="form-grid">
            <Field label="仅接收指定仓库（可选）">
              <select
                value={form.repositoryId ?? ''}
                onChange={(event) => patch({ repositoryId: event.target.value || undefined })}
              >
                <option value="">允许任意已登记仓库</option>
                {project.repositories.map(({ id, name }) => (
                  <option value={id} key={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="推送引用前缀（可选）">
              <input
                value={form.refPrefix ?? ''}
                placeholder="refs/heads/main"
                onChange={(event) => patch({ refPrefix: event.target.value || undefined })}
              />
            </Field>
          </div>
        )}
        {!!fields.length && (
          <section className="graph-fields">
            <h4>触发参数映射</h4>
            {form.kind === 'API' && (
              <p className="field-note">
                事件字段由调用方提交。映射仓库、提交或 Git 引用时，调用请求须提供相应值。
              </p>
            )}
            {form.kind === 'UPSTREAM' && form.upstreamStatus !== 'SUCCESS' && (
              <p className="field-note">触发条件为上游成功时可使用其最终输出。</p>
            )}
            {fields.map((field) => (
              <TriggerParameterField
                key={field.id}
                field={field}
                project={project}
                kind={form.kind}
                upstreamOutputs={upstreamOutputs}
                value={form.parameterMappings?.[field.id]}
                change={(mapping) => {
                  const next = { ...form.parameterMappings };
                  if (mapping) next[field.id] = mapping;
                  else delete next[field.id];
                  patch({ parameterMappings: next });
                }}
              />
            ))}
          </section>
        )}
        {!definition.loading && blocked && <p className="field-note">{blocked}</p>}
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

function TriggerParameterField({
  project,
  field,
  kind,
  upstreamOutputs,
  value,
  change,
}: {
  project: ProjectDetail;
  field: GraphField;
  kind: TriggerConfig['kind'];
  upstreamOutputs: GraphField[];
  value?: ParameterMapping;
  change: (value?: ParameterMapping) => void;
}) {
  const supported: EventField[] = [];
  if (!field.multiple) {
    if (field.type === 'NUMBER' && kind === 'CRON') supported.push('scheduledAt');
    if (field.type === 'TEXT') {
      supported.push('eventId');
      if (hasGitEvent(kind)) supported.push('commit', 'ref');
      if (kind === 'UPSTREAM') supported.push('upstreamRunId', 'upstreamStatus');
    }
    if (hasGitEvent(kind) && field.type === 'REPOSITORY') supported.push('repository');
    if (hasGitEvent(kind) && field.type === 'GIT_REF') supported.push('commit', 'ref');
  }
  const compatibleOutputs = upstreamOutputs.filter((source) => compatibleUpstream(source, field));
  const selected =
    value?.source === 'EVENT'
      ? value.field
      : value?.source === 'VALUE'
        ? 'constant'
        : value?.source === 'UPSTREAM_OUTPUT'
          ? 'output:' + value.fieldId
          : '';
  return (
    <div className="graph-field-card graph-fields">
      <Field label={field.name + (field.required ? '（必填）' : '')}>
        <select
          value={selected}
          onChange={(event) => {
            const id = event.target.value;
            if (id === 'constant') change({ source: 'VALUE', value: field.defaultValue ?? '' });
            else if (id.startsWith('output:'))
              change({ source: 'UPSTREAM_OUTPUT', fieldId: id.slice(7) });
            else if (supported.includes(id as EventField))
              change({ source: 'EVENT', field: id as EventField });
            else change(undefined);
          }}
        >
          <option value="">采用开始节点默认规则</option>
          <option value="constant">设置固定值</option>
          {value?.source === 'UPSTREAM_OUTPUT' &&
            !compatibleOutputs.some(({ id }) => id === value.fieldId) && (
              <option value={selected} disabled>
                原有上游输出不可用
              </option>
            )}
          {supported.map((name) => (
            <option value={name} key={name}>
              {events[name]}
            </option>
          ))}
          {compatibleOutputs.map(({ id, name }) => (
            <option value={'output:' + id} key={id}>
              上游最终输出 · {name} ({id})
            </option>
          ))}
        </select>
      </Field>
      {value?.source === 'VALUE' && (
        <GraphFieldValue
          project={project}
          field={{ ...field, name: '触发参数值' }}
          value={value.value}
          change={(next) => change({ source: 'VALUE', value: next })}
          checkRequired
        />
      )}
    </div>
  );
}

function TriggerDetails({
  path,
  rule,
  project,
  canInvoke,
  onRun,
}: {
  path: string;
  rule: TriggerRule;
  project: ProjectDetail;
  canInvoke: boolean;
  onRun: (id: string) => void;
}) {
  const events = useResource<TriggerEvent[]>(path + '/events', 5000);
  const [eventId, setEventId] = useState(() => graphKey('event'));
  const [repositoryId, setRepositoryId] = useState('');
  const [commitSha, setCommitSha] = useState('');
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [invoked, setInvoked] = useState<TriggerEvent>();
  const latest = events.data?.find((item) => item.id === invoked?.id) ?? invoked;
  const eventFields = new Set(
    Object.values(rule.parameterMappings ?? {}).flatMap((mapping) =>
      mapping.source === 'EVENT' ? [mapping.field] : [],
    ),
  );
  async function invoke(event: FormEvent) {
    event.preventDefault();
    if (busy || !eventId.trim()) return;
    setBusy(true);
    setError('');
    try {
      setInvoked(
        await post<TriggerEvent>(path + '/invoke', {
          eventId: eventId.trim(),
          ...(repositoryId && { repositoryId }),
          ...(commitSha.trim() && { commitSha: commitSha.trim() }),
          ...(ref.trim() && { ref: ref.trim() }),
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
            {(eventFields.has('repository') ||
              eventFields.has('commit') ||
              eventFields.has('ref')) && (
              <Field label="事件仓库" hint="按事件提交检出时，仓库须与检出仓库一致。">
                <select
                  required={eventFields.has('repository')}
                  value={repositoryId}
                  onChange={(e) => setRepositoryId(e.target.value)}
                >
                  <option value="">请选择仓库</option>
                  {project.repositories.map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {eventFields.has('commit') && (
              <Field label="事件提交 SHA">
                <input
                  required
                  maxLength={64}
                  pattern="(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})"
                  value={commitSha}
                  onChange={(e) => setCommitSha(e.target.value)}
                />
              </Field>
            )}
            {eventFields.has('ref') && (
              <Field label="事件 Git 引用">
                <input
                  required
                  maxLength={500}
                  placeholder="refs/heads/main"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                />
              </Field>
            )}
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
