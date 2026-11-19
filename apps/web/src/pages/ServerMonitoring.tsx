import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Activity, Pencil, RefreshCw } from 'lucide-react';
import { api, formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field, Form, Loading, Modal, Section } from '../components';
import type { User } from '../models';
import {
  bytes,
  metricNames,
  metricText,
  metricValue,
  monitorStates,
  pickInterface,
} from './monitoring-data';
import type { MetricKey, MonitorDetail, MonitorRow, MonitorSettings } from './monitoring-data';
import './monitoring.css';

export function MonitoringSettings({ user }: { user: User }) {
  const resource = useResource<MonitorSettings>('/monitoring/settings');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settings = resource.data;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api('/monitoring/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          enabled: form.has('enabled'),
          intervalSeconds: Number(form.get('intervalSeconds')),
          retentionDays: Number(form.get('retentionDays')),
          concurrency: Number(form.get('concurrency')),
        }),
      });
      setEditing(false);
      await resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="Linux 资源监控"
      action={
        settings &&
        user.role === 'ADMIN' && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => {
              setError('');
              setEditing(true);
            }}
          >
            <Pencil size={15} />
            修改配置
          </button>
        )
      }
    >
      <ErrorBanner error={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : (
        settings && (
          <>
            <div className="setting-row">
              <span>
                <Activity size={17} />
                定时采集
              </span>
              <strong>{settings.enabled ? '已开启' : '监控已关闭'}</strong>
            </div>
            <div className="setting-row">
              <span>采样间隔</span>
              <strong>{settings.intervalSeconds} 秒</strong>
            </div>
            <div className="setting-row">
              <span>历史保留</span>
              <strong>{settings.retentionDays} 天</strong>
            </div>
            <div className="setting-row">
              <span>同时采集上限</span>
              <strong>{settings.concurrency} 台</strong>
            </div>
          </>
        )
      )}
      {editing && settings && (
        <Modal
          title="Linux 资源监控配置"
          onClose={() => {
            if (!busy) setEditing(false);
          }}
        >
          <Form busy={busy} error={error} onCancel={() => setEditing(false)} onSubmit={save}>
            <label className="checkbox-row">
              <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
              启用服务器资源监控
            </label>
            <p className="monitor-note">
              仅采集已开启单机监控的服务器。关闭后，历史可在保留期内查看。
            </p>
            <Field label="采样间隔（秒）">
              <input
                name="intervalSeconds"
                type="number"
                required
                min="15"
                max="3600"
                defaultValue={settings.intervalSeconds}
              />
            </Field>
            <Field label="历史保留（天）">
              <input
                name="retentionDays"
                type="number"
                required
                min="1"
                max="90"
                defaultValue={settings.retentionDays}
              />
            </Field>
            <Field label="同时采集上限（台）">
              <input
                name="concurrency"
                type="number"
                required
                min="1"
                max="10"
                defaultValue={settings.concurrency}
              />
            </Field>
          </Form>
        </Modal>
      )}
    </Section>
  );
}

export function MonitorSummary({ row, open }: { row?: MonitorRow; open: () => void }) {
  if (!row) return <span className="muted">—</span>;
  const m = row.metrics;
  return (
    <div className="monitor-summary">
      <button type="button" className="text-button" onClick={open}>
        {monitorStates[row.status]}
      </button>
      {m && (
        <>
          <small>
            CPU {metricText(m.cpuPercent, 'cpu')} · 内存{' '}
            {metricText(metricValue(m, 'memory'), 'memory')} · 根盘{' '}
            {metricText(metricValue(m, 'disk'), 'disk')}
          </small>
          <small>
            {pickInterface(m, row.interfaceName)?.name || row.interfaceName || '网卡'} ↓{' '}
            {metricText(metricValue(m, 'rx', row.interfaceName), 'rx')} ↑{' '}
            {metricText(metricValue(m, 'tx', row.interfaceName), 'tx')}
          </small>
          <small>采样 {formatTime(row.sampledAt)}</small>
        </>
      )}
    </div>
  );
}

