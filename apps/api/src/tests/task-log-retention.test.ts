import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import type { Insertable, Kysely } from 'kysely';
import type { Database, TasksTable } from '../core/database/schema';

// Set the fixture path before loading config or activating any database adapter.
const directory = mkdtempSync(join(tmpdir(), 'veyops-task-log-retention-'));
process.env.DATA_DIR = directory;
process.env.DATABASE_CLIENT = 'sqlite';
process.env.DATABASE_PATH = ':memory:';

const fixtures = Promise.all([
  import('../core/database/database.service.js'),
  import('../modules/tasks/task-log.service.js'),
  import('../modules/tasks/task-log-retention.js'),
  import('./helpers/isolated-postgres.js'),
]);

after(() => {
  assert.equal(resolve(tmpdir(), basename(directory)), resolve(directory));
  rmSync(directory, { recursive: true, force: true });
});

const day = 86_400_000;
const now = Date.UTC(2026, 10, 4);
const old = now - 2 * day;

async function user(database: Kysely<Database>) {
  const id = randomUUID();
  await database
    .insertInto('users')
    .values({ id, username: id, password_hash: 'fixture', created_at: now, updated_at: now })
    .execute();
  return id;
}

function task(
  creator: string,
  overrides: Partial<Insertable<TasksTable>> = {},
): Insertable<TasksTable> {
  return {
    id: randomUUID(),
    task_type: 'COMMAND',
    status: 'SUCCESS',
    payload_json: '{}',
    result_json: '{"fixture":true}',
    name: 'fixture',
    created_by: creator,
    created_at: old,
    updated_at: old,
    finished_at: old,
    log_size_bytes: 17,
    ...overrides,
  };
}

async function testRetention(database: Kysely<Database>) {
  const [, { TaskLogService }] = await fixtures;
  const logs = new TaskLogService();
  const creator = await user(database);
  const expired = task(creator);
  const boundary = task(creator, { finished_at: now - day });
  const active = task(creator, { status: 'RUNNING' });
  const missing = task(creator, { status: 'CANCELLED' });
  const unfinished = task(creator, { finished_at: null });
  const leased = task(creator, { lease_owner: randomUUID() });
  for (const row of [expired, boundary, active, missing, unfinished, leased])
    row.log_file_key = logs.key(row.id, old);
  const foreign = task(creator, { log_file_key: active.log_file_key });
  const artifact = task(creator, { log_file_key: 'artifacts/keep.log' });
  const escaped = task(creator, { created_at: Date.UTC(2020, 0, 1) });
  escaped.log_file_key = logs.key(escaped.id, Number(escaped.created_at));
  const artifactPath = join(directory, 'artifacts', 'keep.log');
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, 'artifact');
  const external = join(directory, 'other-files');
  mkdirSync(external);
  const escapedFile = join(external, `${escaped.id}.log`);
  writeFileSync(escapedFile, 'must stay');
  const linkedMonth = dirname(logs.path(String(escaped.log_file_key)));
  mkdirSync(dirname(linkedMonth), { recursive: true });
  symlinkSync(external, linkedMonth, 'junction');
  try {
    for (const row of [expired, boundary, active, unfinished, leased])
      logs.append(row.id, String(row.log_file_key), 'fixture log');
    const rows = [
      expired,
      boundary,
      active,
      missing,
      unfinished,
      leased,
      foreign,
      artifact,
      escaped,
    ];
    await database.insertInto('tasks').values(rows).execute();

    assert.deepEqual(await logs.pruneExpired(database, 0, now), {
      removed: 0,
      missing: 0,
      skipped: 0,
      failed: 0,
      more: false,
    });
    assert.equal(logs.read(String(expired.log_file_key)).content, 'fixture log');
    assert.deepEqual(await logs.pruneExpired(database, 1, now), {
      removed: 1,
      missing: 1,
      skipped: 3,
      failed: 0,
      more: false,
    });

    for (const row of [boundary, active, unfinished, leased])
      assert.equal(logs.read(String(row.log_file_key)).content, 'fixture log');
    assert.equal(readFileSync(artifactPath, 'utf8'), 'artifact');
    assert.equal(readFileSync(escapedFile, 'utf8'), 'must stay');
    assert.equal(existsSync(logs.path(String(expired.log_file_key))), false);
    assert.deepEqual(logs.read(String(expired.log_file_key), 11), { content: '', nextOffset: 11 });
    assert.deepEqual(logs.read(null, 11), { content: '', nextOffset: 11 });
    assert.equal(logs.tail(String(expired.log_file_key)), '');
    assert.deepEqual(await logs.pruneExpired(database, 1, now), {
      removed: 0,
      missing: 0,
      skipped: 3,
      failed: 0,
      more: false,
    });

    const saved = await database
      .selectFrom('tasks')
      .select(['id', 'status', 'result_json', 'log_size_bytes', 'log_file_key'])
      .execute();
    assert.equal(saved.length, rows.length);
    const finished = saved.find(({ id }) => id === expired.id);
    assert.deepEqual(finished, {
      id: expired.id,
      status: 'SUCCESS',
      result_json: '{"fixture":true}',
      log_size_bytes: 17,
      log_file_key: null,
    });
    assert.equal(saved.find(({ id }) => id === missing.id)?.log_file_key, null);
    assert.equal(saved.find(({ id }) => id === escaped.id)?.log_file_key, escaped.log_file_key);
  } finally {
    unlinkSync(linkedMonth);
    rmSync(external, { recursive: true, force: true });
  }
}

