const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { watch } = require('node:fs');
const { mkdir, readFile, readdir, readlink, writeFile } = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { testTarget } = require('./work-directory-live.cjs');

const originalContent = '<main>VeyOps shared-workspace delivery</main>\n';
const sourceDirectory = 'flow-v2-source';
const targetWorkspaceRoot = '/srv/veyops-stage0';
const composeSource = ['services:', '  web:', '    image: ${VEYOPS_IMAGE}', ''].join('\n');

function fixtureReleaseDirectory(target, project, service) {
  // The fixture binds each target's workspace root under its own /accept directory.
  return `/accept/targets/${target}/deploy/${project.slug}/.deployments/${service.id}`;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 15_000 }).trim();
}

async function repositoryFixture(nativeImage = false) {
  const worktree = '/accept/flow-v2-source';
  const bare = '/accept/repo/flow-v2-source.git';
  await mkdir(worktree);
  git('-C', worktree, 'init', '-b', 'main');
  const commit = (message) => {
    git('-C', worktree, 'add', '.');
    git(
      '-C',
      worktree,
      '-c',
      'user.name=VeyOps acceptance',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      message,
    );
    return git('-C', worktree, 'rev-parse', 'HEAD');
  };
  await writeFile(worktree + '/index.html', originalContent);
  await writeFile(worktree + '/.env.test', 'FIXTURE_ONLY=sample\n');
  await writeFile(
    worktree + '/source-note.txt',
    'Source file included in the whole directory release\n',
  );
  if (nativeImage) {
    await writeFile(
      worktree + '/Dockerfile',
      [
        'FROM busybox:1.36',
        'COPY index.html /site/index.html',
        'CMD ["httpd", "-f", "-p", "8080", "-h", "/site"]',
        '',
      ].join('\n'),
    );
    await writeFile(worktree + '/compose.yaml', composeSource);
  }
  const sha = commit('Initial fixture');
  await writeFile(worktree + '/index.html', '<main>New branch head</main>\n');
  const nextSha = commit('New unreleased fixture');
  git('clone', '--bare', worktree, bare);
  git('--git-dir', bare, 'update-ref', 'refs/heads/main', sha, nextSha);
  return {
    sha,
    nextSha,
    advance: () => git('--git-dir', bare, 'update-ref', 'refs/heads/main', nextSha, sha),
  };
}

async function publish(api, graph, canvas) {
  const { revision } = await api.get(graph);
  const saved = await api.call('PUT', graph + '/draft', {
    expectedRevision: revision,
    definition: { canvas },
  });
  return (await api.post(graph + '/publish', { expectedRevision: saved.revision }))
    .publishedVersion;
}

function configureTemplateEntries(canvas, start, release, composePath) {
  const onlyBuild = canvas.nodes.find(({ name }) => name === '仅构建');
  const onlyDeploy = canvas.nodes.find(({ name }) => name === '仅部署');
  assert.ok(onlyBuild && onlyDeploy);
  const { sources, execution, variables } = start.start;
  onlyBuild.start = { sources, execution, variables, release: { serviceId: release.serviceId } };
  onlyDeploy.start = { variables, release: { ...release, artifactSource: 'RUN_PARAMETER' } };
  const buildEnd = canvas.nodes.find(({ name }) => name === '构建结束');
  if (composePath) {
    assert.ok(buildEnd.finish.images.length);
    buildEnd.finish.images[0].composePath = composePath;
  }
  const check = canvas.nodes.find(({ operation }) => operation === 'CHECK');
  if (check) check.shell = { directory: sourceDirectory, command: 'test -s index.html' };
  const health = canvas.nodes.find(({ operation }) => operation === 'HEALTH_CHECK');
  if (health)
    health.healthCheck.command = composePath
      ? 'test -s compose.yaml'
      : 'test -s ' + sourceDirectory + '/dist/index.html';
  const approval = canvas.nodes.find(({ operation }) => operation === 'APPROVAL');
  const decision = approval && {
    releaseNodeId: canvas.nodes.find(({ operation }) => operation === 'DEPLOY_ARTIFACT').id,
    serviceId: release.serviceId,
    serverIds: release.targets.serverIds,
  };
  return { onlyBuild, onlyDeploy, ...(decision && { decision }) };
}

function primaryPath(canvas, startId) {
  const pair = canvas.endpoints.find((entry) => entry.startId === startId);
  const nodes = canvas.nodes.filter(({ id, type }) =>
    type === 'START' ? id === startId : type === 'END' ? id === pair.endId : true,
  );
  const ids = new Set(nodes.map(({ id }) => id));
  return {
    ...canvas,
    nodes,
    endpoints: [pair],
    edges: canvas.edges.filter(({ from, to }) => ids.has(from) && ids.has(to)),
  };
}

