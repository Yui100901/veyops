import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { CredentialsService } from '../modules/credentials/credentials.service';
import { RegistriesService } from '../modules/registries/registries.service';
import {
  checkRegistryConnection,
  registryAddress,
} from '../modules/registries/registry-connection';

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
