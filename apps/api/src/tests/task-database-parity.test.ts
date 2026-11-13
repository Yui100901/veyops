import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { DatabaseService } from '../core/database/database.service';
import { TaskHandlerRegistry } from '../modules/tasks/task-handler.registry';
import { TaskLogService } from '../modules/tasks/task-log.service';
import { TaskWorkerService } from '../modules/tasks/task-worker.service';
import { TasksService } from '../modules/tasks/tasks.service';
import type { CreateTaskInput } from '../modules/tasks/tasks.types';
import {
  createPostgresService,
  postgresTestUrl,
  withIsolatedPostgres,
} from './helpers/isolated-postgres';

type Dialect = 'sqlite' | 'postgres';

class MemoryTaskLogs extends TaskLogService {
  override append(_taskId: string, _key: string, content: string) {
    return Buffer.byteLength(content);
  }
}

async function withDatabases(
  dialect: Dialect,
  run: (primary: DatabaseService, peer: DatabaseService) => Promise<void>,
) {
  if (dialect === 'postgres') {
    assert.ok(postgresTestUrl);
    await withIsolatedPostgres(postgresTestUrl, async (connectionString) => {
      const primary = createPostgresService(connectionString);
      // Separate pools exercise real row-lock contention and database-based cancellation.
      const peer = createPostgresService(connectionString);
      try {
        await primary.onModuleInit();
        await peer.onModuleInit();
        await run(primary, peer);
      } finally {
        await Promise.all([peer.onApplicationShutdown(), primary.onApplicationShutdown()]);
      }
    });
    return;
  }

  const previousClient = process.env.DATABASE_CLIENT;
  const previousPath = process.env.DATABASE_PATH;
  let database: DatabaseService;
  try {
    process.env.DATABASE_CLIENT = 'sqlite';
    process.env.DATABASE_PATH = ':memory:';
    database = new DatabaseService();
  } finally {
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT;
    else process.env.DATABASE_CLIENT = previousClient;
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
  }
  try {
    await database.onModuleInit();
    await run(database, database);
  } finally {
    await database.onApplicationShutdown();
  }
}

