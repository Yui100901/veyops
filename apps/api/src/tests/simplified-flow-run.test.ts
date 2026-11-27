import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { GraphCanvas } from '../modules/execution-graphs/execution-graph-definition';
import { flowTarget } from './helpers/flow-target';

test('SQLite FLOW_V2 pins the server, rejects split releases, and plans both Compose images', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-simplified-run-'));
  const password = randomBytes(16).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: 'sqlite',
    DATABASE_PATH: join(directory, 'test.db'),
    DATA_DIR: directory,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: password,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { RepositoryMetadataService } =
    await import('../modules/projects/repository-metadata.service.js');
  const { PipelinesService } = await import('../modules/pipelines/pipelines.service.js');
  const { SimplifiedFlowRunService } =
    await import('../modules/execution-graphs/simplified-flow-run.service.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false });
  try {
    configureApp(app);
    await app.init();
    const api = request.agent(app.getHttpServer());
    const root = '/api/v1';
    const post = async (path: string, value: object) =>
      (
        await api
          .post(root + path)
          .send(value)
          .expect(201)
      ).body.data;
    await post('/auth/login', { username: 'root', password });
    const a = await flowTarget(api);
    const b = await flowTarget(api, false, '127.0.0.2');
    const project = await post('/projects', { name: 'Fixture', slug: 'fixture' });
    const path = '/projects/' + project.id;
    const graph = path + '/execution-graph';
    const repository = await post(path + '/repositories', {
      name: 'App',
      cloneUrl: 'https://example.invalid/app.git',
    });
    const service = await post(path + '/services', { name: 'App', slug: 'app' });
    t.mock.method(app.get(RepositoryMetadataService), 'planGraphCheckout', async () => ({
      repositoryId: repository.id,
      repositoryName: 'App',
      ref: 'refs/heads/main',
      branch: 'main',
      commitSha: 'd'.repeat(40),
      fullClone: false,
      access: { clone_url: 'https://example.invalid/app.git', credential_id: null },
    }));
    const releases = t.mock.method(app.get(PipelinesService), 'previewArtifactDeployPlan');

    const canvas: GraphCanvas = {
      model: 'FLOW_V2',
      nodes: [
        {
          id: 'start',
          name: '构建与发布',
          type: 'START',
          start: {
            execution: { serverId: a },
            sources: [{ id: 'monorepo', repositoryId: repository.id }],
            release: {
              serviceId: service.id,
              compose: { path: 'app/compose.yaml' },
              imageIds: ['frontend', 'backend'],
            },
          },
        },
        { id: 'checkout', name: '检出', type: 'CHECKOUT' },
        {
          id: 'front-image',
          name: '构建前端',
          type: 'BUILD',
          build: { repoPath: 'app/frontend', dockerfilePath: 'Dockerfile' },
        },
        {
          id: 'back-image',
          name: '构建后端',
          type: 'BUILD',
          build: { repoPath: 'app/backend', dockerfilePath: 'Dockerfile' },
        },
        { id: 'release', name: '发布', type: 'DEPLOY_ARTIFACT', deploy: { method: 'COMPOSE' } },
        {
          id: 'end',
          name: '结束',
          type: 'END',
          finish: {
            saveWorkspace: false,
            images: [
              {
                id: 'frontend',
                name: 'fixture/front',
                source: 'BUILT_IN',
                buildNodeId: 'front-image',
              },
              {
                id: 'backend',
                name: 'fixture/back',
                source: 'BUILT_IN',
                buildNodeId: 'back-image',
              },
            ],
          },
        },
      ],
      edges: [
        { from: 'start', to: 'checkout' },
        { from: 'checkout', to: 'front-image' },
        { from: 'checkout', to: 'back-image' },
        { from: 'front-image', to: 'release' },
        { from: 'back-image', to: 'release' },
        { from: 'release', to: 'end' },
      ],
      endpoints: [{ startId: 'start', endId: 'end' }],
      templates: [],
    };
    const draft = (await api.get(root + graph).expect(200)).body.data;
    const save = (current: GraphCanvas) =>
      api.put(root + graph + '/draft').send({
        expectedRevision: draft.revision,
        definition: { canvas: current },
      });
    const split = structuredClone(canvas);
    Object.assign(split.nodes[0]!.start!.release!, { targets: { serverIds: [b] } });
    await save(split).expect(400);
    Object.assign(split.nodes[0]!.start!.execution!, { location: 'MANAGER' });
    await save(split).expect(400);
    const saved = (await save(canvas).expect(200)).body.data;
    const { publishedVersion: version } = await post(graph + '/publish', {
      expectedRevision: saved.revision,
    });
    const args = { version };
    const endpoint = graph + '/flows/start';
    const preview = await post(endpoint + '/preview', args);
    assert.equal(preview.simplified.location, 'TARGET');
    assert.equal(preview.simplified.serverId, a);
    assert.equal(preview.simplified.workspaceRetention, 'OFF');
    assert.deepEqual(preview.simplified.release.serverIds, [a]);
    assert.deepEqual(preview.simplified.release.images, [
      { id: 'frontend', name: 'fixture/front' },
      { id: 'backend', name: 'fixture/back' },
    ]);
    assert.deepEqual(releases.mock.calls[0]?.arguments[2]?.delivery?.imageBindings, {
      VEYOPS_IMAGE_FRONTEND: 'fixture/front',
      VEYOPS_IMAGE_BACKEND: 'fixture/back',
    });
    await post(endpoint + '/run', {
      ...args,
      expectedConfigurationHash: preview.configurationHash,
      expectedPlanSections: preview.planSections,
      idempotencyKey: randomUUID(),
    });

    const db = app.get(DatabaseService).db;
    const published = await db
      .selectFrom('execution_graph_versions')
      .select(['id', 'definition_json'])
      .where('graph_id', '=', draft.id)
      .where('version', '=', version)
      .executeTakeFirstOrThrow();
    const definition = JSON.parse(published.definition_json);
    const oldStart = definition.flows[0].nodes.find(
      ({ id }: { id: string }) => id === 'start',
    ).start;
    const oldFinish = definition.flows[0].nodes.find(
      ({ id }: { id: string }) => id === 'end',
    ).finish;
    const replaceProjection = async () =>
      db
        .updateTable('execution_graph_versions')
        .set({ definition_json: JSON.stringify(definition) })
        .where('id', '=', published.id)
        .execute();
    oldFinish.saveWorkspace = true;
    oldFinish.retention = 'RUN';
    await replaceProjection();
    const reusable = await post(endpoint + '/preview', args);
    assert.equal(reusable.simplified.workspaceRetention, 'PERSISTENT');
    assert.equal(Object.hasOwn(reusable.simplified.finish, 'retention'), false);
    const stored = await db
      .selectFrom('execution_graph_versions')
      .select('definition_json')
      .where('id', '=', published.id)
      .executeTakeFirstOrThrow();
    assert.equal(stored.definition_json, JSON.stringify(definition));
    oldStart.release.targets = { serverIds: [b] };
    await replaceProjection();
    const incompatible = (
      await api
        .post(root + endpoint + '/preview')
        .send(args)
        .expect(400)
    ).body;
    assert.equal(incompatible.error.planIssue.fieldId, 'start.execution.serverId');
    delete oldStart.release.targets;
    oldStart.execution = { location: 'MANAGER' };
    await replaceProjection();
    await api.get(root + graph + '/versions/' + version).expect(200);
    await api
      .post(root + endpoint + '/preview')
      .send(args)
      .expect(400);

    delete canvas.nodes[0]!.start!.execution;
    const runtimeDraft = (
      await api
        .put(root + graph + '/draft')
        .send({
          expectedRevision: saved.revision,
          definition: { canvas },
        })
        .expect(200)
    ).body.data;
    const runtimeRelease = await post(graph + '/publish', {
      expectedRevision: runtimeDraft.revision,
    });
    const runtimeVersion = runtimeRelease.publishedVersion;
    const defaults = await post(endpoint + '/run-defaults', {
      version: runtimeVersion,
      idempotencyKey: randomUUID(),
    });
    assert.equal(defaults.outcome, 'NEEDS_CONFIRMATION');
    const parameters = { version: runtimeVersion, inputs: { serverIds: [b, a] } };
    const batch = await post(endpoint + '/preview-targets', parameters);
    assert.deepEqual(
      batch.targets.map(
        ({
          serverId,
          preview,
        }: {
          serverId: string;
          preview: { simplified: { serverId: string; release: { serverIds: string[] } } };
        }) => [serverId, preview.simplified.serverId, preview.simplified.release.serverIds],
      ),
      [a, b].sort().map((id) => [id, id, [id]]),
    );
    const startBatch = {
      ...parameters,
      expectedConfigurationHash: batch.configurationHash,
      idempotencyKey: randomUUID(),
    };
    const planner = app.get(SimplifiedFlowRunService);
    const confirm = planner.confirm.bind(planner);
    const failed = t.mock.method(
      planner,
      'confirm',
      async (...params: Parameters<typeof confirm>) => {
        const placement = params[1].placement;
        if (placement.location === 'TARGET' && placement.target.id === [a, b].sort().at(-1))
          throw new ConflictException('测试目标已变化');
        return confirm(...params);
      },
    );
    await api
      .post(root + endpoint + '/run-targets')
      .send(startBatch)
      .expect(409);
    const queued = () =>
      db
        .selectFrom('execution_flow_runs')
        .select(['id', 'execution_server_id'])
        .where('project_id', '=', project.id)
        .where('version', '=', runtimeVersion)
        .execute();
    assert.deepEqual(await queued(), []);
    failed.mock.restore();

    const started = await post(endpoint + '/run-targets', startBatch);
    assert.deepEqual(await post(endpoint + '/run-targets', startBatch), started);
    assert.deepEqual(
      (await queued()).map((row) => [row.execution_server_id, row.id]).sort(),
      started.runs.map(({ serverId, runId }: { serverId: string; runId: string }) => [
        serverId,
        runId,
      ]),
    );
    await api
      .post(root + endpoint + '/run-targets')
      .send({ ...startBatch, inputs: { serverIds: [a] } })
      .expect(409);

    canvas.nodes[0]!.start!.execution = { serverIds: [a, b] };
    const fixedDraft = await api
      .put(root + graph + '/draft')
      .send({
        expectedRevision: runtimeDraft.revision,
        definition: { canvas },
      })
      .expect(200);
    const fixedRelease = await post(graph + '/publish', {
      expectedRevision: fixedDraft.body.data.revision,
    });
    const fixedArgs = { version: fixedRelease.publishedVersion };
    const fixedBatch = await post(endpoint + '/preview-targets', fixedArgs);
    assert.deepEqual(
      fixedBatch.targets.map(({ serverId }: { serverId: string }) => serverId),
      [a, b].sort(),
    );
    await api
      .post(root + endpoint + '/preview-targets')
      .send({ ...fixedArgs, inputs: { serverIds: [a] } })
      .expect(400);
    await api
      .post(root + endpoint + '/preview')
      .send({ ...fixedArgs, inputs: { serverIds: [a] } })
      .expect(400);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
