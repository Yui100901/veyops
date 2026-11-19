import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:http';
import { ModuleRef } from '@nestjs/core';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { CredentialsService } from '../modules/credentials/credentials.service';
import { AiRepository } from '../modules/ai/ai.repository';
import { AiProvidersService } from '../modules/ai/ai-providers.service';
import { AiPolicyService } from '../modules/ai/ai-policy.service';
import { AiToolsService } from '../modules/ai/ai-tools.service';
import { AiProposalsService } from '../modules/ai/ai-proposals.service';
import { AiService } from '../modules/ai/ai.service';
import {
  OpenAiCompatibleService,
  completionUrl,
  sanitizeAiText,
} from '../infrastructure/ai-provider/openai-compatible.service';
import { ProjectsService } from '../modules/projects/projects.service';
import { RepositoryMetadataService } from '../modules/projects/repository-metadata.service';
import { ProjectRelationsService } from '../modules/projects/project-relations';
import { ServersService } from '../modules/servers/servers.service';
import { TasksService } from '../modules/tasks/tasks.service';
import { CommandCenterService } from '../modules/command-center/command-center.service';
import { CurrentUser } from '../modules/auth/auth.decorators';
import {
  AiDeploymentToolsService,
  diagnoseDeploymentFailure,
  parseDeploymentProbe,
} from '../modules/ai/ai-deployment-tools.service';
import { AiRepositoryAnalysisService } from '../modules/ai/ai-repository-analysis.service';
import { AiSourceChangeService } from '../modules/ai/ai-source-change.service';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'veyops-ai-'));
  process.env.DATABASE_PATH = join(dir, 'app.db');
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const database = new DatabaseService();
  await database.onModuleInit();
  const actor: CurrentUser = { id: randomUUID(), username: 'admin', role: 'ADMIN' };
  const other: CurrentUser = { id: randomUUID(), username: 'other', role: 'ADMIN' };
  for (const user of [actor, other])
    await database.db
      .insertInto('users')
      .values({
        id: user.id,
        username: user.username,
        role: user.role,
        password_hash: 'unused',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
  const projectId = randomUUID();
  await database.db
    .insertInto('projects')
    .values({
      id: projectId,
      name: 'Project',
      slug: 'project',
      created_by: actor.id,
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .execute();
  const audit = new AuditService(database);
  const credentials = new CredentialsService(database, audit);
  const repository = new AiRepository(database);
  const projects = new ProjectsService(
    database,
    audit,
    new ProjectRelationsService(database, audit),
    new RepositoryMetadataService(database, credentials),
  );
  const wire = new OpenAiCompatibleService();
  const providers = new AiProvidersService(repository, credentials, wire, audit);
  const policy = new AiPolicyService(repository, projects, audit);
  const target = {
    id: randomUUID(),
    name: 'Server',
    host: 'test.local',
    port: 22,
    username: 'ops',
    credentialId: null,
    hostKeyFingerprint: '0'.repeat(64),
    status: 'UNKNOWN',
    osType: null,
    lastCheckedAt: null,
    tags: [],
    createdAt: Date.now(),
  };
  let executeCount = 0;
  const commands = {
    execute: async () => {
      executeCount++;
      const id = randomUUID();
      await database.db
        .insertInto('tasks')
        .values({
          id,
          task_type: 'COMMAND',
          name: 'AI task',
          created_by: actor.id,
          payload_json: '{}',
          created_at: Date.now(),
          updated_at: Date.now(),
          available_at: Date.now(),
        })
        .execute();
      return { id, status: 'PENDING', name: 'AI task' };
    },
  } as unknown as CommandCenterService;
  const servers = {
    list: async () => [target],
    snapshot: async (ids: string[]) => {
      if (ids.some((id) => id !== target.id)) throw new Error('服务器不存在');
      return [target];
    },
  } as unknown as ServersService;
  const tasks = {
    list: async () => [],
    targets: async () => [],
    get: async (id: string) =>
      database.db
        .selectFrom('tasks')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
  } as unknown as TasksService;
  const deployment = {
    inspect: async () => [{ serverId: target.id, status: 'OK', facts: { git: 'available' } }],
    initialization: async (component: string) => ({
      planId: component,
      version: 1,
      planVersionId: 'fixed',
      targetHash: 'a'.repeat(64),
      summary: 'Fixed initialization',
      steps: [],
    }),
    initialize: async () => commands.execute({} as never, actor.id),
  } as unknown as AiDeploymentToolsService;
  const sourceWrites: string[] = [];
  const source = {
    async prepare(payload: Record<string, unknown>) {
      return {
        projectId,
        repositoryId: payload.repositoryId,
        payload,
        preview: { ...payload },
        bindingsHash: 'a'.repeat(64),
      };
    },
    async execute(stage: string, payload: Record<string, unknown>) {
      sourceWrites.push(stage);
      return {
        ...payload,
        projectId,
        id: randomUUID(),
        kind: stage === 'BRANCH' ? 'SOURCE_BRANCH' : 'PULL_REQUEST',
      };
    },
  } as unknown as AiSourceChangeService;
  const tools = new AiToolsService(
    servers,
    projects,
    tasks,
    commands,
    policy,
    {} as ModuleRef,
    deployment,
    {} as AiRepositoryAnalysisService,
    source,
  );
  const proposals = new AiProposalsService(repository, policy, tools, audit);
  const ai = new AiService(repository, providers, wire, policy, tools, proposals, projects, audit);
  return {
    database,
    actor,
    other,
    projectId,
    target,
    providers,
    policy,
    tools,
    proposals,
    repository,
    wire,
    ai,
    executeCount: () => executeCount,
    sourceWrites,
    async close() {
      await database.onApplicationShutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function upstream(
  handler: (
    body: Record<string, any>,
    auth: string | undefined,
  ) => { status?: number; body: unknown },
) {
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (part: Buffer) => {
      text += part;
    });
    req.on('end', () => {
      const result = handler(JSON.parse(text), req.headers.authorization);
      res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => closeServer(server) };
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

test('OpenAI compatibility normalizes roots and /v1, rejects embedded credentials and redacts key-like text', () => {
  assert.equal(
    completionUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/chat/completions',
  );
  assert.equal(completionUrl('https://example.com/v1/'), 'https://example.com/v1/chat/completions');
  assert.throws(() => completionUrl('https://user:secret@example.com/v1'));
  assert.throws(() => completionUrl('http://external.example/v1'));
  assert.equal(
    sanitizeAiText('password=abc api_key=xyz sk-1234567890abcdefgh'),
    'password=[REDACTED] api_key=[REDACTED] [REDACTED]',
  );
});
test('routes chat, repository analysis and failure diagnosis to configured providers and preserves explicit selection', async () => {
  const f = await fixture();
  const calls: string[] = [];
  const http = await upstream((body) => {
    calls.push(body.model);
    return { body: { choices: [{ message: { content: 'OK' } }] } };
  });
  try {
    async function provider(model: string) {
      return f.providers.create(
        {
          name: model,
          model,
          baseUrl: http.url,
          apiKey: 'local-fixture-key',
          enabled: true,
          timeoutSeconds: 8,
        },
        f.actor.id,
      );
    }
    const first = await provider('general'),
      second = await provider('analysis');
    await f.providers.setRoutes(
      { chat: second.id, repository: first.id, diagnosis: second.id },
      f.actor.id,
    );
    await f.ai.chat({ message: 'test chat' }, f.actor);
    await f.ai.chat({ message: 'explicit', providerId: first.id }, f.actor);
    assert.deepEqual(calls, ['analysis', 'general']);
    assert.equal((await f.providers.resolve(undefined, 'repository')).id, first.id);
    assert.equal((await f.providers.resolve(undefined, 'diagnosis')).id, second.id);
    await f.providers.update(second.id, { enabled: false }, f.actor.id);
    await assert.rejects(f.ai.chat({ message: 'unavailable' }, f.actor), /禁用/);
    await assert.rejects(f.providers.setRoutes({ repository: second.id }, f.actor.id), /启用/);
    assert.equal((await f.providers.routes()).chat, second.id);
    assert.equal(calls.length, 2);
    await f.providers.setRoutes({}, f.actor.id);
    assert.equal((await f.providers.resolve()).id, first.id);
  } finally {
    await http.close();
    await f.close();
  }
});
test('conditional AI rules intersect role, operation and distinct targets, deny a mixed batch and recheck a pending proposal', async () => {
  const f = await fixture();
  try {
    const second = randomUUID();
    const scope = { mode: 'FULL_CONTROL' as const, serverIds: [f.target.id, second] };
    const action = {
      action: 'initialize_component',
      projectId: f.projectId,
      serverIds: [f.target.id, second],
    };
    await f.policy.update(
      {
        ...scope,
        actionRules: [
          { action: 'initialize_component', effect: 'CONFIRM', minimumTargets: 2, role: 'ADMIN' },
          { action: 'initialize_component', effect: 'DENY', serverId: second, role: 'OPERATOR' },
        ],
      },
      f.actor,
    );
    await f.policy.update({ ...scope, projectId: f.projectId }, f.actor);
    const snap = await f.policy.snapshot(f.projectId);
    assert.equal(f.policy.evaluate(f.actor, action, snap), 'REQUIRE_CONFIRM');
    assert.equal(
      f.policy.evaluate(f.actor, { ...action, serverIds: [f.target.id, f.target.id] }, snap),
      'ALLOW',
    );
    assert.throws(() => f.policy.evaluate({ ...f.actor, role: 'OPERATOR' }, action, snap), /禁止/);
    const prepared = await f.tools.prepare('execute_command', {
      serverIds: [f.target.id],
      command: 'uname',
    });
    const proposal = await f.proposals.create(
      { ...prepared, projectId: f.projectId },
      snap,
      f.actor,
    );
    await f.policy.update(
      {
        ...scope,
        actionRules: [{ action: 'execute_command', effect: 'DENY', serverId: f.target.id }],
      },
      f.actor,
    );
    await f.policy.update(scope, f.actor);
    await assert.rejects(f.proposals.confirm(proposal.id, f.actor), /禁止/);
    assert.equal(f.executeCount(), 0);
    await f.policy.update({ ...scope, actionRules: [] }, f.actor);
    await f.proposals.confirm(proposal.id, f.actor);
    assert.equal(f.executeCount(), 1);
  } finally {
    await f.close();
  }
});
test('AI is optional; provider keys are encrypted and metadata never returns plaintext; disabled provider cannot run', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.providers.resolve(), /尚未配置/);
    const provider = await f.providers.create(
      {
        name: 'Test',
        baseUrl: 'https://example.com/v1',
        model: 'custom-model',
        apiKey: 'sk-test-provider-secret-1234',
        enabled: false,
        timeoutSeconds: 10,
      },
      f.actor.id,
    );
    assert.equal(JSON.stringify(provider).includes('sk-test'), false);
    const stored = await f.database.db
      .selectFrom('credentials')
      .selectAll()
      .executeTakeFirstOrThrow();
    assert.equal(stored.ciphertext.includes('sk-test'), false);
    await assert.rejects(f.providers.resolve(provider.id), /禁用/);
    await f.providers.update(provider.id, { enabled: true }, f.actor.id);
    assert.equal((await f.providers.resolve()).model, 'custom-model');
    await f.providers.remove(provider.id, f.actor.id);
    assert.deepEqual(await f.providers.list(), []);
  } finally {
    await f.close();
  }
});
test('OpenAI wire sends configured model and bearer key, returns only safe message and hides upstream error bodies', async () => {
  const key = 'sk-mock-provider-123456789';
  let fail = false;
  const server = await upstream((body, auth) => {
    assert.equal(auth, `Bearer ${key}`);
    assert.equal(body.model, 'deepseek-flash');
    return fail
      ? { status: 401, body: { error: `invalid key ${key}` } }
      : {
          body: {
            choices: [
              {
                message: {
                  content: `OK ${key}`,
                  reasoning_content: 'must not expose internal reasoning',
                },
              },
            ],
          },
        };
  });
  try {
    const wire = new OpenAiCompatibleService();
    const connection = {
      baseUrl: server.url,
      model: 'deepseek-flash',
      apiKey: key,
      timeoutSeconds: 5,
    };
    const result = await wire.complete(connection, [{ role: 'user', content: 'hello' }]);
    assert.equal(result.content, 'OK [REDACTED]');
    assert.equal(JSON.stringify(result).includes('reasoning'), false);
    fail = true;
    await assert.rejects(
      wire.complete(connection, [{ role: 'user', content: 'hello' }]),
      (e: Error) => e.message.includes('HTTP 401') && !e.message.includes(key),
    );
  } finally {
    await server.close();
  }
});
test('AI permission precedence prevents role bypass, readonly writes, mixed scope and global-deny overrides', async () => {
  const f = await fixture();
  try {
    const action = { action: 'execute_command', serverIds: [f.target.id] };
    const confirm = await f.policy.snapshot();
    assert.equal(f.policy.evaluate(f.actor, action, confirm), 'REQUIRE_CONFIRM');
    assert.throws(
      () => f.policy.evaluate({ ...f.actor, role: 'VIEWER' }, action, confirm),
      /用户角色/,
    );
    await f.policy.update({ mode: 'READ_ONLY' }, f.actor);
    assert.throws(
      () => f.policy.evaluate(f.actor, action, { ...confirm, mode: 'READ_ONLY' }),
      /只读/,
    );
    await assert.rejects(f.policy.update({ mode: 'FULL_CONTROL' }, f.actor), /必须明确/);
    await f.policy.update(
      { mode: 'FULL_CONTROL', serverIds: [f.target.id], deniedActions: ['run_pipeline'] },
      f.actor,
    );
    await f.policy.update(
      {
        mode: 'FULL_CONTROL',
        projectId: f.projectId,
        serverIds: [f.target.id],
        allowedActions: ['run_pipeline', 'inspect_servers', 'execute_command'],
      },
      f.actor,
    );
    const full = await f.policy.snapshot(f.projectId);
    assert.equal(
      f.policy.evaluate(
        f.actor,
        { action: 'inspect_servers', serverIds: [f.target.id], projectId: f.projectId },
        full,
      ),
      'ALLOW',
    );
    assert.equal(
      f.policy.evaluate(f.actor, { ...action, projectId: f.projectId }, full),
      'REQUIRE_CONFIRM',
    );
    assert.throws(
      () =>
        f.policy.evaluate(
          f.actor,
          { action: 'run_pipeline', serverIds: [f.target.id], projectId: f.projectId },
          full,
        ),
      /禁止/,
    );
    assert.throws(
      () => f.policy.evaluate(f.actor, { ...action, serverIds: [f.target.id, randomUUID()] }, full),
      /拒绝整个/,
    );
  } finally {
    await f.close();
  }
});
test('AI proposals bind owner, recheck current policies and target bindings, expire and consume exactly once', async () => {
  const f = await fixture();
  try {
    const prepared = await f.tools.prepare('execute_command', {
      serverIds: [f.target.id],
      command: 'uname -s',
    });
    const proposal = await f.proposals.create(prepared, await f.policy.snapshot(), f.actor);
    await assert.rejects(f.proposals.confirm(proposal.id, f.other), /不存在/);
    await f.policy.update({ mode: 'READ_ONLY' }, f.actor);
    await assert.rejects(f.proposals.confirm(proposal.id, f.actor), /只读/);
    await f.policy.update({ mode: 'CONFIRM' }, f.actor);
    f.target.host = 'changed.local';
    await assert.rejects(f.proposals.confirm(proposal.id, f.actor), /已改变/);
    f.target.host = 'test.local';
    const results = await Promise.allSettled([
      f.proposals.confirm(proposal.id, f.actor),
      f.proposals.confirm(proposal.id, f.actor),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(f.executeCount(), 1);
    const expired = await f.proposals.create(prepared, await f.policy.snapshot(), f.actor);
    await f.database.db
      .updateTable('ai_action_proposals')
      .set({ expires_at: Date.now() - 1 })
      .where('id', '=', expired.id)
      .execute();
    await assert.rejects(f.proposals.confirm(expired.id, f.actor), /已过期/);
    const rejected = await f.proposals.create(prepared, await f.policy.snapshot(), f.actor);
    await f.proposals.reject(rejected.id, f.actor);
    await assert.rejects(f.proposals.confirm(rejected.id, f.actor), /已处理/);
    assert.equal(f.executeCount(), 1);
  } finally {
    await f.close();
  }
});
test('project-bound command proposals retain project policy when confirming', async () => {
  const f = await fixture();
  try {
    const prepared = await f.tools.prepare('execute_command', {
      serverIds: [f.target.id],
      command: 'uname -s',
    });
    prepared.projectId = f.projectId;
    const proposal = await f.proposals.create(
      prepared,
      await f.policy.snapshot(f.projectId),
      f.actor,
    );
    await f.policy.update({ mode: 'READ_ONLY', projectId: f.projectId }, f.actor);
    await assert.rejects(f.proposals.confirm(proposal.id, f.actor), /只读/);
    await f.policy.update({ mode: 'CONFIRM', projectId: f.projectId, serverIds: [] }, f.actor);
    const [withdrawn] = await f.proposals.list(f.actor);
    assert.deepEqual(withdrawn?.preview, {});
    assert.deepEqual(withdrawn?.payload, {});
    assert.equal('scopeRevoked' in withdrawn! && withdrawn.scopeRevoked, true);
    await assert.rejects(f.proposals.confirm(proposal.id, f.actor), /未授权/);
    assert.deepEqual((await f.proposals.reject(proposal.id, f.actor)).proposal.preview, {});
    assert.equal(f.executeCount(), 0);
  } finally {
    await f.close();
  }
});
test('resetting one project AI policy restores inheritance without changing other overrides', async () => {
  const f = await fixture();
  try {
    const otherProject = randomUUID();
    await f.database.db
      .insertInto('projects')
      .values({
        id: otherProject,
        name: 'Other project',
        slug: 'other',
        created_by: f.actor.id,
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    await f.policy.update({ mode: 'READ_ONLY' }, f.actor);
    await f.policy.update({ mode: 'CONFIRM', projectId: f.projectId }, f.actor);
    await f.policy.update({ mode: 'CONFIRM', projectId: otherProject }, f.actor);
    await assert.rejects(
      f.policy.resetProject(f.projectId, { ...f.actor, role: 'OPERATOR' }),
      /仅管理员/,
    );
    const result = await f.policy.resetProject(f.projectId, f.actor);
    assert.equal(result.system.mode, 'READ_ONLY');
    assert.deepEqual(
      result.projects.map(({ projectId }) => projectId),
      [otherProject],
    );
    assert.equal((await f.policy.snapshot(f.projectId)).mode, 'READ_ONLY');
    assert.equal((await f.policy.snapshot(otherProject)).mode, 'CONFIRM');
    await f.policy.update(
      { mode: 'READ_ONLY', projectId: otherProject, deniedActions: ['list_projects'] },
      f.actor,
    );
    const visible = await f.tools.read(
      'list_projects',
      {},
      await f.policy.snapshot(),
      undefined,
      f.actor,
    );
    assert.deepEqual(
      (visible as { id: string }[]).map(({ id }) => id),
      [f.projectId],
    );
  } finally {
    await f.close();
  }
});

test('AI page context is retained and refuses cross-service drafts and out-of-scope actions', async () => {
  const f = await fixture();
  const serviceId = randomUUID(),
    siblingId = randomUUID(),
    repositoryId = randomUUID();
  let callCount = 0;
  const server = await upstream((body) => {
    callCount++;
    assert.equal(
      body.tools.some(
        (entry: { function: { name: string } }) => entry.function.name === 'execute_command',
      ),
      false,
    );
    if (callCount !== 1) return { body: { choices: [{ message: { content: '分析完成' } }] } };
    const draft = (id: string, service?: string) => ({
      id,
      type: 'function',
      function: {
        name: 'draft_pipeline',
        arguments: JSON.stringify({
          definition: JSON.stringify({
            name: 'Page draft',
            serviceId: service,
            definition: { repositoryId },
          }),
        }),
      },
    });
    return {
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                draft('drift', siblingId),
                draft('bound'),
                {
                  id: 'command',
                  type: 'function',
                  function: {
                    name: 'execute_command',
                    arguments: JSON.stringify({ serverIds: [f.target.id], command: 'uname' }),
                  },
                },
              ],
            },
          },
        ],
      },
    };
  });
  try {
    await f.database.db
      .insertInto('services')
      .values(
        [serviceId, siblingId].map((id, index) => ({
          id,
          project_id: f.projectId,
          name: `Service ${index}`,
          slug: `service-${index}`,
          created_at: Date.now(),
          updated_at: Date.now(),
        })),
      )
      .execute();
    await f.database.db
      .insertInto('repositories')
      .values({
        id: repositoryId,
        project_id: f.projectId,
        name: 'Repository',
        clone_url: 'https://git.example.invalid/project.git',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    await f.providers.create(
      {
        name: 'Mock',
        baseUrl: server.url,
        model: 'test',
        apiKey: 'fixture-key',
        timeoutSeconds: 5,
        enabled: true,
      },
      f.actor.id,
    );
    const context = { kind: 'SERVICE' as const, serviceId };
    const scoped = await f.repository.resolveContext(context, f.projectId, f.actor);
    const hiddenRepo = randomUUID();
    await f.database.db
      .insertInto('repositories')
      .values({
        id: hiddenRepo,
        project_id: f.projectId,
        name: 'Restricted',
        clone_url: 'https://git.example.invalid/private.git',
        created_at: Date.now(),
        updated_at: Date.now(),
      })
      .execute();
    await f.policy.update(
      { mode: 'READ_ONLY', projectId: f.projectId, repositoryIds: [repositoryId] },
      f.actor,
    );
    const scopedPolicy = await f.policy.snapshot(f.projectId);
    const metadata = await f.tools.read(
      'get_project',
      { projectId: f.projectId },
      scopedPolicy,
      f.projectId,
      f.actor,
      scoped,
    );
    assert.equal(JSON.stringify(metadata).includes(hiddenRepo), false);
    assert.equal(JSON.stringify(metadata).includes(siblingId), false);
    await assert.rejects(
      f.tools.read(
        'draft_pipeline',
        {
          definition: JSON.stringify({
            definition: { repositoryId, nodes: [{ type: 'SOURCE', repositoryId: hiddenRepo }] },
          }),
        },
        scopedPolicy,
        f.projectId,
        f.actor,
        scoped,
      ),
      /授权范围/,
    );
    await assert.rejects(
      f.ai.chat({ context, projectId: randomUUID(), message: '错误项目' }, f.actor),
      /当前项目不一致/,
    );
    const reply = await f.ai.chat({ context, message: '生成流水线' }, f.actor);
    assert.equal(reply.projectId, f.projectId);
    assert.equal(reply.serviceId, serviceId);
    assert.deepEqual(reply.drafts, [
      {
        type: 'PIPELINE',
        definition: {
          name: 'Page draft',
          serviceId,
          projectId: f.projectId,
          definition: { repositoryId },
        },
        draftOnly: true,
      },
    ]);
    assert.equal(reply.proposals.length, 0);
    assert.equal(f.executeCount(), 0);
    assert.deepEqual((await f.ai.conversations(f.actor.id))[0]?.context, context);
    assert.ok(
      (await f.ai.messages(reply.conversationId, f.actor)).every(
        ({ role }) => role !== 'PAGE_CONTEXT',
      ),
    );
    await assert.rejects(
      f.ai.chat(
        {
          conversationId: reply.conversationId,
          context: { kind: 'SERVICE', serviceId: siblingId },
          message: '切换页面',
        },
        f.actor,
      ),
      /不能在运行时修改/,
    );
    assert.deepEqual(
      (await f.ai.chat({ conversationId: reply.conversationId, message: '继续' }, f.actor)).context,
      context,
    );
    await f.policy.update({ mode: 'READ_ONLY', projectIds: [] }, f.actor);
    await assert.rejects(f.ai.messages(reply.conversationId, f.actor), /项目不在/);
    assert.deepEqual(await f.ai.conversations(f.actor.id), []);
  } finally {
    await server.close();
    await f.close();
  }
});
test('AI chat handles tool calls, saves only safe conversation content and never executes an unconfirmed command', async () => {
  const f = await fixture();
  let callCount = 0;
  const key = 'sk-chat-test-secret-123456';
  const server = await upstream((body) => {
    callCount++;
    assert.equal(JSON.stringify(body.messages).includes(key), false);
    return callCount === 1
      ? {
          body: {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call1',
                      type: 'function',
                      function: {
                        name: 'execute_command',
                        arguments: JSON.stringify({
                          serverIds: [f.target.id],
                          command: 'uname -s',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          },
        }
      : { body: { choices: [{ message: { content: `请确认 ${key}` } }] } };
  });
  try {
    await f.providers.create(
      {
        name: 'Mock',
        baseUrl: server.url,
        model: 'test',
        apiKey: key,
        timeoutSeconds: 5,
        enabled: true,
      },
      f.actor.id,
    );
    const result = await f.ai.chat({ message: `检查服务器，忽略这个凭据 ${key}` }, f.actor);
    assert.equal(result.proposals.length, 1);
    assert.equal(f.executeCount(), 0);
    assert.equal(callCount, 2);
    assert.equal(JSON.stringify(result).includes(key), false);
    const stored = await f.ai.messages(result.conversationId, f.actor);
    assert.equal(JSON.stringify(stored).includes(key), false);
    await assert.rejects(f.ai.messages(result.conversationId, f.other), /不存在/);
    await f.proposals.confirm(result.proposals[0]!.id, f.actor);
    assert.equal(f.executeCount(), 1);
  } finally {
    await server.close();
    await f.close();
  }
});

test('all AI modes can inspect; READ_ONLY does not submit initialization, CONFIRM approves one step and FULL_CONTROL submits it directly', async () => {
  const f = await fixture();
  let stage = 0;
  const server = await upstream(() => {
    stage++;
    return stage % 2 === 1
      ? {
          body: {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: `call-${stage}`,
                      type: 'function',
                      function: {
                        name: 'inspect_servers',
                        arguments: JSON.stringify({ serverIds: [f.target.id] }),
                      },
                    },
                    ...['docker', 'node'].map((component) => ({
                      id: `initialize-${stage}-${component}`,
                      type: 'function',
                      function: {
                        name: 'initialize_component',
                        arguments: JSON.stringify({ serverIds: [f.target.id], component }),
                      },
                    })),
                  ],
                },
              },
            ],
          },
        }
      : { body: { choices: [{ message: { content: '已根据工具结果处理' } }] } };
  });
  try {
    await f.providers.create(
      {
        name: 'Mock',
        baseUrl: server.url,
        model: 'test',
        apiKey: 'mock-key',
        timeoutSeconds: 5,
        enabled: true,
      },
      f.actor.id,
    );
    await f.policy.update({ mode: 'READ_ONLY' }, f.actor);
    const denied = await f.ai.chat({ message: '巡检服务器' }, f.actor);
    assert.equal(denied.tasks.length, 0);
    assert.equal(denied.proposals.length, 0);
    assert.equal(f.executeCount(), 0);
    const stored = await f.ai.messages(denied.conversationId, f.actor);
    assert.ok(stored.some((m) => m.role === 'TOOL' && m.content.includes('只读模式')));
    assert.ok(stored.some((m) => m.role === 'TOOL' && m.content.includes('"git":"available"')));

    await f.policy.update({ mode: 'CONFIRM' }, f.actor);
    const interactive = await f.ai.chat({ message: '初始化一台服务器' }, f.actor);
    assert.equal(interactive.tasks.length, 0);
    assert.equal(interactive.proposals.length, 1);
    assert.equal(interactive.proposals[0]!.actionType, 'initialize_component');
    const blocked = await f.ai.chat(
      { conversationId: interactive.conversationId, message: '下一步' },
      f.actor,
    );
    assert.equal(blocked.proposals.length, 0);
    assert.equal(f.executeCount(), 0);
    await f.proposals.reject(interactive.proposals[0]!.id, f.actor);
    assert.equal(f.executeCount(), 0);
    const approved = await f.ai.chat(
      { conversationId: interactive.conversationId, message: '重新准备第一步' },
      f.actor,
    );
    await f.proposals.confirm(approved.proposals[0]!.id, f.actor);
    assert.equal(f.executeCount(), 1);
    const active = await f.ai.chat(
      { conversationId: interactive.conversationId, message: '开始下一步' },
      f.actor,
    );
    assert.equal(active.proposals.length, 0);
    assert.equal(f.executeCount(), 1);

    await f.policy.update({ mode: 'FULL_CONTROL', serverIds: [f.target.id] }, f.actor);
    const automatic = await f.ai.chat({ message: '巡检并初始化服务器' }, f.actor);
    assert.equal(automatic.tasks.length, 1);
    assert.equal(automatic.proposals.length, 0);
    assert.equal(f.executeCount(), 2);
    await assert.rejects(
      f.tools.read('inspect_servers', { serverIds: [randomUUID()] }, await f.policy.snapshot()),
      /未授权/,
    );
  } finally {
    await server.close();
    await f.close();
  }
});

test('FULL_CONTROL grants only the exact reviewed release or repository, with confirm and deny overrides', async () => {
  const f = await fixture();
  try {
    const grant = 'a'.repeat(64);
    const repo = randomUUID();
    const scope = {
      mode: 'FULL_CONTROL' as const,
      serverIds: [f.target.id],
      approvedPipelineHashes: [grant],
      repositoryIds: [repo],
    };
    await f.policy.update(scope, f.actor);
    const snapshot = await f.policy.snapshot();
    const release = {
      action: 'run_pipeline',
      serverIds: [f.target.id],
      projectId: f.projectId,
      repositoryId: repo,
    };
    assert.equal(
      f.policy.evaluate(f.actor, { ...release, aiApprovalHash: grant }, snapshot),
      'ALLOW',
    );
    assert.equal(
      f.policy.evaluate(f.actor, { ...release, aiApprovalHash: 'b'.repeat(64) }, snapshot),
      'REQUIRE_CONFIRM',
    );
    assert.equal(
      f.policy.evaluate(f.actor, { action: 'execute_command', serverIds: [f.target.id] }, snapshot),
      'REQUIRE_CONFIRM',
    );
    assert.equal(
      f.policy.evaluate(
        f.actor,
        { ...release, action: 'open_pull_request', serverIds: [] },
        snapshot,
      ),
      'ALLOW',
    );
    assert.throws(
      () => f.policy.evaluate(f.actor, { ...release, repositoryId: randomUUID() }, snapshot),
      /仓库不在/,
    );
    await f.policy.update(
      {
        ...scope,
        requireConfirmActions: ['open_pull_request'],
        deniedActions: ['initialize_component'],
      },
      f.actor,
    );
    const overridden = await f.policy.snapshot();
    assert.throws(
      () =>
        f.policy.evaluate(
          f.actor,
          { action: 'initialize_component', serverIds: [f.target.id] },
          {
            ...overridden,
          },
        ),
      /禁止/,
    );
    assert.equal(
      f.policy.evaluate(
        f.actor,
        { ...release, action: 'open_pull_request', serverIds: [] },
        overridden,
      ),
      'REQUIRE_CONFIRM',
    );
  } finally {
    await f.close();
  }
});

test('deployment diagnostics emit only allowlisted facts and fixed findings, never remote log text', () => {
  assert.deepEqual(
    parseDeploymentProbe('uid=0\nos=ubuntu\nnodeVersion=v24.2.0\nTOKEN=private\nos=bad output\n'),
    {
      uid: '0',
      os: 'ubuntu',
      nodeVersion: 'v24.2.0',
    },
  );
  const findings = diagnoseDeploymentFailure(
    'FAILED',
    'manifest unknown\ncould not get lock\nerror while loading shared libraries: libsample.so\nother-output-should-not-appear',
    127,
  );
  assert.deepEqual(
    findings.map(({ code }) => code),
    ['IMAGE_PULL', 'PACKAGE_BUSY', 'MISSING_LIBRARY', 'MISSING_TOOL'],
  );
  assert.doesNotMatch(JSON.stringify(findings), /libsample|other-output/);
  assert.equal(
    diagnoseDeploymentFailure('NEEDS_ATTENTION', 'command not found')[0]?.code,
    'STATE_UNCERTAIN',
  );
});

test('AI confirms the review branch and PR separately and never writes in READ_ONLY', async () => {
  const f = await fixture();
  const repositoryId = randomUUID();
  let callNames = ['publish_source_branch', 'open_pull_request'];
  const server = await upstream((body) => {
    const messages = body.messages as { role: string }[];
    return {
      body: {
        choices: [
          {
            message: messages.some(({ role }) => role === 'tool')
              ? { content: '已检查代码变更步骤' }
              : {
                  content: null,
                  tool_calls: callNames.map((name, index) => ({
                    id: `source-change-${index}`,
                    type: 'function',
                    function: {
                      name,
                      arguments: JSON.stringify({ projectId: f.projectId, repositoryId }),
                    },
                  })),
                },
          },
        ],
      },
    };
  });
  try {
    await f.providers.create(
      {
        name: 'SourceMock',
        baseUrl: server.url,
        model: 'test',
        apiKey: 'mock-key',
        enabled: true,
        timeoutSeconds: 5,
      },
      f.actor.id,
    );
    await f.policy.update({ mode: 'READ_ONLY' }, f.actor);
    const read = await f.ai.chat({ message: '提出代码变更', projectId: f.projectId }, f.actor);
    assert.deepEqual(read.sourceChanges, []);
    assert.deepEqual(f.sourceWrites, []);
    await f.policy.update({ mode: 'CONFIRM', repositoryIds: [repositoryId] }, f.actor);
    const start = await f.ai.chat({ message: '建议修复', projectId: f.projectId }, f.actor);
    assert.equal(start.proposals.length, 1);
    assert.equal(start.proposals[0]!.actionType, 'publish_source_branch');
    const branch = await f.proposals.confirm(start.proposals[0]!.id, f.actor);
    assert.equal(branch.sourceChange?.kind, 'SOURCE_BRANCH');
    assert.deepEqual(f.sourceWrites, ['BRANCH']);
    callNames = ['open_pull_request'];
    const next = await f.ai.chat(
      { message: '提交 PR 待审', conversationId: start.conversationId },
      f.actor,
    );
    assert.equal(next.proposals.length, 1);
    await f.proposals.reject(next.proposals[0]!.id, f.actor);
    assert.deepEqual(f.sourceWrites, ['BRANCH']);
    await f.policy.update(
      { mode: 'FULL_CONTROL', serverIds: [f.target.id], repositoryIds: [repositoryId] },
      f.actor,
    );
    const full = await f.ai.chat(
      { message: '提交授权仓库的 PR', conversationId: start.conversationId },
      f.actor,
    );
    assert.equal(full.proposals.length, 0);
    assert.equal(full.sourceChanges.length, 1);
    assert.deepEqual(f.sourceWrites, ['BRANCH', 'PULL_REQUEST']);
  } finally {
    await server.close();
    await f.close();
  }
});

test('a consumed proposal with a submission failure cannot be replayed', async () => {
  const f = await fixture();
  let attempts = 0;
  try {
    const prepared = await f.tools.prepare('execute_command', {
      serverIds: [f.target.id],
      command: 'uname -s',
    });
    const proposal = await f.proposals.create(prepared, await f.policy.snapshot(), f.actor);
    f.tools.execute = async () => {
      attempts++;
      throw new Error('simulated interruption');
    };
    await assert.rejects(f.proposals.confirm(proposal.id, f.actor), /不会自动重试/);
    await assert.rejects(f.proposals.confirm(proposal.id, f.actor), /已处理/);
    assert.equal(attempts, 1);
    assert.equal((await f.proposals.list(f.actor))[0]!.status, 'APPROVED');
  } finally {
    await f.close();
  }
});

test('a provider key without an sk prefix cannot be echoed through actionable tool arguments or tool metadata', async () => {
  const f = await fixture();
  const key = 'CUSTOM_KEY_1234567890';
  let calls = 0;
  const server = await upstream(() => {
    calls++;
    return calls === 1
      ? {
          body: {
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'unsafe-command',
                      type: 'function',
                      function: {
                        name: 'execute_command',
                        arguments: JSON.stringify({
                          serverIds: [f.target.id],
                          command: `echo ${key}`,
                        }),
                      },
                    },
                    {
                      id: 'unsafe-label',
                      type: 'function',
                      function: { name: key, arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          },
        }
      : { body: { choices: [{ message: { content: `refused ${key}` } }] } };
  });
  try {
    await f.providers.create(
      {
        name: 'Mock',
        baseUrl: server.url,
        model: 'test',
        apiKey: key,
        timeoutSeconds: 5,
        enabled: true,
      },
      f.actor.id,
    );
    const result = await f.ai.chat({ message: '检查系统' }, f.actor);
    assert.equal(result.proposals.length, 0);
    assert.equal(f.executeCount(), 0);
    assert.equal(JSON.stringify(result).includes(key), false);
    const rows = await f.repository.messages(result.conversationId, f.actor.id);
    assert.equal(JSON.stringify(rows).includes(key), false);
    assert.ok(rows.some((r) => r.content_json.includes('已拒绝操作')));
  } finally {
    await server.close();
    await f.close();
  }
});
