import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function checkApi(databaseUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-api-'));
  process.env.DATABASE_CLIENT = databaseUrl ? 'postgres' : 'sqlite';
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.DATA_DIR = directory;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  const initialPassword = 'fixture-initial-password';
  const newPassword = 'fixture-changed-password';
  process.env.ADMIN_PASSWORD = initialPassword;
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SshService)
    .useValue({
      probe: async () => ({ exitCode: 0, output: 'Linux test-host' }),
      execute: async () => ({ exitCode: 0 }),
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const viewer = request.agent(app.getHttpServer());
    const initialSession = request.agent(app.getHttpServer());
    await api.get('/api/v1/servers').expect(401);
    const status = await api.get('/api/v1/auth/status').expect(200);
    assert.equal(status.body.data.initialized, true);
    await api
      .post('/api/v1/auth/setup')
      .send({ username: 'attacker', password: initialPassword })
      .expect(404);
    const login = await api
      .post('/api/v1/auth/login')
      .send({ username: 'root', password: initialPassword })
      .expect(201);
    assert.equal(login.body.data.role, 'ADMIN');
    assert.equal(login.body.data.mustChangePassword, true);
    assert.ok(login.headers['set-cookie'][0].includes('HttpOnly'));
    assert.ok(login.headers['set-cookie'][0].includes('SameSite=Strict'));
    assert.equal(JSON.stringify(login.body).includes('token'), false);
    const current = await api.get('/api/v1/auth/me').expect(200);
    assert.equal(current.body.data.mustChangePassword, true);
    await api.get('/api/v1/servers').expect(403);
    await api.post('/api/v1/credentials').send({}).expect(403);
    await initialSession
      .post('/api/v1/auth/login')
      .send({ username: 'root', password: initialPassword })
      .expect(201);
    await api
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: initialPassword, newPassword: initialPassword })
      .expect(400);
    await api
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: initialPassword, newPassword: 'short' })
      .expect(400);
    await api
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: 'wrong', newPassword })
      .expect(401);
    const changed = await api
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: initialPassword, newPassword })
      .expect(200);
    assert.deepEqual(changed.body.data, { success: true });
    assert.ok(changed.headers['set-cookie'][0].startsWith('veyops_session=;'));
    await api.get('/api/v1/auth/me').expect(401);
    await initialSession.get('/api/v1/auth/me').expect(401);
    await api
      .post('/api/v1/auth/login')
      .send({ username: 'root', password: initialPassword })
      .expect(401);
    const renewed = await api
      .post('/api/v1/auth/login')
      .send({ username: 'root', password: newPassword })
      .expect(201);
    assert.equal(renewed.body.data.mustChangePassword, false);
    await api
      .post('/api/v1/credentials')
      .set('Origin', 'https://evil.example')
      .send({})
      .expect(403);
    const credential = await api
      .post('/api/v1/credentials')
      .send({ name: 'test ssh', type: 'SSH_PASSWORD', secret: { password: 'server-secret-123' } })
      .expect(201);
    const credentialId = credential.body.data.id as string;
    const db = app.get(DatabaseService).db;
    const stored = await db
      .selectFrom('credentials')
      .selectAll()
      .where('id', '=', credentialId)
      .executeTakeFirstOrThrow();
    assert.equal(stored.ciphertext.includes('server-secret-123'), false);
    assert.equal(JSON.stringify(credential.body).includes('ciphertext'), false);
    const list = await api.get('/api/v1/credentials').expect(200);
    assert.equal(JSON.stringify(list.body).includes('server-secret-123'), false);
    await api
      .post('/api/v1/servers')
      .send({
        name: 'invalid',
        host: '127.0.0.1',
        username: 'ops',
        credentialId,
        hostKeyFingerprint: 'untrusted',
      })
      .expect(400);
    const server = await api
      .post('/api/v1/servers')
      .send({
        name: 'test',
        host: '127.0.0.1',
        port: 22,
        username: 'ops',
        credentialId,
        hostKeyFingerprint: '0'.repeat(64),
        tags: ['test'],
      })
      .expect(201);
    const serverId = server.body.data.id as string;
    await api.post(`/api/v1/servers/${serverId}/test`).expect(201);
    const tested = await api.get(`/api/v1/servers/${serverId}`).expect(200);
    assert.equal(tested.body.data.status, 'ONLINE');
    await api.delete(`/api/v1/credentials/${credentialId}`).expect(409);
    await api
      .post('/api/v1/commands/execute')
      .send({ command: 'uname -a', serverIds: [serverId] })
      .expect(400);
    await api
      .post('/api/v1/commands/execute')
      .send({ command: 'uname -a', serverIds: [], confirmed: true })
      .expect(400);
    const command = await api
      .post('/api/v1/commands/execute')
      .send({
        name: 'readonly test',
        command: 'uname -a',
        serverIds: [serverId, serverId],
        confirmed: true,
      })
      .expect(201);
    const targets = await api.get(`/api/v1/tasks/${command.body.data.id}/targets`).expect(200);
    assert.equal(targets.body.data.length, 1);
    await api.post(`/api/v1/tasks/${command.body.data.id}/cancel`).expect(201);
    const project = await api
      .post('/api/v1/projects')
      .send({ name: 'Website', slug: 'website' })
      .expect(201);
    const projectId = project.body.data.id as string;
    await api.post('/api/v1/projects').send({ name: 'duplicate', slug: 'website' }).expect(409);
    await api
      .post(`/api/v1/projects/${projectId}/services`)
      .send({ name: 'API', slug: 'api', serviceType: 'API' })
      .expect(201);
    await api
      .post(`/api/v1/projects/${projectId}/environments`)
      .send({ name: '生产', slug: 'production', environmentType: 'PRODUCTION' })
      .expect(201);
    await api
      .post(`/api/v1/projects/${projectId}/repositories`)
      .send({ name: 'secret-url', cloneUrl: 'https://user:secret@example.com/repo.git' })
      .expect(400);
    await api
      .post(`/api/v1/projects/${projectId}/repositories`)
      .send({ name: 'main', cloneUrl: 'https://example.com/repo.git', defaultBranch: 'main' })
      .expect(201);
    const details = await api.get(`/api/v1/projects/${projectId}`).expect(200);
    assert.equal(details.body.data.services.length, 1);
    assert.equal(details.body.data.environments.length, 1);
    const serviceId = details.body.data.services[0].id as string;
    const environmentId = details.body.data.environments[0].id as string;
    const repositoryId = details.body.data.repositories[0].id as string;
    const target = await api
      .post('/api/v1/deployment-targets')
      .send({
        name: 'test target',
        serverIds: [serverId, serverId],
        strategy: 'SEQUENTIAL',
        maxParallel: 1,
        failurePolicy: 'STOP',
      })
      .expect(201);
    assert.equal(target.body.data.serverIds.length, 1);
    const targetId = target.body.data.id as string;
    await api
      .put(`/api/v1/services/${serviceId}/repositories`)
      .send({ repositories: [{ repositoryId, repoPath: '.', isPrimary: true }] })
      .expect(200);
    const linked = await api.get(`/api/v1/services/${serviceId}/repositories`).expect(200);
    assert.equal(linked.body.data[0].repositoryId, repositoryId);
    await api
      .put(`/api/v1/services/${serviceId}/environments/${environmentId}/config`)
      .send({
        targetId,
        buildLocation: 'TARGET',
        artifactType: 'FILE',
        deployMethod: 'DOCKER_COMPOSE',
      })
      .expect(400);
    await api
      .put(`/api/v1/services/${serviceId}/environments/${environmentId}/config`)
      .send({
        targetId,
        buildLocation: 'TARGET',
        artifactType: 'FILE',
        deployMethod: 'FILE',
        deployPath: '/tmp/veyops-test-service',
      })
      .expect(200);
    await api
      .put(`/api/v1/environments/${environmentId}/variables`)
      .send({
        variables: [
          { key: 'APP_MODE', value: 'production' },
          { key: 'SECRET_REF', credentialId },
        ],
      })
      .expect(200);
    await api
      .put(`/api/v1/environments/${environmentId}/variables`)
      .send({ variables: [{ key: 'INVALID', value: 'plaintext', credentialId }] })
      .expect(400);
    await api
      .put(`/api/v1/services/${serviceId}/environments/${environmentId}/variables`)
      .send({ variables: [{ key: 'APP_MODE', value: 'service-override' }] })
      .expect(200);
    const { ServiceConfigsService } =
      await import('../modules/service-configs/service-configs.service.js');
    const snapshot = await app
      .get(ServiceConfigsService)
      .readSnapshot(serviceId, environmentId, targetId);
    assert.equal(snapshot.variables.APP_MODE, 'service-override');
    assert.equal(snapshot.secretVariables.SECRET_REF, credentialId);
    const variables = await api.get(`/api/v1/environments/${environmentId}/variables`).expect(200);
    assert.equal(JSON.stringify(variables.body).includes('server-secret-123'), false);
    await api.delete(`/api/v1/deployment-targets/${targetId}`).expect(409);
    const retired = await api
      .post('/api/v1/servers')
      .send({
        name: 'retired fixture',
        host: '127.0.0.2',
        username: 'ops',
        credentialId,
        hostKeyFingerprint: '0'.repeat(64),
      })
      .expect(201);
    const group = await api
      .post('/api/v1/server-groups')
      .send({
        name: 'active and retired',
        serverIds: [serverId, retired.body.data.id],
      })
      .expect(201);
    await api.delete(`/api/v1/servers/${retired.body.data.id}`).expect(200);
    for (const isolatedSelection of [
      { groupIds: [group.body.data.id] },
      { projectIds: [projectId] },
      { environmentIds: [environmentId] },
    ]) {
      const resolved = await api
        .post('/api/v1/commands/preview')
        .send(isolatedSelection)
        .expect(201);
      assert.deepEqual(
        resolved.body.data.targets.map((row: { id: string }) => row.id),
        [serverId],
      );
      if ('environmentIds' in isolatedSelection) {
        const queued = await api
          .post('/api/v1/commands/execute')
          .send({
            ...isolatedSelection,
            confirmed: true,
            command: 'true',
            expectedTargetHash: resolved.body.data.targetHash,
          })
          .expect(201);
        const scope = await db
          .selectFrom('tasks')
          .select(['project_id', 'environment_id'])
          .where('id', '=', queued.body.data.id)
          .executeTakeFirstOrThrow();
        assert.deepEqual(scope, { project_id: projectId, environment_id: environmentId });
      }
    }
    const selection = {
      serverIds: [serverId],
      projectIds: [projectId],
      environmentIds: [environmentId],
      deploymentTargetIds: [targetId],
      tags: ['test'],
    };
    const preview = await api.post('/api/v1/commands/preview').send(selection).expect(201);
    assert.deepEqual(preview.body.data.targets, [
      { id: serverId, name: 'test', host: '127.0.0.1' },
    ]);
    assert.equal(preview.body.data.count, 1);
    await api
      .post('/api/v1/commands/execute')
      .send({ ...selection, confirmed: true, command: 'true' })
      .expect(400);
    const execution = {
      ...selection,
      confirmed: true,
      command: 'uname -a',
      expectedTargetHash: preview.body.data.targetHash,
    };
    const retrySource = await api.post('/api/v1/commands/execute').send(execution).expect(201);
    const originalTask = retrySource.body.data.id as string;
    const originalTargets = await api.get(`/api/v1/tasks/${originalTask}/targets`).expect(200);
    const originalTarget = originalTargets.body.data[0].id as string;
    const retryUrl = `/api/v1/tasks/${originalTask}/targets/${originalTarget}/retry`;
    await api.post(retryUrl).send({ confirmed: true }).expect(409);
    await db
      .updateTable('tasks')
      .set({ status: 'FAILED' })
      .where('id', '=', originalTask)
      .execute();
    await db
      .updateTable('task_targets')
      .set({ status: 'FAILED', exit_code: 7 })
      .where('id', '=', originalTarget)
      .execute();
    const failure = await api.get(`/api/v1/tasks/${originalTask}/targets`).expect(200);
    assert.equal(failure.body.data[0].canRetry, true);
    const [firstRetry, duplicateRetry] = await Promise.all([
      api.post(retryUrl).send({ confirmed: true }).expect(201),
      api.post(retryUrl).send({ confirmed: true }).expect(201),
    ]);
    assert.equal(firstRetry.body.data.id, duplicateRetry.body.data.id);
    assert.deepEqual(firstRetry.body.data.retryOf, {
      taskId: originalTask,
      targetId: originalTarget,
    });
    const retryRows = await api.get(`/api/v1/tasks/${firstRetry.body.data.id}/targets`).expect(200);
    assert.deepEqual(
      retryRows.body.data.map((row: { serverId: string }) => row.serverId),
      [serverId],
    );
    await api
      .patch(`/api/v1/credentials/${credentialId}`)
      .send({ secret: { password: 'fixture-rotated-ssh' } })
      .expect(200);
    await api.post('/api/v1/commands/execute').send(execution).expect(409);
    await api.post(retryUrl).send({ confirmed: true }).expect(409);
    await db
      .updateTable('tasks')
      .set({ status: 'NEEDS_ATTENTION' })
      .where('id', '=', originalTask)
      .execute();
    await api.post(retryUrl).send({ confirmed: true }).expect(409);
    const admin = await db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('users')
      .values({
        id: randomUUID(),
        username: 'viewer',
        password_hash: admin.password_hash,
        role: 'VIEWER',
        status: 'ACTIVE',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    await viewer
      .post('/api/v1/auth/login')
      .send({ username: 'viewer', password: newPassword })
      .expect(201);
    await viewer.get('/api/v1/servers').expect(200);
    const initialSettings = await viewer.get('/api/v1/system').expect(200);
    assert.equal(initialSettings.body.data.defaultBuildLocation, 'TARGET');
    assert.equal(initialSettings.body.data.defaultMaxParallelTargets, 3);
    assert.equal(initialSettings.body.data.logRetentionDays, 0);
    await viewer.patch('/api/v1/system').send({ logRetentionDays: 7 }).expect(403);
    await api.patch('/api/v1/system').send({ defaultMaxParallelTargets: 11 }).expect(400);
    await api.patch('/api/v1/system').send({ logRetentionDays: null }).expect(400);
    await api.patch('/api/v1/system').send({ defaultBuildLocation: 'OTHER' }).expect(400);
    await Promise.all([
      api.patch('/api/v1/system').send({ defaultBuildLocation: 'MANAGER' }).expect(200),
      api
        .patch('/api/v1/system')
        .send({ defaultMaxParallelTargets: 6, logRetentionDays: 7 })
        .expect(200),
    ]);
    const savedSettings = await viewer.get('/api/v1/system').expect(200);
    assert.equal(savedSettings.body.data.defaultBuildLocation, 'MANAGER');
    assert.equal(savedSettings.body.data.defaultMaxParallelTargets, 6);
    assert.equal(savedSettings.body.data.logRetentionDays, 7);

    const targetWithDefaults = await api
      .post('/api/v1/deployment-targets')
      .send({ name: 'System default target', serverIds: [serverId] })
      .expect(201);
    assert.equal(targetWithDefaults.body.data.maxParallel, 6);
    const commandWithDefaults = await api
      .post('/api/v1/commands/execute')
      .send({
        name: 'System defaults command',
        command: 'true',
        serverIds: [serverId],
        confirmed: true,
      })
      .expect(201);
    const queuedCommand = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', commandWithDefaults.body.data.id)
      .executeTakeFirstOrThrow();
    assert.equal(JSON.parse(queuedCommand.payload_json).maxParallel, 6);

    const pipeline = {
      name: 'System default pipeline',
      projectId,
      serviceId,
      definition: { repositoryId, deployPath: '/tmp/veyops-settings-pipeline' },
    };
    const pipelineWithDefaults = await api.post('/api/v1/pipelines').send(pipeline).expect(201);
    assert.equal(pipelineWithDefaults.body.data.definition.buildLocation, 'MANAGER');
    assert.equal(pipelineWithDefaults.body.data.definition.artifactType, 'FILE');
    const pipelinePath = `/api/v1/pipelines/${pipelineWithDefaults.body.data.id}`;
    const configPath = `/api/v1/services/${serviceId}/environments/${environmentId}/config`;
    const existingConfig = await api
      .put(configPath)
      .send({ targetId, deployPath: '/tmp/veyops-test-service' })
      .expect(200);
    assert.equal(existingConfig.body.data.buildLocation, 'TARGET');

    await api
      .patch('/api/v1/system')
      .send({ defaultBuildLocation: 'TARGET', defaultMaxParallelTargets: 5 })
      .expect(200);
    const retainedPipeline = await api
      .patch(pipelinePath)
      .send({ name: pipeline.name, definition: pipeline.definition })
      .expect(200);
    assert.equal(retainedPipeline.body.data.definition.buildLocation, 'MANAGER');
    const newPipeline = await api
      .post('/api/v1/pipelines')
      .send({
        ...pipeline,
        name: 'System default pipeline explicit',
        definition: { ...pipeline.definition, buildLocation: 'MANAGER' },
      })
      .expect(201);
    assert.equal(newPipeline.body.data.definition.buildLocation, 'MANAGER');
    const retainedTarget = await api
      .patch(`/api/v1/deployment-targets/${targetWithDefaults.body.data.id}`)
      .send({ name: 'System default target updated', serverIds: [serverId] })
      .expect(200);
    assert.equal(retainedTarget.body.data.maxParallel, 6);
    await viewer.post(retryUrl).send({ confirmed: true }).expect(403);
    await viewer
      .post('/api/v1/credentials')
      .send({ name: 'forbidden', type: 'SSH_PASSWORD', secret: { password: 'x' } })
      .expect(403);
    await viewer
      .post('/api/v1/commands/execute')
      .send({ command: 'uname', serverIds: [serverId], confirmed: true })
      .expect(403);
    const audit = await api.get('/api/v1/audit').expect(200);
    assert.ok(audit.body.data.some((r: { action: string }) => r.action === 'credential.create'));
    assert.ok(
      audit.body.data.some((r: { action: string }) => r.action === 'system.settings.update'),
    );
    assert.equal(JSON.stringify(audit.body).includes('server-secret-123'), false);
    await api.delete(`/api/v1/servers/${serverId}`).expect(200);
    await api.get(`/api/v1/servers/${serverId}`).expect(404);
    const history = await api.get(`/api/v1/tasks/${command.body.data.id}/targets`).expect(200);
    assert.equal(history.body.data.length, 1);
    await api.post('/api/v1/auth/logout').expect(201);
    await api.get('/api/v1/auth/me').expect(401);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite API: bootstrap, sessions, RBAC, encrypted credentials, resources and validation', () =>
  checkApi());
test(
  'PostgreSQL API: bootstrap, sessions, RBAC, encrypted credentials, resources and validation',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  async () => {
    const { postgresTestUrl, withIsolatedPostgres } =
      await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgresTestUrl!, checkApi);
  },
);
