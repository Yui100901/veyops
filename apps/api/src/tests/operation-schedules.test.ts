import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  normalizeScheduleTiming,
  upcomingTimes,
} from '../modules/operation-schedules/operation-schedule-time';

test('schedule timing stays on its interval anchor and skips missing and repeated Cron wall times', () => {
  const interval = normalizeScheduleTiming({
    type: 'INTERVAL',
    intervalSeconds: 10,
    timeZone: 'Asia/Shanghai',
  });
  assert.deepEqual(upcomingTimes(interval, 15_000, 33_000, 2), [35_000, 45_000]);
  const spring = normalizeScheduleTiming({
    type: 'CRON',
    cron: '30 2 * * *',
    timeZone: 'America/New_York',
  });
  const springStart = Date.parse('2026-03-08T01:00:00-05:00');
  assert.deepEqual(upcomingTimes(spring, springStart, springStart, 1), [
    Date.parse('2026-03-09T02:30:00-04:00'),
  ]);
  const fall = normalizeScheduleTiming({
    type: 'CRON',
    cron: '30 1 * * *',
    timeZone: 'America/New_York',
  });
  const fallStart = Date.parse('2026-11-01T00:00:00-04:00');
  assert.deepEqual(upcomingTimes(fall, fallStart, fallStart, 2), [
    Date.parse('2026-11-01T01:30:00-04:00'),
    Date.parse('2026-11-02T01:30:00-05:00'),
  ]);
  const afterFirst = Date.parse('2026-11-01T01:45:00-04:00');
  assert.deepEqual(upcomingTimes(fall, fallStart, afterFirst, 1), [
    Date.parse('2026-11-02T01:30:00-05:00'),
  ]);
  assert.throws(
    () => normalizeScheduleTiming({ type: 'CRON', timeZone: 'UTC', cron: '* * * * * *' }),
    /五字段/,
  );
});

