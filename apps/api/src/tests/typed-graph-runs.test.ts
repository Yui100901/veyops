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
    const post = async (path: string, body: object) =>
      (
        await api
          .post(prefix + path)
          .send(body)
          .expect(201)
      ).body.data;
    const get = async (path: string) => (await api.get(prefix + path).expect(200)).body.data;
    await post('/auth/login', { username: 'root', password: initial });
    await api
      .post(prefix + '/auth/change-password')
      .send({ currentPassword: initial, newPassword: password })
      .expect(200);
    await post('/auth/login', { username: 'root', password });
    const project = await post('/projects', { name: 'Typed flow', slug: 'typed-flow' });
    const graph = `/projects/${project.id}/execution-graph`;
    const field = { id: 'choice', name: 'Deploy decision', type: 'TEXT', required: true };
    const input = { kind: 'INPUT', fieldId: 'choice' };
    const fromCall = { kind: 'OUTPUT', nodeId: 'call', fieldId: 'choice' };
    const definition = {
      flows: [],
      canvas: {
        nodes: [
          { id: 'parent', name: 'Parent', type: 'START', inputs: [field] },
          { id: 'call', name: 'Call decision', type: 'FLOW_CALL', flowId: 'child' },
          {
            id: 'check',
            name: 'Check decision',
            type: 'CONDITION',
            condition: { key: 'input', value: 'refs/heads/release' },
          },
          { id: 'yes', name: 'Deploy', type: 'LOG', message: 'deploy-branch' },
          { id: 'no', name: 'Stay', type: 'LOG', message: 'stay-branch' },
          { id: 'join', name: 'Continue', type: 'JOIN' },
          { id: 'end', name: 'Return result', type: 'END', outputs: [field] },
          { id: 'child', name: 'Receive decision', type: 'START', inputs: [field] },
          { id: 'child-end', name: 'Return decision', type: 'END', outputs: [field] },
        ],
        edges: [
          { from: 'parent', to: 'call' },
          { from: 'call', to: 'check' },
          { from: 'check', to: 'yes', when: 'TRUE' },
          { from: 'check', to: 'no', when: 'FALSE' },
          { from: 'yes', to: 'join' },
          { from: 'no', to: 'join' },
          { from: 'join', to: 'end' },
          { from: 'child', to: 'child-end' },
        ],
        endpoints: [
          {
            startId: 'parent',
            endId: 'end',
            inputBindings: { call: { choice: input }, check: { value: fromCall } },
            outputBindings: { choice: fromCall },
          },
          { startId: 'child', endId: 'child-end', outputBindings: { choice: input } },
        ],
        templates: [],
      },
    };
    const current = await get(graph);
    const saved = (
      await api
        .put(prefix + graph + '/draft')
        .send({ expectedRevision: current.revision, definition })
        .expect(200)
    ).body.data;
    const published = await post(graph + '/publish', { expectedRevision: saved.revision });
    const version = published.publishedVersion;
    const flow = graph + '/flows/parent';
    await api
      .post(prefix + flow + '/preview')
      .send({ version })
      .expect(400);

    const args = { version, inputs: { parameters: { choice: 'manual' } } };
    const checked = await post(flow + '/preview', args);
    assert.equal(checked.parameters.choice, 'manual');
    const manual = await post(flow + '/run', {
      ...args,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: checked.configurationHash,
    });
    const detail = await get(graph + '/runs/' + manual.id);
    assert.equal(detail.status, 'SUCCESS');
    assert.equal(detail.outputs.choice, 'manual');
    assert.equal(
      detail.nodes.find((node: { nodeId: string }) => node.nodeId === 'yes').status,
      'SKIPPED',
    );

    const triggerPath = graph + '/triggers';
    const rule = {
      name: 'Typed automation',
      kind: 'API',
      flowId: 'parent',
      version,
      enabled: true,
    };
    await api
      .post(prefix + triggerPath)
      .send(rule)
      .expect(400);
    const configured = await post(triggerPath, {
      ...rule,
      parameterMappings: { choice: { source: 'EVENT', field: 'ref' } },
    });
    const event = { eventId: 'ref-event', ref: 'refs/heads/release' };
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
    assert.equal(automated.status, 'SUCCESS');
    assert.equal(automated.outputs.choice, event.ref);
    assert.equal(automated.trigger.eventId, event.eventId);
    assert.equal(automated.trigger.ref, event.ref);
    assert.equal(
      automated.nodes.find((node: { nodeId: string }) => node.nodeId === 'no').status,
      'SKIPPED',
    );

    const clock = { id: 'clock', name: 'Started at', type: 'NUMBER', required: true };
    const deferredDefinition = {
      flows: [],
      canvas: {
        nodes: [
          { id: 'entry', type: 'START', name: 'Start' },
          { id: 'approve', type: 'APPROVAL', name: 'Approve' },
          { id: 'call-child', type: 'FLOW_CALL', name: 'Call child', flowId: 'clock-child' },
          { id: 'exit', type: 'END', name: 'End', outputs: [clock] },
          { id: 'clock-child', type: 'START', name: 'Child', inputs: [clock] },
          { id: 'clock-end', type: 'END', name: 'Child end', outputs: [clock] },
        ],
        edges: [
          { from: 'entry', to: 'approve' },
          { from: 'approve', to: 'call-child' },
          { from: 'call-child', to: 'exit' },
          { from: 'clock-child', to: 'clock-end' },
        ],
        endpoints: [
          {
            startId: 'entry',
            endId: 'exit',
            inputBindings: { 'call-child': { clock: { kind: 'CONTEXT', fieldId: 'triggeredAt' } } },
            outputBindings: { clock: { kind: 'OUTPUT', nodeId: 'call-child', fieldId: 'clock' } },
          },
          {
            startId: 'clock-child',
            endId: 'clock-end',
            outputBindings: { clock: { kind: 'INPUT', fieldId: 'clock' } },
          },
        ],
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
    await api
      .patch(prefix + triggerPath + '/' + configured.id)
      .send({
        ...rule,
        enabled: false,
        parameterMappings: { choice: { source: 'EVENT', field: 'ref' } },
      })
      .expect(200);
    const deferred = await publish(deferredDefinition);
    const deferredFlow = graph + '/flows/entry';
    const deferredArgs = { version: deferred.publishedVersion };
    const preview = await post(deferredFlow + '/preview', deferredArgs);
    const pending = await post(deferredFlow + '/run', {
      ...deferredArgs,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: preview.configurationHash,
    });
    assert.equal(pending.status, 'WAITING');
    await publish(definition);
    await post(`${graph}/versions/${deferred.publishedVersion}/retire`, {});
    const resumed = await post(`${graph}/runs/${pending.id}/nodes/approve/decision`, {
      decision: 'APPROVE',
    });
    assert.equal(resumed.status, 'SUCCESS');
    assert.ok(resumed.outputs.clock > 0);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
}

test('SQLite typed runs bind child inputs and outputs, choose result branches and map trigger events', () =>
  checkTypedRuns());
test(
  'PostgreSQL typed runs bind child inputs and outputs, choose result branches and map trigger events',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  () => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, checkTypedRuns),
);
