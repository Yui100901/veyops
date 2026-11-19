import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { ServersService } from '../servers/servers.service';
import { readMonitorTrend, type TrendMetric } from './monitor-trend';
import {
  SshService,
  SshExecutionError,
  SshHostKeyMismatchError,
} from '../../infrastructure/ssh/ssh.service';
import {
  linuxMetrics,
  linuxMonitorCommand,
  parseLinuxSample,
  type LinuxSample,
  type LinuxCounters,
  type MonitorMetrics,
} from './linux-sample';

type Settings = {
  enabled: boolean;
  intervalSeconds: number;
  retentionDays: number;
  concurrency: number;
};
type Host = Database['monitor_hosts'];
const day = 86_400_000;
const leaseMs = 30000;
function invalidateLease(lease: string | null) {
  return lease && !lease.startsWith('cancelled:') ? 'cancelled:' + lease : lease;
}
function newHost(serverId: string, nextAt: number): Host {
  return {
    server_id: serverId,
    enabled: 1,
    interface_name: null,
    next_at: nextAt,
    lease: null,
    lease_until: 0,
    failures: 0,
    attempt_at: null,
    sampled_at: null,
    raw_json: null,
    metrics_json: null,
    error: null,
  };
}

async function settings(db: Kysely<Database>): Promise<Settings> {
  const row = await db
    .selectFrom('monitor_settings')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  return {
    enabled: !!row.enabled,
    intervalSeconds: row.interval_seconds,
    retentionDays: row.retention_days,
    concurrency: row.concurrency,
  };
}
// Serialize claims and configuration changes across API and dedicated worker processes.
async function lock(db: Kysely<Database>) {
  await db
    .updateTable('monitor_settings')
    .set((eb) => ({ id: eb.ref('id') }))
    .where('id', '=', 1)
    .execute();
}
type LatestHost = Pick<
  Host,
  'enabled' | 'sampled_at' | 'attempt_at' | 'interface_name' | 'error' | 'metrics_json'
>;
function present(
  id: string,
  host: LatestHost | undefined,
  s: Settings,
  now: number,
  hasBaseline: boolean,
) {
  const enabled = host ? !!host.enabled : true;
  const sampledAt =
    host?.sampled_at && host.sampled_at >= now - day * s.retentionDays ? host.sampled_at : null;
  const status =
    !enabled || !s.enabled
      ? 'DISABLED'
      : host?.error
        ? 'FAILED'
        : !sampledAt
          ? 'WAITING'
          : now - sampledAt > s.intervalSeconds * 2000 || !hasBaseline
            ? 'STALE'
            : 'OK';
  return {
    serverId: id,
    enabled,
    interfaceName: host?.interface_name ?? null,
    status,
    lastAttemptAt: host?.attempt_at ?? null,
    sampledAt,
    error: host?.error ?? null,
    metrics: (sampledAt && host?.metrics_json
      ? JSON.parse(host.metrics_json)
      : null) as MonitorMetrics | null,
  };
}
function stagger(id: string, interval: number) {
  return createHash('sha256').update(id).digest().readUInt32BE(0) % (interval * 1000);
}

