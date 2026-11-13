import 'reflect-metadata';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseService } from '../core/database/database.service';
import type { AiProvidersService } from '../modules/ai/ai-providers.service';
import type { CreateAiProviderDto } from '../modules/ai/ai.dto';

// This process owns an isolated DATA_DIR before any application module is imported.
// These tests never open the workspace's real encrypted bootstrap envelope.
const isolatedDirectory = mkdtemp(join(tmpdir(), 'veyops-bootstrap-'));
const fakeKey = 'sk-bootstrap-test-key-123456789';
let imports:
  | Promise<{
      Database: (typeof import('../core/database/database.service'))['DatabaseService'];
      Initial: (typeof import('../core/initial-configuration'))['InitialConfigurationService'];
      Auth: (typeof import('../modules/auth/auth.service'))['AuthService'];
      Audit: (typeof import('../modules/audit/audit.service'))['AuditService'];
    }>
  | undefined;
async function classes() {
  if (!imports)
    imports = (async () => {
      process.env.DATA_DIR = await isolatedDirectory;
      const [
        { DatabaseService },
        { InitialConfigurationService },
        { AuthService },
        { AuditService },
      ] = await Promise.all([
        import('../core/database/database.service.js'),
        import('../core/initial-configuration.js'),
        import('../modules/auth/auth.service.js'),
        import('../modules/audit/audit.service.js'),
      ]);
      return {
        Database: DatabaseService,
        Initial: InitialConfigurationService,
        Auth: AuthService,
        Audit: AuditService,
      };
    })();
  return imports;
}
after(async () => {
  const directory = resolve(await isolatedDirectory);
  assert.ok(
    directory.startsWith(resolve(tmpdir()) + '\\') || directory.startsWith(resolve(tmpdir()) + '/'),
  );
  assert.ok(directory.includes('veyops-bootstrap-'));
  await rm(directory, { recursive: true, force: true });
});
function envelope(config: Record<string, unknown>, key: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  return {
    version: 1,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}
async function fixture(withAdmin = true) {
  const { Database, Initial, Auth, Audit } = await classes();
  const directory = await isolatedDirectory;
  const file = join(directory, 'config', 'ai-bootstrap.json');
  await mkdir(join(directory, 'config'), { recursive: true });
  await unlink(file).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_PATH = join(directory, `${randomUUID()}.db`);
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const database: DatabaseService = new Database();
  await database.onModuleInit();
  const adminId = randomUUID();
  const viewerId = randomUUID();
  if (withAdmin)
    await database.db
      .insertInto('users')
      .values({
        id: adminId,
        username: 'bootstrap-admin',
        role: 'ADMIN',
        status: 'ACTIVE',
        password_hash: 'unused',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
  await database.db
    .insertInto('users')
    .values({
      id: viewerId,
      username: 'bootstrap-viewer',
      role: 'VIEWER',
      status: 'ACTIVE',
      password_hash: 'unused',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .execute();
  let created = 0;
  let failCreate = false;
  const providers: {
    id: string;
    name: string;
    baseUrl: string;
    model: string;
    enabled: boolean;
  }[] = [];
  const received: CreateAiProviderDto[] = [];
  const fake = {
    list: async () => providers,
    create: async (config: CreateAiProviderDto, userId: string) => {
      assert.equal(typeof userId, 'string');
      if (failCreate) throw new Error(`simulated upstream failure ${fakeKey}`);
      created++;
      received.push(config);
      const row = {
        id: randomUUID(),
        name: config.name,
        baseUrl: config.baseUrl.replace(/\/+$/, ''),
        model: config.model,
        enabled: config.enabled,
      };
      providers.push(row);
      return row;
    },
  } as unknown as AiProvidersService;
  const initial = new Initial(database, fake);
  const diagnostics: string[] = [];
  const logger = (
    initial as unknown as {
      logger: { log: (message: string) => void; warn: (message: string) => void };
    }
  ).logger;
  logger.log = (message) => diagnostics.push(message);
  logger.warn = (message) => diagnostics.push(message);
  const config = {
    name: 'Fixture Provider',
    baseUrl: 'https://example.com/v1/',
    model: 'test-model',
    apiKey: fakeKey,
    enabled: true,
    timeoutSeconds: 20,
  };
  return {
    initial,
    database,
    file,
    adminId,
    viewerId,
    config,
    received,
    providers,
    diagnostics,
    get created() {
      return created;
    },
    fail() {
      failCreate = true;
    },
    async write(value: unknown = envelope(config, process.env.ENCRYPTION_KEY!)) {
      await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    },
    auth() {
      return new Auth(database, new Audit(database), initial);
    },
    async close() {
      await database.onModuleDestroy();
    },
  };
}

test('encrypted bootstrap decrypts a fake AES-GCM envelope once and removes the pending file', async () => {
  const f = await fixture();
  try {
    await f.write();
    assert.equal((await readFile(f.file, 'utf8')).includes(fakeKey), false);
    await Promise.all([f.initial.apply(f.adminId), f.initial.apply(f.adminId)]);
    assert.equal(f.created, 1);
    assert.equal(f.received[0]!.apiKey, fakeKey);
    assert.equal(f.received[0]!.baseUrl, 'https://example.com/v1');
    await assert.rejects(access(f.file));
    await f.initial.apply(f.adminId);
    assert.equal(f.created, 1);
    assert.equal(
      f.diagnostics.some((m) => m.includes(fakeKey)),
      false,
    );
  } finally {
    await f.close();
  }
});
test('bootstrap idempotence matches normalized URLs and preserves a deliberately disabled existing provider', async () => {
  const f = await fixture();
  try {
    await f.write(envelope({ ...f.config, enabled: false }, process.env.ENCRYPTION_KEY!));
    await f.initial.apply(f.adminId);
    assert.equal(f.providers[0]!.enabled, false);
    await f.write();
    await f.initial.apply(f.adminId);
    assert.equal(f.created, 1);
    assert.equal(f.providers[0]!.enabled, false);
    await assert.rejects(access(f.file));
  } finally {
    await f.close();
  }
});
test('startup waits for an active administrator and never imports as VIEWER or disabled ADMIN', async () => {
  const f = await fixture(false);
  try {
    await f.write();
    await f.initial.onApplicationBootstrap();
    assert.equal(f.created, 0);
    await access(f.file);
    await f.initial.apply(f.viewerId);
    assert.equal(f.created, 0);
    await access(f.file);
    await f.database.db
      .insertInto('users')
      .values({
        id: f.adminId,
        username: 'disabled-admin',
        role: 'ADMIN',
        status: 'DISABLED',
        password_hash: 'unused',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    await f.initial.onApplicationBootstrap();
    assert.equal(f.created, 0);
    await f.database.db
      .updateTable('users')
      .set({ status: 'ACTIVE' })
      .where('id', '=', f.adminId)
      .execute();
    await f.initial.onApplicationBootstrap();
    assert.equal(f.created, 1);
  } finally {
    await f.close();
  }
});
test('tampered authentication tags, wrong master keys, malformed envelopes and missing API keys retain encrypted input without throwing', async () => {
  const f = await fixture();
  try {
    const tampered = envelope(f.config, process.env.ENCRYPTION_KEY!);
    tampered.authTag = randomBytes(16).toString('base64');
    await f.write(tampered);
    await f.initial.apply(f.adminId);
    await access(f.file);
    assert.equal(f.created, 0);
    await f.write(envelope(f.config, randomBytes(32).toString('hex')));
    await f.initial.apply(f.adminId);
    assert.equal(f.created, 0);
    await f.write({ version: 2, nonce: '', authTag: '', ciphertext: '' });
    await f.initial.apply(f.adminId);
    assert.equal(f.created, 0);
    const withoutKey: Record<string, unknown> = { ...f.config };
    delete withoutKey.apiKey;
    await f.write(envelope(withoutKey, process.env.ENCRYPTION_KEY!));
    await f.initial.apply(f.adminId);
    await access(f.file);
    assert.equal(f.created, 0);
    assert.equal(
      f.diagnostics.some((m) => m.includes(fakeKey)),
      false,
    );
  } finally {
    await f.close();
  }
});
test('failed optional provider creation does not block administrator setup or create a bootstrap session twice', async () => {
  const f = await fixture(false);
  try {
    // Remove the synthetic VIEWER so the real first-user flow can run.
    await f.database.db.deleteFrom('users').where('id', '=', f.viewerId).execute();
    await f.write();
    f.fail();
    const session = await f.auth().setup('first-admin', 'bootstrap-login-test-1234');
    assert.equal(session.user.role, 'ADMIN');
    assert.equal(session.token.length, 64);
    assert.equal(f.created, 0);
    await access(f.file);
    assert.equal(
      f.diagnostics.some((m) => m.includes(fakeKey)),
      false,
    );
    await assert.rejects(
      f.auth().setup('second-admin', 'bootstrap-login-test-1234'),
      /系统已初始化/,
    );
  } finally {
    await f.close();
  }
});
