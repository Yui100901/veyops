import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Kysely } from 'kysely';
import request from 'supertest';
import type { Database } from '../core/database/schema';

const apiBase = '/api/v1';
const postgres = process.env.VEYOPS_TEST_POSTGRES_URL;

type Api = ReturnType<typeof request.agent>;
type Summary = {
  id: string;
  kind: string;
  name: string;
  description: string;
  projectIds: string[];
  isDefault: boolean;
};
type ViewIndex = { views: Summary[]; defaultViewId: string };
type ViewProject = {
  id: string;
  deploymentStatus: string;
  environments: { id: string; environmentType: string }[];
  addresses: { id: string; url: string }[];
  recentDeployments: {
    id: string;
    taskId: string;
    environmentId: string;
    serverId: string;
    status: string;
    healthStatus: string;
  }[];
};
type ViewDetail = Summary & { projects: ViewProject[] };

async function get<T>(api: Api, path: string): Promise<T> {
  return (await api.get(apiBase + path).expect(200)).body.data;
}

async function create<T>(api: Api, path: string, input: object): Promise<T> {
  return (
    await api
      .post(apiBase + path)
      .send(input)
      .expect(201)
  ).body.data;
}

async function edit(api: Api, id: string, input: object): Promise<Summary> {
  return (
    await api
      .patch(apiBase + '/views/' + id)
      .send(input)
      .expect(200)
  ).body.data;
}

const project = (api: Api, name: string, slug: string) =>
  create<{ id: string }>(api, '/projects', { name, slug });

