import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreBackup } from '../core/database/backup';
import { postgresTestUrl, withIsolatedPostgres } from './helpers/isolated-postgres';

type BackupSummary = {
  id: string;
  createdAt: string;
  databaseClient: 'sqlite' | 'postgres';
  fileCount: number;
};

async function localPort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate test port');
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return address.port;
}

async function checkManagedBackups(t: TestContext, databaseUrl?: string) {
  const root = await mkdtemp(join(tmpdir(), 'veyops-backup-api-'));
  const dataDir = join(root, 'data');
  const databasePath = join(dataDir, 'database', 'app.db');
  const client = databaseUrl ? 'postgres' : 'sqlite';
  const key = randomBytes(32);
  const initial = randomBytes(24).toString('hex');
  const password = randomBytes(24).toString('hex');
  const logPath = 'logs/backup-fixture.log';
  const artifactPath = 'artifacts/inspection.txt';
  const log = 'fixture log\n';
  const archiveEntry = 'managed artifact\n';
  for (const [path, value] of [
    [logPath, log],
    [artifactPath, archiveEntry],
    ['config/encryption.key', key.toString('hex')],
    ['artifacts/private.partial', 'unfinished output'],
  ]) {
    const target = join(dataDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  const port = await localPort();
  const origin = `http://127.0.0.1:${port}/api/v1`;
  const child = spawn(process.execPath, [resolve(__dirname, '../main.js')], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_CLIENT: client,
      DATABASE_PATH: databasePath,
      DATABASE_URL: databaseUrl ?? '',
      DATA_DIR: dataDir,
      ENCRYPTION_KEY: key.toString('hex'),
      ADMIN_PASSWORD: initial,
      WORKER_ENABLED: 'false',
      COOKIE_SECURE: 'false',
    },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  // A fresh PostgreSQL schema may migrate over a remote database connection.
  const startupDeadline = Date.now() + (client === 'postgres' ? 90000 : 15000);
  for (;;) {
    if ((await fetch(origin + '/health').catch(() => null))?.ok) break;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Backup API exited before becoming ready (${child.exitCode ?? child.signalCode})`,
      );
    if (Date.now() >= startupDeadline)
      throw new Error('Timed out waiting for backup API migrations and startup');
    await delay(150);
  }

  function session() {
    let cookie = '';
    return async (path: string, method: 'GET' | 'POST' = 'GET', data?: unknown) => {
      const response = await fetch(origin + path, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const token = response.headers.getSetCookie()[0];
      if (token) cookie = token.split(';', 1)[0]!;
      return response;
    };
  }

  const admin = session();
  const viewer = session();
  assert.equal((await admin('/backups')).status, 401);
  assert.equal(
    (await admin('/auth/login', 'POST', { username: 'root', password: initial })).status,
    201,
  );
  assert.equal((await admin('/backups')).status, 403);
  assert.equal(
    (
      await admin('/auth/change-password', 'POST', {
        currentPassword: initial,
        newPassword: password,
      })
    ).status,
    200,
  );
  assert.equal((await admin('/auth/login', 'POST', { username: 'root', password })).status, 201);
  assert.deepEqual(await (await admin('/backups')).json(), { data: [] });

  const viewerName = 'backup-viewer';
  const viewerInitial = randomBytes(24).toString('hex');
  const viewerPassword = randomBytes(24).toString('hex');
  assert.equal(
    (
      await admin('/users', 'POST', {
        username: viewerName,
        role: 'VIEWER',
        password: viewerInitial,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await viewer('/auth/login', 'POST', {
        username: viewerName,
        password: viewerInitial,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await viewer('/auth/change-password', 'POST', {
        currentPassword: viewerInitial,
        newPassword: viewerPassword,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await viewer('/auth/login', 'POST', {
        username: viewerName,
        password: viewerPassword,
      })
    ).status,
    201,
  );
  assert.equal((await viewer('/backups')).status, 403);
  assert.equal((await viewer('/backups', 'POST')).status, 403);

  const created = await admin('/backups', 'POST');
  assert.equal(created.status, 201);
  const { data: backup } = (await created.json()) as { data: BackupSummary };
  assert.match(backup.id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(backup.databaseClient, client);
  assert.equal(backup.fileCount, 3);
  assert.ok(Number.isFinite(Date.parse(backup.createdAt)));
  assert.deepEqual(await (await admin('/backups')).json(), { data: [backup] });

  const endpoint = `/backups/${backup.id}`;
  assert.equal((await viewer(endpoint + '/verify', 'POST')).status, 403);
  assert.equal((await viewer(endpoint + '/download')).status, 403);
  const verified = await admin(endpoint + '/verify', 'POST');
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { data: backup });
  const download = await admin(endpoint + '/download');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition') ?? '', /attachment;.*\.tar\.gz/);
  assert.match(download.headers.get('cache-control') ?? '', /no-store/);
  const bundle = join(root, 'backup.tar.gz');
  await writeFile(bundle, Buffer.from(await download.arrayBuffer()));
  const extracted = join(root, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', bundle, '-C', extracted]);
  const snapshot = client === 'sqlite' ? 'database.sqlite' : 'database.dump';
  assert.ok((await stat(join(extracted, snapshot))).size > 0);
  assert.equal(await readFile(join(extracted, logPath), 'utf8'), log);
  assert.equal(await readFile(join(extracted, artifactPath), 'utf8'), archiveEntry);
  await assert.rejects(stat(join(extracted, 'config/encryption.key')), { code: 'ENOENT' });
  await assert.rejects(stat(join(extracted, 'artifacts/private.partial')), { code: 'ENOENT' });

  if (client === 'sqlite') {
    const restoredData = join(root, 'restored');
    const targetDb = join(root, 'fresh', 'app.db');
    await restoreBackup(
      { dataDir: restoredData, database: { client, path: targetDb }, key },
      extracted,
    );
    assert.ok((await stat(targetDb)).size > 0);
    assert.equal(await readFile(join(restoredData, artifactPath), 'utf8'), archiveEntry);
  }

  const audit = await (await admin('/audit')).text();
  assert.ok(audit.includes(backup.id));
  for (const value of [password, initial, key.toString('hex'), dataDir]) {
    assert.ok(!audit.includes(value));
  }
  await writeFile(join(dataDir, 'backups', backup.id, artifactPath), 'changed after backup');
  const damaged = await admin(endpoint + '/verify', 'POST');
  assert.ok(damaged.status >= 400);
  assert.ok(!(await damaged.text()).includes(dataDir));
  assert.ok((await admin(endpoint + '/download')).status >= 400);
}

test('SQLite backup page API protects access, verifies integrity and exports a restorable bundle', (t) =>
  checkManagedBackups(t));
test(
  'PostgreSQL backup page API protects access and exports an authenticated database dump',
  { skip: !postgresTestUrl },
  (t) => withIsolatedPostgres(postgresTestUrl!, (url) => checkManagedBackups(t, url)),
);
