import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { AiSourceChangeService } from '../modules/ai/ai-source-change.service';
import { AuditService } from '../modules/audit/audit.service';
import type { DatabaseService } from '../core/database/database.service';
import type { CredentialsService } from '../modules/credentials/credentials.service';

const exec = promisify(execFile);
const token = 'opaque-fixture-value-for-source-change';
const username = 'repo-writer';

async function serveRepository(root: string) {
  const writes: Array<{ head: string; base: string; title: string }> = [];
  const access = 'Basic ' + Buffer.from(username + ':' + token).toString('base64');
  const gitPath = (await exec('git', ['--exec-path'])).stdout.trim();
  const backend = join(
    gitPath,
    process.platform === 'win32' ? 'git-http-backend.exe' : 'git-http-backend',
  );
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://fixture.invalid');
    if (path.pathname === '/api/v1/repos/demo/app/pulls' && request.method === 'POST') {
      if (request.headers.authorization !== 'token ' + token) {
        response.writeHead(403).end();
        return;
      }
      const bytes: Buffer[] = [];
      for await (const chunk of request) bytes.push(Buffer.from(chunk));
      writes.push(JSON.parse(Buffer.concat(bytes).toString('utf8')));
      response
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ number: 7 }));
      return;
    }
    if (!path.pathname.startsWith('/demo/app.git/')) {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== access) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="test sources"' }).end();
      return;
    }
    const child = spawn(backend, [], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, 'unused-global-config'),
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method || 'GET',
        PATH_INFO: path.pathname,
        QUERY_STRING: path.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: request.headers['content-length'] || '0',
        HTTP_GIT_PROTOCOL: request.headers['git-protocol']?.toString() || '',
        REMOTE_USER: username,
      },
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on('error', () => response.writeHead(500).end());
    child.on('close', () => {
      const output = Buffer.concat(chunks);
      const separator = '\r\n\r\n';
      const start = output.indexOf(separator);
      if (start === -1) return response.writeHead(500).end();
      let status = 200;
      for (const header of output.subarray(0, start).toString('ascii').split('\r\n')) {
        const colon = header.indexOf(':');
        if (colon === -1) continue;
        const key = header.slice(0, colon);
        const value = header.slice(colon + 1).trim();
        if (key === 'Status') status = Number.parseInt(value, 10);
        else response.setHeader(key, value);
      }
      response.writeHead(status).end(output.subarray(start + separator.length));
    });
    child.stdin.on('error', () => undefined);
    request.pipe(child.stdin);
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    writes,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((complete) => server.close(() => complete())),
  };
}