function MetricTrend({
  trend,
  hours,
  metric,
  interval,
}: {
  trend: MonitorDetail;
  hours: number;
  metric: MetricKey;
  interval: number;
}) {
  const { from: start, to: end, series: points } = trend;
  const values = points.flatMap((p) => (p.value == null ? [] : [p.value]));
  if (!values.length)
    return <p className="mini-empty">此时间段没有可用的{metricNames[metric]}样本</p>;
  const max = metric === 'rx' || metric === 'tx' ? Math.max(1, ...values) : 100;
  const paths: string[] = [];
  const isolated: { x: number; y: number }[] = [];
  let previous = 0,
    count = 0,
    last = { x: 0, y: 0 };
  function endSegment() {
    if (count === 1) isolated.push(last);
    count = 0;
  }
  for (const p of points) {
    if (p.value == null || p.breakBefore || p.at - previous > interval * 3000) endSegment();
    if (p.value == null) continue;
    last = {
      x: 2 + (596 * (p.at - start)) / (end - start),
      y: 93 - 90 * Math.min(1, Math.max(0, p.value / max)),
    };
    paths.push((count ? 'L' : 'M') + last.x.toFixed(2) + ' ' + last.y.toFixed(2));
    count++;
    previous = p.at;
  }
  endSegment();
  return (
    <figure className="monitor-chart">
      <figcaption>
        {metricNames[metric]} · {metricText(Math.min(...values), metric)} 至{' '}
        {metricText(Math.max(...values), metric)}
      </figcaption>
      <div className="monitor-plot">
        <span>{metricText(max, metric)}</span>
        <svg
          viewBox="0 0 600 96"
          preserveAspectRatio="none"
          role="img"
          aria-label={
            metricNames[metric] + '，近 ' + hours + ' 小时，共 ' + values.length + ' 个有效样本'
          }
        >
          <path
            d="M0 3H600M0 48H600M0 93H600"
            fill="none"
            stroke="var(--border)"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={paths.join(' ')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
          {isolated.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="2.4" fill="var(--accent)" />
          ))}
        </svg>
      </div>
      <div className="monitor-axis">
        <span>{formatTime(start)}</span>
        <span>{formatTime(end)}</span>
      </div>
    </figure>
  );
}

