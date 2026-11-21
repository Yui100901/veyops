const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdir, readFile, readlink, writeFile } = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const {
  initializeDemo,
  loadDemo,
  prepareDemoRepository,
  serveDemoGit,
} = require('./refactor-demo.cjs');

const acceptanceRoot = '/accept';
const apiUrl = 'http://127.0.0.1:3000/api/v1';
const targetNames = ['test-a', 'test-b', 'production-a', 'production-b'];
const targetGroup = {
  test: ['test-a', 'test-b'],
  production: ['production-a', 'production-b'],
};
const activeRunStatuses = new Set(['QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED']);
const expectedLocation = '/srv/veyops-stage0/storefront';
const checkoutFile = {
  'test-config': '.env.test',
  'production-config': '.env.prod',
};
const [revision, fixtureImage] = process.argv.slice(2);

function command(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 60_000 }).trim();
}

function docker(target, ...args) {
  assert.ok(targetNames.includes(target), '未知的隔离 Docker 目标');
  return command('/accept/bin/docker', [
    '--host=unix:///accept/targets/' + target + '/docker.sock',
    ...args,
  ]);
}

const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const equalIds = (actual, expected, message) =>
  assert.deepEqual([...actual].sort(), [...expected].sort(), message);
const nodeById = (run, id) => {
  const node = run.detail.nodes.find(({ nodeId }) => nodeId === id);
  assert.ok(node, `未找到节点 ${id}`);
  return node;
};
const deploymentOn = (run, serverId, nodeId) => {
  const target = nodeById(run, nodeId).output?.release?.targets.find(
    (item) => item.serverId === serverId,
  );
  const record = run.releases.find(({ id }) => id === target?.deploymentId);
  assert.ok(record, `未找到 ${nodeId} 的目标发布记录 ${serverId}`);
  return record;
};

