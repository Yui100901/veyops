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
  const { flowSelection } = await import('../modules/execution-graphs/graph-run-lifecycle.js');
  const entryNames = ['构建并部署', '仅构建', '仅部署'];
  const assertSharedCanvas = (canvas: GraphCanvas, startId: string, complete: boolean) => {
    assert.equal(canvas.model, 'FLOW_V2');
    assert.equal(canvas.nodes.length, complete ? 11 : 8);
    assert.equal(canvas.edges.length, complete ? 10 : 7);
    assert.equal(canvas.endpoints.length, 3);
    assert.equal(canvas.endpoints[0]?.startId, startId);
    assert.equal(canvas.endpoints[0]?.endId, canvas.endpoints[2]?.endId);
    assert.notEqual(canvas.endpoints[0]?.endId, canvas.endpoints[1]?.endId);
    const { flows } = compileCanvas(canvas, false);
    assert.deepEqual(
      flows.map(({ name }) => name),
      entryNames,
    );
    const build = ['CHECKOUT', ...(complete ? ['CHECK'] : []), 'BUILD'];
    const release = [
      ...(complete ? ['APPROVAL'] : []),
      'DEPLOY_ARTIFACT',
      ...(complete ? ['HEALTH_CHECK'] : []),
    ];
    assert.deepEqual(
      flows.map((flow) => {
        const { ordered, selected, incoming } = flowSelection(flow, {});
        assert.equal(ordered.length, selected.size);
        for (const [index, node] of ordered.slice(1).entries()) {
          assert.deepEqual(
            incoming.get(node.id)?.map(({ from }) => from),
            [ordered[index]!.id],
          );
        }
        return ordered.map(({ type }) => type);
      }),
      [
        ['START', ...build, ...release, 'END'],
        ['START', ...build, 'END'],
        ['START', ...release, 'END'],
      ],
    );
    const [delivery, buildOnly, releaseOnly] = flows;
    assert.equal(delivery?.nodes.at(-1)?.name, '发布结束');
    assert.equal(buildOnly?.nodes.at(-1)?.name, '构建结束');
    assert.equal(releaseOnly?.nodes.at(-1)?.name, '发布结束');
    assert.equal(releaseOnly?.nodes[0]?.start?.release?.artifactSource, 'RUN_PARAMETER');
    assert.equal(releaseOnly?.nodes[0]?.start?.release?.artifactId, undefined);
  };
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
    async function projectCatalog() {
      const { body } = await api.get(`${root}/delivery-flows`).expect(200);
      return body.data.find(({ projectId }: { projectId: string }) => projectId === project.id);
    }
    const draft = (await api.get(path).expect(200)).body.data;
    assert.equal(draft.revision, 1);
    assert.equal(draft.publishedVersion, null);
    const seed: GraphCanvas = draft.draft.canvas;
    assertSharedCanvas(seed, seed.nodes[0]!.id, false);
    assert.equal(seed.nodes[0]?.start?.execution?.location, 'INHERIT');
    assert.equal(seed.nodes[4]?.finish?.saveWorkspace, true);
    assert.equal(seed.nodes[4]?.finish?.requireRelease, 'ACTIVATED');
    assert.ok(
      seed.nodes.every(({ inputs, outputs }) => inputs === undefined && outputs === undefined),
    );
    assert.equal(seed.endpoints[0]?.inputBindings, undefined);
    const initialCatalog = await projectCatalog();
    assert.equal(initialCatalog.hasDraftChanges, true);
    assert.deepEqual(
      initialCatalog.flows.map(
        ({ id, inDraft, version }: { id: string; inDraft: boolean; version?: number }) => [
          id,
          inDraft,
          version,
        ],
      ),
      seed.endpoints.map(({ startId }) => [startId, true, undefined]),
    );
    assert.deepEqual((await api.get(path).expect(200)).body.data, draft);
    assert.deepEqual((await api.get(`${path}/runs`).expect(200)).body.data, []);
    const { flowTemplates } = (await api.get(`${path}/catalog`).expect(200)).body.data;
    assert.deepEqual(
      flowTemplates.map(({ id }: { id: string }) => id),
      ['MINIMAL_CI_CD', 'COMPLETE_CI_CD'],
    );
    for (const template of flowTemplates) {
      assert.deepEqual(
        template.entries.map(({ name }: { name: string }) => name),
        entryNames,
      );
      assert.deepEqual(template.artifactTypes, ['DIRECTORY', 'DOCKER_IMAGE']);
    }

    const expand = `${path}/draft/templates/expand`;
    const payload = { templateId: 'COMPLETE_CI_CD' };
    const minimal = (await api.post(expand).send({ templateId: 'MINIMAL_CI_CD' }).expect(201)).body
      .data;
    assertSharedCanvas(minimal.canvas, minimal.startId, false);
    const seedIds = new Set(seed.nodes.map(({ id }) => id));
    assert.ok(minimal.canvas.nodes.every(({ id }: { id: string }) => !seedIds.has(id)));
    const [left, right] = await Promise.all([
      api.post(expand).send(payload).expect(201),
      api.post(expand).send(payload).expect(201),
    ]);
    const complete = left.body.data.canvas as GraphCanvas;
    assertSharedCanvas(complete, left.body.data.startId, true);
    assertSharedCanvas(right.body.data.canvas, right.body.data.startId, true);
    assert.equal(
      complete.nodes.find(({ name }) => name === '发布结束')?.finish?.requireRelease,
      'HEALTHY',
    );
    assert.notEqual(left.body.data.startId, right.body.data.startId);
    assert.ok(
      left.body.data.canvas.nodes.some(
        (node: { id: string }) => node.id === left.body.data.startId,
      ),
    );
    const leftIds = new Set(left.body.data.canvas.nodes.map((node: { id: string }) => node.id));
    assert.ok(right.body.data.canvas.nodes.every((node: { id: string }) => !leftIds.has(node.id)));
    const dockerVariants = await Promise.all(
      ['MINIMAL_CI_CD', 'COMPLETE_CI_CD'].map(async (templateId) => {
        const { body } = await api
          .post(expand)
          .send({ templateId, artifactType: 'DOCKER_IMAGE' })
          .expect(201);
        const canvas = body.data.canvas as GraphCanvas;
        assertSharedCanvas(canvas, body.data.startId, templateId === 'COMPLETE_CI_CD');
        assert.equal(
          canvas.nodes.find(({ operation }) => operation === 'BUILD')?.build?.dockerfilePath,
          'Dockerfile',
        );
        assert.equal(
          canvas.nodes.find(({ operation }) => operation === 'DEPLOY_ARTIFACT')?.deploy?.method,
          'COMPOSE',
        );
        assert.ok(
          canvas.nodes
            .filter(({ type }) => type === 'END')
            .every(({ finish }) => finish?.images?.some(({ source }) => source === 'BUILT_IN')),
        );
        return canvas;
      }),
    );
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
    await api
      .post(expand)
      .send({ ...payload, artifactType: 'FILE' })
      .expect(400);
    await api.post(expand).send({ templateId: 'CD_DEPLOY' }).expect(400);
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
      seed.endpoints.map(({ startId }, index) => ({
        flowId: startId,
        nodeId: startId,
        fieldId: index === 2 ? 'start.release.serviceId' : 'start.sources.source.repositoryId',
      })),
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
    const configured = (candidate: GraphCanvas) => {
      const canvas = structuredClone(candidate);
      for (const node of canvas.nodes) {
        if (node.start) {
          for (const source of node.start.sources ?? []) source.repositoryId = repository.id;
          node.start.release = node.start.release
            ? { ...node.start.release, serviceId: service.id, targets: { serverIds: [target.id] } }
            : { serviceId: service.id };
        }
        if (node.operation === 'BUILD')
          node.build = node.build?.dockerfilePath
            ? { ...node.build, repoPath: 'project' }
            : { repoPath: 'project', buildCommand: 'mkdir -p dist' };
        if (node.operation === 'CHECK')
          node.shell = { ...node.shell, directory: 'project', command: 'test -d .' };
        if (node.operation === 'HEALTH_CHECK')
          node.healthCheck = { ...node.healthCheck, command: 'test -f .veyops-managed' };
      }
      return canvas;
    };
    const ready = configured(seed);
    const wholeWorkspace = await api
      .post(`${path}/validate`)
      .send({ definition: { canvas: ready } })
      .expect(201);
    assert.deepEqual(wholeWorkspace.body.data.issues, []);
    ready.nodes[0]!.start!.release!.contentPath = 'project/dist/';
    const readyDraft = (await save(ready, saved.revision).expect(200)).body.data;
    const published = (
      await api.post(`${path}/publish`).send({ expectedRevision: readyDraft.revision }).expect(201)
    ).body.data;
    assert.equal(published.publishedVersion, 1);
    const releaseOnlyId = ready.endpoints[2]!.startId;
    const requiresArtifact = await api
      .post(`${path}/flows/${releaseOnlyId}/preview`)
      .send({ version: published.publishedVersion })
      .expect(400);
    assert.match(requiresArtifact.body.error.message, /历史产物/);

    const disconnected = structuredClone(ready);
    const buildOnlyId = disconnected.endpoints[1]!.startId;
    disconnected.nodes = disconnected.nodes.filter(({ id }) => id !== buildOnlyId);
    disconnected.edges = disconnected.edges.filter(({ from }) => from !== buildOnlyId);
    disconnected.endpoints = disconnected.endpoints.filter(
      ({ startId }) => startId !== buildOnlyId,
    );
    const unresolvedExit = await api
      .post(`${path}/validate`)
      .send({ definition: { canvas: disconnected } })
      .expect(201);
    assert.match(unresolvedExit.body.data.issues[0].message, /构建结束/);

    const ci = configured(complete);
    for (const docker of dockerVariants) {
      const validated = await api
        .post(`${path}/validate`)
        .send({ definition: { canvas: configured(docker) } })
        .expect(201);
      assert.deepEqual(validated.body.data.issues, []);
    }
    const ciValidated = await api
      .post(`${path}/validate`)
      .send({ definition: { canvas: ci } })
      .expect(201);
    assert.deepEqual(ciValidated.body.data.issues, []);
    const ciDraft = (await save(ci, published.revision).expect(200)).body.data;
    const pendingCatalog = await projectCatalog();
    assert.equal(pendingCatalog.hasDraftChanges, true);
    assert.equal(pendingCatalog.flows.length, 6);
    const active = pendingCatalog.flows.find(({ id }: { id: string }) => id === seed.nodes[0]!.id);
    assert.equal(active.version, published.publishedVersion);
    assert.equal(active.inDraft, false);
    const ciStartId = ci.endpoints[0]!.startId;
    const draftOnly = pendingCatalog.flows.find(({ id }: { id: string }) => id === ciStartId);
    assert.equal(draftOnly.inDraft, true);
    assert.equal(draftOnly.version, undefined);
    const ciPublished = (
      await api.post(`${path}/publish`).send({ expectedRevision: ciDraft.revision }).expect(201)
    ).body.data;
    const ciCatalog = await projectCatalog();
    assert.equal(ciCatalog.hasDraftChanges, false);
    assert.equal(ciCatalog.flows.length, 3);
    assert.equal(ciCatalog.flows[0].id, ciStartId);
    assert.equal(ciCatalog.flows[0].version, ciPublished.publishedVersion);
    assert.equal(ciCatalog.flows[0].inDraft, true);
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
