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
import { flowTarget } from './helpers/flow-target';

async function checkTypedRuns(url?: string) {
  const data = await mkdtemp(join(tmpdir(), 'veyops-typed-flow-'));
  const initial = randomBytes(18).toString('hex');
  const password = randomBytes(18).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: url ? 'postgres' : 'sqlite',
    ...(url && { DATABASE_URL: url }),
    DATABASE_PATH: join(data, 'test.sqlite'),
    DATA_DIR: data,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: initial,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
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
    const api = request.agent(app.getHttpServer());
    const prefix = '/api/v1';
    const post = async (path: string, body: object) => {
      const response = await api.post(prefix + path).send(body);
      assert.equal(response.status, 201, path + ' ' + JSON.stringify(response.body));
      return response.body.data;
    };
    const get = async (path: string) => (await api.get(prefix + path).expect(200)).body.data;
    await post('/auth/login', { username: 'root', password: initial });
    await api
      .post(prefix + '/auth/change-password')
      .send({ currentPassword: initial, newPassword: password })
      .expect(200);
    await post('/auth/login', { username: 'root', password });
    const serverId = await flowTarget(api);
    const project = await post('/projects', { name: 'Typed flow', slug: 'typed-flow' });
    const graph = `/projects/${project.id}/execution-graph`;
    const definition = {
      canvas: {
        model: 'FLOW_V2',
        nodes: [
          {
            id: 'start',
            name: 'Choose a route',
            type: 'START',
            start: {
              execution: { serverId },
              variables: [{ key: 'REF', value: 'manual', allowOverride: true }],
            },
          },
          {
            id: 'check',
            name: 'Check release ref',
            type: 'CONDITION',
            condition: { value: 'refs/heads/release' },
          },
          { id: 'wait', name: 'Wait before release', type: 'DELAY', delaySeconds: 60 },
          { id: 'skip', name: 'Skip wait', type: 'LOG', message: 'no release' },
          { id: 'end', name: 'Continue', type: 'END' },
        ],
        edges: [
          { from: 'start', to: 'check' },
          { from: 'check', to: 'wait', when: 'TRUE' },
          { from: 'check', to: 'skip', when: 'FALSE' },
          { from: 'wait', to: 'end' },
          { from: 'skip', to: 'end' },
        ],
        endpoints: [{ startId: 'start', endId: 'end' }],
        templates: [],
      },
    };
    const publish = async (nextDefinition: object) => {
      const { revision } = await get(graph);
      const draft = await api
        .put(prefix + graph + '/draft')
        .send({ expectedRevision: revision, definition: nextDefinition })
        .expect(200);
      return post(graph + '/publish', { expectedRevision: draft.body.data.revision });
    };
    const { publishedVersion: version } = await publish(definition);
    const flow = graph + '/flows/start';
    const args = { version, inputs: { value: 'manual', parameters: { 'var:REF': 'manual' } } };
    await api
      .post(prefix + flow + '/preview')
      .send({ version, inputs: { parameters: { REF: 'unapproved key' } } })
      .expect(400);
    const plan = await post(flow + '/preview', args);
    const manual = await post(flow + '/run', {
      ...args,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: plan.configurationHash,
    });
    const status = (run: { nodes: { nodeId: string; status: string }[] }, id: string) =>
      run.nodes.find(({ nodeId }) => nodeId === id)?.status;
    assert.equal(manual.status, 'SUCCESS');
    assert.equal(status(manual, 'wait'), 'SKIPPED');
    assert.equal(status(manual, 'skip'), 'SUCCESS');

    const triggerPath = graph + '/triggers';
    const rule = {
      name: 'Ref-aware automation',
      kind: 'API',
      flowId: 'start',
      version,
      enabled: true,
    };
    await api
      .post(prefix + triggerPath)
      .send({ ...rule, parameterMappings: { UNKNOWN: { source: 'EVENT', field: 'ref' } } })
      .expect(400);
    const configured = await post(triggerPath, {
      ...rule,
      inputValue: 'manual',
    });
    const event = {
      eventId: 'ref-event',
      ref: 'refs/heads/release',
      inputValue: 'refs/heads/release',
    };
    const invoked = (
      await api
        .post(prefix + triggerPath + '/' + configured.id + '/invoke')
        .send(event)
        .expect(202)
    ).body.data;
    await app.get(GraphTriggersService).tick();
    const events = await get(triggerPath + '/' + configured.id + '/events');
    const queued = events.find((item: { id: string }) => item.id === invoked.id);
    assert.equal(queued.status, 'QUEUED');
    const automated = await get(graph + '/runs/' + queued.runId);
    assert.equal(automated.status, 'WAITING');
    assert.equal(automated.trigger.eventId, event.eventId);
    assert.equal(automated.trigger.ref, event.ref);
    assert.equal(status(automated, 'skip'), 'SKIPPED');
    assert.equal(status(automated, 'wait'), 'WAITING');

    const updated = structuredClone(definition);
    updated.canvas.nodes.find(({ id }) => id === 'skip')!.message = 'new version';
    await publish(updated);
    await post(graph + '/versions/' + version + '/retire', {});
    await app
      .get(DatabaseService)
      .db.updateTable('execution_node_runs')
      .set({ started_at: Date.now() - 61_000 })
      .where('run_id', '=', automated.id)
      .where('node_id', '=', 'wait')
      .execute();
    await app.get(GraphRunnerService).tick();
    const resumed = await get(graph + '/runs/' + automated.id);
    assert.equal(resumed.status, 'SUCCESS');
    assert.equal(resumed.version, version);
    assert.equal(status(resumed, 'end'), 'SUCCESS');
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
}

test('SQLite FLOW_V2 carries an API event into routing and keeps a waiting run on the confirmed version', () =>
  checkTypedRuns());
test(
  'PostgreSQL FLOW_V2 carries an API event into routing and keeps a waiting run on the confirmed version',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  () => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, checkTypedRuns),
);
