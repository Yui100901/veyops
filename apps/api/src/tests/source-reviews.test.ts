import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { SourceReviewService } = await import('../modules/deployments/source-review.service.js');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    const sha = 'b'.repeat(40);
    const otherSha = 'c'.repeat(40);
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

    assert.equal(await reviews.requireReviewed(project.id, service.id, environment.id, sha), null);
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
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, sha),
      /尚未通过/,
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
    assert.equal(
      (await reviews.requireReviewed(project.id, service.id, environment.id, sha))?.id,
      approved.id,
    );
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, otherSha),
      /尚未通过/,
    );
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, staging.id, sha, { force: true }),
      /尚未通过/,
    );
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, '0'.repeat(40)),
      /必须关联实际 Git 提交/,
    );
    const rows = (await operator.get(reviewUrl + '?commitSha=' + sha).expect(200)).body.data;
    assert.deepEqual(
      rows.map((row: typeof approved) => row.id),
      [approved.id],
    );

    const revoked = (
      await admin
        .put(reviewUrl + '/' + sha)
        .send({ decision: 'REVOKED', reason: 'Review invalidated' })
        .expect(200)
    ).body.data;
    assert.equal(revoked.id, approved.id);
    assert.equal(revoked.decision, 'REVOKED');
    await assert.rejects(
      reviews.requireReviewed(project.id, service.id, environment.id, sha),
      /尚未通过/,
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
        [detail.projectId, detail.serviceId, detail.environmentId, detail.commitSha],
        [project.id, service.id, environment.id, sha],
      );
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('SQLite source reviews bind decisions and auditing to the exact commit and service environment', () =>
  checkReviews());
test(
  'PostgreSQL source reviews preserve scope checks, revocation and admin auditing',
  { skip: !postgresTestUrl },
  () => withIsolatedPostgres(postgresTestUrl!, checkReviews),
);
