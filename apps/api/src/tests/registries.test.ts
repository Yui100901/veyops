import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { CredentialsService } from '../modules/credentials/credentials.service';
import { RegistriesService } from '../modules/registries/registries.service';
import {
  checkRegistryConnection,
  registryAddress,
} from '../modules/registries/registry-connection';
import { postgresTestUrl, withIsolatedPostgres } from './helpers/isolated-postgres';

const v2 = { 'Docker-Distribution-Api-Version': 'registry/2.0' };
const fixtureLogin = { username: 'fixture-user', password: 'fixture-password' };
const basic = `Basic ${Buffer.from(`${fixtureLogin.username}:${fixtureLogin.password}`).toString('base64')}`;

test('Registry host validation keeps host and port canonical without accepting URLs or ambiguous IPs', () => {
  assert.equal(registryAddress(' REGISTRY.Example.test:05000 '), 'registry.example.test:5000');
  assert.equal(registryAddress('192.168.1.10:5000'), '192.168.1.10:5000');
  for (const value of [
    'https://registry.example.test',
    'example.test/image',
    'user:password@example.test',
    'registry..example.test',
    'example.test:65536',
    '127.1',
  ]) {
    assert.throws(() => registryAddress(value), /有效的 Registry/);
  }
});

test('Registry connects anonymously, uses Basic only when challenged, and never follows a redirect', async (t) => {
  const requests: Array<{ url: string; authorization?: string; redirect?: string }> = [];
  let behavior: 'anonymous' | 'basic' | 'redirect' | 'invalid' = 'anonymous';
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    const authorization = (init.headers as Record<string, string> | undefined)?.Authorization;
    requests.push({ url: url.href, authorization, redirect: init.redirect });
    if (behavior === 'redirect')
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://outside.example.test' },
      });
    if (behavior === 'invalid') return new Response('unrelated endpoint');
    if (behavior === 'basic' && authorization !== basic)
      return new Response(null, {
        status: 401,
        headers: { ...v2, 'WWW-Authenticate': 'Basic realm="Registry"' },
      });
    return new Response('{}', { headers: v2 });
  });
  assert.deepEqual(await checkRegistryConnection('registry.example.test', fixtureLogin), {
    success: true,
    authenticated: false,
    message: '连接成功，仓库允许匿名访问，本次未验证凭据',
  });
  behavior = 'basic';
  assert.equal((await checkRegistryConnection('registry.example.test')).success, false);
  assert.equal(
    (await checkRegistryConnection('registry.example.test', fixtureLogin)).authenticated,
    true,
  );
  behavior = 'redirect';
  assert.equal(
    (await checkRegistryConnection('registry.example.test', fixtureLogin)).success,
    false,
  );
  behavior = 'invalid';
  assert.equal(
    (await checkRegistryConnection('registry.example.test', fixtureLogin)).success,
    false,
  );
  assert.deepEqual(
    requests.map((request) => request.authorization),
    [undefined, undefined, undefined, basic, undefined, undefined],
  );
  assert.ok(
    requests.every(
      (request) =>
        request.url === 'https://registry.example.test/v2/' && request.redirect === 'manual',
    ),
  );
});

test('Registry validates Bearer authentication and does not send credentials to untrusted realms', async (t) => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  let realm = 'https://auth.docker.io/token';
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    const authorization = (init.headers as Record<string, string> | undefined)?.Authorization;
    requests.push({ url: url.href, authorization });
    if (url.origin === 'https://auth.docker.io')
      return Response.json({ access_token: 'fixture.bearer.token' });
    if (authorization === 'Bearer fixture.bearer.token') return new Response('{}', { headers: v2 });
    return new Response(null, {
      status: 401,
      headers: {
        ...v2,
        'WWW-Authenticate': `Basic realm="Registry", Bearer realm="${realm}", service="registry.docker.io"`,
      },
    });
  });
  assert.equal((await checkRegistryConnection('docker.io', fixtureLogin)).authenticated, true);
  assert.deepEqual(requests, [
    { url: 'https://registry-1.docker.io/v2/', authorization: undefined },
    { url: 'https://auth.docker.io/token?service=registry.docker.io', authorization: basic },
    { url: 'https://registry-1.docker.io/v2/', authorization: 'Bearer fixture.bearer.token' },
  ]);
  requests.length = 0;
  realm = 'https://outside.example.test/token';
  const rejected = await checkRegistryConnection('docker.io', fixtureLogin);
  assert.equal(rejected.success, false);
  assert.match(rejected.message, /不受信任/);
  assert.deepEqual(requests, [
    { url: 'https://registry-1.docker.io/v2/', authorization: undefined },
  ]);
});

