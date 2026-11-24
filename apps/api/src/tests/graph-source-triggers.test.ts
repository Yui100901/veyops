import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { GraphCheckoutEvent } from '../modules/projects/repository-metadata.service';
import { withIsolatedPostgres } from './helpers/isolated-postgres';

const a = 'a'.repeat(40);
const b = 'b'.repeat(40);
const ref = 'refs/heads/main';
const cloneUrl = 'https://git.example.test/team/demo.git';

async function verify(t: TestContext, databaseUrl?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-graph-source-'));
  const password = randomBytes(24).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    ...(databaseUrl && { DATABASE_URL: databaseUrl }),
    DATABASE_PATH: join(dir, 'test.db'),
    DATA_DIR: dir,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: password,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { RepositoryMetadataService } =
    await import('../modules/projects/repository-metadata.service.js');
  const { GraphTriggersService } =
    await import('../modules/execution-graphs/graph-triggers.service.js');
  const { GraphRunnerService } =
    await import('../modules/execution-graphs/graph-runner.service.js');
  const { CredentialsService } = await import('../modules/credentials/credentials.service.js');
  const { AuditService } = await import('../modules/audit/audit.service.js');
  const { TaskHandlerRegistry } = await import('../modules/tasks/task-handler.registry.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false, rawBody: true });
  try {
    configureApp(app);
    await app.init();
    const api = request.agent(app.getHttpServer());
    const publicApi = request(app.getHttpServer());
    const prefix = '/api/v1';
    await api
      .post(prefix + '/auth/login')
      .send({ username: 'root', password })
      .expect(201);
    const database = app.get(DatabaseService);
    const metadata = app.get(RepositoryMetadataService);
    const make = async (path: string, body: unknown) =>
      (
        await api
          .post(path)
          .send(body as object)
          .expect(201)
      ).body.data;
    const project = await make(prefix + '/projects', {
      name: 'Source trigger',
      slug: 'source-trigger',
    });
    const scope = prefix + '/projects/' + project.id;
    t.mock.method(metadata, 'refreshBranches', async () => ({
      defaultBranch: 'main',
      branches: [{ name: 'main', sha: a }],
    }));
    const repository = await make(scope + '/repositories', { name: 'Demo source', cloneUrl });
    const secondary = await make(scope + '/repositories', {
      name: 'Secondary source',
      cloneUrl: 'https://git.example.test/team/secondary.git',
    });
    let head = a;
    let unavailable = false;
    t.mock.method(metadata, 'branchHeads', async () => {
      if (unavailable) return new Map();
      return new Map([['main', head]]);
    });
    const seen: { repositoryId: string; mode: string; requestedSha?: string }[] = [];
    t.mock.method(
      metadata,
      'planGraphCheckout',
      async (
        _projectId: string,
        input: {
          repositoryId: string;
          mode: string;
          branch?: string;
          commitSha?: string;
          event?: GraphCheckoutEvent;
        },
      ) => {
        const source = input.repositoryId === repository.id ? repository : secondary;
        const branch = input.mode === 'BRANCH' ? (input.branch ?? 'main') : undefined;
        const selectedRef = branch ? 'refs/heads/' + branch : input.commitSha;
        const event =
          input.event?.repositoryId === source.id && input.event?.ref === selectedRef
            ? input.event
            : undefined;
        seen.push({
          repositoryId: input.repositoryId,
          mode: input.mode,
          requestedSha: event?.commitSha ?? input.commitSha,
        });
        return {
          repositoryId: source.id,
          repositoryName: source.name,
          commitSha:
            event?.commitSha ??
            input.commitSha ??
            (source.id === repository.id ? head : 'c'.repeat(40)),
          ref: selectedRef,
          branch,
          ...(event && { eventPinned: true }),
          fullClone: false,
          access: { clone_url: source.cloneUrl, credential_id: null },
        };
      },
    );
    const graphPath = scope + '/execution-graph';
    const rules = graphPath + '/triggers';
    const graph = (await api.get(graphPath).expect(200)).body.data;
    const draft = (
      await api
        .put(graphPath + '/draft')
        .send({
          expectedRevision: graph.revision,
          definition: {
            canvas: {
              nodes: [
                {
                  id: 'flow',
                  type: 'START',
                  contract: 'PRESET',
                  name: '开始',
                  inputs: [
                    {
                      id: 'repository',
                      type: 'REPOSITORY',
                      name: '仓库',
                      defaultValue: repository.id,
                      runtimeOverride: false,
                    },
                    {
                      id: 'gitVersion',
                      type: 'GIT_REF',
                      name: '版本',
                      defaultValue: { kind: 'BRANCH', value: 'main' },
                      runtimeOverride: false,
                    },
                  ],
                },
                {
                  id: 'code',
                  type: 'CHECKOUT',
                  name: '主仓库',
                },
                {
                  id: 'other',
                  type: 'CHECKOUT',
                  name: '其他仓库',
                },
                { id: 'end', type: 'END', name: '结束' },
              ],
              edges: [
                { from: 'flow', to: 'code' },
                { from: 'code', to: 'other' },
                { from: 'other', to: 'end' },
              ],
              endpoints: [
                {
                  startId: 'flow',
                  endId: 'end',
                  inputBindings: {
                    other: {
                      repository: { kind: 'VALUE', value: secondary.id },
                      version: { kind: 'VALUE', value: { kind: 'BRANCH', value: 'main' } },
                    },
                  },
                },
              ],
              templates: [],
            },
          },
        })
        .expect(200)
    ).body.data;
    const draftHook = await make(rules, {
      kind: 'WEBHOOK',
      name: 'Draft receiver',
      flowId: 'flow',
      enabled: false,
      webhookProtocol: 'BEARER',
      repositoryId: repository.id,
      ref,
    });
    assert.match(draftHook.secret, /^[A-Za-z0-9_-]{40,}$/);
    const disabledTest = await publicApi
      .post(draftHook.receivePath + '/test')
      .set('Authorization', 'Bearer ' + draftHook.secret)
      .send({ eventId: 'unpublished-test', ref, commitSha: a })
      .expect(202);
    assert.equal(disabledTest.body.data.status, 'TESTED', JSON.stringify(disabledTest.body.data));
    assert.equal(disabledTest.body.data.runId, null);
    const version = (await make(graphPath + '/publish', { expectedRevision: draft.revision }))
      .publishedVersion;
    const common = {
      name: 'Watch source',
      flowId: 'flow',
      version,
      enabled: true,
      repositoryId: repository.id,
    };
    const poll = await make(rules, {
      ...common,
      kind: 'CRON',
      cronMode: 'POLL',
      cron: '* * * * *',
      timeZone: 'UTC',
    });
    const hooks = await make(rules, { ...common, kind: 'WEBHOOK', webhookProtocol: 'GITEA' });
    const generic = await make(rules, { ...common, kind: 'WEBHOOK', webhookProtocol: 'BEARER' });
    const registered = (await api.get(rules).expect(200)).body.data;
    assert.ok(!JSON.stringify(registered).includes(hooks.secret));
    assert.equal(registered.find(({ id }: { id: string }) => id === poll.id).resolvedRef, ref);
    const service = app.get(GraphTriggersService);
    const competitor = new GraphTriggersService(
      database,
      app.get(GraphRunnerService),
      app.get(CredentialsService),
      app.get(AuditService),
      app.get(TaskHandlerRegistry),
      metadata,
    );
    const pollNow = async () => {
      const now = Date.now();
      await database.db
        .updateTable('execution_graph_triggers')
        .set({ next_at: now - 1 })
        .where('id', '=', poll.id)
        .execute();
      // Concurrent workers initially read the same due rule and commit state.
      await Promise.all([service.tick(now), competitor.tick(now)]);
    };
    const events = async (id: string) =>
      (await api.get(rules + '/' + id + '/events').expect(200)).body.data;
    await pollNow();
    await pollNow();
    assert.deepEqual(await events(poll.id), []);
    unavailable = true;
    await pollNow();
    const failure = (await events(poll.id))[0];
    assert.equal(failure.status, 'REJECTED');
    const observed = (await api.get(rules).expect(200)).body.data.find(
      ({ id }: { id: string }) => id === poll.id,
    ).observation;
    assert.equal(observed.commitSha, a);
    assert.match(observed.error, /远端分支/);
    unavailable = false;
    head = b;
    await pollNow();
    const pollEvents = await events(poll.id);
    const changes = pollEvents.filter(({ status }: { status: string }) => status === 'QUEUED');
    assert.equal(changes.length, 1, JSON.stringify(pollEvents));
    assert.equal(changes[0].metadata.commitSha, b);
    assert.equal(changes[0].metadata.previousCommitSha, a);
    assert.ok(seen.some((item) => item.repositoryId === repository.id && item.requestedSha === b));
    assert.ok(!seen.some((item) => item.repositoryId === secondary.id && item.requestedSha === b));
    const delivered = (
      eventId: string,
      commitSha: string,
      pushRef = ref,
      repositoryUrl = cloneUrl,
      options: { test?: boolean; invalid?: boolean } = {},
    ) => {
      const raw = JSON.stringify({
        ref: pushRef,
        after: commitSha,
        repository: { full_name: 'team/demo', clone_url: repositoryUrl },
        commits: [{ message: 'large native payload ' + 'a'.repeat(140_000) }],
      });
      return publicApi
        .post(hooks.receivePath + (options.test ? '/test' : ''))
        .set('X-Gitea-Delivery', eventId)
        .set('X-Gitea-Event', 'push')
        .set(
          'X-Gitea-Signature',
          options.invalid
            ? 'a'.repeat(64)
            : createHmac('sha256', hooks.secret).update(raw).digest('hex'),
        )
        .type('json')
        .send(raw);
    };
    await delivered('bad-sig', b, ref, cloneUrl, { invalid: true }).expect(401);
    assert.equal(
      (await delivered('filter-ref', b, 'refs/heads/other').expect(202)).body.data.status,
      'IGNORED',
    );
    assert.equal(
      (
        await delivered('filter-repo', b, ref, 'https://git.example.test/team/other.git').expect(
          202,
        )
      ).body.data.status,
      'IGNORED',
    );
    assert.equal(
      (await delivered('delete-ref', '0'.repeat(40)).expect(202)).body.data.status,
      'IGNORED',
    );
    const tested = (await delivered('testing', b, ref, cloneUrl, { test: true }).expect(202)).body
      .data;
    assert.equal(tested.status, 'TESTED');
    assert.equal(tested.runId, null);
    const shared = (await delivered('poll-won', b).expect(202)).body.data;
    assert.equal(shared.duplicateOf, changes[0].id);
    assert.equal(shared.runId, changes[0].runId);
    assert.equal((await delivered('poll-won', b).expect(202)).body.data.id, shared.id);
    head = a;
    const pushed = (await delivered('rollback', a).expect(202)).body.data;
    assert.equal(pushed.status, 'PENDING');
    await service.tick();
    await pollNow();
    assert.equal(
      (await events(hooks.id)).find(({ id }: { id: string }) => id === pushed.id).status,
      'QUEUED',
    );
    assert.equal(
      (await events(poll.id)).filter(
        ({ duplicateOf }: { duplicateOf?: string }) => duplicateOf === pushed.id,
      ).length,
      1,
    );
    assert.equal((await delivered('poll-won', b).expect(202)).body.data.id, shared.id);
    assert.equal((await delivered('stale-after', b).expect(202)).body.data.status, 'IGNORED');
    const rotate = await make(rules + '/' + generic.id + '/rotate-secret', {});
    assert.notEqual(rotate.secret, generic.secret);
    const bearer = (token: string) =>
      publicApi
        .post(generic.receivePath)
        .set('Authorization', 'Bearer ' + token)
        .send({ eventId: 'generic-after-rotate', ref, commitSha: b });
    await bearer(generic.secret).expect(401);
    await publicApi
      .post(generic.receivePath)
      .set('Authorization', 'Bearer ' + rotate.secret)
      .send({ eventId: 'invalid-generic', ref, commitSha: 'bad' })
      .expect(400);
    head = b;
    const accepted = (await bearer(rotate.secret).expect(202)).body.data;
    assert.equal(accepted.status, 'PENDING');
    assert.equal((await bearer(rotate.secret).expect(202)).body.data.id, accepted.id);
    assert.ok(
      !(await events(hooks.id)).some(({ eventId }: { eventId: string }) => eventId === 'bad-sig'),
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('SQLite source triggers authenticate providers and observe each ref change once', (t) =>
  verify(t));
test(
  'PostgreSQL source triggers deduplicate a branch observation across workers and providers',
  { skip: !process.env.VEYOPS_TEST_POSTGRES_URL },
  (t) => withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, (url) => verify(t, url)),
);
