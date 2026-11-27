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
import type { SshOptions, SshTarget } from '../infrastructure/ssh/ssh.service';
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
  const { OpenAiCompatibleService } =
    await import('../infrastructure/ai-provider/openai-compatible.service.js');
  const { deploymentProbe, initializationPlans } =
    await import('../modules/ai/ai-deployment-tools.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const executed: string[] = [];
  const assistantRequests: string[] = [];
  const assistantResponses = [
    { existingPlanId: initializationPlans.nginx },
    {
      name: 'Install Nginx on Linux',
      actions: [{ type: 'INSTALL_PACKAGES', packages: { 'apt-get': ['nginx'], dnf: ['nginx'] } }],
    },
  ];
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SshService)
    .useValue({
      execute: async (target: SshTarget, command: string, options: SshOptions) => {
        executed.push(command);
        if (command === deploymentProbe) {
          const facts =
            target.host === 'replacement.test'
              ? 'os=rocky\ndnf=available'
              : 'os=ubuntu\napt-get=available';
          options.onData?.(`${facts}\nuid=0\ninit=systemd\nprobeComplete=1\n`, 'stdout');
        }
        return { exitCode: command.endsWith('\nfalse') ? 9 : 0 };
      },
    })
    .overrideProvider(OpenAiCompatibleService)
    .useValue({
      complete: async (_connection: unknown, messages: { content: string }[]) => {
        assistantRequests.push(messages[1]!.content);
        return { content: JSON.stringify(assistantResponses.shift()) };
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
    const parameters = [
      { name: 'MESSAGE', type: 'STRING', required: true },
      { name: 'RETRIES', type: 'NUMBER', defaultValue: 0 },
      { name: 'CHECK', type: 'BOOLEAN', defaultValue: false },
    ];
    const command = 'printf "%s\n" "$VEYOPS_PARAM_MESSAGE"';
    await api.get('/api/v1/command-templates').expect(404);
    const defaults = (await api.get('/api/v1/system').expect(200)).body.data;
    assert.equal(defaults.maxConcurrentFlowsPerServer, 10);
    assert.equal(defaults.defaultOperationFailurePolicy, 'CONTINUE');
    assert.equal(defaults.defaultOperationTimeoutSeconds, 300);
    await api
      .patch('/api/v1/system')
      .send({
        defaultMaxParallelTargets: 4,
        defaultOperationFailurePolicy: 'STOP',
        defaultOperationTimeoutSeconds: 42,
      })
      .expect(200);
    const literal = "it's `literal`";
    const commandTask = await api
      .post('/api/v1/commands/execute')
      .send({ confirmed: true, serverIds: [server.body.data.id], command: 'hostname' })
      .expect(201);
    const db = app.get(DatabaseService).db;
    const stored = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', commandTask.body.data.id)
      .executeTakeFirstOrThrow();
    const commandPayload = JSON.parse(stored.payload_json) as TaskPayload;
    assert.equal(commandPayload.timeout, 42);
    assert.equal(commandPayload.maxParallel, 4);
    assert.equal(commandPayload.failurePolicy, 'STOP');
    assert.equal(commandPayload.steps[0].command, 'hostname');
    await api.post(`/api/v1/tasks/${commandTask.body.data.id}/cancel`).expect(201);

    const planDefinition = {
      name: 'Checked maintenance',
      parameters,
      preChecks: [{ name: 'Ready', command: 'false' }],
      steps: [{ name: 'Maintenance', command }],
      postChecks: [{ name: 'Verified', command: 'true' }],
    };
    const plan = await api.post('/api/v1/operation-plans').send(planDefinition).expect(201);
    const planPath = '/api/v1/operation-plans/' + plan.body.data.id;
    const directTarget = { confirmed: true, serverIds: [server.body.data.id], version: 1 };
    await api
      .post(planPath + '/run')
      .send(directTarget)
      .expect(400);
    await api
      .post(planPath + '/run')
      .send({ ...directTarget, parameters: { MESSAGE: 1 } })
      .expect(400);
    await api
      .post(planPath + '/run')
      .send({
        ...directTarget,
        parameters: { MESSAGE: 'hi', UNKNOWN: true },
      })
      .expect(400);
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
      parameters: { MESSAGE: literal },
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
    assert.equal(planPayload.maxParallel, 4);
    assert.equal(planPayload.failurePolicy, 'STOP');
    assert.equal(planPayload.timeout, 42);
    assert.equal(
      planPayload.steps[1].command,
      "export VEYOPS_PARAM_MESSAGE='it'\"'\"'s `literal`'\nexport VEYOPS_PARAM_RETRIES='0'\nexport VEYOPS_PARAM_CHECK='false'\n" +
        command,
    );
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

    const nativeDefinition = {
      name: 'Canvas maintenance',
      parameters: [{ name: 'MESSAGE', type: 'STRING', required: true }],
      chain: {
        nodes: [
          { id: 'start', type: 'START', name: 'Start', x: 32, y: 50 },
          { id: 'system', type: 'CONDITION', name: 'System', x: 270, y: 50, fact: 'OS' },
          { id: 'inspect', type: 'COMMAND', name: 'Inspect', x: 508, y: 50, command },
          { id: 'end', type: 'END', name: 'End', x: 746, y: 50 },
        ],
        edges: [
          { from: 'start', to: 'system' },
          { from: 'system', to: 'inspect', when: 'debian' },
          { from: 'inspect', to: 'end' },
        ],
      },
    };
    const nativePlan = await api.post('/api/v1/operation-plans').send(nativeDefinition).expect(201);
    const nativePath = '/api/v1/operation-plans/' + nativePlan.body.data.id;
    assert.deepEqual(nativePlan.body.data.chain, nativeDefinition.chain);
    await api
      .patch(nativePath)
      .send({ ...nativeDefinition, name: 'Canvas maintenance updated' })
      .expect(200);
    const versions = (await api.get(nativePath + '/versions').expect(200)).body.data;
    assert.deepEqual(
      versions.map(({ version }: { version: number }) => version),
      [2, 1],
    );
    assert.deepEqual(versions[1].chain, nativeDefinition.chain);
    const nativeTask = await api
      .post(nativePath + '/run')
      .send({ ...confirmedPlan, expectedTargetHash: refreshed.body.data.targetHash })
      .expect(201);
    assert.equal(nativeTask.body.data.name, 'Canvas maintenance · v1');
    const nativePayload = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', nativeTask.body.data.id)
      .executeTakeFirstOrThrow();
    const nativeSnapshot = JSON.parse(nativePayload.payload_json) as TaskPayload;
    assert.deepEqual(nativeSnapshot.operationChain?.edges, nativeDefinition.chain.edges);
    assert.equal(
      nativeSnapshot.operationChain?.nodes.find(({ id }) => id === 'inspect')?.command,
      "export VEYOPS_PARAM_MESSAGE='it'\"'\"'s `literal`'\n" + command,
    );

    await api
      .post('/api/v1/ai/providers')
      .send({
        name: 'Fixture AI',
        baseUrl: 'http://127.0.0.1:9999/v1',
        model: 'fixture-model',
        apiKey: 'fixture-model-key',
      })
      .expect(201);
    const inspectStart = executed.length;
    const recommend = await api
      .post('/api/v1/operation-plans/ai-assist')
      .send({
        serverIds: [server.body.data.id],
        instructions: '在所选服务器上使用包管理器安装 Nginx',
      })
      .expect(201);
    assert.equal(recommend.body.data.kind, 'RECOMMENDATION');
    assert.equal(recommend.body.data.plan.id, initializationPlans.nginx);
    assert.match(assistantRequests[0]!, /"packageManager":"apt-get"/);
    const suggestion = await api
      .post('/api/v1/operation-plans/ai-assist')
      .send({
        serverIds: [server.body.data.id, replacement.body.data.id],
        instructions: '在所选服务器上使用包管理器安装 Nginx',
      })
      .expect(201);
    assert.equal(suggestion.body.data.kind, 'DRAFT');
    assert.deepEqual(
      suggestion.body.data.draft.chain.edges.flatMap(({ when }: { when?: string }) => when ?? []),
      ['apt-get', 'dnf'],
    );
    assert.match(assistantRequests[1]!, /"packageManager":"dnf"/);
    assert.equal(assistantRequests[1]!.includes(initializationPlans.nginx), false);
    assert.deepEqual(executed.slice(inspectStart), [
      deploymentProbe,
      deploymentProbe,
      deploymentProbe,
    ]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
