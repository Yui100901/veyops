const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');
const { promisify } = require('node:util');
const { Client } = require('ssh2');

const pollCleanup = async (api, path, expected) => {
  const deadline = Date.now() + 30_000;
  do {
    const job = await api.get(path);
    assert.equal(job.instances.length, 1);
    if (job.instances[0].status === expected) return job;
    assert.notEqual(job.status, 'COMPLETE', '清理任务提前结束');
    await sleep(200);
  } while (Date.now() < deadline);
  throw new Error(`清理任务未进入 ${expected}`);
};

async function openTestSftp(target) {
  assert.equal(target.host, 'test-a', '恢复验收只允许操作专用测试主机');
  const client = new Client();
  try {
    await new Promise((resolve, reject) => {
      client
        .on('error', reject)
        .once('ready', resolve)
        .connect({
          host: target.host,
          username: target.username,
          privateKey: target.privateKey,
          readyTimeout: 8000,
          hostVerifier: (key) =>
            'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') ===
            target.hostKeyFingerprint,
        });
    });
    const sftp = await promisify(client.sftp).call(client);
    return {
      close: () => client.end(),
      lstat: promisify(sftp.lstat).bind(sftp),
      rename: promisify(sftp.rename).bind(sftp),
      unlink: promisify(sftp.unlink).bind(sftp),
      writeFile: promisify(sftp.writeFile).bind(sftp),
    };
  } catch (error) {
    client.destroy();
    throw error;
  }
}

