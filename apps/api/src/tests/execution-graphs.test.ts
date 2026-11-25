import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { initialGraphDraft } from '../core/database/execution-graphs-migration';
import type { GraphCanvas } from '../modules/execution-graphs/execution-graph-definition';
import { withIsolatedPostgres } from './helpers/isolated-postgres';

const choice = { variables: [{ key: 'CHOICE', value: 'ordinary', allowOverride: true }] };
const parameters = (value: string) => ({ 'var:CHOICE': value });

const plainBranchCanvas: GraphCanvas = {
  model: 'FLOW_V2',
  nodes: [
    { id: 'start-plain', type: 'START', name: '普通分叉', start: choice },
    {
      id: 'rules',
      type: 'CONDITION',
      name: '条件分支',
      branch: {
        parameterKey: 'CHOICE',
        cases: [
          { id: 'publish', value: 'release' },
          { id: 'verify', value: 'test' },
        ],
      },
    },
    { id: 'parallel-delay', type: 'DELAY', name: '并行等待', delaySeconds: 60 },
    { id: 'selected-path', type: 'DELAY', name: '匹配路径等待', delaySeconds: 60 },
    { id: 'default-path', type: 'LOG', name: '默认路径', message: 'default' },
    { id: 'combined', type: 'LOG', name: '下游任务', message: 'merged' },
    {
      id: 'end-plain',
      type: 'END',
      name: '结束',
    },
  ],
  edges: [
    { from: 'start-plain', to: 'rules' },
    { from: 'start-plain', to: 'parallel-delay' },
    { from: 'rules', to: 'selected-path', when: 'CASE:publish' },
    { from: 'rules', to: 'selected-path', when: 'CASE:verify' },
    { from: 'rules', to: 'default-path', when: 'DEFAULT' },
    { from: 'selected-path', to: 'combined' },
    { from: 'default-path', to: 'combined' },
    { from: 'parallel-delay', to: 'combined' },
    { from: 'combined', to: 'end-plain' },
  ],
  endpoints: [
    {
      startId: 'start-plain',
      endId: 'end-plain',
    },
  ],
  templates: [],
};

