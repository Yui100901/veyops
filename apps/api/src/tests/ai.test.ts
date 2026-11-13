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
import { ServersService } from '../modules/servers/servers.service';
import { TasksService } from '../modules/tasks/tasks.service';
import { CommandCenterService } from '../modules/command-center/command-center.service';
import { CurrentUser } from '../modules/auth/auth.decorators';

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
  const projects = new ProjectsService(database, audit);
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
  const tasks = { list: async () => [], targets: async () => [] } as unknown as TasksService;
  const tools = new AiToolsService(servers, projects, tasks, commands, policy, {} as ModuleRef);
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
    async close() {
      await database.onModuleDestroy();
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
    assert.equal(f.executeCount(), 0);
  } finally {
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
    const stored = await f.ai.messages(result.conversationId, f.actor.id);
    assert.equal(JSON.stringify(stored).includes(key), false);
    await assert.rejects(f.ai.messages(result.conversationId, f.other.id), /不存在/);
    await f.proposals.confirm(result.proposals[0]!.id, f.actor);
    assert.equal(f.executeCount(), 1);
  } finally {
    await server.close();
    await f.close();
  }
});

test('FULL_CONTROL runs only registered inspection automatically while READ_ONLY denies execution tool calls', async () => {
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
    await f.policy.update({ mode: 'FULL_CONTROL', serverIds: [f.target.id] }, f.actor);
    const automatic = await f.ai.chat({ message: '巡检服务器' }, f.actor);
    assert.equal(automatic.tasks.length, 1);
    assert.equal(automatic.proposals.length, 0);
    assert.equal(f.executeCount(), 1);
    await f.policy.update({ mode: 'READ_ONLY' }, f.actor);
    const denied = await f.ai.chat({ message: '巡检服务器' }, f.actor);
    assert.equal(denied.tasks.length, 0);
    assert.equal(denied.proposals.length, 0);
    assert.equal(f.executeCount(), 1);
    const stored = await f.ai.messages(denied.conversationId, f.actor.id);
    assert.ok(stored.some((m) => m.role === 'TOOL' && m.content.includes('只读模式')));
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
    assert.equal((await f.proposals.list(f.actor.id))[0]!.status, 'APPROVED');
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
