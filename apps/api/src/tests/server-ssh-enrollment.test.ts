import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { DatabaseService, migrateSqlite } from '../core/database/database.service';
import { migrationProvider } from '../core/database/migrations';
import type { Database } from '../core/database/schema';
import { SshHostKeyMismatchError, SshService } from '../infrastructure/ssh/ssh.service';
import type { SshTarget } from '../infrastructure/ssh/ssh.service';
import { AuditService } from '../modules/audit/audit.service';
import type { CredentialsService } from '../modules/credentials/credentials.service';
import { ServersService } from '../modules/servers/servers.service';

const fingerprint = (byte: number) =>
  `SHA256:${Buffer.alloc(32, byte).toString('base64').slice(0, -1)}`;

test('SSH trust offers are bound to the requester, endpoint, server state and expiration', async (t) => {
  const sqlite = new BetterSqlite3(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  t.after(() => db.destroy());
  await migrateSqlite(db, migrationProvider);
  const database = { db } as DatabaseService;
  const owner = randomUUID();
  const other = randomUUID();
  const credentialId = randomUUID();
  const now = Date.now();
  await db
    .insertInto('users')
    .values(
      [owner, other].map((id) => ({
        id,
        username: id,
        password_hash: 'fixture',
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
  await db
    .insertInto('credentials')
    .values({
      id: credentialId,
      name: 'Fixture',
      type: 'SSH_PASSWORD',
      ciphertext: 'fixture',
      nonce: 'fixture',
      auth_tag: 'fixture',
      created_by: owner,
      created_at: now,
      updated_at: now,
    })
    .execute();
  let remoteKey = fingerprint(1);
  let inspected: object | undefined;
  const ssh = {
    inspectHostKey: async (endpoint: object) => {
      inspected = endpoint;
      return { algorithm: 'ssh-ed25519', fingerprint: remoteKey };
    },
    probe: async (target: SshTarget) => {
      if (target.hostKeyFingerprint !== remoteKey) throw new SshHostKeyMismatchError();
      return { exitCode: 0, output: 'Linux\nVEYOPS_OS="Linux"' };
    },
  } as unknown as SshService;
  const servers = new ServersService(
    database,
    {
      assertSsh: async (id: string) => {
        assert.equal(id, credentialId);
      },
    } as unknown as CredentialsService,
    ssh,
    new AuditService(database),
  );
  const endpoint = { host: 'Fixture.Example', port: 2222 };
  const input = { ...endpoint, name: 'Fixture', username: 'ops', credentialId };

  await assert.rejects(servers.create(input, owner), BadRequestException);
  const offer = await servers.probeHostKey(endpoint, owner);
  assert.deepEqual(inspected, { host: 'fixture.example', port: 2222 });
  assert.equal(offer.fingerprint, fingerprint(1));
  assert.ok(offer.expiresAt > Date.now());
  const accepted = { ...input, hostKeyAcceptanceToken: offer.acceptanceToken };
  await assert.rejects(servers.create(accepted, other), ConflictException);
  await assert.rejects(servers.create({ ...accepted, port: 22 }, owner), ConflictException);
  assert.deepEqual(await servers.list(), []);
  const server = await servers.create(accepted, owner);
  assert.equal(server.host, 'fixture.example');
  assert.equal(server.hostKeyFingerprint, fingerprint(1));
  await assert.rejects(servers.create(accepted, owner), ConflictException);
  assert.equal((await servers.test(server.id, owner)).success, true);

  const expired = await servers.probeHostKey(endpoint, owner);
  const digest = createHash('sha256').update(expired.acceptanceToken).digest('hex');
  const key = 'ssh.host-key-acceptance:' + digest;
  const row = await db
    .selectFrom('system_settings')
    .select('value_json')
    .where('key', '=', key)
    .executeTakeFirstOrThrow();
  await db
    .updateTable('system_settings')
    .set({
      value_json: JSON.stringify({ ...JSON.parse(row.value_json), expiresAt: Date.now() - 1 }),
    })
    .where('key', '=', key)
    .execute();
  await assert.rejects(
    servers.create({ ...input, hostKeyAcceptanceToken: expired.acceptanceToken }, owner),
    ConflictException,
  );

  const edited = await servers.update(server.id, { ...input, name: 'Renamed' }, owner);
  assert.equal(edited.hostKeyFingerprint, fingerprint(1));
  assert.equal(edited.status, 'ONLINE');
  const trusted = await servers.probeHostKey({ ...endpoint, serverId: server.id }, owner);
  assert.equal(trusted.matchesPrevious, true);
  remoteKey = fingerprint(2);
  await assert.rejects(servers.test(server.id, owner), /SSH 主机指纹与已确认值不一致/);
  assert.equal((await servers.get(server.id)).hostKeyFingerprint, fingerprint(1));
  await assert.rejects(
    servers.update(server.id, { ...input, hostKeyFingerprint: remoteKey }, owner),
    BadRequestException,
  );
  const changed = await servers.probeHostKey({ ...endpoint, serverId: server.id }, owner);
  assert.equal(changed.previousFingerprint, fingerprint(1));
  assert.equal(changed.matchesPrevious, false);
  await assert.rejects(
    servers.create({ ...input, hostKeyAcceptanceToken: changed.acceptanceToken }, owner),
    ConflictException,
  );
  const rotated = await servers.confirmHostKey(
    server.id,
    { hostKeyAcceptanceToken: changed.acceptanceToken },
    owner,
  );
  assert.equal(rotated.hostKeyFingerprint, fingerprint(2));
  await assert.rejects(
    servers.confirmHostKey(server.id, { hostKeyAcceptanceToken: trusted.acceptanceToken }, owner),
    ConflictException,
  );
  assert.equal((await servers.test(server.id, owner)).success, true);

  const moved = { ...input, host: 'Other.Example' };
  await assert.rejects(servers.update(server.id, moved, owner), BadRequestException);
  const next = await servers.probeHostKey(
    { host: moved.host, port: moved.port, serverId: server.id },
    owner,
  );
  const updated = await servers.update(
    server.id,
    { ...moved, hostKeyAcceptanceToken: next.acceptanceToken },
    owner,
  );
  assert.equal(updated.host, 'other.example');
  const rotationAudit = await db
    .selectFrom('audit_logs')
    .select(['user_id', 'details_json'])
    .where('action', '=', 'server.host_key.accept')
    .executeTakeFirstOrThrow();
  assert.equal(rotationAudit.user_id, owner);
  assert.equal(JSON.parse(rotationAudit.details_json).previousFingerprint, fingerprint(1));
});