function createApi() {
  let cookie = '';
  const request = async (method, path, body) => {
    const response = await fetch(apiUrl + path, {
      method,
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const session = response.headers.get('set-cookie');
    if (session) cookie = session.split(';')[0];
    return response;
  };
  const call = async (method, path, body, expected) => {
    const response = await request(method, path, body);
    const json = await response.json();
    if (
      (expected !== undefined && response.status !== expected) ||
      (expected === undefined && !response.ok)
    ) {
      throw new Error(`${method} ${path} 返回 ${response.status} ${json.error?.message ?? ''}`);
    }
    return json.data;
  };
  return {
    call,
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
    request,
  };
}

async function readTargets() {
  const privateKey = await readFile(acceptanceRoot + '/host-ssh/fixture-admin', 'utf8');
  return Object.fromEntries(
    await Promise.all(
      targetNames.map(async (host) => {
        const pub = await readFile(`${acceptanceRoot}/host-ssh/${host}.pub`, 'utf8');
        const publicKey = pub.trim().split(/\s+/)[1];
        assert.ok(publicKey, `缺少 ${host} 的 SSH 主机公钥`);
        const hostKeyFingerprint =
          'SHA256:' +
          createHash('sha256')
            .update(Buffer.from(publicKey, 'base64'))
            .digest('base64')
            .replace(/=+$/, '');
        return [host, { host, username: 'root', privateKey, hostKeyFingerprint }];
      }),
    ),
  );
}

function projectQuery(path, projectId, criteria = {}) {
  return path + '?' + new URLSearchParams({ projectId, ...criteria });
}

function checkEnvironment(plan, expected, fixture) {
  if (!expected) return;
  const { collection, sha, buildTargets, releaseTargets, nodeVariables } = expected;
  if (collection) {
    assert.equal(plan.environmentSet?.id, fixture.environmentSetIds[collection]);
    assert.ok(plan.environmentSet?.revision > 0);
  }
  if (sha) {
    assert.ok(plan.checkouts.length > 0);
    assert.ok(plan.checkouts.every(({ commitSha }) => commitSha === sha));
    if (collection) {
      const files = plan.executionPlan.environmentFiles;
      assert.ok(
        files.some(({ path, commitSha }) => path === checkoutFile[collection] && commitSha === sha),
      );
    }
  }
  const targets = plan.executionPlan.targets;
  if (buildTargets) {
    equalIds(
      targets
        .filter(({ purpose }) => purpose === 'BUILD')
        .flatMap(({ servers }) => servers.map(({ id }) => id)),
      buildTargets,
      '构建目标成员和计划不一致',
    );
  }
  if (releaseTargets) {
    const releases = targets.filter(({ purpose }) => purpose === 'RELEASE');
    assert.ok(releases.length);
    for (const { servers } of releases)
      equalIds(
        servers.map(({ id }) => id),
        releaseTargets,
        '发布目标成员和计划不一致',
      );
  }
  if (nodeVariables) {
    const variable = (key) =>
      plan.executionPlan.variables.find(
        (item) => item.nodeId === 'build-files' && item.key === key,
      );
    assert.equal(variable('GIT_SHA')?.source, 'NODE');
    assert.equal(variable('FILE_PROFILE')?.source, 'FILE');
    assert.equal(variable('LOG_LEVEL')?.source, 'ENVIRONMENT_SET');
    assert.ok(variable('LOG_LEVEL')?.overriddenSources?.includes('FILE'));
    assert.equal(variable('POSTGRES_URL')?.sensitive, true);
  }
}

function checkDecision(node, option) {
  const scope = node.output?.scope;
  assert.match(node.output?.scopeHash ?? '', /^[a-f0-9]{64}$/);
  if (node.type === 'SOURCE_REVIEW') {
    assert.equal(scope.kind, 'SOURCE_REVIEW');
    assert.equal(scope.buildNodeId, 'build-manager');
    assert.deepEqual(scope.sources, [{ repositoryId: option.repositoryId, commitSha: option.sha }]);
  } else {
    assert.equal(scope.kind, 'RELEASE');
    assert.equal(scope.releaseNodeId, 'deploy-files');
    assert.equal(scope.serviceId, option.serviceId);
    equalIds(scope.serverIds, option.serverIds, '审批目标不等于展开后的实际成员');
    assert.equal(scope.artifactIds.length, scope.serverIds.length);
    assert.equal(scope.artifactFingerprints.length, scope.artifactIds.length);
    assert.ok(scope.artifactFingerprints.every((value) => /^[a-f0-9]{64}$/.test(value)));
  }
  return scope;
}

function createGraphRunner(api, fixture, evidence) {
  const graph = `/projects/${fixture.projectId}/execution-graph`;
  return async (flow, parameters = {}, options = {}) => {
    const path = graph + '/flows/' + flow;
    const version = options.version ?? fixture.version;
    const choice = { version, inputs: { parameters } };
    const plan = await api.post(path + '/preview', choice);
    checkEnvironment(plan, options.plan, fixture);
    const input = {
      ...choice,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: plan.configurationHash,
      expectedPlanSections: plan.planSections,
    };
    const queued = await api.post(path + '/run', input);
    if (options.checkIdempotency)
      assert.equal((await api.post(path + '/run', input)).id, queued.id);

    const runPath = graph + '/runs/' + queued.id;
    const decisions = new Map();
    const deadline = Date.now() + 12 * 60_000;
    let detail;
    do {
      detail = await api.get(runPath);
      if (!activeRunStatuses.has(detail.status)) break;
      for (const node of detail.nodes) {
        if (
          node.status !== 'WAITING' ||
          !['APPROVAL', 'SOURCE_REVIEW'].includes(node.type) ||
          decisions.has(node.nodeId)
        )
          continue;
        assert.ok(options.decision, `执行流 ${flow} 进入意外审批节点 ${node.nodeId}`);
        const scope = checkDecision(node, options.decision);
        const result = await api.post(runPath + '/nodes/' + node.nodeId + '/decision', {
          decision: 'APPROVE',
          expectedScopeHash: node.output.scopeHash,
        });
        const receipt = result.nodes.find(({ nodeId }) => nodeId === node.nodeId)?.output;
        assert.equal(receipt?.decision, 'APPROVE');
        assert.equal(receipt?.scopeHash, node.output.scopeHash);
        assert.ok(receipt?.actorId);
        decisions.set(node.nodeId, {
          actorId: receipt.actorId,
          scopeHash: receipt.scopeHash,
          scope,
        });
      }
      await sleep(650);
    } while (Date.now() < deadline);
    if (detail.status !== (options.expected ?? 'SUCCESS')) {
      const states = detail.nodes.map(({ nodeId, status, log }) => ({ nodeId, status, log }));
      throw new Error(`${flow} 运行 ${queued.id} 状态 ${detail.status}，${JSON.stringify(states)}`);
    }
    assert.equal(decisions.size, options.decision ? 1 : 0);
    const [projectArtifacts, releases] = await Promise.all([
      api.get(projectQuery('/artifacts', fixture.projectId)),
      api.get(projectQuery('/deployments', fixture.projectId)),
    ]);
    const recordedIds = new Set(detail.artifactIds);
    const runArtifacts = projectArtifacts.filter(({ id }) => recordedIds.has(id));
    const runReleases = releases.filter(({ graphRunId }) => graphRunId === detail.id);
    const entry = {
      flow,
      version,
      runId: detail.id,
      configurationHash: plan.configurationHash,
      environmentSet: plan.environmentSet,
      checkouts: plan.checkouts.map(({ nodeId, repositoryId, commitSha }) => ({
        nodeId,
        repositoryId,
        commitSha,
      })),
      targets: plan.executionPlan.targets,
      status: detail.status,
      decisions: [...decisions].map(([nodeId, receipt]) => ({ nodeId, ...receipt })),
      artifacts: runArtifacts.map((artifact) => ({
        id: artifact.id,
        artifactId: artifact.artifactId,
        name: artifact.name,
        kind: artifact.kind,
        serverId: artifact.serverId,
        sourceCommit: artifact.sourceCommit,
        physical: artifact.physical,
        checksum: artifact.checksum,
        imageId: artifact.imageId,
        references: artifact.sources,
      })),
      releases: runReleases,
    };
    evidence.runs.push(entry);
    console.log('VEYOPS_ACCEPTANCE_RUN ' + JSON.stringify(entry));
    return { detail, artifacts: runArtifacts, releases: runReleases, entry };
  };
}

function artifactFor(run, output, expected) {
  const refs = run.detail.outputs[output];
  assert.ok(Array.isArray(refs) && refs.length > 0, `没有收到 ${output} 产物`);
  assert.equal(new Set(refs.map(({ artifactId }) => artifactId)).size, 1);
  const [{ artifactId }] = refs;
  assert.match(artifactId, /^[0-9a-f-]{36}$/i);
  const instances = refs.map((ref) => run.artifacts.find(({ id }) => id === ref.instanceId));
  assert.ok(instances.every(Boolean), '跨运行选择的产物未登记');
  if (expected.servers)
    equalIds(
      instances.map(({ serverId }) => serverId),
      expected.servers,
    );
  for (const artifact of instances) {
    assert.equal(artifact.kind, expected.kind);
    assert.equal(artifact.sourceCommit, expected.sha);
    assert.equal(artifact.graphRunId, run.detail.id);
    assert.ok(
      artifact.sources.some(
        ({ repositoryId, commitSha }) =>
          repositoryId === expected.repositoryId && commitSha === expected.sha,
      ),
    );
    if (expected.kind === 'DOCKER_IMAGE')
      assert.match(artifact.imageId ?? '', /^sha256:[a-f0-9]{64}$/);
    else assert.match(artifact.checksum ?? '', /^[a-f0-9]{64}$/);
  }
  return { artifactId, instances };
}

async function verifyArtifact(api, artifact) {
  const { instances } = await api.post('/artifacts/' + artifact.artifactId + '/verify', {});
  equalIds(
    instances.map(({ id }) => id),
    artifact.instances.map(({ id }) => id),
  );
  assert.ok(instances.every(({ verificationStatus }) => verificationStatus === 'AVAILABLE'));
}

async function verifyFileRelease(fixture, release, artifact, names, html, nodeId) {
  for (const target of names) {
    assert.ok(targetNames.includes(target), '文件发布需使用专用验收目标');
    const serverId = fixture.serverIds[target];
    const row = deploymentOn(release, serverId, nodeId);
    const instance =
      artifact.instances.find((item) => item.serverId === serverId) ??
      artifact.instances.find((item) => item.serverId === null);
    assert.ok(instance);
    assert.equal(row.isCurrent, true);
    assert.equal(row.status, 'SUCCESS');
    assert.equal(row.deployPath, expectedLocation);
    assert.equal(row.artifactId, instance.id);
    const current = `${acceptanceRoot}/targets/${target}/deploy/storefront/current`;
    assert.equal(await readlink(current), `releases/${row.taskId}`);
    assert.equal((await readFile(current + '/index.html', 'utf8')).trim(), html);
    const served = await fetch(`http://${target}:18080/`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(served.status, 200);
    assert.equal((await served.text()).trim(), html);
  }
}

async function verifyComposeRelease(fixture, release, artifact, expected) {
  for (const target of targetGroup.production) {
    const serverId = fixture.serverIds[target];
    const row = deploymentOn(release, serverId, 'deploy-image');
    const instance = artifact.instances.find((item) => item.serverId === serverId);
    assert.equal(row.isCurrent, true);
    assert.equal(row.status, 'SUCCESS');
    assert.equal(row.artifactId, instance.id);
    const { template, composeProject, dockerEngineId, imageId } = row.composeRelease;
    assert.equal(template.source, 'REPOSITORY_FILE');
    assert.equal(template.repositoryId, expected.repositoryId);
    assert.equal(template.commitSha, expected.sha);
    assert.equal(template.path, 'compose.yaml');
    assert.equal(template.checksum, expected.templateChecksum);
    assert.match(composeProject, /^veyops-[a-f0-9]{24}$/);
    assert.equal(docker(target, 'info', '--format', '{{.ID}}'), dockerEngineId);
    const containers = docker(
      target,
      'ps',
      '--filter',
      'label=com.docker.compose.project=' + composeProject,
      '--filter',
      'label=com.docker.compose.service=web',
      '--format',
      '{{.ID}}',
    ).split('\n');
    assert.equal(containers.length, 1);
    assert.match(containers[0], /^[0-9a-f]{12,64}$/);
    const container = containers[0];
    assert.equal(docker(target, 'inspect', '--format', '{{.Image}}', container), imageId);
    assert.equal(imageId, instance.imageId);
    assert.equal(
      docker(target, 'exec', container, 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/'),
      expected.html,
    );
  }
}

async function verifyBackup(api, expectedArtifact, expectedRelease) {
  const backup = await api.post('/backups', {});
  const path = '/backups/' + backup.id;
  assert.equal((await api.post(path + '/verify', {})).id, backup.id);
  const bundle = await api.request('GET', path + '/download');
  assert.equal(bundle.status, 200);
  const directory = acceptanceRoot + '/backup-extracted';
  await writeFile(acceptanceRoot + '/backup.tar.gz', Buffer.from(await bundle.arrayBuffer()), {
    flag: 'wx',
  });
  await mkdir(directory);
  command('tar', ['-xzf', acceptanceRoot + '/backup.tar.gz', '-C', directory]);

  const { restoreBackup } = require('/app/apps/api/dist/core/database/backup.js');
  const dataDir = acceptanceRoot + '/restored';
  const sqlitePath = dataDir + '/database/app.db';
  const client = process.env.DATABASE_CLIENT;
  const url = process.env.VEYOPS_ACCEPT_RESTORE_DATABASE_URL;
  if (client === 'postgres') {
    assert.ok(url, 'PostgreSQL 验收需要独立空还原库');
    const source = new URL(process.env.DATABASE_URL);
    const restore = new URL(url);
    assert.equal(restore.host, source.host);
    assert.notEqual(restore.pathname, source.pathname, '还原库不能是当前候选库');
  }
  await restoreBackup(
    {
      dataDir,
      database: client === 'sqlite' ? { client, path: sqlitePath } : { client, url },
      key: Buffer.from(process.env.ENCRYPTION_KEY, 'hex'),
    },
    directory,
  );

  const checks = [
    [
      'select commit_sha as value from artifact_sources where artifact_id = ?',
      expectedArtifact.id,
      expectedArtifact.sourceCommit,
    ],
    ['select status as value from deployment_records where id = ?', expectedRelease.id, 'SUCCESS'],
  ];
  if (client === 'sqlite') {
    const db = require('/app/node_modules/better-sqlite3')(sqlitePath, { readonly: true });
    try {
      for (const [sql, key, value] of checks) assert.equal(db.prepare(sql).pluck().get(key), value);
    } finally {
      db.close();
    }
  } else {
    const { Client } = require('/app/node_modules/pg');
    const db = new Client({ connectionString: url });
    try {
      await db.connect();
      for (const [sql, key, value] of checks) {
        const checked = await db.query(sql.replace('?', '$1'), [key]);
        assert.equal(checked.rows[0]?.value, value);
      }
    } finally {
      await db.end();
    }
  }
  return { id: backup.id, restored: true, database: client };
}

async function run() {
  assert.match(revision, /^[0-9a-f]{40}$/);
  assert.equal(fixtureImage, 'busybox:1.36');
  assert.equal(process.env.DOCKER_HOST, 'unix:///accept/targets/test-a/docker.sock');
  assert.ok(['sqlite', 'postgres'].includes(process.env.DATABASE_CLIENT));
  const demo = loadDemo('/accept/examples/refactor-stage0/project.yaml');
  const gitRoot = acceptanceRoot + '/repo';
  const source = await prepareDemoRepository(demo, gitRoot);
  const git = serveDemoGit(gitRoot);
  git.listen(8088, '0.0.0.0');
  await once(git, 'listening');
  let app;
  try {
    const { createApp } = require('/app/apps/api/dist/bootstrap.js');
    app = await createApp();
    app.useLogger(false);
    await app.listen(3000, '0.0.0.0');
    const api = createApi();
    const password = randomBytes(25).toString('hex');
    await api.post('/auth/login', { username: 'root', password: process.env.ADMIN_PASSWORD });
    await api.post('/auth/change-password', {
      currentPassword: process.env.ADMIN_PASSWORD,
      newPassword: password,
    });
    await api.post('/auth/login', { username: 'root', password });
    const demoConfig = {
      call: api.call,
      repositoryBaseUrl: 'http://manager:8088',
      buildImage: process.env.VEYOPS_ACCEPT_BUILD_IMAGE,
      targets: await readTargets(),
    };
    const fixture = await initializeDemo(demo, demoConfig);
    assert.deepEqual(await initializeDemo(demo, demoConfig), fixture);
    assert.equal(fixture.commitSha, source.commitSha);
    const sha = source.commitSha;
    const nextSha = source.nextCommitSha;
    assert.match(nextSha, /^[0-9a-f]{40}$/);
    assert.notEqual(nextSha, sha);
    const repo = fixture.repositoryIds['web-repo'];
    const serviceId = fixture.serviceIds.storefront;
    const allTargets = Object.fromEntries(
      Object.entries(targetGroup).map(([scope, members]) => [
        scope,
        members.map((host) => fixture.serverIds[host]),
      ]),
    );
    const selection = (scope) => ({ groupIds: [fixture.groupIds[`web-${scope}-group`]] });
    const html = command('git', ['--git-dir', source.repositoryPath, 'show', sha + ':index.html']);
    const nextHtml = command('git', [
      '--git-dir',
      source.repositoryPath,
      'show',
      nextSha + ':index.html',
    ]);
    assert.notEqual(html, nextHtml);
    const evidence = {
      revision,
      projectId: fixture.projectId,
      graphVersion: fixture.version,
      database: process.env.DATABASE_CLIENT,
      sourceCommit: sha,
      candidateCommit: nextSha,
      runs: [],
    };
    const execute = createGraphRunner(api, fixture, evidence);
    const manager = await execute(
      'manager-build',
      {},
      {
        plan: { collection: 'test-config', sha, buildTargets: [] },
        checkIdempotency: true,
      },
    );
    const managerArtifact = artifactFor(manager, 'directory', {
      kind: 'DIRECTORY',
      sha,
      repositoryId: repo,
      servers: [null],
    });
    await verifyArtifact(api, managerArtifact);
    await execute(
      'reviewed-build',
      {},
      {
        plan: { collection: 'test-config', sha, buildTargets: [] },
        decision: { repositoryId: repo, sha },
      },
    );
    const files = {};
    for (const scope of ['test', 'production']) {
      const collection = `${scope}-config`;
      const target = await execute(
        'target-files',
        {
          environmentSet: fixture.environmentSetIds[collection],
          buildTargets: selection(scope),
        },
        {
          plan: { collection, sha, buildTargets: allTargets[scope], nodeVariables: true },
        },
      );
      const expected = { sha, repositoryId: repo, servers: allTargets[scope] };
      files[scope] = artifactFor(target, 'directory', { ...expected, kind: 'DIRECTORY' });
      artifactFor(target, 'file', { ...expected, kind: 'FILE' });
      const build = nodeById(target, 'build-files');
      assert.equal(build.environment.find(({ fieldId }) => fieldId === 'GIT_SHA')?.value, sha);
      const temporaryIds = build.output.runReport.map(
        ({ temporaryArtifactId }) => temporaryArtifactId,
      );
      assert.ok(temporaryIds.every(Boolean));
      assert.equal(temporaryIds.length, allTargets[scope].length);
      assert.ok(
        temporaryIds.every((id) => !target.artifacts.some((artifact) => artifact.id === id)),
      );
    }

    const combined = await execute(
      'build-and-deploy',
      {},
      {
        plan: {
          collection: 'test-config',
          sha,
          buildTargets: allTargets.test,
          releaseTargets: allTargets.test,
        },
        decision: { serviceId, serverIds: allTargets.test },
      },
    );
    const combinedFile = {
      instances: combined.artifacts.filter(({ name }) => name === 'webDirectory'),
    };
    equalIds(
      combinedFile.instances.map(({ serverId }) => serverId),
      allTargets.test,
    );
    await verifyFileRelease(
      fixture,
      combined,
      combinedFile,
      targetGroup.test,
      html,
      'deploy-files',
    );
    const transferred = await execute(
      'deploy-existing',
      {
        artifact: { artifactId: managerArtifact.artifactId },
        releaseTargets: selection('production'),
      },
      { plan: { releaseTargets: allTargets.production } },
    );
    await verifyFileRelease(
      fixture,
      transferred,
      managerArtifact,
      targetGroup.production,
      html,
      'deploy-files',
    );
    let productionFiles;
    for (const scope of ['test', 'production']) {
      await verifyArtifact(api, files[scope]);
      const historical = await execute(
        'deploy-existing',
        {
          artifact: { artifactId: files[scope].artifactId },
          releaseTargets: selection(scope),
        },
        { plan: { releaseTargets: allTargets[scope] } },
      );
      await verifyFileRelease(
        fixture,
        historical,
        files[scope],
        targetGroup[scope],
        html,
        'deploy-files',
      );
      if (scope === 'production') productionFiles = historical;
    }

    const image = await execute(
      'target-image',
      {},
      {
        plan: { collection: 'production-config', sha, buildTargets: allTargets.production },
      },
    );
    const imageArtifact = artifactFor(image, 'image', {
      kind: 'DOCKER_IMAGE',
      sha,
      repositoryId: repo,
      servers: allTargets.production,
    });
    await verifyArtifact(api, imageArtifact);
    const compose = await execute(
      'deploy-compose',
      { artifact: { artifactId: imageArtifact.artifactId } },
      {
        plan: { collection: 'production-config', releaseTargets: allTargets.production },
      },
    );
    const composeTemplate = demo.repositories[0].sourceSnapshot.files['compose.yaml'];
    await verifyComposeRelease(fixture, compose, imageArtifact, {
      repositoryId: repo,
      sha,
      html,
      templateChecksum: sha256(composeTemplate),
    });
    // File and Compose are separate active release locations on the same hosts.
    assert.ok(productionFiles);
    const current = await api.get(projectQuery('/deployments', fixture.projectId));
    for (const server of allTargets.production) {
      for (const entry of [
        deploymentOn(productionFiles, server, 'deploy-files'),
        deploymentOn(compose, server, 'deploy-image'),
      ]) {
        assert.equal(current.find(({ id }) => id === entry.id)?.isCurrent, true);
      }
    }
    const cleanup = await api.post('/artifact-retention/preview', {
      artifacts: [files.production, imageArtifact].map(({ artifactId }) => ({ artifactId })),
    });
    assert.equal(cleanup.instances.length, allTargets.production.length * 2);
    assert.equal(cleanup.eligibleCount, 0);
    assert.ok(cleanup.instances.every((instance) => !instance.eligible && instance.reason));
    evidence.protectedReleaseInstances = cleanup.instances;

    const staged = await execute(
      'target-files',
      {
        gitVersion: { kind: 'COMMIT', value: nextSha },
        environmentSet: fixture.environmentSetIds['test-config'],
      },
      {
        plan: {
          collection: 'test-config',
          sha: nextSha,
          buildTargets: allTargets.test,
          nodeVariables: true,
        },
      },
    );
    const next = artifactFor(staged, 'directory', {
      kind: 'DIRECTORY',
      sha: nextSha,
      repositoryId: repo,
      servers: allTargets.test,
    });
    const automatic = await execute(
      'health-rollback',
      {
        artifact: { artifactId: next.artifactId },
        rollbackArtifact: { artifactId: combinedFile.instances[0].artifactId },
      },
      { plan: { releaseTargets: allTargets.test } },
    );
    const health = nodeById(automatic, 'probe-files');
    assert.equal(health.output.release.healthStatus, 'UNHEALTHY');
    assert.ok(
      health.output.release.targets.every(
        ({ health: status, probeExitCode }) => status === 'UNHEALTHY' && probeExitCode === 10,
      ),
    );
    await verifyFileRelease(
      fixture,
      automatic,
      combinedFile,
      targetGroup.test,
      html,
      'rollback-files',
    );
    for (const server of allTargets.test)
      assert.equal(
        deploymentOn(automatic, server, 'rollback-files').rollbackOfDeploymentId,
        deploymentOn(automatic, server, 'deploy-files').id,
      );

    const newer = await execute(
      'deploy-existing',
      { artifact: { artifactId: next.artifactId } },
      {
        plan: { releaseTargets: allTargets.test },
      },
    );
    await verifyFileRelease(fixture, newer, next, targetGroup.test, nextHtml, 'deploy-files');
    const manual = await execute(
      'rollback-existing',
      {
        artifact: { artifactId: files.test.artifactId },
      },
      { plan: { releaseTargets: allTargets.test } },
    );
    await verifyFileRelease(fixture, manual, files.test, targetGroup.test, html, 'rollback-files');
    for (const server of allTargets.test)
      assert.equal(
        deploymentOn(manual, server, 'rollback-files').rollbackOfDeploymentId,
        deploymentOn(newer, server, 'deploy-files').id,
      );

    const graph = `/projects/${fixture.projectId}/execution-graph`;
    const { draft: definition, revision: expectedRevision } = await api.get(graph);
    const failBuild = definition.canvas.nodes.find(({ id }) => id === 'build-files');
    assert.ok(failBuild?.build);
    failBuild.build.buildCommand = 'exit 23';
    const failedDraft = await api.call('PUT', graph + '/draft', {
      expectedRevision,
      definition: { flows: [], canvas: definition.canvas },
    });
    const failedVersion = (
      await api.post(graph + '/publish', { expectedRevision: failedDraft.revision })
    ).publishedVersion;
    const stopped = await execute(
      'build-and-deploy',
      {},
      { version: failedVersion, expected: 'FAILED' },
    );
    assert.equal(nodeById(stopped, 'deploy-files').status, 'SKIPPED');
    assert.equal(stopped.releases.length, 0);
    await verifyFileRelease(fixture, manual, files.test, targetGroup.test, html, 'rollback-files');

    evidence.backup = await verifyBackup(
      api,
      files.test.instances[0],
      deploymentOn(manual, allTargets.test[0], 'rollback-files'),
    );
    await writeFile(acceptanceRoot + '/evidence.json', JSON.stringify(evidence, null, 2) + '\n', {
      flag: 'wx',
    });
    console.log('VEYOPS_P1_DELIVERY_OK ' + JSON.stringify(evidence));
  } finally {
    try {
      if (app) await app.close();
    } finally {
      await new Promise((resolve) => git.close(resolve));
    }
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
