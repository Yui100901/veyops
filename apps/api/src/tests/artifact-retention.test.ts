import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { dataDirectory } from '../core/config';
import { DatabaseService } from '../core/database/database.service';
import { lockAvailableArtifacts } from '../modules/artifacts/artifact-availability';
import { ArtifactRetentionService } from '../modules/artifacts/artifact-retention.service';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { AuditService } from '../modules/audit/audit.service';
import { createPostgresTestDatabase, postgresTestUrl } from './helpers/isolated-postgres';

const now = Date.now();
const yesterday = now - 86_400_000;
const expired = now - 31 * 86_400_000;

async function sqlite(t: TestContext) {
  const previousClient = process.env.DATABASE_CLIENT;
  const previousPath = process.env.DATABASE_PATH;
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_PATH = ':memory:';
  let database: DatabaseService;
  try {
    database = new DatabaseService();
  } finally {
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT;
    else process.env.DATABASE_CLIENT = previousClient;
    if (previousPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousPath;
  }
  t.after(() => database.onApplicationShutdown());
  await database.onModuleInit();
  return database;
}

async function verifyRetention(t: TestContext, database: DatabaseService) {
  const db = database.db;
  const audit = new AuditService(database);
  const retention = new ArtifactRetentionService(database, audit);
  const ids = Object.fromEntries(
    ['user', 'project', 'service', 'env', 'target', 'server', 'pipeline', 'version'].map((key) => [
      key,
      randomUUID(),
    ]),
  ) as Record<
    'user' | 'project' | 'service' | 'env' | 'target' | 'server' | 'pipeline' | 'version',
    string
  >;
  const time = { created_at: now, updated_at: now };
  await db
    .insertInto('users')
    .values({
      id: ids.user,
      username: 'retention',
      password_hash: 'test',
      role: 'ADMIN',
      ...time,
    })
    .execute();
  await db
    .insertInto('projects')
    .values({
      id: ids.project,
      name: 'retention',
      slug: 'retention',
      created_by: ids.user,
      ...time,
    })
    .execute();
  await db
    .insertInto('services')
    .values({
      id: ids.service,
      project_id: ids.project,
      name: 'release',
      slug: 'release',
      ...time,
    })
    .execute();
  await db
    .insertInto('environments')
    .values({
      id: ids.env,
      project_id: ids.project,
      name: 'test',
      slug: 'test',
      ...time,
    })
    .execute();
  await db
    .insertInto('deployment_targets')
    .values({ id: ids.target, name: 'test', ...time })
    .execute();
  await db
    .insertInto('servers')
    .values({ id: ids.server, name: 'test', host: '127.0.0.1', username: 'ops', ...time })
    .execute();
  await db
    .insertInto('pipelines')
    .values({
      id: ids.pipeline,
      project_id: ids.project,
      service_id: ids.service,
      name: 'release',
      ...time,
    })
    .execute();
  await db
    .insertInto('pipeline_versions')
    .values({
      id: ids.version,
      pipeline_id: ids.pipeline,
      version: 1,
      definition_json: '{}',
      created_by: ids.user,
      created_at: now,
    })
    .execute();
  async function task(status: string, payload = {}) {
    const id = randomUUID();
    await db
      .insertInto('tasks')
      .values({
        id,
        task_type: 'PIPELINE',
        status,
        name: 'release',
        created_by: ids.user,
        payload_json: JSON.stringify(payload),
        ...time,
      })
      .execute();
    return id;
  }
  async function run(createdAt: number) {
    const taskId = await task('SUCCESS');
    const runId = randomUUID();
    const sha = 'a'.repeat(40);
    await db
      .insertInto('pipeline_runs')
      .values({
        id: runId,
        task_id: taskId,
        pipeline_id: ids.pipeline,
        pipeline_version_id: ids.version,
        project_id: ids.project,
        service_id: ids.service,
        environment_id: ids.env,
        target_id: ids.target,
        git_ref: sha,
        commit_sha: sha,
        build_location_snapshot: 'MANAGER',
        artifact_type_snapshot: 'FILE',
        created_at: createdAt,
      })
      .execute();
    return { runId, taskId };
  }
  const root = join(dataDirectory, 'artifacts');
  await mkdir(root, { recursive: true });
  async function archive(runId: string, createdAt: number, alias?: string) {
    const id = randomUUID();
    const file = alias ?? join(root, `${id}.tar.gz`);
    if (!alias) {
      t.after(() => rm(file, { force: true }));
      await writeFile(file, 'test data');
    }
    await db
      .insertInto('artifacts')
      .values({
        id,
        project_id: ids.project,
        service_id: ids.service,
        pipeline_run_id: runId,
        artifact_type: 'FILE',
        storage_type: 'LOCAL_FILE',
        storage_key: file,
        created_at: createdAt,
        size_bytes: 9,
      })
      .execute();
    return { id, file };
  }

  const currentRun = await run(expired);
  const current = await archive(currentRun.runId, expired);
  const targetId = randomUUID();
  await db
    .insertInto('task_targets')
    .values({
      id: targetId,
      task_id: currentRun.taskId,
      server_id: ids.server,
      server_name_snapshot: 'test',
      host_snapshot: '127.0.0.1',
    })
    .execute();
  await db
    .insertInto('deployment_records')
    .values({
      id: randomUUID(),
      pipeline_run_id: currentRun.runId,
      artifact_id: current.id,
      task_target_id: targetId,
      service_id: ids.service,
      environment_id: ids.env,
      server_id: ids.server,
      status: 'SUCCESS',
      health_status: 'HEALTHY',
      started_at: expired,
    })
    .execute();
  const immutableRun = await run(expired);
  const pending = await archive(immutableRun.runId, expired);
  await task('PENDING', { pipeline: { deploymentArtifacts: [{ id: pending.id }] } });
  const alias = await archive(immutableRun.runId, expired, current.file);
  const oldRun = await run(expired);
  const old = await archive(oldRun.runId, expired);
  const yesterdayRun = await run(yesterday);
  const exceeded = await archive(yesterdayRun.runId, yesterday);
  const newRun = await run(now);
  const recent = await archive(newRun.runId, now);
  const recentSibling = await archive(newRun.runId, now);

  const scope = { serviceId: ids.service, environmentId: ids.env };
  assert.deepEqual(await retention.settings(scope), {
    maxBuilds: 20,
    maxDays: 30,
    inherited: true,
  });
  assert.deepEqual(
    (await retention.preview(now)).candidates.flatMap((entry) => entry.artifactIds),
    [old.id],
  );
  await retention.configure({ maxBuilds: 1, maxDays: 365 }, ids.user, scope);
  const candidates = new Set(
    (await retention.preview(now)).candidates.flatMap((entry) => entry.artifactIds),
  );
  assert.deepEqual(candidates, new Set([old.id, exceeded.id]));

  // Pin and deployment references committed after preview must be re-read before deletion.
  await retention.pin(old.id, true, ids.user);
  const result = await retention.prune([old.id, exceeded.id, pending.id, alias.id], ids.user, now);
  assert.deepEqual(result, {
    pruned: [exceeded.id],
    failed: [],
    skipped: [old.id, pending.id, alias.id],
  });
  assert.equal(await readFile(old.file, 'utf8'), 'test data');
  await assert.rejects(readFile(exceeded.file), /ENOENT/);
  for (const item of [current, pending, recent, recentSibling])
    assert.equal(await readFile(item.file, 'utf8'), 'test data');
  await assert.rejects(
    db.transaction().execute((tx) => lockAvailableArtifacts(tx, [exceeded.id])),
    /归档已清理/,
  );
  const artifacts = new ArtifactsService(database);
  const pruned = (await artifacts.list(ids.project)).find((row) => row.id === exceeded.id);
  assert.equal(pruned?.prunedAt, now);
  assert.equal(pruned.downloadAvailable, false);
  await assert.rejects(artifacts.download(exceeded.id), /可下载的归档/);
  assert.equal(
    (await audit.list()).some((event) => event.action === 'artifact.retention.prune'),
    true,
  );
  assert.equal((await retention.configure(null, ids.user, scope)).inherited, true);

  const delayed = await archive(oldRun.runId, expired);
  await rm(delayed.file);
  await mkdir(delayed.file);
  try {
    assert.deepEqual(await retention.prune([delayed.id], ids.user, now), {
      pruned: [],
      failed: [delayed.id],
      skipped: [],
    });
  } finally {
    await rmdir(delayed.file);
  }
  await writeFile(delayed.file, 'test data');
  await retention.pruneExpired();
  await assert.rejects(readFile(delayed.file), /ENOENT/);
  const removed = await db
    .selectFrom('artifacts')
    .select('archive_deleted_at')
    .where('id', '=', delayed.id)
    .executeTakeFirstOrThrow();
  assert.ok(removed.archive_deleted_at);
}

test('artifact retention protects current, pending and pinned archives on SQLite', async (t) => {
  await verifyRetention(t, await sqlite(t));
});

test(
  'artifact retention protects current, pending and pinned archives on PostgreSQL',
  { skip: !postgresTestUrl },
  async (t) => {
    await verifyRetention(t, await createPostgresTestDatabase(t));
  },
);
