import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

const base = '/api/v1';
const users = base + '/users';
const profile = base + '/auth/me';
const userFields = [
  'id',
  'username',
  'role',
  'status',
  'mustChangePassword',
  'createdAt',
  'updatedAt',
].sort();

type Session = ReturnType<typeof request.agent>;

const postgresTestUrl = process.env.VEYOPS_TEST_POSTGRES_URL;
const previousDataDir = process.env.DATA_DIR;
let dataDir: string;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'veyops-user-management-'));
  process.env.DATA_DIR = dataDir;
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

function login(session: Session, username: string, password: string) {
  return session.post(base + '/auth/login').send({ username, password });
}

function changePassword(session: Session, currentPassword: string, newPassword: string) {
  return session.post(base + '/auth/change-password').send({ currentPassword, newPassword });
}

async function checkUserManagement(t: TestContext, databaseUrl?: string) {
  const initialPassword = 'fixtureRoot-temporary!';
  const rootPassword = 'fixtureRoot-rotated!';
  const temporary = 'fixtureStaff-temporary!';
  const staffPassword = 'fixtureStaff-rotated!';
  const resetPassword = 'fixtureStaff-admin-reset!';
  const peerPassword = 'fixturePeer-rotated!';
  const settings = {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    DATABASE_URL: databaseUrl,
    DATABASE_PATH: join(dataDir, 'test.db'),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    WORKER_ENABLED: 'false',
    COOKIE_SECURE: 'false',
    ADMIN_PASSWORD: initialPassword,
  };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  let app: NestExpressApplication | undefined;
  try {
    const { AppModule } = await import('../app.module.js');
    const { configureApp } = await import('../bootstrap.js');
    const { DatabaseService } = await import('../core/database/database.service.js');
    const { AuthService } = await import('../modules/auth/auth.service.js');
    const { AuditService } = await import('../modules/audit/audit.service.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(app);
    await app.init();
    await app.listen(0, '127.0.0.1');

    const server = app.getHttpServer();
    const db = app.get(DatabaseService).db;
    const auth = app.get(AuthService);
    const root = request.agent(server);
    const staff = request.agent(server);
    const secondSession = request.agent(server);
    const peer = request.agent(server);

    await root.get(users).expect(401);
    const rootInitial = await login(root, 'root', initialPassword).expect(201);
    const rootId = rootInitial.body.data.id as string;
    await root.get(users).expect(403);
    await changePassword(root, initialPassword, rootPassword).expect(200);
    await login(root, 'root', rootPassword).expect(201);
    const listing = await root.get(users).expect(200);
    assert.equal(listing.body.data.length, 1);
    assert.deepEqual(Object.keys(listing.body.data[0]).sort(), userFields);
    assert.equal(listing.body.data[0].mustChangePassword, false);

    await root
      .post(users)
      .send({ username: 'invalid user', role: 'ADMIN', password: temporary })
      .expect(400);
    await root
      .post(users)
      .send({ username: 'invalid-role', role: 'OWNER', password: temporary })
      .expect(400);
    await root
      .post(users)
      .send({ username: 'short-pass', role: 'VIEWER', password: 'short' })
      .expect(400);
    const input = { username: 'staff-account', role: 'VIEWER', password: temporary };
    const duplicateRequests = await Promise.all([
      root.post(users).send(input),
      root.post(users).send(input),
    ]);
    assert.deepEqual(duplicateRequests.map(({ status }) => status).sort(), [201, 409]);
    const staffUser = duplicateRequests.find(({ status }) => status === 201)!.body.data;
    const staffId = staffUser.id as string;
    const staffPath = users + '/' + staffId;
    assert.deepEqual(Object.keys(staffUser).sort(), userFields);
    assert.deepEqual(
      [staffUser.username, staffUser.role, staffUser.status, staffUser.mustChangePassword],
      ['staff-account', 'VIEWER', 'ACTIVE', true],
    );

    await root.patch(staffPath).send({}).expect(400);
    await root.patch(staffPath).send({ status: null }).expect(400);
    await root
      .patch(users + '/' + randomUUID())
      .send({ status: 'DISABLED' })
      .expect(404);
    await root
      .patch(users + '/' + rootId)
      .send({ role: 'VIEWER' })
      .expect(409);
    await root
      .patch(users + '/' + rootId)
      .send({ status: 'DISABLED' })
      .expect(409);
    await root
      .post(users + '/' + rootId + '/reset-password')
      .send({ password: temporary })
      .expect(409);

    const staffInitial = await login(staff, input.username, temporary).expect(201);
    assert.equal(staffInitial.body.data.mustChangePassword, true);
    await staff.get(base + '/projects').expect(403);
    await changePassword(staff, temporary, staffPassword).expect(200);
    await login(staff, input.username, staffPassword).expect(201);
    await login(secondSession, input.username, staffPassword).expect(201);
    await staff.get(base + '/projects').expect(200);
    await staff.get(users).expect(403);
    await staff
      .post(users)
      .send({ ...input, username: 'unauthorized' })
      .expect(403);
    await staff.patch(staffPath).send({ role: 'ADMIN' }).expect(403);
    await staff
      .post(staffPath + '/reset-password')
      .send({ password: temporary })
      .expect(403);

    const roleChange = await root.patch(staffPath).send({ role: 'OPERATOR' }).expect(200);
    assert.equal(roleChange.body.data.role, 'OPERATOR');
    await staff.get(profile).expect(401);
    await secondSession.get(profile).expect(401);
    const operator = await login(staff, input.username, staffPassword).expect(201);
    assert.equal(operator.body.data.role, 'OPERATOR');
    await staff.get(users).expect(403);
    const project = await staff
      .post(base + '/projects')
      .send({ name: 'User ownership fixture', slug: 'user-ownership-fixture' })
      .expect(201);

    await root.patch(staffPath).send({ status: 'DISABLED' }).expect(200);
    await staff.get(profile).expect(401);
    await login(staff, input.username, staffPassword).expect(401);
    const owner = await db
      .selectFrom('projects')
      .select('created_by')
      .where('id', '=', project.body.data.id)
      .executeTakeFirstOrThrow();
    assert.equal(owner.created_by, staffId);
    await root.patch(staffPath).send({ status: 'ACTIVE' }).expect(200);
    await staff.get(profile).expect(401);
    await login(staff, input.username, staffPassword).expect(201);

    const audit = app.get(AuditService);
    const record = audit.record.bind(audit);
    const rejectedAudit = t.mock.method(audit, 'record', (...args: Parameters<typeof record>) => {
      if (args[1] === 'user.reset_password') throw new Error('fixture audit write failed');
      return record(...args);
    });
    try {
      await root
        .post(staffPath + '/reset-password')
        .send({ password: resetPassword })
        .expect(500);
    } finally {
      rejectedAudit.mock.restore();
    }
    // If the audit insert fails, password and session revocation both roll back.
    await staff.get(profile).expect(200);
    await login(secondSession, input.username, staffPassword).expect(201);

    const [reset, oldLogins] = await Promise.all([
      root
        .post(staffPath + '/reset-password')
        .send({ password: resetPassword })
        .expect(200),
      Promise.allSettled(
        Array.from({ length: 4 }, () => auth.login(input.username, staffPassword)),
      ),
    ]);
    assert.deepEqual(Object.keys(reset.body.data).sort(), userFields);
    assert.equal(reset.body.data.mustChangePassword, true);
    await staff.get(profile).expect(401);
    await secondSession.get(profile).expect(401);
    for (const result of oldLogins) {
      if (result.status === 'fulfilled')
        await assert.rejects(auth.resolve(result.value.token), /登录已过期/);
      else assert.match(String(result.reason), /用户名或密码错误/);
    }
    await login(staff, input.username, staffPassword).expect(401);
    const resetLogin = await login(staff, input.username, resetPassword).expect(201);
    assert.equal(resetLogin.body.data.mustChangePassword, true);
    await staff.get(base + '/projects').expect(403);

    const auditRows = await db
      .selectFrom('audit_logs')
      .select(['action', 'details_json', 'user_id'])
      .where('resource_id', '=', staffId)
      .where('action', 'like', 'user.%')
      .execute();
    assert.deepEqual(auditRows.map(({ action }) => action).sort(), [
      'user.create',
      'user.reset_password',
      'user.update',
      'user.update',
      'user.update',
    ]);
    assert.ok(auditRows.every(({ user_id }) => user_id === rootId));
    const stored = await db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', staffId)
      .executeTakeFirstOrThrow();
    assert.notEqual(stored.password_hash, resetPassword);
    const visible = JSON.stringify([
      (await root.get(users).expect(200)).body,
      staffUser,
      reset.body,
      auditRows,
    ]);
    for (const secret of [temporary, staffPassword, resetPassword, stored.password_hash]) {
      assert.equal(visible.includes(secret), false);
    }

    const peerUser = await root
      .post(users)
      .send({ username: 'peer-admin', role: 'ADMIN', password: temporary })
      .expect(201);
    const peerId = peerUser.body.data.id as string;
    const peerInitial = await login(peer, 'peer-admin', temporary).expect(201);
    assert.equal(peerInitial.body.data.mustChangePassword, true);
    await peer.get(users).expect(403);
    await changePassword(peer, temporary, peerPassword).expect(200);
    await login(peer, 'peer-admin', peerPassword).expect(201);

    const edits = await Promise.all([
      root.patch(users + '/' + peerId).send({ status: 'DISABLED' }),
      peer.patch(users + '/' + rootId).send({ status: 'DISABLED' }),
    ]);
    assert.equal(edits.filter(({ status }) => status === 200).length, 1);
    assert.ok(edits.some(({ status }) => [401, 403, 409].includes(status)));
    const activeAdmins = await db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .execute();
    assert.deepEqual(activeAdmins, [{ id: edits[0].status === 200 ? rootId : peerId }]);
  } finally {
    try {
      await app?.close();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}

test('SQLite user management protects admin accounts, sessions and credentials', (t) =>
  checkUserManagement(t));
test(
  'PostgreSQL user management protects admin accounts, sessions and credentials',
  { skip: !postgresTestUrl },
  async (t) => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgresTestUrl!, (url) => checkUserManagement(t, url));
  },
);