test('Registry edits require explicit credential selection on address changes and tests audit only status', async (t) => {
  process.env.DATABASE_PATH = ':memory:';
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const database = new DatabaseService();
  await database.onModuleInit();
  try {
    const userId = randomUUID();
    const now = Date.now();
    await database.db
      .insertInto('users')
      .values({
        id: userId,
        username: 'test-user',
        password_hash: 'fixture',
        role: 'ADMIN',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const audit = new AuditService(database);
    const credentials = new CredentialsService(database, audit);
    const registries = new RegistriesService(database, audit, credentials);
    const credential = await credentials.create(
      { name: 'registry-login', type: 'DOCKER_REGISTRY', secret: fixtureLogin },
      userId,
    );
    const registry = await registries.create(
      { name: ' private ', registryUrl: 'REGISTRY.example.test', credentialId: credential.id },
      userId,
    );
    assert.equal(registry.name, 'private');
    await assert.rejects(
      registries.update(registry.id, { registryUrl: 'other.example.test' }, userId),
      /重新选择凭据/,
    );
    const renamed = await registries.update(registry.id, { name: 'renamed' }, userId);
    assert.equal(renamed.credentialId, credential.id);
    t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
      const authorization = (init.headers as Record<string, string> | undefined)?.Authorization;
      return authorization === basic
        ? new Response('{}', { headers: v2 })
        : new Response(null, {
            status: 401,
            headers: { ...v2, 'WWW-Authenticate': 'Basic realm="Registry"' },
          });
    });
    assert.equal((await registries.test(registry.id, userId)).authenticated, true);
    const auditRows = await audit.list();
    assert.deepEqual(auditRows.find((row) => row.action === 'registry.test')?.detail, {
      success: true,
      authenticated: true,
    });
    assert.equal(JSON.stringify(auditRows).includes(fixtureLogin.password), false);
    const moved = await registries.update(
      registry.id,
      { registryUrl: 'other.example.test', credentialId: null },
      userId,
    );
    assert.equal(moved.registryUrl, 'other.example.test');
    assert.equal(moved.credentialId, null);
    assert.equal((await registries.test(registry.id, userId)).authenticated, false);
  } finally {
    await database.onApplicationShutdown();
  }
});