const dagCanvas: GraphCanvas = {
  model: 'FLOW_V2',
  nodes: [
    { id: 'orchestrate', type: 'START', name: '条件与并行', start: choice },
    { id: 'split', type: 'PARALLEL', name: '并行' },
    {
      id: 'choose',
      type: 'CONDITION',
      name: '判断',
      condition: { value: 'release', parameterKey: 'CHOICE' },
    },
    { id: 'yes', type: 'LOG', name: '发布分支', message: 'release-path' },
    { id: 'no', type: 'LOG', name: '常规分支', message: 'regular-path' },
    { id: 'branch-join', type: 'JOIN', name: '分支汇合' },
    { id: 'parallel-log', type: 'LOG', name: '并行记录', message: 'parallel-path' },
    { id: 'all-join', type: 'JOIN', name: '等待汇合' },
    { id: 'dag-end', type: 'END', name: '结束' },
  ],
  edges: [
    { from: 'orchestrate', to: 'split' },
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
  endpoints: [
    {
      startId: 'orchestrate',
      endId: 'dag-end',
    },
  ],
  templates: [],
};

const advancedCanvas: GraphCanvas = {
  model: 'FLOW_V2',
  nodes: [
    { id: 'advanced', type: 'START', name: '可控流程', start: choice },
    {
      id: 'switch',
      type: 'SWITCH',
      name: '选择执行路径',
      switch: { cases: ['approve', 'delay'], parameterKey: 'CHOICE' },
    },
    { id: 'approve', type: 'LOG', name: '执行命令', message: 'approved path chosen' },
    { id: 'continue', type: 'LOG', name: '继续发布', message: 'approved-path' },
    { id: 'delay', type: 'DELAY', name: '等待', delaySeconds: 60 },
    { id: 'default', type: 'LOG', name: '普通检查', message: 'default-path' },
    { id: 'join', type: 'JOIN', name: '汇合' },
    { id: 'end', type: 'END', name: '结束' },
  ],
  edges: [
    { from: 'advanced', to: 'switch' },
    { from: 'switch', to: 'approve', when: 'CASE:0' },
    { from: 'switch', to: 'delay', when: 'CASE:1' },
    { from: 'switch', to: 'default', when: 'DEFAULT' },
    { from: 'approve', to: 'continue' },
    { from: 'continue', to: 'join' },
    { from: 'delay', to: 'join' },
    { from: 'default', to: 'join' },
    { from: 'join', to: 'end' },
  ],
  endpoints: [{ startId: 'advanced', endId: 'end' }],
  templates: [],
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
    await api.get(root + '/pipelines').expect(404);
    await api.get(root + '/projects/' + id + '/runs').expect(404);
    assert.equal(initialGraph.publishedVersion, null);
    assert.equal(initialGraph.id, (await api.get(path).expect(200)).body.data.id);
    assert.notEqual(initialGraph.id, (await api.get(otherPath).expect(200)).body.data.id);
    const repairPath =
      root + '/projects/' + (await project('graph-build-path')) + '/execution-graph';
    const { revision: blankRevision } = (await api.get(repairPath).expect(200)).body.data;
    const canvas: GraphCanvas = {
      model: 'FLOW_V2',
      nodes: [
        { id: 'start', type: 'START', name: '构建' },
        {
          id: 'build',
          type: 'FUNCTION',
          operation: 'BUILD',
          name: '构建程序',
          build: { buildCommand: 'npm run build', repoPath: '../outside' },
        },
        { id: 'end', type: 'END', name: '结束' },
      ],
      edges: [
        { from: 'start', to: 'build' },
        { from: 'build', to: 'end' },
      ],
      endpoints: [{ startId: 'start', endId: 'end' }],
      templates: [],
    };
    const verifyPath = (issue: Record<string, unknown>) => {
      assert.deepEqual(
        [issue.flowId, issue.nodeId, issue.fieldId],
        ['start', 'build', 'build.repoPath'],
      );
    };
    const validation = (
      await api
        .post(repairPath + '/validate')
        .send({ definition: { canvas } })
        .expect(201)
    ).body.data;
    assert.equal(validation.issues.length, 1);
    verifyPath(validation.issues[0]);
    const incomplete = (
      await api
        .put(repairPath + '/draft')
        .send({ expectedRevision: blankRevision, definition: { canvas } })
        .expect(200)
    ).body.data;
    const reloaded = (await api.get(repairPath).expect(200)).body.data;
    assert.equal(reloaded.draft.canvas.nodes[1].build.repoPath, '../outside');
    const failed = (
      await api
        .post(repairPath + '/publish')
        .send({ expectedRevision: incomplete.revision })
        .expect(400)
    ).body.error;
    verifyPath(failed.planIssue);
    canvas.nodes[1]!.build!.repoPath = 'app';
    const repaired = (
      await api
        .put(repairPath + '/draft')
        .send({ expectedRevision: incomplete.revision, definition: { canvas } })
        .expect(200)
    ).body.data;
    await api
      .post(repairPath + '/publish')
      .send({ expectedRevision: repaired.revision })
      .expect(201);
    const runDag = async (id: string, version: number, value: string) => {
      const flowPath = otherPath + '/flows/' + id;
      const args = { version, inputs: { parameters: parameters(value) } };
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
          definition: { canvas: dagCanvas },
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
    const findNode = (
      run: { nodes: { nodeId: string; status: string; output?: Record<string, unknown> }[] },
      id: string,
    ) => run.nodes.find(({ nodeId }) => nodeId === id)!;
    const state = (run: Parameters<typeof findNode>[0], nodeId: string) =>
      findNode(run, nodeId)?.status;
    const plainPath = root + '/projects/' + (await project('plain-dag')) + '/execution-graph';
    const publishPlain = async (canvas: GraphCanvas) => {
      const { revision } = (await api.get(plainPath).expect(200)).body.data;
      const draft = (
        await api
          .put(plainPath + '/draft')
          .send({ expectedRevision: revision, definition: { canvas } })
          .expect(200)
      ).body.data;
      const { publishedVersion } = (
        await api
          .post(plainPath + '/publish')
          .send({ expectedRevision: draft.revision })
          .expect(201)
      ).body.data;
      return publishedVersion as number;
    };
    const plainFlow = plainPath + '/flows/start-plain';
    const initialPlainVersion = await publishPlain(plainBranchCanvas);
    const args = { version: initialPlainVersion, inputs: { parameters: parameters('release') } };
    const before = (
      await api
        .post(plainFlow + '/preview')
        .send(args)
        .expect(201)
    ).body.data;
    assert.equal(
      before.routing.find(({ when }: { when: string }) => when === 'CASE:publish').status,
      'CERTAIN',
    );
    assert.equal(
      before.routing.find(({ when }: { when: string }) => when === 'CASE:verify').status,
      'EXCLUDED',
    );
    const reordered = structuredClone(plainBranchCanvas);
    const rules = reordered.nodes.find(({ id }) => id === 'rules')!.branch!.cases;
    rules.reverse();
    rules[1]!.label = '新显示名称';
    args.version = await publishPlain(reordered);
    await api
      .post(plainFlow + '/run')
      .send({
        ...args,
        expectedConfigurationHash: before.configurationHash,
        idempotencyKey: randomUUID(),
      })
      .expect(409);
    const currentRoute = (
      await api
        .post(plainFlow + '/preview')
        .send(args)
        .expect(201)
    ).body.data;
    const identity = {
      ...args,
      expectedConfigurationHash: currentRoute.configurationHash,
      idempotencyKey: randomUUID(),
    };
    const pendingJoin = (
      await api
        .post(plainFlow + '/run')
        .send(identity)
        .expect(201)
    ).body.data;
    assert.equal(pendingJoin.status, 'WAITING');
    assert.equal(state(pendingJoin, 'parallel-delay'), 'WAITING');
    assert.equal(state(pendingJoin, 'combined'), 'PENDING');
    assert.equal(state(pendingJoin, 'default-path'), 'SKIPPED');
    const db = app.get(DatabaseService).db;
    const worker = app.get(TaskWorkerService);
    const wake = async (runId: string, nodeId: string) => {
      await db
        .updateTable('execution_node_runs')
        .set({ started_at: Date.now() - 61_000 })
        .where('run_id', '=', runId)
        .where('node_id', '=', nodeId)
        .execute();
      await worker.tick();
    };
    await wake(pendingJoin.id, 'selected-path');
    const stillWaiting = (await api.get(plainPath + '/runs/' + pendingJoin.id).expect(200)).body
      .data;
    assert.equal(state(stillWaiting, 'selected-path'), 'SUCCESS');
    assert.equal(state(stillWaiting, 'parallel-delay'), 'WAITING');
    assert.equal(state(stillWaiting, 'combined'), 'PENDING');
    await wake(pendingJoin.id, 'parallel-delay');
    const rerun = (
      await api
        .post(plainFlow + '/run')
        .send(identity)
        .expect(201)
    ).body.data;
    assert.equal(rerun.id, pendingJoin.id);
    assert.equal(rerun.status, 'SUCCESS');
    assert.equal(findNode(rerun, 'rules').output?.branchId, 'CASE:publish');
    assert.equal(
      rerun.nodes.filter(({ nodeId }: { nodeId: string }) => nodeId === 'combined').length,
      1,
    );
    const cancelJoin = (
      await api
        .post(plainFlow + '/run')
        .send({ ...identity, idempotencyKey: randomUUID() })
        .expect(201)
    ).body.data;
    const cancelledJoin = (
      await api
        .post(plainPath + '/runs/' + cancelJoin.id + '/cancel')
        .send({})
        .expect(201)
    ).body.data;
    assert.equal(cancelledJoin.status, 'CANCELLED');
    assert.equal(state(cancelledJoin, 'rules'), 'SUCCESS');
    assert.equal(state(cancelledJoin, 'parallel-delay'), 'CANCELLED');
    assert.equal(state(cancelledJoin, 'combined'), 'SKIPPED');
    assert.equal(state(cancelledJoin, 'end-plain'), 'SKIPPED');
    assert.equal(state(dagRun, 'yes'), 'SUCCESS');
    assert.equal(state(dagRun, 'no'), 'SKIPPED');
    assert.equal(state(dagRun, 'parallel-log'), 'SUCCESS');
    assert.equal(state(dagRun, 'all-join'), 'SUCCESS');
    assert.equal(findNode(dagRun, 'choose').output?.matched, true);
    const invalidCall = structuredClone(dagCanvas);
    const parallelEdge = invalidCall.edges.find(({ to }) => to === 'parallel-log')!;
    invalidCall.nodes.push({
      id: 'call',
      type: 'FLOW_CALL',
      name: '旧子流',
      flowId: 'child',
    });
    invalidCall.nodes.push(
      { id: 'child', type: 'START', name: 'New chain' },
      { id: 'child-end', type: 'END', name: 'New chain end' },
    );
    invalidCall.endpoints.push({ startId: 'child', endId: 'child-end' });
    parallelEdge.to = 'call';
    invalidCall.edges.push(
      { from: 'call', to: 'parallel-log' },
      { from: 'child', to: 'child-end' },
    );
    const unsupportedCall = await api
      .post(otherPath + '/validate')
      .send({ definition: { canvas: invalidCall } })
      .expect(201);
    assert.ok(
      unsupportedCall.body.data.issues.some((issue: { nodeId: string }) => issue.nodeId === 'call'),
      JSON.stringify(unsupportedCall.body),
    );
    await api
      .post(otherPath + '/extract')
      .send({})
      .expect(404);
    const flowId = 'check';
    const definition = (message: string) => ({
      canvas: {
        model: 'FLOW_V2',
        nodes: [
          { id: flowId, type: 'START', name: '核对项目' },
          { id: 'report', type: 'LOG', name: '记录结果', message },
          { id: 'end', type: 'END', name: '完成' },
        ],
        edges: [
          { from: flowId, to: 'report' },
          { from: 'report', to: 'end' },
        ],
        endpoints: [{ startId: flowId, endId: 'end' }],
        templates: [],
      },
    });
    const old = definition('first published run');
    const broken = definition('invalid');
    broken.canvas.edges.push({ from: 'end', to: flowId });
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
    const originalDraft = writes.find((r) => r.status === 200)!.body.data;
    const revision = originalDraft.revision;
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
    const nextDraft = (await save(revision, next).expect(200)).body.data;
    const nextRevision = nextDraft.revision;
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
    assert.deepEqual(pinned.definition.canvas, originalDraft.draft.canvas);
    await api.get(otherPath + '/runs/' + runId).expect(404);
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
    const restored = (
      await api
        .post(path + '/versions/1/restore')
        .send({ expectedRevision: nextRevision })
        .expect(201)
    ).body.data;
    assert.deepEqual(restored.draft.canvas, originalDraft.draft.canvas);
    assert.equal(restored.draft.canvas.endpoints[0].startId, flowId);
    assert.equal(restored.revision, nextRevision + 1);
    assert.equal(restored.publishedVersion, v2);
    await api
      .post(path + '/versions/1/restore')
      .send({ expectedRevision: nextRevision })
      .expect(409);
    assert.deepEqual(
      (await api.get(path + '/versions/2').expect(200)).body.data.definition.canvas,
      nextDraft.draft.canvas,
    );

    const advancedProject = await project('advanced-graph');
    const advancedPath = root + '/projects/' + advancedProject + '/execution-graph';
    const savedAdvanced = (
      await api
        .put(advancedPath + '/draft')
        .send({ expectedRevision: 1, definition: { canvas: advancedCanvas } })
        .expect(200)
    ).body.data;
    await api
      .post(advancedPath + '/publish')
      .send({ expectedRevision: savedAdvanced.revision })
      .expect(201);
    const start = async (value: string) => {
      const args = { version: 1, inputs: { parameters: parameters(value) } };
      const endpoint = advancedPath + '/flows/advanced';
      const preview = (
        await api
          .post(endpoint + '/preview')
          .send(args)
          .expect(201)
      ).body.data;
      return (
        await api
          .post(endpoint + '/run')
          .send({
            ...args,
            expectedConfigurationHash: preview.configurationHash,
            idempotencyKey: randomUUID(),
          })
          .expect(201)
      ).body.data;
    };
    const details = async (id: string) =>
      (await api.get(advancedPath + '/runs/' + id).expect(200)).body.data;
    const automatic = await start('ordinary');
    assert.equal(automatic.status, 'SUCCESS');
    assert.equal(findNode(automatic, 'switch').output?.matched, 'DEFAULT');
    assert.equal(findNode(automatic, 'switch').output?.branchId, 'DEFAULT');
    assert.equal(findNode(automatic, 'approve').status, 'SKIPPED');
    const selected = await start('approve');
    assert.equal(selected.status, 'SUCCESS');
    assert.equal(findNode(selected, 'switch').output?.matched, 'CASE:0');
    assert.equal(
      findNode(selected, 'switch').output?.branchId,
      'CASE:' + createHash('sha256').update('approve').digest('hex'),
    );
    assert.equal(findNode(selected, 'continue').status, 'SUCCESS');

    const waiting = await start('delay');
    assert.equal(waiting.status, 'WAITING');
    assert.equal(findNode(waiting, 'switch').output?.matched, 'CASE:1');
    const wakeAt = Number(findNode(waiting, 'delay').output?.wakeAt);
    assert.ok(wakeAt > Date.now());
    await worker.tick();
    const beforeWake = await details(waiting.id);
    assert.equal(findNode(beforeWake, 'delay').output?.wakeAt, wakeAt);
    assert.equal(beforeWake.status, 'WAITING');
    await wake(waiting.id, 'delay');
    assert.equal((await details(waiting.id)).status, 'SUCCESS');
    const cancelled = await start('delay');
    const cancelledDetail = (
      await api
        .post(advancedPath + '/runs/' + cancelled.id + '/cancel')
        .send({})
        .expect(201)
    ).body.data;
    assert.equal(cancelledDetail.status, 'CANCELLED');
    assert.equal(findNode(cancelledDetail, 'delay').status, 'CANCELLED');

    const historicProject = await project('historic-graph');
    const historicPath = root + '/projects/' + historicProject + '/execution-graph';
    const historicGraph = (await api.get(historicPath).expect(200)).body.data;
    const historicDefinition = JSON.parse(initialGraphDraft);
    const historicFlow = historicDefinition.flows[0];
    const adminId = await db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    await db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('execution_graph_versions')
        .values({
          id: randomUUID(),
          graph_id: historicGraph.id,
          version: 1,
          source_revision: historicGraph.revision,
          definition_json: initialGraphDraft,
          created_at: Date.now(),
          created_by: adminId.id,
        })
        .execute();
      await transaction
        .updateTable('execution_graphs')
        .set({ published_version: 1, draft_json: initialGraphDraft })
        .where('id', '=', historicGraph.id)
        .execute();
    });
    const historicVersion = (await api.get(historicPath + '/versions/1').expect(200)).body.data;
    assert.deepEqual(historicVersion.definition.flows[0].nodes, historicFlow.nodes);
    const unsupported = await api
      .post(historicPath + '/flows/' + historicFlow.id + '/preview')
      .send({ version: 1 })
      .expect(409);
    assert.match(unsupported.text, /FLOW_V2/);
    await api
      .post(historicPath + '/versions/1/restore')
      .send({ expectedRevision: historicGraph.revision })
      .expect(400);
    await api
      .put(historicPath + '/draft')
      .send({ expectedRevision: historicGraph.revision, definition: historicDefinition })
      .expect(400);

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