export function ServerMonitoring({
  id,
  canEdit,
  onChange,
  summary,
}: {
  id: string;
  canEdit: boolean;
  onChange: () => void;
  summary?: MonitorRow;
}) {
  const [hours, setHours] = useState(1);
  const [metric, setMetric] = useState<MetricKey>('cpu');
  const [mount, setMount] = useState('/');
  const [network, setNetwork] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = new URLSearchParams({ hours: String(hours), metric });
  if (metric === 'disk') query.set('mount', mount);
  if ((metric === 'rx' || metric === 'tx') && network) query.set('interfaceName', network);
  const resource = useResource<MonitorDetail>(
    `/monitoring/servers/${id}?${query}`,
    hours === 1 ? 30000 : 120000,
  );
  const settings = useResource<MonitorSettings>('/monitoring/settings', 30000);
  // Keep selectors mounted while changing chart queries. ServerOverview remounts per host.
  const [lastDetail, setLastDetail] =
    useState<Pick<MonitorDetail, 'server' | 'interfaces' | 'mounts'>>();
  useEffect(() => {
    if (resource.data) {
      const { server, interfaces, mounts } = resource.data;
      setLastDetail({ server, interfaces, mounts });
    }
  }, [resource.data]);
  const detail = resource.data ?? lastDetail;
  const row = detail?.server ?? summary;
  const m = row?.metrics;
  const selectedDisk = m?.disks.find((disk) => disk.mount === mount);
  const selected = network ?? row?.interfaceName ?? (m && pickInterface(m)?.name) ?? '';
  const iface = m && pickInterface(m, selected);
  const mounts = new Set<string>([
    mount,
    '/',
    ...(m?.disks ?? []).map((d) => d.mount),
    ...(detail?.mounts ?? []),
  ]);
  const interfaces = new Set<string>([
    ...(m?.network ?? []).map((n) => n.name),
    ...(detail?.interfaces ?? []),
  ]);
  if (selected) interfaces.add(selected);
  async function mutate(patch?: { enabled?: boolean; interfaceName?: string | null }) {
    setError('');
    setBusy(true);
    try {
      if (patch)
        await api(`/monitoring/servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      else await post(`/monitoring/servers/${id}/refresh`);
    } catch (err) {
      setError(message(err));
    } finally {
      await resource.reload();
      onChange();
      setBusy(false);
    }
  }
  return (
    <div className="monitor-detail">
      <ErrorBanner
        error={resource.error || settings.error || error}
        retry={() => {
          void resource.reload();
          void settings.reload();
        }}
      />
      {resource.loading && !row ? (
        <Loading />
      ) : (
        row && (
          <>
            <div className="monitor-toolbar">
              <strong>{monitorStates[row.status]}</strong>
              {canEdit && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    disabled={busy}
                    onChange={(e) => void mutate({ enabled: e.target.checked })}
                  />
                  单机监控
                </label>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={
                    busy || !settings.data?.enabled || !row.enabled || row.status === 'DISABLED'
                  }
                  onClick={() => void mutate()}
                >
                  <RefreshCw size={15} />
                  {busy ? '处理中…' : '立即采样'}
                </button>
              )}
            </div>
            {settings.data && !settings.data.enabled && (
              <p className="monitor-note">
                系统监控已关闭。
                <a className="text-link" href="#/settings">
                  查看系统设置
                </a>
              </p>
            )}
            <p className="monitor-note">
              最近成功采样 {formatTime(row.sampledAt)} · 最近尝试 {formatTime(row.lastAttemptAt)}
            </p>
            {row.error && <ErrorBanner error={row.error} />}
            {m ? (
              <>
                <dl className="monitor-stats">
                  <div>
                    <dt>CPU 使用率</dt>
                    <dd>{metricText(m.cpuPercent, 'cpu')}</dd>
                    <small>负载（1 / 5 / 15 分钟） {m.load.join(' / ')}</small>
                  </div>
                  <div>
                    <dt>内存使用率</dt>
                    <dd>{metricText(metricValue(m, 'memory'), 'memory')}</dd>
                    <small>
                      使用 {bytes(m.memory.usedBytes)} / 总量 {bytes(m.memory.totalBytes)} · 可用{' '}
                      {bytes(m.memory.availableBytes)}
                    </small>
                  </div>
                  <div>
                    <dt>交换空间</dt>
                    <dd>{bytes(m.memory.swapTotalBytes - m.memory.swapFreeBytes)}</dd>
                    <small>总量 {bytes(m.memory.swapTotalBytes)}</small>
                  </div>
                </dl>
              </>
            ) : (
              <p className="mini-empty">暂无成功采样</p>
            )}
            {(m || metric === 'disk') && (
              <div className="monitor-toolbar">
                <Field label="磁盘挂载点">
                  <select value={mount} onChange={(e) => setMount(e.target.value)}>
                    {[...mounts].map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </Field>
                <span className="monitor-note">
                  {selectedDisk
                    ? `使用率 ${metricText(selectedDisk.usedPercent, 'disk')} · 可用 ${bytes(selectedDisk.availableBytes)} / 总量 ${bytes(selectedDisk.totalBytes)}`
                    : '最近采样中无此挂载点'}
                </span>
              </div>
            )}
            {interfaces.size > 0 && (
              <>
                <div className="monitor-toolbar">
                  <Field label="网络接口">
                    <select value={selected} onChange={(e) => setNetwork(e.target.value)}>
                      {!selected && <option value="">选择接口</option>}
                      {[...interfaces].map((name) => (
                        <option key={name}>{name}</option>
                      ))}
                    </select>
                  </Field>
                  {canEdit && selected && selected !== row.interfaceName && (
                    <button
                      disabled={busy}
                      className="button secondary small"
                      type="button"
                      onClick={() => void mutate({ interfaceName: selected })}
                    >
                      设为列表网卡
                    </button>
                  )}
                  {canEdit && row.interfaceName && (
                    <button
                      disabled={busy}
                      className="text-button"
                      type="button"
                      onClick={() => void mutate({ interfaceName: null })}
                    >
                      恢复自动选择
                    </button>
                  )}
                </div>
                <p className="monitor-note">
                  接收 {metricText(iface?.rxBytesPerSecond ?? null, 'rx')} · 发送{' '}
                  {metricText(iface?.txBytesPerSecond ?? null, 'tx')}
                  {iface && (
                    <>
                      {' '}
                      · 累计接收 {iface.rxBytes} B · 累计发送 {iface.txBytes} B
                    </>
                  )}
                </p>
              </>
            )}
            <h3 className="field-title">近期趋势</h3>
            <div className="monitor-toolbar">
              <Field label="时间范围">
                <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  <option value={1}>近 1 小时</option>
                  <option value={24}>近 24 小时</option>
                </select>
              </Field>
              <Field label="资源指标">
                <select value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
                  {Object.entries(metricNames).map(([key, label]) => (
                    <option value={key} key={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {resource.data ? (
              <MetricTrend
                trend={resource.data}
                hours={hours}
                metric={metric}
                interval={settings.data?.intervalSeconds ?? 60}
              />
            ) : (
              resource.loading && <Loading />
            )}
          </>
        )
      )}
    </div>
  );
}