async function checkCustomViews(
  admin: Api,
  operator: Api,
  viewer: Api,
  database: Kysely<Database>,
  adminId: string,
) {
  const alpha = await project(admin, 'Alpha', 'alpha');
  const beta = await project(admin, 'Beta', 'beta');
  const removed = await project(admin, 'Archived', 'archived');
  const initial = { name: 'My deployments', projectIds: [beta.id, alpha.id, removed.id] };
  assert.equal((await get<ViewIndex>(admin, '/views')).defaultViewId, 'all');
  const privateView = await create<Summary>(admin, '/views', { ...initial, isDefault: true });
  assert.equal(privateView.kind, 'CUSTOM');
  assert.equal(privateView.isDefault, true);
  assert.deepEqual(privateView.projectIds, initial.projectIds);

  const index = await get<ViewIndex>(admin, '/views');
  assert.equal(index.defaultViewId, privateView.id);
  assert.equal(index.views.find(({ id }) => id === 'all')?.isDefault, false);
  assert.deepEqual(
    index.views.filter(({ kind }) => kind !== 'CUSTOM').map(({ id }) => id),
    ['all', 'production', 'testing', 'abnormal'],
  );
  assert.deepEqual(
    (await get<ViewDetail>(admin, '/views/' + privateView.id)).projects.map(({ id }) => id),
    initial.projectIds,
  );

  await operator.get(apiBase + '/views/' + privateView.id).expect(404);
  await operator
    .patch(apiBase + '/views/' + privateView.id)
    .send(initial)
    .expect(404);
  await operator.delete(apiBase + '/views/' + privateView.id).expect(404);
  assert.equal((await get<ViewIndex>(operator, '/views')).defaultViewId, 'all');
  const operatorView = await create<Summary>(operator, '/views', {
    name: 'Operator view',
    projectIds: [alpha.id],
    isDefault: true,
  });
  await admin.get(apiBase + '/views/' + operatorView.id).expect(404);
  assert.equal((await get<ViewIndex>(viewer, '/views')).views.length, 4);
  await viewer.get(apiBase + '/views/all').expect(200);
  await viewer.get(apiBase + '/views/' + privateView.id).expect(404);
  await viewer
    .post(apiBase + '/views')
    .send(initial)
    .expect(403);
  await viewer
    .patch(apiBase + '/views/' + privateView.id)
    .send(initial)
    .expect(403);
  await viewer.delete(apiBase + '/views/' + privateView.id).expect(403);
  await admin
    .patch(apiBase + '/views/production')
    .send(initial)
    .expect(403);
  await admin.delete(apiBase + '/views/all').expect(403);

  const amended = {
    name: 'Release order',
    description: 'Shown in order',
    projectIds: [alpha.id, removed.id, beta.id],
  };
  const changed = await edit(admin, privateView.id, amended);
  assert.equal(changed.name, amended.name);
  assert.equal(changed.description, amended.description);
  assert.equal(changed.isDefault, true);
  assert.deepEqual(changed.projectIds, amended.projectIds);
  const editedPath = apiBase + '/views/' + privateView.id;
  for (const projectIds of [[beta.id, beta.id], [randomUUID()], ['not-a-uuid']]) {
    await admin
      .patch(editedPath)
      .send({ ...amended, projectIds, isDefault: false })
      .expect(400);
  }
  assert.deepEqual(
    (await get<ViewDetail>(admin, '/views/' + privateView.id)).projects.map(({ id }) => id),
    amended.projectIds,
  );
  assert.equal((await get<ViewIndex>(admin, '/views')).defaultViewId, privateView.id);

  await admin.delete(apiBase + '/projects/' + removed.id).expect(200);
  const afterRemoval = await get<ViewDetail>(admin, '/views/' + privateView.id);
  assert.deepEqual(afterRemoval.projectIds, [alpha.id, beta.id]);
  assert.deepEqual(
    afterRemoval.projects.map(({ id }) => id),
    [alpha.id, beta.id],
  );
  assert.ok(!(await get<ViewDetail>(admin, '/views/all')).projectIds.includes(removed.id));
  await admin
    .post(apiBase + '/views')
    .send({ ...initial, projectIds: [removed.id] })
    .expect(400);

  const concurrent = await Promise.all(
    ['First default', 'Second default'].map((name) =>
      create<Summary>(admin, '/views', {
        name,
        projectIds: [],
        isDefault: true,
      }),
    ),
  );
  const afterSwitch = await get<ViewIndex>(admin, '/views');
  const defaults = afterSwitch.views.filter(({ isDefault }) => isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0]?.id, afterSwitch.defaultViewId);
  assert.ok(concurrent.some(({ id }) => id === afterSwitch.defaultViewId));
  assert.equal((await get<ViewIndex>(operator, '/views')).defaultViewId, operatorView.id);
  await admin.delete(apiBase + '/views/' + afterSwitch.defaultViewId).expect(200);
  assert.equal((await get<ViewIndex>(admin, '/views')).defaultViewId, 'all');
  await edit(admin, privateView.id, {
    name: 'Restored default',
    projectIds: [alpha.id],
    isDefault: true,
  });
  await edit(admin, privateView.id, {
    name: 'Cleared default',
    projectIds: [alpha.id],
    isDefault: false,
  });
  assert.equal((await get<ViewIndex>(admin, '/views')).defaultViewId, 'all');
  await admin.delete(editedPath).expect(200);
  await admin.get(editedPath).expect(404);
  await admin.get(apiBase + '/projects/' + alpha.id).expect(200);
  assert.equal(
    (
      await database
        .selectFrom('view_projects')
        .select('project_id')
        .where('view_id', '=', privateView.id)
        .execute()
    ).length,
    0,
  );
  const audit = await database
    .selectFrom('audit_logs')
    .select('action')
    .where('user_id', '=', adminId)
    .where('resource_id', '=', privateView.id)
    .execute();
  assert.deepEqual(
    new Set(audit.map(({ action }) => action)),
    new Set(['view.create', 'view.update', 'view.delete']),
  );
}

