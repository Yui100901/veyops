const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { watch } = require('node:fs');
const { mkdir, readFile, readdir, readlink, writeFile } = require('node:fs/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { testTarget } = require('./work-directory-live.cjs');

const originalContent = '<main>VeyOps shared-workspace delivery</main>\n';
const sourceDirectory = 'nested/flow-v2-source';
const targetDirectory = '/srv/veyops-stage0/flow-v2';
const activation = '/accept/targets/test-b/deploy/flow-v2/current';
const composeSource = ['services:', '  web:', '    image: ${VEYOPS_IMAGE}', ''].join('\n');

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
  await writeFile(worktree + '/source-note.txt', 'Source file outside the release subdirectory\n');
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

async function verifyActivation(run, serverId, artifactId, sha) {
  assert.equal(run.releases.length, 1);
  const [release] = run.releases;
  assert.equal(release.status, 'SUCCESS');
  assert.equal(release.serverId, serverId);
  assert.equal(release.artifactId, artifactId);
  assert.equal(release.isCurrent, true);
  assert.equal(await readlink(activation), 'releases/' + release.taskId);
  assert.equal(await readFile(activation + '/index.html', 'utf8'), originalContent);
  assert.equal((await readFile(activation + '/source-sha.txt', 'utf8')).trim(), sha);
  assert.equal((await readFile(activation + '/environment.txt', 'utf8')).trim(), 'flow-v2');
  for (const omitted of ['.git', '.env.test', 'source-note.txt', 'scratch'])
    await assert.rejects(readFile(activation + '/' + omitted), { code: 'ENOENT' });
  return release;
}

async function verifyFlowV2({ api, fixture, execute }) {
  const source = await repositoryFixture();
  const project = await api.post('/projects', { name: '简化执行流验收', slug: 'flow-v2-live' });
  const projectPath = '/projects/' + project.id;
  const graph = projectPath + '/execution-graph';
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
  const { canvas, startId } = await api.post(graph + '/draft/templates/expand', {
    templateId: 'MINIMAL_CI_CD',
    model: 'FLOW_V2',
  });
  assert.equal(canvas.model, 'FLOW_V2');
  assert.equal(canvas.nodes.length, 5);
  assert.ok(canvas.endpoints.every((endpoint) => Object.keys(endpoint).length === 2));
  const start = canvas.nodes.find(({ id }) => id === startId);
  const build = canvas.nodes.find(({ operation }) => operation === 'BUILD');
  const finish = canvas.nodes.find(({ type }) => type === 'END');
  const release = {
    serviceId: service.id,
    targets: { serverIds: [deliveryTarget] },
    deployPath: targetDirectory,
    contentPath: sourceDirectory + '/dist',
  };
  start.start = {
    sources: [
      {
        id: 'source',
        repositoryId: repository.id,
        ref: { kind: 'BRANCH', value: 'main' },
        parentDirectory: 'nested',
      },
    ],
    execution: { location: 'TARGET', serverId: sourceTarget },
    variables: [{ key: 'FLOW_FIXTURE_ENV', value: 'flow-v2' }],
    release,
  };
  build.build = {
    repoPath: sourceDirectory,
    buildCommand: [
      'mkdir -p dist scratch',
      'cp index.html dist/index.html',
      'printf "%s\\n" "$VEYOPS_GIT_COMMIT_SHA" > dist/source-sha.txt',
      'printf "%s\\n" "$FLOW_FIXTURE_ENV" > dist/environment.txt',
      'printf "%s\\n" "exclude from snapshot" > scratch/private.txt',
    ].join('\n'),
  };
  finish.finish.excludePaths = [sourceDirectory + '/scratch'];
  const version = await publish(api, graph, canvas);
  const built = await execute(
    startId,
    {},
    { projectId: project.id, version, checkIdempotency: true },
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
  assert.match(artifact.physical.path, /^\/[0-9A-Za-z._/-]+$/);
  const physical = artifact.physical.path + '/' + sourceDirectory;
  await testTarget(
    [
      'set -eu',
      `test -f '${physical}/source-note.txt'`,
      `test -f '${physical}/dist/index.html'`,
      `test ! -e '${physical}/.git'`,
      `test ! -e '${physical}/.env.test'`,
      `test ! -e '${physical}/scratch'`,
    ].join('\n'),
    'test-a',
  );
  const initial = await verifyActivation(built, deliveryTarget, artifact.id, source.sha);

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
      finish: { saveWorkspace: false, requireRelease: 'ACTIVATED' },
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
  assert.deepEqual(replay.detail.outputs.artifactIds, [artifact.id]);
  const repeated = await verifyActivation(replay, deliveryTarget, artifact.id, source.sha);
  assert.notEqual(repeated.id, initial.id);
  return {
    projectId: project.id,
    sourceCommitSha: source.sha,
    updatedBranchSha: source.nextSha,
    sourceServerId: sourceTarget,
    destinationServerId: deliveryTarget,
    buildRunId: built.detail.id,
    replayRunId: replay.detail.id,
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

async function verifyFlowV2Image({ api, fixture, execute, docker }) {
  const source = await repositoryFixture(true);
  const project = await api.post('/projects', {
    name: '简化执行流镜像验收',
    slug: 'flow-v2-image-live',
  });
  const projectPath = '/projects/' + project.id;
  const graph = projectPath + '/execution-graph';
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
  const directory = '/accept/targets/test-a/deploy/flow-v2-image';
  const release = {
    serviceId: service.id,
    targets: { serverIds: [serverId] },
    deployPath: '/srv/veyops-stage0/flow-v2-image',
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
        parentDirectory: 'nested',
      },
    ],
    execution: { location: 'TARGET', serverId },
    release: { ...release, compose: { path: sourceDirectory + '/compose.yaml' } },
  };
  build.build = { repoPath: sourceDirectory, dockerfilePath: 'Dockerfile' };
  finish.finish = { saveWorkspace: true, retention: 'PERSISTENT', requireRelease: 'ACTIVATED' };
  const version = await publish(api, graph, canvas);
  const initialRun = await execute(startId, {}, { projectId: project.id, version });
  assert.equal(initialRun.detail.simplified.sources[0].commitSha, source.sha);
  assert.deepEqual(initialRun.artifacts.map(({ kind }) => kind).sort(), [
    'DIRECTORY',
    'DOCKER_IMAGE',
  ]);
  const image = initialRun.artifacts.find(({ kind }) => kind === 'DOCKER_IMAGE');
  const workspace = initialRun.artifacts.find(({ kind }) => kind === 'DIRECTORY');
  assert.notEqual(image.id, workspace.id);
  assert.equal(workspace.physical.collection, 'WORK_DIRECTORY');
  assert.equal(image.serverId, serverId);
  assert.equal(image.sourceCommit, source.sha);
  assert.equal(image.physical.location, 'DOCKER_ENGINE');
  assert.equal(image.physical.owner, 'MANAGED');
  assert.match(image.imageId, /^sha256:[a-f0-9]{64}$/);
  const reference = image.physical.imageReference;
  assert.match(reference, /^veyops-build\/[a-f0-9-]+:[a-f0-9-]+$/);
  const inspect = (ref) => docker('test-a', 'image', 'inspect', '--format', '{{.Id}}', ref);
  assert.equal(inspect(reference), image.imageId);
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
  return {
    projectId: project.id,
    serverId,
    sourceCommitSha: source.sha,
    buildRunId: initialRun.detail.id,
    replayRunId: replayed.detail.id,
    imageArtifactId: image.id,
    directoryArtifactId: workspace.id,
    imageId: image.imageId,
    composeChecksum: original.deployment.composeRelease.template.checksum,
    initialDeploymentId: original.deployment.id,
    replayDeploymentId: restored.deployment.id,
    changedImageAttempt: refused,
  };
}

module.exports = { verifyFlowV2, verifyFlowV2Image };
