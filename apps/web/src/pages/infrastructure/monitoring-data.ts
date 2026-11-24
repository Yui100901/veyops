export interface MonitorSettings {
  enabled: boolean;
  intervalSeconds: number;
  retentionDays: number;
  concurrency: number;
}
export interface Metrics {
  cpuPercent: number | null;
  load: number[];
  memory: {
    totalBytes: number;
    availableBytes: number;
    usedBytes: number;
    swapTotalBytes: number;
    swapFreeBytes: number;
  };
  disks: { mount: string; totalBytes: number; availableBytes: number; usedPercent: number }[];
  network: {
    name: string;
    rxBytes: string;
    txBytes: string;
    rxBytesPerSecond: number | null;
    txBytesPerSecond: number | null;
  }[];
}
export interface MonitorRow {
  serverId: string;
  enabled: boolean;
  interfaceName: string | null;
  status: 'DISABLED' | 'WAITING' | 'OK' | 'STALE' | 'FAILED';
  lastAttemptAt: number | null;
  sampledAt: number | null;
  error: string | null;
  metrics: Metrics | null;
}
export interface MonitorDetail {
  server: MonitorRow;
  from: number;
  to: number;
  series: { at: number; value: number | null; breakBefore?: boolean }[];
  mounts: string[];
  interfaces: string[];
}
export const monitorStates = {
  DISABLED: '监控已关闭',
  WAITING: '等待采样',
  OK: '采样正常',
  STALE: '采样已过期',
  FAILED: '采集失败',
};
export function pickInterface(metrics: Metrics, name?: string | null) {
  return name
    ? metrics.network.find((item) => item.name === name)
    : (metrics.network.find((item) => item.name !== 'lo') ?? metrics.network[0]);
}
export const metricNames = {
  cpu: 'CPU 使用率',
  memory: '内存使用率',
  disk: '磁盘使用率',
  rx: '接收速率',
  tx: '发送速率',
};
export type MetricKey = keyof typeof metricNames;
export function metricValue(
  metrics: Metrics | null | undefined,
  key: MetricKey,
  network?: string | null,
  mount = '/',
) {
  if (!metrics) return null;
  switch (key) {
    case 'cpu':
      return metrics.cpuPercent;
    case 'memory':
      return metrics.memory.totalBytes
        ? (100 * metrics.memory.usedBytes) / metrics.memory.totalBytes
        : null;
    case 'disk':
      return metrics.disks.find((disk) => disk.mount === mount)?.usedPercent ?? null;
    case 'rx':
      return pickInterface(metrics, network)?.rxBytesPerSecond ?? null;
    case 'tx':
      return pickInterface(metrics, network)?.txBytesPerSecond ?? null;
  }
}
const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
export function bytes(value: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scale = 0;
  while (value >= 1024 && scale < units.length - 1) {
    value /= 1024;
    scale++;
  }
  return decimal.format(value) + ' ' + units[scale];
}
export function metricText(value: number | null, key: MetricKey) {
  if (value == null) return '—';
  return key === 'rx' || key === 'tx' ? bytes(value) + '/s' : decimal.format(value) + '%';
}