async function checkPresets(api: Api, db: Kysely<Database>, userId: string) {
  const [mixed, unchecked, running, empty] = await Promise.all([
    project(api, 'Mixed environments', 'mixed'),
    project(api, 'Unchecked', 'unchecked'),
    project(api, 'Running', 'running'),
    project(api, 'Empty', 'empty'),
  ]);
  const now = Date.now();
  const timestamps = { created_at: now, updated_at: now };
  const serverIds = [randomUUID(), randomUUID()];
  const targetId = randomUUID();
  await db
    .insertInto('servers')
    .values(
      serverIds.map((id, index) => ({
        id,
        name: `View fixture server ${index + 1}`,
        host: '127.0.0.1',
        username: 'fixture',
        ...timestamps,
      })),
    )
    .execute();
  await db
    .insertInto('deployment_targets')
    .values({ id: targetId, name: 'View targets', ...timestamps })
    .execute();

  const environment = (id: string, name: string, environmentType: 'PRODUCTION' | 'TESTING') =>
    create<{ id: string }>(api, `/projects/${id}/environments`, {
      name,
      slug: environmentType.toLowerCase(),
      environmentType,
    });
  const production = await environment(mixed.id, 'Production', 'PRODUCTION');
  const testing = await environment(mixed.id, 'Testing', 'TESTING');
  const uncheckedEnv = await environment(unchecked.id, 'Testing', 'TESTING');
  const runningEnv = await environment(running.id, 'Testing', 'TESTING');
  const address = (name: string, environmentId?: string) =>
    create<{ id: string }>(api, `/projects/${mixed.id}/addresses`, {
      name,
      url: `https://example.invalid/${name}`,
      environmentId,
    });
  const sharedAddress = await address('shared');
  const prodAddress = await address('prod', production.id);
  const testAddress = await address('test', testing.id);

  async function deploymentHistory(projectId: string) {
    const [serviceId, pipelineId, versionId] = [randomUUID(), randomUUID(), randomUUID()];
    await db
      .insertInto('services')
      .values({
        id: serviceId,
        project_id: projectId,
        name: 'Service',
        slug: 'service',
        ...timestamps,
      })
      .execute();
    await db
      .insertInto('pipelines')
      .values({
        id: pipelineId,
        project_id: projectId,
        service_id: serviceId,
        name: 'Pipeline',
        ...timestamps,
      })
      .execute();
    await db
      .insertInto('pipeline_versions')
      .values({
        id: versionId,
        pipeline_id: pipelineId,
        version: 1,
        definition_json: '{}',
        created_by: userId,
        created_at: now,
      })
      .execute();
    return async (envId: string, serverId: string, at: number, status: string, health: string) => {
      const [taskId, taskTargetId, runId, recordId] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const finishedAt = status === 'RUNNING' ? null : at + 1;
      await db
        .insertInto('tasks')
        .values({
          id: taskId,
          task_type: 'PIPELINE',
          created_by: userId,
          project_id: projectId,
          service_id: serviceId,
          environment_id: envId,
          target_id: targetId,
          status,
          payload_json: '{}',
          created_at: at,
          updated_at: finishedAt ?? at,
          finished_at: finishedAt,
        })
        .execute();
      await db
        .insertInto('task_targets')
        .values({
          id: taskTargetId,
          task_id: taskId,
          server_id: serverId,
          status,
          server_name_snapshot: 'Fixture',
          host_snapshot: '127.0.0.1',
        })
        .execute();
      await db
        .insertInto('pipeline_runs')
        .values({
          id: runId,
          task_id: taskId,
          pipeline_id: pipelineId,
          pipeline_version_id: versionId,
          project_id: projectId,
          service_id: serviceId,
          environment_id: envId,
          target_id: targetId,
          git_ref: 'main',
          commit_sha: 'a'.repeat(40),
          build_location_snapshot: 'TARGET',
          artifact_type_snapshot: 'FILE',
          created_at: at,
        })
        .execute();
      await db
        .insertInto('deployment_records')
        .values({
          id: recordId,
          pipeline_run_id: runId,
          task_target_id: taskTargetId,
          service_id: serviceId,
          environment_id: envId,
          server_id: serverId,
          status,
          health_status: health,
          started_at: at,
          finished_at: finishedAt,
        })
        .execute();
      return { taskId, recordId };
    };
  }

  const mixedDeploy = await deploymentHistory(mixed.id);
  await mixedDeploy(production.id, serverIds[0]!, now + 10, 'FAILED', 'FAILED');
  for (const offset of [20, 30, 40, 50]) {
    await mixedDeploy(production.id, serverIds[1]!, now + offset, 'SUCCESS', 'HEALTHY');
  }
  const tested = await mixedDeploy(testing.id, serverIds[0]!, now + 60, 'SUCCESS', 'HEALTHY');
  const uncheckedDeploy = await deploymentHistory(unchecked.id);
  await uncheckedDeploy(uncheckedEnv.id, serverIds[0]!, now + 20, 'SUCCESS', 'NOT_CHECKED');
  const runningDeploy = await deploymentHistory(running.id);
  await runningDeploy(runningEnv.id, serverIds[0]!, now + 20, 'RUNNING', 'PENDING');

  const all = await get<ViewDetail>(api, '/views/all');
  assert.equal(all.projects.find(({ id }) => id === empty.id)?.deploymentStatus, 'NOT_DEPLOYED');
  assert.equal(all.projects.find(({ id }) => id === mixed.id)?.deploymentStatus, 'ABNORMAL');
  assert.equal(all.projects.find(({ id }) => id === unchecked.id)?.deploymentStatus, 'UNVERIFIED');
  assert.equal(all.projects.find(({ id }) => id === running.id)?.deploymentStatus, 'RUNNING');
  assert.deepEqual((await get<ViewDetail>(api, '/views/abnormal')).projectIds, [mixed.id]);

  const prod = await get<ViewDetail>(api, '/views/production');
  assert.deepEqual(prod.projectIds, [mixed.id]);
  const prodProject = prod.projects[0]!;
  assert.equal(prodProject.deploymentStatus, 'ABNORMAL');
  assert.deepEqual(
    prodProject.environments.map(({ id }) => id),
    [production.id],
  );
  assert.deepEqual(
    new Set(prodProject.addresses.map(({ id }) => id)),
    new Set([sharedAddress.id, prodAddress.id]),
  );
  assert.equal(prodProject.recentDeployments.length, 3);
  assert.ok(
    prodProject.recentDeployments.every(
      ({ status, environmentId }) => status === 'SUCCESS' && environmentId === production.id,
    ),
  );

  const testView = await get<ViewDetail>(api, '/views/testing');
  assert.deepEqual(new Set(testView.projectIds), new Set([mixed.id, unchecked.id, running.id]));
  const testProject = testView.projects.find(({ id }) => id === mixed.id)!;
  assert.equal(testProject.deploymentStatus, 'HEALTHY');
  assert.deepEqual(
    testProject.environments.map(({ id }) => id),
    [testing.id],
  );
  assert.deepEqual(
    new Set(testProject.addresses.map(({ id }) => id)),
    new Set([sharedAddress.id, testAddress.id]),
  );
  assert.equal(testProject.recentDeployments[0]?.taskId, tested.taskId);
  assert.equal(testProject.recentDeployments[0]?.id, tested.recordId);

  const fix = await mixedDeploy(production.id, serverIds[0]!, now + 70, 'SUCCESS', 'HEALTHY');
  assert.deepEqual((await get<ViewDetail>(api, '/views/abnormal')).projectIds, []);
  const repaired = (await get<ViewDetail>(api, '/views/production')).projects[0]!;
  assert.equal(repaired.deploymentStatus, 'HEALTHY');
  assert.equal(repaired.recentDeployments[0]?.taskId, fix.taskId);
}

