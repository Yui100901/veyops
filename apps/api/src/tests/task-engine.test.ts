import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { DatabaseService } from '../core/database/database.service';
import { TaskHandlerRegistry } from '../modules/tasks/task-handler.registry';
import { TaskLogService } from '../modules/tasks/task-log.service';
import { TasksService } from '../modules/tasks/tasks.service';
import { TaskWorkerService, aggregateStatus } from '../modules/tasks/task-worker.service';
import {
  SimplifiedFlowRunService,
  type SimplifiedRunPlan,
} from '../modules/execution-graphs/simplified-flow-run.service';
import {
  ensureGraphDeliveryEnvironment,
  ensureGraphUnscopedArtifactService,
} from '../modules/pipelines/delivery-execution-profile';
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
import { SystemSettingsService } from '../modules/system/system-settings.service';
import { canAdmitServerWork, nextServerWorkOrder } from '../modules/tasks/server-execution-queue';
import { lastValueFrom, toArray } from 'rxjs';
import { rmSync } from 'node:fs';
import {
  createPostgresService,
  postgresTestUrl,
  withIsolatedPostgres,
} from './helpers/isolated-postgres';

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
async function databaseFixture(provided?: DatabaseService) {
  if (!provided) {
    process.env.DATABASE_CLIENT = 'sqlite';
    process.env.DATABASE_PATH = ':memory:';
  }
  const database = provided ?? new DatabaseService();
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

test('standalone simplified actions enqueue without a service and still reject archived services', async (t) => {
  const { database, userId, tasks } = await databaseFixture();
  try {
    const projectId = randomUUID();
    const archivedServiceId = randomUUID();
    const now = Date.now();
    await database.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('projects')
        .values({
          id: projectId,
          name: 'Standalone build',
          slug: 'standalone-build',
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await ensureGraphDeliveryEnvironment(tx, projectId);
      await ensureGraphUnscopedArtifactService(tx, projectId);
      await tx
        .insertInto('services')
        .values({
          id: archivedServiceId,
          project_id: projectId,
          name: 'Archived service',
          slug: 'archived-service',
          archived_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
    });
    const module = await Test.createTestingModule({ providers: [SimplifiedFlowRunService] })
      .useMocker(() => ({}))
      .compile();
    t.after(() => module.close());
    const runService = module.get(SimplifiedFlowRunService);
    const run = {
      id: randomUUID(),
      project_id: projectId,
      flow_id: 'start',
      version: 1,
      created_by: userId,
      configuration_hash: 'fixture',
    };
    const node = { id: 'checkout', name: 'Checkout', type: 'CHECKOUT' } as const;
    const plan: SimplifiedRunPlan = {
      placement: { location: 'MANAGER', projectSlug: 'fixture' },
      sources: [],
      environment: { variables: {}, secretVariables: {}, variableSources: [] },
      finish: { saveWorkspace: true },
    };
    const action = (options: SimplifiedRunPlan) =>
      runService.task(run, { id: randomUUID(), node_id: node.id }, node, options, 'ACTION');
    const task = await tasks.create(action(plan), userId);
    assert.equal(task.status, 'PENDING');
    assert.equal(task.projectId, projectId);
    assert.equal(task.serviceId, null);
    await assert.rejects(
      tasks.create(action({ ...plan, serviceId: archivedServiceId }), userId),
      /任务引用的资源已变化/,
    );
  } finally {
    await database.onApplicationShutdown();
  }
});

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
  const overlapping = new SecretRedactor(['abca', 'abcamore']);
  assert.equal(
    overlapping.write('abca') + overlapping.write('more') + overlapping.end(),
    '[REDACTED]',
  );
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
    await fixture.database.onApplicationShutdown();
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
    await fixture.database.onApplicationShutdown();
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
    await fixture.database.onApplicationShutdown();
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
    await assert.rejects(
      () => ctx.startStep(targetId, serverId, { name: 'late', command: 'write' }, 1),
      /租约/,
    );
    await ctx.finishStep(stepId, 'SUCCESS', 0);
    await ctx.finishTarget(targetId, 'SUCCESS', 0);
    assert.equal((await tasks.targets(task.id))[0]?.status, 'NEEDS_ATTENTION');
    assert.equal((await tasks.steps(task.id))[0]?.status, 'NEEDS_ATTENTION');
    assert.equal((await tasks.steps(task.id)).length, 1);
  } finally {
    await fixture.database.onApplicationShutdown();
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
    await fixture.database.onApplicationShutdown();
  }
});
async function verifySharedSlots(provided?: DatabaseService) {
  const { database, userId, logs } = await databaseFixture(provided);
  const settings = new SystemSettingsService(database, new AuditService(database));
  const registry = new TaskHandlerRegistry();
  const tasks = new TasksService(database, logs, registry, settings);
  const worker = new TaskWorkerService(database, tasks, registry, logs, settings);
  const started = new Set<string>();
  let releaseNodes = () => {};
  let releaseCommand = () => {};
  const nodeGate = new Promise<void>((resolve) => {
    releaseNodes = resolve;
  });
  const commandGate = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  try {
    const serverId = randomUUID();
    const otherId = randomUUID();
    const graphId = randomUUID();
    const projectId = randomUUID();
    const now = Date.now();
    await settings.update({ maxConcurrentFlowsPerServer: 2 }, userId);
    await database.db
      .insertInto('servers')
      .values(
        [serverId, otherId].map((id) => ({
          id,
          name: id,
          host: 'host',
          username: 'ops',
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
    await database.db
      .insertInto('projects')
      .values({
        id: projectId,
        name: 'Queue',
        slug: 'queue',
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('execution_graphs')
      .values({
        id: graphId,
        project_id: projectId,
        revision: 1,
        draft_json: '{}',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('execution_graph_versions')
      .values({
        id: randomUUID(),
        graph_id: graphId,
        version: 1,
        source_revision: 1,
        definition_json: '{}',
        created_by: userId,
        created_at: now,
      })
      .execute();
    const putFlow = (id: string, status: 'RUNNING' | 'QUEUED') =>
      database.db.transaction().execute(async (tx) => {
        const queuedAt = await nextServerWorkOrder(tx, serverId);
        await tx
          .insertInto('execution_flow_runs')
          .values({
            id,
            graph_id: graphId,
            project_id: projectId,
            version: 1,
            flow_id: 'start',
            flow_name: 'Build',
            created_by: userId,
            idempotency_key: id,
            request_hash: id,
            configuration_hash: id,
            inputs_json: '{}',
            execution_server_id: serverId,
            created_at: queuedAt,
            status,
            execution_admitted_at: status === 'RUNNING' ? now : null,
          })
          .execute();
      });
    const runningFlow = randomUUID();
    const waitingFlow = randomUUID();
    await putFlow(runningFlow, 'RUNNING');
    const submit = (name: string, host = serverId, idempotencyKey?: string) =>
      tasks.create(
        { type: 'COMMAND', name, payload: payload([target(host)]), idempotencyKey },
        userId,
      );
    const left = await submit('left', serverId, 'execution-flow:' + randomUUID());
    const right = await submit('right', serverId, 'execution-flow:' + randomUUID());
    const first = await submit('first command');
    await putFlow(waitingFlow, 'QUEUED');
    const after = await submit('after waiting flow');
    const separate = await submit('independent server', otherId);
    registry.register({
      type: 'COMMAND',
      execute: async (task, ctx) => {
        const targetId = await ctx.startTarget(task.payload.targets[0]!.id);
        started.add(task.id);
        if (task.id === left.id || task.id === right.id) await nodeGate;
        if (task.id === first.id) await commandGate;
        await ctx.finishTarget(targetId, 'SUCCESS', 0);
      },
    });
    await worker.tick();
    await waitFor(async () =>
      [left.id, right.id, first.id, separate.id].every((id) => started.has(id)),
    );
    assert.equal((await tasks.get(after.id)).status, 'PENDING');
    releaseCommand();
    await waitFor(async () => (await tasks.get(first.id)).status === 'SUCCESS');
    await worker.tick();
    assert.equal((await tasks.get(after.id)).status, 'PENDING');
    await database.db.transaction().execute(async (tx) => {
      assert.equal(await canAdmitServerWork(tx, serverId, 'FLOW', waitingFlow, 2), true);
      await tx
        .updateTable('execution_flow_runs')
        .set({
          status: 'RUNNING',
          execution_admitted_at: Date.now(),
        })
        .where('id', '=', waitingFlow)
        .execute();
    });
    await worker.tick();
    assert.equal((await tasks.get(after.id)).status, 'PENDING');
    releaseNodes();
    await database.db
      .updateTable('execution_flow_runs')
      .set({ status: 'SUCCESS', finished_at: Date.now() })
      .where('id', '=', runningFlow)
      .execute();
    await worker.tick();
    await waitFor(async () => (await tasks.get(after.id)).status === 'SUCCESS');
  } finally {
    releaseNodes();
    releaseCommand();
    await worker.shutdown();
    await database.onApplicationShutdown();
  }
}
test('SQLite flows and command targets share FIFO server slots', () => verifySharedSlots());
test(
  'PostgreSQL flows and command targets share FIFO server slots',
  { skip: !postgresTestUrl },
  () =>
    withIsolatedPostgres(postgresTestUrl!, (url) => verifySharedSlots(createPostgresService(url))),
);
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
    await fixture.database.onApplicationShutdown();
  }
});

test('a thrown handler and unavailable log sink finalize active records before the completion hook', async () => {
  const { database, tasks, userId, logs } = await databaseFixture();
  const registry = new TaskHandlerRegistry();
  const worker = new TaskWorkerService(database, tasks, registry, logs);
  try {
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
      { type: 'COMMAND', name: 'failed-storage', payload: payload([target(serverId)]) },
      userId,
    );
    let observed: string[] | undefined;
    registry.register({
      type: 'COMMAND',
      execute: async (_record, context) => {
        const id = await context.startTarget(serverId);
        await context.startStep(id, serverId, { name: 'publish', command: '' }, 0);
        logs.append = () => {
          throw new Error('disk unavailable');
        };
        context.log('write to unavailable log sink');
      },
      afterCompletion: async (record) => {
        observed = [
          (await tasks.row(record.id)).status,
          (await tasks.targets(record.id))[0]!.status,
          (await tasks.steps(record.id))[0]!.status,
        ];
        throw new Error('analysis failed');
      },
    });
    await worker.tick();
    await waitFor(async () => Boolean(observed));
    assert.deepEqual(observed, ['NEEDS_ATTENTION', 'NEEDS_ATTENTION', 'NEEDS_ATTENTION']);
    const row = await tasks.row(task.id);
    assert.equal(row.lease_owner, null);
    assert.equal(row.lease_expires_at, null);
    assert.match(row.error_summary!, /日志存储失败/);
    assert.equal(await worker.claim(), undefined);
  } finally {
    await worker.shutdown();
    await database.onApplicationShutdown();
  }
});

test('shutdown waits for active execution before releasing SQLite ownership', async () => {
  const { database, tasks, userId, logs } = await databaseFixture();
  const registry = new TaskHandlerRegistry();
  const worker = new TaskWorkerService(database, tasks, registry, logs);
  try {
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
      { type: 'COMMAND', name: 'in-flight', payload: payload([target(serverId)]) },
      userId,
    );
    let receivedShutdown = false;
    registry.register({
      type: 'COMMAND',
      execute: async (_record, context) => {
        const id = await context.startTarget(serverId);
        const step = await context.startStep(id, serverId, { name: 'write', command: '' }, 0);
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        receivedShutdown = true;
        await context.finishStep(step, 'CANCELLED', null);
        await context.finishTarget(id, 'CANCELLED', null);
      },
    });
    await worker.tick();
    await waitFor(async () => (await tasks.steps(task.id))[0]?.status === 'RUNNING');
    await worker.shutdown();
    assert.equal(receivedShutdown, true);
    assert.equal((await tasks.row(task.id)).status, 'NEEDS_ATTENTION');
    assert.equal((await tasks.targets(task.id))[0]?.status, 'NEEDS_ATTENTION');
    assert.equal((await tasks.steps(task.id))[0]?.status, 'NEEDS_ATTENTION');
    assert.equal(
      await database.db
        .selectFrom('system_settings')
        .select('key')
        .where('key', '=', 'worker:sqlite-owner')
        .executeTakeFirst(),
      undefined,
    );
  } finally {
    await worker.shutdown();
    await database.onApplicationShutdown();
  }
});
