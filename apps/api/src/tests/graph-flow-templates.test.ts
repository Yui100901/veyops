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
import type { GraphCanvas } from '../modules/execution-graphs/execution-graph-definition';
import { withIsolatedPostgres } from './helpers/isolated-postgres';

async function checkTemplates(databaseUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-graph-templates-'));
  const password = randomBytes(16).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    ...(databaseUrl && { DATABASE_URL: databaseUrl }),
    DATABASE_PATH: join(dir, 'test.db'),
    DATA_DIR: dir,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: password,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { AuditService } = await import('../modules/audit/audit.service.js');
  const { compileCanvas } = await import('../modules/execution-graphs/execution-graph-canvas.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false });
  try {
    configureApp(app);
    await app.init();
    const root = '/api/v1';
    const api = request.agent(app.getHttpServer());
    await api.post(`${root}/auth/login`).send({ username: 'root', password }).expect(201);
    const createProject = (slug: string) => api.post(`${root}/projects`).send({ name: slug, slug });
    const project = (await createProject('template-fixture').expect(201)).body.data;
    const path = `${root}/projects/${project.id}/execution-graph`;
    const draft = (await api.get(path).expect(200)).body.data;
    assert.equal(draft.revision, 1);
    assert.equal(draft.publishedVersion, null);
    const seed: GraphCanvas = draft.draft.canvas;
    assert.equal(seed.model, 'FLOW_V2');
    assert.equal(seed.endpoints.length, 1);
    assert.deepEqual(
      seed.nodes.map((node) => node.operation ?? node.type),
      ['START', 'CHECKOUT', 'BUILD', 'DEPLOY_ARTIFACT', 'END'],
    );
    assert.equal(seed.edges.length, 4);
    assert.equal(seed.nodes[0]?.start?.execution?.location, 'INHERIT');
    assert.equal(seed.nodes[4]?.finish?.saveWorkspace, true);
    assert.equal(seed.nodes[4]?.finish?.requireRelease, 'ACTIVATED');
    assert.ok(
      seed.nodes.every(({ inputs, outputs }) => inputs === undefined && outputs === undefined),
    );
    assert.equal(seed.endpoints[0]?.inputBindings, undefined);
    assert.deepEqual((await api.get(path).expect(200)).body.data, draft);
    assert.deepEqual((await api.get(`${path}/runs`).expect(200)).body.data, []);
    const { flowTemplates } = (await api.get(`${path}/catalog`).expect(200)).body.data;
    assert.deepEqual(
      flowTemplates.map(({ id }: { id: string }) => id),
      ['MINIMAL_CI_CD', 'CI_BUILD', 'CD_DEPLOY'],
    );

    const expand = `${path}/draft/templates/expand`;
    const payload = { templateId: 'CD_DEPLOY' };
    const [left, right] = await Promise.all([
      api.post(expand).send(payload).expect(201),
      api.post(expand).send(payload).expect(201),
    ]);
    assert.equal(left.body.data.canvas.model, 'FLOW_V2');
    assert.equal(left.body.data.canvas.nodes.at(-1).finish.requireRelease, 'HEALTHY');
    assert.notEqual(left.body.data.startId, right.body.data.startId);
    assert.ok(
      left.body.data.canvas.nodes.some(
        (node: { id: string }) => node.id === left.body.data.startId,
      ),
    );
    const leftIds = new Set(left.body.data.canvas.nodes.map((node: { id: string }) => node.id));
    assert.ok(right.body.data.canvas.nodes.every((node: { id: string }) => !leftIds.has(node.id)));
    const invalidId = await api
      .post(expand)
      .send({ ...payload, templateId: 'INVALID' })
      .expect(400);
    const invalidType = await api
      .post(expand)
      .send({ ...payload, artifactType: null })
      .expect(400);
    assert.equal(invalidId.body.error.details.fieldErrors[0].path[0], 'templateId');
    assert.equal(invalidType.body.error.details.fieldErrors[0].path[0], 'artifactType');
    assert.deepEqual((await api.get(path).expect(200)).body.data, draft);
    assert.deepEqual((await api.get(`${path}/runs`).expect(200)).body.data, []);

    const viewerPassword = randomBytes(16).toString('hex');
    await api
      .post(`${root}/users`)
      .send({ username: 'template-viewer', password: viewerPassword, role: 'VIEWER' })
      .expect(201);
    const viewer = request.agent(app.getHttpServer());
    const changedPassword = randomBytes(16).toString('hex');
    await viewer
      .post(`${root}/auth/login`)
      .send({ username: 'template-viewer', password: viewerPassword })
      .expect(201);
    await viewer
      .post(`${root}/auth/change-password`)
      .send({ currentPassword: viewerPassword, newPassword: changedPassword })
      .expect(200);
    await viewer
      .post(`${root}/auth/login`)
      .send({ username: 'template-viewer', password: changedPassword })
      .expect(201);
    await viewer.get(`${path}/catalog`).expect(200);
    await viewer.post(expand).send(payload).expect(403);

    const save = (canvas: GraphCanvas, expectedRevision: number) =>
      api.put(`${path}/draft`).send({ expectedRevision, definition: { canvas } });
    const saved = (await save(seed, draft.revision).expect(200)).body.data;
    await save(seed, draft.revision).expect(409);
    const { issues } = (
      await api
        .post(`${path}/validate`)
        .send({ definition: { canvas: seed } })
        .expect(201)
    ).body.data;
    assert.deepEqual(
      issues.map(
        ({ flowId, nodeId, fieldId }: { flowId: string; nodeId: string; fieldId: string }) => ({
          flowId,
          nodeId,
          fieldId,
        }),
      ),
      [
        {
          flowId: seed.nodes[0]!.id,
          nodeId: seed.nodes[0]!.id,
          fieldId: 'start.sources.source.repositoryId',
        },
      ],
    );
    await api.post(`${path}/publish`).send({ expectedRevision: saved.revision }).expect(400);

    const repository = (
      await api
        .post(`${root}/projects/${project.id}/repositories`)
        .send({ name: 'Template Git', cloneUrl: 'https://git.example.test/project.git' })
        .expect(201)
    ).body.data;
    const service = (
      await api
        .post(`${root}/projects/${project.id}/services`)
        .send({ name: 'Template service', slug: 'template' })
        .expect(201)
    ).body.data;
    const credential = (
      await api
        .post(`${root}/credentials`)
        .send({ name: 'Template SSH', type: 'SSH_PASSWORD', secret: { password: 'fixture' } })
        .expect(201)
    ).body.data;
    const target = (
      await api
        .post(`${root}/servers`)
        .send({
          name: 'Template target',
          host: 'ssh.example.test',
          port: 22,
          username: 'template',
          credentialId: credential.id,
          hostKeyFingerprint: 'a'.repeat(64),
        })
        .expect(201)
    ).body.data;
    const ready = structuredClone(seed);
    const start = ready.nodes[0]!.start!;
    start.sources![0]!.repositoryId = repository.id;
    ready.nodes[2]!.build = { repoPath: 'project', buildCommand: 'mkdir -p dist' };
    start.release = {
      serviceId: service.id,
      targets: { serverIds: [target.id] },
      deployPath: '/tmp/veyops-flow-template-fixture',
    };
    const missingSelection = await api
      .post(`${path}/validate`)
      .send({ definition: { canvas: ready } })
      .expect(201);
    assert.equal(missingSelection.body.data.issues[0].fieldId, 'start.release.contentPath');
    start.release.contentPath = 'project/dist/';
    const readyDraft = (await save(ready, saved.revision).expect(200)).body.data;
    const published = (
      await api.post(`${path}/publish`).send({ expectedRevision: readyDraft.revision }).expect(201)
    ).body.data;
    assert.equal(published.publishedVersion, 1);

    const ci: GraphCanvas = (
      await api.post(expand).send({ templateId: 'CI_BUILD', artifactType: 'DIRECTORY' }).expect(201)
    ).body.data.canvas;
    const check = ci.nodes.find(({ operation }) => operation === 'CHECK')!;
    const build = ci.nodes.find(({ operation }) => operation === 'BUILD')!;
    ci.nodes.find(({ type }) => type === 'START')!.start!.sources![0]!.repositoryId = repository.id;
    check.shell = { ...check.shell, directory: 'project', command: 'test -d .' };
    build.build = { repoPath: 'project', buildCommand: 'mkdir -p dist' };
    const ciValidated = await api
      .post(`${path}/validate`)
      .send({ definition: { canvas: ci } })
      .expect(201);
    assert.deepEqual(ciValidated.body.data.issues, []);
    const ciDraft = (await save(ci, published.revision).expect(200)).body.data;
    const ciPublished = (
      await api.post(`${path}/publish`).send({ expectedRevision: ciDraft.revision }).expect(201)
    ).body.data;
    const mixed: GraphCanvas = {
      nodes: [
        { id: 'old-start', name: '已有流程', type: 'START' },
        { id: 'old-log', name: '原节点', type: 'LOG', message: '原配置' },
        { id: 'old-end', name: '原结束', type: 'END' },
        ...ci.nodes.map((node) => ({ ...node, model: 'FLOW_V2' as const })),
      ],
      edges: [
        { from: 'old-start', to: 'old-log' },
        { from: 'old-log', to: 'old-end' },
        ...ci.edges,
      ],
      endpoints: [
        { startId: 'old-start', endId: 'old-end', serviceId: service.id },
        ...ci.endpoints,
      ],
      templates: [],
    };
    const db = app.get(DatabaseService).db;
    await save(mixed, ciPublished.revision).expect(400);
    await api
      .post(`${path}/catalog`)
      .send({ definition: { canvas: mixed } })
      .expect(404);
    await api.get(`${path}/migration`).expect(404);
    const validation = (
      await api
        .post(`${path}/validate`)
        .send({ definition: { canvas: mixed } })
        .expect(201)
    ).body.data;
    assert.match(validation.issues[0].message, /FLOW_V2/);
    const graph = await db
      .selectFrom('execution_graphs')
      .selectAll()
      .where('project_id', '=', project.id)
      .executeTakeFirstOrThrow();
    const author = await db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    const oldVersion = ciPublished.publishedVersion + 1;
    const oldDefinition = JSON.stringify(compileCanvas(mixed, true));
    await db
      .insertInto('execution_graph_versions')
      .values({
        id: randomUUID(),
        graph_id: graph.id,
        version: oldVersion,
        source_revision: ciPublished.revision + 1,
        definition_json: oldDefinition,
        created_by: author.id,
        created_at: Date.now(),
      })
      .execute();
    await db
      .updateTable('execution_graphs')
      .set({ draft_json: oldDefinition, published_version: oldVersion })
      .where('id', '=', graph.id)
      .execute();
    const historical = (await api.get(`${path}/versions/${oldVersion}`).expect(200)).body.data;
    assert.equal(historical.definition.flows[0].serviceId, service.id);
    assert.equal(historical.definition.flows[0].nodes[1].message, '原配置');
    const delivery = (await api.get(`${root}/delivery-flows`).expect(200)).body.data;
    assert.deepEqual(
      delivery.find(({ projectId }: { projectId: string }) => projectId === project.id).flows,
      [],
    );
    await api
      .post(`${path}/publication-impact`)
      .send({ expectedRevision: ciPublished.revision })
      .expect(400);
    await api.post(`${path}/publish`).send({ expectedRevision: ciPublished.revision }).expect(400);
    await api
      .post(`${path}/versions/${oldVersion}/restore`)
      .send({ expectedRevision: ciPublished.revision })
      .expect(400);
    await api.post(`${path}/flows/old-start/preview`).send({ version: oldVersion }).expect(409);
    await api
      .post(`${path}/flows/${ci.endpoints[0]!.startId}/preview`)
      .send({ version: oldVersion })
      .expect(409);
    await api
      .post(`${path}/flows/old-start/run`)
      .send({
        version: oldVersion,
        expectedConfigurationHash: 'a'.repeat(64),
        idempotencyKey: 'old',
      })
      .expect(409);
    await api
      .post(`${path}/flows/old-start/run-defaults`)
      .send({ version: oldVersion, idempotencyKey: 'old-defaults' })
      .expect(409);
    await api
      .post(`${path}/triggers`)
      .send({ kind: 'API', name: '旧触发器', flowId: 'old-start', enabled: true })
      .expect(409);
    await api
      .post(`${path}/triggers`)
      .send({ kind: 'API', name: '旧触发器草稿', flowId: 'old-start', enabled: false })
      .expect(400);
    await db
      .updateTable('execution_graphs')
      .set({ draft_json: graph.draft_json, published_version: graph.published_version })
      .where('id', '=', graph.id)
      .execute();

    const audit = app.get(AuditService);
    const record = audit.record;
    audit.record = async (...args) => {
      if (args[1] === 'project.create') throw new Error('fixture transaction rollback');
      return record.apply(audit, args);
    };
    try {
      await createProject('template-rollback').expect(500);
    } finally {
      audit.record = record;
    }
    assert.equal(
      await db
        .selectFrom('projects')
        .select('id')
        .where('slug', '=', 'template-rollback')
        .executeTakeFirst(),
      undefined,
    );
    const graphs = await db.selectFrom('execution_graphs').select('project_id').execute();
    assert.deepEqual(graphs, [{ project_id: project.id }]);
    await api.delete(`${root}/projects/${project.id}`).expect(200);
    await api.post(expand).send(payload).expect(404);
  } finally {
    await app.close();
    await rm(dir, { force: true, recursive: true });
  }
}

test('SQLite flow templates seed drafts and expand independently without writes', () =>
  checkTemplates());
test(
  'PostgreSQL flow templates seed drafts and expand independently without writes',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  () => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, checkTemplates),
);
