import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { withIsolatedPostgres } from './helpers/isolated-postgres';

async function checkLifecycle(url?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-reference-lifecycle-'));
  const initial = randomBytes(18).toString('hex');
  const password = randomBytes(18).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: url ? 'postgres' : 'sqlite',
    ...(url && { DATABASE_URL: url }),
    DATABASE_PATH: join(dir, 'test.db'),
    DATA_DIR: dir,
    ADMIN_PASSWORD: initial,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { GraphRunnerService } =
    await import('../modules/execution-graphs/graph-runner.service.js');
  const { GraphTriggersService } =
    await import('../modules/execution-graphs/graph-triggers.service.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false });
  try {
    configureApp(app);
    await app.init();
    const client = request.agent(app.getHttpServer());
    const api = '/api/v1';
    const post = (path: string, body: object) => client.post(api + path).send(body);
    const get = async (path: string) => (await client.get(api + path).expect(200)).body.data;
    const make = async (path: string, body: object) =>
      (await post(path, body).expect(201)).body.data;
    await make('/auth/login', { username: 'root', password: initial });
    await post('/auth/change-password', { currentPassword: initial, newPassword: password }).expect(
      200,
    );
    await make('/auth/login', { username: 'root', password });
    const credential = await make('/credentials', {
      name: 'Fixture SSH',
      type: 'SSH_PASSWORD',
      secret: { password: randomBytes(16).toString('hex') },
    });
    const server = (name: string) =>
      make('/servers', {
        name,
        host: '127.0.0.1',
        username: 'fixture',
        credentialId: credential.id,
        hostKeyFingerprint: 'a'.repeat(64),
      });
    const project = (slug: string) => make('/projects', { name: slug, slug });
    const start = { id: 'start', type: 'START', name: 'Start' };
    const end = { id: 'end', type: 'END', name: 'End' };
    async function save(graphPath: string, serverId?: string) {
      const { revision } = await get(graphPath);
      const nodes = serverId
        ? [
            start,
            {
              id: 'shell',
              type: 'SHELL',
              name: 'Pinned SSH host',
              shell: { location: 'TARGET', serverId, command: 'true' },
            },
            end,
          ]
        : [start, end];
      const edges = nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }));
      return (
        await client
          .put(api + graphPath + '/draft')
          .send({
            expectedRevision: revision,
            definition: {
              flows: [],
              canvas: {
                nodes: [
                  ...nodes,
                  { id: 'control', type: 'START', name: 'Control flow' },
                  { id: 'control-end', type: 'END', name: 'Control end' },
                ],
                edges: [...edges, { from: 'control', to: 'control-end' }],
                endpoints: [
                  { startId: 'start', endId: 'end' },
                  { startId: 'control', endId: 'control-end' },
                ],
                templates: [],
              },
            },
          })
          .expect(200)
      ).body.data.revision as number;
    }

    const raceProject = await project('reference-race');
    const racePath = `/projects/${raceProject.id}/execution-graph`;
    const raced = await server('Race host');
    const raceRevision = await save(racePath, raced.id);
    const [published, removed] = await Promise.all([
      post(racePath + '/publish', { expectedRevision: raceRevision }),
      client.delete(api + '/servers/' + raced.id),
    ]);
    assert.ok(
      (published.status === 201 && removed.status === 409) ||
        (published.status === 400 && removed.status === 200),
      JSON.stringify({ published: published.body, removed: removed.body }),
    );
    if (removed.status === 409)
      assert.ok(
        removed.body.error.references.some((ref: { state: string }) => ref.state === 'RUNNABLE'),
      );

    const tracked = await server('Versioned host');
    const owner = await project('reference-history');
    const scope = '/projects/' + owner.id;
    const graph = scope + '/execution-graph';
    const older = await make(graph + '/publish', {
      expectedRevision: await save(graph, tracked.id),
    });
    const version = older.publishedVersion as number;
    const rule = {
      name: 'Follows current publication',
      kind: 'API',
      flowId: 'control',
      version,
      enabled: true,
    };
    await post(graph + '/triggers', { ...rule, flowId: 'start' }).expect(403);
    const trigger = await make(graph + '/triggers', rule);
    const triggerPath = graph + '/triggers/' + trigger.id;
    const accepted = (
      await post(triggerPath + '/invoke', { eventId: 'before-publication' }).expect(202)
    ).body.data;
    assert.equal(accepted.status, 'PENDING');
    assert.equal(accepted.version, version);
    const review = await make(graph + '/flows/start/preview', { version });
    const live = await make(graph + '/flows/start/run', {
      version,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: review.configurationHash,
    });
    assert.match(live.status, /QUEUED|RUNNING/);

    const updated = await make(graph + '/publish', { expectedRevision: await save(graph) });
    const latest = updated.publishedVersion as number;
    const [followed] = await get(graph + '/triggers');
    assert.equal(followed.id, trigger.id);
    assert.equal(followed.version, latest);
    assert.equal(followed.enabled, true);
    const blocked = await client.delete(api + '/servers/' + tracked.id).expect(409);
    assert.ok(
      blocked.body.error.references.some(
        (ref: { version?: number; state: string }) =>
          ref.version === version && ref.state === 'RUNNABLE',
      ),
    );
    const inFlight = await post(`${graph}/versions/${version}/retire`, {}).expect(409);
    assert.match(inFlight.body.error.message, /已接收的触发事件/);
    await app.get(GraphTriggersService).tick();
    const [dispatched] = await get(triggerPath + '/events');
    assert.equal(dispatched.id, accepted.id);
    assert.equal(dispatched.status, 'QUEUED');
    assert.equal(dispatched.version, version);
    assert.equal((await get(`${graph}/runs/${dispatched.runId}`)).version, version);
    const retired = await make(`${graph}/versions/${version}/retire`, {});
    assert.ok(retired.retiredAt);
    assert.equal((await get(`${graph}/versions/${version}`)).retiredAt, retired.retiredAt);
    await post(graph + '/flows/start/preview', { version }).expect(409);
    const nextEvent = (
      await post(triggerPath + '/invoke', { eventId: 'after-retirement' }).expect(202)
    ).body.data;
    assert.equal(nextEvent.version, latest);
    const pending = await client.delete(api + '/servers/' + tracked.id).expect(409);
    assert.ok(
      pending.body.error.references.some((ref: { state: string }) => ref.state === 'PENDING'),
    );

    await make(`${graph}/runs/${live.id}/cancel`, {});
    await app.get(GraphRunnerService).tick();
    await client.delete(api + '/servers/' + tracked.id).expect(200);
    const history = await get(scope + '/resource-references');
    assert.equal(
      history.servers.some((row: { id: string }) => row.id === tracked.id),
      false,
    );
    assert.ok(
      history.references.some(
        (ref: { resourceId: string; state: string }) =>
          ref.resourceId === tracked.id && ref.state === 'HISTORY',
      ),
    );
    assert.equal((await get(`${graph}/runs/${live.id}`)).version, version);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('SQLite publication/removal serialize and retirement preserves runnable, pending and historical reference states', () =>
  checkLifecycle());
test(
  'PostgreSQL publication/removal serialize and retirement preserves runnable, pending and historical reference states',
  {
    skip: !process.env.VEYOPS_TEST_POSTGRES_URL,
  },
  () => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, checkLifecycle),
);