async function verifyActivation(run, serverId, artifactId, sha, activation) {
  assert.equal(run.releases.length, 1);
  const [release] = run.releases;
  assert.equal(release.status, 'SUCCESS');
  assert.equal(release.serverId, serverId);
  assert.equal(release.artifactId, artifactId);
  assert.equal(release.isCurrent, true);
  assert.equal(await readlink(activation), 'releases/' + release.taskId);
  const delivered = activation + '/' + sourceDirectory;
  assert.equal(await readFile(delivered + '/dist/index.html', 'utf8'), originalContent);
  assert.equal((await readFile(delivered + '/dist/source-sha.txt', 'utf8')).trim(), sha);
  assert.equal((await readFile(delivered + '/dist/environment.txt', 'utf8')).trim(), 'flow-v2');
  assert.match(await readFile(delivered + '/source-note.txt', 'utf8'), /whole directory/);
  assert.match(await readFile(delivered + '/scratch/retained.txt', 'utf8'), /retained fixture/);
  for (const omitted of ['.git/HEAD', '.env.test', 'dist/.git/HEAD', 'dist/.env.test'])
    await assert.rejects(readFile(delivered + '/' + omitted), { code: 'ENOENT' });
  return release;
}

async function verifyFlowV2({ api, fixture, execute }) {
  const source = await repositoryFixture();
  const project = await api.post('/projects', { name: '简化执行流验收', slug: 'flow-v2-live' });
  const projectPath = '/projects/' + project.id;
  const graph = projectPath + '/execution-graph';
  await api.call('PATCH', projectPath + '/execution-settings', { targetWorkspaceRoot });
  const repository = await api.post(projectPath + '/repositories', {
    name: 'Flow V2 source',
    cloneUrl: 'http://manager:8088/flow-v2-source.git',
  });
  const service = await api.post(projectPath + '/services', {
    name: 'Flow V2 static site',
    slug: 'flow-v2-site',
    serviceType: 'WEB',
  });
  const sourceTarget = fixture.serverIds['test-a'];
  const deliveryTarget = fixture.serverIds['test-b'];
  assert.ok(sourceTarget && deliveryTarget && sourceTarget !== deliveryTarget);
  const activation = fixtureReleaseDirectory('test-b', project, service) + '/current';
  const { canvas, startId } = await api.post(graph + '/draft/templates/expand', {
    templateId: 'COMPLETE_CI_CD',
    model: 'FLOW_V2',
  });
  assert.equal(canvas.model, 'FLOW_V2');
  assert.deepEqual(
    [canvas.nodes.length, canvas.edges.length, canvas.endpoints.length],
    [11, 10, 3],
  );
  assert.ok(canvas.endpoints.every((endpoint) => Object.keys(endpoint).length === 2));
  const start = canvas.nodes.find(({ id }) => id === startId);
  const build = canvas.nodes.find(({ operation }) => operation === 'BUILD');
  const finish = canvas.nodes.find(({ type }) => type === 'END');
  const release = {
    serviceId: service.id,
    targets: { serverIds: [deliveryTarget] },
  };
  start.start = {
    sources: [
      {
        id: 'source',
        repositoryId: repository.id,
        ref: { kind: 'BRANCH', value: 'main' },
      },
    ],
    execution: { location: 'TARGET', serverId: sourceTarget },
    variables: [{ key: 'FLOW_FIXTURE_ENV', value: 'flow-v2' }],
    release,
  };
  build.build = {
    repoPath: sourceDirectory,
    buildCommand: [
      'mkdir -p dist/.git scratch',
      'cp index.html dist/index.html',
      'if [ -f .env.test ]; then cp .env.test dist/.env.test; fi',
      'if [ -f .git/HEAD ]; then cp .git/HEAD dist/.git/HEAD; fi',
      'printf "%s\\n" "$VEYOPS_GIT_COMMIT_SHA" > dist/source-sha.txt',
      'printf "%s\\n" "$FLOW_FIXTURE_ENV" > dist/environment.txt',
      'printf "%s\\n" "retained fixture" > scratch/retained.txt',
    ].join('\n'),
  };
  delete finish.finish.saveWorkspace;
  delete finish.finish.retention;
  const { onlyBuild, onlyDeploy, decision } = configureTemplateEntries(canvas, start, release);
  const version = await publish(api, graph, canvas);
  const built = await execute(
    startId,
    {},
    { projectId: project.id, version, checkIdempotency: true, decision },
  );
  assert.equal(built.detail.simplified.serverId, sourceTarget);
  assert.equal(built.detail.simplified.sources[0].path, sourceDirectory);
  assert.equal(built.detail.simplified.sources[0].commitSha, source.sha);
  assert.equal(built.entry.checkouts[0].commitSha, source.sha);
  assert.equal(built.artifacts.length, 1);
  const [artifact] = built.artifacts;
  assert.equal(artifact.kind, 'DIRECTORY');
  assert.equal(artifact.sourceCommit, source.sha);
  assert.equal(artifact.serverId, sourceTarget);
  assert.equal(artifact.temporary, false);
  assert.equal(artifact.verificationStatus, 'AVAILABLE');
  assert.equal(artifact.physical.collection, 'WORK_DIRECTORY');
  assert.ok(built.detail.outputs.artifactIds.includes(artifact.id));
  assert.equal(artifact.physical.path, built.detail.simplified.workspacePath);
  assert.equal(artifact.physical.path, `${targetWorkspaceRoot}/${project.slug}/${built.detail.id}`);
  assert.match(artifact.physical.path, /^\/[0-9A-Za-z._/-]+$/);
  const physical = artifact.physical.path + '/' + sourceDirectory;
  await testTarget(
    [
      'set -eu',
      `test -f '${physical}/source-note.txt'`,
      `test -f '${physical}/dist/index.html'`,
      `test -d '${physical}/.git'`,
      `test -f '${physical}/.env.test'`,
      `test -f '${physical}/dist/.git/HEAD'`,
      `test -f '${physical}/dist/.env.test'`,
      `test -f '${physical}/scratch/retained.txt'`,
    ].join('\n'),
    'test-a',
  );
  assert.equal(artifact.downloadAvailable, false);
  const initial = await verifyActivation(
    built,
    deliveryTarget,
    artifact.id,
    source.sha,
    activation,
  );

  const builtOnly = await execute(onlyBuild.id, {}, { projectId: project.id, version });
  assert.deepEqual(
    builtOnly.detail.nodes.map(({ type }) => type),
    ['START', 'CHECKOUT', 'CHECK', 'BUILD', 'END'],
  );
  assert.equal(await readlink(activation), 'releases/' + initial.taskId);
  const [onlyBuildArtifact] = builtOnly.artifacts;
  const deployedOnly = await execute(
    onlyDeploy.id,
    { artifactId: onlyBuildArtifact.id },
    { projectId: project.id, version, decision },
  );
  assert.deepEqual(
    deployedOnly.detail.nodes.map(({ type }) => type),
    ['START', 'APPROVAL', 'DEPLOY_ARTIFACT', 'HEALTH_CHECK', 'END'],
  );
  assert.equal(deployedOnly.detail.simplified.workspacePath, null);
  await verifyActivation(
    deployedOnly,
    deliveryTarget,
    onlyBuildArtifact.id,
    source.sha,
    activation,
  );

  for (const [name, serverId] of [
    ['test-a', sourceTarget],
    ['test-b', deliveryTarget],
  ]) {
    const historicalBuild = structuredClone(canvas);
    const historyStart = historicalBuild.nodes.find(({ id }) => id === onlyBuild.id);
    historyStart.start.sources = [];
    historyStart.start.execution = { location: 'TARGET', serverId };
    const historicalVersion = await publish(api, graph, historicalBuild);
    const fromHistory = await execute(
      onlyBuild.id,
      { workspaceArtifactId: onlyBuildArtifact.id },
      { projectId: project.id, version: historicalVersion },
    );
    assert.equal(fromHistory.detail.simplified.workspaceSource.kind, 'HISTORICAL');
    assert.equal(fromHistory.detail.simplified.workspaceSource.artifactId, onlyBuildArtifact.id);
    assert.equal(fromHistory.detail.simplified.workspaceSource.sources[0].commitSha, source.sha);
    assert.equal(fromHistory.detail.simplified.serverId, serverId);
    const checkout = fromHistory.detail.nodes.find(({ type }) => type === 'CHECKOUT');
    assert.equal(checkout.status, 'SUCCESS');
    assert.equal(checkout.output.checkoutSkipped, 'HISTORICAL_WORKSPACE');
    const [generated] = fromHistory.artifacts;
    assert.notEqual(generated.id, onlyBuildArtifact.id);
    assert.notEqual(generated.physical.path, onlyBuildArtifact.physical.path);
    await testTarget(
      [
        'set -eu',
        `test -s '${generated.physical.path}/${sourceDirectory}/dist/index.html'`,
        `test ! -e '${generated.physical.path}/${sourceDirectory}/.git'`,
      ].join('\n'),
      name,
    );
  }

  const transient = structuredClone(canvas);
  transient.nodes.find(({ id }) => id === finish.id).finish.saveWorkspace = false;
  const transientVersion = await publish(api, graph, transient);
  const transientRun = await execute(
    startId,
    {},
    { projectId: project.id, version: transientVersion, checkIdempotency: true, decision },
  );
  assert.equal(transientRun.artifacts.length, 0, 'temporary release stays outside artifact lists');
  const [temporary] = transientRun.detail.simplified.artifacts;
  assert.equal(transientRun.detail.simplified.artifacts.length, 1);
  assert.equal(temporary.name, 'workspace');
  assert.equal(temporary.temporary, true);
  const transientRelease = await verifyActivation(
    transientRun,
    deliveryTarget,
    temporary.id,
    source.sha,
    activation,
  );
  const cleanup = await api.post('/artifact-retention/preview', {
    artifacts: [{ artifactId: temporary.id }],
  });
  assert.equal(cleanup.eligibleCount, 0, 'active release protects the temporary snapshot');

  source.advance();
  const replayStart = 'historical-release';
  const replayDeploy = 'historical-deploy';
  const replayEnd = 'historical-finish';
  canvas.nodes.push(
    {
      id: replayStart,
      name: '历史产物重发',
      type: 'START',
      start: { release: { ...release, artifactId: artifact.id } },
    },
    {
      id: replayDeploy,
      name: '部署历史产物',
      type: 'FUNCTION',
      operation: 'DEPLOY_ARTIFACT',
      deploy: { method: 'FILE' },
    },
    {
      id: replayEnd,
      name: '核对激活',
      type: 'END',
      finish: { requireRelease: 'ACTIVATED' },
    },
  );
  canvas.edges.push({ from: replayStart, to: replayDeploy }, { from: replayDeploy, to: replayEnd });
  canvas.endpoints.push({ startId: replayStart, endId: replayEnd });
  const replayVersion = await publish(api, graph, canvas);
  const replay = await execute(
    replayStart,
    {},
    { projectId: project.id, version: replayVersion, checkIdempotency: true },
  );
  assert.equal(replay.detail.simplified.release.artifactId, artifact.id);
  assert.deepEqual(replay.detail.simplified.sources, []);
  assert.equal(replay.detail.simplified.workspacePath, null);
  assert.deepEqual(replay.detail.outputs.artifactIds, [artifact.id]);
  const repeated = await verifyActivation(
    replay,
    deliveryTarget,
    artifact.id,
    source.sha,
    activation,
  );
  assert.notEqual(repeated.id, initial.id);

  start.start.release.artifactId = artifact.id;
  const mixedVersion = await publish(api, graph, canvas);
  const mixed = await execute(
    startId,
    {},
    { projectId: project.id, version: mixedVersion, decision },
  );
  const [newSnapshot] = mixed.detail.simplified.artifacts;
  assert.equal(mixed.detail.simplified.artifacts.length, 1);
  assert.equal(newSnapshot.temporary, false);
  assert.equal(newSnapshot.commitSha, source.nextSha);
  assert.notEqual(newSnapshot.id, artifact.id);
  assert.deepEqual(
    new Set(mixed.detail.outputs.artifactIds),
    new Set([newSnapshot.id, artifact.id]),
  );
  const mixedRelease = await verifyActivation(
    mixed,
    deliveryTarget,
    artifact.id,
    source.sha,
    activation,
  );
  return {
    projectId: project.id,
    sourceCommitSha: source.sha,
    updatedBranchSha: source.nextSha,
    sourceServerId: sourceTarget,
    destinationServerId: deliveryTarget,
    buildRunId: built.detail.id,
    temporaryRunId: transientRun.detail.id,
    temporaryArtifactId: temporary.id,
    temporaryDeploymentId: transientRelease.id,
    replayRunId: replay.detail.id,
    mixedRunId: mixed.detail.id,
    mixedSnapshotId: newSnapshot.id,
    mixedDeploymentId: mixedRelease.id,
    artifactId: artifact.id,
    initialDeploymentId: initial.id,
    replayDeploymentId: repeated.id,
  };
}

