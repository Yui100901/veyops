import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { Server, utils, Connection } from 'ssh2';
import { SshService, SshTarget } from '../infrastructure/ssh/ssh.service';
import type { CredentialsService } from '../modules/credentials/credentials.service';

test('SFTP uses verified SSH to upload content/files and download identical artifact bytes', async () => {
  const privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const fingerprint =
    'SHA256:' +
    createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const files = new Map<string, Buffer>(),
    handles = new Map<number, string>(),
    connections = new Set<Connection>();
  let next = 1;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    connections.add(client);
    client.on('close', () => connections.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (ctx) =>
      ctx.method === 'password' && ctx.password === 'sftp-fixture' ? ctx.accept() : ctx.reject(),
    );
    client.on('ready', () =>
      client.on('session', (accept) =>
        accept().on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const stats = (id: number, path: string) => {
            const data = files.get(path);
            if (!data) {
              sftp.status(id, 2);
              return;
            }
            sftp.attrs(id, {
              size: data.length,
              mode: 0o100600,
              uid: 0,
              gid: 0,
              atime: 0,
              mtime: 0,
            });
          };
          sftp.on('OPEN', (id, path, flags) => {
            if (flags & 8) files.set(path, Buffer.alloc(0));
            if (!files.has(path)) {
              sftp.status(id, 2);
              return;
            }
            const n = next++,
              h = Buffer.alloc(4);
            h.writeUInt32BE(n);
            handles.set(n, path);
            sftp.handle(id, h);
          });
          sftp.on('WRITE', (id, h, offset, data) => {
            const path = handles.get(h.readUInt32BE())!,
              old = files.get(path) || Buffer.alloc(0),
              updated = Buffer.alloc(Math.max(old.length, offset + data.length));
            old.copy(updated);
            data.copy(updated, offset);
            files.set(path, updated);
            sftp.status(id, 0);
          });
          sftp.on('READ', (id, h, offset, length) => {
            const data = files.get(handles.get(h.readUInt32BE())!)!;
            if (offset >= data.length) sftp.status(id, 1);
            else sftp.data(id, data.subarray(offset, offset + length));
          });
          sftp.on('CLOSE', (id, h) => {
            handles.delete(h.readUInt32BE());
            sftp.status(id, 0);
          });
          sftp.on('STAT', stats);
          sftp.on('LSTAT', stats);
          sftp.on('FSTAT', (id, h) => stats(id, handles.get(h.readUInt32BE())!));
          sftp.on('SETSTAT', (id) => sftp.status(id, 0));
          sftp.on('FSETSTAT', (id) => sftp.status(id, 0));
        }),
      ),
    );
  });
  const directory = await mkdtemp(join(tmpdir(), 'veyops-sftp-'));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const target: SshTarget = {
      id: 'fixture',
      name: 'fixture',
      host: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      username: 'ops',
      credentialId: 'fixture',
      hostKeyFingerprint: fingerprint,
    };
    const service = new SshService({
      decrypt: async () => ({ password: 'sftp-fixture' }),
    } as unknown as CredentialsService);
    const bytes = Buffer.from('真实产物\n'.repeat(20000));
    const local = join(directory, 'artifact.tar');
    await writeFile(local, bytes);
    await service.upload(target, local, '/artifact.tar', { timeout: 10 });
    assert.deepEqual(files.get('/artifact.tar'), bytes);
    await service.download(target, '/artifact.tar', join(directory, 'downloaded.tar'), {
      timeout: 10,
    });
    assert.deepEqual(await readFile(join(directory, 'downloaded.tar')), bytes);
    await service.uploadContent(target, '#!/bin/sh\ntrue\n', '/askpass', {
      timeout: 5,
      mode: 0o700,
    });
    assert.equal(files.get('/askpass')?.toString(), '#!/bin/sh\ntrue\n');
    await assert.rejects(
      service.upload({ ...target, hostKeyFingerprint: '0'.repeat(64) }, local, '/blocked', {
        timeout: 5,
      }),
      /SFTP/,
    );
    assert.equal(files.has('/blocked'), false);
  } finally {
    for (const c of connections) c.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
