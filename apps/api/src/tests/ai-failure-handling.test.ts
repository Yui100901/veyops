import 'reflect-metadata';
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PipelineSnapshot } from '../modules/pipelines/pipeline.types';
import type { TaskExecutionContext, TaskRecord } from '../modules/tasks/tasks.types';
import type { SshOptions } from '../infrastructure/ssh/ssh.service';

const postgresUrl = process.env.VEYOPS_TEST_POSTGRES_URL;
let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'veyops-failure-'));
  process.env.DATA_DIR = dir;
});
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function verifyFailures(liveKey?: string, databaseUrl?: string) {
  Object.assign(process.env, {
    DATABASE_CLIENT: databaseUrl ? 'postgres' : 'sqlite',
    ...(databaseUrl && { DATABASE_URL: databaseUrl }),
    DATABASE_PATH: join(dir, randomUUID() + '.db'),
    ADMIN_PASSWORD: 'failure-fixture-password',
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    WORKER_ENABLED: 'false',
    AI_PIPELINE_ANALYSIS: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const { TasksService } = await import('../modules/tasks/tasks.service.js');
  const { PipelineExecutor } = await import('../modules/pipelines/pipeline-executor.service.js');
  const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
  const { AiFailureHandlingService } = await import('../modules/ai/ai-failure-handling.service.js');
  const { deploymentProbe } = await import('../modules/ai/ai-deployment-tools.service.js');
  const sent: string[] = [];
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    sent.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: '请核查已分类的失败阶段。',
                failedPhase: null,
                nextActions: [],
              }),
            },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  let sourceError = '';
  let failVerification = false;
  let completeProbe = true;
  let afterPrecheck: (() => Promise<void>) | undefined;
  const remote: string[] = [];
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PipelineExecutor)
    .useValue({
      execute: async (task: TaskRecord, ctx: TaskExecutionContext) => {
        const serverId = task.payload.targets[0]!.id;
        const target = await ctx.startTarget(serverId);
        const step = await ctx.startStep(
          target,
          serverId,
          { key: 'BUILD', name: '隔离故障测试', command: '' },
          0,
        );
        ctx.log('secret-fixture-marker ' + sourceError + '\n', serverId);
        const exitCode = sourceError.includes('not found') ? 127 : 1;
        await ctx.finishStep(step, 'FAILED', exitCode, sourceError);
        await ctx.finishTarget(target, 'FAILED', exitCode, sourceError);
      },
    })
    .overrideProvider(SshService)
    .useValue({
      execute: async (_target: unknown, command: string, options: SshOptions) => {
        remote.push(command);
        if (afterPrecheck && command.includes('test "$(id -u)" -eq 0 && command -v apt-get')) {
          const revoke = afterPrecheck;
          afterPrecheck = undefined;
          await revoke();
        }
        if (command === deploymentProbe)
          options.onData?.(
            'uid=0\nos=debian\napt-get=available\n' + (completeProbe ? 'probeComplete=1\n' : ''),
            'stdout',
          );
        return {
          exitCode: failVerification && command.includes('node --version && npm --version') ? 1 : 0,
        };
      },
    })
    .compile();
  const app = module.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    await api
      .post('/api/v1/auth/login')
      .send({ username: 'root', password: process.env.ADMIN_PASSWORD })
      .expect(201);
    const password = 'changed-fixture-password';
    await api
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: process.env.ADMIN_PASSWORD, newPassword: password })
      .expect(200);
    await api.post('/api/v1/auth/login').send({ username: 'root', password }).expect(201);
    const db = app.get(DatabaseService).db;
    const worker = app.get(TaskWorkerService);
    const tasks = app.get(TasksService);
    const handling = app.get(AiFailureHandlingService);
    const { id: userId } = await db
      .selectFrom('users')
      .select('id')
      .where('username', '=', 'root')
      .executeTakeFirstOrThrow();
    const projectId = randomUUID(),
      serviceId = randomUUID(),
      environmentId = randomUUID(),
      repositoryId = randomUUID();
    const times = { created_at: Date.now(), updated_at: Date.now() };
    await db
      .insertInto('projects')
      .values({
        id: projectId,
        name: '故障验收',
        slug: 'failure-fixture',
        created_by: userId,
        ...times,
      })
      .execute();
    await db
      .insertInto('services')
      .values({ id: serviceId, project_id: projectId, name: 'demo', slug: 'demo', ...times })
      .execute();
    await db
      .insertInto('environments')
      .values({
        id: environmentId,
        project_id: projectId,
        name: 'fixture',
        slug: 'fixture',
        ...times,
      })
      .execute();
    await db
      .insertInto('repositories')
      .values({
        id: repositoryId,
        project_id: projectId,
        name: 'fixture',
        clone_url: 'https://fixture.invalid/app.git',
        ...times,
      })
      .execute();
    const address = http.address();
    assert.ok(address && typeof address === 'object');
    const provider = (
      await api
        .post('/api/v1/ai/providers')
        .send({
          name: 'failure fixture',
          baseUrl: liveKey ? 'https://api.deepseek.com' : 'http://127.0.0.1:' + address.port,
          apiKey: liveKey ?? 'test-fixture-key',
          model: 'deepseek-flash',
          enabled: true,
          timeoutSeconds: 15,
        })
        .expect(201)
    ).body.data.id;
    const credential = (
      await api
        .post('/api/v1/credentials')
        .send({ name: 'fixture', type: 'SSH_PASSWORD', secret: { password: 'fixture' } })
        .expect(201)
    ).body.data.id;
    const host = (
      await api
        .post('/api/v1/servers')
        .send({
          name: '模拟目标',
          host: '127.0.0.1',
          username: 'fixture',
          credentialId: credential,
          hostKeyFingerprint: '0'.repeat(64),
        })
        .expect(201)
    ).body.data;
    await db
      .insertInto('service_environment_configs')
      .values({
        id: randomUUID(),
        service_id: serviceId,
        environment_id: environmentId,
        target_selection_json: JSON.stringify({
          serverIds: [host.id],
          groupIds: [],
          strategy: 'SEQUENTIAL',
          maxParallel: 1,
          failurePolicy: 'STOP',
        }),
        ...times,
      })
      .execute();
    const path =
      '/api/v1/ai/services/' + serviceId + '/environments/' + environmentId + '/failure-handling';
    const configure = async (enabled: boolean) =>
      api.patch(path).send({ enabled, component: 'node' }).expect(200);
    const policy = async (mode: string) =>
      api
        .patch('/api/v1/ai/policies')
        .send({ mode, serverIds: [host.id] })
        .expect(200);
    const incident = async (taskId: string) =>
      db
        .selectFrom('ai_failure_incidents')
        .selectAll()
        .where('task_id', '=', taskId)
        .executeTakeFirstOrThrow();
    const run = async (error: string, location = 'TARGET', mode = 'BUILD_ONLY') => {
      sourceError = error;
      const task = await tasks.create(
        {
          type: 'PIPELINE',
          name: '故障夹具',
          scope: { projectId, serviceId, environmentId },
          payload: {
            targets: [host],
            steps: [],
            strategy: 'SEQUENTIAL',
            maxParallel: 1,
            failurePolicy: 'STOP',
            timeout: 60,
            pipeline: {
              mode,
              projectId,
              serviceId,
              environmentId,
              definition: { repositoryId, buildLocation: location },
            } as PipelineSnapshot,
          },
        },
        userId,
      );
      await worker.tick();
      for (let i = 0; i < 300 && (await tasks.get(task.id)).status !== 'FAILED'; i++)
        await sleep(25);
      assert.equal((await tasks.get(task.id)).status, 'FAILED');
      return task.id;
    };
    const result = await api.get(path).expect(200);
    assert.equal(result.body.data.enabled, false);
    assert.equal(result.body.data.component, null);
    await run('npm: command not found');
    assert.equal((await api.get(path)).body.data.incidents.length, 0);
    await configure(true);
    await policy('READ_ONLY');
    for (const [error, code, mode] of [
      ['npm: command not found', 'MISSING_TOOL', 'BUILD_ONLY'],
      ['EAI_AGAIN', 'DOWNLOAD', 'BUILD_ONLY'],
      ['EADDRINUSE', 'PORT_OCCUPIED', 'DEPLOY_ARTIFACT'],
    ]) {
      const id = await run(error!, 'TARGET', mode);
      await db.transaction().execute((tx) => handling.completion(tx, id, Date.now()));
      await Promise.all([handling.tick(), handling.tick()]);
      const row = await incident(id);
      assert.equal(row.status, 'ADVICE', row.summary);
      assert.equal(JSON.parse(row.findings_json)[0].code, code);
      assert.equal(row.proposal_id, null);
      assert.ok(row.summary);
      assert.equal((await api.get(path).query({ taskId: id })).body.data.incidents.length, 1);
      assert.equal(
        (
          await db
            .selectFrom('notification_events')
            .select('id')
            .where('task_id', '=', id)
            .execute()
        ).length,
        1,
      );
    }
    assert.equal(remote.length, 0);
    await policy('CONFIRM');
    const approveId = await run('npm: command not found');
    await handling.tick();
    const proposal = (await incident(approveId)).proposal_id;
    assert.ok(proposal, (await incident(approveId)).summary);
    assert.equal(
      (await api.get(path).query({ taskId: approveId })).body.data.incidents[0].canApprove,
      true,
    );
    const confirm = '/api/v1/ai/proposals/' + proposal + '/confirm';
    await api.post(confirm).expect(201);
    await api.post(confirm).expect(409);
    async function settle(id: string, expected: string) {
      await worker.tick();
      for (let i = 0; i < 300 && (await incident(id)).status === 'REPAIRING'; i++) await sleep(25);
      const row = await incident(id);
      assert.equal(row.status, expected, row.summary);
      assert.ok(row.repair_task_id);
      return row.repair_task_id;
    }
    await settle(approveId, 'VERIFIED');
    assert.ok(remote.some((command) => command.includes('node --version && npm --version')));
    await policy('FULL_CONTROL');
    const full = await run('npm: command not found');
    await handling.tick();
    assert.equal((await incident(full)).status, 'REPAIRING', (await incident(full)).summary);
    await settle(full, 'VERIFIED');
    if (liveKey) return;
    completeProbe = false;
    const truncated = await run('npm: command not found');
    await handling.tick();
    assert.equal((await incident(truncated)).status, 'MANUAL');
    assert.equal((await incident(truncated)).proposal_id, null);
    completeProbe = true;
    assert.ok(sent.some((body) => body.includes('PORT_OCCUPIED')));
    assert.ok(
      sent.every((body) => !body.includes('secret-fixture-marker') && !body.includes(host.id)),
    );
    assert.ok(sent.every((body) => !body.includes('npm: command not found')));
    const manager = await run('npm: command not found', 'MANAGER');
    await handling.tick();
    assert.equal((await incident(manager)).status, 'ADVICE');
    await policy('CONFIRM');
    const revoked = await run('npm: command not found');
    await handling.tick();
    const revokedProposal = (await incident(revoked)).proposal_id!;
    await configure(true);
    assert.equal((await incident(revoked)).status, 'AWAITING_APPROVAL');
    const extra = (
      await api
        .post('/api/v1/servers')
        .send({
          name: '新组成员',
          host: '127.0.0.2',
          username: 'fixture',
          credentialId: credential,
          hostKeyFingerprint: '1'.repeat(64),
        })
        .expect(201)
    ).body.data.id;
    const group = (
      await api
        .post('/api/v1/server-groups')
        .send({ name: '成员已改变', serverIds: [host.id, extra] })
        .expect(201)
    ).body.data.id;
    const changeTargets = (serverIds: string[], groupIds: string[]) =>
      db
        .updateTable('service_environment_configs')
        .set({
          target_selection_json: JSON.stringify({
            serverIds,
            groupIds,
            strategy: 'SEQUENTIAL',
            maxParallel: 1,
            failurePolicy: 'STOP',
          }),
        })
        .where('service_id', '=', serviceId)
        .execute();
    await changeTargets([], [group]);
    assert.equal(
      (await api.get(path).query({ taskId: revoked })).body.data.incidents[0].canApprove,
      false,
    );
    await api.post('/api/v1/ai/proposals/' + revokedProposal + '/confirm').expect(409);
    await changeTargets([host.id], []);
    for (const restriction of [
      { deniedActions: ['diagnose_deployment'] },
      { projectIds: [randomUUID()] },
      { serverIds: [extra] },
      { repositoryIds: [randomUUID()] },
    ]) {
      await api
        .patch('/api/v1/ai/policies')
        .send({ mode: 'CONFIRM', ...restriction })
        .expect(200);
      assert.deepEqual((await api.get(path).query({ taskId: revoked })).body.data.incidents, []);
      await api.post('/api/v1/ai/proposals/' + revokedProposal + '/confirm').expect(403);
      assert.equal((await incident(revoked)).repair_task_id, null);
    }
    await policy('READ_ONLY');
    assert.equal(
      (await api.get(path).query({ taskId: revoked })).body.data.incidents[0].canApprove,
      false,
    );
    await api.post('/api/v1/ai/proposals/' + revokedProposal + '/confirm').expect(403);
    await configure(false);
    assert.equal((await incident(revoked)).status, 'MANUAL');
    await configure(true);
    await policy('FULL_CONTROL');
    const downgraded = await run('npm: command not found');
    await handling.tick();
    const calls = remote.length;
    await policy('CONFIRM');
    await settle(downgraded, 'MANUAL');
    assert.equal(remote.length, calls);
    const declined = await run('npm: command not found');
    await handling.tick();
    const declinedProposal = (await incident(declined)).proposal_id!;
    await api.post('/api/v1/ai/proposals/' + declinedProposal + '/reject').expect(201);
    await handling.tick();
    assert.equal((await incident(declined)).status, 'MANUAL');
    assert.equal((await incident(declined)).repair_task_id, null);
    await policy('FULL_CONTROL');
    const midRun = await run('npm: command not found');
    await handling.tick();
    const installs = remote.filter((command) => command.includes('apt-get install')).length;
    afterPrecheck = async () => {
      await policy('READ_ONLY');
    };
    await settle(midRun, 'MANUAL');
    assert.equal(remote.filter((command) => command.includes('apt-get install')).length, installs);
    await policy('FULL_CONTROL');
    failVerification = true;
    const broken = await run('npm: command not found');
    await handling.tick();
    const repairTask = await settle(broken, 'MANUAL');
    assert.equal(
      (
        await db
          .selectFrom('ai_failure_incidents')
          .select('task_id')
          .where('task_id', '=', repairTask)
          .execute()
      ).length,
      0,
    );
    await api
      .patch('/api/v1/ai/providers/' + provider)
      .send({ enabled: false })
      .expect(200);
    const unavailable = await run('npm: command not found');
    await handling.tick();
    assert.equal((await incident(unavailable)).status, 'MANUAL');
    assert.equal((await incident(unavailable)).proposal_id, null);
  } finally {
    await app.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}
test('failure handling classifies evidence, binds approvals, verifies repairs and stops on revoked access', () =>
  verifyFailures());
test(
  'PostgreSQL failure handling preserves approval and verification semantics',
  { skip: !postgresUrl },
  async () => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(postgresUrl!, (url) => verifyFailures(undefined, url));
  },
);
test(
  'live provider classifies three delivery faults and verifies approved and automatic repairs',
  {
    skip: !process.env.VEYOPS_TEST_FAILURE_AI_KEY,
  },
  () => verifyFailures(process.env.VEYOPS_TEST_FAILURE_AI_KEY),
);
