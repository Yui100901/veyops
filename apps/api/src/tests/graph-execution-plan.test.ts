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
import { withIsolatedPostgres } from './helpers/isolated-postgres';
import { replaceVariables } from './helpers/variable-scope';

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
  const { RepositoryMetadataService } =
    await import('../modules/projects/repository-metadata.service.js');
  const { ServersService } = await import('../modules/servers/servers.service.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
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
    const service = await create(scope + '/services', { name: 'Web', slug: 'web' });
    const empty = await create(scope + '/environments', { name: 'Empty', slug: 'empty' });
    const env = await create(scope + '/environments', {
      name: 'Test',
      slug: 'test',
      repositoryEnvFile: '.env.test',
      defaultTargetSelection: { groupIds: [group.id] },
    });
    const vars = `/services/${service.id}/environments/${env.id}/variables`;
    const plain = 'value-must-not-be-in-preview';
    const secret = 'secret-must-not-be-in-preview';
    await replaceVariables(api, base + vars, [
      { key: 'OVERLAP', value: plain },
      { key: 'PASSWORD', value: secret, isSecret: true },
    ]);
    const pin = 'd'.repeat(40);
    const files = t.mock.method(
      app.get(RepositoryMetadataService),
      'inspectGraphEnvironmentFile',
      async (
        _project: string,
        source: { repositoryId: string; commitSha: string },
        paths: string[],
      ) => {
        assert.deepEqual(source, { repositoryId: repo.id, commitSha: pin });
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
    const field = { id: 'environment', name: 'Environment', type: 'ENVIRONMENT', required: true };
    const start = (id: string) => ({ id, name: id, type: 'START', inputs: [field] });
    const end = (id: string) => ({ id, name: id, type: 'END' });
    const build = (id: string, buildLocation: string) => ({
      id,
      name: id,
      type: 'BUILD',
      build: {
        repositoryId: repo.id,
        commitSha: pin,
        buildLocation,
        buildCommand: 'npm run build',
        artifacts: [{ name: 'output', type: 'FILE', path: 'dist/file.zip' }],
      },
    });
    const chain = (ids: string[]) => ids.slice(1).map((to, index) => ({ from: ids[index], to }));
    const revision = (
      await api
        .put(base + path + '/draft')
        .send({
          expectedRevision: draft.revision,
          definition: {
            flows: [],
            canvas: {
              nodes: [
                start('build-only'),
                build('manager', 'MANAGER'),
                end('end-build'),
                start('combined'),
                build('combined-build', 'MANAGER'),
                {
                  id: 'release',
                  name: 'Release',
                  type: 'DEPLOY_ARTIFACT',
                  deploy: { deployPath: '/opt/veyops-fixture' },
                },
                {
                  ...end('end-release'),
                  outputs: [
                    { id: 'released', name: 'Release result', type: 'RELEASE', required: true },
                  ],
                },
                start('target-only'),
                build('target', 'TARGET'),
                end('end-target'),
              ],
              edges: [
                ...chain(['build-only', 'manager', 'end-build']),
                ...chain(['combined', 'combined-build', 'release', 'end-release']),
                ...chain(['target-only', 'target', 'end-target']),
              ],
              endpoints: [
                { startId: 'build-only', endId: 'end-build', serviceId: service.id },
                {
                  startId: 'combined',
                  endId: 'end-release',
                  serviceId: service.id,
                  inputBindings: {
                    release: {
                      artifact: { kind: 'OUTPUT', nodeId: 'combined-build', fieldId: 'output' },
                    },
                  },
                  outputBindings: {
                    released: { kind: 'OUTPUT', nodeId: 'release', fieldId: 'release' },
                  },
                },
                { startId: 'target-only', endId: 'end-target', serviceId: service.id },
              ],
              templates: [],
            },
          },
        })
        .expect(200)
    ).body.data.revision;
    const version = (await create(path + '/publish', { expectedRevision: revision }))
      .publishedVersion;
    const flow = (id: string) => path + '/flows/' + id;
    const args = (environment: string, targets?: string[]) => ({
      version,
      inputs: {
        parameters: { environment },
        ...(targets && { serverIds: targets }),
      },
    });
    const previewOnly = await create(flow('build-only') + '/preview', args(empty.id));
    const previewWithDefaults = await create(flow('build-only') + '/preview', args(env.id));
    assert.equal(snapshots.mock.callCount(), 0);
    assert.deepEqual(previewOnly.executionPlan.targets[0].servers, []);
    assert.deepEqual(previewOnly.executionPlan.environmentFiles[0], {
      flowId: 'build-only',
      nodeId: 'manager',
      status: 'SKIPPED',
      source: 'CONVENTION',
      required: false,
      repositoryId: repo.id,
      commitSha: pin,
      path: '.env.empty',
    });
    assert.ok(
      !previewOnly.executionPlan.variables.some((v: { key: string }) => v.key === 'UNEXPECTED_FALLBACK'),
    );
    assert.equal(previewWithDefaults.executionPlan.targets[0].source, 'MANAGER');
    assert.equal(previewWithDefaults.executionPlan.environmentFiles[0].path, '.env.test');
    assert.equal(previewWithDefaults.executionPlan.environmentFiles[0].commitSha, pin);
    assert.ok(files.mock.callCount() >= 2);
    assert.deepEqual(
      previewWithDefaults.executionPlan.variables.find((v: { key: string }) => v.key === 'OVERLAP'),
      {
        flowId: 'build-only',
        nodeId: 'manager',
        key: 'OVERLAP',
        source: 'SERVICE_ENVIRONMENT',
        sensitive: false,
      },
    );
    assert.ok(!JSON.stringify(previewWithDefaults).includes(plain));
    assert.ok(!JSON.stringify(previewWithDefaults).includes(secret));

    const missing = await post(flow('target-only') + '/preview', args(env.id)).expect(400);
    assert.match(missing.body.error.message, /target.*缺少构建服务器/);
    const combined = flow('combined');
    const defaultPlan = await create(combined + '/preview', args(env.id));
    assert.equal(defaultPlan.deliveries[1].requireApproval, false);
    const automaticPlan = await app.get(GraphRunnerService).preview(
      project.id,
      'combined',
      args(env.id),
      { automation: { kind: 'API', ruleId: 'fixture', revision: '1' } },
    );
    assert.equal(automaticPlan.deliveries[0]?.requireApproval, false);
    assert.equal(automaticPlan.deliveries[1]?.requireApproval, true);
    assert.notEqual(automaticPlan.configurationHash, defaultPlan.configurationHash);
    assert.deepEqual(
      defaultPlan.executionPlan.targets.map((item: { purpose: string; source: string }) => [
        item.purpose,
        item.source,
      ]),
      [
        ['BUILD', 'MANAGER'],
        ['RELEASE', 'PROJECT_ENVIRONMENT'],
      ],
    );
    assert.deepEqual(
      defaultPlan.executionPlan.targets[1].servers.map((s: { id: string }) => s.id),
      [first.id],
    );
    assert.ok(
      defaultPlan.executionPlan.deferred.some(
        (item: { producerField: string }) => item.producerField === 'output',
      ),
    );
    await api
      .patch(base + '/server-groups/' + group.id)
      .send({ name: 'Release', serverIds: [first.id, second.id] })
      .expect(200);
    const stale = await post(combined + '/run', {
      ...args(env.id),
      expectedConfigurationHash: defaultPlan.configurationHash,
      expectedPlanSections: defaultPlan.planSections,
      idempotencyKey: randomUUID(),
    }).expect(409);
    assert.ok(stale.body.error.changes.some((change: string) => change.includes('执行目标及成员')));

    const config = `/services/${service.id}/environments/${env.id}/config`;
    await api
      .put(base + config)
      .send({ serverIds: [second.id], deployPath: '/opt/veyops-override' })
      .expect(200);
    const overridden = await create(combined + '/preview', args(env.id));
    assert.equal(overridden.executionPlan.targets[1].source, 'SERVICE_ENVIRONMENT');
    assert.deepEqual(
      overridden.executionPlan.targets[1].servers.map((s: { id: string }) => s.id),
      [second.id],
    );
    const explicit = await create(combined + '/preview', args(env.id, [first.id]));
    assert.equal(explicit.executionPlan.targets[1].source, 'RUN_INPUT');
    assert.deepEqual(
      explicit.executionPlan.targets[1].servers.map((s: { id: string }) => s.id),
      [first.id],
    );

    const started = await create(flow('build-only') + '/run', {
      ...args(env.id),
      expectedConfigurationHash: previewWithDefaults.configurationHash,
      expectedPlanSections: previewWithDefaults.planSections,
      idempotencyKey: randomUUID(),
    });
    assert.match(started.status, /QUEUED|RUNNING/);
  } finally {
    await app.close();
    await rm(data, { recursive: true, force: true });
  }
}

test('SQLite graph plan separates build and release and rejects stale target membership', (t) =>
  checkPlan(t));
test(
  'PostgreSQL graph plan separates build and release and rejects stale target membership',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  (t) => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, (url) => checkPlan(t, url)),
);