test('SQLite log retention only removes owned, expired, finished task logs', async () => {
  const [{ DatabaseService }] = await fixtures;
  const database = new DatabaseService();
  try {
    await database.onModuleInit();
    await testRetention(database.db);
  } finally {
    await database.onApplicationShutdown();
  }
});

test(
  'PostgreSQL log retention only removes owned, expired, finished task logs',
  {
    skip: !process.env.VEYOPS_TEST_POSTGRES_URL,
  },
  async () => {
    const [, , , { createPostgresService, postgresTestUrl, withIsolatedPostgres }] = await fixtures;
    assert.ok(postgresTestUrl);
    await withIsolatedPostgres(postgresTestUrl, async (connection) => {
      const database = createPostgresService(connection);
      try {
        await database.onModuleInit();
        await testRetention(database.db);
      } finally {
        await database.onApplicationShutdown();
      }
    });
  },
);

test('log retention continues the next batch past unsafe log rows', async () => {
  const [{ DatabaseService }, { TaskLogService }, { logRetentionBatchSize }] = await fixtures;
  const database = new DatabaseService();
  try {
    await database.onModuleInit();
    const creator = await user(database.db);
    const logs = new TaskLogService();
    const legitimate = task(creator, { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
    legitimate.log_file_key = logs.key(legitimate.id, old);
    logs.append(legitimate.id, legitimate.log_file_key, 'latest batch');
    const malformed = Array.from({ length: logRetentionBatchSize }, (_, index) =>
      task(creator, {
        id: `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`,
        log_file_key: legitimate.log_file_key,
      }),
    );
    await database.db
      .insertInto('tasks')
      .values([...malformed, legitimate])
      .execute();
    assert.deepEqual(await logs.pruneExpired(database.db, 1, now), {
      removed: 0,
      missing: 0,
      skipped: logRetentionBatchSize,
      failed: 0,
      more: true,
    });
    assert.equal(logs.read(legitimate.log_file_key).content, 'latest batch');
    assert.deepEqual(await logs.pruneExpired(database.db, 1, now), {
      removed: 1,
      missing: 0,
      skipped: 0,
      failed: 0,
      more: false,
    });
  } finally {
    await database.onApplicationShutdown();
  }
});

for (const client of ['SQLite', 'PostgreSQL']) {
  test(
    `${client} rechecks project log retention and inherits the system policy for unscoped history`,
    { skip: client === 'PostgreSQL' && !process.env.VEYOPS_TEST_POSTGRES_URL },
    async (t) => {
      const [{ DatabaseService }, { TaskLogService }, , { createPostgresTestDatabase }] =
        await fixtures;
      const database =
        client === 'PostgreSQL' ? await createPostgresTestDatabase(t) : new DatabaseService();
      if (client === 'SQLite') {
        t.after(() => database.onApplicationShutdown());
        await database.onModuleInit();
      }
      const { SystemSettingsService } =
        await import('../modules/system/system-settings.service.js');
      const { AuditService } = await import('../modules/audit/audit.service.js');
      const settings = new SystemSettingsService(database, new AuditService(database));
      const logs = new TaskLogService();
      const creator = await user(database.db);
      const projectId = randomUUID();
      await database.db
        .insertInto('projects')
        .values({
          id: projectId,
          slug: projectId,
          name: 'Project',
          created_by: creator,
          created_at: old,
          updated_at: old,
        })
        .execute();
      const projectTask = task(creator, { project_id: projectId });
      const unscoped = task(creator);
      for (const row of [projectTask, unscoped]) {
        row.log_file_key = logs.key(row.id, old);
        logs.append(row.id, row.log_file_key, 'saved');
        await database.db.insertInto('tasks').values(row).execute();
      }
      await settings.updateProject(projectId, { logRetentionDays: 1 }, creator);
      const previouslyExpired = await settings.logRetentionPolicies();
      await settings.updateProject(projectId, { logRetentionDays: 0 }, creator);
      const raced = await logs.pruneExpired(database.db, previouslyExpired, now, (tx) =>
        settings.logRetentionPolicies(tx),
      );
      assert.equal(raced.removed, 0);
      assert.equal(logs.read(projectTask.log_file_key!).content, 'saved');

      await settings.updateProject(projectId, { logRetentionDays: 1 }, creator);
      assert.equal(
        (await logs.pruneExpired(database.db, await settings.logRetentionPolicies(), now)).removed,
        1,
      );
      assert.equal(logs.read(projectTask.log_file_key!).content, '');
      assert.equal(logs.read(unscoped.log_file_key!).content, 'saved');

      const protectedTask = task(creator, { project_id: projectId });
      protectedTask.log_file_key = logs.key(protectedTask.id, old);
      await database.db.insertInto('tasks').values(protectedTask).execute();
      logs.append(protectedTask.id, protectedTask.log_file_key, 'retained');
      await settings.update({ logRetentionDays: 1 }, creator);
      await settings.updateProject(projectId, { logRetentionDays: 0 }, creator);
      assert.equal(
        (await logs.pruneExpired(database.db, await settings.logRetentionPolicies(), now)).removed,
        1,
      );
      assert.equal(logs.read(unscoped.log_file_key!).content, '');
      assert.equal(logs.read(protectedTask.log_file_key).content, 'retained');
    },
  );
}
