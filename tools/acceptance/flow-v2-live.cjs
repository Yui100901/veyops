const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdir, readFile, readlink, writeFile } = require('node:fs/promises');
const { testTarget } = require('./work-directory-live.cjs');

const originalContent = '<main>VeyOps shared-workspace delivery</main>\n';
const sourceDirectory = 'nested/flow-v2-source';
const targetDirectory = '/srv/veyops-stage0/flow-v2';
const activation = '/accept/targets/test-b/deploy/flow-v2/current';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 15_000 }).trim();
}

async function repositoryFixture() {
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

module.exports = { verifyFlowV2 };
