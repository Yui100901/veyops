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

const project = (api: Api, name: string, slug: string, tags?: string[]) =>
  create<{ id: string }>(api, '/projects', { name, slug, tags });

async function checkPortal(api: Api, viewer: Api, db: Kysely<Database>, userId: string) {
  const [mixed, unchecked, running, empty, inactive, cancelled, firstFailure, uncertain] =
    await Promise.all([
      project(api, 'Mixed targets', 'mixed', ['Customer apps']),
      project(api, 'Unchecked', 'unchecked'),
      project(api, 'Running', 'running'),
      project(api, 'Empty', 'empty'),
      project(api, 'Inactive target', 'inactive'),
      project(api, 'Cancelled only', 'cancelled'),
      project(api, 'First failed release', 'first-failure', ['Internal apps']),
      project(api, 'Health needs checking', 'needs-checking'),
    ]);
  const now = Date.now();
  const timestamps = { created_at: now, updated_at: now };
  const [firstServer, secondServer, inactiveServer] = [randomUUID(), randomUUID(), randomUUID()];
  const targetId = randomUUID();
  await db
    .insertInto('servers')
    .values(
      [firstServer, secondServer, inactiveServer].map((id, index) => ({
        id,
        name: `Portal fixture server ${index + 1}`,
        host: '127.0.0.1',
        username: 'fixture',
        is_active: id === inactiveServer ? 0 : 1,
        ...timestamps,
      })),
    )
    .execute();
  await db
    .insertInto('deployment_targets')
    .values({ id: targetId, name: 'Portal targets', ...timestamps })
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
  const inactiveEnv = await environment(inactive.id, 'Testing', 'TESTING');
  const service = (projectId: string, slug: string, links: string[] = []) =>
    create<{ id: string; addresses: { id: string }[] }>(api, `/projects/${projectId}/services`, {
      name: slug,
      slug,
      addresses: links.map((name) => ({ name, url: `https://example.invalid/${name}` })),
    });
  const web = await service(mixed.id, 'web', ['home', 'docs']);
  const backend = await service(mixed.id, 'backend', ['api']);

  async function deploymentHistory(projectId: string, serviceId: string) {
    const [pipelineId, versionId] = [randomUUID(), randomUUID()];
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
    return async (
      envId: string,
      serverId: string,
      at: number,
      status: string,
      health: string,
      release?: { scopeKey: string; activated?: boolean; error?: string; record?: boolean },
    ) => {
      const [taskId, taskTargetId, runId, recordId] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ];
      const pending = status === 'RUNNING' || status === 'PENDING';
      const finishedAt = pending ? null : at + 1;
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
          release_scope_key: release?.scopeKey,
          error_summary: release?.error,
          started_at: release && status !== 'PENDING' ? at : null,
          finished_at: finishedAt,
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
      if (release?.record !== false)
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
            release_scope_key: release?.scopeKey,
            activated_at: release?.activated ? at : null,
            health_status: health,
            health_observed_at: health === 'HEALTHY' || health === 'FAILED' ? finishedAt : null,
            started_at: at,
            finished_at: finishedAt,
          })
          .execute();
      return { taskId, taskTargetId, recordId, serviceId };
    };
  }

  const mixedDeploy = await deploymentHistory(mixed.id, web.id);
  await mixedDeploy(production.id, firstServer, now + 10, 'FAILED', 'FAILED');
  for (const offset of [20, 30, 40, 50]) {
    await mixedDeploy(production.id, secondServer, now + offset, 'SUCCESS', 'HEALTHY');
  }
  const failed = await mixedDeploy(production.id, secondServer, now + 55, 'FAILED', 'FAILED');
  const tested = await mixedDeploy(testing.id, firstServer, now + 60, 'SUCCESS', 'HEALTHY');
  const backendDeploy = await deploymentHistory(mixed.id, backend.id);
  await backendDeploy(production.id, secondServer, now + 65, 'SUCCESS', 'HEALTHY');
  const uncheckedDeploy = await deploymentHistory(
    unchecked.id,
    (await service(unchecked.id, 'web', ['unchecked-service'])).id,
  );
  await uncheckedDeploy(uncheckedEnv.id, firstServer, now + 20, 'SUCCESS', 'NOT_CHECKED');
  const runningDeploy = await deploymentHistory(
    running.id,
    (await service(running.id, 'web', ['running-service'])).id,
  );
  await runningDeploy(runningEnv.id, firstServer, now + 20, 'RUNNING', 'PENDING');
  const inactiveDeploy = await deploymentHistory(
    inactive.id,
    (await service(inactive.id, 'web')).id,
  );
  await inactiveDeploy(inactiveEnv.id, inactiveServer, now + 20, 'SUCCESS', 'HEALTHY');

  const cancelledService = await service(cancelled.id, 'cancelled-service', ['cancelled']);
  const cancelledEnv = await environment(cancelled.id, 'Testing', 'TESTING');
  const cancelledDeploy = await deploymentHistory(cancelled.id, cancelledService.id);
  await cancelledDeploy(cancelledEnv.id, firstServer, now + 24, 'CANCELLED', 'NOT_CHECKED');

  const scope = (projectId: string, serviceId: string, serverId: string, path: string) =>
    JSON.stringify([projectId, serviceId, serverId, 'FILE', path]);
  const firstFailureService = await service(firstFailure.id, 'first-failure', ['first-failure']);
  const firstFailureEnv = await environment(firstFailure.id, 'Testing', 'TESTING');
  const firstFailedDeploy = await deploymentHistory(firstFailure.id, firstFailureService.id);
  await firstFailedDeploy(firstFailureEnv.id, firstServer, now + 25, 'FAILED', 'NOT_CHECKED', {
    scopeKey: scope(firstFailure.id, firstFailureService.id, firstServer, '/opt/failed'),
    record: false,
  });

  const uncertainService = await service(uncertain.id, 'needs-checking', ['needs-checking']);
  const uncertainEnv = await environment(uncertain.id, 'Testing', 'TESTING');
  const uncertainDeploy = await deploymentHistory(uncertain.id, uncertainService.id);
  await uncertainDeploy(uncertainEnv.id, firstServer, now + 26, 'SUCCESS', 'UNKNOWN', {
    scopeKey: scope(uncertain.id, uncertainService.id, firstServer, '/opt/uncertain'),
    activated: true,
  });

  const portal = await get<{
    tags: string[];
    projects: {
      id: string;
      services: {
        id: string;
        abnormal: boolean;
        addresses: { name: string; url: string }[];
        targets: {
          current: string | null;
          health: string | null;
          healthObservedAt: number | null;
          lastAttempt: string;
        }[];
      }[];
    }[];
  }>(viewer, '/portal?q=DoCs');
  assert.deepEqual(
    portal.projects.map(({ id }) => id),
    [mixed.id],
  );
  const [portalService] = portal.projects[0]!.services;
  assert.ok(portalService);
  assert.equal(portalService.id, web.id);
  assert.deepEqual(portalService.addresses, [
    { id: web.addresses[0]!.id, name: 'home', url: 'https://example.invalid/home' },
    { id: web.addresses[1]!.id, name: 'docs', url: 'https://example.invalid/docs' },
  ]);
  assert.ok(
    portalService.targets.some(
      (target) =>
        target.current === 'SUCCESS' &&
        target.lastAttempt === 'FAILED' &&
        target.health === 'HEALTHY' &&
        target.healthObservedAt === now + 51,
    ),
  );
  assert.ok(
    portalService.targets.every((target) => !('serverId' in target) && !('taskId' in target)),
  );
  const detailPath = `/projects/${mixed.id}/services/${web.id}/delivery-status`;
  const deliveryStatus = await get<
    {
      serverId: string;
      current: { status: string; commitSha: string; startedAt: number };
      latestAttempt: { id: string; status: string };
    }[]
  >(viewer, detailPath);
  const lastFailed = deliveryStatus.find(({ serverId }) => serverId === secondServer)!;
  assert.equal(lastFailed.current.status, 'SUCCESS');
  assert.equal(lastFailed.current.startedAt, now + 50);
  assert.equal(lastFailed.current.commitSha, 'a'.repeat(40));
  assert.equal(lastFailed.latestAttempt.id, failed.recordId);
  assert.equal(lastFailed.latestAttempt.status, 'FAILED');
  await viewer.get(apiBase + detailPath.replace(mixed.id, unchecked.id)).expect(404);
  const archivedService = await service(mixed.id, 'retired-link', ['archive-only']);
  await api.delete(`${apiBase}/projects/${mixed.id}/services/${archivedService.id}`).expect(200);
  assert.deepEqual((await get<typeof portal>(viewer, '/portal?q=archive-only')).projects, []);

  assert.deepEqual(portal.tags, ['Customer apps', 'Internal apps']);
  assert.equal(portalService.abnormal, true);
  const abnormal = (q?: string) =>
    get<typeof portal>(viewer, '/portal?abnormal=true' + (q ? '&' + q : ''));
  assert.deepEqual(
    new Set((await abnormal()).projects.map(({ id }) => id)),
    new Set([mixed.id, firstFailure.id, uncertain.id]),
  );
  assert.deepEqual(
    (await abnormal('q=docs&tag=Customer%20apps')).projects.map(({ id, services }) => ({
      id,
      services: services.map(({ id: serviceId }) => serviceId),
    })),
    [{ id: mixed.id, services: [web.id] }],
  );
  assert.deepEqual((await abnormal('q=docs&tag=Internal%20apps')).projects, []);
  assert.deepEqual((await abnormal('serviceId=' + backend.id)).projects, []);
  assert.equal((await abnormal('projectId=' + mixed.id)).projects[0]?.services[0]?.id, web.id);
  for (const id of [unchecked.id, running.id, empty.id, cancelled.id])
    assert.deepEqual((await abnormal('projectId=' + id)).projects, []);
  const firstRejectedTarget = (await abnormal('projectId=' + firstFailure.id)).projects[0]
    ?.services[0]?.targets[0];
  assert.equal(firstRejectedTarget?.current, null);
  assert.equal(firstRejectedTarget?.lastAttempt, 'FAILED');
  const uncertainTarget = (await abnormal('projectId=' + uncertain.id)).projects[0]?.services[0]
    ?.targets[0];
  assert.equal(uncertainTarget?.current, 'SUCCESS');
  assert.equal(uncertainTarget?.health, 'UNKNOWN');
  const uncheckedTarget = (
    await get<typeof portal>(viewer, '/portal?abnormal=false&projectId=' + unchecked.id)
  ).projects[0]?.services[0]?.targets[0];
  assert.equal(uncheckedTarget?.health, 'NOT_CHECKED');
  const runningTarget = (await get<typeof portal>(viewer, '/portal?projectId=' + running.id))
    .projects[0]?.services[0]?.targets[0];
  const cancelledTarget = (await get<typeof portal>(viewer, '/portal?projectId=' + cancelled.id))
    .projects[0]?.services[0]?.targets[0];
  assert.equal(runningTarget?.lastAttempt, 'RUNNING');
  assert.equal(cancelledTarget?.lastAttempt, 'CANCELLED');
  await viewer.get(apiBase + '/portal?abnormal=yes').expect(400);
  const retiredProject = await project(api, 'Archived project', 'archived-project', [
    'Archived tag',
  ]);
  await service(retiredProject.id, 'archived-project-service', ['archived-project-link']);
  await api.delete(apiBase + '/projects/' + retiredProject.id).expect(200);
  const archived = await get<typeof portal>(viewer, '/portal?q=archived-project');
  assert.deepEqual(archived.projects, []);
  assert.ok(!archived.tags.includes('Archived tag'));

  const recent = `/projects/${mixed.id}/services/${tested.serviceId}/recent-deployments`;
  const rows = await get<{ id: string; serviceId: string }[]>(api, recent);
  assert.equal(rows.length, 5);
  assert.equal(rows[0]?.id, tested.recordId);
  assert.ok(rows.every(({ serviceId }) => serviceId === tested.serviceId));
  const testRows = await get<{ id: string }[]>(api, `${recent}?environmentId=${testing.id}`);
  assert.deepEqual(
    testRows.map(({ id }) => id),
    [tested.recordId],
  );
  await api.get(`${apiBase}${recent}?environmentId=${uncheckedEnv.id}`).expect(404);
  await api.get(apiBase + recent.replace(mixed.id, unchecked.id)).expect(404);

  await mixedDeploy(production.id, secondServer, now + 70, 'SUCCESS', 'HEALTHY');
  await mixedDeploy(production.id, firstServer, now + 72, 'SUCCESS', 'HEALTHY');
  assert.deepEqual((await abnormal('projectId=' + mixed.id)).projects, []);

  const scopeKey = (serverId: string, location: string) =>
    JSON.stringify([mixed.id, web.id, serverId, 'FILE', location]);
  const first = scopeKey(firstServer, '/opt/first');
  const second = scopeKey(firstServer, '/opt/second');
  const third = scopeKey(secondServer, '/opt/first');
  const old = await mixedDeploy(testing.id, firstServer, now + 80, 'SUCCESS', 'HEALTHY', {
    scopeKey: first,
    activated: true,
  });
  const rejected = await mixedDeploy(testing.id, firstServer, now + 90, 'FAILED', 'NOT_CHECKED', {
    scopeKey: first,
    record: false,
    error: 'SSH failed password=fixture-hidden',
  });
  await mixedDeploy(testing.id, firstServer, now + 100, 'PENDING', 'NOT_CHECKED', {
    scopeKey: first,
    record: false,
  });
  const preparing = await mixedDeploy(
    testing.id,
    firstServer,
    now + 110,
    'RUNNING',
    'NOT_CHECKED',
    {
      scopeKey: second,
      record: false,
    },
  );
  const fresh = await mixedDeploy(testing.id, secondServer, now + 115, 'SUCCESS', 'HEALTHY', {
    scopeKey: third,
    activated: true,
  });
  const released = await get<
    {
      scopeKey: string;
      location: string;
      current: { id: string } | null;
      latestAttempt: {
        taskTargetId: string;
        deploymentRecordId: string | null;
        status: string;
        phase: string;
        errorSummary: string | null;
      };
    }[]
  >(viewer, detailPath);
  const rejectedHead = released.find(({ scopeKey }) => scopeKey === first)!;
  assert.equal(rejectedHead.current?.id, old.recordId);
  assert.equal(rejectedHead.latestAttempt.taskTargetId, rejected.taskTargetId);
  assert.equal(rejectedHead.latestAttempt.deploymentRecordId, null);
  assert.equal(rejectedHead.latestAttempt.status, 'FAILED');
  assert.equal(rejectedHead.latestAttempt.phase, 'PREPARE');
  assert.equal(rejectedHead.latestAttempt.errorSummary, 'SSH failed password=[REDACTED]');
  const preparingHead = released.find(({ scopeKey }) => scopeKey === second)!;
  assert.equal(preparingHead.location, '/opt/second');
  assert.equal(preparingHead.current, null);
  assert.equal(preparingHead.latestAttempt.taskTargetId, preparing.taskTargetId);
  assert.equal(preparingHead.latestAttempt.status, 'RUNNING');
  const freshHead = released.find(({ scopeKey }) => scopeKey === third)!;
  assert.equal(freshHead.latestAttempt.taskTargetId, fresh.taskTargetId);
  assert.equal(freshHead.latestAttempt.deploymentRecordId, fresh.recordId);
  assert.equal(freshHead.current?.id, fresh.recordId);

  const failedRelease = await mixedDeploy(testing.id, firstServer, now + 120, 'FAILED', 'FAILED', {
    scopeKey: first,
    activated: true,
  });
  const attemptedRecord = await db
    .selectFrom('deployment_records')
    .selectAll()
    .where('id', '=', failedRelease.recordId)
    .executeTakeFirstOrThrow();
  const restoredId = randomUUID();
  await db
    .insertInto('deployment_records')
    .values({
      ...attemptedRecord,
      id: restoredId,
      status: 'SUCCESS',
      health_status: 'HEALTHY',
      rollback_of_deployment_id: failedRelease.recordId,
      started_at: now + 122,
      activated_at: now + 123,
      health_observed_at: now + 124,
      finished_at: now + 124,
    })
    .execute();
  const restoredHead = (await get<typeof released>(viewer, detailPath)).find(
    ({ scopeKey }) => scopeKey === first,
  )!;
  assert.equal(restoredHead.current?.id, restoredId);
  assert.equal(restoredHead.latestAttempt.taskTargetId, failedRelease.taskTargetId);
  assert.equal(restoredHead.latestAttempt.deploymentRecordId, failedRelease.recordId);
  assert.equal(restoredHead.latestAttempt.status, 'FAILED');
}

