import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseService } from '../core/database/database.service';
import { TaskHandlerRegistry } from '../modules/tasks/task-handler.registry';
import { TaskLogService } from '../modules/tasks/task-log.service';
import { TasksService } from '../modules/tasks/tasks.service';
import { TaskWorkerService, aggregateStatus } from '../modules/tasks/task-worker.service';
import { MultiTargetExecutor } from '../infrastructure/ssh/multi-target.executor';
import {
  fingerprintMatches,
  SshExecutionError,
  SshService,
  SshTarget,
} from '../infrastructure/ssh/ssh.service';
import { SecretRedactor } from '../infrastructure/ssh/secret-redactor';
import { TaskExecutionContext, TaskPayload, TaskStatus } from '../modules/tasks/tasks.types';
import { TasksController } from '../modules/tasks/tasks.controller';
import { AuditService } from '../modules/audit/audit.service';
import { lastValueFrom, toArray } from 'rxjs';
import { rmSync } from 'node:fs';

class MemoryLogs extends TaskLogService {
  lines = new Map<string, string>();
  override append(id: string, _key: string, text: string) {
    this.lines.set(id, (this.lines.get(id) ?? '') + text);
    return Buffer.byteLength(this.lines.get(id)!);
  }
}
const target = (id: string): SshTarget => ({
  id,
  name: `server-${id}`,
  host: '127.0.0.1',
  port: 22,
  username: 'ops',
  credentialId: null,
  hostKeyFingerprint: 'a'.repeat(64),
});
const payload = (targets: SshTarget[]): TaskPayload => ({
  targets,
  steps: [{ name: 'inspect', command: 'uname -a' }],
  strategy: 'PARALLEL',
  maxParallel: 3,
  failurePolicy: 'CONTINUE',
  timeout: 30,
});
function context() {
  const results = new Map<string, TaskStatus>();
  const controller = new AbortController();
  const ctx: TaskExecutionContext = {
    signal: controller.signal,
    log: () => undefined,
    startTarget: async (id) => id,
    finishTarget: async (id, status) => {
      results.set(id, status);
    },
    startStep: async (_id, serverId, _step, index) => `${serverId}:${index}`,
    finishStep: async () => undefined,
  };
  return { ctx, results, controller };
}
async function databaseFixture() {
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_PATH = ':memory:';
  const database = new DatabaseService();
  await database.onModuleInit();
  const now = Date.now();
  const userId = randomUUID();
  await database.db
    .insertInto('users')
    .values({
      id: userId,
      username: userId,
      password_hash: 'test-only',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const logs = new MemoryLogs();
  const tasks = new TasksService(database, logs);
  return { database, userId, logs, tasks };
}

test('SSH verifies SHA256 base64 and hex fingerprints and rejects changed host keys', () => {
  const key = Buffer.from('public-host-key');
  const digest = createHash('sha256').update(key).digest();
  assert.equal(
    fingerprintMatches(key, `SHA256:${digest.toString('base64').replace(/=+$/, '')}`),
    true,
  );
  assert.equal(fingerprintMatches(key, digest.toString('hex')), true);
  assert.equal(fingerprintMatches(Buffer.from('attacker-key'), digest.toString('hex')), false);
});
test('stream redaction hides secrets split across arbitrary output chunks', () => {
  const secret = 'sensitive-password-123';
  for (let split = 0; split <= secret.length; split++) {
    const redactor = new SecretRedactor([secret]);
    const result =
      redactor.write(`before ${secret.slice(0, split)}`) +
      redactor.write(`${secret.slice(split)} after`) +
      redactor.end();
    assert.equal(result, 'before [REDACTED] after');
  }
  const redactor = new SecretRedactor(['abca']);
  assert.equal(redactor.write('abca') + redactor.end(), '[REDACTED]');
});
test('executor limits target concurrency and preserves per-server failures', async () => {
  let running = 0;
  let peak = 0;
  const fake = {
    execute: async (server: SshTarget) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { exitCode: server.id === '2' ? 1 : 0 };
    },
  } as unknown as SshService;
  const executor = new MultiTargetExecutor(fake);
  const { ctx, results } = context();
  await executor.execute(
    {
      id: 'task',
      type: 'COMMAND',
      name: 'batch',
      payload: payload(['1', '2', '3', '4', '5'].map(target)),
    },
    ctx,
  );
  assert.equal(peak, 3);
  assert.equal(results.get('2'), 'FAILED');
  assert.equal(results.get('5'), 'SUCCESS');
  assert.equal(aggregateStatus([...results.values()], false), 'PARTIAL_FAILED');
});
test('sequential STOP policy does not execute the next server after failure', async () => {
  const called: string[] = [];
  const executor = new MultiTargetExecutor({
    execute: async (server: SshTarget) => {
      called.push(server.id);
      return { exitCode: 1 };
    },
  } as unknown as SshService);
  const { ctx } = context();
  await executor.execute(
    {
      id: 'task',
      type: 'COMMAND',
      name: 'stop',
      payload: {
        ...payload(['1', '2', '3'].map(target)),
        strategy: 'SEQUENTIAL',
        failurePolicy: 'STOP',
      },
    },
    ctx,
  );
  assert.deepEqual(called, ['1']);
});
test('timeout and cancellation are distinct per-target terminal states', async () => {
  const executor = new MultiTargetExecutor({
    execute: async () => {
      throw new SshExecutionError('timeout', 'TIMED_OUT');
    },
  } as unknown as SshService);
  const { ctx, results } = context();
  await executor.execute(
    { id: 'task', type: 'COMMAND', name: 'timeout', payload: payload([target('1')]) },
    ctx,
  );
  assert.equal(results.get('1'), 'TIMED_OUT');
  assert.equal(aggregateStatus([...results.values()], false), 'TIMED_OUT');
  const cancelled = context();
  cancelled.controller.abort();
  await executor.execute(
    { id: 'task', type: 'COMMAND', name: 'cancel', payload: payload([target('1')]) },
    cancelled.ctx,
  );
  assert.equal(cancelled.results.size, 0);
});
test('database queue claims a task only once and keeps connection snapshots immutable', async () => {
  const fixture = await databaseFixture();
  try {
    const { database, tasks, userId, logs } = fixture;
    const serverId = randomUUID();
    const now = Date.now();
    await database.db
      .insertInto('servers')
      .values({
        id: serverId,
        name: 'original',
        host: 'old.example',
        username: 'ops',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const task = await tasks.create(
      {
        type: 'COMMAND',
        name: 'snapshot',
        payload: payload([{ ...target(serverId), name: 'original', host: 'old.example' }]),
      },
      userId,
    );
    await database.db
      .updateTable('servers')
      .set({ host: 'new.example', name: 'changed' })
      .where('id', '=', serverId)
      .execute();
    const registry = new TaskHandlerRegistry();
    const workers = [
      new TaskWorkerService(database, tasks, registry, logs),
      new TaskWorkerService(database, tasks, registry, logs),
    ];
    const claims = await Promise.all(workers.map((worker) => worker.claim()));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal((await tasks.targets(task.id))[0]?.host, 'old.example');
    assert.equal((await tasks.targets(task.id))[0]?.serverName, 'original');
  } finally {
    await fixture.database.onModuleDestroy();
  }
});
test('expired leases require attention and never requeue uncertain writes', async () => {
  const fixture = await databaseFixture();
  try {
    const { database, tasks, userId, logs } = fixture;
    const serverId = randomUUID();
    const now = Date.now();
    await database.db
      .insertInto('servers')
      .values({
        id: serverId,
        name: 'server',
        host: 'host',
        username: 'ops',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const task = await tasks.create(
      { type: 'COMMAND', name: 'uncertain-write', payload: payload([target(serverId)]) },
      userId,
    );
    await database.db
      .updateTable('tasks')
      .set({ status: 'RUNNING', lease_owner: 'dead-worker', lease_expires_at: now - 1 })
      .where('id', '=', task.id)
      .execute();
    const worker = new TaskWorkerService(database, tasks, new TaskHandlerRegistry(), logs);
    await worker.recoverExpired();
    assert.equal((await tasks.get(task.id)).status, 'NEEDS_ATTENTION');
    assert.equal((await tasks.targets(task.id))[0]?.status, 'NEEDS_ATTENTION');
    assert.equal(await worker.claim(), undefined);
  } finally {
    await fixture.database.onModuleDestroy();
  }
});
test('pending cancellation atomically cancels all targets without running', async () => {
  const fixture = await databaseFixture();
  try {
    const { database, tasks, userId, logs } = fixture;
    const serverId = randomUUID();
    const now = Date.now();
    await database.db
      .insertInto('servers')
      .values({
        id: serverId,
        name: 'server',
        host: 'host',
        username: 'ops',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const task = await tasks.create(
      { type: 'COMMAND', name: 'pending', payload: payload([target(serverId)]) },
      userId,
    );
    assert.equal((await tasks.cancel(task.id)).status, 'CANCELLED');
    assert.equal((await tasks.targets(task.id))[0]?.status, 'CANCELLED');
    assert.equal(
      await new TaskWorkerService(database, tasks, new TaskHandlerRegistry(), logs).claim(),
      undefined,
    );
  } finally {
    await fixture.database.onModuleDestroy();
  }
});

test('SSE resumes from Last-Event-ID and completes its polling stream for finished tasks', async () => {
  let receivedOffset = 0;
  const controller = new TasksController(
    {
      get: async () => ({ status: 'SUCCESS' }),
      logs: async (_id: string, offset: number) => {
        receivedOffset = offset;
        return { content: '', nextOffset: offset };
      },
    } as unknown as TasksService,
    {} as AuditService,
  );
  const events = await lastValueFrom(controller.stream('task', '5', '89').pipe(toArray()));
  assert.equal(receivedOffset, 89);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.id, '89');
  assert.throws(() => controller.stream('task', 'NaN'), /offset/);
  assert.throws(() => controller.stream('task', '-1'), /offset/);
});

test('file logs reject traversal and preserve UTF-8 characters across read boundaries', () => {
  const logs = new TaskLogService();
  const id = randomUUID();
  const key = logs.key(id, Date.now());
  const content = `${'a'.repeat(256 * 1024 - 2)}你好吗🙂\n${'中'.repeat(1500)}`;
  try {
    assert.throws(() => logs.path('../outside.log'), /Invalid log path/);
    logs.append(id, key, content);
    let combined = '';
    let offset = 0;
    for (let count = 0; count < 10; count++) {
      const chunk = logs.read(key, offset);
      if (!chunk.content) break;
      assert.ok(chunk.nextOffset > offset);
      offset = chunk.nextOffset;
      combined += chunk.content;
    }
    assert.equal(combined, content);
    assert.equal(combined.includes('\ufffd'), false);
  } finally {
    rmSync(logs.path(key), { force: true });
  }
});

test('lease recovery fences late target and step completions from the old worker', async () => {
  const fixture = await databaseFixture();
  try {
    const { database, tasks, userId, logs } = fixture;
    const serverId = randomUUID();
    const now = Date.now();
    await database.db
      .insertInto('servers')
      .values({
        id: serverId,
        name: 'server',
        host: 'host',
        username: 'ops',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const task = await tasks.create(
      { type: 'COMMAND', name: 'fenced', payload: payload([target(serverId)]) },
      userId,
    );
    const worker = new TaskWorkerService(database, tasks, new TaskHandlerRegistry(), logs);
    const row = (await worker.claim())!;
    const ctx = tasks.context(row, new AbortController().signal);
    const targetId = await ctx.startTarget(serverId);
    const stepId = await ctx.startStep(targetId, serverId, { name: 'step', command: 'write' }, 0);
    await database.db
      .updateTable('tasks')
      .set({ lease_expires_at: now - 1 })
      .where('id', '=', task.id)
      .execute();
    await worker.recoverExpired();
    await ctx.finishStep(stepId, 'SUCCESS', 0);
    await ctx.finishTarget(targetId, 'SUCCESS', 0);
    assert.equal((await tasks.targets(task.id))[0]?.status, 'NEEDS_ATTENTION');
    assert.equal((await tasks.steps(task.id))[0]?.status, 'NEEDS_ATTENTION');
  } finally {
    await fixture.database.onModuleDestroy();
  }
});

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for task state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
test('registered handlers execute through the queue and persist target and parent results', async () => {
  const fixture = await databaseFixture();
  let worker: TaskWorkerService | undefined;
  try {
    const { database, tasks, userId, logs } = fixture;
    const serverId = randomUUID();
    const now = Date.now();
    await database.db
      .insertInto('servers')
      .values({
        id: serverId,
        name: 'server',
        host: 'host',
        username: 'ops',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const task = await tasks.create(
      { type: 'COMMAND', name: 'complete', payload: payload([target(serverId)]) },
      userId,
    );
    const registry = new TaskHandlerRegistry();
    const executor = new MultiTargetExecutor({
      execute: async () => ({ exitCode: 0 }),
    } as unknown as SshService);
    registry.register({
      type: 'COMMAND',
      execute: (task, context) => executor.execute(task, context),
    });
    worker = new TaskWorkerService(database, tasks, registry, logs);
    await worker.tick();
    await waitFor(async () => (await tasks.get(task.id)).status === 'SUCCESS');
    assert.equal((await tasks.targets(task.id))[0]?.status, 'SUCCESS');
    assert.equal((await tasks.steps(task.id))[0]?.status, 'SUCCESS');
    const row = await tasks.row(task.id);
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_expires_at, null);
    assert.equal(row.attempt_count, 1);
    assert.ok(row.log_size_bytes > 0);
  } finally {
    await worker?.onModuleDestroy();
    await fixture.database.onModuleDestroy();
  }
});
test('running cancellation signals the active handler and reaches CANCELLED', async () => {
  const fixture = await databaseFixture();
  let worker: TaskWorkerService | undefined;
  try {
    const { database, tasks, userId, logs } = fixture;
    const serverId = randomUUID();
    const now = Date.now();
    await database.db
      .insertInto('servers')
      .values({
        id: serverId,
        name: 'server',
        host: 'host',
        username: 'ops',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const task = await tasks.create(
      { type: 'COMMAND', name: 'cancel-running', payload: payload([target(serverId)]) },
      userId,
    );
    const registry = new TaskHandlerRegistry();
    registry.register({
      type: 'COMMAND',
      execute: async (_task, ctx) => {
        const targetId = await ctx.startTarget(serverId);
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        await ctx.finishTarget(targetId, 'CANCELLED', null, 'cancelled');
      },
    });
    worker = new TaskWorkerService(database, tasks, registry, logs);
    await worker.tick();
    await waitFor(async () => (await tasks.targets(task.id))[0]?.status === 'RUNNING');
    await tasks.cancel(task.id);
    await waitFor(async () => (await tasks.get(task.id)).status === 'CANCELLED');
    assert.equal((await tasks.targets(task.id))[0]?.status, 'CANCELLED');
  } finally {
    await worker?.onModuleDestroy();
    await fixture.database.onModuleDestroy();
  }
});
