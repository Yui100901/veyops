import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

const exec = promisify(execFile);

async function gitHttpFixture(directory: string, token: string) {
  const authorization = `Basic ${Buffer.from(`fixture-user:${token}`).toString('base64')}`;
  let authenticatedRequests = 0;
  let available = true;
  let pauseRequest: (() => Promise<void>) | undefined;
  const server = createServer(async (req, res) => {
    if (!available) {
      res.writeHead(503).end();
      return;
    }
    if (req.headers.authorization !== authorization) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }).end();
      return;
    }
    authenticatedRequests++;
    if (pauseRequest) {
      const wait = pauseRequest;
      pauseRequest = undefined;
      await wait();
    }
    const url = new URL(req.url!, 'http://127.0.0.1');
    if (url.pathname.startsWith('/redirect.git/')) {
      res.writeHead(302, { location: req.url!.replace('/redirect.git/', '/source.git/') }).end();
      return;
    }
    const backend = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: directory.replaceAll('\\', '/'),
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method!,
        CONTENT_TYPE: req.headers['content-type'] || '',
        CONTENT_LENGTH: req.headers['content-length'] || '',
        GIT_PROTOCOL: String(req.headers['git-protocol'] || ''),
      },
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    backend.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    backend.stderr.resume();
    backend.on('error', () => res.writeHead(500).end());
    backend.on('close', (code) => {
      if (res.writableEnded) return;
      const response = Buffer.concat(chunks);
      const delimiter = Buffer.from('\r\n\r\n');
      const split = response.indexOf(delimiter);
      if (code !== 0 || split === -1) {
        res.writeHead(500).end();
        return;
      }
      let status = 200;
      for (const line of response.subarray(0, split).toString('ascii').split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon < 1) continue;
        const name = line.slice(0, colon);
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') status = Number(value.slice(0, 3));
        else res.setHeader(name, value);
      }
      res.writeHead(status).end(response.subarray(split + delimiter.length));
    });
    backend.stdin.on('error', () => undefined);
    req.pipe(backend.stdin);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    authenticatedRequests: () => authenticatedRequests,
    holdNextRequest: () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        pauseRequest = () => {
          resolve();
          return gate;
        };
      });
      return { started, release };
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function checkMetadata(t: TestContext, databaseUrl?: string) {
  try {
    await exec('git', ['--version']);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Git executable unavailable');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'veyops-git-metadata-test-'));
  const resources: {
    app?: NestExpressApplication;
    fixture?: Awaited<ReturnType<typeof gitHttpFixture>>;
    provider?: ReturnType<typeof createServer>;
  } = {};
  t.after(async () => {
    await resources.app?.close();
    await resources.fixture?.close();
    if (resources.provider?.listening)
      await new Promise<void>((resolve) => resources.provider!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const token = 'fixture-git-token-for-metadata-only';
  const authorDate = '2024-03-12T08:10:00+08:00';
  const source = join(directory, 'source');
  const git = (...args: string[]) =>
    exec(
      'git',
      [
        '-c',
        'user.name=Fixture Author',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      {
        cwd: directory,
        env: { ...process.env, GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: authorDate },
        windowsHide: true,
      },
    );
  await git('init', '--initial-branch=main', '--template=', source);
  const docs = join(source, 'docs');
  await mkdir(docs);
  const web = join(source, 'services', 'web');
  await mkdir(join(web, 'src'), { recursive: true });
  await mkdir(join(web, 'secrets'));
  await mkdir(join(source, 'services', 'api'), { recursive: true });
  await writeFile(
    join(web, 'package.json'),
    JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' } }),
  );
  await writeFile(join(web, 'README.md'), '# Browser application\nUse pnpm and Node.js.\n');
  await writeFile(join(web, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nignored-lock-data\n');
  await writeFile(join(web, 'src', 'index.ts'), 'export const version = "first-source-entry";\n');
  await writeFile(
    join(web, 'compose.yaml'),
    'services:\n  web:\n    environment:\n      DB_PASSWORD: "sample-quoted-secret"\n',
  );
  await writeFile(join(web, '.env'), 'SHOULD_NOT_SEND=env-file-private\n');
  await writeFile(join(web, 'secrets', 'README.md'), 'secrets-file-private');
  await writeFile(
    join(source, 'services', 'api', 'package.json'),
    '{"name":"outside-selected-subdirectory"}',
  );
  await writeFile(join(docs, 'DEPLOY.md'), `# First release\n使用凭据 ${token}\n`);
  await writeFile(join(docs, 'deployment.md'), Buffer.alloc(12 * 1024 + 1, 65));
  await writeFile(join(source, 'pointer.txt'), '../docs/DEPLOY.md');
  await git('-C', source, 'add', 'docs', 'services');
  const pointer = (await git('-C', source, 'hash-object', '-w', 'pointer.txt')).stdout.trim();
  await git(
    '-C',
    source,
    'update-index',
    '--add',
    '--cacheinfo',
    `120000,${pointer},link/DEPLOY.md`,
  );
  await git('-C', source, 'update-index', '--add', '--cacheinfo', `120000,${pointer},linked`);
  const commit = async (subject: string) => {
    await git('-C', source, 'commit', '--allow-empty', '-m', subject);
    return (await git('-C', source, 'rev-parse', 'HEAD')).stdout.trim();
  };
  const first = await commit('First change');
  await writeFile(join(docs, 'DEPLOY.md'), '# Second release\n');
  await writeFile(join(web, 'src', 'index.ts'), 'export const version = "current-source-entry";\n');
  await writeFile(join(web, '.env'), 'SHOULD_NOT_SEND=new-private-value\n');
  await writeFile(join(web, '.env.test'), 'TEST_KEY=test-value\nVEYOPS_PROJECT_ID=spoof\n');
  await writeFile(join(web, '.env.prod'), 'PROD_KEY=prod-value\n');
  await git('-C', source, 'add', 'docs/DEPLOY.md', 'services/web');
  const second = await commit('Second change');
  const main = await commit('Third change');
  await git('-C', source, 'tag', '-a', 'release/v1', '-m', 'annotated release', second);
  await git('-C', source, 'tag', 'release/lightweight', first);
  await git('-C', source, 'switch', '-c', 'feature/release', first);
  const feature = await commit(`Branch change with ${token}`);
  await git('-C', source, 'switch', 'main');
  const bare = join(directory, 'source.git');
  await git('clone', '--bare', '--template=', '--', source, bare);
  await git('--git-dir', bare, 'config', 'uploadpack.allowFilter', 'true');
  await git('--git-dir', bare, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const fixture = await gitHttpFixture(directory, token);
  resources.fixture = fixture;

  const initialPassword = 'fixture-metadata-password';
  const password = 'fixture-metadata-renewed-password';
  Object.assign(process.env, {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    ...(databaseUrl && { DATABASE_URL: databaseUrl }),
    DATABASE_PATH: join(directory, 'test.db'),
    DATA_DIR: directory,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    WORKER_ENABLED: 'false',
    ADMIN_PASSWORD: initialPassword,
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { RepositoryMetadataService } =
    await import('../modules/projects/repository-metadata.service.js');
  const { GraphNodeTasks, graphCheckoutOutputs } =
    await import('../modules/execution-graphs/graph-node-tasks.js');
  const { BuildsService } = await import('../modules/builds/builds.service.js');
  const { PipelineDefinitionDto } = await import('../modules/pipelines/pipeline.dto.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  resources.app = app;
  configureApp(app);
  await app.init();
  const admin = request.agent(app.getHttpServer());
  await admin
    .post('/api/v1/auth/login')
    .send({ username: 'root', password: initialPassword })
    .expect(201);
  await admin
    .post('/api/v1/auth/change-password')
    .send({ currentPassword: initialPassword, newPassword: password })
    .expect(200);
  await admin.post('/api/v1/auth/login').send({ username: 'root', password }).expect(201);
  const db = app.get(DatabaseService).db;
  const root = await db
    .selectFrom('users')
    .select('password_hash')
    .where('username', '=', 'root')
    .executeTakeFirstOrThrow();
  const sessions = new Map<'OPERATOR' | 'VIEWER', typeof admin>();
  for (const role of ['OPERATOR', 'VIEWER'] as const) {
    await db
      .insertInto('users')
      .values({
        id: randomUUID(),
        username: role.toLowerCase(),
        password_hash: root.password_hash,
        role,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    const session = request.agent(app.getHttpServer());
    await session
      .post('/api/v1/auth/login')
      .send({ username: role.toLowerCase(), password })
      .expect(201);
    sessions.set(role, session);
  }
  const operator = sessions.get('OPERATOR')!;
  const viewer = sessions.get('VIEWER')!;
  const project = (
    await admin.post('/api/v1/projects').send({ name: 'Fixture', slug: 'fixture' }).expect(201)
  ).body.data.id;
  const other = (
    await admin.post('/api/v1/projects').send({ name: 'Other', slug: 'other' }).expect(201)
  ).body.data.id;
  const credential = (
    await admin
      .post('/api/v1/credentials')
      .send({
        name: 'Git Fixture',
        type: 'GIT_TOKEN',
        secret: { username: 'fixture-user', token },
      })
      .expect(201)
  ).body.data.id;
  const repositoryPath = `/api/v1/projects/${project}/repositories`;
  const create = {
    name: 'Private fixture',
    cloneUrl: `${fixture.url}/source.git`,
    defaultBranch: 'old',
  };
  await operator
    .post(repositoryPath)
    .send({ ...create, credentialId: credential })
    .expect(403);
  const duplicate = (
    await operator
      .post(repositoryPath)
      .send({ ...create, name: 'Public fixture' })
      .expect(201)
  ).body.data;
  await git('--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/feature/release');
  const created = (
    await admin
      .post(repositoryPath)
      .send({ ...create, credentialId: credential })
      .expect(201)
  ).body.data;
  const id = created.id;
  assert.equal(created.defaultBranch, 'feature/release');
  assert.equal(created.branchSyncStatus, 'CURRENT');
  const metadataPath = `${repositoryPath}/${id}`;

  await viewer.get(`${metadataPath}/connection`).expect(403);
  await admin.get(`/api/v1/projects/${other}/repositories/${id}/branches`).expect(404);
  const cached = (await operator.get(`${metadataPath}/branch-cache`).expect(200)).body.data;
  assert.deepEqual(cached.branches, [
    { name: 'feature/release', sha: feature },
    { name: 'main', sha: main },
  ]);
  assert.equal(cached.defaultBranch, 'feature/release');
  assert.equal(cached.status, 'CURRENT');
  await viewer.post(`${metadataPath}/branch-cache/refresh`).expect(403);
  await admin.get(`/api/v1/projects/${other}/repositories/${id}/branch-cache`).expect(404);
  await db
    .updateTable('repositories')
    .set({
      branch_cache_json: JSON.stringify({ ...cached, syncedAt: Date.now() - 16 * 60_000 }),
    })
    .where('id', '=', id)
    .execute();
  assert.equal(
    (await operator.get(`${metadataPath}/branch-cache`).expect(200)).body.data.status,
    'STALE',
  );
  fixture.setAvailable(false);
  const offline = (await operator.post(`${metadataPath}/branch-cache/refresh`).expect(201)).body
    .data;
  assert.equal(offline.status, 'ERROR');
  assert.deepEqual(offline.branches, cached.branches);
  fixture.setAvailable(true);
  await git('--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const recovered = (await operator.post(`${metadataPath}/branch-cache/refresh`).expect(201)).body
    .data;
  assert.equal(recovered.status, 'CURRENT');
  assert.equal(recovered.defaultBranch, 'main');
  const metadata = app.get(RepositoryMetadataService);
  const access = { clone_url: create.cloneUrl, credential_id: credential };
  const beforeRepositoryMatch = fixture.authenticatedRequests();
  await assert.rejects(
    metadata.planGraphCheckout(project, { repositoryId: create.cloneUrl, mode: 'BRANCH' }),
    /匹配多个项目仓库/,
  );
  await assert.rejects(
    metadata.planGraphCheckout(other, { repositoryId: create.cloneUrl, mode: 'BRANCH' }),
    /未匹配当前项目/,
  );
  assert.equal(fixture.authenticatedRequests(), beforeRepositoryMatch);
  await admin.delete(`${repositoryPath}/${duplicate.id}`).expect(200);
  const shallow = await metadata.planGraphCheckout(project, {
    repositoryId: create.cloneUrl,
    mode: 'BRANCH',
    branch: 'feature/release',
  });
  assert.equal(shallow.repositoryId, id);
  assert.equal(shallow.commitSha, feature);
  assert.deepEqual(await metadata.checkoutGraphSource(project, shallow), {
    commitSha: feature,
    subject: 'Branch change with [REDACTED]',
    shallow: true,
  });
  const tag = await metadata.planGraphCheckout(project, {
    repositoryId: id,
    mode: 'TAG',
    tag: 'release/v1',
  });
  assert.equal(tag.commitSha, second);
  assert.equal(tag.tag, 'release/v1');
  assert.equal(
    (
      await metadata.planGraphCheckout(project, {
        repositoryId: id,
        mode: 'TAG',
        tag: 'release/lightweight',
      })
    ).commitSha,
    first,
  );
  await git('--git-dir', bare, 'tag', '-f', 'release/v1', main);
  const persistedWorktree = join(directory, 'persisted-worktree');
  assert.equal(
    (await metadata.checkoutGraphSource(project, tag, undefined, persistedWorktree)).commitSha,
    second,
  );
  assert.equal(
    (await readFile(join(persistedWorktree, 'docs', 'DEPLOY.md'), 'utf8')).trim(),
    '# Second release',
  );
  const graphNodes = app.get(GraphNodeTasks);
  const checkoutNode = { id: 'source', name: 'Source', type: 'CHECKOUT' } as const;
  const values = { repository: id, version: { kind: 'COMMIT', value: second } };
  const plan = await graphNodes.prepare(project, checkoutNode, { values, fetchModeDeferred: true });
  assert.equal(plan.type, 'CHECKOUT');
  assert.equal(plan.fetchModeDeferred, true);
  assert.equal(plan.source.commitSha, second);
  assert.equal(graphCheckoutOutputs(plan.source, undefined, undefined, true).fetchMode, undefined);
  const task = await graphNodes.task(project, checkoutNode, plan, randomUUID(), {
    runId: randomUUID(),
    nodeRunId: randomUUID(),
    values: { ...values, fetchMode: 'FULL' },
  });
  const history = task.payload.graphModule?.source;
  assert.ok(history);
  assert.equal(graphCheckoutOutputs(history).fetchMode, 'FULL');
  assert.deepEqual(await metadata.checkoutGraphSource(project, history), {
    commitSha: second,
    subject: 'Second change',
    shallow: false,
  });
  const graphPath = `/api/v1/projects/${project}/execution-graph`;
  const repoInput = {
    id: 'repository',
    name: '仓库名',
    referenceName: 'GIT_REPOSITORY_NAME',
    type: 'REPOSITORY',
    defaultValue: create.cloneUrl,
  };
  const graph = {
    flows: [],
    canvas: {
      nodes: [
        { id: 'default', name: '默认仓库', type: 'START' },
        {
          id: 'supplied',
          name: '上游指定仓库',
          type: 'START',
          inputs: [{ ...repoInput, id: 'upstreamRepo' }],
        },
        {
          id: 'checkout',
          name: '手工配置检出节点',
          type: 'FUNCTION',
          operation: 'CHECKOUT',
          inputs: [repoInput],
        },
        { id: 'end', name: '完成检出', type: 'END' },
      ],
      endpoints: [
        { startId: 'default', endId: 'end' },
        { startId: 'supplied', endId: 'end' },
      ],
      edges: [
        { from: 'default', to: 'checkout' },
        { from: 'supplied', to: 'checkout' },
        { from: 'checkout', to: 'end' },
      ],
      templates: [],
    },
  };
  const currentGraph = (await admin.get(graphPath).expect(200)).body.data;
  const savedGraph = (
    await admin
      .put(graphPath + '/draft')
      .send({ expectedRevision: currentGraph.revision, definition: graph })
      .expect(200)
  ).body.data;
  const published = (
    await admin
      .post(graphPath + '/publish')
      .send({ expectedRevision: savedGraph.revision })
      .expect(201)
  ).body.data;
  for (const [flow, source] of [
    ['default', 'DEFAULT'],
    ['supplied', 'INPUT'],
  ]) {
    const preview = (
      await admin
        .post(`${graphPath}/flows/${flow}/preview`)
        .send({
          version: published.publishedVersion,
          inputs: { parameters: flow === 'supplied' ? { upstreamRepo: id } : {} },
        })
        .expect(201)
    ).body.data;
    assert.equal(preview.checkouts[0].repositoryId, id);
    assert.equal(preview.checkouts[0].commitSha, main);
    const checkout = preview.nodes.find((node: { nodeId: string }) => node.nodeId === 'checkout');
    const repository = checkout.inputs.find(
      (field: { fieldId: string }) => field.fieldId === 'repository',
    );
    assert.equal(repository.source.kind, source);
  }
  await admin.delete(metadataPath).expect(409);
  await assert.rejects(metadata.checkoutGraphSource(other, shallow), /仓库不存在/);
  assert.deepEqual(
    await metadata.branchHeads(project, id, ['main', 'feature/release', 'not-found'], access),
    new Map([
      ['main', main],
      ['feature/release', feature],
    ]),
  );
  await assert.rejects(
    metadata.branchHeads(project, id, ['main'], { ...access, credential_id: null }),
    /仓库配置已变化/,
  );
  await viewer.get(`${metadataPath}/environment-files`).query({ commitSha: first }).expect(403);
  await operator.get(`${metadataPath}/environment-files`).query({ commitSha: 'main' }).expect(400);
  const environmentFiles = await operator
    .get(`${metadataPath}/environment-files`)
    .query({ commitSha: first })
    .expect(200);
  assert.deepEqual(environmentFiles.body.data, {
    files: [{ path: 'services/web/.env', keys: ['SHOULD_NOT_SEND'] }],
  });
  assert.equal(environmentFiles.text.includes('env-file-private'), false);
  const currentSource = { repositoryId: id, commitSha: main, branch: 'main' };
  const configured = await graphNodes.prepareEnvironment(
    project,
    { ...currentSource, commitSha: first },
    { envFile: 'services/web/.env' },
  );
  assert.equal(configured?.status, 'PINNED');
  assert.equal(configured.source, 'NODE');
  assert.equal(configured.path, 'services/web/.env');
  assert.deepEqual(configured.variables, [
    { key: 'SHOULD_NOT_SEND', source: 'FILE', isSecret: true },
  ]);
  assert.equal(JSON.stringify(configured).includes('env-file-private'), false);
  const resolved = await app.get(BuildsService).resolveVariables({
    runId: 'fixture-run',
    pipelineId: 'fixture-pipeline',
    pipelineVersionId: 'fixture-version',
    projectId: project,
    serviceId: 'fixture-service',
    environmentId: 'fixture-scope',
    commitSha: main,
    repository: { url: create.cloneUrl, credentialId: credential },
    definition: new PipelineDefinitionDto(),
    variables: { SHOULD_NOT_SEND: 'higher-layer-value' },
    secretVariables: {},
    graph: {
      runId: 'fixture-run',
      nodeRunId: 'fixture-node',
      variables: { environmentFile: configured },
    },
  });
  assert.equal(resolved.values.SHOULD_NOT_SEND, 'higher-layer-value');
  assert.equal(resolved.secrets.includes('env-file-private'), true);
  assert.equal(resolved.secrets.includes('new-private-value'), false);
  const explicit = await graphNodes.prepareEnvironment(project, currentSource, {
    directory: 'services//web',
    envFile: './.env.test',
  });
  assert.equal(explicit?.status, 'PINNED');
  assert.equal(explicit.source, 'NODE');
  assert.equal(explicit.path, 'services/web/.env.test');
  assert.deepEqual(
    explicit.variables.map(({ key }) => key),
    ['TEST_KEY'],
  );
  await assert.rejects(
    graphNodes.prepareEnvironment(
      project,
      { ...currentSource, commitSha: first },
      {
        envFile: 'services/web/.env.test',
      },
    ),
    /缺少必需的环境文件/,
  );
  await assert.rejects(
    metadata.inspectGraphEnvironmentFile(project, currentSource, ['linked/.env']),
    /符号链接/,
  );
  await assert.rejects(
    metadata.inspectGraphEnvironmentFile(project, currentSource, ['link/DEPLOY.md']),
    /普通文件/,
  );
  for (const [slug, key] of [
    ['test', 'TEST_KEY'],
    ['prod', 'PROD_KEY'],
    ['staging', undefined],
  ] as const) {
    const plan = await graphNodes.prepareEnvironment(project, currentSource, {
      envFile: `services/web/.env.${slug}`,
      required: false,
    });
    assert.equal(plan?.commitSha, main);
    assert.equal(plan.source, 'NODE');
    assert.equal(plan.path, `services/web/.env.${slug}`);
    assert.equal(plan.status, key ? 'PINNED' : 'SKIPPED');
    assert.deepEqual(
      plan.variables.map(({ key }) => key),
      key ? [key] : [],
    );
  }
  assert.equal(
    await graphNodes.prepareEnvironment(project, currentSource, { directory: 'services/web' }),
    undefined,
  );
  await assert.rejects(
    graphNodes.prepareEnvironment(project, currentSource, { envFile: '../.env' }),
    /相对路径/,
  );
  const requestsBeforeInvalidQueries = fixture.authenticatedRequests();
  await assert.rejects(
    metadata.readDeploymentDoc(other, id, first, 'docs/DEPLOY.md'),
    /仓库不存在/,
  );
  await assert.rejects(metadata.readDeploymentDoc(project, id, first, '../DEPLOY.md'), /相对路径/);
  await assert.rejects(
    metadata.readDeploymentDoc(project, id, 'main', 'DEPLOY.md'),
    /完整 Git Commit/,
  );
  assert.equal(fixture.authenticatedRequests(), requestsBeforeInvalidQueries);
  const originalDoc = await metadata.readDeploymentDoc(project, id, first, 'docs/DEPLOY.md');
  assert.equal(originalDoc.commitSha, first);
  assert.equal(originalDoc.path, 'docs/DEPLOY.md');
  assert.equal(
    originalDoc.content.replaceAll('\r\n', '\n'),
    '# First release\n使用凭据 [REDACTED]\n',
  );
  const latestDoc = await metadata.readDeploymentDoc(project, id, main, 'docs/DEPLOY.md');
  assert.equal(latestDoc.content.replaceAll('\r\n', '\n'), '# Second release\n');
  await assert.rejects(
    metadata.readDeploymentDoc(project, id, first, 'DEPLOY.md'),
    /不存在该部署文档/,
  );
  await assert.rejects(
    metadata.readDeploymentDoc(project, id, first, 'link/DEPLOY.md'),
    /普通文件/,
  );
  await assert.rejects(metadata.readDeploymentDoc(project, id, first, 'docs/deployment.md'));
  const pinned = await metadata.readAnalysisContext(project, id, {
    commitSha: first,
    repoPath: 'services/web',
  });
  assert.equal(pinned.commitSha, first);
  assert.deepEqual(pinned.lockfiles, ['services/web/pnpm-lock.yaml']);
  assert.deepEqual(
    pinned.files.map((entry) => entry.path),
    [
      'services/web/README.md',
      'services/web/compose.yaml',
      'services/web/package.json',
      'services/web/src/index.ts',
    ],
  );
  assert.match(pinned.files.at(-1)!.content, /first-source-entry/);
  const defaultCommit = await metadata.readAnalysisContext(project, id, {
    repoPath: 'services/web',
  });
  assert.equal(defaultCommit.commitSha, main);
  assert.match(defaultCommit.files.at(-1)!.content, /current-source-entry/);
  await assert.rejects(
    metadata.readAnalysisContext(project, id, { repoPath: '../services' }),
    /相对子目录/,
  );
  await assert.rejects(
    metadata.readAnalysisContext(project, id, { docPath: 'link/DEPLOY.md' }),
    /普通文件/,
  );

  const providerRequests: { model: string; messages: { content: string }[]; tools?: unknown }[] =
    [];
  let conflictingDraft = false;
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    providerRequests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                name: 'Web build',
                testCommand: 'corepack pnpm test',
                technologies: ['Node.js', 'TypeScript'],
                detectedServices: [
                  { name: 'Web', path: 'services/web', technology: 'TypeScript' },
                  { name: 'Invented', path: 'outside' },
                ],
                definition: {
                  ...(conflictingDraft && { buildLocation: 'TARGET' }),
                  buildCommand: 'corepack pnpm run build',
                  installCommand: 'corepack pnpm install --frozen-lockfile',
                  outputPath: 'dist',
                  repoPath: 'invented/path',
                  registryId: randomUUID(),
                },
              }),
            },
          },
        ],
      }),
    );
  });
  resources.provider = provider;
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  await admin
    .post('/api/v1/ai/providers')
    .send({
      name: 'Repository analysis fixture',
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
      model: 'fixture-model',
      apiKey: 'fixture-provider-key',
    })
    .expect(201);
  const repositoryProvider = await admin
    .post('/api/v1/ai/providers')
    .send({
      name: 'Repository route',
      baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}`,
      model: 'repository-specialist',
      apiKey: 'fixture-provider-key',
    })
    .expect(201);
  const routing = { repository: repositoryProvider.body.data.id };
  await operator.put('/api/v1/ai/routing').send(routing).expect(403);
  await admin.put('/api/v1/ai/routing').send({ chat: 'invalid' }).expect(400);
  await admin.put('/api/v1/ai/routing').send(routing).expect(200);
  assert.deepEqual((await admin.get('/api/v1/ai/routing').expect(200)).body.data, routing);
  await admin.patch('/api/v1/ai/policies').send({ mode: 'READ_ONLY' }).expect(200);
  const analysisRequest = {
    projectId: project,
    repositoryId: id,
    commitSha: first,
    repoPath: 'services/web',
  };
  await viewer.post('/api/v1/ai/repository-analysis').send(analysisRequest).expect(403);
  await admin
    .patch('/api/v1/ai/policies')
    .send({ mode: 'READ_ONLY', repositoryIds: [] })
    .expect(200);
  const requestsBeforeDenial = fixture.authenticatedRequests();
  await operator.post('/api/v1/ai/repository-analysis').send(analysisRequest).expect(403);
  assert.equal(fixture.authenticatedRequests(), requestsBeforeDenial);
  assert.equal(providerRequests.length, 0);
  await admin
    .patch('/api/v1/ai/policies')
    .send({ mode: 'READ_ONLY', repositoryIds: [id] })
    .expect(200);
  const { body } = await operator
    .post('/api/v1/ai/repository-analysis')
    .send(analysisRequest)
    .expect(201);
  assert.equal(body.data.source.commitSha, first);
  assert.equal(body.data.source.path, 'services/web/README.md');
  assert.deepEqual(body.data.technologies, ['Node.js', 'TypeScript']);
  assert.deepEqual(body.data.detectedServices, [
    { name: 'Web', path: 'services/web', technology: 'TypeScript' },
  ]);
  assert.equal(body.data.draft.definition.repositoryId, id);
  assert.equal(body.data.draft.definition.repoPath, 'services/web');
  assert.equal(body.data.draft.definition.buildCommand, 'corepack pnpm run build');
  assert.equal(body.data.draft.definition.nodes, undefined);
  assert.equal(body.data.draft.definition.registryId, undefined);
  assert.equal(body.data.draft.definition.deployPath, undefined);
  assert.equal(body.data.draft.serviceId, undefined);
  assert.ok(body.data.missingFields.includes('deployPath'));
  assert.ok(body.data.evidencePaths.includes('services/web/pnpm-lock.yaml'));
  const [providerRequest] = providerRequests;
  assert.ok(providerRequest);
  assert.equal(providerRequest.model, 'repository-specialist');
  assert.equal(providerRequest.tools, undefined);
  const evidenceRequest = providerRequest.messages[1].content;
  assert.match(evidenceRequest, /first-source-entry/);
  assert.match(evidenceRequest, /pnpm-lock.yaml/);
  assert.match(evidenceRequest, /\[REDACTED\]/);
  assert.doesNotMatch(
    evidenceRequest,
    /current-source-entry|sample-quoted-secret|env-file-private|secrets-file-private|ignored-lock-data|outside-selected-subdirectory/,
  );
  const { body: repositoryOnly } = await operator
    .post('/api/v1/ai/repository-analysis')
    .send({ projectId: project, repositoryId: id })
    .expect(201);
  assert.deepEqual(repositoryOnly.data.source, { path: 'docs/DEPLOY.md', commitSha: main });
  assert.equal(repositoryOnly.data.draft.definition.repoPath, undefined);
  assert.equal(repositoryOnly.data.draft.definition.nodes, undefined);
  assert.ok(repositoryOnly.data.missingFields.includes('repoPath'));
  assert.match(providerRequests[1].messages[1].content, /Second release/);
  const pipeline = { buildLocation: 'MANAGER', artifactType: 'FILE', defaultMode: 'BUILD_ONLY' };
  const nodeDraftRequest = {
    projectId: project,
    repositoryId: id,
    repoPath: 'services/web',
    branch: 'feature/release',
    pipeline,
  };
  const { body: nodeDraft } = await operator
    .post('/api/v1/ai/repository-analysis')
    .send(nodeDraftRequest)
    .expect(201);
  assert.equal(nodeDraft.data.source.commitSha, feature);
  const definition = nodeDraft.data.draft.definition;
  assert.equal(definition.nodes[0].branch, 'feature/release');
  assert.deepEqual(
    definition.nodes.map((node: { type: string }) => node.type),
    ['CHECKOUT', 'INSTALL', 'BUILD', 'TEST', 'PACKAGE'],
  );
  assert.equal(definition.nodes[1].command, 'corepack pnpm install --frozen-lockfile');
  assert.equal(definition.nodes[2].command, 'corepack pnpm run build');
  assert.equal(definition.nodes[3].command, 'corepack pnpm test');
  assert.equal(definition.buildLocation, 'MANAGER');
  assert.equal(nodeDraft.data.missingFields.includes('deployPath'), false);
  assert.deepEqual(JSON.parse(providerRequests.at(-1)!.messages[1].content).pipeline, pipeline);
  const deployDraft = await operator
    .post('/api/v1/ai/repository-analysis')
    .send({
      ...nodeDraftRequest,
      commitSha: first,
      pipeline: { buildLocation: 'TARGET', artifactType: 'DOCKER_IMAGE', defaultMode: 'DEPLOY' },
    })
    .expect(201);
  assert.equal(deployDraft.body.data.source.commitSha, first);
  assert.equal(deployDraft.body.data.draft.definition.nodes.at(-1).type, 'DEPLOY');
  assert.equal(deployDraft.body.data.draft.definition.outputPath, undefined);
  assert.ok(deployDraft.body.data.missingFields.includes('dockerfilePath'));
  const beforeInvalidBranch = providerRequests.length;
  await operator
    .post('/api/v1/ai/repository-analysis')
    .send({ ...nodeDraftRequest, branch: 'missing' })
    .expect(400);
  assert.equal(providerRequests.length, beforeInvalidBranch);
  conflictingDraft = true;
  await operator.post('/api/v1/ai/repository-analysis').send(nodeDraftRequest).expect(502);
  conflictingDraft = false;
  assert.equal((await db.selectFrom('pipelines').select('id').execute()).length, 0);
  assert.equal((await db.selectFrom('tasks').select('id').execute()).length, 0);
  assert.deepEqual((await operator.get(`${metadataPath}/connection`).expect(200)).body.data, {
    ok: true,
    defaultBranch: 'main',
  });
  assert.deepEqual((await operator.get(`${metadataPath}/branches`).expect(200)).body.data, {
    defaultBranch: 'main',
    branches: [
      { name: 'feature/release', sha: feature },
      { name: 'main', sha: main },
    ],
  });
  const recent = await operator.get(`${metadataPath}/commits`).query({ limit: 2 }).expect(200);
  assert.equal(recent.body.data.branch, 'main');
  assert.deepEqual(
    recent.body.data.commits.map((entry: { sha: string }) => entry.sha),
    [main, second],
  );
  const selected = await operator
    .get(`${metadataPath}/commits`)
    .query({ branch: 'feature/release', limit: 1 })
    .expect(200);
  assert.equal(selected.body.data.branch, 'feature/release');
  assert.deepEqual(selected.body.data.commits, [
    {
      sha: feature,
      subject: 'Branch change with [REDACTED]',
      authoredAt: '2024-03-12T00:10:00.000Z',
      authorName: 'Fixture Author',
    },
  ]);
  assert.ok(fixture.authenticatedRequests() > 0);
  await operator
    .get(`${metadataPath}/commits`)
    .query({ branch: '--upload-pack=payload' })
    .expect(400);
  await operator.get(`${metadataPath}/commits`).query({ limit: 51 }).expect(400);
  const failure = await operator
    .get(`${metadataPath}/commits`)
    .query({ branch: 'absent' })
    .expect(502);
  assert.doesNotMatch(JSON.stringify(failure.body), /fixture-git-token|127\.0\.0\.1|fatal:/);
  const redirect = (
    await admin
      .post(repositoryPath)
      .send({
        name: 'Redirect fixture',
        cloneUrl: `${fixture.url}/redirect.git`,
        credentialId: credential,
      })
      .expect(201)
  ).body.data.id;
  await operator.get(`${repositoryPath}/${redirect}/connection`).expect(502);
  await git('init', '--bare', '--initial-branch=next', join(directory, 'empty.git'));
  const held = fixture.holdNextRequest();
  const lateProbe = operator
    .post(`${metadataPath}/branch-cache/refresh`)
    .expect(201)
    .then((response) => response.body.data);
  try {
    await Promise.race([
      held.started,
      lateProbe.then(() => {
        throw new Error('probe returned before Git request');
      }),
    ]);
    const empty = (
      await admin
        .patch(metadataPath)
        .send({ ...create, cloneUrl: `${fixture.url}/empty.git` })
        .expect(200)
    ).body.data;
    assert.equal(empty.branchSyncStatus, 'CURRENT');
    assert.equal(empty.defaultBranch, null);
    assert.equal(empty.branchCount, 0);
  } finally {
    held.release();
  }
  assert.deepEqual((await lateProbe).branches, []);
  const invalid = (
    await admin
      .patch(metadataPath)
      .send({ ...create, cloneUrl: `${fixture.url}/absent.git` })
      .expect(200)
  ).body.data;
  assert.equal(invalid.branchSyncStatus, 'ERROR');
  const invalidCache = (await operator.get(`${metadataPath}/branch-cache`).expect(200)).body.data;
  assert.deepEqual(invalidCache.branches, []);
  assert.equal(invalidCache.syncedAt, null);
  await admin.delete(`/api/v1/projects/${project}`).expect(200);
  await operator.get(`${metadataPath}/connection`).expect(404);
}

test('SQLite repository synchronization and authenticated smart HTTP metadata', (t) =>
  checkMetadata(t));
test(
  'PostgreSQL repository synchronization and authenticated smart HTTP metadata',
  {
    skip: !process.env.VEYOPS_TEST_POSTGRES_URL,
  },
  async (t) => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, async (url) => {
      await t.test('persists branch snapshots and recovers after failed probes', (context) =>
        checkMetadata(context, url),
      );
    });
  },
);
