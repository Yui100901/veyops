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

test('API: bootstrap, sessions, RBAC, encrypted credentials, resources and validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-api-'));
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.DATA_DIR = directory;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
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
    await api.get('/api/v1/servers').expect(401);
    const status = await api.get('/api/v1/auth/status').expect(200);
    assert.equal(status.body.data.initialized, false);
    await api.post('/api/v1/auth/setup').send({ username: 'admin', password: 'weak' }).expect(400);
    const setup = await api
      .post('/api/v1/auth/setup')
      .send({ username: 'admin', password: 'test-password-1234' })
      .expect(201);
    assert.equal(setup.body.data.role, 'ADMIN');
    assert.ok(setup.headers['set-cookie'][0].includes('HttpOnly'));
    assert.ok(setup.headers['set-cookie'][0].includes('SameSite=Strict'));
    assert.equal(JSON.stringify(setup.body).includes('token'), false);
    await api
      .post('/api/v1/auth/setup')
      .send({ username: 'second', password: 'test-password-1234' })
      .expect(409);
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
    const admin = await db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', 'admin')
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
      .send({ username: 'viewer', password: 'test-password-1234' })
      .expect(201);
    await viewer.get('/api/v1/servers').expect(200);
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
});
