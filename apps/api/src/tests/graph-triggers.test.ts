import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { withIsolatedPostgres } from './helpers/isolated-postgres';

async function verify(databaseUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-native-graph-triggers-'));
  const initial = randomBytes(20).toString('hex');
  const password = randomBytes(20).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    ...(databaseUrl && { DATABASE_URL: databaseUrl }),
    DATABASE_PATH: join(dir, 'test.db'),
    DATA_DIR: dir,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: initial,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { AuditService } = await import('../modules/audit/audit.service.js');
  const { CredentialsService } = await import('../modules/credentials/credentials.service.js');
  const { GraphTriggersService } =
    await import('../modules/execution-graphs/graph-triggers.service.js');
  const { GraphRunnerService } =
    await import('../modules/execution-graphs/graph-runner.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const { TaskHandlerRegistry } = await import('../modules/tasks/task-handler.registry.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false, rawBody: true });
  try {
    configureApp(app);
    await app.init();
    const admin = request.agent(app.getHttpServer());
    const publicApi = request(app.getHttpServer());
    const root = '/api/v1';
    await admin
      .post(root + '/auth/login')
      .send({ username: 'root', password: initial })
      .expect(201);
    await admin
      .post(root + '/auth/change-password')
      .send({ currentPassword: initial, newPassword: password })
      .expect(200);
    await admin
      .post(root + '/auth/login')
      .send({ username: 'root', password })
      .expect(201);
    const database = app.get(DatabaseService);
    const credentialValue = randomBytes(32).toString('hex');
    const credential = (
      await admin
        .post(root + '/credentials')
        .send({
          name: 'Graph signatures',
          type: 'CUSTOM_SECRET',
          secret: { value: credentialValue },
        })
        .expect(201)
    ).body.data;
    const project = (
      await admin
        .post(root + '/projects')
        .send({ name: 'Graph triggers', slug: 'graph-triggers' })
        .expect(201)
    ).body.data;
    const path = root + '/projects/' + project.id + '/execution-graph';
    const triggers = path + '/triggers';
    const makeFlow = (id: string, message: string) => ({
      id,
      name: id,
      nodes: [
        { id: id + '-start', type: 'START', name: '开始' },
        { id: id + '-log', type: 'LOG', name: '日志', message },
        { id: id + '-end', type: 'END', name: '结束' },
      ],
      edges: [
        { from: id + '-start', to: id + '-log' },
        { from: id + '-log', to: id + '-end' },
      ],
    });
    async function publish(message: string) {
      const graph = (await admin.get(path).expect(200)).body.data;
      const draft = (
        await admin
          .put(path + '/draft')
          .send({
            expectedRevision: graph.revision,
            definition: {
              flows: [makeFlow('source', message), makeFlow('target', 'after source')],
            },
          })
          .expect(200)
      ).body.data;
      return (
        await admin
          .post(path + '/publish')
          .send({ expectedRevision: draft.revision })
          .expect(201)
      ).body.data.publishedVersion as number;
    }
    const version = await publish('pinned old rule version');
    const makeRule = async (fields: Record<string, unknown>) =>
      (
        await admin
          .post(triggers)
          .send({
            name: 'Native rule',
            flowId: 'source',
            version,
            enabled: true,
            ...fields,
          })
          .expect(201)
      ).body.data;
    const manual = await makeRule({ kind: 'API', inputValue: 'preset' });
    const signed = await makeRule({ kind: 'WEBHOOK', credentialId: credential.id });
    const scheduled = await makeRule({
      kind: 'CRON',
      cron: '15 9 * * *',
      timeZone: 'Asia/Shanghai',
    });
    const upstream = await makeRule({
      kind: 'UPSTREAM',
      flowId: 'target',
      upstreamFlowId: 'source',
      upstreamStatus: 'SUCCESS',
    });
    await admin
      .post(triggers)
      .send({
        name: 'Cyclic',
        kind: 'UPSTREAM',
        flowId: 'source',
        upstreamFlowId: 'target',
        upstreamStatus: 'SUCCESS',
        version,
        enabled: true,
      })
      .expect(400);
    assert.equal(new Date(scheduled.nextAt).getUTCHours(), 1);
    assert.equal(new Date(scheduled.nextAt).getUTCMinutes(), 15);
    assert.equal(signed.credentialNonce, undefined);
    await publish('new visual version');

    await publicApi
      .post(triggers + '/' + manual.id + '/invoke')
      .send({ eventId: 'api-once' })
      .expect(401);
    const entered = (
      await admin
        .post(triggers + '/' + manual.id + '/invoke')
        .send({ eventId: 'api-once', inputValue: 'event override' })
        .expect(202)
    ).body.data;
    const replay = (
      await admin
        .post(triggers + '/' + manual.id + '/invoke')
        .send({ eventId: 'api-once', inputValue: 'event override' })
        .expect(202)
    ).body.data;
    assert.equal(entered.id, replay.id);
    await admin
      .post(triggers + '/' + manual.id + '/invoke')
      .send({ eventId: 'api-once', inputValue: 'other event' })
      .expect(409);

    const body = JSON.stringify({ inputValue: 'signed event' });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signing = (eventId: string, at = timestamp) =>
      'sha256=' +
      createHmac('sha256', credentialValue)
        .update(at + '.' + eventId + '.' + body)
        .digest('hex');
    const deliver = (eventId: string, signature: string, at = timestamp, raw = body) =>
      publicApi
        .post(root + '/graph-webhooks/' + signed.id)
        .set('x-veyops-timestamp', at)
        .set('x-veyops-delivery', eventId)
        .set('x-veyops-signature', signature)
        .type('json')
        .send(raw);
    await deliver(
      'signed-once',
      signing('signed-once'),
      timestamp,
      JSON.stringify({ inputValue: 'body tampered' }),
    ).expect(401);
    const expired = String(Number(timestamp) - 601);
    await deliver('too-old', signing('too-old', expired), expired).expect(401);
    const hook = (await deliver('signed-once', signing('signed-once')).expect(202)).body.data;
    assert.equal(
      (await deliver('signed-once', signing('signed-once')).expect(202)).body.data.id,
      hook.id,
    );
    const shadow = new GraphTriggersService(
      database,
      app.get(GraphRunnerService),
      app.get(CredentialsService),
      app.get(AuditService),
      app.get(TaskHandlerRegistry),
    );
    const worker = app.get(TaskWorkerService);
    await Promise.all([worker.tick(), shadow.tick()]);
    async function events(id: string) {
      return (await admin.get(triggers + '/' + id + '/events').expect(200)).body.data;
    }
    for (const [id, kind, expectedValue] of [
      [manual.id, 'API', 'event override'],
      [signed.id, 'WEBHOOK', 'signed event'],
    ]) {
      const rows = await events(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'QUEUED');
      const run = (await admin.get(path + '/runs/' + rows[0].runId).expect(200)).body.data;
      assert.equal(run.triggerType, kind);
      assert.equal(run.version, version);
      assert.equal(run.status, 'SUCCESS');
      assert.equal(run.inputs.value, expectedValue);
      assert.equal(run.nodes[1].log, 'pinned old rule version');
    }
    const store = app.get(GraphTriggersService);
    await Promise.all([store.tick(scheduled.nextAt), shadow.tick(scheduled.nextAt)]);
    const cron = await events(scheduled.id);
    assert.equal(cron.length, 1);
    assert.equal(cron[0].eventId, String(scheduled.nextAt));
    const cronRun = (await admin.get(path + '/runs/' + cron[0].runId).expect(200)).body.data;
    assert.equal(cronRun.triggerType, 'CRON');
    await store.tick();
    const follow = await events(upstream.id);
    assert.equal(follow.length, 3);
    for (const event of follow) {
      const run = (await admin.get(path + '/runs/' + event.runId).expect(200)).body.data;
      assert.equal(run.triggerType, 'UPSTREAM');
      assert.equal(run.flowId, 'target');
    }
    await Promise.all([store.tick(), shadow.tick()]);
    assert.equal((await events(upstream.id)).length, 3);

    await admin
      .post(triggers + '/' + manual.id + '/invoke')
      .send({ eventId: 'disable-before-dispatch' })
      .expect(202);
    await admin
      .patch(triggers + '/' + manual.id)
      .send({
        name: 'Native rule',
        kind: 'API',
        flowId: 'source',
        version,
        enabled: false,
        inputValue: 'preset',
      })
      .expect(200);
    await store.tick();
    assert.equal(
      (await events(manual.id)).find(
        (row: { eventId: string }) => row.eventId === 'disable-before-dispatch',
      ).status,
      'REJECTED',
    );
    await admin
      .post(triggers + '/' + manual.id + '/invoke')
      .send({ eventId: 'disabled' })
      .expect(404);
    await admin
      .patch(root + '/credentials/' + credential.id)
      .send({ secret: { value: randomBytes(32).toString('hex') } })
      .expect(200);
    await deliver('old-key', signing('old-key')).expect(401);
    const projectRuns = (
      await database.db
        .selectFrom('execution_flow_runs')
        .select('id')
        .where('project_id', '=', project.id)
        .execute()
    ).length;
    assert.equal(projectRuns, 6);
    assert.equal(JSON.stringify(await events(signed.id)).includes(credentialValue), false);

    // A deleted START no longer owns an active trigger. Rules for retained STARTs stay pinned.
    const adapted = (await admin.get(path).expect(200)).body.data;
    const canvas = adapted.draft.canvas;
    const withoutSource = {
      ...canvas,
      nodes: canvas.nodes.filter(({ id }: { id: string }) => id !== 'source'),
      edges: canvas.edges.filter(({ from }: { from: string }) => from !== 'source'),
      endpoints: canvas.endpoints.filter(
        ({ startId }: { startId: string }) => startId !== 'source',
      ),
    };
    const saved = (
      await admin
        .put(path + '/draft')
        .send({
          expectedRevision: adapted.revision,
          definition: { flows: [], canvas: withoutSource },
        })
        .expect(200)
    ).body.data;
    assert.deepEqual(
      saved.draft.flows.map(({ id }: { id: string }) => id),
      ['target'],
    );
    await admin
      .post(path + '/publish')
      .send({ expectedRevision: saved.revision })
      .expect(201);
    const rules = (await admin.get(triggers).expect(200)).body.data;
    assert.equal(rules.find(({ id }: { id: string }) => id === scheduled.id).enabled, false);
    const retained = rules.find(({ id }: { id: string }) => id === upstream.id);
    assert.equal(retained.enabled, true);
    assert.equal(retained.version, version);
    await admin
      .patch(triggers + '/' + manual.id)
      .send({ name: 'Enable orphan', kind: 'API', flowId: 'source', version, enabled: true })
      .expect(409);
    const keptHistory = (
      await admin.get(path + '/runs/' + (await events(signed.id))[0].runId).expect(200)
    ).body.data;
    assert.equal(keptHistory.version, version);
    assert.equal(keptHistory.nodes[1].log, 'pinned old rule version');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('SQLite native graph triggers pin versions and deduplicate schedules and signed events', () =>
  verify());
test(
  'PostgreSQL graph triggers atomically submit across competing workers',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  () => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, verify),
);