@Injectable()
export class MonitoringService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly shutdown = new AbortController();
  private readonly pending = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private seedAt = 0;
  private pruneAt = 0;
  constructor(
    private readonly database: DatabaseService,
    private readonly servers: ServersService,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
  ) {}
  onApplicationBootstrap() {
    if (process.env.WORKER_ENABLED !== 'false') this.start();
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(
        () => void this.tick().catch(() => this.logger.warn('资源采集调度失败，下轮重试')),
        2000,
      );
      this.timer.unref();
    }
  }
  async onApplicationShutdown() {
    clearInterval(this.timer);
    this.shutdown.abort();
    await this.polling?.catch(() => undefined);
    await Promise.allSettled(this.pending.values());
  }
  settings() {
    return settings(this.database.db);
  }
  async updateSettings(input: Partial<Settings>, userId: string) {
    const result = await this.database.db.transaction().execute(async (tx) => {
      await lock(tx);
      const old = await settings(tx);
      const current = {
        enabled: input.enabled ?? old.enabled,
        intervalSeconds: input.intervalSeconds ?? old.intervalSeconds,
        retentionDays: input.retentionDays ?? old.retentionDays,
        concurrency: input.concurrency ?? old.concurrency,
      };
      await tx
        .updateTable('monitor_settings')
        .set({
          enabled: Number(current.enabled),
          interval_seconds: current.intervalSeconds,
          retention_days: current.retentionDays,
          concurrency: current.concurrency,
        })
        .where('id', '=', 1)
        .execute();
      if (current.enabled !== old.enabled || current.intervalSeconds !== old.intervalSeconds) {
        const hosts = await tx.selectFrom('monitor_hosts').select(['server_id', 'lease']).execute();
        for (const host of hosts)
          await tx
            .updateTable('monitor_hosts')
            .set({
              lease: invalidateLease(host.lease),
              raw_json: null,
              failures: 0,
              error: null,
              next_at: Date.now() + stagger(host.server_id, current.intervalSeconds),
            })
            .where('server_id', '=', host.server_id)
            .execute();
      }
      await this.audit.record(
        userId,
        'monitoring.settings.update',
        'monitoring',
        'system',
        current,
        tx,
      );
      return current;
    });
    this.seedAt = 0;
    this.pruneAt = 0;
    return result;
  }
  async updateHost(
    id: string,
    input: { enabled?: boolean; interfaceName?: string | null },
    userId: string,
  ) {
    await this.servers.get(id);
    await this.database.db.transaction().execute(async (tx) => {
      await lock(tx);
      await tx
        .insertInto('monitor_hosts')
        .values(newHost(id, 0))
        .onConflict((c) => c.column('server_id').doNothing())
        .execute();
      const host = await tx
        .selectFrom('monitor_hosts')
        .selectAll()
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow();
      const enabled = Number(input.enabled ?? !!host.enabled);
      await tx
        .updateTable('monitor_hosts')
        .set({
          enabled,
          interface_name:
            input.interfaceName === undefined ? host.interface_name : input.interfaceName,
          ...(enabled !== host.enabled && {
            lease: invalidateLease(host.lease),
            raw_json: null,
            failures: 0,
            error: null,
            next_at: 0,
          }),
        })
        .where('server_id', '=', id)
        .execute();
      await this.audit.record(userId, 'monitoring.server.update', 'server', id, input, tx);
    });
    return this.row(id);
  }
  private async row(id: string) {
    const db = this.database.db;
    const [s, host] = await Promise.all([
      settings(db),
      db.selectFrom('monitor_hosts').selectAll().where('server_id', '=', id).executeTakeFirst(),
    ]);
    return present(id, host, s, Date.now(), Boolean(host?.raw_json));
  }
  async list(summary = false) {
    const db = this.database.db;
    const [s, hosts] = await Promise.all([
      settings(db),
      db
        .selectFrom('servers as server')
        .leftJoin('monitor_hosts as host', 'host.server_id', 'server.id')
        .select([
          'server.id',
          'host.enabled',
          'host.sampled_at',
          'host.attempt_at',
          'host.interface_name',
          'host.error',
          'host.metrics_json',
        ])
        .select(sql<number>`case when host.raw_json is null then 0 else 1 end`.as('hasBaseline'))
        .where('server.is_active', '=', 1)
        .execute(),
    ]);
    const now = Date.now();
    return hosts.map((host) => {
      const row = present(
        host.id,
        host.enabled === null ? undefined : { ...host, enabled: host.enabled },
        s,
        now,
        Boolean(host.hasBaseline),
      );
      if (summary && row.metrics) {
        const interfaces = row.metrics.network;
        const selected = row.interfaceName
          ? interfaces.find((n) => n.name === row.interfaceName)
          : (interfaces.find((n) => n.name !== 'lo') ?? interfaces[0]);
        row.metrics.disks = row.metrics.disks.filter((disk) => disk.mount === '/');
        row.metrics.network = selected ? [selected] : [];
      }
      return row;
    });
  }
  async trend(id: string, hours: number, metric: TrendMetric, mount = '/', interfaceName?: string) {
    await this.servers.get(id);
    const server = await this.row(id);
    const to = Date.now(),
      from = to - hours * 3600000;
    const nic =
      interfaceName ??
      server.interfaceName ??
      server.metrics?.network.find((n) => n.name !== 'lo')?.name ??
      server.metrics?.network[0]?.name;
    return {
      server,
      ...(await readMonitorTrend(this.database.db, id, from, to, metric, mount, nic)),
    };
  }
  async detail(id: string, hours: number) {
    await this.servers.get(id);
    const server = await this.row(id);
    const rows = await this.database.db
      .selectFrom('monitor_samples')
      .select(['at', 'metrics_json'])
      .where('server_id', '=', id)
      .where('at', '>=', Date.now() - hours * 3600000)
      .orderBy('at')
      .execute();
    return {
      server,
      history: rows.map(({ at, metrics_json }) => ({
        at,
        metrics: metrics_json ? (JSON.parse(metrics_json) as MonitorMetrics) : null,
      })),
    };
  }
  async refresh(id: string) {
    await this.servers.get(id);
    if (this.pending.has(id) && (await this.row(id)).status === 'DISABLED')
      throw new ConflictException('资源监控已关闭');
    await this.collect(id, true);
    return this.row(id);
  }
  tick() {
    this.polling ??= this.poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }
  private async poll() {
    const db = this.database.db,
      now = Date.now(),
      s = await settings(db);
    if (now >= this.pruneAt) {
      const cutoff = now - day * s.retentionDays;
      await db.deleteFrom('monitor_samples').where('at', '<', cutoff).execute();
      await db
        .updateTable('monitor_hosts')
        .set({ raw_json: null, metrics_json: null, sampled_at: null })
        .where('sampled_at', '<', cutoff)
        .execute();
      this.pruneAt = now + 60000;
    }
    if (!s.enabled || this.shutdown.signal.aborted) return;
    if (now >= this.seedAt) {
      const missing = await db
        .selectFrom('servers')
        .leftJoin('monitor_hosts', 'monitor_hosts.server_id', 'servers.id')
        .select('servers.id')
        .where('servers.is_active', '=', 1)
        .where('monitor_hosts.server_id', 'is', null)
        .execute();
      for (let i = 0; i < missing.length; i += 40)
        await db
          .insertInto('monitor_hosts')
          .values(
            missing
              .slice(i, i + 40)
              .map(({ id }) => newHost(id, now + stagger(id, s.intervalSeconds))),
          )
          .onConflict((c) => c.column('server_id').doNothing())
          .execute();
      this.seedAt = now + 15000;
    }
    const due = await db
      .selectFrom('monitor_hosts')
      .innerJoin('servers', 'servers.id', 'monitor_hosts.server_id')
      .select('server_id')
      .where('servers.is_active', '=', 1)
      .where('monitor_hosts.enabled', '=', 1)
      .where('lease_until', '<=', now)
      .where('next_at', '<=', now)
      .orderBy('next_at')
      .limit(s.concurrency)
      .execute();
    await Promise.all(due.map(({ server_id }) => this.collect(server_id, false)));
  }
  private collect(id: string, manual: boolean) {
    const existing = this.pending.get(id);
    if (existing) return existing;
    const job = this.collectOnce(id, manual).finally(() => this.pending.delete(id));
    this.pending.set(id, job);
    return job;
  }
  private async collectOnce(id: string, manual: boolean) {
    const db = this.database.db;
    const claim = await db.transaction().execute(async (tx) => {
      await lock(tx);
      const s = await settings(tx);
      if (manual)
        await tx
          .insertInto('monitor_hosts')
          .values(newHost(id, 0))
          .onConflict((c) => c.column('server_id').doNothing())
          .execute();
      const host = await tx
        .selectFrom('monitor_hosts')
        .selectAll()
        .where('server_id', '=', id)
        .executeTakeFirstOrThrow();
      if (!s.enabled || !host.enabled) {
        if (manual) throw new ConflictException('资源监控已关闭');
        return;
      }
      const now = Date.now();
      if (host.lease && host.lease_until > now) return { waitingFor: host.lease };
      if (
        host.next_at > now &&
        (!manual ||
          host.failures ||
          (host.raw_json && now - (host.attempt_at ?? 0) < s.intervalSeconds * 1000))
      )
        return;
      const count = await tx
        .selectFrom('monitor_hosts')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('lease_until', '>', now)
        .executeTakeFirstOrThrow();
      if (Number(count.n) >= s.concurrency) {
        if (manual) throw new ConflictException('采集并发额度已满，请稍后刷新');
        return;
      }
      const lease = randomUUID();
      await tx
        .updateTable('monitor_hosts')
        .set({ lease, lease_until: now + leaseMs, attempt_at: now })
        .where('server_id', '=', id)
        .execute();
      return { lease, s, host };
    });
    if (!claim) return;
    if ('waitingFor' in claim) {
      if (!manual) return;
      const until = Date.now() + leaseMs;
      while (Date.now() < until && !this.shutdown.signal.aborted) {
        await delay(250);
        const host = await db
          .selectFrom('monitor_hosts')
          .select('lease')
          .where('server_id', '=', id)
          .executeTakeFirst();
        if (host?.lease !== claim.waitingFor) break;
      }
      return;
    }
    const { lease, s, host } = claim;
    let raw: LinuxSample | null = null,
      error: string | null = null;
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(15000)]);
    try {
      const target = await this.servers.get(id);
      let output = '',
        oversized = false;
      const result = await this.ssh.execute(target, linuxMonitorCommand, {
        signal,
        timeout: 12,
        onData(text, stream) {
          if (stream === 'stdout' && !oversized) {
            output += text;
            oversized = output.length > 512 * 1024;
          }
        },
      });
      if (result.exitCode !== 0 || oversized) throw new Error('Incomplete');
      raw = parseLinuxSample(output);
    } catch (err) {
      error =
        err instanceof SshHostKeyMismatchError
          ? 'SSH 主机指纹不匹配'
          : (err instanceof SshExecutionError && err.kind === 'TIMED_OUT') || signal.aborted
            ? 'SSH 资源采集超时或中断'
            : 'Linux 资源采集失败，请检查 SSH 和主机指标';
    }
    const at = Date.now();
    const rawJson = raw
      ? JSON.stringify({
          boot: raw.boot,
          uptime: raw.uptime,
          counters: raw.counters,
          net: raw.net,
        } satisfies LinuxCounters)
      : null;
    const metrics = raw
      ? linuxMetrics(
          raw,
          host.raw_json ? (JSON.parse(host.raw_json) as LinuxCounters) : null,
          s.intervalSeconds,
        )
      : null;
    const metricsJson = metrics ? JSON.stringify(metrics) : null;
    const failures = error ? Math.min(host.failures + 1, 10) : 0;
    await db.transaction().execute(async (tx) => {
      await lock(tx);
      const saved = await tx
        .updateTable('monitor_hosts')
        .set({
          lease: null,
          lease_until: 0,
          failures,
          error,
          raw_json: rawJson,
          next_at: at + s.intervalSeconds * 1000 * Math.min(16, 2 ** failures),
          ...(metrics && { sampled_at: at, metrics_json: metricsJson }),
        })
        .where('server_id', '=', id)
        .where('lease', '=', lease)
        .executeTakeFirst();
      if (saved.numUpdatedRows === 0n) {
        // A configuration change invalidates the result but reserves its SSH slot until completion.
        await tx
          .updateTable('monitor_hosts')
          .set({ lease: null, lease_until: 0 })
          .where('server_id', '=', id)
          .where('lease', '=', 'cancelled:' + lease)
          .execute();
      } else
        await tx
          .insertInto('monitor_samples')
          .values({
            id: randomUUID(),
            server_id: id,
            at,
            raw_json: rawJson,
            metrics_json: metricsJson,
          })
          .execute();
    });
  }
}
