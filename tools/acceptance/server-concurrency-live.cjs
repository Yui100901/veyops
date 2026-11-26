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
  await call('PATCH', '/system', { maxConcurrentFlowsPerServer: 2 });
  const project = await post('/projects', {
    name: '单机队列隔离验收',
    slug: 'flow-capacity-' + randomUUID().slice(0, 8),
  });
  const projectPath = '/projects/' + project.id;
  const graph = projectPath + '/execution-graph';
  const config = await get(graph);
  const chains = [ids[0], ids[0], ids[0], ids[1], ids[2]].map((serverId, i) => {
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
  let details;
  for (const until = Date.now() + 120000; Date.now() < until;) {
    details = await Promise.all(runs.map((run) => get(graph + '/runs/' + run)));
    assert.ok(
      details.every(({ status }) => ['RUNNING', 'QUEUED', 'WAITING', 'SUCCESS'].includes(status)),
      JSON.stringify(
        details.map(({ status, nodes }) => ({
          status,
          nodes: nodes.map(({ name, status, log }) => ({ name, status, log })),
        })),
      ),
    );
    if (details.every(({ status }) => status === 'SUCCESS')) break;
    await delay(1200);
  }
  assert.ok(details.every(({ status }) => status === 'SUCCESS'));
  const actions = details.map(({ nodes, simplified }) => {
    const node = nodes.find(({ type }) => type === 'SHELL');
    return {
      startedAt: node.startedAt,
      finishedAt: node.finishedAt,
      serverId: simplified.serverId,
    };
  });
  assert.deepEqual(
    actions.map(({ serverId }) => serverId),
    [ids[0], ids[0], ids[0], ids[1], ids[2]],
  );
  const [a1, a2, a3, b, c] = actions;
  assert.ok(a1.startedAt <= a2.startedAt);
  assert.ok(a2.startedAt < a1.finishedAt, 'A allows two simultaneous runs');
  assert.ok(a3.startedAt >= Math.min(a1.finishedAt, a2.finishedAt), 'Third run on A queues');
  assert.ok(
    Math.max(b.startedAt, c.startedAt) < Math.min(a1.finishedAt, a2.finishedAt),
    'B and C start independently of A',
  );
  await call('DELETE', projectPath);
  console.log(JSON.stringify({ maxConcurrentFlowsPerServer: 2, runs, actions }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
