import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ExecutionPlanIssueError } from '../core/execution-plan-issue';
import { withIsolatedPostgres } from './helpers/isolated-postgres';

async function checkPlan(t: TestContext, url?: string) {
  const data = await mkdtemp(join(tmpdir(), 'veyops-execution-plan-'));
  const initial = randomBytes(18).toString('hex');
  const password = randomBytes(18).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: url ? 'postgres' : 'sqlite',
    ...(url && { DATABASE_URL: url }),
    DATABASE_PATH: join(data, 'test.db'),
    DATA_DIR: data,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: initial,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { GraphRunnerService } =
    await import('../modules/execution-graphs/graph-runner.service.js');
  const { PipelinesService } = await import('../modules/pipelines/pipelines.service.js');
  const { RepositoryMetadataService } =
    await import('../modules/projects/repository-metadata.service.js');
  const { ServersService } = await import('../modules/servers/servers.service.js');
  const app = (
    await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false });
  try {
    configureApp(app);
    await app.init();
    const api = request.agent(app.getHttpServer());
    const base = '/api/v1';
    const post = (path: string, body: object) => api.post(base + path).send(body);
    const create = async (path: string, body: object) => {
      const result = await post(path, body);
      assert.equal(
        result.status,
        201,
        `${path}: ${result.body.error?.message ?? 'unexpected status'}`,
      );
      return result.body.data;
    };
    await create('/auth/login', { username: 'root', password: initial });
    await post('/auth/change-password', { currentPassword: initial, newPassword: password }).expect(
      200,
    );
    await create('/auth/login', { username: 'root', password });
    const credential = await create('/credentials', {
      name: 'SSH fixture',
      type: 'SSH_PASSWORD',
      secret: { password: randomUUID() },
    });
    const host = (name: string) =>
      create('/servers', {
        name,
        host: name === 'First' ? '127.0.0.1' : '127.0.0.2',
        username: 'fixture',
        credentialId: credential.id,
        hostKeyFingerprint: 'a'.repeat(64),
      });
    const [first, second] = [await host('First'), await host('Second')];
    const group = await create('/server-groups', { name: 'Release', serverIds: [first.id] });
    const project = await create('/projects', { slug: 'plan-fixture', name: 'Plan fixture' });
    const scope = `/projects/${project.id}`;
    const repo = await create(scope + '/repositories', {
      name: 'Fixture source',
      cloneUrl: 'https://git.example.test/repository.git',
    });
    const alternateRepo = await create(scope + '/repositories', {
      name: 'Alternate source',
      cloneUrl: 'https://git.example.test/alternate.git',
    });
    const service = await create(scope + '/services', { name: 'Web', slug: 'web' });
    const empty = await create(scope + '/environment-sets', { name: 'Empty' });
    const plain = 'value-must-not-be-in-preview';
    const secret = 'secret-must-not-be-in-preview';
    const env = await create(scope + '/environment-sets', {
      name: 'Test',
      variables: [
        { key: 'OVERLAP', value: plain },
        { key: 'PASSWORD', value: secret, isSecret: true },
      ],
    });
    const pin = 'd'.repeat(40);
    let alternatePin = 'b'.repeat(40);
    t.mock.method(
      app.get(RepositoryMetadataService),
      'planGraphCheckout',
      async (_projectId: string, { repositoryId }: { repositoryId: string }) => {
        const selected = repositoryId === alternateRepo.id ? alternateRepo : repo;
        const commitSha = repositoryId === alternateRepo.id ? alternatePin : pin;
        return {
          repositoryId: selected.id,
          repositoryName: selected.name,
          commitSha,
          ref: commitSha,
          fullClone: false,
          access: { clone_url: selected.cloneUrl, credential_id: null },
        };
      },
    );
    const files = t.mock.method(
      app.get(RepositoryMetadataService),
      'inspectGraphEnvironmentFile',
      async (
        _project: string,
        source: { repositoryId: string; commitSha: string },
        paths: string[],
      ) => {
        assert.equal(source.repositoryId, repo.id);
        assert.equal(source.commitSha, pin);
        assert.equal(paths.length, 1);
        if (paths[0] === '.env') return { path: '.env', keys: ['UNEXPECTED_FALLBACK'] };
        return paths.includes('.env.test')
          ? { path: '.env.test', keys: ['FROM_FILE', 'OVERLAP'] }
          : undefined;
      },
    );
    const snapshots = t.mock.method(app.get(ServersService), 'snapshot');
    const path = scope + '/execution-graph';
    const draft = (await api.get(base + path).expect(200)).body.data;
    const flow = (id: string) => path + '/flows/' + id;
    const source = { id: 'main', repositoryId: repo.id, ref: { kind: 'COMMIT', value: pin } };
    const release = { serviceId: service.id };
    const makeFlow = (id: string, start: object, managed = false) => {
      const nodes = [
        { id, name: id, type: 'START', start },
        { id: id + '-checkout', name: '检出固定源码', type: 'CHECKOUT' },
        {
          id: id + '-build',
          name: '构建',
          type: 'BUILD',
          build: { buildCommand: 'npm run build', repoPath: 'repository' },
        },
        ...(managed
          ? [
              { id: id + '-approval', name: '确认发布', type: 'APPROVAL' },
              {
                id: id + '-release',
                name: '发布',
                type: 'DEPLOY_ARTIFACT',
                deploy: { method: 'FILE' },
              },
            ]
          : []),
        { id: id + '-end', name: '结束', type: 'END' },
      ];
      return {
        nodes,
        edges: nodes.slice(1).map(({ id: to }, index) => ({ from: nodes[index]!.id, to })),
        endpoint: { startId: id, endId: id + '-end' },
      };
    };
    const managed = { sources: [source], execution: { serverId: first.id }, release };
    const builds = [
      makeFlow('fresh', {
        sources: [
          source,
          {
            id: 'alternate',
            repositoryId: alternateRepo.id,
            ref: { kind: 'BRANCH', value: 'main' },
          },
        ],
        execution: { serverId: first.id },
        environmentSetId: env.id,
        dotenv: { sourceId: 'main', path: '.env.test' },
      }),
      makeFlow('combined', { ...managed, environmentSetId: empty.id }, true),
      makeFlow('sensitive', { ...managed, environmentSetId: env.id }, true),
      makeFlow('target', {
        sources: [source],
        execution: { serverId: second.id },
      }),
    ];
    const response = await api
      .put(base + path + '/draft')
      .send({
        expectedRevision: draft.revision,
        definition: {
          canvas: {
            model: 'FLOW_V2',
            templates: [],
            nodes: builds.flatMap(({ nodes }) => nodes),
            edges: builds.flatMap(({ edges }) => edges),
            endpoints: builds.map(({ endpoint }) => endpoint),
          },
        },
      })
      .expect(200);
    const { publishedVersion: version } = await create(path + '/publish', {
      expectedRevision: response.body.data.revision,
    });
    const args = { version };
    const fresh = await create(flow('fresh') + '/preview', args);
    assert.equal(snapshots.mock.callCount(), 1);
    assert.equal(fresh.simplified.location, 'TARGET');
    assert.deepEqual(
      fresh.checkouts.map(({ directory, commitSha }: { directory: string; commitSha: string }) => [
        directory,
        commitSha,
      ]),
      [
        ['repository', pin],
        ['alternate', alternatePin],
      ],
    );
    assert.equal(fresh.scripts[0].directory, 'repository');
    assert.equal(fresh.environmentSet.id ?? fresh.environmentSet.setId, env.id);
    assert.equal(files.mock.callCount(), 1);
    assert.doesNotMatch(
      JSON.stringify(fresh),
      /value-must-not-be-in-preview|secret-must-not-be-in-preview/,
    );
    const target = await create(flow('target') + '/preview', args);
    assert.equal(target.simplified.location, 'TARGET');
    assert.equal(target.simplified.serverId, second.id);
    const combined = flow('combined');
    const releasePlans = t.mock.method(app.get(PipelinesService), 'previewArtifactDeployPlan');
    const preview = await create(combined + '/preview', args);
    assert.equal(releasePlans.mock.callCount(), 1);
    assert.equal(
      releasePlans.mock.calls[0]?.arguments[2]?.definition.deployPath,
      `~/.veyops/workspace/${project.slug}/.deployments/${service.id}`,
    );
    assert.equal(preview.simplified.location, 'TARGET');
    assert.deepEqual(preview.simplified.release.serverIds, [first.id]);
    assert.equal(Object.hasOwn(preview.simplified.release, 'contentPath'), false);
    assert.equal(Object.hasOwn(preview.simplified.release, 'deployPath'), false);
    assert.equal(preview.deliveries[0].requireApproval, false);
    const runner = app.get(GraphRunnerService);
    const automation = { kind: 'API' as const, ruleId: 'fixture', revision: '1' };
    const previous = process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
    try {
      delete process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
      await assert.rejects(
        runner.preview(project.id, 'combined', args, { automation }),
        /API 尚未放行/,
      );
      process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS = 'API';
      await assert.rejects(
        runner.preview(project.id, 'combined', args, { automation }),
        /缺少有效的自动执行授权/,
      );
      await api
        .patch(base + '/servers/' + first.id + '/automatic-execution')
        .send({ enabled: true })
        .expect(200);
      await assert.rejects(
        runner.preview(project.id, 'sensitive', args, { automation }),
        (error: unknown) =>
          error instanceof ExecutionPlanIssueError &&
          error.issue.fieldId === 'variables' &&
          /敏感变量/.test(error.message),
      );
      const automatic = await runner.preview(project.id, 'combined', args, { automation });
      assert.ok(
        automatic.gates.some(
          ({ nodeId, kind, releaseNodeId }) =>
            nodeId === 'combined-approval' &&
            kind === 'APPROVAL' &&
            releaseNodeId === 'combined-release',
        ),
      );
      assert.deepEqual(automatic.deliveries[0]!.serverIds, [first.id]);
    } finally {
      if (previous === undefined) delete process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
      else process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS = previous;
    }

    const run = (endpoint: string, plan: { configurationHash: string; planSections: object }) =>
      post(endpoint + '/run', {
        ...args,
        expectedConfigurationHash: plan.configurationHash,
        expectedPlanSections: plan.planSections,
        idempotencyKey: randomUUID(),
      });
    await api
      .patch(base + '/server-groups/' + group.id)
      .send({ name: 'Release', serverIds: [first.id, second.id] })
      .expect(200);
    const changed = await create(combined + '/preview', args);
    assert.deepEqual(changed.simplified.release.serverIds, [first.id]);
    assert.equal(changed.configurationHash, preview.configurationHash);
    await run(combined, preview).expect(201);

    alternatePin = 'c'.repeat(40);
    await run(flow('fresh'), fresh).expect(409);
    const refreshed = await create(flow('fresh') + '/preview', args);
    assert.equal(refreshed.checkouts[1].commitSha, alternatePin);
    assert.notEqual(refreshed.configurationHash, fresh.configurationHash);
    const started = await run(flow('fresh'), refreshed).expect(201);
    assert.match(started.body.data.status, /QUEUED|RUNNING/);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
}

test('SQLite graph plan pins build and release to one server and rejects stale commits', (t) =>
  checkPlan(t));
test(
  'PostgreSQL graph plan pins build and release to one server and rejects stale commits',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  (t) => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, (url) => checkPlan(t, url)),
);