async function checkRegistryRemoval(connectionString?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-registry-removal-'));
  const initialPassword = 'registry-removal-initial-password';
  const password = 'registry-removal-second-password';
  process.env.DATABASE_CLIENT = connectionString ? 'postgres' : 'sqlite';
  if (connectionString) process.env.DATABASE_URL = connectionString;
  process.env.DATABASE_PATH = join(directory, 'registry.db');
  process.env.DATA_DIR = directory;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_PASSWORD = initialPassword;
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  const base = '/api/v1';
  try {
    await app.init();
    const database = app.get(DatabaseService).db;
    const api = request.agent(app.getHttpServer());
    const post = async (path: string, data: object) =>
      (
        await api
          .post(base + path)
          .send(data)
          .expect(201)
      ).body.data;
    const login = (agent: typeof api, username: string, value: string) =>
      agent
        .post(base + '/auth/login')
        .send({ username, password: value })
        .expect(201);
    await login(api, 'root', initialPassword);
    await api
      .post(base + '/auth/change-password')
      .send({ currentPassword: initialPassword, newPassword: password })
      .expect(200);
    await login(api, 'root', password);
    const admin = await database
      .selectFrom('users')
      .select('password_hash')
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    await database
      .insertInto('users')
      .values({
        id: randomUUID(),
        username: 'registry-operator',
        role: 'OPERATOR',
        password_hash: admin.password_hash,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    const operator = request.agent(app.getHttpServer());
    await login(operator, 'registry-operator', password);
    const credential = await post('/credentials', {
      name: 'Registry login',
      type: 'DOCKER_REGISTRY',
      secret: fixtureLogin,
    });
    const createRegistry = (name: string) =>
      post('/registries', {
        name,
        registryUrl: 'registry.example.test',
        credentialId: credential.id,
      });
    const unreferenced = await createRegistry('Unreferenced');
    const deletionPath = base + '/registries/' + unreferenced.id;
    await request(app.getHttpServer()).delete(deletionPath).expect(401);
    await operator.delete(deletionPath).expect(403);
    await api.delete(deletionPath).expect(200);
    await api.delete(deletionPath).expect(404);
    assert.ok(
      (
        await database
          .selectFrom('credentials')
          .select('id')
          .where('id', '=', credential.id)
          .executeTakeFirst()
      )?.id,
    );

    const historical = await createRegistry('Historical version');
    const artifactRegistry = await createRegistry('Registry artifact');
    const project = await post('/projects', { name: 'Registry fixture', slug: 'registry-fixture' });
    const projectPath = '/projects/' + project.id;
    const service = await post(projectPath + '/services', {
      name: 'Fixture service',
      slug: 'fixture',
    });
    const repository = await post(projectPath + '/repositories', {
      name: 'Fixture Git',
      cloneUrl: 'https://example.invalid/fixture.git',
    });
    const definition = {
      name: 'Image build',
      projectId: project.id,
      serviceId: service.id,
      definition: {
        repositoryId: repository.id,
        artifactType: 'DOCKER_IMAGE',
        registryId: historical.id,
      },
    };
    const pipeline = await post('/pipelines', definition);
    await api
      .patch(base + '/pipelines/' + pipeline.id)
      .send({
        name: definition.name,
        enabled: false,
        definition: { repositoryId: repository.id, artifactType: 'DOCKER_IMAGE' },
      })
      .expect(200);
    await api.delete(base + '/registries/' + historical.id).expect(409);
    const image = randomUUID();
    await database
      .insertInto('artifacts')
      .values({
        id: image,
        project_id: project.id,
        service_id: service.id,
        artifact_type: 'DOCKER_IMAGE',
        storage_type: 'REGISTRY_IMAGE',
        storage_key: 'fixture/image:tag',
        registry_id: artifactRegistry.id,
        created_at: Date.now(),
      })
      .execute();
    await api.delete(base + '/registries/' + artifactRegistry.id).expect(409);
    assert.equal(
      (
        await database
          .selectFrom('artifacts')
          .select('registry_id')
          .where('id', '=', image)
          .executeTakeFirstOrThrow()
      ).registry_id,
      artifactRegistry.id,
    );

    const contended = await createRegistry('Referenced concurrently');
    const registryService = app.get(RegistriesService);
    const lookup = registryService.get.bind(registryService);
    let markResourceLoaded!: () => void;
    const resourceLoaded = new Promise<void>((resolve) => {
      markResourceLoaded = resolve;
    });
    let resumeWriter!: () => void;
    const writerPermission = new Promise<void>((resolve) => {
      resumeWriter = resolve;
    });
    registryService.get = async (id) => {
      const registry = await lookup(id);
      if (id === contended.id) {
        markResourceLoaded();
        await writerPermission;
      }
      return registry;
    };
    const pendingWrite = api
      .post(base + '/pipelines')
      .send({
        ...definition,
        name: 'Contended Pipeline',
        definition: { ...definition.definition, registryId: contended.id },
      })
      .then((response) => response);
    try {
      await Promise.race([
        resourceLoaded,
        pendingWrite.then(({ status }) => {
          throw new Error(`Pipeline returned ${status} before Registry validation`);
        }),
      ]);
      await api.delete(base + '/registries/' + contended.id).expect(200);
    } finally {
      resumeWriter();
      registryService.get = lookup;
    }
    assert.equal((await pendingWrite).status, 404);
    const pipelines = (await api.get(base + '/pipelines').expect(200)).body.data;
    assert.deepEqual(
      pipelines.map(({ id }: { id: string }) => id),
      [pipeline.id],
    );
    const audits = await app.get(AuditService).list();
    assert.deepEqual(
      new Set(
        audits
          .filter(({ action }) => action === 'registry.delete')
          .map(({ resourceId }) => resourceId),
      ),
      new Set([unreferenced.id, contended.id]),
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite Registry removal enforces authorization and protects history and concurrent references', () =>
  checkRegistryRemoval());

test(
  'PostgreSQL Registry removal enforces authorization and protects history and concurrent references',
  { skip: !postgresTestUrl && 'VEYOPS_TEST_POSTGRES_URL is unset' },
  () => withIsolatedPostgres(postgresTestUrl!, (url) => checkRegistryRemoval(url)),
);
