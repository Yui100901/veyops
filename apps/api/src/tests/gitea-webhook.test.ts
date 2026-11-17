import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

test('Gitea signed push builds the pinned version once and keeps the build result independent of AI', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-webhook-'));
  const initialPassword = 'fixture-webhook-admin-password';
  const newPassword = 'fixture-webhook-admin-changed';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_PASSWORD = initialPassword;
  process.env.WEBHOOK_BUILD_DOCKER_SOCKET = '/run/user/1000/veyops-test.sock';
  process.env.AI_PIPELINE_ANALYSIS = 'true';
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { BuildsService, BuildCommandError } = await import('../modules/builds/builds.service.js');
  const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const { TasksService } = await import('../modules/tasks/tasks.service.js');
  const { PipelinesService } = await import('../modules/pipelines/pipelines.service.js');
  const builds: string[] = [];
  const archive = Buffer.from('archive fixture\n');
  const checksum = createHash('sha256').update(archive).digest('hex');
  const artifactDirectory = join(directory, 'artifacts');
  await mkdir(artifactDirectory);
  let sshCalls = 0;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BuildsService)
    .useValue({
      resolveVariables: async () => ({ values: {}, secrets: [] }),
      errorKind: () => 'FAILED',
      manager: async ({
        taskId,
        snapshot,
      }: {
        taskId: string;
        snapshot: { commitSha: string; mode: string };
      }) => {
        builds.push(snapshot.commitSha);
        assert.equal(snapshot.mode, 'BUILD_ONLY');
        if (snapshot.commitSha === 'c'.repeat(40))
          throw new BuildCommandError(2, 'fixture-build-details');
        const localArchive = join(artifactDirectory, `${taskId}.tar.gz`);
        await writeFile(localArchive, archive);
        return { localArchive, checksum, sizeBytes: archive.length, cleanup: async () => {} };
      },
    })
    .overrideProvider(SshService)
    .useValue({
      execute: async () => {
        sshCalls++;
        throw new Error('自动构建不应连接部署主机');
      },
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
    rawBody: true,
  });
  configureApp(app);
  const modelInputs: Array<Record<string, unknown>> = [];
  let modelOffline = false;
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
    modelInputs.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (modelOffline) {
      res.writeHead(503).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: '构建完成。',
                failedPhase: null,
                nextActions: ['核对产物校验和'],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const anonymous = request(app.getHttpServer());
    const initial = await api
      .post('/api/v1/auth/login')
      .send({ username: 'root', password: initialPassword })
      .expect(201);
    const userId = initial.body.data.id as string;
    await api
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: initialPassword, newPassword })
      .expect(200);
    await api
      .post('/api/v1/auth/login')
      .send({ username: 'root', password: newPassword })
      .expect(201);
    const address = model.address();
    assert.ok(address && typeof address !== 'string');
    await api
      .post('/api/v1/ai/providers')
      .send({
        name: 'Build model',
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: 'fixture-model',
        apiKey: 'fixture-model-key',
      })
      .expect(201);

    const secret = 'fixture-webhook-secret-with-32-bytes';
    const short = await api
      .post('/api/v1/credentials')
      .send({ name: 'short', type: 'CUSTOM_SECRET', secret: { value: 'short' } })
      .expect(201);
    const hookCredential = await api
      .post('/api/v1/credentials')
      .send({ name: 'hook', type: 'CUSTOM_SECRET', secret: { value: secret } })
      .expect(201);
    const sshCredential = await api
      .post('/api/v1/credentials')
      .send({ name: 'ssh', type: 'SSH_PASSWORD', secret: { password: 'fixture-ssh-only' } })
      .expect(201);
    const server = await api
      .post('/api/v1/servers')
      .send({
        name: 'build target',
        host: '127.0.0.1',
        username: 'ops',
        credentialId: sshCredential.body.data.id,
        hostKeyFingerprint: 'f'.repeat(64),
      })
      .expect(201);
    const target = await api
      .post('/api/v1/deployment-targets')
      .send({ name: 'target', serverIds: [server.body.data.id] })
      .expect(201);
    const project = await api
      .post('/api/v1/projects')
      .send({ name: 'Project', slug: 'webhook-test' })
      .expect(201);
    const projectId = project.body.data.id as string;
    const repoUrl = 'https://gitea.example.test/team/app.git';
    const repo = await api
      .post(`/api/v1/projects/${projectId}/repositories`)
      .send({ name: 'Main', cloneUrl: repoUrl })
      .expect(201);
    const service = await api
      .post(`/api/v1/projects/${projectId}/services`)
      .send({ name: 'Web', slug: 'web' })
      .expect(201);
    const environment = await api
      .post(`/api/v1/projects/${projectId}/environments`)
      .send({ name: 'Test', slug: 'test', environmentType: 'TESTING' })
      .expect(201);
    const definition = {
      repositoryId: repo.body.data.id,
      buildCommand: 'printf fixture',
      buildLocation: 'MANAGER',
      artifactType: 'FILE',
    };
    const pipeline = await api
      .post('/api/v1/pipelines')
      .send({ name: 'CI', projectId, serviceId: service.body.data.id, definition })
      .expect(201);
    const pipelineId = pipeline.body.data.id as string;
    const settingsPath = `/api/v1/pipelines/${pipelineId}/webhook`;
    const endpoint = `/api/v1/webhooks/gitea/${pipelineId}`;
    const settings = {
      environmentId: environment.body.data.id,
      targetId: target.body.data.id,
      branch: 'release/next',
      secretCredentialId: hookCredential.body.data.id,
      enabled: true,
    };
    await anonymous.get(settingsPath).expect(401);
    assert.equal((await api.get(settingsPath).expect(200)).body.data, null);
    await api
      .put(settingsPath)
      .send({ ...settings, secretCredentialId: short.body.data.id })
      .expect(400);
    await api
      .put(settingsPath)
      .send({ ...settings, branch: 'release/*' })
      .expect(400);
    await api
      .patch(`/api/v1/pipelines/${pipelineId}`)
      .send({ name: 'CI', definition: { ...definition, buildLocation: 'TARGET' } })
      .expect(200);
    await api.put(settingsPath).send(settings).expect(400);
    await api.patch(`/api/v1/pipelines/${pipelineId}`).send({ name: 'CI', definition }).expect(200);
    const saved = await api.put(settingsPath).send(settings).expect(200);
    assert.equal(saved.body.data.endpoint, endpoint);
    assert.equal(saved.body.data.version, 3);
    assert.equal(JSON.stringify(saved.body).includes(secret), false);
    assert.equal('configurationHash' in saved.body.data, false);

    const commit = 'A'.repeat(40);
    const push = {
      ref: 'refs/heads/release/next',
      after: commit,
      repository: { clone_url: repoUrl },
    };
    const raw = (data: object) => `${JSON.stringify(data, null, 2)}\n`;
    const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex');
    const deliver = (body: string, event = 'push', signature = sign(body)) =>
      anonymous
        .post(endpoint)
        .set('content-type', 'application/json')
        .set('X-Gitea-Event', event)
        .set('X-Gitea-Signature', signature)
        .send(body);
    await deliver(raw(push), 'push', '0'.repeat(64)).expect(401);
    await deliver(raw(push), 'push', sign(JSON.stringify(push))).expect(401);
    await deliver(raw({ ...push, after: 'invalid' })).expect(400);
    await deliver(
      raw({ ...push, repository: { clone_url: 'https://gitea.example.test/team/other.git' } }),
    ).expect(403);
    assert.deepEqual((await deliver(raw(push), 'create').expect(200)).body.data, {
      accepted: false,
      reason: 'EVENT_IGNORED',
    });
    assert.deepEqual(
      (await deliver(raw({ ...push, ref: 'refs/heads/main' })).expect(200)).body.data,
      { accepted: false, reason: 'BRANCH_IGNORED' },
    );
    assert.deepEqual(
      (await deliver(raw({ ...push, after: '0'.repeat(40) })).expect(200)).body.data,
      { accepted: false, reason: 'BRANCH_DELETED' },
    );

    // A later saved Pipeline definition cannot change the immutable version approved for the hook.
    await api
      .patch(`/api/v1/pipelines/${pipelineId}`)
      .send({ name: 'CI', definition: { ...definition, buildCommand: 'printf changed' } })
      .expect(200);
    const [accepted, duplicate] = await Promise.all([
      deliver(raw(push)).expect(200),
      deliver(raw(push)).expect(200),
    ]);
    const taskId = accepted.body.data.taskId as string;
    assert.deepEqual(accepted.body.data, {
      accepted: true,
      taskId,
      commitSha: commit.toLowerCase(),
      mode: 'BUILD_ONLY',
    });
    assert.equal(duplicate.body.data.taskId, taskId);
    const db = app.get(DatabaseService).db;
    const runs = await db
      .selectFrom('pipeline_runs')
      .innerJoin('pipeline_versions', 'pipeline_versions.id', 'pipeline_runs.pipeline_version_id')
      .select(['task_id', 'trigger_type', 'git_ref', 'version'])
      .where('pipeline_runs.pipeline_id', '=', pipelineId)
      .execute();
    assert.deepEqual(runs, [
      { task_id: taskId, trigger_type: 'WEBHOOK', git_ref: push.ref, version: 3 },
    ]);
    const task = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow();
    const payload = JSON.parse(task.payload_json);
    assert.equal(payload.pipeline.mode, 'BUILD_ONLY');
    assert.equal(payload.pipeline.definition.buildCommand, 'printf fixture');
    assert.equal(task.payload_json.includes(secret), false);

    await api
      .put(`/api/v1/environments/${settings.environmentId}/variables`)
      .send({ variables: [{ key: 'EXAMPLE', value: 'config changed' }] })
      .expect(200);
    await deliver(raw({ ...push, after: 'b'.repeat(40) })).expect(409);
    assert.equal((await api.put(settingsPath).send(settings).expect(200)).body.data.version, 4);
    await db
      .updateTable('users')
      .set({ must_change_password: 1 })
      .where('id', '=', userId)
      .execute();
    await deliver(raw({ ...push, after: 'b'.repeat(40) })).expect(403);
    await db
      .updateTable('users')
      .set({ must_change_password: 0 })
      .where('id', '=', userId)
      .execute();
    const taskService = app.get(TasksService);
    const worker = app.get(TaskWorkerService);
    process.env.WORKER_ENABLED = 'true';
    await worker.onApplicationBootstrap();
    async function finished(id: string) {
      const deadline = Date.now() + 6500;
      while (Date.now() < deadline) {
        const task = await taskService.get(id);
        if (task.result?.aiAnalysis) return task;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail('AI analysis was not persisted');
    }
    const built = await finished(taskId);
    assert.equal(built.status, 'SUCCESS');
    assert.equal(built.result.aiAnalysis.status, 'SUCCESS');
    const listed = await api
      .get(`/api/v1/artifacts?pipelineRunId=${built.pipelineRunId}`)
      .expect(200);
    assert.equal(listed.body.data.length, 1);
    const artifact = listed.body.data[0];
    assert.equal(artifact.sourceCommit, commit.toLowerCase());
    assert.equal(artifact.downloadAvailable, true);
    const downloadPath = `/api/v1/artifacts/${artifact.id}/download`;
    await anonymous.get(downloadPath).expect(401);
    const downloaded = await api
      .get(downloadPath)
      .buffer(true)
      .parse((response, done) => {
        const parts: Buffer[] = [];
        response.on('data', (chunk: Buffer) => parts.push(chunk));
        response.on('end', () => done(null, Buffer.concat(parts)));
        response.on('error', done);
      })
      .expect('X-Artifact-SHA256', checksum)
      .expect('Content-Disposition', /attachment; filename="veyops-.*\.tar\.gz"/)
      .expect('Content-Length', String(archive.length))
      .expect(200);
    assert.deepEqual(downloaded.body, archive);
    await writeFile(join(artifactDirectory, `${taskId}.tar.gz`), 'incomplete archive');
    await api.get(downloadPath).expect(409);
    assert.equal(
      (await api.get(`/api/v1/tasks/${taskId}`).expect(200)).body.data.result.aiAnalysis.summary,
      '构建完成。',
    );
    modelOffline = true;
    const newCommit = 'c'.repeat(40);
    const failedDelivery = await deliver(raw({ ...push, after: newCommit })).expect(200);
    const failed = await finished(failedDelivery.body.data.taskId as string);
    assert.equal(failed.status, 'FAILED');
    assert.deepEqual(failed.result.aiAnalysis, { status: 'UNAVAILABLE' });
    const successWithoutAi = 'd'.repeat(40);
    const fallbackDelivery = await deliver(raw({ ...push, after: successWithoutAi })).expect(200);
    const fallback = await finished(fallbackDelivery.body.data.taskId as string);
    assert.equal(fallback.status, 'SUCCESS');
    assert.deepEqual(fallback.result.aiAnalysis, { status: 'UNAVAILABLE' });
    assert.deepEqual(builds, [commit.toLowerCase(), newCommit, successWithoutAi]);
    assert.equal(sshCalls, 0);
    assert.equal((await db.selectFrom('deployment_records').select('id').execute()).length, 0);
    assert.equal(modelInputs.length, 3);
    const prompt = JSON.stringify(modelInputs);
    for (const sensitive of [secret, repoUrl, 'fixture-build-details', 'printf fixture'])
      assert.equal(prompt.includes(sensitive), false);
    assert.match(prompt, /MANAGER_BUILD/);

    // Pause a valid delivery after authentication and preview, then rotate before it inserts.
    const pipelines = app.get(PipelinesService);
    const run = pipelines.run.bind(pipelines);
    let notifyReachedRun!: () => void;
    let allowInsert!: () => void;
    const reachedRun = new Promise<void>((resolve) => {
      notifyReachedRun = resolve;
    });
    const insertAllowed = new Promise<void>((resolve) => {
      allowInsert = resolve;
    });
    const pausedRun = t.mock.method(pipelines, 'run', async (...args: Parameters<typeof run>) => {
      notifyReachedRun();
      await insertAllowed;
      return run(...args);
    });
    const waiting = deliver(raw({ ...push, after: 'e'.repeat(40) })).then((res) => res.status);
    const nextSecret = 'fixture-rotated-signing-key-32-bytes';
    try {
      await Promise.race([
        reachedRun,
        waiting.then((status) => assert.fail(`delivery ended early: ${status}`)),
      ]);
      await api
        .patch(`/api/v1/credentials/${settings.secretCredentialId}`)
        .send({ secret: { value: nextSecret } })
        .expect(200);
    } finally {
      allowInsert();
      pausedRun.mock.restore();
    }
    assert.equal(await waiting, 401);
    await api
      .patch(`/api/v1/credentials/${settings.secretCredentialId}`)
      .send({ status: 'DISABLED' })
      .expect(200);
    await deliver(raw(push)).expect(401);
    await api
      .put(settingsPath)
      .send({ ...settings, enabled: false })
      .expect(200);
    assert.deepEqual((await deliver(raw(push)).expect(200)).body.data, {
      accepted: false,
      reason: 'DISABLED',
    });
    assert.equal((await db.selectFrom('pipeline_runs').select('id').execute()).length, 3);

    const group = (
      await api
        .post('/api/v1/server-groups')
        .send({ name: 'build group', serverIds: [server.body.data.id] })
        .expect(201)
    ).body.data;
    await api
      .patch(`/api/v1/credentials/${settings.secretCredentialId}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    const direct = (
      await api
        .put(settingsPath)
        .send({ ...settings, targetId: undefined, groupIds: [group.id] })
        .expect(200)
    ).body.data;
    assert.equal(direct.targetId, null);
    assert.deepEqual(direct.groupIds, [group.id]);
    const directPush = raw({ ...push, after: 'f'.repeat(40) });
    const signed = createHmac('sha256', nextSecret).update(directPush).digest('hex');
    const directDelivery = (await deliver(directPush, 'push', signed).expect(200)).body.data;
    assert.equal(directDelivery.accepted, true);
    const directRun = await db
      .selectFrom('pipeline_runs')
      .select(['target_id', 'target_selection_json'])
      .where('task_id', '=', directDelivery.taskId)
      .executeTakeFirstOrThrow();
    assert.equal(directRun.target_id, null);
    assert.deepEqual(JSON.parse(directRun.target_selection_json!).groupIds, [group.id]);
  } finally {
    await app.close();
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
