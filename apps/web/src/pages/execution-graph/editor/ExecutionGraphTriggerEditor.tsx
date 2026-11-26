import { useState, type FormEvent } from 'react';
import { api, message, post, useResource } from '../../../api';
import { ErrorBanner, Field } from '../../../components';
import type { Credential, ProjectDetail } from '../../../models';
import type { GraphField } from '../execution-graph-definition';
import { GraphFieldValue } from './ExecutionGraphFields';
import {
  eventFields,
  triggerChoice,
  triggerChoices,
  triggerDate,
  triggerRequest,
  triggerSourceName,
  type EventField,
  type ParameterMapping,
  type TriggerChoice,
  type TriggerConfig,
  type TriggerFlow,
  type TriggerPreflight,
  type TriggerRule,
} from './graph-trigger-model';

export function ExecutionGraphTriggerEditor({
  path,
  project,
  startId,
  latestVersion,
  rule,
  flows,
  onPrepareDraft,
  issueHref,
  onCancel,
  onSaved,
}: {
  path: string;
  project: ProjectDetail;
  startId: string;
  latestVersion: number | null;
  rule?: TriggerRule;
  flows: TriggerFlow[];
  onPrepareDraft?: () => Promise<number>;
  issueHref?: (issue: NonNullable<TriggerPreflight['issue']>) => string;
  onCancel: () => void;
  onSaved: (rule: TriggerRule) => void;
}) {
  const [form, setForm] = useState<TriggerConfig>(() => ({
    name: '',
    kind: 'CRON',
    flowId: startId,
    enabled: false,
    cron: '0 2 * * *',
    upstreamStatus: 'SUCCESS',
    ...rule,
    webhookProtocol: rule ? (rule.webhookProtocol ?? 'SIGNED') : 'GITEA',
  }));
  const [result, setResult] = useState<TriggerPreflight>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const choice = triggerChoice(form);
  const hasSource = choice === 'POLL' || choice === 'WEBHOOK' || choice === 'API';
  const signed = choice === 'WEBHOOK' && form.webhookProtocol === 'SIGNED';
  const start = flows.find(({ id }) => id === startId);
  const requiredArtifact = start?.requiredArtifact;
  const artifactMapping = form.parameterMappings?.artifactId;
  const triggerArtifactId =
    artifactMapping?.source === 'VALUE' && typeof artifactMapping.value === 'string'
      ? artifactMapping.value
      : undefined;
  const sources = start?.sources?.filter(
    ({ repositoryId, ref }) => repositoryId && (!ref || ref.kind === 'BRANCH'),
  );
  const showSources = sources !== undefined && choice !== 'API' && hasSource;
  const sourceId = form.sourceId ?? (sources?.length === 1 ? sources[0]?.id : undefined);
  const timeZone = useResource<{ timeZone: string }>(
    form.kind === 'CRON' ? '/operation-schedules/time-zone' : null,
  );
  const credentials = useResource<Credential[]>(signed ? '/credentials' : null);
  const branches = useResource<{ branches: { name: string }[] }>(
    hasSource && !showSources && form.repositoryId
      ? '/projects/' + project.id + '/repositories/' + form.repositoryId + '/branches'
      : null,
  );
  const startFields = start?.inputs ?? [];
  const fields = startFields.filter(({ runtimeOverride }) => runtimeOverride !== false);
  const upstreamOutputs =
    form.kind === 'UPSTREAM' && form.upstreamStatus === 'SUCCESS'
      ? (flows.find(({ id }) => id === form.upstreamFlowId)?.outputs ?? [])
      : [];
  const valid = Boolean(
    form.name.trim() &&
    (form.kind !== 'CRON' || form.cron?.trim()) &&
    (!signed || form.credentialId) &&
    (!showSources || sources.some(({ id }) => id === sourceId)) &&
    (!start?.useUpstreamArtifact || (choice === 'UPSTREAM' && form.upstreamStatus === 'SUCCESS')) &&
    (form.kind !== 'UPSTREAM' || form.upstreamFlowId),
  );

  function patch(values: Partial<TriggerConfig>) {
    setForm((previous) => ({ ...previous, ...values }));
    setResult(undefined);
    setError('');
  }

  async function check(request: ReturnType<typeof triggerRequest>) {
    const preflight = await post<TriggerPreflight>(path + '/preflight', {
      ...request,
      ...(rule && { triggerId: rule.id }),
    });
    setResult(preflight);
    return preflight;
  }

  async function act(action: 'check' | 'save' | 'enable') {
    if (busy || !valid) return;
    if (start?.requiresHistoryDirectory && (action !== 'save' || rule?.enabled)) {
      setError('此入口需要在运行时手动选择历史目录。配置源码后可启用自动触发。');
      return;
    }
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const enabled =
        action === 'enable' ||
        ((action === 'save' || action === 'check') && Boolean(rule?.enabled));
      if (requiredArtifact && (enabled || action === 'check') && !triggerArtifactId) {
        setError('请为自动触发选择同一服务的产物实例。');
        return;
      }
      const body = triggerRequest(
        {
          ...form,
          ...(showSources && { sourceId }),
          parameterMappings:
            start?.sources !== undefined
              ? requiredArtifact && triggerArtifactId
                ? { artifactId: { source: 'VALUE', value: triggerArtifactId } }
                : {}
              : Object.fromEntries(
                  Object.entries(form.parameterMappings ?? {}).filter(
                    ([id]) =>
                      !startFields.some(
                        (field) => field.id === id && field.runtimeOverride === false,
                      ),
                  ),
                ),
        },
        enabled,
        latestVersion,
      );
      if (action === 'check') {
        await check({ ...body, enabled: !!latestVersion });
        return;
      }
      if (enabled) {
        const preflight = await check(body);
        if (!preflight.eligible) return;
      }
      const draftRevision = !enabled && onPrepareDraft ? await onPrepareDraft() : undefined;
      const request = { ...body, ...(draftRevision !== undefined && { draftRevision }) };
      const saved = rule
        ? await api<TriggerRule>(path + '/' + rule.id, {
            method: 'PATCH',
            body: JSON.stringify(request),
          })
        : await post<TriggerRule>(path, request);
      onSaved(saved);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void act('save');
  }

  return (
    <form className="graph-properties graph-trigger-editor" onSubmit={submit}>
      <h4>{rule ? '编辑触发规则' : '添加触发规则'}</h4>
      {start?.requiresHistoryDirectory && (
        <p className="field-note">此入口需要在运行时手动选择历史目录。配置源码后可启用自动触发。</p>
      )}
      <ErrorBanner error={error || (signed ? credentials.error : '')} />
      <fieldset disabled={busy}>
        <div className="form-grid">
          <Field label="规则名称">
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="触发方式">
            <select
              value={choice}
              onChange={(event) => {
                const next = event.target.value as TriggerChoice;
                const cronMode = next === 'RUN' || next === 'POLL' ? next : undefined;
                patch({
                  kind: cronMode ? 'CRON' : (next as 'WEBHOOK' | 'UPSTREAM' | 'API'),
                  cronMode,
                  parameterMappings: {},
                  webhookProtocol: next === 'WEBHOOK' ? 'GITEA' : undefined,
                  sourceId: undefined,
                  repositoryId: undefined,
                  ref: undefined,
                  refPrefix: undefined,
                });
              }}
            >
              {Object.entries(triggerChoices)
                .filter(([value]) => value !== 'API' || rule?.kind === 'API')
                .map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
            </select>
          </Field>
          {form.kind === 'CRON' && (
            <>
              <Field label="Cron 表达式" hint="五段表达式，例如每天凌晨两点 0 2 * * *。">
                <input
                  required
                  value={form.cron ?? ''}
                  maxLength={160}
                  onChange={(e) => patch({ cron: e.target.value })}
                />
              </Field>
              <Field
                label="时区"
                hint={
                  timeZone.data
                    ? '系统默认 · ' + timeZone.data.timeZone
                    : '填写 IANA 时区，例如 Asia/Shanghai。'
                }
              >
                <input
                  list="graph-trigger-time-zones"
                  value={form.timeZone ?? ''}
                  maxLength={80}
                  placeholder={timeZone.data?.timeZone ?? '系统默认'}
                  onChange={(e) => patch({ timeZone: e.target.value })}
                />
                <datalist id="graph-trigger-time-zones">
                  {['UTC', ...(Intl.supportedValuesOf?.('timeZone') ?? [])].map((zone) => (
                    <option value={zone} key={zone} />
                  ))}
                </datalist>
              </Field>
            </>
          )}
          {choice === 'WEBHOOK' && (
            <Field label="Webhook 协议">
              <select
                value={form.webhookProtocol ?? 'GITEA'}
                onChange={(e) =>
                  patch({ webhookProtocol: e.target.value as TriggerConfig['webhookProtocol'] })
                }
              >
                <option value="GITEA">Gitea 原生签名</option>
                <option value="BEARER">通用 HTTP 令牌</option>
                {rule?.kind === 'WEBHOOK' &&
                  (!rule.webhookProtocol || rule.webhookProtocol === 'SIGNED') && (
                    <option value="SIGNED">维序签名</option>
                  )}
              </select>
            </Field>
          )}
          {signed && (
            <Field label="签名凭据">
              <select
                required
                value={form.credentialId ?? ''}
                onChange={(e) => patch({ credentialId: e.target.value || undefined })}
              >
                <option value="">请选择凭据</option>
                {credentials.data
                  ?.filter(({ type, status }) => type === 'TOKEN' && status === 'ACTIVE')
                  .map(({ id, name }) => (
                    <option value={id} key={id}>
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
                  onChange={(e) =>
                    patch({
                      upstreamFlowId: e.target.value,
                      parameterMappings: Object.fromEntries(
                        Object.entries(form.parameterMappings ?? {}).filter(
                          ([, value]) => value.source !== 'UPSTREAM_OUTPUT',
                        ),
                      ),
                    })
                  }
                >
                  <option value="">请选择上游执行流</option>
                  {flows
                    .filter(({ id }) => id !== startId)
                    .map(({ id, name }) => (
                      <option value={id} key={id}>
                        {name}
                      </option>
                    ))}
                  {form.upstreamFlowId && !flows.some(({ id }) => id === form.upstreamFlowId) && (
                    <option value={form.upstreamFlowId} disabled>
                      当前图中没有此上游入口
                    </option>
                  )}
                </select>
              </Field>
              <Field label="完成条件">
                <select
                  value={form.upstreamStatus ?? 'SUCCESS'}
                  onChange={(e) =>
                    patch({
                      upstreamStatus: e.target.value as TriggerConfig['upstreamStatus'],
                      parameterMappings:
                        e.target.value === 'SUCCESS'
                          ? form.parameterMappings
                          : Object.fromEntries(
                              Object.entries(form.parameterMappings ?? {}).filter(
                                ([, value]) => value.source !== 'UPSTREAM_OUTPUT',
                              ),
                            ),
                    })
                  }
                >
                  <option value="SUCCESS">上游成功</option>
                  <option value="FAILED">上游失败</option>
                  <option value="ANY">任意结束结果</option>
                </select>
              </Field>
            </>
          )}
          {showSources && (
            <Field label="源码来源" hint="从开始节点选择要跟踪的分支。">
              <select
                value={sourceId ?? ''}
                onChange={(event) =>
                  patch({
                    sourceId: event.target.value || undefined,
                    repositoryId: undefined,
                    ref: undefined,
                    refPrefix: undefined,
                  })
                }
              >
                <option value="">请选择源码来源</option>
                {sources.map(({ id, repositoryId, ref }) => (
                  <option key={id} value={id}>
                    {triggerSourceName(project, repositoryId)} · {ref?.value || '仓库默认分支'}
                  </option>
                ))}
              </select>
              {!sources.length && <p className="field-note">请先在开始节点加入跟踪分支的源码。</p>}
            </Field>
          )}
          {hasSource && !showSources && (
            <>
              <Field label="仓库">
                <select
                  value={form.repositoryId ?? ''}
                  onChange={(e) => patch({ repositoryId: e.target.value || undefined })}
                >
                  <option value="">
                    {signed || form.kind === 'API' ? '按现有过滤规则' : '继承执行流配置'}
                  </option>
                  {project.repositories.map(({ id, name }) => (
                    <option value={id} key={id}>
                      {name}
                    </option>
                  ))}
                  {form.repositoryId &&
                    !project.repositories.some(({ id }) => id === form.repositoryId) && (
                      <option value={form.repositoryId} disabled>
                        仓库已不可用
                      </option>
                    )}
                </select>
              </Field>
              {signed || form.kind === 'API' ? (
                <Field label="Git 引用前缀" hint="如 refs/heads/main，留空接收全部。">
                  <input
                    maxLength={220}
                    value={form.refPrefix ?? ''}
                    onChange={(e) => patch({ refPrefix: e.target.value })}
                  />
                </Field>
              ) : (
                <Field label="分支" hint="留空继承执行流的分支。">
                  <input
                    list="graph-trigger-branches"
                    maxLength={256}
                    value={(form.ref ?? '').replace(/^refs\/heads\//, '')}
                    onChange={(e) =>
                      patch({
                        ref: e.target.value
                          ? 'refs/heads/' + e.target.value.replace(/^refs\/heads\//, '')
                          : undefined,
                      })
                    }
                  />
                  <datalist id="graph-trigger-branches">
                    {branches.data?.branches?.map(({ name }) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </Field>
              )}
            </>
          )}
        </div>
        {choice === 'POLL' && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.buildOnFirstObservation ?? false}
              onChange={(e) => patch({ buildOnFirstObservation: e.target.checked })}
            />
            首次检查立即构建
          </label>
        )}
        {start?.useUpstreamArtifact && (
          <p className="field-note">此执行流使用上游产物，触发条件选择“上游成功”。</p>
        )}
        {requiredArtifact && (
          <GraphFieldValue
            project={project}
            field={requiredArtifact.field}
            scope={requiredArtifact}
            value={triggerArtifactId}
            artifactInstancesOnly
            change={(value) =>
              patch({
                parameterMappings:
                  typeof value === 'string' ? { artifactId: { source: 'VALUE', value } } : {},
              })
            }
          />
        )}
        {start?.sources === undefined && Boolean(fields.length) && (
          <details className="graph-field-card" open={form.kind === 'UPSTREAM' || undefined}>
            <summary>高级参数映射</summary>
            <div className="graph-fields">
              <p className="field-note">
                参数默认继承开始节点。需要覆盖时，可选择固定值或对应的事件字段。
              </p>
              {fields.map((field) => (
                <TriggerParameterField
                  key={field.id}
                  field={field}
                  project={project}
                  choice={choice}
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
            </div>
          </details>
        )}
        {result && (
          <div className="graph-properties graph-trigger-preflight" role="status">
            {result.issue ? (
              <div>
                <strong>预检阻塞</strong>
                <p>{result.issue.message}</p>
                {result.issue.nodeId && issueHref && (
                  <a className="button secondary small" href={issueHref(result.issue)}>
                    定位问题
                  </a>
                )}
              </div>
            ) : (
              <p>
                {result.eligible && result.version
                  ? '预检通过 · 已发布 v' + result.version
                  : '发布可运行的执行流后可以启用。'}
              </p>
            )}
            {result.checkout && (
              <p>
                生效来源 · {triggerSourceName(project, result.checkout.repositoryId)} ·{' '}
                <code>{result.checkout.ref}</code>
              </p>
            )}
            {Boolean(result.nextTimes?.length) && (
              <div>
                <strong>未来三个时点{result.timeZone ? ' · ' + result.timeZone : ''}</strong>
                <ol>
                  {result.nextTimes.map((time) => (
                    <li key={time}>{triggerDate(time, result.timeZone)}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
        <div className="heading-actions">
          <button type="submit" className="button primary" disabled={!valid}>
            {busy ? '处理中…' : rule?.enabled ? '预检并保存' : '保存草稿'}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!valid}
            onClick={() => void act('check')}
          >
            预检
          </button>
          {!rule?.enabled && latestVersion && (
            <button
              type="button"
              className="button secondary"
              disabled={!valid}
              onClick={() => void act('enable')}
            >
              预检并启用
            </button>
          )}
          <button type="button" className="button secondary" onClick={onCancel}>
            取消编辑
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function TriggerParameterField({
  project,
  field,
  choice,
  upstreamOutputs,
  value,
  change,
}: {
  project: ProjectDetail;
  field: GraphField;
  choice: TriggerChoice;
  upstreamOutputs: GraphField[];
  value?: ParameterMapping;
  change: (value?: ParameterMapping) => void;
}) {
  const hasSource = choice === 'POLL' || choice === 'WEBHOOK' || choice === 'API';
  const supported: EventField[] = [];
  if (!field.multiple) {
    if (field.type === 'NUMBER' && (choice === 'RUN' || choice === 'POLL'))
      supported.push('scheduledAt');
    if (field.type === 'TEXT') {
      supported.push('eventId');
      if (hasSource) supported.push('commit', 'ref');
      if (choice === 'UPSTREAM') supported.push('upstreamRunId', 'upstreamStatus');
    }
    if (hasSource && field.type === 'REPOSITORY') supported.push('repository');
    if (hasSource && field.type === 'GIT_REF') supported.push('commit', 'ref');
  }
  const outputs = upstreamOutputs.filter(
    (source) =>
      !['CREDENTIAL', 'WORKSPACE', 'VARIABLES'].includes(source.type) &&
      source.type === field.type &&
      Boolean(source.multiple) === Boolean(field.multiple) &&
      (!field.artifactType || !source.artifactType || source.artifactType === field.artifactType),
  );
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
            !outputs.some(({ id }) => id === value.fieldId) && (
              <option value={selected} disabled>
                原有上游输出不可用
              </option>
            )}
          {supported.map((id) => (
            <option value={id} key={id}>
              {eventFields[id]}
            </option>
          ))}
          {outputs.map(({ id, name }) => (
            <option value={'output:' + id} key={id}>
              上游最终输出 · {name}
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
