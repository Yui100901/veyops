import { BadRequestException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { MonitorMetrics } from './linux-sample';

export type TrendMetric = 'cpu' | 'memory' | 'disk' | 'rx' | 'tx';
export function trendMetric(value?: string): TrendMetric | undefined {
  if (
    value === undefined ||
    value === 'cpu' ||
    value === 'memory' ||
    value === 'disk' ||
    value === 'rx' ||
    value === 'tx'
  )
    return value;
  throw new BadRequestException('资源指标无效');
}

export async function readMonitorTrend(
  db: Kysely<Database>,
  serverId: string,
  from: number,
  to: number,
  metric: TrendMetric,
  mount: string,
  network?: string,
) {
  const series: { at: number; value: number | null; breakBefore?: boolean }[] = [];
  const mounts = new Set<string>(),
    interfaces = new Set<string>();
  let cursor: { at: number; id: string } | undefined;
  // A 24-hour query can span thousands of samples. Keep only a single chart series in memory.
  while (true) {
    let query = db
      .selectFrom('monitor_samples')
      .select(['id', 'at', 'metrics_json'])
      .where('server_id', '=', serverId)
      .where('at', '>=', from)
      .where('at', '<=', to);
    if (cursor) {
      const { at, id } = cursor;
      query = query.where((eb) =>
        eb.or([eb('at', '>', at), eb.and([eb('at', '=', at), eb('id', '>', id)])]),
      );
    }
    const rows = await query.orderBy('at').orderBy('id').limit(64).execute();
    for (const row of rows) {
      const sample: MonitorMetrics | null = row.metrics_json ? JSON.parse(row.metrics_json) : null;
      let value: number | null = null;
      if (sample) {
        for (const disk of sample.disks) mounts.add(disk.mount);
        for (const iface of sample.network) interfaces.add(iface.name);
        switch (metric) {
          case 'cpu':
            value = sample.cpuPercent;
            break;
          case 'memory':
            value = sample.memory.totalBytes
              ? (100 * sample.memory.usedBytes) / sample.memory.totalBytes
              : null;
            break;
          case 'disk':
            value = sample.disks.find((d) => d.mount === mount)?.usedPercent ?? null;
            break;
          case 'rx':
          case 'tx': {
            const nic = sample.network.find((n) => n.name === network);
            value = (metric === 'rx' ? nic?.rxBytesPerSecond : nic?.txBytesPerSecond) ?? null;
            break;
          }
        }
      }
      // After re-enabling a host, even a short monitoring pause must break gauge charts.
      const baseline =
        sample &&
        sample.cpuPercent === null &&
        sample.network.every(
          (nic) => nic.rxBytesPerSecond === null && nic.txBytesPerSecond === null,
        );
      series.push({ at: row.at, value, ...(baseline && { breakBefore: true }) });
    }
    if (rows.length < 64) break;
    cursor = rows[rows.length - 1];
  }
  return { from, to, series, mounts: [...mounts], interfaces: [...interfaces] };
}