test('AI source changes create an isolated Git branch from a pinned base and only then an audited Gitea PR', async (t) => {
  try {
    await exec('git', ['--version']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return t.skip('Git is required for the authenticated repository test');
  }
  const work = await mkdtemp(join(tmpdir(), 'veyops-ai-source-test-'));
  const resources: { fixture?: Awaited<ReturnType<typeof serveRepository>> } = {};
  t.after(async () => {
    await resources.fixture?.close();
    await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const git = async (...args: string[]) =>
    (
      await exec(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
        {
          cwd: work,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: join(work, 'unused-global-config'),
          },
          windowsHide: true,
        },
      )
    ).stdout.trim();
  const source = join(work, 'source');
  const remote = join(work, 'demo', 'app.git');
  await git('init', '--initial-branch=main', '--template=', '-q', source);
  await mkdir(join(source, 'src'));
  await mkdir(join(work, 'demo'));
  await writeFile(join(source, 'src', 'app.ts'), 'export const status = 500;\n');
  await writeFile(join(source, 'README.md'), '# Fixture\n');
  await git('-C', source, 'add', '.');
  const blob = await git('-C', source, 'hash-object', '-w', 'README.md');
  await git('-C', source, 'update-index', '--add', '--cacheinfo', `120000,${blob},src/link.ts`);
  await git('-C', source, 'commit', '-m', 'Initial fixture');
  const baseCommit = await git('-C', source, 'rev-parse', 'HEAD');
  await git('clone', '--bare', '--quiet', source, remote);
  await git(`--git-dir=${remote}`, 'config', 'http.receivepack', 'true');
  await git(`--git-dir=${remote}`, 'config', 'uploadpack.allowFilter', 'true');
  const fixture = await serveRepository(work);
  resources.fixture = fixture;

  const projectId = randomUUID();
  const repositoryId = randomUUID();
  const id = randomUUID();
  const actor = randomUUID();
  const repo = { id, nonce: 'v1', provider: 'GITEA', clone_url: fixture.url + '/demo/app.git' };
  const logs: Array<Record<string, unknown>> = [];
  const database = {
    db: {
      selectFrom(table: string) {
        const matched: Record<string, unknown> = {};
        const query = {
          innerJoin: () => query,
          select: () => query,
          where(field: string, operator: string, value: unknown) {
            if (operator === '=') matched[field] = value;
            return query;
          },
          async executeTakeFirst() {
            if (table === 'repositories') {
              if (
                matched['repositories.id'] === repositoryId &&
                matched['repositories.project_id'] === projectId
              )
                return repo;
              return undefined;
            }
            return logs.find((row) =>
              Object.entries(matched).every(([key, value]) => row[key] === value),
            );
          },
        };
        return query;
      },
      insertInto(table: string) {
        assert.equal(table, 'audit_logs');
        return {
          values(row: Record<string, unknown>) {
            const write = () => {
              if (logs.some(({ id }) => id === row.id)) return undefined;
              logs.push(row);
              return row;
            };
            return {
              async execute() {
                write();
              },
              onConflict() {
                return { returning: () => ({ executeTakeFirst: async () => write() }) };
              },
            };
          },
        };
      },
    },
  } as unknown as DatabaseService;
  const credentials = {
    async decrypt(credentialId: string, nonce: string) {
      assert.equal(credentialId, repo.id);
      assert.equal(nonce, repo.nonce);
      return { token, username };
    },
  } as unknown as CredentialsService;
  const service = new AiSourceChangeService(database, credentials, new AuditService(database));
  const request = {
    projectId,
    repositoryId,
    baseBranch: 'main',
    baseCommit,
    title: 'Fix sample status',
    files: [{ path: 'src/app.ts', content: 'export const status = 200;\n' }],
  };
  assert.equal(
    service.suggest({ ...request, description: 'Return the successful status.' }).draftOnly,
    true,
  );
  assert.equal(fixture.writes.length, 0);
  assert.notEqual(
    service.suggest({ ...request, description: 'Return the successful status.' }).files,
    undefined,
  );
  for (const path of [
    '.github/workflows/ci.yml',
    'src/config/default.ts',
    'src/../outside.ts',
    'src/secret.ts',
  ]) {
    await assert.rejects(
      service.prepare({ ...request, files: [{ path, content: 'denied' }] }, 'BRANCH'),
      /只允许修改/,
    );
  }
  await assert.rejects(
    service.prepare({ ...request, repositoryId: randomUUID() }, 'BRANCH'),
    /仓库不存在/,
  );
  await assert.rejects(
    service.prepare({ ...request, files: [{ path: 'src/app.ts', content: token }] }, 'BRANCH'),
    /包含仓库凭据/,
  );

  const symlink = await service.prepare(
    { ...request, files: [{ path: 'src/link.ts', content: 'attempt' }] },
    'BRANCH',
  );
  await assert.rejects(
    service.execute('BRANCH', symlink.payload, symlink.bindingsHash, actor),
    /已有的普通非可执行文件/,
  );
  const staleBase = await service.prepare({ ...request, baseCommit: 'a'.repeat(40) }, 'BRANCH');
  await assert.rejects(
    service.execute('BRANCH', staleBase.payload, staleBase.bindingsHash, actor),
    /基线提交已变化/,
  );
  const prepared = await service.prepare(request, 'BRANCH');
  repo.nonce = 'v2';
  await assert.rejects(
    service.execute('BRANCH', prepared.payload, prepared.bindingsHash, actor),
    /仓库绑定或源码变更已修改/,
  );
  repo.nonce = 'v1';

  assert.deepEqual(
    await git(`--git-dir=${remote}`, 'for-each-ref', '--format=%(refname)', 'refs/heads'),
    'refs/heads/main',
  );
  const branch = await service.execute('BRANCH', prepared.payload, prepared.bindingsHash, actor);
  assert.equal(branch.kind, 'SOURCE_BRANCH');
  if (branch.kind !== 'SOURCE_BRANCH') assert.fail('Expected a branch receipt');
  assert.match(branch.branch, /^veyops-ai\//);
  assert.equal(await git(`--git-dir=${remote}`, 'rev-parse', 'main'), baseCommit);
  assert.equal(await git(`--git-dir=${remote}`, 'rev-parse', branch.branch + '^'), baseCommit);
  assert.equal(
    await git(`--git-dir=${remote}`, 'show', branch.branch + ':src/app.ts'),
    'export const status = 200;',
  );
  assert.equal(
    await git(`--git-dir=${remote}`, 'show', 'main:src/app.ts'),
    'export const status = 500;',
  );
  assert.equal(fixture.writes.length, 0);
  const pull = await service.prepare(
    { ...request, branch: branch.branch, commitSha: branch.commitSha },
    'PULL_REQUEST',
  );
  await assert.rejects(
    service.execute('PULL_REQUEST', pull.payload, pull.bindingsHash, randomUUID()),
    /本人/,
  );
  await assert.rejects(
    service.prepare({ ...request, branch: 'main', commitSha: baseCommit }, 'PULL_REQUEST'),
    /独立 AI 分支/,
  );
  assert.equal(fixture.writes.length, 0);
  const writes = await Promise.allSettled(
    [1, 2].map(() => service.execute('PULL_REQUEST', pull.payload, pull.bindingsHash, actor)),
  );
  const success = writes.find((result) => result.status === 'fulfilled');
  assert.ok(success);
  const result = success.value;
  for (const duplicate of writes.filter((entry) => entry.status === 'rejected'))
    assert.match(String(duplicate.reason), /已提交过 PR 创建请求/);
  assert.equal(result.kind, 'PULL_REQUEST');
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.writes[0].head, branch.branch);
  assert.equal(fixture.writes[0].base, 'main');
  assert.equal(fixture.writes[0].title, request.title);
  assert.deepEqual(
    await service.execute('PULL_REQUEST', pull.payload, pull.bindingsHash, actor),
    result,
  );
  assert.equal(fixture.writes.length, 1);
  assert.ok(!JSON.stringify(logs).includes(token));
  assert.equal(await git(`--git-dir=${remote}`, 'rev-parse', 'main'), baseCommit);
});