async function verifyComposeActivation(run, image, serverId, directory, docker) {
  assert.equal(run.releases.length, 1);
  const [deployment] = run.releases;
  assert.equal(deployment.status, 'SUCCESS');
  assert.equal(deployment.serverId, serverId);
  assert.equal(deployment.artifactId, image.id);
  assert.equal(deployment.isCurrent, true);
  const { imageId, template, composeProject, dockerEngineId } = deployment.composeRelease;
  assert.equal(imageId, image.imageId);
  assert.equal(dockerEngineId, docker('test-a', 'info', '--format', '{{.ID}}'));
  assert.equal(template.source, 'ARCHIVE');
  assert.equal(template.checksum, createHash('sha256').update(composeSource).digest('hex'));
  assert.equal(await readlink(directory + '/current'), 'releases/' + deployment.taskId);
  assert.equal(await readFile(directory + '/current/compose.yaml', 'utf8'), composeSource);
  const container = docker(
    'test-a',
    'ps',
    '--filter',
    'label=com.docker.compose.project=' + composeProject,
    '--filter',
    'label=com.docker.compose.service=web',
    '--format',
    '{{.ID}}',
  );
  assert.match(container, /^[0-9a-f]{12,64}$/);
  assert.equal(docker('test-a', 'inspect', '--format', '{{.Image}}', container), imageId);
  assert.equal(
    docker('test-a', 'exec', container, 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/'),
    originalContent.trim(),
  );
  return { deployment, container, composeProject };
}

async function rejectChangedImage(api, graph, flow, version, plan) {
  const path = graph + '/flows/' + flow;
  const response = await api.request('POST', path + '/run', {
    version,
    inputs: { parameters: {} },
    idempotencyKey: randomUUID(),
    expectedConfigurationHash: plan.configurationHash,
    expectedPlanSections: plan.planSections,
  });
  const payload = await response.json();
  if (!response.ok) {
    assert.equal(response.status, 409, JSON.stringify(payload));
    assert.match(payload.error.message, /产物|镜像|配置/);
    return { status: 'REJECTED', reason: payload.error.message };
  }
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    const detail = await api.get(graph + '/runs/' + payload.data.id);
    if (!['QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED'].includes(detail.status)) {
      assert.equal(detail.status, 'FAILED', JSON.stringify(detail.nodes));
      const failed = detail.nodes.find(
        ({ type, status }) => type === 'DEPLOY_ARTIFACT' && status === 'FAILED',
      );
      assert.ok(failed, JSON.stringify(detail.nodes));
      return { status: 'FAILED', runId: detail.id, reason: failed.log };
    }
    await sleep(500);
  }
  assert.fail('Historical replay did not finish after the image tag was changed');
}

