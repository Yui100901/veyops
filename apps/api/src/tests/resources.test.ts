import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { withIsolatedPostgres } from './helpers/isolated-postgres';

async function checkResources(databaseUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-resources-'));
  process.env.DATABASE_CLIENT = databaseUrl ? 'postgres' : 'sqlite';
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.DATA_DIR = directory;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_PASSWORD = 'resources-fixture-bootstrap';
  const password = 'resources-fixture-changed';
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
  let probeExitCode = 0;
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SshService)
    .useValue({
      probe: async () => ({
        exitCode: probeExitCode,
        output: [
          'Linux fixture',
          'VEYOPS_OS="Debian GNU/Linux"',
          'VEYOPS_LOAD=0.01 0.03 0.06',
          'VEYOPS_MEM=100 75',
          'VEYOPS_DISK=200 130',
        ].join('\n'),
      }),
    })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const base = '/api/v1';
    const session = (value: string) =>
      api.post(base + '/auth/login').send({ username: 'root', password: value });
    await session(process.env.ADMIN_PASSWORD).expect(201);
    await api
      .post(base + '/auth/change-password')
      .send({
        currentPassword: process.env.ADMIN_PASSWORD,
        newPassword: password,
      })
      .expect(200);
    await session(password).expect(201);
    const create = async (path: string, body: object) =>
      (
        await api
          .post(base + path)
          .send(body)
          .expect(201)
      ).body.data;
    const patch = async (path: string, body: object) =>
      (
        await api
          .patch(base + path)
          .send(body)
          .expect(200)
      ).body.data;
    const fetch = async (path: string) => (await api.get(base + path).expect(200)).body.data;
    const credential = await create('/credentials', {
      name: 'fixture',
      type: 'SSH_PASSWORD',
      secret: { password: 'fixture-secret' },
    });
    const serverInput = {
      name: 'Fixture host',
      host: '127.0.0.1',
      username: 'fixture',
      credentialId: credential.id,
      hostKeyFingerprint: 'a'.repeat(64),
      description: 'Initial description',
    };
    const server = await create('/servers', serverInput);
    const group = await create('/server-groups', { name: 'Initial group', serverIds: [] });
    const edited = await patch('/server-groups/' + group.id, {
      name: 'Edited group',
      description: 'Fixtures',
      serverIds: [server.id, server.id],
    });
    assert.deepEqual(edited.serverIds, [server.id]);
    await create('/servers/' + server.id + '/test', {});
    await patch('/servers/' + server.id, { ...serverInput, description: 'Changed description' });
    const checked = await fetch('/servers/' + server.id);
    assert.equal(checked.osType, 'Debian GNU/Linux');
    assert.equal(checked.status, 'ONLINE');
    assert.equal(checked.description, 'Changed description');
    assert.deepEqual(checked.groups, [{ id: group.id, name: 'Edited group' }]);
    assert.equal(checked.probeHistory[0].metrics.diskAvailableKb, 130);
    probeExitCode = 1;
    await api.post(base + '/servers/' + server.id + '/test').expect(400);
    assert.equal((await fetch('/servers/' + server.id)).status, 'OFFLINE');

    const project = await create('/projects', { name: 'Fixture A', slug: 'fixture-a' });
    const peer = await create('/projects', { name: 'Fixture B', slug: 'fixture-b' });
    const third = await create('/projects', { name: 'Fixture C', slug: 'fixture-c' });
    const fourth = await create('/projects', { name: 'Fixture D', slug: 'fixture-d' });
    const root = '/projects/' + project.id;
    const service = await create(root + '/services', { name: 'Service', slug: 'service' });
    const environment = await create(root + '/environments', { name: 'Test', slug: 'test' });
    const repo = await create(root + '/repositories', {
      name: 'Git',
      cloneUrl: 'https://example.invalid/test.git',
    });
    const [editedService, editedEnvironment, editedRepo] = await Promise.all([
      patch(root + '/services/' + service.id, {
        name: 'Service v2',
        slug: 'service',
        serviceType: 'API',
      }),
      patch(root + '/environments/' + environment.id, {
        name: 'Test v2',
        slug: 'test',
        environmentType: 'TESTING',
      }),
      patch(root + '/repositories/' + repo.id, {
        name: 'Git v2',
        cloneUrl: 'https://example.invalid/test.git',
        defaultBranch: 'develop',
      }),
    ]);
    assert.equal(editedService.serviceType, 'API');
    assert.equal(editedEnvironment.environmentType, 'TESTING');
    assert.equal(editedRepo.defaultBranch, null);
    assert.equal(editedRepo.branchSyncStatus, 'ERROR');
    const fixtureTarget = await create('/deployment-targets', {
      name: 'Fixture deploy',
      serverIds: [server.id],
    });
    const configure = async (serviceId: string, environmentId: string) => {
      const scope = `/services/${serviceId}/environments/${environmentId}`;
      await api
        .put(base + scope + '/config')
        .send({ targetId: fixtureTarget.id, deployPath: '/tmp/veyops-resource-fixture' })
        .expect(200);
      await api
        .put(base + scope + '/variables')
        .send({ variables: [{ key: 'SERVICE_MODE', value: 'fixture' }] })
        .expect(200);
      return scope;
    };
    const configuredScope = await configure(service.id, environment.id);
    await api
      .put(base + `/environments/${environment.id}/variables`)
      .send({ variables: [{ key: 'ENVIRONMENT_MODE', value: 'fixture' }] })
      .expect(200);
    const address = await create(root + '/addresses', {
      name: 'API',
      url: 'https://example.invalid/api',
      serviceId: service.id,
      environmentId: environment.id,
      addressType: 'API',
    });
    await api
      .patch(base + '/projects/' + peer.id + '/services/' + service.id)
      .send({ name: 'Wrong project', slug: 'wrong' })
      .expect(404);
    await api
      .post(base + '/projects/' + peer.id + '/addresses')
      .send({ name: 'Wrong project', url: 'https://example.invalid', serviceId: service.id })
      .expect(400);
    await api.delete(base + root + '/services/' + service.id).expect(409);
    await api.delete(base + root + '/environments/' + environment.id).expect(409);
    assert.equal((await fetch(configuredScope + '/config')).targetId, fixtureTarget.id);
    assert.equal((await fetch(configuredScope + '/variables'))[0].key, 'SERVICE_MODE');
    assert.equal(
      (await fetch(`/environments/${environment.id}/variables`))[0].key,
      'ENVIRONMENT_MODE',
    );
    await api.delete(base + root + '/addresses/' + address.id).expect(200);
    await api.delete(base + root + '/environments/' + environment.id).expect(200);
    const staging = await create(root + '/environments', { name: 'Staging', slug: 'staging' });
    const unusedService = await create(root + '/services', {
      name: 'Unused service',
      slug: 'unused-service',
    });
    await configure(unusedService.id, staging.id);
    await api.delete(base + root + '/services/' + unusedService.id).expect(200);
    await configure(service.id, staging.id);
    assert.equal((await fetch(root)).deploymentTargets[0].id, fixtureTarget.id);
    assert.deepEqual((await fetch('/servers/' + server.id)).projects, [
      {
        id: project.id,
        name: 'Fixture A',
        slug: 'fixture-a',
      },
    ]);

    const dependency = await create(root + '/dependencies', { dependsOnProjectId: peer.id });
    await create('/projects/' + peer.id + '/dependencies', {
      dependsOnProjectId: third.id,
      dependencyType: 'DEPLOYMENT',
    });
    await api
      .post(base + '/projects/' + third.id + '/dependencies')
      .send({ dependsOnProjectId: project.id })
      .expect(409);
    await api.delete(base + '/projects/' + peer.id).expect(409);
    const reciprocal = await Promise.all([
      api.post(base + root + '/dependencies').send({ dependsOnProjectId: fourth.id }),
      api
        .post(base + '/projects/' + fourth.id + '/dependencies')
        .send({ dependsOnProjectId: project.id }),
    ]);
    assert.deepEqual(reciprocal.map((response) => response.status).sort(), [201, 409]);
    assert.ok(
      (await fetch(root)).dependencies.some((row: { id: string }) => row.id === dependency.id),
    );
    const pipeline = await create('/pipelines', {
      name: 'Test Pipeline',
      projectId: project.id,
      serviceId: service.id,
      definition: { repositoryId: repo.id },
    });
    assert.equal((await fetch(root)).pipelines[0].id, pipeline.id);
    await api.delete(base + root + '/repositories/' + repo.id).expect(409);
    await api.delete(base + root + '/services/' + service.id).expect(409);
    const unused = await create(root + '/repositories', {
      name: 'Unused',
      cloneUrl: 'https://example.invalid/unused.git',
    });
    await api.delete(base + root + '/repositories/' + unused.id).expect(200);
    await api.delete(base + '/servers/' + server.id).expect(200);
    assert.deepEqual((await fetch('/server-groups'))[0].serverIds, []);
    await api.delete(base + '/server-groups/' + group.id).expect(200);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite resource management enforces ownership and preserves referenced resources', () =>
  checkResources());
const postgres = process.env.VEYOPS_TEST_POSTGRES_URL;
test(
  'PostgreSQL resource management serializes dependency changes and preserves references',
  { skip: !postgres },
  () => withIsolatedPostgres(postgres!, checkResources),
);
