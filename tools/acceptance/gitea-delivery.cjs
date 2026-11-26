const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve, sep } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const giteaBase = new URL(process.env.VEYOPS_ACCEPT_GITEA_URL || 'http://192.168.31.40:3000');
const veyopsBase = new URL(
  process.env.VEYOPS_ACCEPT_GITEA_VEYOPS_URL || 'http://192.168.31.40:3184',
);
const user = process.env.VEYOPS_ACCEPT_GITEA_USER || 'yfy';
const password = process.env.VEYOPS_GITEA_PASSWORD;
const statePath = resolve(
  process.env.VEYOPS_ACCEPT_GITEA_STATE || 'data/local-test/veyops-gitea-acceptance.json',
);
const definitions = [
  { key: 'fullstack', suffix: 'fullstack', name: '前后端并行发布' },
  { key: 'dependency', suffix: 'dependency', name: '同项目链依赖' },
  { key: 'poll', suffix: 'poll', name: '源码轮询与推送' },
];

class FixtureFailure extends Error {}

function basic(username, secret) {
  return 'Basic ' + Buffer.from(username + ':' + secret).toString('base64');
}

async function json(base, path, method, body, headers = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      accept: 'application/json',
      ...headers,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      `${method} ${path} -> ${response.status} ${payload?.error?.message ?? payload?.message ?? ''}`,
    );
  return { response, payload };
}

async function gitea(path, method = 'GET', body) {
  assert.ok(password, 'Supply VEYOPS_GITEA_PASSWORD in the process environment.');
  return (
    await json(giteaBase, '/api/v1' + path, method, body, { authorization: basic(user, password) })
  ).payload;
}

