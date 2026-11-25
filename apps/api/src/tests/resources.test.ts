import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { withIsolatedPostgres } from './helpers/isolated-postgres';
import { replaceVariables } from './helpers/variable-scope';

async function checkResources(databaseUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-resources-'));
  process.env.DATABASE_CLIENT = databaseUrl ? 'postgres' : 'sqlite';
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.DATA_DIR = directory;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_PASSWORD = 'resources-fixture-bootstrap';
  const password = 'resources-fixture-changed';
  const { LegacyDeliveryFixtureModule } =
    await import('./helpers/legacy-delivery-fixture.module.js');
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
  const { ServiceConfigsService } =
    await import('../modules/service-configs/service-configs.service.js');
  let probeExitCode = 0;
  const module = await Test.createTestingModule({
    imports: [AppModule, LegacyDeliveryFixtureModule],
  })
    .overrideProvider(SshService)
    .useValue({
      probe: async () => ({
        exitCode: probeExitCode,
        output: [
          'Linux fixture',
          'VEYOPS_OS="Debian GNU/Linux"',
          'VEYOPS_LOAD=0.01 0.03 0.06',
          'VEYOPS_MEM=100 75',
          'VEYOPS_DISK=200 130',
        ].join('\n'),
      }),
    })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const base = '/api/v1';
    const session = (value: string) =>
      api.post(base + '/auth/login').send({ username: 'root', password: value });
    await session(process.env.ADMIN_PASSWORD).expect(201);
    await api
      .post(base + '/auth/change-password')
      .send({
        currentPassword: process.env.ADMIN_PASSWORD,
        newPassword: password,
      })
      .expect(200);
    await session(password).expect(201);
    const create = async (path: string, body: object) =>
      (
        await api
          .post(base + path)
          .send(body)
          .expect(201)
      ).body.data;
    const patch = async (path: string, body: object) =>
      (
        await api
          .patch(base + path)
          .send(body)
          .expect(200)
      ).body.data;
    const fetch = async (path: string) => (await api.get(base + path).expect(200)).body.data;
    const credential = await create('/credentials', {
      name: 'fixture',
      type: 'SSH_PASSWORD',
      secret: { password: 'fixture-secret' },
    });
    const serverInput = {
      name: 'Fixture host',
      host: '127.0.0.1',
      username: 'fixture',
      credentialId: credential.id,
      hostKeyFingerprint: 'a'.repeat(64),
      description: 'Initial description',
    };
    const server = await create('/servers', serverInput);
    const group = await create('/server-groups', { name: 'Initial group', serverIds: [] });
    const edited = await patch('/server-groups/' + group.id, {
      name: 'Edited group',
      description: 'Fixtures',
      serverIds: [server.id, server.id],
    });
    assert.deepEqual(edited.serverIds, [server.id]);
    await create('/servers/' + server.id + '/test', {});
    await patch('/servers/' + server.id, { ...serverInput, description: 'Changed description' });
    const checked = await fetch('/servers/' + server.id);
    assert.equal(checked.osType, 'Debian GNU/Linux');
    assert.equal(checked.status, 'ONLINE');
    assert.equal(checked.description, 'Changed description');
    assert.deepEqual(checked.groups, [{ id: group.id, name: 'Edited group' }]);
    assert.equal(checked.probeHistory[0].metrics.diskAvailableKb, 130);
    probeExitCode = 1;
    await api.post(base + '/servers/' + server.id + '/test').expect(400);
    assert.equal((await fetch('/servers/' + server.id)).status, 'OFFLINE');

    const project = await create('/projects', { name: 'Fixture A', slug: 'fixture-a' });
    const peer = await create('/projects', { name: 'Fixture B', slug: 'fixture-b' });
    const root = '/projects/' + project.id;
    const service = await create(root + '/services', { name: 'Service', slug: 'service' });
    const environment = await create(root + '/environments', { name: 'Test', slug: 'test' });
    const repo = await create(root + '/repositories', {
      name: 'Git',
      cloneUrl: 'https://example.invalid/test.git',
    });
    const [editedService, editedEnvironment, editedRepo] = await Promise.all([
      patch(root + '/services/' + service.id, {
        expectedRevision: service.revision,
        name: 'Service v2',
        slug: 'service',
        serviceType: 'API',
      }),
      patch(root + '/environments/' + environment.id, {
        name: 'Test v2',
        slug: 'test',
        environmentType: 'TESTING',
      }),
      patch(root + '/repositories/' + repo.id, {
        name: 'Git v2',
        cloneUrl: 'https://example.invalid/test.git',
        defaultBranch: 'develop',
      }),
    ]);
    assert.equal(editedService.serviceType, 'API');
    assert.equal(editedEnvironment.environmentType, 'TESTING');
    assert.equal(editedRepo.defaultBranch, null);
    assert.equal(editedRepo.branchSyncStatus, 'ERROR');
    const graphPath = root + '/execution-graph';
    const environmentSet = await create(root + '/environment-sets', { name: 'Flow variables' });
    const publishResourceReferences = async (withRelease: boolean) => {
      const { revision } = await fetch(graphPath);
      const actions = withRelease
        ? [
            { id: 'shell', type: 'SHELL', name: '构建文件', shell: { command: 'mkdir -p dist' } },
            { id: 'deploy', type: 'DEPLOY_ARTIFACT', name: '发布', deploy: { method: 'FILE' } },
          ]
        : [];
      const order = ['start', ...actions.map(({ id }) => id), 'end'];
      const draft = await api
        .put(base + graphPath + '/draft')
        .send({
          expectedRevision: revision,
          definition: {
            flows: [],
            canvas: {
              model: 'FLOW_V2',
              nodes: [
                {
                  id: 'start',
                  type: 'START',
                  name: '目标选择',
                  ...(withRelease && {
                    start: {
                      environmentSetId: environmentSet.id,
                      release: {
                        targets: { groupIds: [group.id] },
                        serviceId: service.id,
                        deployPath: '/srv/resource-fixture',
                        contentPath: 'dist',
                      },
                    },
                  }),
                },
                ...actions,
                { id: 'end', type: 'END', name: '完成' },
              ],
              edges: order.slice(1).map((to, index) => ({ from: order[index]!, to })),
              endpoints: [{ startId: 'start', endId: 'end' }],
              templates: [],
            },
          },
        })
        .expect(200);
      const published = await create(graphPath + '/publish', {
        expectedRevision: draft.body.data.revision,
      });
      return published.publishedVersion as number;
    };
    const resourceVersion = await publishResourceReferences(true);
    const blockedGroup = await api.delete(base + '/server-groups/' + group.id).expect(409);
    assert.ok(
      blockedGroup.body.error.references.some(
        (ref: { sourceKind: string; state: string; fieldId: string }) =>
          ref.sourceKind === 'GRAPH' &&
          ref.state === 'RUNNABLE' &&
          ref.fieldId === 'start.release.targets',
      ),
    );
    const graphInventory = await fetch(root + '/resource-references');
    assert.ok(
      graphInventory.references.some(
        (ref: { resourceId: string; state: string; fieldId: string }) =>
          ref.resourceId === environmentSet.id &&
          ref.state === 'RUNNABLE' &&
          ref.fieldId === 'start.environmentSetId',
      ),
    );
    assert.ok(
      graphInventory.servers
        .find((row: { id: string }) => row.id === server.id)
        ?.references.some(
          (ref: { sourceKind: string; state: string }) =>
            ref.sourceKind === 'GRAPH' && ref.state === 'RUNNABLE',
        ),
    );
    const fixtureTarget = await create('/deployment-targets', {
      name: 'Fixture deploy',
      serverIds: [server.id],
    });
    const configure = async (serviceId: string, environmentId: string) => {
      const scope = `/services/${serviceId}/environments/${environmentId}`;
      await replaceVariables(api, base + scope + '/variables', [
        { key: 'SERVICE_MODE', value: 'fixture' },
      ]);
      assert.equal(await fetch(scope + '/config'), null);
      await api
        .put(base + scope + '/config')
        .send({ targetId: fixtureTarget.id, deployPath: '/tmp/veyops-resource-fixture' })
        .expect(200);
      return scope;
    };
    const configuredScope = await configure(service.id, environment.id);
    await replaceVariables(api, base + `/environments/${environment.id}/variables`, [
      { key: 'ENVIRONMENT_MODE', value: 'fixture' },
    ]);
    const servicePath = root + '/services/' + service.id;
    const serviceWithAddresses = await patch(servicePath, {
      expectedRevision: editedService.revision,
      addresses: [
        { name: 'API', url: 'https://example.invalid/api' },
        { name: 'Docs', url: 'https://docs.example.invalid' },
      ],
    });
    const [address, docs] = serviceWithAddresses.addresses;
    const cards: {
      id: string;
      addresses: {
        id: string;
        name: string;
        url: string;
        serviceId: string;
        serviceName: string;
        environmentName: null;
      }[];
    }[] = await fetch('/projects?include=addresses');
    assert.deepEqual(
      cards.find((p) => p.id === project.id)?.addresses,
      [address, docs].map((link) => ({
        ...link,
        serviceId: service.id,
        serviceName: editedService.name,
        environmentName: null,
      })),
    );
    assert.deepEqual(cards.find((p) => p.id === peer.id)?.addresses, []);
    assert.equal('addresses' in (await fetch('/projects'))[0], false);
    const retainedAddress = await patch(servicePath, {
      expectedRevision: serviceWithAddresses.revision,
      addresses: [address],
    });
    assert.deepEqual(retainedAddress.addresses, [address]);
    await api
      .patch(base + '/projects/' + peer.id + '/services/' + service.id)
      .send({ expectedRevision: retainedAddress.revision, name: 'Wrong project', slug: 'wrong' })
      .expect(404);
    const otherServicePath = '/projects/' + peer.id + '/services';
    const otherService = await create(otherServicePath, {
      name: 'Peer service',
      slug: 'peer-service',
    });
    await api
      .patch(base + otherServicePath + '/' + otherService.id)
      .send({ expectedRevision: otherService.revision, addresses: [address] })
      .expect(400);
    await api.delete(base + root + '/services/' + service.id).expect(409);
    await publishResourceReferences(false);
    await create(`${graphPath}/versions/${resourceVersion}/retire`, {});
    assert.equal((await fetch(configuredScope + '/config')).targetId, fixtureTarget.id);
    assert.equal((await fetch(configuredScope + '/variables')).variables[0].key, 'SERVICE_MODE');
    assert.equal(
      (await fetch(`/environments/${environment.id}/variables`)).variables[0].key,
      'ENVIRONMENT_MODE',
    );
    const projectVarsPath = root + '/variables';
    const envVarsPath = `/environments/${environment.id}/variables`;
    const putVariables = (path: string, variables: object[], status?: number) =>
      replaceVariables(api, base + path, variables, status);
    const secretKey = 'DATABASE_URL';
    const secretValue = 'fixture-secret-value-to-encrypt';
    const common = [
      { key: 'ENVIRONMENT_MODE', value: 'common' },
      { key: 'SERVICE_MODE', value: 'common' },
    ];
    await putVariables(projectVarsPath, [
      ...common,
      { key: secretKey, value: secretValue, isSecret: true, description: 'Test database' },
    ]);
    const projectVariables = await fetch(projectVarsPath);
    const projectSecret = projectVariables.variables.find(
      (variable: { key: string }) => variable.key === secretKey,
    );
    assert.equal(projectSecret.value, null);
    assert.equal(projectSecret.isSecret, true);
    assert.equal(projectSecret.description, 'Test database');
    assert.equal('credentialId' in projectSecret, false);
    const db = app.get(DatabaseService).db;
    const stored = await db
      .selectFrom('project_variables')
      .innerJoin('credentials', 'credentials.id', 'project_variables.credential_id')
      .select(['value_text', 'ciphertext', 'credential_id'])
      .where('project_id', '=', project.id)
      .where('key', '=', secretKey)
      .executeTakeFirstOrThrow();
    assert.equal(stored.value_text, null);
    assert.ok(stored.ciphertext && !stored.ciphertext.includes(secretValue));
    assert.equal((await fetch('/credentials')).length, 1);
    await putVariables(projectVarsPath, [...common, { key: secretKey, keepSecret: true }]);
    const keptSnapshot = await fetch(projectVarsPath);
    assert.equal(keptSnapshot.revision, projectVariables.revision);
    const kept = keptSnapshot.variables.find(
      (variable: { key: string }) => variable.key === secretKey,
    );
    assert.deepEqual(kept, projectSecret);
    const revealUrl = base + projectVarsPath + '/' + secretKey + '/reveal';
    await putVariables(
      projectVarsPath,
      [...common, { key: secretKey, isSecret: true, value: '••••••••••••' }],
      400,
    );
    const revealed = await api.post(revealUrl).expect(201).expect('Cache-Control', 'no-store');
    assert.deepEqual(revealed.body.data, { value: secretValue });
    const staffPassword = 'fixture-operator-bootstrap';
    const staffChangedPassword = 'fixture-operator-changed';
    await create('/users', {
      username: 'fixture-operator',
      role: 'OPERATOR',
      password: staffPassword,
    });
    const staff = request.agent(app.getHttpServer());
    const staffLogin = (password: string) =>
      staff.post(base + '/auth/login').send({ username: 'fixture-operator', password });
    await staffLogin(staffPassword).expect(201);
    await staff
      .post(base + '/auth/change-password')
      .send({ currentPassword: staffPassword, newPassword: staffChangedPassword })
      .expect(200);
    await staffLogin(staffChangedPassword).expect(201);
    await staff.post(revealUrl).expect(403);
    const auditEntries = await db
      .selectFrom('audit_logs')
      .select('details_json')
      .where('action', '=', 'project.variables.reveal')
      .execute();
    assert.deepEqual(
      auditEntries.map((row) => JSON.parse(row.details_json)),
      [{ key: secretKey }],
    );
    const configs = app.get(ServiceConfigsService);
    assert.deepEqual(
      (await fetch(envVarsPath + '/inherited')).map((variable: { key: string }) => variable.key),
      [secretKey, 'SERVICE_MODE'],
    );
    const identifiers = {
      VEYOPS_PROJECT_ID: project.id,
      VEYOPS_PROJECT_SLUG: project.slug,
      VEYOPS_SERVICE_ID: service.id,
      VEYOPS_SERVICE_SLUG: service.slug,
    };
    const platformSources = Object.keys(identifiers).map((key) => ({
      key,
      isSecret: false,
      source: 'SYSTEM',
    }));
    assert.deepEqual(await configs.resolveVariables(project.id, environment.id, service.id), {
      variables: { ENVIRONMENT_MODE: 'fixture', SERVICE_MODE: 'fixture', ...identifiers },
      secretVariables: { [secretKey]: stored.credential_id },
      variableSources: [
        { key: secretKey, isSecret: true, source: 'PROJECT' },
        { key: 'ENVIRONMENT_MODE', isSecret: false, source: 'ENVIRONMENT' },
        { key: 'SERVICE_MODE', isSecret: false, source: 'SERVICE_ENVIRONMENT' },
        ...platformSources,
      ],
    });
    await putVariables(envVarsPath, [{ key: secretKey, value: 'environment-override' }]);
    assert.deepEqual(await configs.resolveVariables(project.id, environment.id, service.id), {
      variables: {
        ENVIRONMENT_MODE: 'common',
        SERVICE_MODE: 'fixture',
        [secretKey]: 'environment-override',
        ...identifiers,
      },
      secretVariables: {},
      variableSources: [
        { key: secretKey, isSecret: false, source: 'ENVIRONMENT' },
        { key: 'ENVIRONMENT_MODE', isSecret: false, source: 'PROJECT' },
        { key: 'SERVICE_MODE', isSecret: false, source: 'SERVICE_ENVIRONMENT' },
        ...platformSources,
      ],
    });
    await putVariables(envVarsPath, [{ key: secretKey, isSecret: true, keepSecret: true }], 400);
    await putVariables(envVarsPath, [{ key: 'VEYOPS_PROJECT_ID', value: 'override' }], 400);
    await putVariables(envVarsPath, [{ key: 'veyops_service_slug', value: 'override' }], 400);
    await putVariables(projectVarsPath, [
      ...common,
      { key: secretKey, isSecret: true, value: 'rotated-secret-value' },
    ]);
    await api
      .put(base + projectVarsPath)
      .send({
        expectedRevision: keptSnapshot.revision,
        variables: [{ key: secretKey, isSecret: true, keepSecret: true }],
      })
      .expect(409);
    await api
      .put(base + projectVarsPath)
      .send({ variables: [] })
      .expect(400);
    assert.equal((await fetch(projectVarsPath)).variables.length, 3);
    assert.deepEqual((await api.post(revealUrl).expect(201)).body.data, {
      value: 'rotated-secret-value',
    });
    const withoutAddresses = await patch(servicePath, {
      expectedRevision: retainedAddress.revision,
      addresses: [],
    });
    assert.deepEqual(withoutAddresses.addresses, []);
    await api.delete(base + root + '/environments/' + environment.id).expect(200);
    const staging = await create(root + '/environments', { name: 'Staging', slug: 'staging' });
    const unusedService = await create(root + '/services', {
      name: 'Unused service',
      slug: 'unused-service',
    });
    await configure(unusedService.id, staging.id);
    await api.delete(base + root + '/services/' + unusedService.id).expect(200);
    await configure(service.id, staging.id);
    assert.equal((await fetch(root)).deploymentTargets[0].id, fixtureTarget.id);
    const serverProjects: {
      id: string;
      name: string;
      slug: string;
      references: { environmentId?: string; viaTargetId?: string; state: string }[];
    }[] = (await fetch('/servers/' + server.id)).projects;
    assert.deepEqual(
      serverProjects.map(({ id, name, slug }) => ({ id, name, slug })),
      [
        {
          id: project.id,
          name: 'Fixture A',
          slug: 'fixture-a',
        },
      ],
    );
    assert.ok(
      serverProjects[0]?.references.some(
        ({ environmentId, viaTargetId, state }) =>
          environmentId === staging.id &&
          viaTargetId === fixtureTarget.id &&
          state === 'CONFIGURED',
      ),
    );

    const detail = await fetch(root);
    assert.equal('dependencies' in detail, false);
    assert.equal('dependents' in detail, false);
    const removedRoute = base + root + '/dependencies';
    await api.post(removedRoute).send({ dependsOnProjectId: peer.id }).expect(404);
    await api
      .patch(removedRoute + '/' + peer.id)
      .send({ dependsOnProjectId: peer.id })
      .expect(404);
    await api.delete(removedRoute + '/' + peer.id).expect(404);
    const peerPath = base + '/projects/' + peer.id;
    await api.delete(peerPath).expect(200);
    await api.get(peerPath).expect(404);
    assert.ok(
      (
        await db
          .selectFrom('projects')
          .select('deleted_at')
          .where('id', '=', peer.id)
          .executeTakeFirstOrThrow()
      ).deleted_at,
    );
    assert.equal(
      (
        await db
          .selectFrom('services')
          .select('project_id')
          .where('id', '=', otherService.id)
          .executeTakeFirstOrThrow()
      ).project_id,
      peer.id,
    );
    const pipeline = await create('/pipelines', {
      name: 'Test Pipeline',
      projectId: project.id,
      serviceId: service.id,
      definition: { repositoryId: repo.id },
    });
    assert.equal((await fetch(root)).pipelines, undefined);
    assert.ok(pipeline.id);
    await api.delete(base + root + '/repositories/' + repo.id).expect(409);
    await api.delete(base + root + '/services/' + service.id).expect(409);
    const unused = await create(root + '/repositories', {
      name: 'Unused',
      cloneUrl: 'https://example.invalid/unused.git',
    });
    await api.delete(base + root + '/repositories/' + unused.id).expect(200);
    const inUse = await api.delete(base + '/servers/' + server.id).expect(409);
    assert.ok(
      inUse.body.error.references.some(
        (ref: { environmentId?: string; state: string }) =>
          ref.environmentId === staging.id && ref.state === 'CONFIGURED',
      ),
    );
    await api.delete(base + root + '/environments/' + staging.id).expect(200);
    await api.delete(base + '/servers/' + server.id).expect(200);
    assert.deepEqual((await fetch('/server-groups'))[0].serverIds, []);
    await api.delete(base + '/server-groups/' + group.id).expect(200);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite resource management enforces ownership and preserves referenced resources', () =>
  checkResources());
const postgres = process.env.VEYOPS_TEST_POSTGRES_URL;
test(
  'PostgreSQL resource management enforces ownership and preserves referenced resources',
  { skip: !postgres },
  () => withIsolatedPostgres(postgres!, checkResources),
);