async function checkPortalAccess(databaseUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-portal-'));
  const bootstrapPassword = 'portal-fixture-bootstrap';
  const password = 'portal-fixture-updated';
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
    const { LegacyDeliveryWriteFixtureModule } =
      await import('./helpers/legacy-delivery-write-fixture.module.js');
    const { configureApp } = await import('../bootstrap.js');
    const { DatabaseService } = await import('../core/database/database.service.js');
    const module = await Test.createTestingModule({
      imports: [AppModule, LegacyDeliveryWriteFixtureModule],
    }).compile();
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
      .get(apiBase + '/portal')
      .expect(401);
    await admin.get(apiBase + '/views').expect(404);
    await admin
      .post(apiBase + '/views')
      .send({ name: 'Retired view' })
      .expect(404);
    const system = await get<{ features: Record<string, boolean> }>(admin, '/system');
    assert.equal(system.features.views, undefined);
    await checkPortal(admin, viewer, db, current.id);
    const fixture = await get(viewer, '/portal?tag=Customer%20apps&abnormal=true');
    assert.deepEqual(await get(operator, '/portal?tag=Customer%20apps&abnormal=true'), fixture);
    assert.deepEqual(await get(admin, '/portal?tag=Customer%20apps&abnormal=true'), fixture);
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

test('SQLite portal filters and reports deployment facts for authorized members', () =>
  checkPortalAccess());
test(
  'PostgreSQL portal filters and reports deployment facts for authorized members',
  { skip: !postgres },
  async () => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgres!, checkPortalAccess);
  },
);
