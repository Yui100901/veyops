const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

function checkSharedCanvas(definition) {
  const flows = new Map(definition.flows.map((flow) => [flow.id, flow]));
  const endpoints = new Map(definition.canvas.endpoints.map((end) => [end.startId, end]));
  function activeNodes(id) {
    const flow = flows.get(id);
    assert.ok(flow, `缺少已发布执行流 ${id}`);
    return flow.nodes.map((node) => node.id);
  }
  for (const id of ['target-image', 'build-and-deploy-compose', 'reviewed-target-bundle'])
    assert.ok(activeNodes(id).includes('build-image'));
  for (const id of ['build-and-deploy-compose', 'deploy-compose'])
    assert.ok(activeNodes(id).includes('deploy-image'));
  assert.ok(!activeNodes('target-image').includes('deploy-image'));
  assert.ok(!activeNodes('deploy-compose').includes('build-image'));
  assert.deepEqual(
    endpoints.get('build-and-deploy-compose').inputBindings['deploy-image'].artifact,
    { kind: 'OUTPUT', nodeId: 'build-image', fieldId: 'image' },
  );
  assert.deepEqual(endpoints.get('deploy-compose').inputBindings['deploy-image'].artifact, {
    kind: 'INPUT',
    fieldId: 'artifact',
  });
  assert.deepEqual(endpoints.get('reviewed-target-bundle').inputBindings['build-image'].review, {
    kind: 'OUTPUT',
    nodeId: 'review-image-source',
    fieldId: 'review',
  });
}

async function verifySharedDelivery({
  api,
  execute,
  graph,
  fixture,
  buildOnly,
  historical,
  incompatibleDirectory,
  productionTargets,
  composeExpected,
  artifactFor,
  verifyArtifact,
  verifyComposeRelease,
  verifyDirectoryRelease,
}) {
  const published = await api.get(`${graph}/versions/${fixture.version}`);
  checkSharedCanvas(published.definition);

  const { sha, repositoryId, html } = composeExpected;
  const origin = { sha, repositoryId, servers: productionTargets };
  async function bundle(run) {
    const directory = artifactFor(run, 'directory', { ...origin, kind: 'DIRECTORY' });
    const image = artifactFor(run, 'image', { ...origin, kind: 'DOCKER_IMAGE' });
    assert.notEqual(directory.artifactId, image.artifactId);
    assert.ok(directory.instances.every(({ name }) => name === 'webDirectory'));
    assert.ok(image.instances.every(({ name }) => name === 'image'));
    const instances = [...directory.instances, ...image.instances];
    assert.ok(instances.every(({ graphNodeId }) => graphNodeId === 'build-image'));
    assert.ok(instances[0].graphNodeRunId);
    assert.ok(
      instances.every(({ graphNodeRunId }) => graphNodeRunId === instances[0].graphNodeRunId),
    );
    await verifyArtifact(api, directory);
    await verifyArtifact(api, image);
    return { directory, image };
  }

  assert.equal(buildOnly.releases.length, 0);
  const only = await bundle(buildOnly);
  assert.ok(
    incompatibleDirectory.instances.every((instance) =>
      only.directory.instances.every((candidate) => instance.createdAt > candidate.createdAt),
    ),
    '联调目录应晚于生产模拟目录产生',
  );
  assert.ok(
    incompatibleDirectory.instances.every(({ serverId }) => !productionTargets.includes(serverId)),
  );
  const latest = await execute(
    'deploy-latest-directory',
    {},
    {
      plan: { releaseTargets: productionTargets },
    },
  );
  await verifyDirectoryRelease(latest, only.directory);

  const buildPlan = { collection: 'production-config', sha, buildTargets: productionTargets };
  const reviewed = await execute(
    'reviewed-target-bundle',
    {},
    {
      plan: buildPlan,
      decision: { repositoryId, sha, buildNodeId: 'build-image' },
    },
  );
  assert.equal(reviewed.releases.length, 0);
  const reviewedBundle = await bundle(reviewed);
  const current = await execute(
    'build-and-deploy-compose',
    {},
    {
      plan: { ...buildPlan, releaseTargets: productionTargets },
    },
  );
  const currentBundle = await bundle(current);
  await verifyComposeRelease(fixture, current, currentBundle.image, composeExpected);

  const shell = await execute(
    'shell-register',
    { artifactDir: 'custom/acceptance-static' },
    {
      plan: { collection: 'test-config', buildTargets: [] },
    },
  );
  const shellArtifact = artifactFor(shell, 'directory', {
    sha,
    repositoryId,
    kind: 'DIRECTORY',
    servers: [null],
  });
  const [registered] = shellArtifact.instances;
  assert.equal(registered.name, 'shellDirectory');
  assert.equal(registered.graphNodeId, 'register-shell');
  assert.equal(registered.physical.location, 'BUILDER_PATH');
  assert.equal((await readFile(join(registered.physical.path, 'index.html'), 'utf8')).trim(), html);
  await verifyArtifact(api, shellArtifact);

  return {
    buildOnly: { directory: only.directory.artifactId, image: only.image.artifactId },
    reviewed: {
      directory: reviewedBundle.directory.artifactId,
      image: reviewedBundle.image.artifactId,
    },
    currentRelease: { runId: current.detail.id, image: currentBundle.image.artifactId },
    historicalRelease: { runId: historical.detail.id, image: only.image.artifactId },
    latestRelease: {
      runId: latest.detail.id,
      directory: only.directory.artifactId,
      skippedDirectory: incompatibleDirectory.artifactId,
    },
    shell: { runId: shell.detail.id, directory: shellArtifact.artifactId },
  };
}

module.exports = { verifySharedDelivery };