async function verifyArtifactRecovery(api, artifact, fixture, target, differentArtifact) {
  assert.equal(artifact.instances.length, 2);
  const instance = artifact.instances.find(
    ({ serverId }) => serverId === fixture.serverIds['test-a'],
  );
  const peer = artifact.instances.find(({ serverId }) => serverId === fixture.serverIds['test-b']);
  assert.ok(instance && peer);
  assert.equal(instance.projectId, fixture.projectId);
  assert.equal(instance.kind, 'FILE');
  assert.match(instance.id, /^[0-9a-f-]{36}$/i);
  assert.equal(instance.physical.location, 'SERVER_PATH');
  assert.equal(instance.physical.owner, 'MANAGED');
  assert.equal(instance.physical.serverId, instance.serverId);
  const path = `/root/.veyops/artifacts/${instance.id}/payload`;
  assert.equal(instance.physical.path, path);

  const verifyPath = '/artifacts/' + artifact.artifactId;
  const refs = [{ artifactId: artifact.artifactId, instanceId: instance.id }];
  const retention = '/artifact-retention';
  const checks = [];
  const expectVerification = async (expected) => {
    const verified = await api.post(verifyPath + '/verify', {});
    assert.equal(verified.artifactId, artifact.artifactId);
    assert.equal(verified.instances.length, 2);
    const row = verified.instances.find(({ id }) => id === instance.id);
    assert.equal(row.verificationStatus, expected);
    assert.ok(Number.isSafeInteger(row.verifiedAt));
    assert.ok(
      verified.instances.some(
        ({ id, verificationStatus }) => id === peer.id && verificationStatus === 'AVAILABLE',
      ),
    );
    if (expected !== 'AVAILABLE') assert.ok(row.verificationReason);
    const saved = (await api.get(verifyPath)).instances.find(({ id }) => id === instance.id);
    assert.equal(saved.verificationStatus, row.verificationStatus);
    assert.equal(saved.verifiedAt, row.verifiedAt);
    checks.push({
      status: row.verificationStatus,
      reason: row.verificationReason,
      checkedAt: row.verifiedAt,
    });
  };

  const unrelatedId = differentArtifact.instances.find(
    ({ serverId }) => serverId === instance.serverId,
  )?.id;
  assert.ok(unrelatedId && unrelatedId !== instance.id);
  await api.call('POST', verifyPath + '/verify', { instanceIds: [unrelatedId] }, 400);
  await api.call(
    'POST',
    retention + '/preview',
    {
      artifacts: [{ artifactId: artifact.artifactId, instanceId: unrelatedId }],
    },
    404,
  );
  const wrongSelection = await api.request(
    'POST',
    '/projects/' + fixture.projectId + '/execution-graph/flows/deploy-existing/preview',
    {
      version: fixture.version,
      inputs: {
        parameters: {
          artifact: { artifactId: differentArtifact.artifactId, instanceId: instance.id },
        },
      },
    },
  );
  assert.equal(wrongSelection.status, 400);
  const { planIssue: rejection } = (await wrongSelection.json()).error;
  assert.equal(rejection.code, 'ARTIFACT');
  assert.equal(rejection.flowId, 'deploy-existing');
  assert.equal(rejection.fieldId, 'artifact');
  assert.equal(rejection.parameterId, 'artifact');

  const sftp = await openTestSftp(target);
  try {
    await expectVerification('AVAILABLE');
    assert.ok((await sftp.lstat(path)).isFile());
    const hold = path + '.acceptance-hold';
    await assert.rejects(() => sftp.lstat(hold), { code: 2 });
    await sftp.rename(path, hold);
    try {
      await expectVerification('MISSING');
      await sftp.writeFile(path, 'veyops acceptance replacement\n', { flag: 'wx', mode: 0o600 });
      try {
        await expectVerification('CHANGED');
      } finally {
        await sftp.unlink(path);
      }
    } finally {
      await sftp.rename(hold, path);
    }
    await expectVerification('AVAILABLE');

    const preview = await api.post(retention + '/preview', { artifacts: refs });
    assert.equal(preview.eligibleCount, 1);
    assert.equal(preview.instances.length, 1);
    assert.equal(preview.instances[0].instanceId, instance.id);
    assert.equal(preview.instances[0].action, 'REMOVE');
    assert.match(preview.planDigest, /^[0-9a-f]{64}$/);
    const confirmation = {
      artifacts: refs,
      planDigest: preview.planDigest,
      idempotencyKey: randomUUID(),
    };
    const keyPath = '/root/.ssh/authorized_keys';
    const disabledKey = keyPath + '.acceptance-hold';
    await assert.rejects(() => sftp.lstat(disabledKey), { code: 2 });

    // Keep this fixture SFTP session open so that we can restore SSH access even
    // if the API call or a cleanup assertion fails. New connections are refused.
    let failed;
    let jobPath;
    await sftp.rename(keyPath, disabledKey);
    try {
      await expectVerification('UNVERIFIABLE');
      const job = await api.post(retention + '/prune', confirmation);
      jobPath = retention + '/jobs/' + job.id;
      failed = await pollCleanup(api, jobPath, 'RETRY');
      assert.ok(failed.instances[0].reason);
      assert.ok(failed.instances[0].retryAt > Date.now());
      assert.equal(failed.instances[0].attempts, 1);
      assert.equal(failed.instances[0].instanceId, instance.id);
      assert.ok((await sftp.lstat(path)).isFile());
      const pending = (await api.get(verifyPath)).instances.find(({ id }) => id === instance.id);
      assert.equal(pending.lifecycleState, 'CLEANING');
      assert.equal(pending.verificationStatus, 'UNVERIFIABLE');
    } finally {
      await sftp.rename(disabledKey, keyPath);
    }

    assert.equal((await api.post(retention + '/prune', confirmation)).id, failed.id);
    assert.equal((await api.post(jobPath + '/retry', {})).id, failed.id);
    const complete = await pollCleanup(api, jobPath, 'DELETED');
    assert.equal(complete.status, 'COMPLETE');
    assert.equal(complete.instances[0].instanceId, instance.id);
    assert.equal(complete.instances[0].attempts, failed.instances[0].attempts + 1);
    await assert.rejects(() => sftp.lstat(path), { code: 2 });
    const checked = await api.post(verifyPath + '/verify', { instanceIds: [peer.id] });
    const deleted = checked.instances.find(({ id }) => id === instance.id);
    const remaining = checked.instances.find(({ id }) => id === peer.id);
    assert.equal(deleted.lifecycleState, 'DELETED');
    assert.equal(remaining.lifecycleState, 'ACTIVE');
    assert.equal(remaining.verificationStatus, 'AVAILABLE');
    return {
      artifactId: artifact.artifactId,
      instanceId: instance.id,
      rejection,
      checks,
      failed,
      complete,
    };
  } finally {
    sftp.close();
  }
}

async function waitFor(label, timeout, read) {
  const deadline = Date.now() + timeout;
  do {
    const result = await read();
    if (result) return result;
    await sleep(500);
  } while (Date.now() < deadline);
  throw new Error(label + ' 超时');
}

function startWorker() {
  const child = spawn(process.execPath, ['/app/apps/api/dist/worker.js'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let problem;
  child.on('error', (error) => {
    problem = error;
  });
  let ready = false;
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    if (ready) return;
    output = (output + chunk).slice(-4096);
    ready = output.includes('veyops Worker ready');
  });
  return {
    check() {
      if (problem) throw problem;
      assert.equal(child.exitCode, null, '临时 Worker 意外退出');
      assert.equal(child.signalCode, null, '临时 Worker 意外中断');
      return ready;
    },
    async stop(signal) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      const stopped = once(child, 'exit', { signal: AbortSignal.timeout(15_000) });
      assert.ok(child.kill(signal));
      return stopped;
    },
  };
}

