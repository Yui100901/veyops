import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { postgresTestUrl, withIsolatedPostgres } from './helpers/isolated-postgres';

async function checkReviews(databaseUrl?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-source-review-'));
  const bootstrapPassword = 'source-review-fixture-bootstrap';
  const password = 'source-review-fixture-password';
  Object.assign(process.env, {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    ...(databaseUrl && { DATABASE_URL: databaseUrl }),
    DATABASE_PATH: join(directory, 'review.db'),
    DATA_DIR: directory,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: bootstrapPassword,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { LegacyDeliveryWriteFixtureModule } =
    await import('./helpers/legacy-delivery-write-fixture.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { SourceReviewService } = await import('../modules/deployments/source-review.service.js');
  const module = await Test.createTestingModule({
    imports: [AppModule, LegacyDeliveryWriteFixtureModule],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  try {
    await app.init();
    const base = '/api/v1';
    const admin = request.agent(app.getHttpServer());
    const operator = request.agent(app.getHttpServer());
    const login = async (agent: typeof admin, username: string) => {
      await agent
        .post(base + '/auth/login')
        .send({ username, password: bootstrapPassword })
        .expect(201);
      await agent
        .post(base + '/auth/change-password')
        .send({ currentPassword: bootstrapPassword, newPassword: password })
        .expect(200);
      await agent
        .post(base + '/auth/login')
        .send({ username, password })
        .expect(201);
    };
    await login(admin, 'root');
    const create = async (path: string, body: object) =>
      (
        await admin
          .post(base + path)
          .send(body)
          .expect(201)
      ).body.data;
    await create('/users', {
      username: 'test-operator',
      password: bootstrapPassword,
      role: 'OPERATOR',
    });
    await login(operator, 'test-operator');

    const project = await create('/projects', {
      name: 'Reviewed releases',
      slug: 'reviewed-release',
    });
    const foreignProject = await create('/projects', {
      name: 'Another project',
      slug: 'another-project',
    });
    const service = await create('/projects/' + project.id + '/services', {
      name: 'API',
      slug: 'api',
    });
    const environment = await create('/projects/' + project.id + '/environments', {
      name: 'Production',
      slug: 'prod',
    });
    const staging = await create('/projects/' + project.id + '/environments', {
      name: 'Staging',
      slug: 'staging',
    });
    const credentials = await create('/credentials', {
      name: 'Release target SSH',
      type: 'SSH_PASSWORD',
      secret: { password: 'fixture-ssh-password' },
    });
    const server = await create('/servers', {
      name: 'Release target',
      host: '127.0.0.1',
      username: 'fixture',
      credentialId: credentials.id,
      hostKeyFingerprint: 'a'.repeat(64),
    });
    const reviews = app.get(SourceReviewService);
    const db = app.get(DatabaseService).db;
    const sha = 'b'.repeat(40);
    const otherSha = 'c'.repeat(40);
    const repository = async (projectId: string, name: string) => {
      const id = randomUUID();
      await db
        .insertInto('repositories')
        .values({
          id,
          project_id: projectId,
          name,
          clone_url: 'https://example.test/' + id,
          created_at: Date.now(),
          updated_at: Date.now(),
        })
        .execute();
      return id;
    };
    const repoA = await repository(project.id, 'Primary repository');
    const foreign = await repository(foreignProject.id, 'Foreign repository');
    const source = [{ repositoryId: repoA, commitSha: sha }];
    const reviewUrl =
      base +
      '/projects/' +
      project.id +
      '/services/' +
      service.id +
      '/environments/' +
      environment.id +
      '/source-reviews';
    const approval = { decision: 'APPROVED', reason: 'Reviewed exact revision' };

    assert.equal(
      await reviews.requireReviewed(project.id, service.id, environment.id, source),
      null,
    );
    const configUrl =
      base + '/services/' + service.id + '/environments/' + environment.id + '/config';
    const config = (
      await admin
        .put(configUrl)
        .send({
          serverIds: [server.id],
          releasePolicy: { requireCodeReview: true },
        })
        .expect(200)
    ).body.data;
    assert.equal(config.releasePolicy.requireCodeReview, true);
    assert.equal(config.releasePolicy.requireApproval, false);
    const legacyId = randomUUID();
    const root = await db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('service_source_reviews')
      .values({
        id: legacyId,
        project_id: project.id,
        service_id: service.id,
        environment_id: environment.id,
        commit_sha: sha,
        decision: 'APPROVED',
        reason: 'Legacy approval retained for history',
        reviewed_by: root.id,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, source),
      /Primary repository.*缺少当前服务环境的有效代码审核/,
    );
    await operator
      .put(reviewUrl + '/' + sha)
      .send(approval)
      .expect(403);
    await operator
      .put(configUrl)
      .send({ serverIds: [server.id], releasePolicy: { requireCodeReview: false } })
      .expect(403);
    await admin
      .put(reviewUrl.replace(project.id, foreignProject.id) + '/' + sha)
      .send(approval)
      .expect(404);
    await admin
      .put(reviewUrl + '/' + sha)
      .send({ ...approval, repositoryId: foreign })
      .expect(404);
    await admin
      .put(reviewUrl + '/abc')
      .send(approval)
      .expect(400);
    await admin
      .put(reviewUrl + '/' + '0'.repeat(40))
      .send(approval)
      .expect(400);
    await admin
      .put(reviewUrl + '/' + sha)
      .send({ ...approval, reason: 'password=not-for-logs' })
      .expect(400);

    const approved = (
      await admin
        .put(reviewUrl + '/' + sha.toUpperCase())
        .send(approval)
        .expect(200)
    ).body.data;
    assert.equal(approved.commitSha, sha);
    assert.equal(approved.decision, 'APPROVED');
    assert.equal(approved.reviewer, 'root');
    assert.equal(approved.repositoryId, repoA);
    assert.equal(approved.repositoryName, 'Primary repository');
    assert.equal(
      (await reviews.requireReviewed(project.id, service.id, environment.id, source))?.[0]
        ?.reviewId,
      approved.id,
    );
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, [
        { repositoryId: repoA, commitSha: otherSha },
      ]),
      /有效代码审核/,
    );
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, staging.id, source, { force: true }),
      /有效代码审核/,
    );
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, [
        { repositoryId: repoA, commitSha: '0'.repeat(40) },
      ]),
      /缺少完整 Git 提交/,
    );
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, [
        { repositoryId: foreign, commitSha: sha },
      ]),
      /仓库不属于当前项目/,
    );
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, []),
      /缺少可核验的仓库/,
    );
    const legacyRows = (await operator.get(reviewUrl + '?commitSha=' + sha).expect(200)).body.data;
    assert.equal(legacyRows.find((row: typeof approved) => row.id === legacyId).repositoryId, null);
    const rows = (
      await operator.get(reviewUrl + '?commitSha=' + sha + '&repositoryId=' + repoA).expect(200)
    ).body.data;
    assert.deepEqual(
      rows.map((row: typeof approved) => row.id),
      [approved.id],
    );
    const repoB = await repository(project.id, 'Actual dependency');
    const combined = [...source, { repositoryId: repoB, commitSha: sha }];
    await admin
      .put(reviewUrl + '/' + sha)
      .send(approval)
      .expect(400);
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, combined),
      /Actual dependency.*缺少当前服务环境的有效代码审核/,
    );
    const dependency = (
      await admin
        .put(reviewUrl + '/' + sha)
        .send({ ...approval, repositoryId: repoB })
        .expect(200)
    ).body.data;
    assert.notEqual(dependency.id, approved.id);
    const both = await reviews.requireReviewed(project.id, service.id, environment.id, combined);
    assert.deepEqual(
      new Set(both?.map(({ repositoryId }) => repositoryId)),
      new Set([repoA, repoB]),
    );

    await db.updateTable('users').set({ role: 'OPERATOR' }).where('id', '=', root.id).execute();
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, combined),
      /有效代码审核/,
    );
    await db.updateTable('users').set({ role: 'ADMIN' }).where('id', '=', root.id).execute();

    const revoked = (
      await admin
        .put(reviewUrl + '/' + sha)
        .send({ repositoryId: repoA, decision: 'REVOKED', reason: 'Review invalidated' })
        .expect(200)
    ).body.data;
    assert.equal(revoked.id, approved.id);
    assert.equal(revoked.decision, 'REVOKED');
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, combined),
      /Primary repository.*缺少当前服务环境的有效代码审核/,
    );
    const audited = await app
      .get(DatabaseService)
      .db.selectFrom('audit_logs')
      .select(['action', 'details_json', 'user_id'])
      .where('resource_id', '=', approved.id)
      .execute();
    assert.deepEqual(audited.map((row) => row.action).sort(), [
      'source-review.approved',
      'source-review.revoked',
    ]);
    for (const row of audited) {
      assert.equal(row.user_id, approved.reviewedBy);
      const detail = JSON.parse(row.details_json);
      assert.deepEqual(
        [
          detail.projectId,
          detail.serviceId,
          detail.environmentId,
          detail.repositoryId,
          detail.commitSha,
        ],
        [project.id, service.id, environment.id, repoA, sha],
      );
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite source reviews verify every repository and commit in the service environment', () =>
  checkReviews());
test(
  'PostgreSQL source reviews preserve scope checks, revocation and admin auditing',
  { skip: !postgresTestUrl },
  () => withIsolatedPostgres(postgresTestUrl!, checkReviews),
);
