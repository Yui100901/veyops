import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DatabaseService } from '../core/database/database.service';
import {
  SshExecutionError,
  type SshService,
  type SshOptions,
  type SshTarget,
} from '../infrastructure/ssh/ssh.service';
import { AuditService } from '../modules/audit/audit.service';
import {
  linuxMetrics,
  linuxMonitorCommand,
  parseLinuxSample,
} from '../modules/monitoring/linux-sample';
import { MonitoringService } from '../modules/monitoring/monitoring.service';
import type { ServersService } from '../modules/servers/servers.service';
import { createPostgresTestDatabase, postgresTestUrl } from './helpers/isolated-postgres';

function sample(i: number) {
  return `@boot
3d086e77-a8b2-4baa-b2b4-e4014957b63e
@uptime
${60 + i * 15} 800.21
@cpu
cpu ${50 + i * 4} 0 9 ${60 + i * 6} 4 0 0 1 1 0
@load
0.01 0.11 0.12 1/156 334
@memory
MemTotal: 2048 kB
MemAvailable: 500 kB
SwapTotal: 32 kB
SwapFree: 16 kB
@disk
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/root 512 128 384 25% /
/dev/data 1024 512 512 50% /data drive
@net
eth0: ${9907199254740993n + BigInt(i * 1500)} 1 2 3 4 5 6 7 ${200 + i * 150} 1 2 3 4 5 6 7
lo: 100 1 2 3 4 5 6 7 180 1 2 3 4 5 6 7
@index
eth0 2
lo 1`;
}
test('Linux sampling preserves cumulative counters and invalidates rate baselines independently', () => {
  const first = parseLinuxSample(sample(0)),
    next = parseLinuxSample(sample(1));
  const m = linuxMetrics(next, first, 15);
  assert.deepEqual(m.load, [0.01, 0.11, 0.12]);
  assert.equal(m.cpuPercent, 40);
  assert.equal(m.network[0]?.rxBytesPerSecond, 100);
  assert.equal(m.network[0]?.txBytesPerSecond, 10);
  assert.equal(m.memory.usedBytes, 1548 * 1024);
  assert.equal(m.memory.swapTotalBytes, 32768);
  assert.deepEqual(
    m.disks.map((d) => d.mount),
    ['/', '/data drive'],
  );
  assert.equal(linuxMetrics(next, null, 15).cpuPercent, null);
  assert.equal(
    linuxMetrics({ ...next, boot: randomUUID() }, first, 15).network[0]?.rxBytesPerSecond,
    null,
  );
  assert.equal(linuxMetrics({ ...next, uptime: 1000 }, first, 15).cpuPercent, null);
  next.counters[0] = '0';
  next.net[0]!.rxBytes = '0';
  assert.equal(linuxMetrics(next, first, 15).cpuPercent, null);
  assert.equal(linuxMetrics(next, first, 15).network[0]?.txBytesPerSecond, null);
  assert.equal(linuxMetrics(next, first, 15).network[1]?.txBytesPerSecond, 0);
  next.net[1]!.index = '3';
  assert.equal(linuxMetrics(next, first, 15).network[1]?.txBytesPerSecond, null);
  assert.throws(() => parseLinuxSample(''));
});

