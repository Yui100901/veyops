import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

test('FLOW_V2 exposes node and task logs and validates artifact ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-graph-output-'));
  const initial = randomBytes(16).toString('hex');
  const password = randomBytes(16).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: 'sqlite',
    DATABASE_PATH: join(dir, 'test.db'),
    DATA_DIR: dir,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: initial,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { BuildsService } = await import('../modules/builds/builds.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false });
  try {
    configureApp(app);
    await app.init();
    const api = request.agent(app.getHttpServer());
    const root = '/api/v1';
    await api
      .post(root + '/auth/login')
      .send({ username: 'root', password: initial })
      .expect(201);
    await api
      .post(root + '/auth/change-password')
      .send({ currentPassword: initial, newPassword: password })
      .expect(200);
    await api
      .post(root + '/auth/login')
      .send({ username: 'root', password })
      .expect(201);

    const create = async (path: string, slug: string): Promise<string> =>
      (
        await api
          .post(root + path)
          .send({ name: slug, slug })
          .expect(201)
      ).body.data.id;
    const projectId = await create('/projects', 'service-outputs');
    const otherId = await create('/projects', 'foreign-outputs');
    const serviceId = await create(`/projects/${projectId}/services`, 'valid-service');
    const foreignServiceId = await create(`/projects/${otherId}/services`, 'other-service');

    app.get(BuildsService).managerFlowCommand = async (
      { context },
      _workspace,
      _command,
      _directory,
      variables,
    ) => {
      assert.equal(variables.VEYOPS_SERVICE_ID, serviceId);
      context.log('自动采集的脚本日志');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const graphPath = `${root}/projects/${projectId}/execution-graph`;
    const draft = (await api.get(graphPath).expect(200)).body.data;
    const saved = (
      await api
        .put(graphPath + '/draft')
        .send({
          expectedRevision: draft.revision,
          definition: {
            canvas: {
              model: 'FLOW_V2',
              templates: [],
              nodes: [
                {
                  id: 'start',
                  name: '开始',
                  type: 'START',
                  start: { execution: { location: 'MANAGER' }, release: { serviceId } },
                },
                {
                  id: 'legacy-log',
                  name: '旧日志节点',
                  type: 'LOG',
                  message: '已有日志节点继续可读。',
                },
                {
                  id: 'shell',
                  name: '选择服务',
                  type: 'FUNCTION',
                  operation: 'SHELL',
                  shell: { command: 'printf ok' },
                },
                { id: 'end', name: '结束', type: 'END', finish: { saveWorkspace: false } },
              ],
              edges: [
                { from: 'start', to: 'legacy-log' },
                { from: 'legacy-log', to: 'shell' },
                { from: 'shell', to: 'end' },
              ],
              endpoints: [{ startId: 'start', endId: 'end' }],
            },
          },
        })
        .expect(200)
    ).body.data;
    const version = (
      await api
        .post(graphPath + '/publish')
        .send({ expectedRevision: saved.revision })
        .expect(201)
    ).body.data.publishedVersion;
    const worker = app.get(TaskWorkerService);
    const flow = graphPath + '/flows/start';
    const launch = async () => {
      const args = { version };
      const preview = (
        await api
          .post(flow + '/preview')
          .send(args)
          .expect(201)
      ).body.data;
      const run = (
        await api
          .post(flow + '/run')
          .send({
            ...args,
            expectedConfigurationHash: preview.configurationHash,
            idempotencyKey: randomUUID(),
          })
          .expect(201)
      ).body.data;
      for (let attempt = 0; attempt < 15; attempt++) {
        await worker.tick();
        const current = (await api.get(graphPath + '/runs/' + run.id).expect(200)).body.data;
        if (['SUCCESS', 'FAILED'].includes(current.status)) return current;
        await delay(20);
      }
      assert.fail('Service output flow did not settle');
    };

    const selected = await launch();
    assert.equal(selected.status, 'SUCCESS');
    const logs = (runId: string, nodeId: string) => `/runs/${runId}/nodes/${nodeId}/logs`;
    const shellLog = (await api.get(graphPath + logs(selected.id, 'shell')).expect(200)).body.data;
    assert.equal(shellLog.source, 'TASK');
    assert.match(shellLog.content, /自动采集的脚本日志/);
    assert.doesNotMatch(shellLog.content, /VEYOPS_OUTPUT|PROJECT_SERVICE/);
    assert.equal(
      (
        await api
          .get(graphPath + logs(selected.id, 'shell') + '?offset=' + shellLog.nextOffset)
          .expect(200)
      ).body.data.content,
      '',
    );
    for (const [nodeId, message] of [
      ['start', '执行流已开始'],
      ['legacy-log', '已有日志节点继续可读'],
      ['end', '执行流已结束'],
    ]) {
      const log = (await api.get(graphPath + logs(selected.id, nodeId!)).expect(200)).body.data;
      assert.equal(log.source, 'NODE');
      assert.ok(log.content.includes(message));
    }
    await api
      .get(`${root}/projects/${otherId}/execution-graph` + logs(selected.id, 'shell'))
      .expect(404);
    await api.get(graphPath + logs(selected.id, 'shell') + '?offset=-1').expect(400);

    const { revision, draft: current } = (await api.get(graphPath).expect(200)).body.data;
    current.canvas.nodes[0].start.release.serviceId = foreignServiceId;
    const validation = await api
      .post(graphPath + '/validate')
      .send({ definition: current })
      .expect(201);
    const [ownership] = validation.body.data.issues;
    assert.equal(ownership.fieldId, 'start.release.serviceId');
    assert.match(ownership.message, /不属于当前项目/);
    const rejected = await api
      .put(graphPath + '/draft')
      .send({ expectedRevision: revision, definition: current })
      .expect(200);
    await api
      .post(graphPath + '/publish')
      .send({ expectedRevision: rejected.body.data.revision })
      .expect(400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
