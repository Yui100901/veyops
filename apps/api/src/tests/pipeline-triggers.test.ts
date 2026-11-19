import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
const postgresTestUrl = process.env.VEYOPS_TEST_POSTGRES_URL;
let directory: string;
const originalDirectory = process.env.DATA_DIR;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'veyops-trigger-'));
  process.env.DATA_DIR = directory;
});
after(async () => {
  if (originalDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDirectory;
  await rm(directory, { recursive: true, force: true });
});

async function verify(databaseUrl?: string) {
  const temp = 'fixture-trigger-initial',
    password = 'fixture-trigger-changed';
  const config = {
    DATABASE_PATH: join(directory, 'triggers.db'),
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    DATABASE_URL: databaseUrl,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    WORKER_ENABLED: 'false',
    ADMIN_PASSWORD: temp,
    WEBHOOK_BUILD_DOCKER_SOCKET: '/run/user/1000/fixture.sock',
  };
  const previous = Object.fromEntries(Object.keys(config).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { PipelineTriggersService } =
    await import('../modules/pipeline-triggers/pipeline-triggers.service.js');
  const { RepositoryMetadataService } =
    await import('../modules/projects/repository-metadata.service.js');
  const { PipelinesService } = await import('../modules/pipelines/pipelines.service.js');
  const { AuditService } = await import('../modules/audit/audit.service.js');
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = m.createNestApplication<NestExpressApplication>({ logger: false, rawBody: true });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const base = '/api/v1';
    async function create(path: string, body: object) {
      const res = await api.post(base + path).send(body);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data;
    }
    const owner = await create('/auth/login', { username: 'root', password: temp });
    await api
      .post(base + '/auth/change-password')
      .send({ currentPassword: temp, newPassword: password })
      .expect(200);
    await create('/auth/login', { username: 'root', password });
    const project = await create('/projects', { name: 'Triggers', slug: 'triggers' });
    const scope = '/projects/' + project.id;
    const service = await create(scope + '/services', { name: 'Web', slug: 'web' });
    const environment = await create(scope + '/environments', {
      name: 'Test',
      slug: 'test',
      environmentType: 'TESTING',
    });
    const url = 'https://fixture.invalid/team/repo.git';
    const repo = await create(scope + '/repositories', { name: 'Repository', cloneUrl: url });
    const secret = 'trigger-test-only-32-byte-secret-for-gitea';
    const credential = await create('/credentials', {
      name: 'hook',
      type: 'CUSTOM_SECRET',
      secret: { value: secret },
    });
    const ssh = await create('/credentials', {
      name: 'ssh',
      type: 'SSH_PASSWORD',
      secret: { password: 'fixture' },
    });
    const server = await create('/servers', {
      name: 'Isolated fixture',
      host: 'fixture.invalid',
      username: 'ci',
      credentialId: ssh.id,
      hostKeyFingerprint: 'a'.repeat(64),
    });
    const serviceConfig = '/services/' + service.id + '/environments/' + environment.id + '/config';
    const config = {
      serverIds: [server.id],
      buildLocation: 'MANAGER',
      deployPath: '/tmp/fixture-trigger',
    };
    await api
      .put(base + serviceConfig)
      .send(config)
      .expect(200);
    const definition = {
      repositoryId: repo.id,
      defaultMode: 'BUILD_ONLY',
      artifactType: 'FILE',
      buildLocation: 'MANAGER',
      buildCommand: 'echo fixture',
      deployPath: '/tmp/fixture-trigger',
    };
    const pipe = await create('/pipelines', {
      name: 'CI',
      projectId: project.id,
      serviceId: service.id,
      definition,
    });
    const path = '/pipelines/' + pipe.id + '/triggers';
    const input = {
      version: 1,
      kind: 'POLL',
      branch: 'trunk',
      environmentId: environment.id,
      timing: { type: 'INTERVAL', intervalSeconds: 600, timeZone: 'UTC' },
    };
    let sha = '1'.repeat(40),
      unavailable = false;
    const metadata = app.get(RepositoryMetadataService);
    let onRead: (() => Promise<void>) | undefined;
    metadata.branchHeads = async (projectId, repositoryId, branches, expected) => {
      assert.equal(projectId, project.id);
      assert.equal(repositoryId, repo.id);
      assert.equal(expected.clone_url, url);
      assert.deepEqual(branches, ['trunk']);
      await onRead?.();
      if (unavailable) throw new Error('unavailable');
      return new Map([['trunk', sha]]);
    };
    const db = app.get(DatabaseService).db;
    const triggers = app.get(PipelineTriggersService);
    const peer = new PipelineTriggersService(
      app.get(DatabaseService),
      app.get(PipelinesService),
      metadata,
      app.get(AuditService),
    );
    const rule = async (id: string) =>
      db.selectFrom('pipeline_triggers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const history = async (id: string) =>
      db
        .selectFrom('pipeline_trigger_history')
        .selectAll()
        .where('trigger_id', '=', id)
        .orderBy('scheduled_at', 'desc')
        .execute();
    const save = async (body: typeof input & { buildCurrent?: boolean; groupIds?: string[] }) => {
      const preview = await create(path + '/preview', body);
      const saved = await create(path, {
        ...body,
        expectedConfigurationHash: preview.configurationHash,
      });
      assert.equal(saved.mode, preview.mode);
      return saved;
    };
    const due = async (id: string, delay = 0) => {
      const at = (await rule(id)).next_at!;
      await Promise.all([triggers.tick(at + delay), peer.tick(at + delay)]);
    };
    const poll = await save(input);
    await due(poll.id);
    assert.equal((await rule(poll.id)).baseline_sha, sha);
    assert.equal((await history(poll.id))[0].status, 'SKIPPED');
    unavailable = true;
    await due(poll.id);
    const failed = await rule(poll.id);
    assert.equal(failed.failures, 1);
    assert.equal(failed.baseline_sha, sha);
    assert.equal((await history(poll.id))[0].status, 'FAILED');
    assert.ok(failed.next_at! - (await history(poll.id))[0].scheduled_at! >= 1_200_000);
    unavailable = false;
    sha = '2'.repeat(40);
    const hook = {
      branch: input.branch,
      environmentId: environment.id,
      enabled: true,
      followMode: true,
      secretCredentialId: credential.id,
    };
    const webhookPath = '/pipelines/' + pipe.id + '/webhook';
    const hookPreview = await create(webhookPath + '/preview', hook);
    await api
      .put(base + webhookPath)
      .send({ ...hook, expectedBindingHash: hookPreview.bindingHash })
      .expect(200);
    const raw = JSON.stringify({
      ref: 'refs/heads/trunk',
      after: sha,
      repository: { clone_url: url },
    });
    const delivery = (expectedStatus = 200) =>
      api
        .post(base + '/webhooks/gitea/' + pipe.id)
        .set('Content-Type', 'application/json')
        .set('X-Gitea-Event', 'push')
        .set('X-Gitea-Signature', createHmac('sha256', secret).update(raw).digest('hex'))
        .send(raw)
        .expect(expectedStatus);
    const [hookResponse] = await Promise.all([delivery(), due(poll.id)]);
    assert.equal((await history(poll.id)).length, 3);
    const taskId = hookResponse.body.data.taskId;
    assert.equal((await history(poll.id))[0].task_id, taskId);
    assert.equal((await rule(poll.id)).baseline_sha, sha);
    assert.equal((await rule(poll.id)).failures, 0);
    assert.equal((await delivery()).body.data.taskId, taskId);
    const cross = await triggers.history(pipe.id);
    assert.deepEqual(
      cross
        .filter((e) => e.task_id === taskId)
        .map((e) => e.status)
        .sort(),
      ['DUPLICATE', 'DUPLICATE', 'QUEUED'],
    );
    // Inheriting the environment must not turn its current member list into an explicit override.
    const replacement = await create('/server-groups', {
      name: 'New environment group',
      serverIds: [server.id],
    });
    await api
      .put(base + serviceConfig)
      .send({ ...config, serverIds: [], groupIds: [replacement.id] })
      .expect(200);
    await delivery(409);
    await api
      .put(base + serviceConfig)
      .send(config)
      .expect(200);
    await api
      .patch(base + '/pipelines/' + pipe.id)
      .send({ name: 'CI v2', definition: { ...definition, buildCommand: 'echo changed' } })
      .expect(200);
    sha = '3'.repeat(40);
    await due(poll.id);
    const pinned = (await history(poll.id))[0];
    assert.equal(pinned.version, 1);
    assert.equal(pinned.commit_sha, sha);
    assert.equal(pinned.mode, 'BUILD_ONLY');
    assert.equal(pinned.status, 'QUEUED');
    const task = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', pinned.task_id!)
      .executeTakeFirstOrThrow();
    assert.equal(JSON.parse(task.payload_json).pipeline.definition.buildCommand, 'echo fixture');

    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve)),
      release = new Promise<void>((resolve) => (resume = resolve));
    onRead = async () => {
      enter();
      await release;
    };
    sha = '4'.repeat(40);
    const racing = due(poll.id);
    await entered;
    await create(path + '/' + poll.id + '/disable', {});
    resume();
    await racing;
    onRead = undefined;
    assert.equal((await history(poll.id))[0].commit_sha, '3'.repeat(40));

    const schedule = await save({ ...input, kind: 'SCHEDULE' });
    await due(schedule.id);
    await due(schedule.id);
    const runs = await history(schedule.id);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].task_id, runs[1].task_id);
    assert.ok(
      runs.every((r) => r.commit_sha === sha && r.mode === 'BUILD_ONLY' && r.status === 'QUEUED'),
    );
    await due(schedule.id, 30_000);
    assert.equal((await history(schedule.id))[0].status, 'SKIPPED');
    assert.equal((await history(schedule.id))[0].task_id, null);

    await api
      .put(base + serviceConfig)
      .send({ ...config, executionMode: 'DEPLOY' })
      .expect(200);
    await due(schedule.id);
    assert.equal((await rule(schedule.id)).status, 'PAUSED');
    for (const kind of ['POLL', 'SCHEDULE']) {
      const deploying = await save({ ...input, kind, buildCurrent: true });
      assert.equal(deploying.mode, 'DEPLOY');
      await due(deploying.id);
      const event = (await history(deploying.id))[0];
      assert.equal(event.mode, 'DEPLOY');
      assert.equal(event.status, 'QUEUED');
      const row = await db
        .selectFrom('tasks')
        .select('payload_json')
        .where('id', '=', event.task_id!)
        .executeTakeFirstOrThrow();
      assert.equal(JSON.parse(row.payload_json).pipeline.deployAfterBuild, true);
      await create(path + '/' + deploying.id + '/disable', {});
    }
    const group = await create('/server-groups', { name: 'Release group', serverIds: [server.id] });
    const grouped = await save({ ...input, groupIds: [group.id], buildCurrent: true });
    assert.deepEqual(grouped.target.groupIds, [group.id]);
    const member = await create('/servers', {
      name: 'New member',
      host: 'new.fixture.invalid',
      username: 'ci',
      credentialId: ssh.id,
      hostKeyFingerprint: 'b'.repeat(64),
    });
    await api
      .patch(base + '/server-groups/' + group.id)
      .send({ name: 'Release group', serverIds: [server.id, member.id] })
      .expect(200);
    await due(grouped.id);
    assert.equal((await rule(grouped.id)).status, 'PAUSED');
    assert.equal((await history(grouped.id))[0].task_id, null);
    const revoked = await save(input);
    await db.updateTable('users').set({ role: 'VIEWER' }).where('id', '=', owner.id).execute();
    await due(revoked.id);
    assert.equal((await rule(revoked.id)).status, 'PAUSED');
    assert.equal((await history(revoked.id))[0].status, 'FAILED');
  } finally {
    await app.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
test('SQLite scheduled/poll rules compete, recover, pin versions and converge with signed push', () =>
  verify());
test(
  'PostgreSQL scheduled/poll rules compete, recover, pin versions and converge with signed push',
  { skip: !postgresTestUrl },
  async () => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgresTestUrl!, verify);
  },
);