async function checkViews(databaseUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-views-'));
  const bootstrapPassword = 'views-fixture-bootstrap';
  const password = 'views-fixture-updated';
  const environment = {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    DATABASE_URL: databaseUrl,
    DATABASE_PATH: join(directory, 'test.db'),
    DATA_DIR: directory,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    WORKER_ENABLED: 'false',
    ADMIN_PASSWORD: bootstrapPassword,
    COOKIE_SECURE: 'false',
  };
  const previous = Object.keys(environment).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let app: NestExpressApplication | undefined;
  try {
    const { AppModule } = await import('../app.module.js');
    const { configureApp } = await import('../bootstrap.js');
    const { DatabaseService } = await import('../core/database/database.service.js');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    const { db } = app.get(DatabaseService);
    const server = app.getHttpServer();
    const admin = request.agent(server);
    const operator = request.agent(server);
    const viewer = request.agent(server);
    await admin
      .post(apiBase + '/auth/login')
      .send({ username: 'root', password: bootstrapPassword })
      .expect(201);
    await admin
      .post(apiBase + '/auth/change-password')
      .send({ currentPassword: bootstrapPassword, newPassword: password })
      .expect(200);
    await admin
      .post(apiBase + '/auth/login')
      .send({ username: 'root', password })
      .expect(201);
    const current = await db
      .selectFrom('users')
      .select(['id', 'password_hash'])
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('users')
      .values(
        ['OPERATOR', 'VIEWER'].map((role) => ({
          id: randomUUID(),
          username: role.toLowerCase(),
          role,
          password_hash: current.password_hash,
          created_at: Date.now(),
          updated_at: Date.now(),
        })),
      )
      .execute();
    await operator
      .post(apiBase + '/auth/login')
      .send({ username: 'operator', password })
      .expect(201);
    await viewer
      .post(apiBase + '/auth/login')
      .send({ username: 'viewer', password })
      .expect(201);
    await request(server)
      .get(apiBase + '/views')
      .expect(401);
    await checkCustomViews(admin, operator, viewer, db, current.id);
    await checkPresets(admin, db, current.id);
  } finally {
    try {
      await app?.close();
      await rm(directory, { recursive: true, force: true });
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}

test('SQLite project views persist private ordered collections and scope deployment health', () =>
  checkViews());
test(
  'PostgreSQL project views persist private ordered collections and scope deployment health',
  { skip: !postgres },
  async () => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgres!, checkViews);
  },
);
