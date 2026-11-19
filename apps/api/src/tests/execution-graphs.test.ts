import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { withIsolatedPostgres } from './helpers/isolated-postgres';

const dagDefinition = {
  flows: [
    {
      id: 'orchestrate',
      name: '条件与并行',
      nodes: [
        { id: 'dag-start', type: 'START', name: '开始' },
        { id: 'split', type: 'PARALLEL', name: '并行' },
        {
          id: 'choose',
          type: 'CONDITION',
          name: '判断',
          condition: { key: 'input', value: 'release' },
        },
        { id: 'yes', type: 'LOG', name: '发布分支', message: 'release-path' },
        { id: 'no', type: 'LOG', name: '常规分支', message: 'regular-path' },
        { id: 'branch-join', type: 'JOIN', name: '分支汇合' },
        { id: 'parallel-log', type: 'LOG', name: '并行记录', message: 'parallel-path' },
        { id: 'all-join', type: 'JOIN', name: '等待汇合' },
        { id: 'dag-end', type: 'END', name: '结束' },
      ],
      edges: [
        { from: 'dag-start', to: 'split' },
        { from: 'split', to: 'choose' },
        { from: 'choose', to: 'yes', when: 'TRUE' },
        { from: 'choose', to: 'no', when: 'FALSE' },
        { from: 'yes', to: 'branch-join' },
        { from: 'no', to: 'branch-join' },
        { from: 'branch-join', to: 'all-join' },
        { from: 'split', to: 'parallel-log' },
        { from: 'parallel-log', to: 'all-join' },
        { from: 'all-join', to: 'dag-end' },
      ],
    },
  ],
};

