import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { TaskPayload } from '../modules/tasks/tasks.types';

test('versioned batch operations validate parameters, preserve snapshots and stop a failed precheck', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'veyops-batch-'));
  const initialPassword = 'batch-fixture-initial-password';
  const password = 'batch-fixture-password';
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.DATA_DIR = directory;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_PASSWORD = initialPassword;

  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const executed: string[] = [];
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SshService)
    .useValue({
      execute: async (_target: unknown, command: string) => {
        executed.push(command);
        return { exitCode: command.endsWith('\nfalse') ? 9 : 0 };
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
      .send({ username: 'root', password: initialPassword })
      .expect(201);
    await api
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: initialPassword, newPassword: password })
      .expect(200);
    await api.post('/api/v1/auth/login').send({ username: 'root', password }).expect(201);
    const credential = await api
      .post('/api/v1/credentials')
      .send({ name: 'Fixture', type: 'SSH_PASSWORD', secret: { password: 'fixture' } })
      .expect(201);
    const server = await api
      .post('/api/v1/servers')
      .send({
        name: 'Fixture target',
        host: '127.0.0.1',
        username: 'tester',
        credentialId: credential.body.data.id,
        hostKeyFingerprint: '0'.repeat(64),
      })
      .expect(201);
    const execution = { confirmed: true, serverIds: [server.body.data.id], version: 1 };
    const parameters = [
      { name: 'MESSAGE', type: 'STRING', required: true },
      { name: 'RETRIES', type: 'NUMBER', defaultValue: 0 },
      { name: 'CHECK', type: 'BOOLEAN', defaultValue: false },
    ];
    const command = 'printf "%s\n" "$VEYOPS_PARAM_MESSAGE"';
    const templateDefinition = { name: 'Report', command, parameters, timeout: 42 };
    const templates = '/api/v1/command-templates';
    const template = await api.post(templates).send(templateDefinition).expect(201);
    const templatePath = `${templates}/${template.body.data.id}`;
    await api
      .patch(templatePath)
      .send({ ...templateDefinition, name: 'New report', timeout: 11 })
      .expect(200);
    const versions = await api.get(templatePath + '/versions').expect(200);
    assert.deepEqual(
      versions.body.data.map((row: { version: number; timeout: number }) => [
        row.version,
        row.timeout,
      ]),
      [
        [2, 11],
        [1, 42],
      ],
    );
    await api
      .post(templatePath + '/run')
      .send(execution)
      .expect(400);
    await api
      .post(templatePath + '/run')
      .send({ ...execution, parameters: { MESSAGE: 1 } })
      .expect(400);
    await api
      .post(templatePath + '/run')
      .send({ ...execution, parameters: { MESSAGE: 'hi', UNKNOWN: true } })
      .expect(400);
    const literal = "it's `literal`";
    const commandTask = await api
      .post(templatePath + '/run')
      .send({ ...execution, parameters: { MESSAGE: literal } })
      .expect(201);
    assert.deepEqual(commandTask.body.data.commandTemplate, {
      id: template.body.data.id,
      version: 1,
    });
    assert.equal(commandTask.body.data.name, 'Report · v1');
    const db = app.get(DatabaseService).db;
    const stored = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', commandTask.body.data.id)
      .executeTakeFirstOrThrow();
    const commandPayload = JSON.parse(stored.payload_json) as TaskPayload;
    assert.equal(commandPayload.timeout, 42);
    assert.equal(
      commandPayload.steps[0].command,
      "export VEYOPS_PARAM_MESSAGE='it'\"'\"'s `literal`'\nexport VEYOPS_PARAM_RETRIES='0'\nexport VEYOPS_PARAM_CHECK='false'\n" +
        command,
    );
    await api.post(`/api/v1/tasks/${commandTask.body.data.id}/cancel`).expect(201);
    await api.delete(templatePath).expect(200);
    await api
      .post(templatePath + '/run')
      .send({ ...execution, parameters: { MESSAGE: 'hi' } })
      .expect(400);
    assert.equal((await api.get(templatePath + '/versions').expect(200)).body.data.length, 2);

    const planDefinition = {
      name: 'Checked maintenance',
      parameters,
      preChecks: [{ name: 'Ready', command: 'false' }],
      steps: [{ name: 'Maintenance', command }],
      postChecks: [{ name: 'Verified', command: 'true' }],
    };
    const plan = await api.post('/api/v1/operation-plans').send(planDefinition).expect(201);
    const planPath = '/api/v1/operation-plans/' + plan.body.data.id;
    const operator = request.agent(app.getHttpServer());
    const operatorAccount = { username: 'plan-operator', password: initialPassword };
    const user = await api
      .post('/api/v1/users')
      .send({ ...operatorAccount, role: 'OPERATOR' })
      .expect(201);
    await operator.post('/api/v1/auth/login').send(operatorAccount).expect(201);
    await operator
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: initialPassword, newPassword: password })
      .expect(200);
    await operator
      .post('/api/v1/auth/login')
      .send({ ...operatorAccount, password })
      .expect(201);
    const group = await api
      .post('/api/v1/server-groups')
      .send({ name: 'Maintenance group', serverIds: [server.body.data.id] })
      .expect(201);
    const selection = { groupIds: [group.body.data.id] };
    const preview = await operator.post('/api/v1/commands/preview').send(selection).expect(201);
    const confirmedPlan = {
      ...selection,
      confirmed: true,
      parameters: { MESSAGE: 'fixture' },
      version: 1,
      expectedTargetHash: preview.body.data.targetHash,
    };
    const existingTaskCount = (await api.get('/api/v1/tasks').expect(200)).body.data.length;
    await api
      .patch('/api/v1/users/' + user.body.data.id)
      .send({ role: 'VIEWER' })
      .expect(200);
    await operator
      .post(planPath + '/run')
      .send(confirmedPlan)
      .expect(401);
    await operator
      .post('/api/v1/auth/login')
      .send({ ...operatorAccount, password })
      .expect(201);
    await operator.get(planPath + '/versions').expect(200);
    await operator
      .post(planPath + '/run')
      .send(confirmedPlan)
      .expect(403);

    const replacement = await api
      .post('/api/v1/servers')
      .send({
        name: 'Replacement target',
        host: 'replacement.test',
        username: 'tester',
        credentialId: credential.body.data.id,
        hostKeyFingerprint: '1'.repeat(64),
      })
      .expect(201);
    await api
      .patch('/api/v1/server-groups/' + group.body.data.id)
      .send({ name: 'Maintenance group', serverIds: [replacement.body.data.id] })
      .expect(200);
    await api
      .post(planPath + '/run')
      .send(confirmedPlan)
      .expect(409);
    assert.equal((await api.get('/api/v1/tasks').expect(200)).body.data.length, existingTaskCount);
    const refreshed = await api.post('/api/v1/commands/preview').send(selection).expect(201);
    assert.deepEqual(
      refreshed.body.data.targets.map((target: { id: string }) => target.id),
      [replacement.body.data.id],
    );
    await api
      .patch(planPath)
      .send({ ...planDefinition, name: 'Updated maintenance', preChecks: [] })
      .expect(200);
    const task = await api
      .post(planPath + '/run')
      .send({ ...confirmedPlan, expectedTargetHash: refreshed.body.data.targetHash })
      .expect(201);
    assert.equal(task.body.data.name, 'Checked maintenance · v1');
    await api.delete(planPath).expect(200);
    const worker = app.get(TaskWorkerService);
    await worker.tick();
    for (let attempt = 0; attempt < 100; attempt++) {
      const detail = await api.get(`/api/v1/tasks/${task.body.data.id}`).expect(200);
      if (detail.body.data.status === 'FAILED') break;
      await sleep(20);
    }
    const failed = await api.get(`/api/v1/tasks/${task.body.data.id}`).expect(200);
    assert.equal(failed.body.data.status, 'FAILED');
    assert.equal(executed.length, 1);
    assert.match(executed[0], /\nfalse$/);
    const savedPlanTask = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', task.body.data.id)
      .executeTakeFirstOrThrow();
    const planPayload = JSON.parse(savedPlanTask.payload_json) as TaskPayload;
    assert.deepEqual(
      planPayload.targets.map(({ id }) => id),
      [replacement.body.data.id],
    );
    assert.deepEqual(
      planPayload.steps.map(({ name }) => name),
      ['前置检查 · Ready', 'Maintenance', '执行后验证 · Verified'],
    );
    const temporaryCommand = await api
      .post('/api/v1/commands/execute')
      .send({
        ...selection,
        confirmed: true,
        expectedTargetHash: refreshed.body.data.targetHash,
        command: 'hostname',
      })
      .expect(201);
    const reuse = '/api/v1/tasks/' + temporaryCommand.body.data.id + '/command-reuse';
    const draft = (await api.get(reuse).expect(200)).body.data;
    assert.equal(draft.command, 'hostname');
    assert.deepEqual(draft.selection, selection);
    assert.equal(draft.previousTargetHash, refreshed.body.data.targetHash);
    assert.deepEqual(
      draft.previousTargets.map(({ id }: { id: string }) => id),
      [replacement.body.data.id],
    );
    await operator.get(reuse).expect(403);
    assert.equal(JSON.stringify(draft).includes(credential.body.data.id), false);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
