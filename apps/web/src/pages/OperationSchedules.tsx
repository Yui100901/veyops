import { InlineEditor, useInlineEditor } from '../InlineEditor';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Clock3, History, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, message, post, remove, useResource } from '../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  Modal,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type {
  OperationParameter,
  ParameterValue,
  Server,
  ServerGroup,
  SystemRuntimeDefaults,
  User,
} from '../models';
import {
  BatchStrategy,
  defaultExecutionOptions,
  ServerPicker,
  TargetOptions,
} from './BatchTargets';
import type { ExecutionOptions, TargetSelection } from './BatchTargets';

const endpoint = '/operation-schedules';
type ScheduleKind = 'COMMAND_TEMPLATE' | 'OPERATION_PLAN';
type Timing = {
  type: 'ONCE' | 'INTERVAL' | 'CRON';
  timeZone: string;
  runAt?: number;
  intervalSeconds?: number;
  cron?: string;
};
interface ScheduleConfig {
  name: string;
  kind: ScheduleKind;
  sourceId: string;
  sourceVersion: number;
  timing: Timing;
  target: Pick<TargetSelection, 'serverIds' | 'groupIds'>;
  parameters: Record<string, ParameterValue>;
  strategy: 'PARALLEL' | 'SEQUENTIAL';
  maxParallel: number;
  failurePolicy: 'CONTINUE' | 'STOP';
  timeoutSeconds: number;
  requireConfirmation: boolean;
}
interface ScheduleRun {
  id: string;
  scheduledAt: number;
  triggeredAt: number | null;
  status: string;
  taskId: string | null;
  reason: string | null;
  confirmationExpiresAt: number | null;
  missedUntil: number | null;
  name: string;
  ownerId: string;
  ownerName?: string;
  sourceVersion: number;
  targetIds: string[];
  steps?: string[];
}
interface OperationSchedule extends ScheduleConfig {
  id: string;
  ownerId: string;
  status: 'ENABLED' | 'DISABLED' | 'PAUSED';
  statusReason: string | null;
  nextRunAt: number | null;
  lastRun: ScheduleRun | null;
  approvedTargetIds: string[];
}
interface SchedulePreview {
  nextRunAt: number | null;
  upcoming: number[];
  targets: { id: string; name: string; host: string }[];
  steps: { name: string; command: string }[];
  configurationHash: string;
  requireConfirmation: boolean;
}
interface ScheduleSource {
  id: string;
  name: string;
  currentVersion: number;
  enabled?: boolean;
}
interface SourceVersion {
  version: number;
  parameters?: OperationParameter[];
}

const kinds: Record<ScheduleKind, string> = {
  COMMAND_TEMPLATE: '命令模板',
  OPERATION_PLAN: '运维方案',
};
const sourcePaths: Record<ScheduleKind, string> = {
  COMMAND_TEMPLATE: '/command-templates',
  OPERATION_PLAN: '/operation-plans',
};

export function civilTime(value: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(value)
      .map(({ type, value }) => [type, value]),
  );
  return [parts.year, parts.month, parts.day].join('-') + 'T' + parts.hour + ':' + parts.minute;
}

export function timestampInZone(value: string, timeZone: string) {
  const wall = Date.parse(value + 'Z');
  const day = 86_400_000;
  const candidates = [-day, 0, day]
    .map((offset) => {
      const sample = wall + offset;
      return wall - (Date.parse(civilTime(sample, timeZone) + 'Z') - sample);
    })
    .filter((instant) => civilTime(instant, timeZone) === value)
    .sort((a, b) => a - b);
  if (candidates[0] === undefined) throw new Error('所选时区中不存在该本地时间。');
  return candidates[0];
}

function zoned(value: number | null | undefined, timeZone: string) {
  return value ? civilTime(value, timeZone).replace('T', ' ') : '—';
}

function timingLabel(timing: Timing) {
  if (timing.type === 'ONCE') return '单次';
  if (timing.type === 'INTERVAL') return '每 ' + timing.intervalSeconds + ' 秒';
  return timing.cron;
}

function RunStatus({ value }: { value: string }) {
  if (value === 'AWAITING_CONFIRMATION')
    return (
      <span className="status amber">
        <span />
        待确认
      </span>
    );
  return <Status value={value === 'QUEUED' ? 'PENDING' : value} />;
}

