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

  const upgrade = await migrator.migrateToLatest();
  assert.ifError(upgrade.error);
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
  const rollback = await migrator.migrateTo('001_initial');
  assert.ifError(rollback.error);
  assert.deepEqual(await db.selectFrom('tasks').select(['id', 'status']).orderBy('id').execute(), [
    { id: 'DEPLOY', status: 'PENDING' },
    { id: 'DEPLOY_ARTIFACT', status: 'CANCELLED' },
  ]);
  await assert.rejects(db.selectFrom('pipeline_webhooks').select('pipeline_id').execute());
  await assert.rejects(db.selectFrom('users').select('must_change_password').execute());
  await assert.rejects(db.selectFrom('artifacts').select('archive_key').execute());
  await assert.rejects(db.selectFrom('artifacts').select('compose_yaml').execute());
  await assert.rejects(db.selectFrom('command_template_versions').select('id').execute());
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
