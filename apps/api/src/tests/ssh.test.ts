import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Server, Connection, utils } from 'ssh2';
import { SshExecutionError, SshService, SshTarget } from '../infrastructure/ssh/ssh.service';
import { CredentialsService } from '../modules/credentials/credentials.service';

const password = 'ssh-test-secret-value';
const hostKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const parsed = utils.parseKey(hostKey);
if (parsed instanceof Error) throw parsed;
const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const connections = new Set<Connection>();
let target: SshTarget;
const server = new Server({ hostKeys: [hostKey] }, (connection) => {
  connections.add(connection);
  connection.on('close', () => connections.delete(connection));
  connection.on('error', () => undefined);
  connection.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'ops' && ctx.password === password)
      ctx.accept();
    else ctx.reject();
  });
  connection.on('ready', () =>
    connection.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptCommand, _reject, info) => {
        const stream = acceptCommand();
        stream.on('error', () => undefined);
        if (info.command === 'wait') return;
        if (info.command === 'nonzero') {
          stream.stderr.write('expected error');
          stream.exit(7);
          stream.end();
          return;
        }
        stream.write(`first ${password.slice(0, 8)}`);
        setTimeout(() => {
          stream.write(`${password.slice(8)} last\n`);
          stream.exit(0);
          stream.end();
        }, 10);
      });
    }),
  );
});
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  target = {
    id: 'test',
    name: 'local-test-ssh',
    host: '127.0.0.1',
    port: (server.address() as AddressInfo).port,
    username: 'ops',
    credentialId: 'test-credential',
    hostKeyFingerprint: fingerprint,
  };
});
after(async () => {
  for (const connection of connections) connection.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const service = (secret = password) =>
  new SshService({ decrypt: async () => ({ password: secret }) } as unknown as CredentialsService);

test('real SSH connection validates host key, authenticates and redacts streamed credentials', async () => {
  let output = '';
  const result = await service().execute(target, 'inspect', {
    timeout: 5,
    onData: (text) => {
      output += text;
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(output, 'first [REDACTED] last\n');
  assert.equal(output.includes(password), false);
});
test('real SSH rejects a changed host key and a wrong password', async () => {
  await assert.rejects(
    service().execute({ ...target, hostKeyFingerprint: '0'.repeat(64) }, 'inspect', { timeout: 5 }),
    /verification failed|host|fingerprint/i,
  );
  await assert.rejects(
    service('incorrect').execute(target, 'inspect', { timeout: 5 }),
    /authentication/i,
  );
});
test('real SSH exposes independent command exit codes', async () => {
  const result = await service().execute(target, 'nonzero', { timeout: 5 });
  assert.equal(result.exitCode, 7);
});
test('real SSH timeout and user cancellation close the command channel', async () => {
  await assert.rejects(
    service().execute(target, 'wait', { timeout: 0.2 }),
    (error: unknown) => error instanceof SshExecutionError && error.kind === 'TIMED_OUT',
  );
  const controller = new AbortController();
  const promise = service().execute(target, 'wait', { timeout: 5, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof SshExecutionError && error.kind === 'CANCELLED',
  );
});
test('a failing log sink fails the SSH task safely instead of throwing from an event callback', async () => {
  await assert.rejects(
    service().execute(target, 'inspect', {
      timeout: 5,
      onData: () => {
        throw new Error('disk full');
      },
    }),
    (error: unknown) => error instanceof SshExecutionError && error.kind === 'NEEDS_ATTENTION',
  );
});