function SchedulePreviewBody({
  config,
  preview,
}: {
  config: ScheduleConfig;
  preview: SchedulePreview;
}) {
  return (
    <>
      <p className="field-note">
        {kinds[config.kind]} v{config.sourceVersion} · {config.timing.timeZone} ·
        {preview.requireConfirmation ? ' 每次执行前确认' : ' 按计划执行'}
      </p>
      <div className="confirmation-targets">
        {preview.targets.map((target) => (
          <span key={target.id}>
            {target.name} <small>{target.host}</small>
          </span>
        ))}
      </div>
      {preview.upcoming.length ? (
        <>
          <h3>接下来的计划时间</h3>
          <ul>
            {preview.upcoming.map((time) => (
              <li key={time}>{zoned(time, config.timing.timeZone)}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="field-note">当前没有未来执行时间。</p>
      )}
      <h3>执行内容</h3>
      {preview.steps.map((step, index) => (
        <details className="version-entry" key={step.name + ':' + index} open={index === 0}>
          <summary>{step.name}</summary>
          <pre className="schedule-command">{step.command}</pre>
        </details>
      ))}
    </>
  );
}

function ScheduleEditor({
  initial,
  systemTimeZone,
  onClose,
  onSaved,
}: {
  initial?: OperationSchedule;
  systemTimeZone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<ScheduleKind>(initial?.kind ?? 'COMMAND_TEMPLATE');
  const [sourceId, setSourceId] = useState(initial?.sourceId ?? '');
  const [version, setVersion] = useState(initial?.sourceVersion);
  const [timing, setTiming] = useState<'ONCE' | 'INTERVAL' | 'CRON' | 'DAILY' | 'WEEKLY'>(
    initial?.timing.type ?? 'INTERVAL',
  );
  const [target, setTarget] = useState<ScheduleConfig['target']>(initial?.target ?? {});
  const [options, setOptions] = useState<ExecutionOptions>(initial ?? defaultExecutionOptions);
  const [preview, setPreview] = useState<{
    config: ScheduleConfig;
    preview: SchedulePreview;
    enabled: boolean;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sources = useResource<ScheduleSource[]>(sourcePaths[kind]);
  const versions = useResource<SourceVersion[]>(
    sourceId ? sourcePaths[kind] + '/' + sourceId + '/versions' : null,
  );
  const servers = useResource<Server[]>('/servers');
  const groups = useResource<ServerGroup[]>('/server-groups');
  const settings = useResource<SystemRuntimeDefaults>('/system');
  const current = sources.data?.find((item) => item.id === sourceId);
  const selectedVersion = version ?? current?.currentVersion;
  const definitions =
    versions.data?.find((item) => item.version === selectedVersion)?.parameters ?? [];
  const defaultZone = initial?.timing.timeZone ?? systemTimeZone;

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (
        !sourceId ||
        !selectedVersion ||
        !versions.data?.some((item) => item.version === selectedVersion)
      )
        throw new Error('请选择已有的命令模板或运维方案版本。');
      const timeZone = String(data.get('timeZone')).trim();
      new Intl.DateTimeFormat('zh-CN', { timeZone });
      const intervalSeconds = Number(data.get('intervalSeconds'));
      let planTiming: Timing;
      if (timing === 'ONCE') {
        planTiming = {
          type: 'ONCE',
          timeZone,
          runAt: timestampInZone(String(data.get('runAt')), timeZone),
        };
      } else if (timing === 'INTERVAL') {
        planTiming = { type: 'INTERVAL', timeZone, intervalSeconds };
      } else {
        const [hour, minute] = String(data.get('clockTime')).split(':').map(Number);
        planTiming = {
          type: 'CRON',
          timeZone,
          cron:
            timing === 'CRON'
              ? String(data.get('cron')).trim()
              : [minute, hour, '*', '*', timing === 'DAILY' ? '*' : data.get('weekday')].join(' '),
        };
      }
      const parameters: Record<string, ParameterValue> = {};
      for (const parameter of definitions) {
        const value = String(data.get('parameter-' + parameter.name) ?? '');
        if (value === '' && !parameter.required) continue;
        parameters[parameter.name] =
          parameter.type === 'BOOLEAN'
            ? value === 'true'
            : parameter.type === 'NUMBER'
              ? Number(value)
              : value;
      }
      const config: ScheduleConfig = {
        name: String(data.get('name')).trim(),
        kind,
        sourceId,
        sourceVersion: selectedVersion,
        timing: planTiming,
        target,
        parameters,
        strategy: options.strategy,
        maxParallel:
          options.strategy === 'SEQUENTIAL'
            ? 1
            : (options.maxParallel ?? settings.data?.defaultMaxParallelTargets ?? 3),
        failurePolicy: options.failurePolicy,
        timeoutSeconds: Number(data.get('timeoutSeconds')),
        requireConfirmation: data.has('requireConfirmation'),
      };
      const result = await post<SchedulePreview>(endpoint + '/preview', config);
      setPreview({ config, preview: result, enabled: data.has('enabled') });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!preview) return;
    setBusy(true);
    setError('');
    const input = {
      ...preview.config,
      enabled: preview.enabled,
      expectedConfigurationHash: preview.preview.configurationHash,
    };
    try {
      if (initial)
        await api(endpoint + '/' + initial.id, { method: 'PATCH', body: JSON.stringify(input) });
      else await post(endpoint, input);
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <InlineEditor
      title={initial ? '编辑定时任务' : '新建定时任务'}
      busy={busy}
      onClose={onClose}
      wide
    >
      <div hidden={!!preview}>
        <Form
          onSubmit={prepare}
          onCancel={onClose}
          busy={busy}
          submit="预览执行计划"
          error={!preview ? error : ''}
        >
          <Field label="任务名称" required>
            <input name="name" required maxLength={120} defaultValue={initial?.name} />
          </Field>
          <div className="form-grid">
            <Field label="执行类型">
              <select
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ScheduleKind);
                  setSourceId('');
                  setVersion(undefined);
                }}
              >
                {Object.entries(kinds).map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={kinds[kind]} required>
              <select
                required
                value={sourceId}
                onChange={(event) => {
                  setSourceId(event.target.value);
                  setVersion(undefined);
                }}
              >
                <option value="" disabled>
                  请选择{kinds[kind]}
                </option>
                {sources.data
                  ?.filter((item) => item.enabled !== false || item.id === sourceId)
                  .map((item) => (
                    <option key={item.id} value={item.id} disabled={item.enabled === false}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="固定版本" required>
              <select
                required
                value={selectedVersion ?? ''}
                onChange={(event) => setVersion(Number(event.target.value))}
                disabled={!versions.data}
              >
                <option value="">选择版本</option>
                {versions.data?.map((item) => (
                  <option key={item.version} value={item.version}>
                    v{item.version}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="任务超时（秒）" required>
              <input
                name="timeoutSeconds"
                type="number"
                min={1}
                max={3600}
                required
                defaultValue={initial?.timeoutSeconds ?? 300}
              />
            </Field>
          </div>
          <ErrorBanner error={sources.error || versions.error} />
          {definitions.length > 0 && (
            <>
              <h3>执行参数</h3>
              <div className="form-grid">
                {definitions.map((field) => {
                  const defaultValue = String(
                    (sourceId === initial?.sourceId && selectedVersion === initial?.sourceVersion
                      ? initial?.parameters[field.name]
                      : undefined) ??
                      field.defaultValue ??
                      '',
                  );
                  return (
                    <Field
                      key={sourceId + ':' + selectedVersion + ':' + field.name}
                      label={field.name}
                      hint={field.description}
                      required={field.required}
                    >
                      {field.type === 'BOOLEAN' ? (
                        <select
                          name={'parameter-' + field.name}
                          required={field.required}
                          defaultValue={defaultValue}
                        >
                          <option value="">未指定</option>
                          <option value="true">是</option>
                          <option value="false">否</option>
                        </select>
                      ) : (
                        <input
                          name={'parameter-' + field.name}
                          required={field.required}
                          defaultValue={defaultValue}
                          type={field.type === 'NUMBER' ? 'number' : 'text'}
                          step={field.type === 'NUMBER' ? 'any' : undefined}
                        />
                      )}
                    </Field>
                  );
                })}
              </div>
            </>
          )}
          <h3>调度</h3>
          <div className="form-grid">
            <Field label="计划类型">
              <select
                value={timing}
                onChange={(event) => setTiming(event.target.value as typeof timing)}
              >
                <option value="ONCE">指定时间执行一次</option>
                <option value="INTERVAL">固定间隔</option>
                <option value="DAILY">每天</option>
                <option value="WEEKLY">每周</option>
                <option value="CRON">Cron</option>
              </select>
            </Field>
            <Field label="IANA 时区" required>
              <input
                name="timeZone"
                list="schedule-time-zones"
                required
                defaultValue={defaultZone}
                placeholder="Asia/Shanghai"
              />
              <datalist id="schedule-time-zones">
                {['UTC', ...Intl.supportedValuesOf('timeZone')].map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
            </Field>
            {timing === 'ONCE' && (
              <Field label="执行时间" hint="按上方时区填写当地时间。" required>
                <input
                  name="runAt"
                  type="datetime-local"
                  required
                  defaultValue={
                    initial?.timing.runAt ? civilTime(initial.timing.runAt, defaultZone) : ''
                  }
                />
              </Field>
            )}
            {timing === 'INTERVAL' && (
              <Field label="执行间隔（秒）" required>
                <input
                  name="intervalSeconds"
                  type="number"
                  min={1}
                  max={31536000}
                  required
                  defaultValue={initial?.timing.intervalSeconds ?? 3600}
                />
              </Field>
            )}
            {timing === 'CRON' && (
              <Field label="Cron 表达式" hint="顺序为分钟、小时、日、月、星期。" required>
                <input
                  name="cron"
                  required
                  placeholder="0 9 * * 1-5"
                  defaultValue={initial?.timing.cron}
                />
              </Field>
            )}
            {(timing === 'DAILY' || timing === 'WEEKLY') && (
              <Field label="当地执行时间" required>
                <input name="clockTime" type="time" defaultValue="09:00" required />
              </Field>
            )}
            {timing === 'WEEKLY' && (
              <Field label="星期">
                <select name="weekday" defaultValue="1">
                  {['日', '一', '二', '三', '四', '五', '六'].map((day, index) => (
                    <option key={day} value={index}>
                      星期{day}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <h3>执行目标</h3>
          <ErrorBanner error={servers.error || groups.error} />
          {servers.loading ? (
            <Loading />
          ) : (
            <ServerPicker
              servers={servers.data ?? []}
              selected={target.serverIds ?? []}
              setSelected={(serverIds) => setTarget({ ...target, serverIds })}
            />
          )}
          <TargetOptions
            label="服务器分组"
            options={groups.data ?? []}
            selected={target.groupIds ?? []}
            onChange={(groupIds) => setTarget({ ...target, groupIds })}
          />
          <BatchStrategy options={options} onChange={setOptions} disabled={busy} />
          <label className="checkbox-row">
            <input
              type="checkbox"
              name="requireConfirmation"
              defaultChecked={initial?.requireConfirmation ?? true}
            />
            每次触发后等待人工确认
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={initial ? initial.status === 'ENABLED' : true}
            />
            保存后启用
          </label>
        </Form>
      </div>
      {preview && (
        <>
          <div className="form-body">
            <SchedulePreviewBody config={preview.config} preview={preview.preview} />
            <ErrorBanner error={error} />
          </div>
          <div className="modal-footer">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setPreview(undefined);
                setError('');
              }}
            >
              返回编辑
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {preview.enabled ? '确认并启用' : '确认并保存'}
            </button>
          </div>
        </>
      )}
    </InlineEditor>
  );
}

function ScheduleHistory({
  schedule,
  onClose,
  user,
  onChanged,
}: {
  schedule: OperationSchedule;
  onClose: () => void;
  user: User;
  onChanged: () => void;
}) {
  const path = endpoint + '/' + schedule.id + '/runs';
  const runs = useResource<ScheduleRun[]>(path, 5000);
  const servers = useResource<Server[]>('/servers');
  const [confirming, setConfirming] = useState<ScheduleRun>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const serverNames = new Map(servers.data?.map((server) => [server.id, server.name]));
  const canEdit =
    user.role === 'ADMIN' || (user.role === 'OPERATOR' && user.id === schedule.ownerId);
  async function approve() {
    if (!confirming) return;
    setBusy(true);
    setError('');
    try {
      await post(path + '/' + confirming.id + '/approve', { confirmed: true });
      setConfirming(undefined);
      await runs.reload();
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={schedule.name + ' · 执行历史'}
      description={schedule.timing.timeZone}
      onClose={onClose}
      wide
    >
      <div className="form-body">
        {confirming ? (
          <>
            <h3>批准当次执行</h3>
            <p>
              {confirming.name} · v{confirming.sourceVersion}
            </p>
            <p className="field-note">
              计划时间 {zoned(confirming.scheduledAt, schedule.timing.timeZone)} · 确认截止{' '}
              {zoned(confirming.confirmationExpiresAt, schedule.timing.timeZone)}
            </p>
            <div className="confirmation-targets">
              {confirming.targetIds.map((id) => (
                <span key={id}>{serverNames.get(id) ?? id}</span>
              ))}
            </div>
            {!!confirming.steps?.length && (
              <ol>
                {confirming.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
            )}
            <ErrorBanner error={error} />
          </>
        ) : (
          <>
            <ErrorBanner error={runs.error} retry={runs.reload} />
            {runs.loading ? (
              <Loading />
            ) : !runs.data?.length ? (
              <Empty title="暂无执行记录" description="计划触发后在此查看执行或跳过原因。" />
            ) : (
              <ul className="schedule-history">
                {runs.data.map((run) => (
                  <li key={run.id}>
                    <div className="schedule-history-heading">
                      <strong>
                        {run.name || schedule.name} · v{run.sourceVersion}
                      </strong>
                      <RunStatus value={run.status} />
                    </div>
                    <p>
                      计划时间 {zoned(run.scheduledAt, schedule.timing.timeZone)}
                      {run.missedUntil
                        ? ' 至 ' + zoned(run.missedUntil, schedule.timing.timeZone)
                        : ''}
                      {' · 实际触发 ' + zoned(run.triggeredAt, schedule.timing.timeZone)}
                    </p>
                    <p>
                      负责人{' '}
                      {run.ownerName ?? (run.ownerId === user.id ? user.username : run.ownerId)} ·
                      目标 {run.targetIds.map((id) => serverNames.get(id) ?? id).join('、') || '—'}
                    </p>
                    {run.reason && <p>{run.reason}</p>}
                    {run.status === 'AWAITING_CONFIRMATION' && (
                      <p>确认截止 {zoned(run.confirmationExpiresAt, schedule.timing.timeZone)}</p>
                    )}
                    {run.taskId && (
                      <a className="text-link" href={'#/tasks/' + run.taskId}>
                        查看任务
                      </a>
                    )}
                    {run.status === 'AWAITING_CONFIRMATION' && canEdit && (
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => {
                          setConfirming(run);
                          setError('');
                        }}
                      >
                        确认执行
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button
          className="button secondary"
          type="button"
          disabled={busy}
          onClick={confirming ? () => setConfirming(undefined) : onClose}
        >
          {confirming ? '返回历史' : '关闭'}
        </button>
        {confirming && (
          <button
            className="button primary"
            type="button"
            disabled={busy}
            onClick={() => void approve()}
          >
            批准此项执行
          </button>
        )}
      </div>
    </Modal>
  );
}

export function OperationSchedulesPage({ user }: { user: User }) {
  const schedules = useResource<OperationSchedule[]>(endpoint, 5000);
  const systemZone = useResource<{ timeZone: string }>(
    user.role === 'VIEWER' ? null : endpoint + '/time-zone',
  );
  const templates = useResource<ScheduleSource[]>(sourcePaths.COMMAND_TEMPLATE);
  const plans = useResource<ScheduleSource[]>(sourcePaths.OPERATION_PLAN);
  const [editing, setEditing] = useInlineEditor<OperationSchedule | 'new'>();
  const [viewing, setViewing] = useState<OperationSchedule>();
  const [deleting, setDeleting] = useState<OperationSchedule>();
  const [enabling, setEnabling] = useState<{
    schedule: OperationSchedule;
    preview: SchedulePreview;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sourceNames = new Map(
    [...(templates.data ?? []), ...(plans.data ?? [])].map((source) => [source.id, source.name]),
  );
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      void schedules.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  function previewEnable(schedule: OperationSchedule) {
    const {
      name,
      kind,
      sourceId,
      sourceVersion,
      timing,
      target,
      parameters,
      strategy,
      maxParallel,
      failurePolicy,
      timeoutSeconds,
      requireConfirmation,
    } = schedule;
    void change(async () => {
      const preview = await post<SchedulePreview>(endpoint + '/preview', {
        name,
        kind,
        sourceId,
        sourceVersion,
        timing,
        target,
        parameters,
        strategy,
        maxParallel,
        failurePolicy,
        timeoutSeconds,
        requireConfirmation,
      });
      setEnabling({ schedule, preview });
    });
  }

  return (
    <>
      <ErrorBanner error={!deleting && !enabling ? error : ''} />
      <ErrorBanner error={schedules.error} retry={schedules.reload} />
      <div hidden={Boolean(editing)}>
        <Section
          title="定时任务"
          subtitle="按计划运行固定版本的模板和方案。"
          action={
            <div className="row-actions">
              <RefreshButton onClick={schedules.reload} />
              {user.role !== 'VIEWER' && (
                <button
                  className="button primary"
                  type="button"
                  disabled={systemZone.loading}
                  onClick={() => setEditing('new')}
                >
                  <Plus size={16} />
                  新建定时任务
                </button>
              )}
            </div>
          }
        >
          {schedules.loading ? (
            <Loading />
          ) : !schedules.data?.length ? (
            <Empty
              title="暂无定时任务"
              description="创建计划后，可在此查看下次执行时间。"
              icon={<Clock3 size={25} />}
            />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>计划</th>
                    <th>状态</th>
                    <th>最近一次</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {schedules.data.map((schedule) => {
                    const editable =
                      user.role === 'ADMIN' ||
                      (user.role === 'OPERATOR' && user.id === schedule.ownerId);
                    return (
                      <tr key={schedule.id}>
                        <td>
                          <strong>{schedule.name}</strong>
                          <small className="schedule-secondary">
                            {sourceNames.get(schedule.sourceId) ?? kinds[schedule.kind]} · v
                            {schedule.sourceVersion} · {schedule.approvedTargetIds.length} 台
                          </small>
                        </td>
                        <td>
                          <strong>{timingLabel(schedule.timing)}</strong>
                          <small className="schedule-secondary">
                            {zoned(schedule.nextRunAt, schedule.timing.timeZone)} ·{' '}
                            {schedule.timing.timeZone}
                          </small>
                        </td>
                        <td>
                          {schedule.status === 'PAUSED' ? (
                            <span className="status amber">
                              <span />
                              已暂停
                            </span>
                          ) : (
                            <Status value={schedule.status === 'ENABLED' ? 'ACTIVE' : 'DISABLED'} />
                          )}
                          {schedule.statusReason && (
                            <small className="schedule-secondary">{schedule.statusReason}</small>
                          )}
                        </td>
                        <td>
                          {schedule.lastRun ? (
                            <>
                              <RunStatus value={schedule.lastRun.status} />
                              <small className="schedule-secondary">
                                {zoned(schedule.lastRun.scheduledAt, schedule.timing.timeZone)}
                              </small>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <div className="schedule-actions">
                            <button
                              className="button secondary small"
                              type="button"
                              onClick={() => setViewing(schedule)}
                            >
                              <History size={15} />
                              历史
                            </button>
                            {editable && (
                              <>
                                <button
                                  className="button secondary small"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setEditing(schedule)}
                                >
                                  <Pencil size={15} />
                                  编辑
                                </button>
                                {schedule.status === 'ENABLED' ? (
                                  <button
                                    className="button secondary small"
                                    type="button"
                                    disabled={busy}
                                    onClick={() =>
                                      void change(() =>
                                        post(endpoint + '/' + schedule.id + '/disable'),
                                      )
                                    }
                                  >
                                    关闭
                                  </button>
                                ) : (
                                  <button
                                    className="button secondary small"
                                    type="button"
                                    disabled={busy}
                                    onClick={() => previewEnable(schedule)}
                                  >
                                    启用
                                  </button>
                                )}
                                <button
                                  className="icon-button bare"
                                  type="button"
                                  disabled={busy}
                                  aria-label={'删除 ' + schedule.name}
                                  onClick={() => {
                                    setError('');
                                    setDeleting(schedule);
                                  }}
                                >
                                  <Trash2 size={16} />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
      {editing && (
        <ScheduleEditor
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? undefined : editing}
          systemTimeZone={
            systemZone.data?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
          }
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void schedules.reload();
          }}
        />
      )}
      {viewing && (
        <ScheduleHistory
          schedule={viewing}
          user={user}
          onClose={() => setViewing(undefined)}
          onChanged={() => void schedules.reload()}
        />
      )}
      {deleting && (
        <Confirm
          title="删除定时任务"
          description={'确认删除「' + deleting.name + '」？已生成的执行记录将保留。'}
          onClose={() => setDeleting(undefined)}
          error={error}
          busy={busy}
          destructive
          label="删除计划"
          onConfirm={() =>
            void change(async () => {
              await remove(endpoint + '/' + deleting.id);
              setDeleting(undefined);
            })
          }
        />
      )}
      {enabling && (
        <Confirm
          title="启用定时任务"
          description="确认后续执行时间、任务版本和目标范围。"
          detail={<SchedulePreviewBody config={enabling.schedule} preview={enabling.preview} />}
          onClose={() => setEnabling(undefined)}
          error={error}
          busy={busy}
          label="确认启用"
          onConfirm={() =>
            void change(async () => {
              await post(endpoint + '/' + enabling.schedule.id + '/enable', {
                expectedConfigurationHash: enabling.preview.configurationHash,
              });
              setEnabling(undefined);
            })
          }
        />
      )}
    </>
  );
}