async function verifyWorkerRecovery(api, fixture, currentWorker) {
  const graph = '/projects/' + fixture.projectId + '/execution-graph';
  const flowPath = graph + '/flows/target-files';
  const { draft, revision } = await api.get(graph);
  const definition = structuredClone(draft);
  const build = definition.canvas.nodes.find(({ id }) => id === 'build-files');
  assert.ok(build?.build);
  const marker = 'VEYOPS_WORKER_FIXTURE_' + randomUUID();
  build.build.buildCommand = 'printf "%s\\n" ' + marker + '\nsleep 100\nexit 23';
  const saved = await api.call('PUT', graph + '/draft', {
    expectedRevision: revision,
    definition: { flows: [], canvas: definition.canvas },
  });
  const { publishedVersion: version } = await api.post(graph + '/publish', {
    expectedRevision: saved.revision,
  });
  const serverId = fixture.serverIds['test-a'];
  const request = {
    version,
    inputs: { parameters: { buildTargets: { serverIds: [serverId] } } },
  };
  const plan = await api.post(flowPath + '/preview', request);
  assert.ok(
    plan.executionPlan.targets.some(
      ({ purpose, servers }) =>
        purpose === 'BUILD' && servers.length === 1 && servers[0].id === serverId,
    ),
  );

  // Only the disposable acceptance application hands its queue to a child.
  // Kill the child while SSH is executing to allow both leases to expire naturally.
  await currentWorker.shutdown();
  let worker = startWorker();
  try {
    await waitFor('临时 Worker 启动', 20_000, () => worker.check());
    const queued = await api.post(flowPath + '/run', {
      ...request,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: plan.configurationHash,
      expectedPlanSections: plan.planSections,
    });
    const runPath = graph + '/runs/' + queued.id;
    const running = await waitFor('目标端构建开始', 90_000, async () => {
      worker.check();
      const detail = await api.get(runPath);
      assert.ok(['QUEUED', 'RUNNING'].includes(detail.status), '中断前执行流提前结束');
      const node = detail.nodes.find(({ nodeId }) => nodeId === 'build-files');
      if (!node?.taskId || node.status !== 'RUNNING') return;
      const path = '/tasks/' + node.taskId;
      const logs = await api.get(path + '/logs');
      if (!logs.content.includes(marker)) return;
      const [task, targets, steps] = await Promise.all([
        api.get(path),
        api.get(path + '/targets'),
        api.get(path + '/steps'),
      ]);
      assert.equal(task.status, 'RUNNING');
      assert.equal(targets.length, 1);
      const [target] = targets;
      assert.equal(target.serverId, serverId);
      assert.equal(target.status, 'RUNNING');
      const step = steps.find(
        (entry) => entry.targetId === target.id && entry.status === 'RUNNING',
      );
      assert.ok(step);
      return { path, task, target, step, node };
    });

    assert.deepEqual(await worker.stop('SIGKILL'), [null, 'SIGKILL']);
    worker = startWorker();
    await waitFor('替代 Worker 启动', 20_000, () => worker.check());
    const recovered = await waitFor('中断租约恢复', 90_000, async () => {
      worker.check();
      const detail = await api.get(runPath);
      if (detail.status === 'NEEDS_ATTENTION') return detail;
      assert.ok(['QUEUED', 'RUNNING'].includes(detail.status), '中断后的结果未经核查即结束');
    });
    const node = recovered.nodes.find(({ nodeId }) => nodeId === running.node.nodeId);
    assert.equal(node.taskId, running.task.id);
    assert.equal(node.status, 'NEEDS_ATTENTION');
    assert.deepEqual(recovered.artifactIds, []);
    const [task, targets, steps, logs] = await Promise.all([
      api.get(running.path),
      api.get(running.path + '/targets'),
      api.get(running.path + '/steps'),
      api.get(running.path + '/logs'),
    ]);
    assert.equal(task.status, 'NEEDS_ATTENTION');
    assert.ok(task.errorSummary);
    assert.equal(task.startedAt, running.task.startedAt);
    assert.equal(targets.length, 1);
    const [target] = targets;
    assert.equal(target.id, running.target.id);
    assert.equal(target.status, 'NEEDS_ATTENTION');
    assert.equal(target.canRetry, false);
    const step = steps.find(({ id }) => id === running.step.id);
    assert.equal(step?.status, 'NEEDS_ATTENTION');
    assert.ok(logs.content.includes(marker));
    return {
      runId: queued.id,
      version,
      status: recovered.status,
      nodeId: node.nodeId,
      taskId: task.id,
      targetId: target.id,
      serverId,
      stepId: step.id,
      reason: task.errorSummary,
    };
  } finally {
    await worker.stop('SIGTERM');
  }
}

module.exports = { verifyArtifactRecovery, verifyWorkerRecovery };