function state() {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

function save(value) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function git(directory, ...args) {
  assert.ok(password, 'Supply VEYOPS_GITEA_PASSWORD in the process environment.');
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      cwd: directory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${giteaBase.origin}/.extraHeader`,
        GIT_CONFIG_VALUE_0: 'Authorization: ' + basic(user, password),
      },
    }).trim();
  } catch (error) {
    throw new Error(`Git ${args[0]} failed (${error.status ?? error.code ?? 'unknown'}).`);
  }
}

function worktree(action) {
  const temporaryRoot = realpathSync(tmpdir());
  const pending = realpathSync(mkdtempSync(join(temporaryRoot, 'veyops-gitea-fixture-')));
  assert.ok(pending.startsWith(temporaryRoot + sep + 'veyops-gitea-fixture-'));
  try {
    return action(pending);
  } finally {
    rmSync(pending, { recursive: true, force: true });
  }
}

function write(directory, name, content) {
  const path = join(directory, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(directory, kind) {
  write(directory, 'README.md', '# VeyOps isolated deployment fixture\n');
  write(directory, 'marker.txt', 'baseline\n');
  if (kind !== 'fullstack') return;
  write(
    directory,
    'frontend/index.html',
    '<!doctype html><html lang="zh"><meta charset="utf-8"><main>VeyOps frontend</main></html>\n',
  );
  write(
    directory,
    'frontend/Dockerfile',
    [
      'FROM busybox:1.36',
      'WORKDIR /site',
      'COPY index.html .',
      'CMD ["httpd", "-f", "-p", "8080", "-h", "/site"]',
      '',
    ].join('\n'),
  );
  write(
    directory,
    'backend/cgi-bin/status',
    [
      '#!/bin/sh',
      'printf \'Content-Type: application/json\\r\\n\\r\\n{"service":"backend","status":"ok"}\\n\'',
      '',
    ].join('\n'),
  );
  write(
    directory,
    'backend/Dockerfile',
    [
      'FROM busybox:1.36',
      'WORKDIR /app',
      'COPY cgi-bin/ cgi-bin/',
      'RUN chmod 0755 cgi-bin/status',
      'CMD ["httpd", "-f", "-p", "8080", "-h", "/app"]',
      '',
    ].join('\n'),
  );
  write(
    directory,
    'compose.yaml',
    [
      'services:',
      '  frontend:',
      '    image: ${VEYOPS_IMAGE_FRONTEND}',
      '    healthcheck:',
      '      test: ["CMD-SHELL", "wget -q -O - http://127.0.0.1:8080/ | grep -q frontend"]',
      '      interval: 1s',
      '      timeout: 2s',
      '      retries: 10',
      '  backend:',
      '    image: ${VEYOPS_IMAGE_BACKEND}',
      '    healthcheck:',
      '      test: ["CMD-SHELL", "wget -q -O - http://127.0.0.1:8080/cgi-bin/status | grep -q backend"]',
      '      interval: 1s',
      '      timeout: 2s',
      '      retries: 10',
      '',
    ].join('\n'),
  );
}

function commit(directory, message) {
  git(directory, 'add', '.');
  git(
    directory,
    '-c',
    'user.name=VeyOps Acceptance',
    '-c',
    'user.email=acceptance@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '-m',
    message,
  );
  return git(directory, 'rev-parse', 'HEAD');
}

function repoPath(repo) {
  return '/repos/' + repo.fullName.split('/').map(encodeURIComponent).join('/');
}

async function until(description, action, timeout = 300_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      if (error instanceof FixtureFailure) throw error;
      last = error.message;
    }
    await sleep(2000);
  }
  throw new Error(description + ' timed out' + (last ? ' · ' + last : ''));
}

async function seed() {
  const assigned = await gitea('/user');
  assert.equal(assigned.login, user);
  const prefix = 'veyops-accept-' + Date.now().toString(36) + '-' + randomUUID().slice(0, 4);
  const plan = existsSync(statePath)
    ? state()
    : { prefix, giteaBase: giteaBase.origin, user, repositories: {} };
  assert.equal(plan.giteaBase, giteaBase.origin);
  assert.equal(plan.user, user);
  save(plan);
  for (const item of definitions) {
    const name = plan.prefix + '-' + item.suffix;
    let record = plan.repositories[item.key];
    if (!record) {
      const repo = await gitea('/user/repos', 'POST', {
        name,
        private: true,
        auto_init: false,
        default_branch: 'main',
        description: 'Isolated VeyOps delivery acceptance fixture',
      });
      assert.equal(repo.private, true);
      assert.equal(repo.full_name, user + '/' + name);
      record = {
        name,
        fullName: repo.full_name,
        cloneUrl: `${giteaBase.origin}/${repo.full_name}.git`,
      };
      plan.repositories[item.key] = record;
      save(plan);
    }
    if (record.seedCommit) continue;
    record.seedCommit = worktree((directory) => {
      const existing = git(directory, 'ls-remote', record.cloneUrl, 'refs/heads/main').split(
        /\s+/,
      )[0];
      if (existing) {
        if (
          item.key === 'poll' &&
          !git(directory, 'ls-remote', record.cloneUrl, 'refs/heads/poll-demo')
        ) {
          git(directory, 'clone', '--single-branch', '--branch', 'main', record.cloneUrl, '.');
          git(directory, 'push', 'origin', 'HEAD:refs/heads/poll-demo');
        }
        return existing;
      }
      git(directory, 'init', '--initial-branch=main');
      git(directory, 'config', 'core.autocrlf', 'false');
      fixture(directory, item.key);
      const sha = commit(directory, 'Seed VeyOps delivery fixture');
      git(directory, 'remote', 'add', 'origin', record.cloneUrl);
      git(directory, 'push', 'origin', 'HEAD:refs/heads/main');
      if (item.key === 'poll') git(directory, 'push', 'origin', 'HEAD:refs/heads/poll-demo');
      return sha;
    });
    const branch = await until(
      'Gitea main branch index',
      () => gitea(repoPath(record) + '/branches/main'),
      30_000,
    );
    assert.equal(branch.commit.id, record.seedCommit);
    save(plan);
  }
  console.log(
    JSON.stringify({
      command: 'seed',
      state: statePath,
      repositories: Object.fromEntries(
        Object.entries(plan.repositories).map(([key, { fullName, seedCommit }]) => [
          key,
          { fullName, seedCommit },
        ]),
      ),
    }),
  );
}

async function application() {
  const secret = process.env.VEYOPS_ACCEPT_PREVIEW_ADMIN_PASSWORD;
  assert.ok(secret, 'Supply VEYOPS_ACCEPT_PREVIEW_ADMIN_PASSWORD in the process environment.');
  let cookie = '';
  const call = async (method, path, body) => {
    const { response, payload } = await json(
      veyopsBase,
      '/api/v1' + path,
      method,
      body,
      cookie ? { cookie } : {},
    );
    const cookies = response.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((entry) => entry.split(';')[0]).join('; ');
    return payload.data;
  };
  const post = (path, body) => call('POST', path, body);
  const get = (path) => call('GET', path);
  const login = await post('/auth/login', {
    username: process.env.VEYOPS_ACCEPT_PREVIEW_ADMIN_USER || 'root',
    password: secret,
  });
  assert.equal(login.role, 'ADMIN');
  return { call, get, post };
}

function graphPath(record) {
  return '/projects/' + record.projectId + '/execution-graph';
}

function makeCanvas(kind, record, servers, prefix) {
  const nodes = [];
  const edges = [];
  const endpoints = [];
  const add = (id, type, name, position, config = {}) =>
    nodes.push({ id, type, name, position, ...config });
  function connect(...ids) {
    for (let i = 1; i < ids.length; i++) edges.push({ from: ids[i - 1], to: ids[i] });
  }
  function start(id, name, serverId, branch, y, release) {
    add(
      id,
      'START',
      name,
      { x: 24, y },
      {
        start: {
          sources: [
            {
              id: 'source',
              repositoryId: record.repositoryId,
              ref: { kind: 'BRANCH', value: branch },
            },
          ],
          execution: { serverId },
          ...(release && { release }),
        },
      },
    );
  }
  function checkout(id, y) {
    add(id, 'CHECKOUT', '代码拉取', { x: 250, y });
  }
  function buildFlow(id, label, serverId, branch, y) {
    start(id, label, serverId, branch, y);
    checkout(id + '-checkout', y);
    add(
      id + '-build',
      'BUILD',
      '构建目录产物',
      { x: 480, y },
      {
        build: {
          repoPath: record.name,
          buildCommand: 'set -eu\nmkdir -p dist\ncp marker.txt dist/build.txt',
        },
      },
    );
    add(id + '-end', 'END', label + '完成', { x: 710, y }, { finish: { saveWorkspace: true } });
    connect(id, id + '-checkout', id + '-build', id + '-end');
    endpoints.push({ startId: id, endId: id + '-end' });
  }
  if (kind === 'fullstack') {
    const y = 132;
    start('fullstack', '并行构建并发布', servers['test-a'], 'main', y, {
      serviceId: record.serviceId,
      imageIds: ['frontend', 'backend'],
      compose: { path: record.name + '/compose.yaml' },
    });
    checkout('checkout', y);
    add('fork', 'PARALLEL', '并行分叉', { x: 480, y });
    for (const [component, label, branchY] of [
      ['frontend', '前端镜像', 72],
      ['backend', '后端镜像', 192],
    ]) {
      add(
        component,
        'BUILD',
        label,
        { x: 710, y: branchY },
        {
          build: { repoPath: record.name + '/' + component, dockerfilePath: 'Dockerfile' },
        },
      );
    }
    add('join', 'JOIN', '汇合镜像', { x: 940, y });
    add(
      'deploy',
      'DEPLOY_ARTIFACT',
      'Compose 发布',
      { x: 1170, y },
      { deploy: { method: 'COMPOSE' } },
    );
    add(
      'end',
      'END',
      '发布完成',
      { x: 1400, y },
      {
        finish: {
          saveWorkspace: false,
          requireRelease: 'ACTIVATED',
          images: ['frontend', 'backend'].map((id) => ({
            id,
            name: prefix + '-' + id,
            source: 'BUILT_IN',
            buildNodeId: id,
          })),
        },
      },
    );
    connect('fullstack', 'checkout', 'fork');
    connect('fork', 'frontend', 'join');
    connect('fork', 'backend', 'join');
    connect('join', 'deploy', 'end');
    endpoints.push({ startId: 'fullstack', endId: 'end' });
  } else if (kind === 'dependency') {
    buildFlow('build-a', '构建链 A', servers['test-b'], 'main', 75);
    buildFlow('build-b', '构建链 B', servers['production-a'], 'main', 245);
  } else {
    buildFlow('hook-build', '推送构建', servers['production-a'], 'main', 75);
    buildFlow('poll-build', '轮询构建', servers['test-b'], 'poll-demo', 245);
  }
  return { model: 'FLOW_V2', nodes, edges, endpoints, templates: [] };
}

async function registerRule(api, path, body) {
  const existing = (await api.get(path)).find((rule) => rule.name === body.name);
  if (existing) {
    assert.equal(existing.kind, body.kind);
    assert.equal(existing.flowId, body.flowId);
    assert.equal(existing.enabled, true);
    return existing;
  }
  const check = await api.post(path + '/preflight', body);
  assert.equal(check.eligible, true, JSON.stringify(check.issue));
  return api.post(path, body);
}

async function configureHook(api, record, name, flowId) {
  const path = graphPath(record) + '/triggers';
  const hookRule = await registerRule(api, path, {
    name,
    kind: 'WEBHOOK',
    webhookProtocol: 'GITEA',
    flowId,
    sourceId: 'source',
    version: record.version,
    enabled: true,
  });
  const hookUrl = new URL(hookRule.receivePath, veyopsBase);
  if (record.giteaHookId) {
    const configured = await gitea(repoPath(record) + '/hooks/' + record.giteaHookId);
    assert.equal(configured.config.url, hookUrl.href);
    assert.equal(configured.active, true);
    return hookRule;
  }
  const secret =
    hookRule.secret ?? (await api.post(path + '/' + hookRule.id + '/rotate-secret', {})).secret;
  assert.ok(secret, 'Gitea hook rule did not return a signing secret.');
  const hooks = await gitea(repoPath(record) + '/hooks');
  const existing = hooks.find((hook) => hook.config?.url === hookUrl.href);
  const hook = await gitea(
    repoPath(record) + '/hooks' + (existing ? '/' + existing.id : ''),
    existing ? 'PATCH' : 'POST',
    {
      ...(!existing && { type: 'gitea' }),
      config: { url: hookUrl.href, content_type: 'json', secret, http_method: 'POST' },
      events: ['push'],
      active: true,
    },
  );
  assert.ok(hook.id);
  record.giteaHookId = hook.id;
  return hookRule;
}

async function configure() {
  const plan = state();
  assert.equal(plan.giteaBase, giteaBase.origin);
  assert.ok(definitions.every(({ key }) => plan.repositories[key]?.seedCommit));
  if (plan.veyopsBase) assert.equal(plan.veyopsBase, veyopsBase.origin);
  plan.veyopsBase = veyopsBase.origin;
  const api = await application();
  const servers = {};
  const fixtureTargets = ['test-a', 'test-b', 'production-a'];
  for (const host of fixtureTargets) {
    const server = (await api.get('/servers')).find(
      (item) => item.host === host && item.name === 'Flow V2 ' + host,
    );
    assert.ok(server, 'Missing isolated fixture target ' + host);
    servers[host] = server.id;
    await api.call('PATCH', '/servers/' + server.id + '/automatic-execution', { enabled: true });
  }
  if (!plan.credentialId) {
    const credential = await api.post('/credentials', {
      name: plan.prefix + ' private Gitea',
      type: 'GIT_PASSWORD',
      secret: { username: user, password },
    });
    plan.credentialId = credential.id;
    save(plan);
  }
  for (const item of definitions) {
    const record = plan.repositories[item.key];
    if (!record.projectId) {
      const project = await api.post('/projects', {
        slug: record.name,
        name: item.name + ' · Gitea 验收',
      });
      record.projectId = project.id;
      save(plan);
    }
    const project = '/projects/' + record.projectId;
    if (!record.repositoryId) {
      const repository = await api.post(project + '/repositories', {
        name: '私有 Gitea 测试源码',
        cloneUrl: record.cloneUrl,
        credentialId: plan.credentialId,
        provider: 'GITEA',
      });
      record.repositoryId = repository.id;
      save(plan);
    }
    if (item.key === 'fullstack' && !record.serviceId) {
      const service = await api.post(project + '/services', {
        slug: 'web-stack',
        name: '前后端 Compose',
        serviceType: 'WEB',
      });
      record.serviceId = service.id;
      save(plan);
    }
    const graph = graphPath(record);
    if (!record.version) {
      const { revision } = await api.get(graph);
      const canvas = makeCanvas(item.key, record, servers, plan.prefix);
      const saved = await api.call('PUT', graph + '/draft', {
        expectedRevision: revision,
        definition: { canvas },
      });
      record.version = (
        await api.post(graph + '/publish', { expectedRevision: saved.revision })
      ).publishedVersion;
      save(plan);
    }
    const flowId = { fullstack: 'fullstack', dependency: 'build-a', poll: 'hook-build' }[item.key];
    const hook = await configureHook(api, record, 'Gitea push · main', flowId);
    record.hookRuleId = hook.id;
    save(plan);
    if (item.key === 'dependency') {
      const rule = await registerRule(api, graph + '/triggers', {
        name: 'A 构建成功后运行 B',
        kind: 'UPSTREAM',
        flowId: 'build-b',
        upstreamFlowId: 'build-a',
        upstreamStatus: 'SUCCESS',
        version: record.version,
        enabled: true,
      });
      record.upstreamRuleId = rule.id;
      save(plan);
    }
    if (item.key === 'poll') {
      const rule = await registerRule(api, graph + '/triggers', {
        name: '观察 poll-demo 分支变更',
        kind: 'CRON',
        cronMode: 'POLL',
        cron: '* * * * *',
        timeZone: 'Asia/Shanghai',
        buildOnFirstObservation: false,
        flowId: 'poll-build',
        sourceId: 'source',
        version: record.version,
        enabled: true,
      });
      record.pollRuleId = rule.id;
      save(plan);
    }
    console.log(
      JSON.stringify({
        command: 'configured',
        fixture: item.key,
        projectId: record.projectId,
        version: record.version,
        hookId: record.giteaHookId,
      }),
    );
  }
}

function push(record, branch, testName) {
  return worktree((directory) => {
    git(
      directory,
      'clone',
      '--no-tags',
      '--single-branch',
      '--branch',
      branch,
      record.cloneUrl,
      '.',
    );
    git(directory, 'config', 'core.autocrlf', 'false');
    const marker = testName + '-' + randomUUID().slice(0, 8);
    write(directory, 'marker.txt', marker + '\n');
    if (testName === 'fullstack') {
      write(
        directory,
        'frontend/index.html',
        '<!doctype html><meta charset="utf-8"><main>VeyOps frontend ' + marker + '</main>\n',
      );
      write(
        directory,
        'backend/cgi-bin/status',
        [
          '#!/bin/sh',
          'printf \'Content-Type: application/json\\r\\n\\r\\n{"service":"backend","status":"ok","revision":"' +
            marker +
            '"}\\n\'',
          '',
        ].join('\n'),
      );
      for (const component of ['frontend', 'backend']) {
        const dockerfile = component + '/Dockerfile';
        const source = readFileSync(join(directory, dockerfile), 'utf8');
        if (!source.includes('RUN sleep 3'))
          write(directory, dockerfile, source.replace('CMD ', 'RUN sleep 3\nCMD '));
      }
    }
    const sha = commit(directory, 'Exercise ' + testName + ' delivery');
    git(directory, 'push', 'origin', 'HEAD:refs/heads/' + branch);
    return sha;
  });
}

const rulePath = (record, ruleId) => graphPath(record) + '/triggers/' + ruleId;

async function waitEvent(api, record, ruleId, name, matcher, timeout) {
  return until(
    name,
    async () => {
      const events = await api.get(rulePath(record, ruleId) + '/events');
      const event = events.find(matcher);
      if (event?.status === 'REJECTED' || event?.status === 'FAILED')
        throw new FixtureFailure(name + ' rejected: ' + (event.error ?? event.status));
      return event?.runId ? event : undefined;
    },
    timeout,
  );
}

async function waitRun(api, record, runId, kind, sha) {
  const path = graphPath(record) + '/runs/' + runId;
  const run = await until(
    kind + ' run ' + runId,
    async () => {
      const found = await api.get(path);
      if (found.status === 'SUCCESS') return found;
      if (['PENDING', 'QUEUED', 'WAITING', 'RUNNING', 'CANCEL_REQUESTED'].includes(found.status))
        return;
      const failed = found.nodes.find(({ status }) =>
        ['FAILED', 'NEEDS_ATTENTION', 'TIMED_OUT', 'PARTIAL_FAILED'].includes(status),
      );
      const logs = failed && (await api.get(path + '/nodes/' + failed.nodeId + '/logs'));
      throw new FixtureFailure(
        `${kind} run ${runId} ${found.status} ${failed?.name ?? ''} ${String(logs?.content ?? failed?.log ?? '').slice(-850)}`,
      );
    },
    600_000,
  );
  assert.equal(run.triggerType, kind);
  assert.equal(run.simplified.sources[0]?.commitSha, sha);
  return run;
}

function summarize(run, event) {
  return {
    runId: run.id,
    eventId: event.eventId,
    trigger: run.triggerType,
    status: run.status,
    commitSha: run.simplified.sources[0].commitSha,
    serverId: run.simplified.serverId,
  };
}

async function exercise() {
  const plan = state();
  assert.equal(
    plan.veyopsBase,
    veyopsBase.origin,
    'Configure this fixture on the selected preview first.',
  );
  assert.ok(
    definitions.every(({ key }) => plan.repositories[key]?.hookRuleId),
    'Complete configure first.',
  );
  const api = await application();
  const poll = plan.repositories.poll;
  if (!poll.pollSha) {
    const branch = await gitea(repoPath(poll) + '/branches/poll-demo');
    await until(
      'poll-demo baseline observation',
      async () => {
        const rule = (await api.get(graphPath(poll) + '/triggers')).find(
          ({ id }) => id === poll.pollRuleId,
        );
        return rule?.observation?.commitSha === branch.commit.id && rule.observation.lastCheckedAt;
      },
      180_000,
    );
  }

  for (const { key } of definitions) {
    const record = plan.repositories[key];
    if (record.pushSha) continue;
    record.pushSha = push(record, 'main', key);
    save(plan);
    console.log(
      JSON.stringify({ command: 'pushed', fixture: key, branch: 'main', sha: record.pushSha }),
    );
  }
  if (!poll.pollSha) {
    poll.pollSha = push(poll, 'poll-demo', 'poll-source');
    save(plan);
    console.log(
      JSON.stringify({
        command: 'pushed',
        fixture: 'poll',
        branch: 'poll-demo',
        sha: poll.pollSha,
      }),
    );
  }

  const results = await Promise.all(
    definitions.map(async ({ key }) => {
      const record = plan.repositories[key];
      const hook = await waitEvent(
        api,
        record,
        record.hookRuleId,
        key + ' Gitea push',
        (event) =>
          event.metadata?.commitSha === record.pushSha && event.metadata?.ref === 'refs/heads/main',
      );
      const run = await waitRun(api, record, hook.runId, 'WEBHOOK', record.pushSha);
      const evidence = {
        projectId: record.projectId,
        hookId: record.giteaHookId,
        hook: summarize(run, hook),
      };
      if (key === 'fullstack') {
        const built = ['frontend', 'backend'].map((id) =>
          run.nodes.find(({ nodeId }) => nodeId === id),
        );
        assert.ok(built.every((node) => node?.status === 'SUCCESS' && node.taskId));
        const tasks = await Promise.all(built.map(({ taskId }) => api.get('/tasks/' + taskId)));
        const coincident =
          Math.max(...tasks.map(({ startedAt }) => startedAt)) <
          Math.min(...tasks.map(({ finishedAt }) => finishedAt));
        assert.ok(coincident, 'Frontend and backend build execution should overlap.');
        const release = run.nodes.find(({ nodeId }) => nodeId === 'deploy').output.release;
        assert.equal(release.status, 'SUCCESS');
        assert.equal(release.targets.length, 1);
        assert.equal(release.targets[0].serverId, run.simplified.serverId);
        const instances = await api.get(
          '/artifacts?' + new URLSearchParams({ projectId: record.projectId }),
        );
        const images = instances.filter(
          ({ kind, graphRunId }) => kind === 'DOCKER_IMAGE' && graphRunId === run.id,
        );
        assert.equal(images.length, 2);
        assert.ok(
          images.every(
            ({ serverId, sourceCommit }) =>
              serverId === run.simplified.serverId && sourceCommit === record.pushSha,
          ),
        );
        evidence.frontendTaskId = tasks[0].id;
        evidence.backendTaskId = tasks[1].id;
        evidence.parallel = coincident;
        evidence.images = images.map(({ id, name, imageReference }) => ({
          id,
          name,
          imageReference,
        }));
        evidence.release = {
          status: release.status,
          serverId: release.targets[0].serverId,
          deploymentId: release.targets[0].deploymentId,
        };
      }
      if (key === 'dependency') {
        const follow = await waitEvent(
          api,
          record,
          record.upstreamRuleId,
          'Successful A triggered B',
          (event) =>
            event.metadata?.upstreamRunId === run.id &&
            event.metadata?.upstreamStatus === 'SUCCESS',
        );
        const downstream = await waitRun(api, record, follow.runId, 'UPSTREAM', record.pushSha);
        assert.equal(downstream.flowId, 'build-b');
        assert.equal(downstream.trigger.upstreamRunId, run.id);
        assert.notEqual(downstream.simplified.serverId, run.simplified.serverId);
        evidence.upstream = summarize(downstream, follow);
      }
      if (key === 'poll') {
        const observed = await waitEvent(
          api,
          record,
          record.pollRuleId,
          'poll-demo branch change',
          (event) =>
            event.metadata?.commitSha === record.pollSha &&
            event.metadata?.ref === 'refs/heads/poll-demo',
          180_000,
        );
        const polled = await waitRun(api, record, observed.runId, 'CRON', record.pollSha);
        assert.equal(polled.flowId, 'poll-build');
        const unrelated = await api.get(rulePath(record, record.hookRuleId) + '/events');
        assert.ok(
          !unrelated.some((event) => event.runId && event.metadata?.commitSha === record.pollSha),
        );
        evidence.poll = summarize(polled, observed);
      }
      return [key, evidence];
    }),
  );
  plan.evidence = Object.fromEntries(results);
  save(plan);
  console.log(JSON.stringify({ command: 'verified', state: statePath, results: plan.evidence }));
}

async function retryFullstack() {
  const plan = state();
  assert.equal(plan.veyopsBase, veyopsBase.origin);
  const record = plan.repositories.fullstack;
  assert.ok(record.hookRuleId && record.pushSha, 'An earlier fullstack exercise is required.');
  const api = await application();
  const previous = (await api.get(rulePath(record, record.hookRuleId) + '/events')).find(
    (event) => event.metadata?.commitSha === record.pushSha && event.runId,
  );
  assert.ok(
    previous &&
      ['SUCCESS', 'FAILED', 'NEEDS_ATTENTION', 'PARTIAL_FAILED', 'CANCELLED', 'TIMED_OUT'].includes(
        previous.runStatus,
      ),
    'Wait until the previous fullstack run is terminal.',
  );
  record.retryOf = { runId: previous.runId, commitSha: record.pushSha, status: previous.runStatus };
  record.pushSha = push(record, 'main', 'fullstack');
  save(plan);
  console.log(
    JSON.stringify({
      command: 'pushed',
      fixture: 'fullstack',
      branch: 'main',
      sha: record.pushSha,
      retryOf: record.retryOf,
    }),
  );
  await exercise();
}

(async () => {
  if (process.argv[2] === 'seed') await seed();
  else if (process.argv[2] === 'configure') await configure();
  else if (process.argv[2] === 'exercise') await exercise();
  else if (process.argv[2] === 'retry-fullstack') await retryFullstack();
  else
    throw new Error(
      'Usage: node tools/acceptance/gitea-delivery.cjs seed|configure|exercise|retry-fullstack',
    );
})().catch((error) => {
  const secrets = [password, process.env.VEYOPS_ACCEPT_PREVIEW_ADMIN_PASSWORD].filter(Boolean);
  console.error(
    secrets.reduce((message, secret) => message.replaceAll(secret, '[redacted]'), error.message),
  );
  process.exitCode = 1;
});
