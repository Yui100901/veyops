import { useRef, useState, type FormEvent } from 'react';
import { Clipboard, Radio } from 'lucide-react';
import { message, post, useResource } from '../../../api';
import { ErrorBanner, Field, Loading, Status } from '../../../components';
import type { ProjectDetail } from '../../../models';
import { graphKey } from '../execution-graph-definition';
import {
  triggerDate,
  triggerSourceName,
  type TriggerEvent,
  type TriggerRule,
} from './graph-trigger-model';

const eventStatuses: Record<string, string> = {
  PENDING: '已接收，待派发',
  QUEUED: '已排队',
  IGNORED: '已跳过',
  REJECTED: '已拦截',
  TESTED: '接收验证通过',
  SKIPPED: '已跳过',
};

const eventSources: Record<string, string> = {
  CRON: '定时构建',
  POLL: '仓库轮询',
  GITEA: 'Gitea',
  BEARER: '通用 Webhook',
  SIGNED: '维序签名',
  API: '认证 API',
  UPSTREAM: '上游完成',
};

export function ExecutionGraphTriggerDetails({
  path,
  rule,
  project,
  initialSecret,
  canManage,
  canInvoke,
  onRun,
  onChanged,
}: {
  path: string;
  rule: TriggerRule;
  project: ProjectDetail;
  initialSecret?: string;
  canManage: boolean;
  canInvoke: boolean;
  onRun: (id: string) => void;
  onChanged: () => void;
}) {
  const events = useResource<TriggerEvent[]>(path + '/events', 5000);
  return (
    <div className="graph-properties graph-trigger-details">
      <h4>{rule.name} · 最近触发事件</h4>
      {rule.kind === 'WEBHOOK' && (
        <WebhookSetup
          path={path}
          rule={rule}
          initialSecret={initialSecret}
          canManage={canManage}
          onRotated={onChanged}
        />
      )}
      {rule.kind === 'API' && (
        <CopyTriggerValue
          label="认证 API 地址"
          value={new URL('/api/v1' + path + '/invoke', window.location.origin).href}
        />
      )}
      {rule.kind === 'API' && canInvoke && rule.enabled && (
        <LegacyApiInvoke
          path={path}
          project={project}
          rule={rule}
          onAccepted={() => void events.reload()}
        />
      )}
      <ErrorBanner error={events.error} retry={events.reload} />
      {events.loading ? (
        <Loading />
      ) : events.data?.length ? (
        <ol className="graph-start-rule-list">
          {events.data.map((item) => (
            <li key={item.id} className="graph-properties">
              <div className="heading-actions">
                <strong>{eventStatuses[item.status] ?? item.status}</strong>
                <small>{triggerDate(item.createdAt, rule.timeZone ?? undefined)}</small>
              </div>
              <div className="heading-actions">
                <code>{item.eventId}</code>
                {item.runStatus && <Status value={item.runStatus} />}
              </div>
              {item.error && <p>{item.error}</p>}
              <EventEvidence
                project={project}
                item={item}
                timeZone={rule.timeZone ?? undefined}
                onRun={onRun}
              />
              {item.runId && (
                <div>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() => item.runId && onRun(item.runId)}
                  >
                    查看运行
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <div className="mini-empty">尚无触发事件。</div>
      )}
    </div>
  );
}

function EventEvidence({
  project,
  item,
  timeZone,
  onRun,
}: {
  project: ProjectDetail;
  item: TriggerEvent;
  timeZone?: string;
  onRun: (id: string) => void;
}) {
  const context = item.metadata;
  const source = context?.eventSource ?? item.source;
  const previous = context?.previousCommitSha ?? item.previousCommitSha;
  const commit = context?.commitSha ?? item.commitSha;
  const repository = context?.repositoryId ?? item.repositoryId;
  const ref = context?.ref ?? item.ref;
  const scheduledAt = context?.scheduledAt ?? item.scheduledAt;
  const upstreamRunId = context?.upstreamRunId ?? item.upstreamRunId;
  const upstreamStatus = context?.upstreamStatus ?? item.upstreamStatus;
  return (
    <dl className="graph-trigger-evidence">
      {source && (
        <div>
          <dt>来源</dt>
          <dd>{eventSources[source] ?? source}</dd>
        </div>
      )}
      {item.version && (
        <div>
          <dt>图版本</dt>
          <dd>v{item.version}</dd>
        </div>
      )}
      {item.ruleRevision && (
        <div>
          <dt>规则修订</dt>
          <dd>
            <code>{item.ruleRevision}</code>
          </dd>
        </div>
      )}
      {repository && (
        <div>
          <dt>仓库</dt>
          <dd>{triggerSourceName(project, repository)}</dd>
        </div>
      )}
      {ref && (
        <div>
          <dt>Git 引用</dt>
          <dd>
            <code>{ref}</code>
          </dd>
        </div>
      )}
      {previous && (
        <div>
          <dt>上次提交</dt>
          <dd>
            <code>{previous}</code>
          </dd>
        </div>
      )}
      {commit && (
        <div>
          <dt>提交 SHA</dt>
          <dd>
            <code>{commit}</code>
          </dd>
        </div>
      )}
      {scheduledAt && (
        <div>
          <dt>计划时点</dt>
          <dd>{triggerDate(scheduledAt, timeZone)}</dd>
        </div>
      )}
      {item.runId && (
        <div>
          <dt>接受时间</dt>
          <dd>{triggerDate(item.createdAt, timeZone)}</dd>
        </div>
      )}
      {context?.checkedAt && (
        <div>
          <dt>检查时间</dt>
          <dd>{triggerDate(context.checkedAt, timeZone)}</dd>
        </div>
      )}
      {upstreamRunId && (
        <div>
          <dt>上游运行</dt>
          <dd>
            <button
              className="button secondary small"
              type="button"
              onClick={() => onRun(upstreamRunId)}
            >
              查看上游{upstreamStatus ? ' · ' + upstreamStatus : ''}
            </button>
          </dd>
        </div>
      )}
    </dl>
  );
}

function WebhookSetup({
  path,
  rule,
  initialSecret,
  canManage,
  onRotated,
}: {
  path: string;
  rule: TriggerRule;
  initialSecret?: string;
  canManage: boolean;
  onRotated: () => void;
}) {
  const protocol = rule.webhookProtocol ?? 'SIGNED';
  const [freshSecret, setFreshSecret] = useState<string>();
  const [rotatedPath, setRotatedPath] = useState<string>();
  const [origin, setOrigin] = useState(window.location.origin);
  const [rotating, setRotating] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [error, setError] = useState('');
  const secret = freshSecret ?? initialSecret;
  const receivePath = rotatedPath ?? rule.receivePath ?? '/api/v1/graph-webhooks/' + rule.id;
  const testPath = rule.testReceivePath ?? receivePath + '/test';
  const base = validOrigin(origin);
  const connect = (url: string) =>
    new URL(url.startsWith('/api/v1/') ? url : '/api/v1' + url, base).href;
  async function rotate() {
    if (rotating) return;
    setRotating(true);
    setError('');
    try {
      const value = await post<{ secret: string; receivePath: string }>(path + '/rotate-secret');
      setFreshSecret(value.secret);
      setRotatedPath(value.receivePath);
      setConfirmRotate(false);
      onRotated();
    } catch (error) {
      setError(message(error));
    } finally {
      setRotating(false);
    }
  }
  return (
    <section className="graph-properties">
      <h4>Webhook 投递配置</h4>
      <Field label="接收方服务地址" hint="填写 Git 服务能访问的维序地址，默认使用当前站点。">
        <input type="url" value={origin} onChange={(e) => setOrigin(e.target.value)} />
      </Field>
      {!base && <ErrorBanner error="请输入没有账号、查询参数或路径的 HTTP(S) 站点地址。" />}
      {base && <CopyTriggerValue label="Webhook 投递地址" value={connect(receivePath)} />}
      {protocol === 'GITEA' && (
        <p className="field-note">
          在 Gitea 选择 Gitea Webhook、JSON 请求和 Push 事件。投递地址填入 Target URL，令牌填入
          Secret。
        </p>
      )}
      {protocol === 'BEARER' && (
        <p className="field-note">
          发送 POST JSON，在 <code>Authorization</code> 中提供 <code>Bearer &lt;token&gt;</code>。
          请求字段为 <code>eventId</code>、<code>ref</code> 和 <code>commitSha</code>。
        </p>
      )}
      {protocol === 'SIGNED' && (
        <p className="field-note">
          将 <code>timestamp.deliveryId.rawJSON</code> 的 HMAC-SHA256 以
          <code>sha256=十六进制摘要</code> 写入 <code>X-Veyops-Signature</code>。同时传入
          <code>X-Veyops-Timestamp</code> 和 <code>X-Veyops-Delivery</code>。
        </p>
      )}
      {secret && canManage && <CopyTriggerValue label="本次令牌" value={secret} secret />}
      {canManage && protocol !== 'SIGNED' && (
        <div className="heading-actions">
          {confirmRotate ? (
            <>
              <span>轮换后旧令牌立即失效。</span>
              <button
                type="button"
                className="button primary small"
                disabled={rotating}
                onClick={() => void rotate()}
              >
                {rotating ? '正在轮换…' : '确认轮换'}
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={rotating}
                onClick={() => setConfirmRotate(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button secondary small"
              onClick={() => setConfirmRotate(true)}
            >
              轮换令牌
            </button>
          )}
        </div>
      )}
      <ErrorBanner error={error} />
      <details className="graph-field-card">
        <summary>测试接收</summary>
        <div className="graph-fields">
          <p className="field-note">
            向验证地址发送与正式推送相同的认证和推送请求。验证结果会显示在下方事件中。
          </p>
          {protocol === 'GITEA' && (
            <p className="field-note">
              可以临时把这个地址填入 Gitea 的 Target URL，验证后再换回投递地址。
            </p>
          )}
          {base && <CopyTriggerValue label="接收验证地址" value={connect(testPath)} />}
        </div>
      </details>
    </section>
  );
}

function validOrigin(value: string) {
  try {
    const url = new URL(value);
    if (
      ['https:', 'http:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
    )
      return url.origin;
  } catch {
    // Incomplete input is shown as a local validation error.
  }
}

function CopyTriggerValue({
  label,
  value,
  secret,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  async function copy() {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(value);
        setStatus('已复制');
        return;
      }
    } catch {
      // Select the value below on browsers that declined Clipboard API access.
    }
    field.current?.focus();
    field.current?.select();
    setStatus(document.execCommand('copy') ? '已复制' : '已选中，可按 Ctrl+C 复制。');
  }
  return (
    <div className="graph-fields graph-trigger-copy">
      <Field label={label}>
        <div className="input-action-row">
          <input
            readOnly
            ref={field}
            value={value}
            autoComplete={secret ? 'off' : undefined}
            onFocus={(event) => event.target.select()}
          />
          <button type="button" className="button secondary small" onClick={() => void copy()}>
            <Clipboard size={15} /> 复制
          </button>
        </div>
      </Field>
      {secret && <p className="field-note">请现在复制令牌，离开后可通过轮换获取新令牌。</p>}
      <span role="status">{status}</span>
    </div>
  );
}

function LegacyApiInvoke({
  path,
  project,
  rule,
  onAccepted,
}: {
  path: string;
  project: ProjectDetail;
  rule: TriggerRule;
  onAccepted: () => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TriggerEvent>();
  const required = new Set(
    Object.values(rule.parameterMappings ?? {}).flatMap((mapping) =>
      mapping.source === 'EVENT' ? [mapping.field] : [],
    ),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = Object.fromEntries(
      [...new FormData(event.currentTarget)].filter(([, value]) => value),
    );
    setBusy(true);
    setError('');
    try {
      setResult(await post<TriggerEvent>(path + '/invoke', body));
      onAccepted();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="graph-properties" onSubmit={(event) => void submit(event)}>
      <h4>发送认证 API 事件</h4>
      <div className="form-grid">
        <Field label="事件 ID">
          <input name="eventId" defaultValue={graphKey('event')} required maxLength={120} />
        </Field>
        <Field label="事件仓库">
          <select
            name="repositoryId"
            required={required.has('repository')}
            defaultValue={rule.repositoryId ?? ''}
          >
            <option value="">请选择仓库</option>
            {project.repositories.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="事件 Git 引用">
          <input name="ref" required={required.has('ref')} placeholder="refs/heads/main" />
        </Field>
        <Field label="事件提交 SHA">
          <input
            name="commitSha"
            required={required.has('commit')}
            pattern="(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})"
          />
        </Field>
      </div>
      <div>
        <button className="button primary small" disabled={busy}>
          <Radio size={15} /> {busy ? '发送中…' : '发送触发请求'}
        </button>
      </div>
      <ErrorBanner error={error} />
      {result && (
        <p role="status">
          {result.eventId} · {eventStatuses[result.status] ?? result.status}
        </p>
      )}
    </form>
  );
}