async function setup(database: DatabaseService) {
  const userId = randomUUID();
  const serverId = randomUUID();
  const now = Date.now();
  await database.db
    .insertInto('users')
    .values({
      id: userId,
      username: userId,
      password_hash: 'fixture-only',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database.db
    .insertInto('servers')
    .values({
      id: serverId,
      name: 'fixture',
      host: '127.0.0.1',
      username: 'fixture',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const input: CreateTaskInput = {
    name: 'database parity fixture',
    type: 'COMMAND',
    payload: {
      targets: [
        {
          id: serverId,
          name: 'fixture',
          host: '127.0.0.1',
          port: 22,
          username: 'fixture',
          credentialId: null,
          hostKeyFingerprint: null,
        },
      ],
      steps: [{ name: 'fixture', command: '' }],
      strategy: 'SEQUENTIAL',
      maxParallel: 1,
      failurePolicy: 'CONTINUE',
      timeout: 30,
    },
  };
  return { userId, serverId, input };
}

async function waitFor(check: () => Promise<boolean>, message: string) {
  const end = Date.now() + 5_000;
  while (!(await check())) {
    assert.ok(Date.now() < end, message);
    await delay(20);
  }
}

for (const dialect of ['sqlite', 'postgres'] as const) {
  const options = {
    skip:
      dialect === 'postgres' && !postgresTestUrl ? 'Set VEYOPS_TEST_POSTGRES_URL to enable' : false,
  };
  test(
    `${dialect}: concurrent submissions and claims keep one owner and fence expired execution`,
    options,
    async () => {
      await withDatabases(dialect, async (database, peer) => {
        const { userId, serverId, input } = await setup(database);
        const logs = new MemoryTaskLogs();
        const tasks = new TasksService(database, logs);
        const peerTasks = new TasksService(peer, logs);
        const workers = [
          new TaskWorkerService(database, tasks, new TaskHandlerRegistry(), logs),
          new TaskWorkerService(peer, peerTasks, new TaskHandlerRegistry(), logs),
        ];
        const idempotencyKey = randomUUID();
        const submissions = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            (i % 2 ? tasks : peerTasks).create({ ...input, idempotencyKey }, userId),
          ),
        );
        const taskId = submissions[0]!.id;
        assert.deepEqual(new Set(submissions.map(({ id }) => id)), new Set([taskId]));
        assert.equal((await tasks.targets(taskId)).length, 1);

        // A higher priority task that is not yet available must not take the lease.
        const future = await tasks.create(input, userId);
        await database.db
          .updateTable('tasks')
          .set({ priority: 100, available_at: Date.now() + 3_600_000 })
          .where('id', '=', future.id)
          .execute();
        const claims = (await Promise.all(workers.map((worker) => worker.claim()))).filter(
          (row) => row !== undefined,
        );
        assert.equal(claims.length, 1);
        const [claimed] = claims;
        assert.equal(claimed!.id, taskId);
        assert.equal(claimed!.attempt_count, 1);
        assert.ok(Number.isSafeInteger(claimed!.lease_expires_at));
        assert.ok(Number.isSafeInteger(claimed!.heartbeat_at));
        assert.ok(Number.isSafeInteger(claimed!.created_at));
        const stale = tasks.context(claimed!, new AbortController().signal);
        const targetId = await stale.startTarget(serverId);
        const stepId = await stale.startStep(targetId, serverId, input.payload.steps[0]!, 0);
        await peer.db
          .updateTable('tasks')
          .set({ lease_expires_at: Date.now() - 1 })
          .where('id', '=', taskId)
          .execute();

        // Expiry prevents new records even before recovery changes the task state.
        await assert.rejects(
          () => stale.startStep(targetId, serverId, { name: 'late', command: '' }, 1),
          /租约/,
        );
        await stale.finishStep(stepId, 'SUCCESS', 0);
        assert.equal((await tasks.steps(taskId))[0]?.status, 'RUNNING');

        await Promise.all(workers.map((worker) => worker.recoverExpired()));
        await stale.finishTarget(targetId, 'SUCCESS', 0);
        const final = await tasks.row(taskId);
        assert.equal(final.status, 'NEEDS_ATTENTION');
        assert.equal(final.lease_owner, null);
        assert.equal(final.lease_expires_at, null);
        assert.equal(final.attempt_count, 1);
        assert.equal((await tasks.targets(taskId))[0]?.status, 'NEEDS_ATTENTION');
        assert.equal((await tasks.steps(taskId))[0]?.status, 'NEEDS_ATTENTION');
        assert.equal((await tasks.row(future.id)).status, 'PENDING');
        assert.equal(await workers[0]!.claim(), undefined);
      });
    },
  );

  test(
    `${dialect}: rollback preserves execution rows when lease recovery cannot commit`,
    options,
    async () => {
      await withDatabases(dialect, async (database, peer) => {
        const { userId, serverId, input } = await setup(database);
        const logs = new MemoryTaskLogs();
        const tasks = new TasksService(database, logs);
        const worker = new TaskWorkerService(database, tasks, new TaskHandlerRegistry(), logs);
        const task = await tasks.create(input, userId);
        const claimed = await worker.claim();
        assert.ok(claimed);
        const execution = tasks.context(claimed, new AbortController().signal);
        const target = await execution.startTarget(serverId);
        await execution.startStep(target, serverId, input.payload.steps[0]!, 0);
        await peer.db
          .updateTable('tasks')
          .set({ lease_expires_at: Date.now() - 1 })
          .where('id', '=', task.id)
          .execute();

        const installFailure =
          dialect === 'sqlite'
            ? sql`CREATE TRIGGER recovery_fixture BEFORE UPDATE ON task_steps
            WHEN NEW.status = 'NEEDS_ATTENTION'
            BEGIN SELECT RAISE(ABORT, 'recovery_fixture'); END`
            : sql`ALTER TABLE task_steps ADD CONSTRAINT recovery_fixture CHECK (status <> 'NEEDS_ATTENTION')`;
        const removeFailure =
          dialect === 'sqlite'
            ? sql`DROP TRIGGER recovery_fixture`
            : sql`ALTER TABLE task_steps DROP CONSTRAINT recovery_fixture`;
        await installFailure.execute(database.db);
        try {
          await assert.rejects(() => worker.recoverExpired(), /recovery_fixture/);
          assert.equal((await tasks.row(task.id)).status, 'RUNNING');
          assert.equal((await tasks.targets(task.id))[0]?.status, 'RUNNING');
          assert.equal((await tasks.steps(task.id))[0]?.status, 'RUNNING');
        } finally {
          await removeFailure.execute(database.db);
        }
        await worker.recoverExpired();
        assert.equal((await tasks.row(task.id)).status, 'NEEDS_ATTENTION');
        assert.equal((await tasks.targets(task.id))[0]?.status, 'NEEDS_ATTENTION');
        assert.equal((await tasks.steps(task.id))[0]?.status, 'NEEDS_ATTENTION');
      });
    },
  );

  test(
    `${dialect}: database heartbeat propagates cancellation from another service instance`,
    options,
    async () => {
      await withDatabases(dialect, async (database, peer) => {
        const { userId, serverId, input } = await setup(database);
        const logs = new MemoryTaskLogs();
        const tasks = new TasksService(database, logs);
        const peerTasks = new TasksService(peer, logs);
        const handlers = new TaskHandlerRegistry();
        handlers.register({
          type: 'COMMAND',
          execute: async (_record, context) => {
            const target = await context.startTarget(serverId);
            const step = await context.startStep(target, serverId, input.payload.steps[0]!, 0);
            await new Promise<void>((resolve) => {
              if (context.signal.aborted) resolve();
              else context.signal.addEventListener('abort', () => resolve(), { once: true });
            });
            await context.finishStep(step, 'CANCELLED', null);
            await context.finishTarget(target, 'CANCELLED', null);
          },
        });
        const worker = new TaskWorkerService(database, tasks, handlers, logs);
        try {
          const task = await tasks.create(input, userId);
          await worker.tick();
          await waitFor(
            async () => (await tasks.steps(task.id))[0]?.status === 'RUNNING',
            'task did not start',
          );
          const cancelled = await peerTasks.cancel(task.id);
          assert.ok(['CANCEL_REQUESTED', 'CANCELLED'].includes(cancelled.status));
          await waitFor(
            async () => (await peerTasks.row(task.id)).status === 'CANCELLED',
            'cancellation did not reach the worker heartbeat',
          );
          const final = await peerTasks.row(task.id);
          assert.ok(Number.isSafeInteger(final.finished_at));
          assert.equal(final.lease_owner, null);
          assert.equal((await peerTasks.targets(task.id))[0]?.status, 'CANCELLED');
          assert.equal((await peerTasks.steps(task.id))[0]?.status, 'CANCELLED');
        } finally {
          await worker.shutdown();
        }
      });
    },
  );
}