async function verifyNamedImageTrigger({
  api,
  canvas,
  graph,
  execute,
  startId,
  associatedStart,
  selectedName,
  projectId,
  serverId,
}) {
  const start = canvas.nodes.find(({ id }) => id === associatedStart);
  delete start.start.release.artifactId;
  start.start.release.useUpstreamArtifact = true;
  start.start.release.upstreamArtifactName = selectedName;
  const version = await publish(api, graph, canvas);
  await api.call('PATCH', '/servers/' + serverId + '/automatic-execution', { enabled: true });
  const rules = graph + '/triggers';
  const rule = await api.post(rules, {
    name: '按登记名称重发镜像',
    kind: 'UPSTREAM',
    version,
    flowId: associatedStart,
    upstreamFlowId: startId,
    upstreamStatus: 'SUCCESS',
    enabled: true,
  });
  const upstream = await execute(startId, {}, { projectId, version });
  const selected = upstream.artifacts.find(({ name }) => name === selectedName);
  assert.ok(selected);
  assert.equal(upstream.artifacts.filter(({ kind }) => kind === 'DOCKER_IMAGE').length, 3);
  const eventsPath = rules + '/' + rule.id + '/events';
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const events = await api.get(eventsPath);
    const event = events.find(({ eventId }) => eventId === upstream.detail.id);
    assert.notEqual(event?.status, 'REJECTED', JSON.stringify(event));
    if (event?.runId) {
      const detail = await api.get(graph + '/runs/' + event.runId);
      if (!['QUEUED', 'RUNNING', 'WAITING'].includes(detail.status)) {
        assert.equal(detail.status, 'SUCCESS', JSON.stringify(detail.nodes));
        assert.equal(detail.triggerType, 'UPSTREAM');
        assert.equal(detail.simplified.release.artifactId, selected.id);
        assert.deepEqual(detail.outputs.artifactIds, [selected.id]);
        const releases = await api.get('/deployments?projectId=' + projectId);
        assert.equal(
          releases.find(
            ({ graphRunId, status }) => graphRunId === detail.id && status === 'SUCCESS',
          )?.artifactId,
          selected.id,
        );
        assert.equal((await api.get(eventsPath)).length, 1);
        return { runId: detail.id, upstreamRunId: upstream.detail.id, artifactId: selected.id };
      }
    }
    await sleep(750);
  }
  assert.fail('The upstream image trigger did not complete');
}

