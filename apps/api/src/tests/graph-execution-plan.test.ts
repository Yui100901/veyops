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
    const start = (id: string, extra: object[] = []) => ({
      id,
      name: id,
      type: 'START',
      inputs: [
        { id: 'environmentSet', name: '变量集合', type: 'ENVIRONMENT_SET', required: true },
        { id: 'configuration', name: '配置', type: 'TEXT', required: true },
        ...extra,
      ],
      environmentSet: { mode: 'INPUT', fieldId: 'environmentSet' },
    });
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
                {
                  id: 'checkout',
                  name: '检出固定源码',
                  type: 'CHECKOUT',
                  checkout: { repositoryId: repo.id, mode: 'COMMIT', commitSha: pin },
                },
                {
                  id: 'load',
                  name: '载入变量文件',
                  type: 'LOAD_ENV',
                  loadEnvironment: {
                    required: false,
                    pathRule: {
                      key: 'configuration',
                      paths: { empty: '.env.empty', test: '.env.test' },
                    },
                  },
                },
                build('manager', 'MANAGER'),
                end('end-build'),
                start('combined', [
                  {
                    id: 'releaseTargets',
                    name: '发布目标',
                    type: 'TARGETS',
                    required: true,
                    defaultValue: { groupIds: [group.id] },
                  },
                ]),
                build('combined-build', 'MANAGER'),
                {
                  id: 'approve-release',
                  name: '确认发布',
                  type: 'APPROVAL',
                  approval: { releaseNodeId: 'release' },
                },
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
                ...chain(['build-only', 'checkout', 'load', 'manager', 'end-build']),
                ...chain([
                  'combined',
                  'combined-build',
                  'approve-release',
                  'release',
                  'end-release',
                ]),
                ...chain(['target-only', 'target', 'end-target']),
              ],
              endpoints: [
                {
                  startId: 'build-only',
                  endId: 'end-build',
                  serviceId: service.id,
                  inputBindings: {
                    load: { source: { kind: 'OUTPUT', nodeId: 'checkout', fieldId: 'source' } },
                    manager: {
                      variables: { kind: 'OUTPUT', nodeId: 'load', fieldId: 'variables' },
                    },
                  },
                },
                {
                  startId: 'combined',
                  endId: 'end-release',
                  serviceId: service.id,
                  inputBindings: {
                    release: {
                      artifact: { kind: 'OUTPUT', nodeId: 'combined-build', fieldId: 'output' },
                      targets: { kind: 'INPUT', fieldId: 'releaseTargets' },
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
    const args = (environmentSet: string, targets?: string[]) => ({
      version,
      inputs: {
        parameters: {
          environmentSet,
          configuration: environmentSet === empty.id ? 'empty' : 'test',
          ...(targets && { releaseTargets: { serverIds: targets } }),
        },
      },
    });
    const previewOnly = await create(flow('build-only') + '/preview', args(empty.id));
    const previewWithDefaults = await create(flow('build-only') + '/preview', args(env.id));
    assert.equal(snapshots.mock.callCount(), 0);
    assert.deepEqual(previewOnly.executionPlan.targets[0].servers, []);
    assert.deepEqual(previewOnly.executionPlan.environmentFiles[0], {
      flowId: 'build-only',
      nodeId: 'load',
      status: 'SKIPPED',
      source: 'NODE',
      required: false,
      repositoryId: repo.id,
      commitSha: pin,
      path: '.env.empty',
      mappingKey: 'configuration',
    });
    assert.ok(
      !previewOnly.executionPlan.variables.some(
        (v: { key: string }) => v.key === 'UNEXPECTED_FALLBACK',
      ),
    );
    assert.equal(previewWithDefaults.executionPlan.targets[0].source, 'MANAGER');
    assert.equal(previewWithDefaults.executionPlan.environmentFiles[0].path, '.env.test');
    assert.equal(previewWithDefaults.executionPlan.environmentFiles[0].commitSha, pin);
    assert.ok(files.mock.callCount() >= 2);
    assert.ok(
      previewWithDefaults.executionPlan.variables.some(
        (v: { nodeId: string; key: string; source: string; sensitive: boolean }) =>
          v.nodeId === 'load' &&
          v.key === 'OVERLAP' &&
          v.source === 'ENVIRONMENT_SET' &&
          v.sensitive === false,
      ),
    );
    assert.ok(!JSON.stringify(previewWithDefaults).includes(plain));
    assert.ok(!JSON.stringify(previewWithDefaults).includes(secret));

    const missing = await post(flow('target-only') + '/preview', args(env.id)).expect(400);
    assert.match(missing.body.error.message, /target.*缺少构建服务器/);
    const combined = flow('combined');
    const defaultPlan = await create(combined + '/preview', args(env.id));
    assert.equal(defaultPlan.deliveries[1].requireApproval, false);
    const runner = app.get(GraphRunnerService);
    const automation = { kind: 'API' as const, ruleId: 'fixture', revision: '1' };
    const previous = process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
    try {
      delete process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
      await assert.rejects(
        runner.preview(project.id, 'combined', args(env.id), { automation }),
        /API 尚未放行/,
      );
      process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS = 'API';
      const automaticPlan = await runner.preview(project.id, 'combined', args(env.id), {
        automation,
      });
      assert.ok(
        automaticPlan.gates.some(
          ({ nodeId, kind, releaseNodeId }) =>
            nodeId === 'approve-release' && kind === 'APPROVAL' && releaseNodeId === 'release',
        ),
      );
      assert.deepEqual(automaticPlan.executionPlan.targets, defaultPlan.executionPlan.targets);
    } finally {
      if (previous === undefined) delete process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
      else process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS = previous;
    }
    assert.deepEqual(
      defaultPlan.executionPlan.targets.map((item: { purpose: string; source: string }) => [
        item.purpose,
        item.source,
      ]),
      [
        ['BUILD', 'MANAGER'],
        ['RELEASE', 'RUN_INPUT'],
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

    const output = (nodeId: string, fieldId: string) => ({ kind: 'OUTPUT', nodeId, fieldId });
    const firstChoice = (fieldId: string) => ({
      kind: 'FIRST_AVAILABLE',
      sources: [output('checkout-a', fieldId), output('checkout-b', fieldId)],
    });
    const checkout = (suffix: string, repositoryId: string) => ({
      id: 'checkout-' + suffix,
      name: '检出 ' + suffix,
      type: 'CHECKOUT',
      checkout: { repositoryId, mode: 'BRANCH', branch: 'main' },
    });
    const branches = (
      await api
        .put(base + path + '/draft')
        .send({
          expectedRevision: (await api.get(base + path).expect(200)).body.data.revision,
          definition: {
            flows: [],
            canvas: {
              nodes: [
                { id: 'branch-test', name: '分支验证', type: 'START' },
                {
                  id: 'choice',
                  name: '运行时输出',
                  type: 'SHELL',
                  shell: { location: 'MANAGER', command: 'printf b' },
                  outputs: [{ id: 'choice', name: '分支', type: 'TEXT', required: true }],
                },
                {
                  id: 'condition',
                  name: '选择分支',
                  type: 'CONDITION',
                  condition: { key: 'input', value: 'a' },
                },
                checkout('a', repo.id),
                checkout('b', alternateRepo.id),
                {
                  id: 'merge-check',
                  name: '汇合检查',
                  type: 'CHECK',
                  shell: { location: 'MANAGER', command: 'git rev-parse HEAD' },
                },
                {
                  id: 'verify-workspace',
                  name: '检查传递的工作区',
                  type: 'CHECK',
                  shell: { location: 'TARGET', command: 'git rev-parse HEAD' },
                },
                end('branch-end'),
              ],
              edges: [
                ...chain(['branch-test', 'choice', 'condition']),
                { from: 'condition', to: 'checkout-b', when: 'FALSE' },
                { from: 'condition', to: 'checkout-a', when: 'TRUE' },
                { from: 'checkout-b', to: 'merge-check' },
                ...chain(['checkout-a', 'merge-check', 'verify-workspace', 'branch-end']),
              ],
              endpoints: [
                {
                  startId: 'branch-test',
                  endId: 'branch-end',
                  inputBindings: {
                    condition: { value: output('choice', 'choice') },
                    'merge-check': {
                      workspace: firstChoice('workspace'),
                      source: firstChoice('source'),
                    },
                    'verify-workspace': {
                      workspace: output('merge-check', 'workspace'),
                      targets: { kind: 'VALUE', value: { serverIds: [first.id] } },
                    },
                  },
                },
              ],
              templates: [],
            },
          },
        })
        .expect(200)
    ).body.data;
    const branchVersion = (await create(path + '/publish', { expectedRevision: branches.revision }))
      .publishedVersion;
    const branchArgs = { version: branchVersion };
    const branchFlow = flow('branch-test');
    const branchPreview = await create(branchFlow + '/preview', branchArgs);
    const script = (preview: typeof branchPreview, nodeId: string) =>
      preview.scripts.find((item: { nodeId: string }) => item.nodeId === nodeId);
    assert.deepEqual(script(branchPreview, 'merge-check').workspace.candidates, [
      {
        producerNodeId: 'checkout-a',
        producerField: 'workspace',
        repositoryId: repo.id,
        commitSha: pin,
        deferred: false,
      },
      {
        producerNodeId: 'checkout-b',
        producerField: 'workspace',
        repositoryId: alternateRepo.id,
        commitSha: alternatePin,
        deferred: false,
      },
    ]);
    assert.deepEqual(
      new Set(script(branchPreview, 'verify-workspace').workspace.candidates),
      new Set([
        {
          producerNodeId: 'merge-check',
          producerField: 'workspace',
          repositoryId: repo.id,
          commitSha: pin,
          deferred: false,
        },
        {
          producerNodeId: 'merge-check',
          producerField: 'workspace',
          repositoryId: alternateRepo.id,
          commitSha: alternatePin,
          deferred: false,
        },
      ]),
    );
    alternatePin = 'c'.repeat(40);
    const changedPreview = await create(branchFlow + '/preview', branchArgs);
    assert.notEqual(changedPreview.configurationHash, branchPreview.configurationHash);
    assert.equal(
      script(changedPreview, 'merge-check').workspace.candidates[1].commitSha,
      alternatePin,
    );
    const staleBranch = await post(branchFlow + '/run', {
      ...branchArgs,
      expectedConfigurationHash: branchPreview.configurationHash,
      expectedPlanSections: branchPreview.planSections,
      idempotencyKey: randomUUID(),
    }).expect(409);
    assert.ok(
      staleBranch.body.error.changes.some(
        (change: string) => change.includes('汇合检查') && change.includes('脚本工作区'),
      ),
    );
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
