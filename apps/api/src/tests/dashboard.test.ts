import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Kysely } from 'kysely';
import request from 'supertest';
import type { Database } from '../core/database/schema';

const base = '/api/v1';
const postgres = process.env.VEYOPS_TEST_POSTGRES_URL;
const time = 1_800_000_000_000;
const timestamps = { created_at: time, updated_at: time };
const sha = 'b'.repeat(40);
const previousDataDir = process.env.DATA_DIR;
let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'veyops-dashboard-'));
  process.env.DATA_DIR = directory;
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  await rm(directory, { recursive: true, force: true });
});

async function seedWorkspace(db: Kysely<Database>, userId: string) {
  const project = { id: randomUUID(), name: 'Checkout', slug: 'checkout' };
  const removed = { id: randomUUID(), name: 'Retired project', slug: 'retired-project' };
  await db
    .insertInto('projects')
    .values([
      { ...project, ...timestamps, created_by: userId },
      { ...removed, ...timestamps, created_by: userId, deleted_at: time + 1 },
    ])
    .execute();

  const servers = [
    { id: randomUUID(), name: 'First host', status: 'ONLINE', is_active: 1 },
    { id: randomUUID(), name: 'Second host', status: 'OFFLINE', is_active: 1 },
    { id: randomUUID(), name: 'Unprobed host', status: 'UNKNOWN', is_active: 1 },
    { id: randomUUID(), name: 'Retired host', status: 'ONLINE', is_active: 0 },
  ];
  await db
    .insertInto('servers')
    .values(
      servers.map((server) => ({ ...server, ...timestamps, host: '127.0.0.1', username: 'test' })),
    )
    .execute();
  const targetId = randomUUID();
  await db
    .insertInto('deployment_targets')
    .values({ id: targetId, name: 'Dashboard test targets', ...timestamps })
    .execute();

  const production = {
    id: randomUUID(),
    name: 'Production',
    project_id: project.id,
    slug: 'production',
  };
  const staging = { id: randomUUID(), name: 'Staging', project_id: project.id, slug: 'staging' };
  const oldEnv = {
    id: randomUUID(),
    name: 'Retired env',
    project_id: removed.id,
    slug: 'retired-env',
  };
  await db
    .insertInto('environments')
    .values([production, staging, oldEnv].map((env) => ({ ...env, ...timestamps })))
    .execute();

  const labels = [
    'Healthy',
    'Mixed',
    'Unknown',
    'Attention',
    'Unchecked',
    'Pending',
    'Retired target',
    'Undeployed',
    'Retired project',
  ] as const;
  const services = Object.fromEntries(
    labels.map((name) => [
      name,
      {
        id: randomUUID(),
        name,
        slug: name.toLowerCase().replaceAll(' ', '-'),
        project_id: name === 'Retired project' ? removed.id : project.id,
      },
    ]),
  );
  await db
    .insertInto('services')
    .values(Object.values(services).map((service) => ({ ...service, ...timestamps })))
    .execute();

  let deploymentId = 0;
  let taskCount = 0;
  async function deploy(
    label: (typeof labels)[number],
    environment: typeof production,
    runOffset: number,
    startedOffset: number | null,
    deployments: { server: number | null; status: string; health: string }[],
  ) {
    const service = services[label]!;
    const [pipelineId, versionId, taskId, runId] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const scope = { project_id: service.project_id, service_id: service.id };
    await db
      .insertInto('pipelines')
      .values({ id: pipelineId, ...scope, name: service.name, ...timestamps })
      .execute();
    await db
      .insertInto('pipeline_versions')
      .values({
        id: versionId,
        pipeline_id: pipelineId,
        version: 1,
        definition_json: '{}',
        created_by: userId,
        created_at: time,
      })
      .execute();
    const createdAt = time + runOffset;
    const startedAt = startedOffset === null ? null : time + startedOffset;
    const now = startedAt ?? createdAt;
    taskCount++;
    await db
      .insertInto('tasks')
      .values({
        id: taskId,
        ...scope,
        environment_id: environment.id,
        target_id: targetId,
        name: service.name,
        task_type: 'PIPELINE',
        status: deployments[0]!.status,
        created_by: userId,
        payload_json: '{}',
        created_at: createdAt,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('pipeline_runs')
      .values({
        id: runId,
        ...scope,
        environment_id: environment.id,
        target_id: targetId,
        task_id: taskId,
        pipeline_id: pipelineId,
        pipeline_version_id: versionId,
        git_ref: 'main',
        commit_sha: sha,
        build_location_snapshot: 'TARGET',
        artifact_type_snapshot: 'FILE',
        created_at: createdAt,
      })
      .execute();
    const rows = [];
    for (const deployment of deployments) {
      const server = deployment.server === null ? undefined : servers[deployment.server]!;
      const serverId = server?.id ?? null;
      const serverName = server?.name ?? 'Former host snapshot';
      const taskTargetId = randomUUID();
      const id = `00000000-0000-4000-8000-${String(++deploymentId).padStart(12, '0')}`;
      const finishedAt = deployment.status === 'RUNNING' ? null : now + 1;
      await db
        .insertInto('task_targets')
        .values({
          id: taskTargetId,
          task_id: taskId,
          server_id: serverId,
          server_name_snapshot: serverName,
          host_snapshot: '127.0.0.1',
          status: deployment.status,
        })
        .execute();
      await db
        .insertInto('deployment_records')
        .values({
          id,
          pipeline_run_id: runId,
          task_target_id: taskTargetId,
          service_id: service.id,
          environment_id: environment.id,
          server_id: serverId,
          status: deployment.status,
          health_status: deployment.health,
          release_version: sha,
          started_at: startedAt,
          finished_at: finishedAt,
        })
        .execute();
      rows.push({
        id,
        taskId,
        projectId: service.project_id,
        projectName: service.project_id === project.id ? project.name : removed.name,
        serviceId: service.id,
        serviceName: service.name,
        environmentId: environment.id,
        environmentName: environment.name,
        serverId,
        serverName,
        status: deployment.status,
        healthStatus: deployment.health,
        releaseVersion: sha,
        createdAt,
        startedAt,
        finishedAt,
      });
    }
    return rows;
  }

  const healthy = { status: 'SUCCESS', health: 'HEALTHY' };
  await deploy('Healthy', production, 15, 18, [{ server: 0, status: 'FAILED', health: 'FAILED' }]);
  await deploy('Healthy', production, 10, 20, [{ server: 0, status: 'FAILED', health: 'FAILED' }]);
  await deploy('Healthy', production, 10, 20, [
    { server: 0, ...healthy },
    { server: 1, ...healthy },
  ]);
  await deploy('Mixed', staging, 30, 30, [{ server: 0, status: 'SUCCESS', health: 'FAILED' }]);
  await deploy('Mixed', production, 40, 40, [{ server: 0, ...healthy }]);
  const mixedPeer = await deploy('Mixed', staging, 50, 50, [{ server: 1, ...healthy }]);
  const unknown = await deploy('Unknown', production, 55, 55, [
    { server: 0, status: 'SUCCESS', health: 'UNKNOWN' },
  ]);
  const attention = await deploy('Attention', production, 60, 60, [
    { server: 0, status: 'NEEDS_ATTENTION', health: 'NOT_CHECKED' },
  ]);
  await deploy('Unchecked', staging, 15, 15, [
    { server: 0, status: 'SUCCESS', health: 'NOT_CHECKED' },
  ]);
  const pending = await deploy('Pending', staging, 70, 70, [
    { server: 0, status: 'RUNNING', health: 'NOT_CHECKED' },
  ]);
  const retired = await deploy('Retired target', production, 57, null, [
    { server: 3, ...healthy },
    { server: null, ...healthy },
  ]);
  await deploy('Retired project', oldEnv, 100, 100, [
    { server: 0, status: 'FAILED', health: 'FAILED' },
  ]);

  return {
    expectedRecent: [...pending, ...attention, ...retired.reverse(), ...unknown, ...mixedPeer],
    taskCount,
  };
}

async function checkDashboard(url?: string) {
  const initial = randomBytes(24).toString('hex');
  const settings = {
    DATABASE_CLIENT: url ? 'postgres' : 'sqlite',
    DATABASE_URL: url,
    DATABASE_PATH: ':memory:',
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: initial,
    WORKER_ENABLED: 'false',
    COOKIE_SECURE: 'false',
  };
  const previous = Object.keys(settings).map((name) => [name, process.env[name]] as const);
  for (const [name, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
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
    const server = app.getHttpServer();
    const { db } = app.get(DatabaseService);
    const api = request.agent(server);
    const dashboard = async () => (await api.get(base + '/dashboard').expect(200)).body.data;
    await request(server)
      .get(base + '/dashboard')
      .expect(401);
    const {
      id: userId,
      mustChangePassword,
      passwordChangeRecommended,
    } = (
      await api
        .post(base + '/auth/login')
        .send({ username: 'root', password: initial })
        .expect(201)
    ).body.data;
    assert.equal(mustChangePassword, false);
    assert.equal(passwordChangeRecommended, true);
    const empty = await dashboard();
    assert.deepEqual(empty.services, { total: 0, running: 0, abnormal: 0 });
    assert.deepEqual(empty.recentDeployments, []);
    assert.deepEqual(empty.recentFailedTasks, []);
    await api.post(base + '/auth/dismiss-password-reminder').expect(200);

    const { expectedRecent, taskCount } = await seedWorkspace(db, userId);
    const failures = [
      'FAILED',
      'PARTIAL_FAILED',
      'TIMED_OUT',
      'NEEDS_ATTENTION',
      'FAILED',
      'PARTIAL_FAILED',
      'TIMED_OUT',
    ];
    const states = [
      ...failures,
      'CANCELLED',
      'PENDING',
      'RUNNING',
      'CANCEL_REQUESTED',
      ...Array<string>(101).fill('SUCCESS'),
    ];
    const tasks = states.map((status, index) => {
      const createdAt = time + 1000 + (index === 6 ? 5 : index);
      return {
        id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        name: `Task ${index}`,
        task_type: 'COMMAND',
        created_by: userId,
        status,
        payload_json: '{}',
        created_at: createdAt,
        updated_at: createdAt,
      };
    });
    await db.insertInto('tasks').values(tasks).execute();

    const result = await dashboard();
    assert.deepEqual(result.servers, { total: 3, online: 1, offline: 1, unknown: 1 });
    assert.equal(result.projects, 1);
    assert.deepEqual(result.services, { total: 8, running: 1, abnormal: 3 });
    assert.equal(result.totalTasks, taskCount + tasks.length);
    assert.equal(result.activeTasks, 4);
    assert.deepEqual(
      result.recentFailedTasks.map((task: { id: string }) => task.id),
      tasks
        .slice(1, failures.length)
        .reverse()
        .map((task) => task.id),
    );
    assert.deepEqual(
      result.recentTasks.map((task: { id: string }) => task.id),
      tasks
        .slice(-6)
        .reverse()
        .map((task) => task.id),
    );
    assert.deepEqual(result.recentDeployments, expectedRecent);
    await api.get(base + '/tasks/' + result.recentDeployments[0].taskId).expect(200);
  } finally {
    try {
      await app?.close();
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
}

test('SQLite dashboard summarizes latest deployment health and failed work', () =>
  checkDashboard());
test(
  'PostgreSQL dashboard summarizes latest deployment health and failed work',
  { skip: !postgres },
  async () => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgres!, checkDashboard);
  },
);