async function checkGraph(url?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-graph-api-'));
  const initial = randomBytes(16).toString('hex');
  const password = randomBytes(16).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: url ? 'postgres' : 'sqlite',
    ...(url && { DATABASE_URL: url }),
    DATABASE_PATH: join(dir, 'test.db'),
    DATA_DIR: dir,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: initial,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false });
  try {
    configureApp(app);
    await app.init();
    const api = request.agent(app.getHttpServer());
    const root = '/api/v1';
    await api
      .post(root + '/auth/login')
      .send({ username: 'root', password: initial })
      .expect(201);
    await api
      .post(root + '/auth/change-password')
      .send({ currentPassword: initial, newPassword: password })
      .expect(200);
    await api
      .post(root + '/auth/login')
      .send({ username: 'root', password })
      .expect(201);
    const project = async (slug: string) =>
      (
        await api
          .post(root + '/projects')
          .send({ name: slug, slug })
          .expect(201)
      ).body.data.id as string;
    const id = await project('graph-foundation');
    const other = await project('other-graph');
    const path = root + '/projects/' + id + '/execution-graph';
    const otherPath = root + '/projects/' + other + '/execution-graph';
    const initialGraph = (await api.get(path).expect(200)).body.data;
    assert.equal(initialGraph.publishedVersion, null);
    assert.equal(initialGraph.id, (await api.get(path).expect(200)).body.data.id);
    assert.notEqual(initialGraph.id, (await api.get(otherPath).expect(200)).body.data.id);
    const runDag = async (id: string, version: number, value: string) => {
      const flowPath = otherPath + '/flows/' + id;
      const args = { version, inputs: { value } };
      const preview = (
        await api
          .post(flowPath + '/preview')
          .send(args)
          .expect(201)
      ).body.data;
      const run = (
        await api
          .post(flowPath + '/run')
          .send({
            ...args,
            expectedConfigurationHash: preview.configurationHash,
            idempotencyKey: randomUUID(),
          })
          .expect(201)
      ).body.data;
      const worker = app.get(TaskWorkerService);
      for (let retry = 0; retry < 15; retry++) {
        const detail = (await api.get(otherPath + '/runs/' + run.id).expect(200)).body.data;
        if (detail.status === 'SUCCESS') return detail;
        assert.ok(
          !['FAILED', 'NEEDS_ATTENTION', 'CANCELLED'].includes(detail.status),
          JSON.stringify(detail.nodes),
        );
        await worker.tick();
        await delay(15);
      }
      assert.fail('DAG did not complete');
    };
    const otherGraph = (await api.get(otherPath).expect(200)).body.data;
    const dagDraft = (
      await api
        .put(otherPath + '/draft')
        .send({
          expectedRevision: otherGraph.revision,
          definition: dagDefinition,
        })
        .expect(200)
    ).body.data;
    const dagV1 = (
      await api
        .post(otherPath + '/publish')
        .send({ expectedRevision: dagDraft.revision })
        .expect(201)
    ).body.data.publishedVersion;
    const dagRun = await runDag('orchestrate', dagV1, 'release');
    const state = (run: { nodes: { nodeId: string; status: string }[] }, nodeId: string) =>
      run.nodes.find((node) => node.nodeId === nodeId)?.status;
    assert.equal(state(dagRun, 'yes'), 'SUCCESS');
    assert.equal(state(dagRun, 'no'), 'SKIPPED');
    assert.equal(state(dagRun, 'parallel-log'), 'SUCCESS');
    assert.equal(state(dagRun, 'all-join'), 'SUCCESS');
    const extract = {
      expectedRevision: dagDraft.revision,
      flowId: 'orchestrate',
      nodeIds: ['choose', 'yes', 'no', 'branch-join'],
      name: '可复用的判断',
      mode: 'REPLACE',
    };
    const proposed = (
      await api
        .post(otherPath + '/extract/preview')
        .send(extract)
        .expect(201)
    ).body.data;
    assert.deepEqual(proposed.entryNodeIds, ['choose']);
    assert.deepEqual(proposed.exitNodeIds, ['branch-join']);
    const replaced = (
      await api
        .post(otherPath + '/extract')
        .send(extract)
        .expect(201)
    ).body.data;
    await api
      .post(otherPath + '/extract')
      .send(extract)
      .expect(409);
    const dagV2 = (
      await api
        .post(otherPath + '/publish')
        .send({ expectedRevision: replaced.revision })
        .expect(201)
    ).body.data.publishedVersion;
    const called = await runDag('orchestrate', dagV2, 'test');
    const call = called.nodes.find((n: { type: string }) => n.type === 'FLOW_CALL');
    assert.equal(call.status, 'SUCCESS');
    assert.ok(call.childRunId);
    const child = (await api.get(otherPath + '/runs/' + call.childRunId).expect(200)).body.data;
    assert.equal(child.parentRunId, called.id);
    assert.equal(child.version, dagV2);
    assert.equal(state(child, 'yes'), 'SKIPPED');
    assert.equal(state(child, 'no'), 'SUCCESS');
    const direct = await runDag(child.flowId, dagV2, 'release');
    assert.equal(state(direct, 'yes'), 'SUCCESS');
    const calledAgain = await runDag('orchestrate', dagV2, 'release');
    const nextChild = calledAgain.nodes.find((n: { type: string }) => n.type === 'FLOW_CALL');
    assert.notEqual(nextChild.childRunId, call.childRunId);
    assert.equal(nextChild.status, 'SUCCESS');
    const cycle = structuredClone(replaced.draft);
    const recursive = cycle.flows.find((item: { id: string }) => item.id === child.flowId);
    const outgoing = recursive.edges.find((edge: { from: string }) => edge.from === 'branch-join');
    recursive.nodes.push({
      id: 'recursive-call',
      type: 'FLOW_CALL',
      name: '递归',
      flowId: 'orchestrate',
    });
    recursive.edges.push({ from: 'recursive-call', to: outgoing.to });
    outgoing.to = 'recursive-call';
    await api
      .put(otherPath + '/draft')
      .send({ expectedRevision: replaced.revision, definition: cycle })
      .expect(400);
    const flowId = 'check';
    const definition = (message: string) => ({
      flows: [
        {
          id: flowId,
          name: '核对项目',
          nodes: [
            { id: 'begin', type: 'START', name: '开始' },
            { id: 'report', type: 'LOG', name: '记录结果', message },
            { id: 'end', type: 'END', name: '完成' },
          ],
          edges: [
            { from: 'begin', to: 'report' },
            { from: 'report', to: 'end' },
          ],
        },
      ],
    });
    const old = definition('first published run');
    const broken = definition('invalid');
    broken.flows[0]!.edges.push({ from: 'end', to: 'begin' });
    await api
      .put(path + '/draft')
      .send({ expectedRevision: initialGraph.revision, definition: broken })
      .expect(400);
    const save = (expectedRevision: number, value: object) =>
      api.put(path + '/draft').send({ expectedRevision, definition: value });
    const writes = await Promise.all([
      save(initialGraph.revision, old),
      save(initialGraph.revision, old),
    ]);
    assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
    const revision = writes.find((r) => r.status === 200)!.body.data.revision;
    const publish = (expectedRevision: number) =>
      api.post(path + '/publish').send({ expectedRevision });
    await publish(initialGraph.revision).expect(409);
    const v1 = (await publish(revision).expect(201)).body.data.publishedVersion;
    assert.equal(v1, 1);
    assert.equal((await publish(revision).expect(201)).body.data.publishedVersion, v1);
    const flow = path + '/flows/' + flowId;
    const preview = (
      await api
        .post(flow + '/preview')
        .send({ version: v1 })
        .expect(201)
    ).body.data;
    const submit = (body: object) => api.post(flow + '/run').send(body);
    const input = {
      version: v1,
      expectedConfigurationHash: preview.configurationHash,
      idempotencyKey: randomUUID(),
    };
    await submit({ ...input, expectedConfigurationHash: '0'.repeat(64) }).expect(409);
    const [a, b] = await Promise.all([submit(input).expect(201), submit(input).expect(201)]);
    const runId = a.body.data.id;
    assert.equal(b.body.data.id, runId);
    const runs = (await api.get(path + '/runs').expect(200)).body.data;
    assert.deepEqual(
      runs.map((r: { id: string }) => r.id),
      [runId],
    );
    const next = definition('second published run');
    const nextRevision = (await save(revision, next).expect(200)).body.data.revision;
    const v2 = (await publish(nextRevision).expect(201)).body.data.publishedVersion;
    assert.equal(v2, 2);
    const second = (
      await api
        .post(flow + '/preview')
        .send({ version: v2 })
        .expect(201)
    ).body.data;
    await submit({
      version: v2,
      expectedConfigurationHash: second.configurationHash,
      idempotencyKey: input.idempotencyKey,
    }).expect(409);
    const secondRun = (
      await submit({
        version: v2,
        expectedConfigurationHash: second.configurationHash,
        idempotencyKey: randomUUID(),
      }).expect(201)
    ).body.data;
    assert.match(
      JSON.stringify((await api.get(path + '/runs/' + secondRun.id).expect(200)).body.data.nodes),
      /second published run/,
    );
    const previous = (await api.get(path + '/runs/' + runId).expect(200)).body.data;
    assert.equal(previous.status, 'SUCCESS');
    assert.equal(previous.version, v1);
    assert.deepEqual(
      previous.nodes.map((n: { status: string }) => n.status),
      ['SUCCESS', 'SUCCESS', 'SUCCESS'],
    );
    assert.match(
      previous.nodes.find((n: { nodeId: string }) => n.nodeId === 'report').log,
      /first published run/,
    );
    const pinned = (await api.get(path + '/versions/' + v1).expect(200)).body.data;
    assert.deepEqual(pinned.definition, old);
    await api.get(otherPath + '/runs/' + runId).expect(404);
    const db = app.get(DatabaseService).db;
    // Timestamps may tie on both databases. The opaque run cursor must preserve UUID order.
    await db
      .updateTable('execution_flow_runs')
      .set({ created_at: Date.now() })
      .where('project_id', '=', id)
      .execute();
    const orderedRuns = [runId, secondRun.id].sort().reverse();
    assert.deepEqual(
      (await api.get(path + '/runs').expect(200)).body.data.map((run: { id: string }) => run.id),
      orderedRuns,
    );
    assert.deepEqual(
      (await api.get(path + '/runs?before=' + orderedRuns[0]).expect(200)).body.data.map(
        (run: { id: string }) => run.id,
      ),
      orderedRuns.slice(1),
    );
    assert.deepEqual(
      (await api.get(path + '/runs?before=' + orderedRuns[1]).expect(200)).body.data,
      [],
    );
    await api.get(otherPath + '/runs?before=' + runId).expect(404);
    await api.get(path + '/runs?before=invalid').expect(400);
    const admin = await db
      .selectFrom('users')
      .select('password_hash')
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('users')
      .values({
        id: randomUUID(),
        username: 'graph-viewer',
        password_hash: admin.password_hash,
        role: 'VIEWER',
        status: 'ACTIVE',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    const viewer = request.agent(app.getHttpServer());
    await viewer
      .post(root + '/auth/login')
      .send({ username: 'graph-viewer', password })
      .expect(201);
    await viewer.get(path + '/runs/' + runId).expect(200);
    await viewer
      .put(path + '/draft')
      .send({ expectedRevision: nextRevision, definition: old })
      .expect(403);
    await viewer
      .post(path + '/publish')
      .send({ expectedRevision: nextRevision })
      .expect(403);
    await viewer
      .post(flow + '/run')
      .send(input)
      .expect(403);
    await api.delete(root + '/projects/' + id).expect(200);
    await api.get(path + '/runs/' + runId).expect(200);
    await submit(input).expect(404);
    const archivedWrite = await save(nextRevision, old);
    assert.ok([400, 403, 404, 409].includes(archivedWrite.status));
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('SQLite project graph saves and publishes atomically, pins historical logs and deduplicates manual runs', () =>
  checkGraph());
test(
  'PostgreSQL project graph preserves the same publication, run, and permission guarantees',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  () => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, checkGraph),
);
