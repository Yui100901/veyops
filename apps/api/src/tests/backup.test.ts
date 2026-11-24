import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import { createBackup, restoreBackup, type BackupSettings } from '../core/database/backup';
import { DatabaseService } from '../core/database/database.service';
import { initialGraphDraft } from '../core/database/execution-graphs-migration';
import { AuditService } from '../modules/audit/audit.service';
import { CredentialsService } from '../modules/credentials/credentials.service';
import { ExecutionGraphsService } from '../modules/execution-graphs/execution-graphs.service';
import { GraphRunnerService } from '../modules/execution-graphs/graph-runner.service';
import { GraphTriggersService } from '../modules/execution-graphs/graph-triggers.service';
import type { GraphDefinition } from '../modules/execution-graphs/execution-graph-definition';
import { PipelinesService } from '../modules/pipelines/pipelines.service';
import { RepositoryMetadataService } from '../modules/projects/repository-metadata.service';
import { TaskHandlerRegistry } from '../modules/tasks/task-handler.registry';
import {
  createPostgresService,
  postgresTestUrl,
  withIsolatedPostgres,
} from './helpers/isolated-postgres';

const sampleUser = 'test-admin';
const sampleTask = 'test-task';
const graphProject = 'backup-project';
const historicalLog = 'first version completed';
const taskLog = 'logs/2026/11/test-task.log';
const artifact = 'artifacts/test-task.tar.gz';
const config = 'config/operator.json';
const secret = { apiKey: 'synthetic-credential-for-backup-test' };
const sampleContents = {
  [taskLog]: Buffer.from('构建完成\n'),
  [artifact]: Buffer.from([0, 1, 2, 255]),
  [config]: Buffer.from('{"sample":true}'),
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'veyops-backup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(root, 'target');
  const backup = join(root, 'backup');
  const key = randomBytes(32);
  for (const directory of ['artifacts', 'logs/2026/11', 'config'])
    await mkdir(join(source, directory), { recursive: true });
  for (const [path, bytes] of Object.entries(sampleContents))
    await writeFile(join(source, path), bytes);
  await writeFile(join(source, 'config/encryption.key'), key.toString('hex'));
  await writeFile(join(source, 'artifacts/incomplete.partial'), 'uncommitted');
  return { root, source, target, backup, key };
}

