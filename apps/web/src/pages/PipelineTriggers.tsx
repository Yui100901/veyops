import { useState } from 'react';
import { formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import { civilTime, timestampInZone } from './OperationSchedules';
import type { DeploymentSelection } from '../models';
import {
  DeploymentSelectionPicker,
  deploymentSelection,
  useDeploymentInventory,
} from './DeploymentSelection';

type Kind = 'SCHEDULE' | 'POLL';
type Timing = {
  type: 'ONCE' | 'INTERVAL' | 'CRON';
  timeZone: string;
  runAt?: number;
  intervalSeconds?: number;
  cron?: string;
};
type Mode = 'BUILD_ONLY' | 'DEPLOY';
type Rule = {
  id: string;
  target: DeploymentSelection;
  kind: Kind;
  environmentId: string;
  environmentName?: string;
  version: number;
  branch: string;
  timing: Timing;
  buildCurrent: boolean;
  mode: Mode;
  status: string;
  reason: string | null;
  nextAt: number | null;
};
type Event = {
  id: string;
  kind: Kind | 'WEBHOOK';
  version: number | null;
  branch: string | null;
  mode: Mode | null;
  created_at: number;
  scheduled_at: number | null;
  commit_sha: string | null;
  task_id: string | null;
  status: string;
  reason: string | null;
  trigger_id: string | null;
};
type Preview = {
  configurationHash: string;
  upcoming: number[];
  mode: Mode;
  buildLocation: string;
  serverIds: string[];
  requireApproval: boolean;
  key: string;
};
const labels: Record<string, string> = {
  SCHEDULE: '定时',
  POLL: '分支轮询',
  WEBHOOK: 'Webhook',
  ENABLED: '运行中',
  DISABLED: '已停用',
  PAUSED: '待重新确认',
  COMPLETED: '已结束',
  QUEUED: '已入队',
  DUPLICATE: '已复用',
  FAILED: '失败',
  SKIPPED: '已跳过',
  BUILD_ONLY: '仅构建',
  DEPLOY: '构建后部署',
};
export function PipelineTriggers({
  pipelineId,
  version,
  environmentId,
  branch,
  canManage,
}: {
  pipelineId: string;
  version: number;
  environmentId: string;
  branch: string;
  canManage: boolean;
}) {
  const path = '/pipelines/' + pipelineId + '/triggers';
  const rules = useResource<Rule[]>(path, 10000);
  const history = useResource<Event[]>(path + '/history', 10000);
  const inventory = useDeploymentInventory();
  const [customTargets, setCustomTargets] = useState(false);
  const [selection, setSelection] = useState<DeploymentSelection>(deploymentSelection());
  const [editing, setEditing] = useState<Rule>();
  const [useSelectedBinding, setUseSelectedBinding] = useState(false);
  const [kind, setKind] = useState<Kind>('SCHEDULE');
  const [type, setType] = useState<Timing['type']>('INTERVAL');
  const [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [interval, setInterval] = useState('300');
  const [cron, setCron] = useState('0 2 * * *');
  const [at, setAt] = useState('');
  const [buildCurrent, setBuildCurrent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const current = {
    kind,
    ...(customTargets ? selection : {}),
    version: editing && !useSelectedBinding ? editing.version : version,
    environmentId: editing && !useSelectedBinding ? editing.environmentId : environmentId,
    branch: editing && !useSelectedBinding ? editing.branch : branch,
  };
  const key = JSON.stringify([
    pipelineId,
    current,
    editing?.id,
    type,
    zone,
    interval,
    cron,
    at,
    buildCurrent,
  ]);
  const confirmed = preview?.key === key ? preview : undefined;
  function edit(rule: Rule) {
    setCustomTargets(rule.target.serverIds !== undefined || rule.target.groupIds !== undefined);
    setSelection(deploymentSelection(rule.target));
    setEditing(rule);
    setUseSelectedBinding(false);
    setKind(rule.kind);
    setType(rule.timing.type);
    setZone(rule.timing.timeZone);
    setInterval(String(rule.timing.intervalSeconds ?? 300));
    setCron(rule.timing.cron ?? '0 2 * * *');
    setAt(rule.timing.runAt ? civilTime(rule.timing.runAt, rule.timing.timeZone) : '');
    setBuildCurrent(rule.buildCurrent);
    setPreview(undefined);
    setError('');
  }
  async function execute(action: 'preview' | 'save' | 'disable', rule?: Rule) {
    setError('');
    setBusy(true);
    try {
      if (action === 'disable' && rule) {
        await post(path + '/' + rule.id + '/disable');
        setPreview(undefined);
      } else {
        const timing: Timing = { type, timeZone: zone };
        if (type === 'ONCE') timing.runAt = timestampInZone(at, zone);
        if (type === 'INTERVAL') timing.intervalSeconds = Number(interval);
        if (type === 'CRON') timing.cron = cron;
        const input = { ...current, timing, buildCurrent: kind === 'POLL' && buildCurrent };
        if (action === 'preview') {
          const result = await post<Omit<Preview, 'key'>>(path + '/preview', input);
          setPreview({ ...result, key });
        } else if (confirmed) {
          await post(path + (editing ? '/' + editing.id : ''), {
            ...input,
            expectedConfigurationHash: confirmed.configurationHash,
          });
          setEditing(undefined);
          setPreview(undefined);
        }
      }
      await Promise.all([rules.reload(), history.reload()]);
    } catch (err) {
      setError(message(err));
      setPreview(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack">
      <ErrorBanner error={error || rules.error || history.error} />
      <h3>触发规则</h3>
      {rules.data?.length === 0 && <p className="muted">尚未配置定时或轮询触发。</p>}
      {rules.data?.map((rule) => (
        <div className="subpanel" key={rule.id}>
          <strong>
            {labels[rule.kind]} · {rule.branch} · v{rule.version}
          </strong>
          <p>
            {rule.environmentName} · {labels[rule.mode]} · {labels[rule.status]} · 下次{' '}
            {formatTime(rule.nextAt)} {rule.reason}
          </p>
          {canManage && (
            <div className="actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => edit(rule)}
              >
                编辑规则
              </button>
              {rule.status === 'ENABLED' && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void execute('disable', rule)}
                >
                  停用
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {canManage && (
        <fieldset disabled={busy}>
          <legend>{editing ? '编辑触发规则' : '新增触发规则'}</legend>
          {editing && (
            <p>
              {editing.environmentName} · {editing.branch} · v{editing.version}{' '}
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setEditing(undefined);
                  setPreview(undefined);
                }}
              >
                取消编辑
              </button>
            </p>
          )}
          {editing && (
            <label>
              <input
                type="checkbox"
                checked={useSelectedBinding}
                onChange={(e) => setUseSelectedBinding(e.target.checked)}
              />
              将绑定更新为上方所选环境和分支（v{version}）
            </label>
          )}
          <div className="form-grid">
            <Field label="触发方式">
              <select
                value={kind}
                onChange={(e) => {
                  const k = e.target.value as Kind;
                  setKind(k);
                  if (k === 'POLL') setType('INTERVAL');
                }}
              >
                <option value="SCHEDULE">定时构建</option>
                <option value="POLL">间隔轮询分支</option>
              </select>
            </Field>
            {kind === 'SCHEDULE' && (
              <Field label="时间规则">
                <select value={type} onChange={(e) => setType(e.target.value as Timing['type'])}>
                  <option value="INTERVAL">固定间隔</option>
                  <option value="CRON">Cron</option>
                  <option value="ONCE">单次</option>
                </select>
              </Field>
            )}
            {type === 'INTERVAL' && (
              <Field label="间隔（秒）">
                <input
                  type="number"
                  min="1"
                  max="31536000"
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                />
              </Field>
            )}
            {type === 'CRON' && (
              <Field label="五字段 Cron">
                <input value={cron} onChange={(e) => setCron(e.target.value)} />
              </Field>
            )}
            {type === 'ONCE' && (
              <Field label="执行时间">
                <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </Field>
            )}
            <Field label="时区">
              <input value={zone} onChange={(e) => setZone(e.target.value)} />
            </Field>
          </div>
          {kind === 'POLL' && (
            <label>
              <input
                type="checkbox"
                checked={buildCurrent}
                onChange={(e) => setBuildCurrent(e.target.checked)}
              />
              首次检查即构建当前提交
            </label>
          )}
          <Field label="发布目标">
            <select
              value={customTargets ? 'custom' : 'default'}
              onChange={(e) => setCustomTargets(e.target.value === 'custom')}
            >
              <option value="default">使用服务环境已配置的服务器或分组</option>
              <option value="custom">为此规则选择服务器或分组</option>
            </select>
          </Field>
          {customTargets && (
            <DeploymentSelectionPicker
              inventory={inventory}
              value={selection}
              onChange={setSelection}
            />
          )}
          <p>
            <button
              className="button secondary"
              type="button"
              disabled={!current.branch || !current.environmentId}
              onClick={() => void execute('preview')}
            >
              预览规则
            </button>
          </p>
          {confirmed && (
            <div className="subpanel">
              <strong>
                {labels[confirmed.mode]} ·{' '}
                {confirmed.buildLocation === 'MANAGER' ? '管理端' : '目标端'}构建
              </strong>
              <p>
                发布审批 {confirmed.requireApproval ? '必需' : '无'} · 目标{' '}
                {confirmed.serverIds
                  .map((id) => inventory.servers.data?.find((s) => s.id === id)?.name ?? id)
                  .join('、')}
              </p>
              <p>
                预计执行{' '}
                {confirmed.upcoming
                  .map((t) => new Date(t).toLocaleString('zh-CN', { timeZone: zone }))
                  .join(' / ')}
                （{zone}）
              </p>
              <button className="button primary" type="button" onClick={() => void execute('save')}>
                确认并启用
              </button>
            </div>
          )}
        </fieldset>
      )}
      <h3>最近触发记录</h3>
      {history.data?.length === 0 && <p className="muted">暂无触发记录。</p>}
      {Boolean(history.data?.length) && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间 / 规则</th>
                <th>分支 / 提交</th>
                <th>模式</th>
                <th>受理结果</th>
              </tr>
            </thead>
            <tbody>
              {history.data?.map((e) => (
                <tr key={e.id}>
                  <td title={e.trigger_id ?? 'Webhook'}>
                    {formatTime(e.scheduled_at ?? e.created_at)} · {labels[e.kind]}
                  </td>
                  <td>
                    {e.branch} · v{e.version}{' '}
                    <code title={e.commit_sha ?? ''}>{e.commit_sha?.slice(0, 10)}</code>
                  </td>
                  <td>{e.mode ? labels[e.mode] : '—'}</td>
                  <td>
                    {e.task_id ? (
                      <a className="text-link" href={'#/tasks/' + e.task_id}>
                        {labels[e.status]} · 查看任务
                      </a>
                    ) : (
                      labels[e.status]
                    )}{' '}
                    {e.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