async function verifyManagerImageArchive({
  api,
  graph,
  canvas,
  execute,
  docker,
  projectId,
  sources,
  release,
  serverId,
  directory,
}) {
  const { canvas: manager, startId } = await api.post(graph + '/draft/templates/expand', {
    templateId: 'COMPLETE_CI_CD',
    model: 'FLOW_V2',
    artifactType: 'DOCKER_IMAGE',
  });
  const start = manager.nodes.find(({ id }) => id === startId);
  const build = manager.nodes.find(({ operation }) => operation === 'BUILD');
  start.start = {
    sources,
    execution: { location: 'MANAGER' },
    release: {
      ...start.start.release,
      ...release,
      compose: { path: sourceDirectory + '/compose.yaml' },
    },
  };
  build.build = { repoPath: sourceDirectory, dockerfilePath: 'Dockerfile' };
  const { onlyBuild, onlyDeploy, decision } = configureTemplateEntries(
    manager,
    start,
    release,
    sourceDirectory + '/compose.yaml',
  );
  start.name = '管理端构建并部署';
  onlyBuild.name = '管理端仅构建';
  onlyDeploy.name = '管理端仅部署';
  canvas.nodes.push(...manager.nodes);
  canvas.edges.push(...manager.edges);
  canvas.endpoints.push(...manager.endpoints);
  const version = await publish(api, graph, canvas);
  const built = await execute(startId, {}, { projectId, version, decision });
  assert.equal(built.detail.simplified.location, 'MANAGER');
  const workspace = built.artifacts.find(({ kind }) => kind === 'DIRECTORY');
  assert.ok(workspace);
  assert.equal(workspace.physical.path, built.detail.simplified.workspacePath);
  const exported = await api.request('GET', '/artifacts/' + workspace.id + '/download');
  assert.equal(exported.status, 200);
  const entries = execFileSync('tar', ['-tzf', '-'], {
    input: Buffer.from(await exported.arrayBuffer()),
    encoding: 'utf8',
    timeout: 15_000,
  })
    .trim()
    .split('\n');
  assert.ok(entries.some((entry) => entry.endsWith(sourceDirectory + '/Dockerfile')));
  assert.ok(
    entries.every((entry) => !entry.split('/').some((part) => /^\.git$|^\.env\./.test(part))),
  );
  const image = built.artifacts.find(({ kind }) => kind === 'DOCKER_IMAGE');
  assert.ok(image);
  assert.equal(image.storageType, 'LOCAL_IMAGE');
  assert.equal(image.imageTag, 'run-' + built.detail.id);
  const archive = await api.request('GET', '/artifacts/' + image.id + '/download');
  assert.equal(archive.status, 200);
  const checksum = createHash('sha256')
    .update(Buffer.from(await archive.arrayBuffer()))
    .digest('hex');
  assert.equal(checksum, image.checksum);
  assert.equal(archive.headers.get('x-artifact-sha256'), checksum);
  const activated = await verifyComposeActivation(built, image, serverId, directory, docker);

  const onlyBuildRun = await execute(onlyBuild.id, {}, { projectId, version });
  const builtImage = onlyBuildRun.artifacts.find(({ kind }) => kind === 'DOCKER_IMAGE');
  assert.ok(builtImage);
  assert.notEqual(image.id, builtImage.id);
  assert.equal(await readlink(directory + '/current'), 'releases/' + activated.deployment.taskId);
  const onlyDeployRun = await execute(
    onlyDeploy.id,
    { artifactId: builtImage.id },
    { projectId, version, decision },
  );
  assert.equal(onlyDeployRun.detail.simplified.workspacePath, null);
  await verifyComposeActivation(onlyDeployRun, builtImage, serverId, directory, docker);

  const replay = 'manager-archive-replay';
  const deploy = 'manager-archive-deploy';
  const end = 'manager-archive-end';
  canvas.nodes.push(
    {
      id: replay,
      name: '重发管理端归档',
      type: 'START',
      start: { release: { ...release, artifactId: image.id } },
    },
    {
      id: deploy,
      name: '部署管理端镜像',
      type: 'FUNCTION',
      operation: 'DEPLOY_ARTIFACT',
      deploy: { method: 'COMPOSE' },
    },
    { id: end, name: '核对激活', type: 'END', finish: { requireRelease: 'ACTIVATED' } },
  );
  canvas.edges.push({ from: replay, to: deploy }, { from: deploy, to: end });
  canvas.endpoints.push({ startId: replay, endId: end });
  const replayVersion = await publish(api, graph, canvas);
  const replayed = await execute(replay, {}, { projectId, version: replayVersion });
  const restored = await verifyComposeActivation(replayed, image, serverId, directory, docker);
  assert.notEqual(restored.deployment.id, activated.deployment.id);
  return {
    runId: built.detail.id,
    artifactId: image.id,
    replayRunId: replayed.detail.id,
    checksum,
  };
}