function sqlite(path: string) {
  const previous = { client: process.env.DATABASE_CLIENT, path: process.env.DATABASE_PATH };
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_PATH = path;
  try {
    return new DatabaseService();
  } finally {
    if (previous.client === undefined) delete process.env.DATABASE_CLIENT;
    else process.env.DATABASE_CLIENT = previous.client;
    if (previous.path === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous.path;
  }
}

function credentials(database: DatabaseService, key: Buffer) {
  const previous = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = key.toString('hex');
  try {
    return new CredentialsService(database, new AuditService(database));
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
  }
}

async function withGraphServices(
  database: DatabaseService,
  work: (graphs: ExecutionGraphsService, runner: GraphRunnerService) => Promise<void>,
) {
  const module = await Test.createTestingModule({
    providers: [
      ExecutionGraphsService,
      GraphRunnerService,
      GraphTriggersService,
      TaskHandlerRegistry,
      AuditService,
      { provide: DatabaseService, useValue: { db: database.db } },
      { provide: CredentialsService, useValue: {} },
      { provide: RepositoryMetadataService, useValue: {} },
      // This fixture uses only local log nodes; a delivery task must never be submitted.
      { provide: PipelinesService, useValue: {} },
    ],
  }).compile();
  try {
    await work(module.get(ExecutionGraphsService), module.get(GraphRunnerService));
  } finally {
    await module.close();
  }
}

async function seed(database: DatabaseService, key: Buffer) {
  await database.onModuleInit();
  await database.db
    .insertInto('users')
    .values({
      id: sampleUser,
      username: sampleUser,
      password_hash: 'fixture',
      role: 'ADMIN',
      created_at: 1,
      updated_at: 1,
    })
    .execute();
  const credential = await credentials(database, key).create(
    { name: 'Backup fixture', type: 'API_KEY', secret },
    sampleUser,
  );
  await database.db
    .insertInto('tasks')
    .values({
      id: sampleTask,
      task_type: 'COMMAND',
      status: 'SUCCESS',
      created_by: sampleUser,
      payload_json: '{}',
      log_file_key: taskLog,
      created_at: 2,
      updated_at: 2,
    })
    .execute();
  await database.db
    .insertInto('projects')
    .values({
      id: graphProject,
      name: 'Backup project',
      slug: 'backup-project',
      created_by: sampleUser,
      created_at: 2,
      updated_at: 2,
    })
    .execute();
  await database.db
    .insertInto('execution_graphs')
    .values({
      id: graphProject,
      project_id: graphProject,
      revision: 1,
      draft_json: initialGraphDraft,
      created_at: 2,
      updated_at: 2,
    })
    .execute();
  await withGraphServices(database, async (graphs, runner) => {
    const draft: GraphDefinition = JSON.parse(initialGraphDraft);
    const flow = draft.flows[0];
    const report = { id: 'report', type: 'LOG' as const, name: '验收日志', message: historicalLog };
    flow.nodes.splice(1, 0, report);
    flow.edges = [
      { from: 'start', to: report.id },
      { from: report.id, to: 'end' },
    ];
    let saved = await graphs.save(
      graphProject,
      { expectedRevision: 1, definition: draft },
      sampleUser,
    );
    await graphs.publish(graphProject, saved.revision, sampleUser);
    const preview = await runner.preview(graphProject, flow.id, { version: 1 });
    await runner.run(
      graphProject,
      flow.id,
      {
        version: 1,
        expectedConfigurationHash: preview.configurationHash,
        idempotencyKey: 'backup-check',
      },
      sampleUser,
    );
    report.message = 'second version';
    saved = await graphs.save(
      graphProject,
      { expectedRevision: saved.revision, definition: draft },
      sampleUser,
    );
    await graphs.publish(graphProject, saved.revision, sampleUser);
  });
  return credential.id;
}

async function verify(
  database: DatabaseService,
  key: Buffer,
  target: string,
  credentialId: string,
) {
  try {
    await database.onModuleInit();
    const task = await database.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', sampleTask)
      .executeTakeFirstOrThrow();
    assert.equal(task.status, 'SUCCESS');
    assert.equal(task.log_file_key, taskLog);
    await withGraphServices(database, async (graphs, runner) => {
      assert.equal((await graphs.get(graphProject)).publishedVersion, 2);
      assert.equal(
        (await graphs.version(graphProject, 2)).definition.flows[0].nodes[1].message,
        'second version',
      );
      const runs = await runner.list(graphProject);
      assert.equal(runs.length, 1);
      const restored = await runner.get(graphProject, runs[0].id);
      assert.equal(restored.version, 1);
      assert.equal(restored.status, 'SUCCESS');
      assert.equal(restored.definition.nodes[1].message, historicalLog);
      assert.deepEqual(
        restored.nodes.map((node) => node.nodeId),
        ['start', 'report', 'end'],
      );
      assert.equal(restored.nodes[1].log, historicalLog);
    });
    assert.deepEqual(await credentials(database, key).decrypt(credentialId), secret);
    for (const [path, expected] of Object.entries(sampleContents)) {
      const restored = await readFile(join(target, path));
      assert.equal(
        createHash('sha256').update(restored).digest('hex'),
        createHash('sha256').update(expected).digest('hex'),
      );
    }
  } finally {
    await database.onApplicationShutdown();
  }
}

test('SQLite backup restores committed WAL data, encrypted credentials, task history and managed files', async (t) => {
  const { root, source, target, backup, key } = await fixture(t);
  const sourceDb = join(source, 'database/app.db');
  const targetDb = join(root, 'external/restore.db');
  const sourceSettings: BackupSettings = {
    dataDir: source,
    key,
    database: { client: 'sqlite', path: sourceDb },
  };
  const targetSettings: BackupSettings = {
    dataDir: target,
    key,
    database: { client: 'sqlite', path: targetDb },
  };
  const database = sqlite(sourceDb);
  let credentialId: string;
  try {
    credentialId = await seed(database, key);
    assert.ok((await stat(`${sourceDb}-wal`)).size > 0);
    const manifest = await createBackup(sourceSettings, backup);
    assert.deepEqual(
      manifest.files.map(({ path }) => path).sort(),
      [artifact, config, 'database.sqlite', taskLog].sort(),
    );
    await assert.rejects(createBackup(sourceSettings, backup), /already exists/);
  } finally {
    await database.onApplicationShutdown();
  }

  await assert.rejects(
    restoreBackup({ ...targetSettings, key: randomBytes(32) }, backup),
    /authentication failed/,
  );
  await writeFile(join(backup, artifact), 'damaged');
  await assert.rejects(restoreBackup(targetSettings, backup), /checksum failed/);
  await assert.rejects(stat(targetDb), { code: 'ENOENT' });
  await assert.rejects(stat(join(target, taskLog)), { code: 'ENOENT' });
  await writeFile(join(backup, artifact), sampleContents[artifact]);
  await mkdir(join(target, 'logs'), { recursive: true });
  await restoreBackup(targetSettings, backup);
  await assert.rejects(restoreBackup(targetSettings, backup), /unused SQLite database path/);
  await assert.rejects(stat(join(target, 'config/encryption.key')), { code: 'ENOENT' });
  await verify(sqlite(targetDb), key, target, credentialId);
});

test(
  'PostgreSQL backup restores only the VeyOps schema and preserves encrypted credentials and managed files',
  {
    skip: !postgresTestUrl && 'VEYOPS_TEST_POSTGRES_URL and PostgreSQL client tools are required',
  },
  async (t) => {
    const { source, target, backup, key } = await fixture(t);
    await withIsolatedPostgres(postgresTestUrl!, async (url, schema) => {
      const sourceSettings: BackupSettings = {
        dataDir: source,
        key,
        database: { client: 'postgres', url },
      };
      const targetSettings: BackupSettings = { ...sourceSettings, dataDir: target };
      const database = createPostgresService(url);
      let credentialId: string;
      try {
        credentialId = await seed(database, key);
      } finally {
        await database.onApplicationShutdown();
      }
      const manifest = await createBackup(sourceSettings, backup);
      assert.deepEqual(manifest.database, { client: 'postgres', schema });
      await assert.rejects(restoreBackup(targetSettings, backup), /empty PostgreSQL schema/);
      const reset = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, max: 1 });
      try {
        await reset.query(`DROP SCHEMA "${schema}" CASCADE`);
        await reset.query(`CREATE SCHEMA "${schema}"`);
      } finally {
        await reset.end();
      }
      await restoreBackup(targetSettings, backup);
      await verify(createPostgresService(url), key, target, credentialId);
    });
  },
);
