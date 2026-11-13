import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { initialMigration } from './migrations';
import type { Database } from './schema';

async function database(t: TestContext): Promise<Kysely<Database>> {
  const connection = new BetterSqlite3(':memory:');
  connection.pragma('foreign_keys = ON');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: connection }) });
  t.after(() => db.destroy());
  await initialMigration.up(db);
  return db;
}

async function user(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: 'user-1',
      username: 'admin',
      password_hash: 'not-a-real-password',
      created_at: 1_800_000_000_000,
      updated_at: 1_800_000_000_000,
    })
    .execute();
}

test('initial migration creates all 40 business tables and reverses cleanly', async (t) => {
  const db = await database(t);
  const result = await sql<{
    name: string;
  }>`select name from sqlite_master where type = 'table'`.execute(db);
  assert.equal(result.rows.length, 40);
  const violations = await sql`PRAGMA foreign_key_check`.execute(db);
  assert.deepEqual(violations.rows, []);
  await initialMigration.down!(db);
  const remaining = await sql`select name from sqlite_master where type = 'table'`.execute(db);
  assert.equal(remaining.rows.length, 0);
});

test('foreign keys retain server/task history while membership associations cascade', async (t) => {
  const db = await database(t);
  await user(db);
  await db
    .insertInto('servers')
    .values({
      id: 'server-1',
      name: 'Test',
      host: '127.0.0.1',
      username: 'ops',
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await db
    .insertInto('server_groups')
    .values({ id: 'group-1', name: 'Test group', created_at: 1 })
    .execute();
  await db
    .insertInto('server_group_members')
    .values({ group_id: 'group-1', server_id: 'server-1', created_at: 1 })
    .execute();
  await db.deleteFrom('server_groups').where('id', '=', 'group-1').execute();
  assert.equal((await db.selectFrom('server_group_members').selectAll().execute()).length, 0);
  await db
    .insertInto('tasks')
    .values({
      id: 'task-1',
      task_type: 'COMMAND',
      created_by: 'user-1',
      payload_json: '{}',
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await db
    .insertInto('task_targets')
    .values({
      id: 'target-1',
      task_id: 'task-1',
      server_id: 'server-1',
      server_name_snapshot: 'Test',
      host_snapshot: '127.0.0.1',
    })
    .execute();
  await assert.rejects(
    db.deleteFrom('servers').where('id', '=', 'server-1').execute(),
    /FOREIGN KEY/,
  );
  await assert.rejects(db.deleteFrom('tasks').where('id', '=', 'task-1').execute(), /FOREIGN KEY/);
  const task = await db
    .selectFrom('tasks')
    .selectAll()
    .where('id', '=', 'task-1')
    .executeTakeFirstOrThrow();
  assert.equal(task.status, 'PENDING');
  assert.equal(task.lease_owner, null);
  assert.equal(task.max_attempts, 1);
});

test('sensitive environment variables store either a value or a credential reference', async (t) => {
  const db = await database(t);
  await user(db);
  await db
    .insertInto('projects')
    .values({
      id: 'p',
      name: 'Project',
      slug: 'project',
      created_by: 'user-1',
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await db
    .insertInto('environments')
    .values({
      id: 'e',
      project_id: 'p',
      name: 'Production',
      slug: 'production',
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await db
    .insertInto('credentials')
    .values({
      id: 'c',
      name: 'Secret',
      type: 'CUSTOM_SECRET',
      ciphertext: 'cipher',
      nonce: 'nonce',
      auth_tag: 'tag',
      created_by: 'user-1',
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await db
    .insertInto('environment_variables')
    .values({ id: 'v1', environment_id: 'e', key: 'PORT', value_text: '3000' })
    .execute();
  await db
    .insertInto('environment_variables')
    .values({ id: 'v2', environment_id: 'e', key: 'PASSWORD', is_secret: 1, credential_id: 'c' })
    .execute();
  await assert.rejects(
    db
      .insertInto('environment_variables')
      .values({
        id: 'v3',
        environment_id: 'e',
        key: 'BAD',
        is_secret: 1,
        credential_id: 'c',
        value_text: 'plaintext',
      })
      .execute(),
    /CHECK/,
  );
  await assert.rejects(
    db
      .insertInto('environment_variables')
      .values({ id: 'v4', environment_id: 'e', key: 'MISSING' })
      .execute(),
    /CHECK/,
  );
  await assert.rejects(
    db
      .insertInto('environment_variables')
      .values({ id: 'v5', environment_id: 'e', key: 'PORT', value_text: '8080' })
      .execute(),
    /UNIQUE/,
  );
});

test('transactions roll back and version numbers are unique within a plan', async (t) => {
  const db = await database(t);
  await user(db);
  await assert.rejects(
    db.transaction().execute(async (trx) => {
      await trx
        .insertInto('operation_plans')
        .values({
          id: 'rollback',
          name: 'Do not save',
          created_by: 'user-1',
          created_at: 1,
          updated_at: 1,
        })
        .execute();
      throw new Error('rollback requested');
    }),
    /rollback requested/,
  );
  assert.equal((await db.selectFrom('operation_plans').selectAll().execute()).length, 0);
  await db
    .insertInto('operation_plans')
    .values({
      id: 'plan',
      name: 'Check server',
      created_by: 'user-1',
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await db
    .insertInto('operation_plan_versions')
    .values({
      id: 'version-1',
      plan_id: 'plan',
      version: 1,
      definition_json: '{}',
      created_by: 'user-1',
      created_at: 1,
    })
    .execute();
  await assert.rejects(
    db
      .insertInto('operation_plan_versions')
      .values({
        id: 'version-2',
        plan_id: 'plan',
        version: 1,
        definition_json: '{}',
        created_by: 'user-1',
        created_at: 1,
      })
      .execute(),
    /UNIQUE/,
  );
});

test('AI policy scopes cannot mismatch their project binding', async (t) => {
  const db = await database(t);
  await db
    .insertInto('ai_permission_policies')
    .values({
      id: 'system',
      scope_type: 'SYSTEM',
      scope_key: 'system',
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  await assert.rejects(
    db
      .insertInto('ai_permission_policies')
      .values({
        id: 'invalid',
        scope_type: 'PROJECT',
        scope_key: 'system',
        created_at: 1,
        updated_at: 1,
      })
      .execute(),
    /CHECK|UNIQUE/,
  );
});
