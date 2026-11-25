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
import { replaceVariables } from './helpers/variable-scope';

async function checkMigration(url?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-graph-migration-'));
  const initial = randomBytes(18).toString('hex');
  const password = randomBytes(18).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: url ? 'postgres' : 'sqlite',
    ...(url && { DATABASE_URL: url }),
    DATABASE_PATH: join(dir, 'test.db'),
    DATA_DIR: dir,
    ADMIN_PASSWORD: initial,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { LegacyDeliveryWriteFixtureModule } =
    await import('./helpers/legacy-delivery-write-fixture.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { GraphTriggersService } =
    await import('../modules/execution-graphs/graph-triggers.service.js');
  const app = (
    await Test.createTestingModule({
      imports: [AppModule, LegacyDeliveryWriteFixtureModule],
    }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false });
  try {
    configureApp(app);
    await app.init();
    const db = app.get(DatabaseService).db;
    const triggers = app.get(GraphTriggersService);
    const client = request.agent(app.getHttpServer());
    const api = '/api/v1';
    const post = (path: string, body: object) => client.post(api + path).send(body);
    const get = async (path: string) => (await client.get(api + path).expect(200)).body.data;
    const make = async (path: string, body: object) =>
      (await post(path, body).expect(201)).body.data;
    await make('/auth/login', { username: 'root', password: initial });
    await post('/auth/change-password', { currentPassword: initial, newPassword: password }).expect(
      200,
    );
    const user = await make('/auth/login', { username: 'root', password });
    const project = (slug: string) => make('/projects', { name: slug, slug });

    const absent = await project('missing-migration-graph');
    await db.deleteFrom('execution_graphs').where('project_id', '=', absent.id).execute();
    const absentPath = `/projects/${absent.id}/execution-graph`;
    const absentPlan = await get(absentPath + '/migration');
    assert.equal(absentPlan.status, 'MISSING');
    await client.get(api + absentPath).expect(404);
    const repair = { planHash: absentPlan.planHash, acknowledgements: [] };
    const seeded = await make(absentPath + '/migration/stage', repair);
    assert.equal(seeded.changed, true);
    assert.deepEqual(await make(absentPath + '/migration/stage', repair), {
      graphId: seeded.graphId,
      revision: 1,
      changed: false,
    });
    assert.equal((await get(absentPath)).id, seeded.graphId);

    const testProject = await project('legacy-start-migration');
    const scope = '/projects/' + testProject.id;
    const graphPath = scope + '/execution-graph';
    const migrationPath = graphPath + '/migration';
    const service = await make(scope + '/services', {
      name: 'Legacy service',
      slug: 'legacy-service',
    });
    const environment = await make(scope + '/environments', {
      name: 'Legacy environment',
      slug: 'legacy-environment',
      repositoryEnvFile: '.env.test',
    });
    const graph = await get(graphPath);
    const admin = await db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    assert.ok(user);
    const repositoryId = randomUUID();
    const now = Date.now();
    await db
      .insertInto('repositories')
      .values({
        id: repositoryId,
        project_id: testProject.id,
        name: 'Recorded source',
        clone_url: 'http://127.0.0.1:1/fixture.git',
        default_branch: 'main',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const credential = await make('/credentials', {
      name: 'Migration SSH',
      type: 'SSH_PASSWORD',
      secret: { password: randomUUID() },
    });
    const server = await make('/servers', {
      name: 'Migration host',
      host: '127.0.0.1',
      username: 'fixture',
      credentialId: credential.id,
      hostKeyFingerprint: 'a'.repeat(64),
    });
    const oldTargetId = randomUUID();
    await db
      .insertInto('deployment_targets')
      .values({
        id: oldTargetId,
        name: 'Legacy selection',
        strategy: 'SEQUENTIAL',
        max_parallel: 1,
        failure_policy: 'STOP',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('deployment_target_servers')
      .values({
        target_id: oldTargetId,
        server_id: server.id,
        sort_order: 0,
      })
      .execute();
    const secret = randomBytes(21).toString('hex');
    await replaceVariables(client, api + scope + '/variables', [
      { key: 'SENSITIVE_FIXTURE', value: secret, isSecret: true },
    ]);
    await db
      .insertInto('service_environment_configs')
      .values({
        id: randomUUID(),
        service_id: service.id,
        environment_id: environment.id,
        target_id: oldTargetId,
        artifact_type: 'FILE',
        deploy_path: '/srv/veyops-fixture',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const commitSha = 'a'.repeat(40);
    const classicPipelineId = randomUUID();
    await db
      .insertInto('pipelines')
      .values({
        id: classicPipelineId,
        project_id: testProject.id,
        service_id: service.id,
        name: 'Legacy Pipeline',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('pipeline_webhooks')
      .values({
        pipeline_id: classicPipelineId,
        pipeline_version: 1,
        environment_id: environment.id,
        target_id: oldTargetId,
        configuration_hash: 'a'.repeat(64),
        secret_credential_id: credential.id,
        created_by: admin.id,
        branch: 'main',
        repository_key: 'fixture',
        enabled: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const artifactId = randomUUID();
    await db
      .insertInto('artifacts')
      .values({
        id: artifactId,
        project_id: testProject.id,
        service_id: service.id,
        artifact_type: 'FILE',
        storage_type: 'LOCAL_FILE',
        storage_key: 'fixture-archive.tgz',
        source_commit: commitSha,
        created_at: now,
      })
      .execute();
    const def = {
      flows: [
        {
          id: 'delivery',
          name: 'Legacy delivery',
          nodes: [
            {
              id: 'start',
              name: 'Legacy delivery',
              type: 'START',
              delivery: {
                kind: 'BUILD_DEPLOY',
                serviceId: service.id,
                build: {
                  repositoryId,
                  buildLocation: 'MANAGER',
                  artifactType: 'FILE',
                  commitSha,
                  buildCommand: 'npm run build',
                  outputPath: 'dist',
                },
                deploy: { deployPath: '/srv/veyops-fixture', startCommand: 'true' },
              },
            },
            { id: 'build', name: 'Build', type: 'BUILD' },
            { id: 'release', name: 'Deploy', type: 'DEPLOY_ARTIFACT' },
            { id: 'end', name: 'End', type: 'END' },
          ],
          edges: [
            { from: 'start', to: 'build' },
            { from: 'build', to: 'release' },
            { from: 'release', to: 'end' },
          ],
        },
        {
          id: 'operations',
          name: 'Approval operations',
          nodes: [
            { id: 'operations', name: 'Operations', type: 'START' },
            { id: 'wait', name: 'Review', type: 'APPROVAL', approval: { timeoutSeconds: 3600 } },
            { id: 'operations-end', name: 'End', type: 'END' },
          ],
          edges: [
            { from: 'operations', to: 'wait' },
            { from: 'wait', to: 'operations-end' },
          ],
        },
      ],
    };
    const legacyJson = JSON.stringify(def);
    await db
      .updateTable('execution_graphs')
      .set({ draft_json: legacyJson, published_version: 1 })
      .where('id', '=', graph.id)
      .execute();
    const originalVersionId = randomUUID();
    await db
      .insertInto('execution_graph_versions')
      .values({
        id: originalVersionId,
        graph_id: graph.id,
        version: 1,
        source_revision: graph.revision,
        definition_json: legacyJson,
        created_at: now,
        created_by: admin.id,
      })
      .execute();
    await db
      .insertInto('service_source_reviews')
      .values({
        id: randomUUID(),
        project_id: testProject.id,
        service_id: service.id,
        environment_id: environment.id,
        commit_sha: commitSha,
        decision: 'APPROVED',
        reason: null,
        reviewed_by: admin.id,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const rule = await make(graphPath + '/triggers', {
      name: 'Original automation',
      kind: 'API',
      flowId: 'operations',
      version: 1,
      enabled: true,
    });
    const triggerPath = `${graphPath}/triggers/${rule.id}`;
    const fire = async (eventId: string) =>
      (await post(triggerPath + '/invoke', { eventId }).expect(202)).body.data;
    const queued = await fire('before-migration');
    await triggers.tick();
    const dispatched = (await get(triggerPath + '/events')).find(
      ({ id }: { id: string }) => id === queued.id,
    );
    assert.ok(dispatched.runId);
    const oldRun = await get(graphPath + '/runs/' + dispatched.runId);
    assert.equal(oldRun.version, 1);
    assert.equal(oldRun.status, 'WAITING');

    const comparison = { environmentId: environment.id, commitSha };
    const plan = await make(migrationPath + '/preview', comparison);
    assert.equal(plan.status, 'LEGACY_DRAFT');
    assert.equal(plan.legacyReviewCount, 1);
    assert.equal(plan.artifactCount, 1);
    assert.equal(plan.legacyPipelines[0].id, classicPipelineId);
    assert.equal(plan.legacyPipelines[0].webhookEnabled, true);
    assert.equal(plan.versions[0].pendingRuns, 1);
    assert.equal(plan.legacyTargets[0].id, oldTargetId);
    assert.deepEqual(plan.comparison[0].before.serverIds, [server.id]);
    assert.deepEqual(plan.comparison[0].after.serverIds, [server.id]);
    assert.equal(plan.comparison[0].after.repositoryId, repositoryId);
    assert.equal(plan.comparison[0].after.commitSha, commitSha);
    assert.equal(
      plan.issues.some(({ blocking }: { blocking: boolean }) => blocking),
      false,
      JSON.stringify(plan.issues),
    );
    assert.equal(JSON.stringify(plan).includes(secret), false);
    assert.equal(JSON.stringify(plan).includes('npm run build'), false);
    await post(migrationPath + '/stage', {
      comparison,
      planHash: 'f'.repeat(64),
      acknowledgements: [],
    }).expect(409);
    const stage = {
      comparison,
      planHash: plan.planHash,
      acknowledgements: plan.issues.map(({ id }: { id: string }) => id),
    };
    const staged = await make(migrationPath + '/stage', stage);
    assert.equal(staged.changed, true);
    assert.equal(staged.graphId, graph.id);
    assert.equal((await make(migrationPath + '/stage', stage)).changed, false);
    const version1 = await get(graphPath + '/versions/1');
    assert.equal(JSON.stringify(version1.definition), legacyJson);
    const published = await make(graphPath + '/publish', { expectedRevision: staged.revision });
    assert.equal(published.publishedVersion, 2);
    const beforeSwitch = await get(migrationPath);
    await fire('during-migration');
    const switchInput = {
      planHash: beforeSwitch.planHash,
      targetVersion: 2,
      triggerIds: [rule.id],
      confirmed: true,
    };
    await post(migrationPath + '/cutover', switchInput).expect(409);
    await triggers.tick();
    await post(migrationPath + '/cutover', {
      ...switchInput,
      planHash: (await get(migrationPath)).planHash,
    }).expect(409);
    await db
      .updateTable('pipeline_webhooks')
      .set({ enabled: 0 })
      .where('pipeline_id', '=', classicPipelineId)
      .execute();
    const result = await make(migrationPath + '/cutover', {
      ...switchInput,
      planHash: (await get(migrationPath)).planHash,
    });
    assert.deepEqual(result.triggers, [{ id: rule.id, previousVersion: 1 }]);
    assert.equal((await fire('before-migration')).id, queued.id);
    const next = await fire('after-migration');
    await triggers.tick();
    const newer = (await get(triggerPath + '/events')).find(
      ({ id }: { id: string }) => id === next.id,
    );
    assert.equal((await get(graphPath + '/runs/' + newer.runId)).version, 2);
    const restored = await make(migrationPath + '/restore', {
      cutoverId: result.id,
      confirmed: true,
    });
    assert.deepEqual(restored.suspendedTriggerIds, []);
    assert.equal(
      (await get(graphPath + '/triggers')).find(({ id }: { id: string }) => id === rule.id).version,
      1,
    );
    assert.equal((await fire('after-migration')).id, next.id);
    assert.equal((await get(graphPath + '/runs/' + dispatched.runId)).status, 'WAITING');
    const restoredAudit = await make(migrationPath + '/restore', {
      cutoverId: result.id,
      confirmed: true,
    });
    assert.deepEqual(restoredAudit, restored);
    assert.equal((await get(migrationPath)).lastCutover.restored, true);
    assert.equal(
      (await get('/artifacts?projectId=' + testProject.id + '&recordId=' + artifactId))[0].id,
      artifactId,
    );
    await make(graphPath + '/runs/' + dispatched.runId + '/nodes/wait/decision', {
      decision: 'APPROVE',
    });
    assert.equal((await get(graphPath + '/runs/' + dispatched.runId)).status, 'SUCCESS');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('SQLite staged graph migration preserves original snapshots and trigger event idempotency', () =>
  checkMigration());
test(
  'PostgreSQL staged graph migration preserves original snapshots and trigger event idempotency',
  { skip: !postgresTestUrl },
  () => withIsolatedPostgres(postgresTestUrl!, checkMigration),
);