for (const dialect of ['sqlite', 'postgres'])
  test(
    `monitoring schedules, merges refreshes, bounds concurrency, resets switches and prunes on ${dialect}`,
    { skip: dialect === 'postgres' && !postgresTestUrl },
    async (t) => {
      let database: DatabaseService;
      if (dialect === 'postgres') database = await createPostgresTestDatabase(t);
      else {
        process.env.DATABASE_CLIENT = 'sqlite';
        process.env.DATABASE_PATH = ':memory:';
        database = new DatabaseService();
        await database.onModuleInit();
        t.after(() => database.onApplicationShutdown());
      }
      const db = database.db,
        userId = randomUUID(),
        a = randomUUID(),
        b = randomUUID();
      await db
        .insertInto('users')
        .values({
          id: userId,
          username: 'monitor',
          role: 'ADMIN',
          password_hash: 'unused',
          created_at: 0,
          updated_at: 0,
        })
        .execute();
      await db
        .insertInto('servers')
        .values(
          [a, b].map((id) => ({
            id,
            name: id,
            host: 'test',
            username: 'ops',
            created_at: 0,
            updated_at: 0,
          })),
        )
        .execute();
      const targets = { get: async (id: string) => ({ id }) } as unknown as ServersService;
      let runs = 0,
        fail = false;
      let block: Promise<void> | undefined,
        release: (() => void) | undefined,
        started: (() => void) | undefined;
      const ssh = {
        execute: async (target: SshTarget, cmd: string, opts: SshOptions) => {
          assert.equal(cmd, linuxMonitorCommand);
          started?.();
          await block;
          if (fail && target.id === a) throw new SshExecutionError('unit timeout', 'TIMED_OUT');
          opts.onData!(sample(runs++), 'stdout');
          return { exitCode: 0 };
        },
      } as unknown as SshService;
      const service = new MonitoringService(database, targets, ssh, new AuditService(database));
      const other = new MonitoringService(database, targets, ssh, new AuditService(database));
      const due = () => db.updateTable('monitor_hosts').set({ next_at: 0 }).execute();
      const count = async () =>
        (await db.selectFrom('monitor_samples').selectAll().execute()).length;
      await assert.rejects(service.refresh(a), /关闭/);
      await service.tick();
      assert.equal(runs, 0);
      await service.updateSettings({ enabled: true, intervalSeconds: 15, concurrency: 1 }, userId);
      const entered = new Promise<void>((r) => {
        started = r;
      });
      block = new Promise((r) => {
        release = r;
      });
      const first = service.refresh(a),
        duplicate = service.refresh(a);
      await entered;
      await assert.rejects(other.refresh(b), /并发/);
      const joined = other.refresh(a);
      release!();
      await Promise.all([first, duplicate, joined]);
      block = undefined;
      assert.equal(runs, 1);
      assert.equal(await count(), 1);
      assert.equal((await service.refresh(a)).metrics?.cpuPercent, null);
      assert.equal(runs, 1);
      await service.updateHost(b, { interfaceName: 'eth0' }, userId);
      await due();
      const fresh = await service.refresh(a);
      assert.equal(fresh.metrics?.network[0]?.rxBytesPerSecond, 100);
      fail = true;
      await due();
      const failed = await service.refresh(a);
      assert.equal(failed.status, 'FAILED');
      assert.equal(failed.sampledAt, fresh.sampledAt);
      assert.match(failed.error!, /超时/);
      const failures = await count();
      await service.refresh(a);
      assert.equal(await count(), failures);
      await service.tick();
      assert.equal((await service.detail(b, 1)).server.status, 'OK');
      fail = false;
      await due();
      const recovered = await service.refresh(a);
      assert.equal(recovered.status, 'OK');
      assert.equal(recovered.metrics?.cpuPercent, null);
      assert.ok((await service.detail(a, 24)).history.some((point) => point.metrics === null));
      const beforeDisable = await count();
      await due();
      const collecting = new Promise<void>((r) => {
        started = r;
      });
      block = new Promise((r) => {
        release = r;
      });
      const interrupted = service.refresh(a);
      await collecting;
      await service.updateHost(a, { enabled: false }, userId);
      await assert.rejects(service.refresh(a), /关闭/);
      await assert.rejects(other.refresh(b), /并发/);
      release!();
      await interrupted;
      block = undefined;
      assert.equal(await count(), beforeDisable);
      await service.updateHost(a, { enabled: true, interfaceName: 'eth0' }, userId);
      assert.equal((await service.refresh(a)).metrics?.cpuPercent, null);
      assert.ok((await service.trend(a, 1, 'memory')).series.at(-1)?.breakBefore);
      await service.updateSettings({ enabled: false, retentionDays: 1 }, userId);
      const historical = (await service.detail(a, 1)).server;
      assert.equal(historical.status, 'DISABLED');
      assert.ok(historical.metrics);
      await db.updateTable('monitor_samples').set({ at: 123 }).execute();
      await db.updateTable('monitor_hosts').set({ sampled_at: 123 }).execute();
      await service.tick();
      assert.equal(await count(), 0);
      assert.equal((await service.detail(a, 24)).server.metrics, null);
      await service.updateSettings({ enabled: true }, userId);
      assert.equal((await service.refresh(a)).metrics?.cpuPercent, null);
      assert.deepEqual((await service.list()).map((row) => row.serverId).sort(), [a, b].sort());
      assert.ok(
        (await db.selectFrom('servers').select('status').execute()).every(
          (row) => row.status === 'UNKNOWN',
        ),
      );
      // Share a timestamp across page boundaries to exercise stable at/id pagination.
      const timestamp = Date.now() - 5000;
      const metadata = linuxMetrics(parseLinuxSample(sample(1)), parseLinuxSample(sample(0)), 15);
      await db
        .insertInto('monitor_samples')
        .values(
          Array.from({ length: 130 }, (_, i) => ({
            id: randomUUID(),
            server_id: b,
            at: timestamp,
            raw_json: null,
            metrics_json: i === 64 ? null : JSON.stringify(metadata),
          })),
        )
        .execute();
      const trend = await service.trend(b, 24, 'rx', '/', 'eth0');
      const tied = trend.series.filter((point) => point.at === timestamp);
      assert.equal(tied.length, 130);
      assert.equal(tied.filter(({ value }) => value === 100).length, 129);
      assert.equal(tied.filter(({ value }) => value === null).length, 1);
      assert.ok(trend.mounts.includes('/data drive'));
      assert.ok(trend.interfaces.includes('lo'));
      assert.ok(
        (await service.trend(b, 24, 'disk', '/missing')).series.every(
          ({ value }) => value === null,
        ),
      );
    },
  );
