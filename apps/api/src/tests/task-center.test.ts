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
import type { TasksService } from '../modules/tasks/tasks.service';

test('task center pages through root executions and standalone tasks without exposing node tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-task-center-'));
  const password = randomBytes(16).toString('hex');
  Object.assign(process.env, {
    DATABASE_CLIENT: 'sqlite',
    DATABASE_PATH: join(dir, 'test.db'),
    DATA_DIR: dir,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: password,
    WORKER_ENABLED: 'false',
  });
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication<NestExpressApplication>({ logger: false });
  try {
    configureApp(app);
    await app.init();
    const api = request.agent(app.getHttpServer());
    const prefix = '/api/v1';
    const endpoint = prefix + '/tasks/center';
    const user = (
      await api
        .post(prefix + '/auth/login')
        .send({ username: 'root', password })
        .expect(201)
    ).body.data;
    const project = (
      await api
        .post(prefix + '/projects')
        .send({ slug: 'tasks', name: 'Fixture' })
        .expect(201)
    ).body.data;
    const db = app.get(DatabaseService).db;
    const graph = await db
      .selectFrom('execution_graphs')
      .select(['id', 'revision', 'draft_json'])
      .where('project_id', '=', project.id)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('execution_graph_versions')
      .values({
        id: randomUUID(),
        graph_id: graph.id,
        version: 1,
        source_revision: graph.revision,
        definition_json: graph.draft_json,
        created_by: user.id,
        created_at: 1,
      })
      .execute();
    const run = {
      graph_id: graph.id,
      project_id: project.id,
      version: 1,
      flow_id: 'start',
      created_by: user.id,
      request_hash: 'request',
      configuration_hash: 'configuration',
      inputs_json: '{}',
    };
    const task = {
      task_type: 'GRAPH_MODULE',
      project_id: project.id,
      status: 'SUCCESS',
      created_by: user.id,
      payload_json: '{}',
      created_at: 5_000,
      updated_at: 5_000,
    };
    const waiting = randomUUID();
    const failed = randomUUID();
    const succeeded = randomUUID();
    const cancelled = randomUUID();
    const child = randomUUID();
    const command = randomUUID();
    const graphTask = randomUUID();
    const snapshotTask = randomUUID();
    const replacedNode = randomUUID();
    const legacyTask = randomUUID();
    await db
      .insertInto('tasks')
      .values([
        {
          ...task,
          id: command,
          task_type: 'COMMAND',
          name: 'Command _test',
          status: 'PENDING',
          created_at: 2_000,
        },
        { ...task, id: graphTask, name: 'Build node' },
        { ...task, id: legacyTask, task_type: 'PIPELINE', name: 'Old flow task' },
        {
          ...task,
          id: snapshotTask,
          name: 'Build snapshot',
          idempotency_key: 'execution-flow:' + replacedNode + ':snapshot',
        },
      ])
      .execute();
    await db
      .insertInto('execution_flow_runs')
      .values([
        {
          ...run,
          id: waiting,
          idempotency_key: waiting,
          flow_name: 'Waiting for Approval',
          status: 'WAITING',
          created_at: 2_000,
        },
        {
          ...run,
          id: failed,
          idempotency_key: failed,
          flow_name: 'Failed delivery',
          status: 'FAILED',
          created_at: 1_000,
          finished_at: 4_000,
          task_id: legacyTask,
        },
        {
          ...run,
          id: cancelled,
          idempotency_key: cancelled,
          flow_name: 'Cancelled delivery',
          status: 'CANCELLED',
          created_at: 3_000,
          finished_at: 3_500,
        },
        {
          ...run,
          id: succeeded,
          idempotency_key: succeeded,
          flow_name: 'Successful delivery',
          status: 'SUCCESS',
          created_at: 500,
          finished_at: 3_500,
        },
      ])
      .execute();
    await db
      .insertInto('execution_flow_runs')
      .values({
        ...run,
        id: child,
        idempotency_key: child,
        flow_name: 'Nested build',
        status: 'SUCCESS',
        created_at: 4_000,
        parent_run_id: waiting,
      })
      .execute();
    await db
      .insertInto('execution_node_runs')
      .values({
        id: replacedNode,
        run_id: waiting,
        node_id: 'build',
        name: 'Build',
        node_type: 'BUILD',
        position: 1,
        status: 'SUCCESS',
        log: '',
        task_id: graphTask,
        started_at: 2_001,
      })
      .execute();

    const list = async (
      query: Record<string, string | number> = {},
    ): Promise<Awaited<ReturnType<TasksService['center']>>> =>
      (await api.get(endpoint).query(query).expect(200)).body.data;
    const first = await list({ limit: 2 });
    assert.ok(first.nextBefore);
    const second = await list({ limit: 3, before: first.nextBefore });
    assert.equal(second.nextBefore, null);
    assert.deepEqual(
      [...first.items, ...second.items].map(({ id }) => id),
      [cancelled, ...[command, waiting].sort().reverse(), failed, succeeded],
    );
    const active = await list({ status: 'ACTIVE' });
    const aggregate = active.items.find(({ id }) => id === waiting);
    assert.deepEqual(aggregate, {
      id: waiting,
      type: 'EXECUTION_FLOW',
      name: 'Waiting for Approval',
      status: 'WAITING',
      createdAt: 2_000,
      createdBy: user.id,
      projectId: project.id,
      projectName: project.name,
      startedAt: 2_001,
      finishedAt: null,
      flowId: 'start',
      version: 1,
      flowRunId: waiting,
      result: null,
    });
    assert.equal(active.items.find(({ id }) => id === command)?.type, 'COMMAND');
    assert.deepEqual(
      (await list({ status: 'FAILED' })).items.map(({ id }) => id),
      [failed],
    );
    assert.deepEqual(
      (await list({ status: 'SUCCESS' })).items.map(({ id }) => id),
      [succeeded],
    );
    assert.deepEqual(
      (await list({ q: 'approval' })).items.map(({ id }) => id),
      [waiting],
    );
    assert.deepEqual(
      (await list({ q: '_test' })).items.map(({ id }) => id),
      [command],
    );
    assert.deepEqual((await list({ q: '%' })).items, []);
    await api.get(endpoint).query({ before: 'malformed-cursor' }).expect(400);
    await api.get(prefix + '/tasks/' + graphTask + '/logs').expect(200);
    assert.ok(
      (await api.get(prefix + '/tasks').expect(200)).body.data.some(
        ({ id }: { id: string }) => id === snapshotTask,
      ),
    );
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