const postgresTestUrl = process.env.VEYOPS_TEST_POSTGRES_URL;
let directory: string;
const previousDirectory = process.env.DATA_DIR;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'veyops-operation-schedules-'));
  process.env.DATA_DIR = directory;
});
after(async () => {
  if (previousDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDirectory;
  await rm(directory, { recursive: true, force: true });
});

async function verifySchedules(databaseUrl?: string) {
  const temporaryPassword = 'schedule-fixture-initial';
  const password = 'schedule-fixture-rotated';
  const configuration = {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    DATABASE_URL: databaseUrl,
    DATABASE_PATH: join(directory, 'test.sqlite'),
    WORKER_ENABLED: 'false',
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: temporaryPassword,
    COOKIE_SECURE: 'false',
  };
  const previous = Object.fromEntries(
    Object.keys(configuration).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(configuration)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { OperationSchedulesService } =
    await import('../modules/operation-schedules/operation-schedules.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const operator = request.agent(app.getHttpServer());
    const base = '/api/v1';
    const signIn = async (session: typeof api, username: string) => {
      await session
        .post(base + '/auth/login')
        .send({ username, password: temporaryPassword })
        .expect(201);
      await session
        .post(base + '/auth/change-password')
        .send({ currentPassword: temporaryPassword, newPassword: password })
        .expect(200);
      await session
        .post(base + '/auth/login')
        .send({ username, password })
        .expect(201);
    };
    await signIn(api, 'root');
    const create = async (path: string, body: object, session = api) =>
      (
        await session
          .post(base + path)
          .send(body)
          .expect(201)
      ).body.data;
    const user = await create('/users', {
      username: 'schedule-owner',
      password: temporaryPassword,
      role: 'OPERATOR',
    });
    await signIn(operator, 'schedule-owner');
    const credential = await create('/credentials', {
      name: 'fixture',
      type: 'SSH_PASSWORD',
      secret: { password: 'test-only-fixture' },
    });
    const serverA = await create('/servers', {
      name: 'Fixture A',
      host: 'fixture-a.test',
      username: 'ops',
      credentialId: credential.id,
      hostKeyFingerprint: 'a'.repeat(64),
    });
    const serverB = await create('/servers', {
      name: 'Fixture B',
      host: 'fixture-b.test',
      username: 'ops',
      credentialId: credential.id,
      hostKeyFingerprint: 'b'.repeat(64),
    });
    const group = await create('/server-groups', {
      name: 'Fixture group',
      serverIds: [serverA.id],
    });
    const command = await create('/command-templates', {
      name: 'Fixture command',
      command: 'printf "$VEYOPS_PARAM_MESSAGE"',
      parameters: [{ name: 'MESSAGE', type: 'STRING', required: true }],
    });
    await api
      .patch(base + '/command-templates/' + command.id)
      .send({
        name: 'Updated fixture',
        command: 'printf "second version"',
      })
      .expect(200);
    const plan = await create('/operation-plans', {
      name: 'Fixture plan',
      steps: [{ name: 'Observe', command: 'uname -a' }],
    });
    const schedule = app.get(OperationSchedulesService);
    const db = app.get(DatabaseService).db;
    const root = '/operation-schedules';
    const body = {
      name: 'Fixture interval',
      kind: 'COMMAND_TEMPLATE',
      sourceId: command.id,
      sourceVersion: 1,
      timing: { type: 'INTERVAL', intervalSeconds: 10, timeZone: 'UTC' },
      target: { serverIds: [], groupIds: [group.id] },
      parameters: { MESSAGE: 'first version' },
      requireConfirmation: false,
      maxParallel: 2,
      failurePolicy: 'STOP',
      timeoutSeconds: 37,
    };
    const save = async (data: object, session = api) => {
      const preview = await create(root + '/preview', data, session);
      return create(
        root,
        { ...data, enabled: true, expectedConfigurationHash: preview.configurationHash },
        session,
      );
    };
    const history = async (id: string) =>
      (await api.get(base + root + '/' + id + '/runs').expect(200)).body.data;
    const disable = async (id: string) => api.post(base + root + '/' + id + '/disable').expect(201);
    const workerPlan = await save({
      ...body,
      name: 'Worker fixture',
      timing: { type: 'INTERVAL', intervalSeconds: 1, timeZone: 'UTC' },
      requireConfirmation: true,
    });
    await delay(Math.max(0, workerPlan.nextRunAt - Date.now() + 10));
    await app.get(TaskWorkerService).tick();
    assert.equal((await history(workerPlan.id))[0].status, 'AWAITING_CONFIRMATION');
    await disable(workerPlan.id);
    const interval = await save(body, operator);
    await Promise.all([schedule.tick(interval.nextRunAt), schedule.tick(interval.nextRunAt)]);
    const [first] = await history(interval.id);
    assert.equal((await history(interval.id)).length, 1);
    assert.equal(first.status, 'PENDING');
    assert.equal(first.ownerName, 'schedule-owner');
    const persisted = await db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', first.taskId)
      .executeTakeFirstOrThrow();
    const task = JSON.parse(persisted.payload_json);
    assert.equal(task.commandTemplate.version, 1);
    assert.equal(task.targets[0].id, serverA.id);
    assert.match(task.steps[0].command, /first version/);
    assert.equal(task.maxParallel, 2);
    assert.equal(task.timeout, 37);
    assert.equal(persisted.created_by, user.id);
    await schedule.tick(interval.nextRunAt + 10_000);
    assert.equal((await history(interval.id))[0].status, 'SKIPPED');
    await api
      .patch(base + '/server-groups/' + group.id)
      .send({ name: 'Fixture group', serverIds: [serverA.id, serverB.id] })
      .expect(200);
    await schedule.tick(interval.nextRunAt + 20_000);
    const all = (await api.get(base + root).expect(200)).body.data;
    assert.equal(all.find((item: { id: string }) => item.id === interval.id).status, 'PAUSED');
    assert.match((await history(interval.id))[0].reason, /目标/);
    await disable(interval.id);

    const guarded = await save(
      {
        ...body,
        name: 'Approval plan',
        kind: 'OPERATION_PLAN',
        sourceId: plan.id,
        timing: { type: 'ONCE', runAt: Date.now() + 30_000, timeZone: 'UTC' },
        parameters: {},
        target: { serverIds: [serverA.id] },
        requireConfirmation: true,
      },
      operator,
    );
    await schedule.tick(guarded.nextRunAt);
    const [approval] = await history(guarded.id);
    assert.equal(approval.status, 'AWAITING_CONFIRMATION');
    const approvalPath = root + '/' + guarded.id + '/runs/' + approval.id + '/approve';
    const accepted = await create(approvalPath, { confirmed: true });
    assert.equal((await history(guarded.id))[0].taskId, accepted.taskId);
    await api
      .post(base + approvalPath)
      .send({ confirmed: true })
      .expect(409);
    await api.delete(base + root + '/' + guarded.id).expect(200);
    assert.equal((await history(guarded.id)).length, 1);

    const expires = await save({
      ...body,
      name: 'Expired approval',
      target: { serverIds: [serverA.id] },
      timing: { type: 'ONCE', runAt: Date.now() + 35_000, timeZone: 'UTC' },
      requireConfirmation: true,
    });
    await schedule.tick(expires.nextRunAt);
    const [expiring] = await history(expires.id);
    await schedule.tick(expiring.confirmationExpiresAt);
    assert.equal((await history(expires.id))[0].status, 'SKIPPED');
    assert.match((await history(expires.id))[0].reason, /超时/);

    const credentialPlan = await save({
      ...body,
      name: 'Credential approval',
      target: { serverIds: [serverA.id] },
      timing: { type: 'ONCE', runAt: Date.now() + 38_000, timeZone: 'UTC' },
      requireConfirmation: true,
    });
    await schedule.tick(credentialPlan.nextRunAt);
    const [credentialApproval] = await history(credentialPlan.id);
    const credentialPath = base + '/credentials/' + credential.id;
    await api.patch(credentialPath).send({ status: 'DISABLED' }).expect(200);
    await api
      .post(base + root + '/' + credentialPlan.id + '/runs/' + credentialApproval.id + '/approve')
      .send({ confirmed: true })
      .expect(409);
    assert.equal((await history(credentialPlan.id))[0].status, 'FAILED');
    assert.match((await history(credentialPlan.id))[0].reason, /SSH/);
    await api.patch(credentialPath).send({ status: 'ACTIVE' }).expect(200);

    const stale = await save(
      {
        ...body,
        name: 'Stale approval',
        timing: { type: 'ONCE', runAt: Date.now() + 40_000, timeZone: 'UTC' },
        target: { serverIds: [serverA.id] },
        requireConfirmation: true,
      },
      operator,
    );
    await schedule.tick(stale.nextRunAt);
    const [staleApproval] = await history(stale.id);
    await api
      .patch(base + '/users/' + user.id)
      .send({ role: 'VIEWER' })
      .expect(200);
    await api
      .post(base + root + '/' + stale.id + '/runs/' + staleApproval.id + '/approve')
      .send({ confirmed: true })
      .expect(409);
    assert.equal((await history(stale.id))[0].status, 'FAILED');
    assert.match((await history(stale.id))[0].reason, /权限/);

    const late = await save({
      ...body,
      name: 'Missed plan',
      timing: { type: 'ONCE', runAt: Date.now() + 50_000, timeZone: 'UTC' },
    });
    await schedule.tick(late.nextRunAt + 600_000);
    const [missed] = await history(late.id);
    assert.equal(missed.status, 'SKIPPED');
    assert.ok(missed.missedUntil > missed.scheduledAt);
    assert.equal(missed.taskId, null);
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('SQLite scheduled operations serialize ticks, approvals and scope changes', () =>
  verifySchedules());
test(
  'PostgreSQL scheduled operations serialize ticks, approvals and scope changes',
  { skip: !postgresTestUrl },
  async () => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgresTestUrl!, verifySchedules);
  },
);
