import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

const postgresTestUrl = process.env.VEYOPS_TEST_POSTGRES_URL;

async function smtpFixture() {
  const messages: string[] = [];
  let temporaryFailure = false;
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 localhost VeyOps fixture\r\n');
    let buffer = '';
    let data: string[] | undefined;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line !== '.') {
            data.push(line);
            continue;
          }
          if (temporaryFailure) {
            temporaryFailure = false;
            socket.write('451 temporary failure\r\n');
          } else {
            messages.push(data.join('\r\n'));
            socket.write('250 accepted\r\n');
          }
          data = undefined;
          continue;
        }
        if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else if (line === 'DATA') {
          data = [];
          socket.write('354 send body\r\n');
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    rejectNext: () => {
      temporaryFailure = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function messageText(message: string) {
  const line = message.indexOf('\r\n\r\n');
  const headers = message.slice(0, line);
  const body = message.slice(line + 4);
  if (/^content-transfer-encoding: base64/im.test(headers))
    return Buffer.from(body, 'base64').toString('utf8');
  if (/^content-transfer-encoding: quoted-printable/im.test(headers)) {
    const bytes = body
      .replace(/=\r\n/g, '')
      .replace(/=([a-f0-9]{2})/gi, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return body;
}

async function verifyNotifications(databaseUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-notifications-'));
  const smtp = await smtpFixture();
  const initialPassword = 'notification-test-initial';
  const password = 'notification-test-changed';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_CLIENT = databaseUrl ? 'postgres' : 'sqlite';
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_PASSWORD = initialPassword;

  const { AppModule } = await import('../app.module.js');
  const { LegacyDeliveryWriteFixtureModule } =
    await import('./helpers/legacy-delivery-write-fixture.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { NotificationsService } =
    await import('../modules/notifications/notifications.service.js');
  const { NotificationMailService } =
    await import('../modules/notifications/notification-mail.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, LegacyDeliveryWriteFixtureModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const database = app.get(DatabaseService);
    const notifications = app.get(NotificationsService);
    const mail = app.get(NotificationMailService);
    const db = database.db;
    const prefix = '/api/v1';
    const post = (path: string, body: object) => api.post(prefix + path).send(body);
    const get = (path: string) => api.get(prefix + path);
    const put = (path: string, body: object) => api.put(prefix + path).send(body);
    const create = async (path: string, body: object) =>
      (await post(path, body).expect(201)).body.data;
    await create('/auth/login', { username: 'root', password: initialPassword });
    await post('/auth/change-password', {
      currentPassword: initialPassword,
      newPassword: password,
    }).expect(200);
    const user = await create('/auth/login', { username: 'root', password });
    const project = await create('/projects', {
      name: 'Notification project',
      slug: 'notification-project',
    });
    const service = await create(`/projects/${project.id}/services`, {
      name: 'Fixture',
      slug: 'fixture',
    });
    const environment = await create(`/projects/${project.id}/environments`, {
      name: 'Test',
      slug: 'test',
      environmentType: 'TESTING',
    });
    const otherUserId = randomUUID();
    await db
      .insertInto('users')
      .values({
        id: otherUserId,
        username: 'other',
        password_hash: 'fixture',
        role: 'VIEWER',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    await notifications.saveSubscriptions(otherUserId, [{ projectId: project.id, stage: 'BUILD' }]);

    const settings = {
      host: '127.0.0.1',
      port: smtp.port,
      security: 'NONE',
      fromEmail: 'sender@example.invalid',
      credentialId: null,
      baseUrl: 'https://veyops.example.invalid/app/',
    };
    await put('/notifications/smtp', settings).expect(200);
    assert.equal(
      (await get('/notifications/smtp').expect(200)).body.data.baseUrl,
      'https://veyops.example.invalid/app',
    );
    await post('/notifications/smtp/test', {}).expect(201);
    const prefs = { email: 'reader@example.invalid', emailEnabled: true, minimumLevel: 'WARNING' };
    await put('/notifications/preferences', prefs).expect(200);
    await post('/notifications/email/verify-request', {}).expect(201);
    await post('/notifications/email/verify-request', {}).expect(429);
    assert.equal(smtp.messages.length, 1);
    const code = /\b([0-9]{6})\b/.exec(messageText(smtp.messages[0]!))?.[1];
    assert.ok(code);
    await post('/notifications/email/verify-confirm', {
      code: code === '000000' ? '000001' : '000000',
    }).expect(400);
    const verified = await create('/notifications/email/verify-confirm', { code });
    assert.ok(verified.verifiedAt);

    const record = async (
      input: {
        mode?: string;
        status?: string;
        targets?: string[];
        rollback?: boolean;
        automated?: boolean;
        deployAfterBuild?: boolean;
      } = {},
    ) => {
      const id = randomUUID();
      const now = Date.now();
      const task = {
        id,
        task_type: 'PIPELINE',
        status: input.status ?? 'SUCCESS',
        name: 'Sensitive runner detail',
        error_summary: 'secret fixture text',
        project_id: project.id,
        service_id: service.id,
        environment_id: environment.id,
        created_at: now,
        updated_at: now,
        finished_at: now,
        created_by: user.id,
        payload_json: JSON.stringify({
          pipeline: {
            mode: input.mode ?? 'BUILD_ONLY',
            triggerType: input.automated ? 'WEBHOOK' : 'MANUAL',
            rollbackOfDeploymentId: input.rollback ? randomUUID() : undefined,
            deployAfterBuild: input.deployAfterBuild,
          },
        }),
      };
      await db.transaction().execute(async (tx) => {
        await tx.insertInto('tasks').values(task).execute();
        await tx
          .insertInto('task_targets')
          .values(
            (input.targets ?? [task.status]).map((status) => ({
              id: randomUUID(),
              task_id: id,
              server_name_snapshot: 'fixture',
              host_snapshot: 'localhost',
              status,
            })),
          )
          .execute();
        await notifications.recordTaskCompletion(tx, id, now);
        await notifications.recordTaskCompletion(tx, id, now);
      });
      return id;
    };

    await record();
    assert.equal((await db.selectFrom('notification_mail').selectAll().execute()).length, 0);
    const failure = await record({
      status: 'FAILED',
      targets: ['FAILED', 'CANCELLED'],
      deployAfterBuild: true,
    });
    smtp.rejectNext();
    await mail.tick();
    const rejected = await db.selectFrom('notification_mail').selectAll().executeTakeFirstOrThrow();
    assert.equal(rejected.status, 'PENDING');
    assert.equal(rejected.attempts, 1);
    const inbox = await get('/notifications?level=FAILURE&unread=true').expect(200);
    assert.equal(inbox.body.data.unreadCount, 2);
    const notice = inbox.body.data.items[0];
    assert.equal(notice.mailStatus, 'PENDING');
    assert.equal(notice.taskId, failure);
    assert.deepEqual(notice.summary, {
      success: 0,
      failed: 1,
      skipped: 1,
      needsAttention: 0,
      deploymentSkipped: true,
      releases: [],
    });
    assert.doesNotMatch(JSON.stringify(inbox.body), /secret fixture text|Sensitive runner detail/);
    await db
      .updateTable('notification_mail')
      .set({ available_at: 0 })
      .where('id', '=', rejected.id)
      .execute();
    await Promise.all([mail.tick(), mail.tick()]);
    const delivered = await db
      .selectFrom('notification_mail')
      .selectAll()
      .executeTakeFirstOrThrow();
    assert.equal(delivered.status, 'SENT');
    assert.equal(delivered.attempts, 2);
    assert.equal(smtp.messages.length, 2);
    const message = messageText(smtp.messages[1]!);
    assert.match(message, /https:\/\/veyops\.example\.invalid\/app\/#\/tasks\//);
    assert.doesNotMatch(message, /secret fixture text|Sensitive runner detail/);

    await put('/notifications/preferences', { ...prefs, minimumLevel: 'FAILURE' }).expect(200);
    await record({ mode: 'DEPLOY_ARTIFACT', rollback: true });
    const warning = await get('/notifications?level=WARNING').expect(200);
    assert.equal(warning.body.data.items[0].stage, 'ROLLBACK');
    assert.equal(warning.body.data.items[0].mailStatus, null);
    await put('/notifications/preferences', { ...prefs, minimumLevel: 'NORMAL' }).expect(200);
    await record({ mode: 'DEPLOY_ARTIFACT' });
    assert.equal(
      (
        await db
          .selectFrom('notification_mail')
          .selectAll()
          .where('status', '=', 'PENDING')
          .execute()
      ).length,
      1,
    );
    await put('/notifications/preferences', { ...prefs, emailEnabled: false }).expect(200);
    await mail.tick();
    assert.equal(
      (
        await db
          .selectFrom('notification_mail')
          .selectAll()
          .where('status', '=', 'SKIPPED')
          .execute()
      ).length,
      1,
    );
    await db
      .updateTable('notification_preferences')
      .set({
        email: 'other@example.invalid',
        email_enabled: 1,
        minimum_level: 'NORMAL',
        verified_at: Date.now() - 1,
      })
      .where('user_id', '=', otherUserId)
      .execute();
    const automatedTask = await record({ automated: true });
    const other = await notifications.list(otherUserId, {});
    assert.equal(other.items[0]?.taskId, automatedTask);
    assert.equal(other.unreadCount, 1);
    assert.equal(other.items[0]?.mailStatus, 'PENDING');
    await notifications.saveSubscriptions(otherUserId, []);
    await mail.tick();
    assert.equal((await notifications.list(otherUserId, {})).items[0]?.mailStatus, 'SKIPPED');
    assert.equal(smtp.messages.length, 2);
    await api.patch(prefix + '/notifications/' + other.items[0]?.id + '/read').expect(404);
    await api.patch(prefix + '/notifications/' + notice.id + '/read').expect(200);
    await api.patch(prefix + '/notifications/read-all').expect(200);
    assert.equal((await get('/notifications/unread-count').expect(200)).body.data.unreadCount, 0);

    const interrupted = Date.now() - 100;
    const taskId = randomUUID();
    await db
      .insertInto('tasks')
      .values({
        id: taskId,
        task_type: 'PIPELINE',
        status: 'RUNNING',
        project_id: project.id,
        created_at: interrupted,
        updated_at: interrupted,
        created_by: user.id,
        lease_expires_at: interrupted,
        payload_json: JSON.stringify({ pipeline: { mode: 'DEPLOY_ARTIFACT' } }),
      })
      .execute();
    await db
      .insertInto('task_targets')
      .values({
        id: randomUUID(),
        task_id: taskId,
        server_name_snapshot: 'fixture',
        host_snapshot: 'localhost',
        status: 'RUNNING',
      })
      .execute();
    await app.get(TaskWorkerService).recoverExpired();
    const recovered = await get('/notifications?level=FAILURE&unread=true').expect(200);
    assert.equal(recovered.body.data.items[0].taskId, taskId);
    assert.equal(recovered.body.data.items[0].status, 'NEEDS_ATTENTION');
    assert.equal(recovered.body.data.items[0].summary.needsAttention, 1);

    const changed = await put('/notifications/preferences', {
      ...prefs,
      email: 'changed@example.invalid',
    }).expect(200);
    assert.equal(changed.body.data.verifiedAt, null);
  } finally {
    await app.close();
    await smtp.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite inbox and real SMTP verify addresses, apply levels and retry delivery', () =>
  verifyNotifications());
test(
  'PostgreSQL inbox and real SMTP verify addresses, apply levels and retry delivery',
  { skip: !postgresTestUrl },
  async () => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgresTestUrl!, verifyNotifications);
  },
);