async function verifyFlowV2Image({ api, fixture, execute, docker }) {
  const source = await repositoryFixture(true);
  const project = await api.post('/projects', {
    name: '简化执行流镜像验收',
    slug: 'flow-v2-image-live',
  });
  const projectPath = '/projects/' + project.id;
  const graph = projectPath + '/execution-graph';
  await api.call('PATCH', projectPath + '/execution-settings', { targetWorkspaceRoot });
  const repository = await api.post(projectPath + '/repositories', {
    name: 'Docker fixture source',
    cloneUrl: 'http://manager:8088/flow-v2-source.git',
  });
  const service = await api.post(projectPath + '/services', {
    name: 'Flow V2 Compose site',
    slug: 'flow-v2-compose',
    serviceType: 'WEB',
  });
  const serverId = fixture.serverIds['test-a'];
  assert.ok(serverId);
  const directory = fixtureReleaseDirectory('test-a', project, service);
  const release = {
    serviceId: service.id,
    targets: { serverIds: [serverId] },
  };
  const { canvas, startId } = await api.post(graph + '/draft/templates/expand', {
    templateId: 'MINIMAL_CI_CD',
    model: 'FLOW_V2',
    artifactType: 'DOCKER_IMAGE',
  });
  const start = canvas.nodes.find(({ id }) => id === startId);
  const build = canvas.nodes.find(({ operation }) => operation === 'BUILD');
  const finish = canvas.nodes.find(({ type }) => type === 'END');
  start.start = {
    sources: [
      {
        id: 'source',
        repositoryId: repository.id,
        ref: { kind: 'BRANCH', value: 'main' },
      },
    ],
    execution: { location: 'TARGET', serverId },
    release: {
      ...release,
      compose: { path: sourceDirectory + '/compose.yaml' },
      imageId: 'chosen',
    },
  };
  build.build = {
    repoPath: sourceDirectory,
    dockerfilePath: 'Dockerfile',
    buildCommand: [
      'test "$VEYOPS_IMAGE_TAG" = "run-$VEYOPS_FLOW_RUN_ID"',
      'docker build --label fixture.variant=chosen -t "flow-v2-web:$VEYOPS_IMAGE_TAG" .',
      'docker build --label fixture.variant=additional -t "flow-v2-worker:$VEYOPS_IMAGE_TAG" .',
    ].join('\n'),
  };
  finish.finish = {
    requireRelease: 'ACTIVATED',
    images: [
      { id: 'built-in', name: 'flow-v2-source', source: 'BUILT_IN' },
      { id: 'chosen', name: 'flow-v2-web', source: 'WORKSPACE' },
      { id: 'worker', name: 'flow-v2-worker', source: 'WORKSPACE' },
    ],
  };

  const { onlyBuild, onlyDeploy } = configureTemplateEntries(
    canvas,
    start,
    release,
    sourceDirectory + '/compose.yaml',
  );
  const unregistered = structuredClone(primaryPath(canvas, startId));
  const deployment = unregistered.nodes.find(({ operation }) => operation === 'DEPLOY_ARTIFACT');
  unregistered.nodes = unregistered.nodes.filter(({ id }) => id !== deployment.id);
  unregistered.nodes.find(({ id }) => id === start.id).start.release = undefined;
  delete unregistered.nodes.find(({ id }) => id === build.id).build.buildCommand;
  delete unregistered.nodes.find(({ id }) => id === finish.id).finish;
  unregistered.edges = [
    ...unregistered.edges.filter(({ from, to }) => from !== deployment.id && to !== deployment.id),
    { from: build.id, to: finish.id },
  ];
  const defaultVersion = await publish(api, graph, unregistered);
  const defaultRun = await execute(startId, {}, { projectId: project.id, version: defaultVersion });
  assert.equal(defaultRun.detail.nodes.find(({ nodeId }) => nodeId === build.id).status, 'SUCCESS');
  assert.deepEqual(
    defaultRun.artifacts.map(({ kind }) => kind),
    ['DIRECTORY'],
  );

  const version = await publish(api, graph, canvas);
  const initialRun = await execute(startId, {}, { projectId: project.id, version });
  assert.equal(initialRun.detail.simplified.sources[0].commitSha, source.sha);
  assert.deepEqual(initialRun.artifacts.map(({ kind }) => kind).sort(), [
    'DIRECTORY',
    'DOCKER_IMAGE',
    'DOCKER_IMAGE',
    'DOCKER_IMAGE',
  ]);
  const images = initialRun.artifacts.filter(({ kind }) => kind === 'DOCKER_IMAGE');
  const image = images.find(({ name }) => name === 'flow-v2-web');
  const worker = images.find(({ name }) => name === 'flow-v2-worker');
  const workspace = initialRun.artifacts.find(({ kind }) => kind === 'DIRECTORY');
  assert.notEqual(image.id, workspace.id);
  assert.notEqual(image.imageId, worker.imageId);
  assert.equal(workspace.physical.collection, 'WORK_DIRECTORY');
  assert.equal(workspace.physical.path, initialRun.detail.simplified.workspacePath);
  assert.equal(
    workspace.physical.path,
    `${targetWorkspaceRoot}/${project.slug}/${initialRun.detail.id}`,
  );
  const inspect = (ref) => docker('test-a', 'image', 'inspect', '--format', '{{.Id}}', ref);
  for (const entry of images) {
    assert.equal(entry.serverId, serverId);
    assert.equal(entry.sourceCommit, source.sha);
    assert.equal(entry.physical.location, 'DOCKER_ENGINE');
    assert.match(entry.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(entry.physical.imageReference, entry.name + ':run-' + initialRun.detail.id);
    assert.equal(inspect(entry.physical.imageReference), entry.imageId);
  }
  const reference = image.physical.imageReference;
  const original = await verifyComposeActivation(initialRun, image, serverId, directory, docker);

  const replay = 'historical-image-release';
  const deploy = 'historical-image-deploy';
  const end = 'historical-image-end';
  canvas.nodes.push(
    {
      id: replay,
      type: 'START',
      name: '生产镜像重发',
      start: { release: { ...release, artifactId: image.id } },
    },
    {
      id: deploy,
      type: 'FUNCTION',
      operation: 'DEPLOY_ARTIFACT',
      name: '部署归档镜像',
      deploy: { method: 'COMPOSE' },
    },
    { id: end, type: 'END', name: '核对镜像激活', finish: { requireRelease: 'ACTIVATED' } },
  );
  canvas.edges.push({ from: replay, to: deploy }, { from: deploy, to: end });
  canvas.endpoints.push({ startId: replay, endId: end });
  const replayVersion = await publish(api, graph, canvas);
  const plan = await api.post(graph + '/flows/' + replay + '/preview', {
    version: replayVersion,
    inputs: { parameters: {} },
  });
  assert.equal(plan.simplified.release.artifactId, image.id);
  const releaseEntries = (await readdir(directory + '/releases')).sort();
  const unexpectedWrites = [];
  const changes = watch(directory + '/releases', (event, file) =>
    unexpectedWrites.push({ event, file }),
  );
  let refused;
  try {
    const replacement = inspect('busybox:1.36');
    assert.notEqual(replacement, image.imageId);
    docker('test-a', 'image', 'tag', replacement, reference);
    assert.equal(inspect(reference), replacement);
    assert.equal(inspect(image.imageId), image.imageId);
    refused = await rejectChangedImage(api, graph, replay, replayVersion, plan);
    assert.deepEqual((await readdir(directory + '/releases')).sort(), releaseEntries);
    assert.deepEqual(unexpectedWrites, [], '镜像身份不匹配时发布端目录发生了写入');
    const stillActive = await verifyComposeActivation(
      initialRun,
      image,
      serverId,
      directory,
      docker,
    );
    assert.equal(stillActive.container, original.container);
  } finally {
    changes.close();
    docker('test-a', 'image', 'tag', image.imageId, reference);
  }
  const replayed = await execute(replay, {}, { projectId: project.id, version: replayVersion });
  const restored = await verifyComposeActivation(replayed, image, serverId, directory, docker);
  assert.equal(restored.composeProject, original.composeProject);
  assert.notEqual(restored.deployment.id, original.deployment.id);
  const onlyBuildRun = await execute(
    onlyBuild.id,
    {},
    { projectId: project.id, version: replayVersion },
  );
  const builtImage = onlyBuildRun.artifacts.find(({ kind }) => kind === 'DOCKER_IMAGE');
  assert.ok(builtImage);
  const onlyDeployRun = await execute(
    onlyDeploy.id,
    { artifactId: builtImage.id },
    { projectId: project.id, version: replayVersion },
  );
  assert.equal(onlyDeployRun.detail.simplified.workspacePath, null);
  await verifyComposeActivation(onlyDeployRun, builtImage, serverId, directory, docker);
  const namedTrigger = await verifyNamedImageTrigger({
    api,
    canvas,
    graph,
    execute,
    startId,
    associatedStart: replay,
    selectedName: image.name,
    projectId: project.id,
    serverId,
  });
  const manager = await verifyManagerImageArchive({
    api,
    graph,
    canvas,
    execute,
    docker,
    projectId: project.id,
    sources: start.start.sources,
    release,
    serverId,
    directory,
  });
  return {
    projectId: project.id,
    serverId,
    sourceCommitSha: source.sha,
    unregisteredBuildRunId: defaultRun.detail.id,
    buildRunId: initialRun.detail.id,
    replayRunId: replayed.detail.id,
    imageArtifactId: image.id,
    imageArtifacts: images.map(({ id, name, imageId }) => ({ id, name, imageId })),
    directoryArtifactId: workspace.id,
    imageId: image.imageId,
    composeChecksum: original.deployment.composeRelease.template.checksum,
    initialDeploymentId: original.deployment.id,
    replayDeploymentId: restored.deployment.id,
    changedImageAttempt: refused,
    namedTrigger,
    manager,
  };
}

module.exports = { verifyFlowV2, verifyFlowV2Image };
