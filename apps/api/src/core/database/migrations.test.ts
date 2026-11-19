import assert from 'node:assert/strict';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, Migrator, NO_MIGRATIONS, SqliteDialect, sql } from 'kysely';
import {
  createPostgresService,
  postgresTestUrl,
  withIsolatedPostgres,
} from '../../tests/helpers/isolated-postgres';
import { migrationProvider } from './migrations';
import { migrateSqlite } from './database.service';
import type { Database } from './schema';

const now = 1_800_000_000_000;
const artifactBytes = 3_000_000_000;

async function verifyUpgrade(db: Kysely<Database>, migrator: Migrator) {
  const initial = await migrator.migrateTo('001_initial');
  assert.ifError(initial.error);
  await db
    .insertInto('users')
    .values({
      id: 'existing-user',
      username: 'existing',
      role: 'ADMIN',
      password_hash: 'test-hash',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('projects')
    .values({
      id: 'project',
      name: 'Existing project',
      slug: 'existing',
      created_by: 'existing-user',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('services')
    .values({
      id: 'service',
      project_id: 'project',
      name: 'Existing service',
      slug: 'existing',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('artifacts')
    .values({
      id: 'artifact',
      project_id: 'project',
      service_id: 'service',
      artifact_type: 'FILE',
      storage_type: 'LOCAL_FILE',
      storage_key: 'historical.tar.gz',
      size_bytes: artifactBytes,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('command_templates')
    .values({
      id: 'existing-template',
      name: 'Existing command template',
      command_text: 'uname -a',
      created_by: 'existing-user',
      created_at: now,
    })
    .execute();

  await db
    .insertInto('servers')
    .values(
      ['one', 'two'].map((id) => ({
        id,
        name: id,
        host: `${id}.test`,
        username: 'ops',
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('environments')
    .values({
      id: 'env',
      project_id: 'project',
      name: 'Testing',
      slug: 'testing',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('deployment_targets')
    .values({
      id: 'legacy-target',
      name: 'Legacy release',
      strategy: 'SEQUENTIAL',
      max_parallel: 2,
      failure_policy: 'STOP',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('deployment_target_servers')
    .values([
      { target_id: 'legacy-target', server_id: 'one', sort_order: 1 },
      { target_id: 'legacy-target', server_id: 'two', sort_order: 0 },
    ])
    .execute();
  await db
    .insertInto('service_environment_configs')
    .values({
      id: 'legacy-config',
      service_id: 'service',
      environment_id: 'env',
      target_id: 'legacy-target',
      created_at: now,
      updated_at: now,
    })
    .execute();

  assert.ifError((await migrator.migrateTo('003_pipeline_webhooks')).error);
  await db
    .insertInto('pipelines')
    .values({
      id: 'ci',
      project_id: 'project',
      service_id: 'service',
      name: 'CI',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('pipeline_versions')
    .values({
      id: 'v1',
      pipeline_id: 'ci',
      version: 1,
      definition_json: '{}',
      created_by: 'existing-user',
      created_at: now,
    })
    .execute();
  await db
    .insertInto('tasks')
    .values({
      id: 'push',
      task_type: 'PIPELINE',
      payload_json: '{}',
      created_by: 'existing-user',
      status: 'SUCCESS',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('pipeline_runs')
    .values({
      id: 'run1',
      pipeline_id: 'ci',
      task_id: 'push',
      pipeline_version_id: 'v1',
      project_id: 'project',
      service_id: 'service',
      environment_id: 'env',
      target_id: 'legacy-target',
      git_ref: 'refs/heads/release/test',
      commit_sha: 'a'.repeat(40),
      build_location_snapshot: 'MANAGER',
      artifact_type_snapshot: 'FILE',
      trigger_type: 'WEBHOOK',
      created_at: now,
    })
    .execute();
  await db
    .insertInto('credentials')
    .values({
      id: 'key',
      name: 'hook',
      type: 'CUSTOM_SECRET',
      ciphertext: 'fixture',
      nonce: 'fixture',
      auth_tag: 'fixture',
      created_by: 'existing-user',
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('pipeline_webhooks')
    .values({
      pipeline_id: 'ci',
      pipeline_version: 1,
      environment_id: 'env',
      target_id: 'legacy-target',
      secret_credential_id: 'key',
      created_by: 'existing-user',
      branch: 'release/test',
      repository_key: 'https://example.test/ci',
      configuration_hash: 'fixture',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const upgrade = await migrator.migrateToLatest();
  assert.ifError(upgrade.error);
  assert.deepEqual(
    await db
      .selectFrom('pipeline_webhooks')
      .select(['follow_mode', 'confirmed_mode'])
      .executeTakeFirstOrThrow(),
    { follow_mode: 0, confirmed_mode: 'BUILD_ONLY' },
  );
  assert.deepEqual(
    await db
      .selectFrom('pipeline_trigger_history')
      .select(['task_id', 'branch', 'mode', 'status'])
      .executeTakeFirstOrThrow(),
    { task_id: 'push', branch: 'release/test', mode: 'BUILD_ONLY', status: 'QUEUED' },
  );
  const config = await db
    .selectFrom('service_environment_configs')
    .select(['target_id', 'target_selection_json'])
    .where('id', '=', 'legacy-config')
    .executeTakeFirstOrThrow();
  assert.equal(config.target_id, 'legacy-target');
  assert.deepEqual(JSON.parse(config.target_selection_json!), {
    serverIds: ['two', 'one'],
    groupIds: [],
    strategy: 'SEQUENTIAL',
    maxParallel: 2,
    failurePolicy: 'STOP',
  });
  assert.ok(
    upgrade.results?.some((migration) => migration.migrationName === '004_artifact_archives'),
  );
  assert.deepEqual(
    await db
      .selectFrom('users')
      .select(['role', 'password_hash', 'created_at', 'must_change_password'])
      .where('id', '=', 'existing-user')
      .executeTakeFirstOrThrow(),
    { role: 'ADMIN', password_hash: 'test-hash', created_at: now, must_change_password: 0 },
  );
  assert.deepEqual(
    await db
      .selectFrom('artifacts')
      .select(['archive_key', 'storage_key', 'size_bytes', 'compose_yaml', 'compose_checksum'])
      .where('id', '=', 'artifact')
      .executeTakeFirstOrThrow(),
    {
      archive_key: null,
      storage_key: 'historical.tar.gz',
      size_bytes: artifactBytes,
      compose_yaml: null,
      compose_checksum: null,
    },
  );
  assert.deepEqual(
    await db
      .selectFrom('command_template_versions')
      .select(['template_id', 'version', 'command_text', 'created_at'])
      .executeTakeFirstOrThrow(),
    {
      template_id: 'existing-template',
      version: 1,
      command_text: 'uname -a',
      created_at: now,
    },
  );
  await assert.rejects(
    db.updateTable('users').set({ must_change_password: 2 }).execute(),
    /check constraint/i,
  );

  const repeat = await migrator.migrateToLatest();
  assert.ifError(repeat.error);
  assert.deepEqual(repeat.results, []);
  await db
    .insertInto('tasks')
    .values(
      ['DEPLOY_ARTIFACT', 'DEPLOY'].map((mode) => ({
        id: mode,
        task_type: 'PIPELINE',
        payload_json: JSON.stringify({ pipeline: { mode } }),
        created_by: 'existing-user',
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('operation_schedules')
    .values({
      id: 'schedule',
      name: 'Existing template schedule',
      owner_id: 'existing-user',
      kind: 'COMMAND_TEMPLATE',
      source_id: 'existing-template',
      source_version: 1,
      config_json: '{}',
      approved_targets_json: '[]',
      status: 'ENABLED',
      created_at: now,
      updated_at: now,
    })
    .execute();
  const occurrence = {
    id: 'run',
    schedule_id: 'schedule',
    scheduled_at: now,
    triggered_at: now,
    status: 'SKIPPED',
    snapshot_json: '{}',
  };
  await db.insertInto('operation_schedule_runs').values(occurrence).execute();
  await assert.rejects(
    db
      .insertInto('operation_schedule_runs')
      .values({ ...occurrence, id: 'duplicate' })
      .execute(),
  );
  const event = {
    id: 'event',
    task_id: 'DEPLOY',
    project_id: 'project',
    stage: 'DEPLOY',
    level: 'NORMAL',
    status: 'SUCCESS',
    summary_json: '{}',
    created_at: now,
  };
  await db.insertInto('notification_events').values(event).execute();
  await assert.rejects(
    db
      .insertInto('notification_events')
      .values({ ...event, id: 'duplicate' })
      .execute(),
  );
  const rollback = await migrator.migrateTo('001_initial');
  assert.ifError(rollback.error);
  assert.deepEqual(await db.selectFrom('tasks').select(['id', 'status']).orderBy('id').execute(), [
    { id: 'DEPLOY', status: 'PENDING' },
    { id: 'DEPLOY_ARTIFACT', status: 'CANCELLED' },
    { id: 'push', status: 'SUCCESS' },
  ]);
  await assert.rejects(db.selectFrom('pipeline_webhooks').select('pipeline_id').execute());
  await assert.rejects(db.selectFrom('users').select('must_change_password').execute());
  await assert.rejects(db.selectFrom('artifacts').select('archive_key').execute());
  await assert.rejects(db.selectFrom('artifacts').select('compose_yaml').execute());
  await assert.rejects(db.selectFrom('command_template_versions').select('id').execute());
  await assert.rejects(db.selectFrom('operation_schedules').select('id').execute());
  await assert.rejects(db.selectFrom('notification_events').select('id').execute());
  assert.deepEqual(
    await db
      .selectFrom('artifacts')
      .select(['storage_key', 'size_bytes'])
      .executeTakeFirstOrThrow(),
    { storage_key: 'historical.tar.gz', size_bytes: artifactBytes },
  );

  const upgradeAgain = await migrator.migrateToLatest();
  assert.ifError(upgradeAgain.error);
  assert.equal(
    (await db.selectFrom('users').select('must_change_password').executeTakeFirstOrThrow())
      .must_change_password,
    0,
  );
  const removeAll = await migrator.migrateTo(NO_MIGRATIONS);
  assert.ifError(removeAll.error);
  await assert.rejects(db.selectFrom('users').select('id').execute());
}

test('SQLite migrations upgrade and downgrade a populated installation', async (t) => {
  const sqlite = new BetterSqlite3(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  t.after(() => db.destroy());
  await verifyUpgrade(db, new Migrator({ db, provider: migrationProvider }));
  assert.deepEqual((await sql`pragma foreign_key_check`.execute(db)).rows, []);
});

test('SQLite rolls back schema and migration bookkeeping after a partial failure', async (t) => {
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }),
  });
  t.after(() => db.destroy());
  await assert.rejects(
    migrateSqlite(db, {
      getMigrations: async () => ({
        broken: {
          async up(connection) {
            await connection.schema.createTable('partial_table').addColumn('id', 'text').execute();
            throw new Error('fixture migration failure');
          },
        },
      }),
    }),
    /fixture migration failure/,
  );
  assert.deepEqual(await db.introspection.getTables({ withInternalKyselyTables: true }), []);
  await migrateSqlite(db, migrationProvider);
  assert.ok((await db.introspection.getTables()).some((table) => table.name === 'artifacts'));
});

test(
  'PostgreSQL migrations isolate search paths and upgrade and downgrade existing rows',
  {
    skip: !postgresTestUrl,
  },
  async () => {
    await withIsolatedPostgres(postgresTestUrl!, async (existingUrl) => {
      const existing = createPostgresService(existingUrl);
      try {
        await existing.onModuleInit();
        await withIsolatedPostgres(postgresTestUrl!, async (connectionString, schema) => {
          const database = createPostgresService(connectionString);
          try {
            const migrator = new Migrator({
              db: database.db,
              provider: migrationProvider,
              migrationTableSchema: schema,
            });
            await verifyUpgrade(database.db, migrator);
            await database.onModuleInit();
            assert.deepEqual(await database.db.selectFrom('users').select('id').execute(), []);
            assert.equal(
              (await sql<{ name: string }>`select current_schema() as name`.execute(database.db))
                .rows[0].name,
              schema,
            );
          } finally {
            await database.onApplicationShutdown();
          }
        });
        assert.deepEqual(await existing.db.selectFrom('users').select('id').execute(), []);
      } finally {
        await existing.onApplicationShutdown();
      }
    });
  },
);
