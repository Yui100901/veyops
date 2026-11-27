const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const base = new URL(process.env.VEYOPS_ACCEPT_URL);
  const password = process.env.VEYOPS_ACCEPT_ADMIN_PASSWORD;
  assert.ok(password);
  const services = ['test-a', 'test-b', 'production-a'];
  let cookie;
  async function call(method, path, body) {
    const response = await fetch(new URL('/api/v1' + path, base), {
      method,
      headers: {
        Origin: base.origin,
        ...(cookie && { Cookie: cookie }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const nextCookie = response.headers.getSetCookie();
    if (nextCookie.length) cookie = nextCookie.map((entry) => entry.split(';', 1)[0]).join('; ');
    const payload = await response.json();
    assert.ok(response.ok, method + ' ' + path + ' ' + payload.error?.message);
    return payload.data;
  }
  const post = (path, body) => call('POST', path, body);
  const get = (path) => call('GET', path);
  await post('/auth/login', { username: 'root', password });
  const servers = await get('/servers');
  const ids = services.map(
    (host) =>
      servers.find((server) => server.host === host && server.name === 'Flow V2 ' + host)?.id,
  );
  assert.ok(ids.every(Boolean), 'Expected three dedicated acceptance targets');
  const previous = (await get('/system')).maxConcurrentFlowsPerServer;
  await call('PATCH', '/system', { maxConcurrentFlowsPerServer: 5 });
  try {
    await verifySharedSlots({ call, post, get, ids });
  } finally {
    await call('PATCH', '/system', { maxConcurrentFlowsPerServer: previous });
  }
}

async function verifySharedSlots({ call, post, get, ids }) {
  const project = await post('/projects', {
    name: '单机队列隔离验收',
    slug: 'flow-capacity-' + randomUUID().slice(0, 8),
  });
  const projectPath = '/projects/' + project.id;
  const graph = projectPath + '/execution-graph';
  const config = await get(graph);
  const chains = [ids[0], ids[0], ids[0]].map((serverId, i) => {
    const index = i + 1;
    const id = 'queue-' + index;
    const command = id + '-work';
    const end = id + '-end';
    return {
      startId: id,
      endId: end,
      nodes: [
        { id, type: 'START', name: '队列运行 ' + index, start: { execution: { serverId } } },
        {
          id: command,
          type: 'FUNCTION',
          operation: 'SHELL',
          name: '占用执行槽 ' + index,
          shell: { command: 'sleep 12' },
        },
        { id: end, type: 'END', name: '完成 ' + index, finish: { saveWorkspace: false } },
      ],
      edges: [
        { from: id, to: command },
        { from: command, to: end },
      ],
    };
  });
  const canvas = {
    model: 'FLOW_V2',
    templates: [],
    nodes: chains.flatMap(({ nodes }) => nodes),
    edges: chains.flatMap(({ edges }) => edges),
    endpoints: chains.map(({ startId, endId }) => ({ startId, endId })),
  };
  const saved = await call('PUT', graph + '/draft', {
    expectedRevision: config.revision,
    definition: { canvas },
  });
  const { publishedVersion: version } = await post(graph + '/publish', {
    expectedRevision: saved.revision,
  });
  const runs = [];
  for (const { startId } of chains) {
    const run = await post(graph + '/flows/' + startId + '/run-defaults', {
      version,
      idempotencyKey: randomUUID(),
    });
    runs.push(run.runId);
  }
  const submit = async (name, serverIds) => {
    const { targetHash } = await post('/commands/preview', { serverIds });
    return (
      await post('/commands/execute', {
        name,
        command: 'sleep 12',
        confirmed: true,
        expectedTargetHash: targetHash,
        serverIds,
      })
    ).id;
  };
  const firstCommand = await submit('验收 · 第一个运维命令', [ids[0]]);
  const secondCommand = await submit('验收 · 第二个运维命令', [ids[0]]);
  const batch = await submit('验收 · 第三个运维命令', ids);
  const tasks = [firstCommand, secondCommand, batch];
  let details, operations;
  for (const until = Date.now() + 120000; Date.now() < until;) {
    [details, operations] = await Promise.all([
      Promise.all(runs.map((run) => get(graph + '/runs/' + run))),
      Promise.all(tasks.map((task) => get('/tasks/' + task))),
    ]);
    assert.ok(
      details.every(({ status }) => ['RUNNING', 'QUEUED', 'WAITING', 'SUCCESS'].includes(status)),
      JSON.stringify(
        details.map(({ status, nodes }) => ({
          status,
          nodes: nodes.map(({ name, status, log }) => ({ name, status, log })),
        })),
      ),
    );
    assert.ok(
      operations.every(({ status }) => ['PENDING', 'RUNNING', 'SUCCESS'].includes(status)),
      JSON.stringify(operations),
    );
    if ([...details, ...operations].every(({ status }) => status === 'SUCCESS')) break;
    await delay(1200);
  }
  assert.ok([...details, ...operations].every(({ status }) => status === 'SUCCESS'));
  const flows = details.map(({ nodes, simplified }) => {
    const node = nodes.find(({ type }) => type === 'SHELL');
    return {
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      serverId: simplified.serverId,
    };
  });
  const commandTargets = await Promise.all(tasks.map((task) => get('/tasks/' + task + '/targets')));
  assert.deepEqual(
    flows.map(({ serverId }) => serverId),
    [ids[0], ids[0], ids[0]],
  );
  const firstFive = [...flows, commandTargets[0][0], commandTargets[1][0]];
  const firstSlotRelease = Math.min(...firstFive.map(({ finishedAt }) => finishedAt));
  assert.ok(
    Math.max(...firstFive.map(({ startedAt }) => startedAt)) < firstSlotRelease,
    'A runs three flows and two commands at once',
  );
  const last = commandTargets[2].find(({ serverId }) => serverId === ids[0]);
  assert.ok(last.startedAt >= firstSlotRelease, 'Sixth task on A waits for a shared slot');
  assert.ok(
    commandTargets[2].filter(({ serverId }) => serverId !== ids[0]).length === 2 &&
      commandTargets[2]
        .filter(({ serverId }) => serverId !== ids[0])
        .every(({ startedAt }) => startedAt < firstSlotRelease),
    'B and C start even when the same command is waiting for A',
  );
  await call('DELETE', projectPath);
  console.log(
    JSON.stringify({ maxConcurrentFlowsPerServer: 5, runs, tasks, flows, commandTargets }),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
