const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const output = (nodeId, fieldId) => ({ kind: 'OUTPUT', nodeId, fieldId });
const value = (entry) => ({ kind: 'VALUE', value: entry });
const node = (id, type, configuration = {}) => ({ id, name: id, type, ...configuration });
const edge = (from, to, when) => ({ from, to, ...(when && { when }) });
const artifact = (artifactId) => value({ artifactId });
const targets = (...serverIds) => value({ serverIds });

function prepareP2Repository(root, source) {
  execFileSync('git', [
    'clone',
    '--quiet',
    '--bare',
    '--branch',
    'acceptance-next',
    source.repositoryPath,
    join(root, 'dependency.git'),
  ]);
  execFileSync('git', [
    '--git-dir',
    source.repositoryPath,
    'tag',
    'acceptance-next',
    source.commitSha,
  ]);
}

function addFlow(canvas, start, end, nodes, edges, inputBindings, outputBindings) {
  canvas.nodes.push(
    node(start, 'START'),
    ...nodes,
    node(end, 'END', {
      outputs: Object.entries(outputBindings).map(([id, { type, artifactType }]) => ({
        id,
        name: id,
        type,
        artifactType,
      })),
    }),
  );
  canvas.edges.push(...edges);
  canvas.endpoints.push({
    startId: start,
    endId: end,
    inputBindings,
    outputBindings: Object.fromEntries(
      Object.entries(outputBindings).map(([id, spec]) => [id, spec.binding]),
    ),
  });
}

async function publish(api, path, extend) {
  const { draft, revision } = await api.get(path);
  extend(draft.canvas);
  const saved = await api.call('PUT', path + '/draft', {
    expectedRevision: revision,
    definition: { flows: [], canvas: draft.canvas },
  });
  const { publishedVersion } = await api.post(path + '/publish', {
    expectedRevision: saved.revision,
  });
  return publishedVersion;
}

async function verifyP2Contract({ api, fixture, execute, source, managerArtifact, files, html }) {
  const project = '/projects/' + fixture.projectId;
  const graph = project + '/execution-graph';
  const baseRepository = fixture.repositoryIds['web-repo'];
  const apiRepository = await api.post(project + '/repositories', {
    name: 'candidate-dependency',
    cloneUrl: 'http://manager:8088/dependency.git',
  });
  const apiService = await api.post(project + '/services', {
    name: '候选 API',
    slug: 'candidate-api',
    serviceType: 'API',
  });
  const webService = fixture.serviceIds.storefront;
  const testA = fixture.serverIds['test-a'];
  const testB = fixture.serverIds['test-b'];
  const composeA = fixture.serverIds['production-a'];

  const build = 'candidate-build-api';
  const version = await publish(api, graph, (canvas) => {
    addFlow(
      canvas,
      'candidate-multi-source',
      'candidate-api-output',
      [
        node('candidate-main', 'CHECKOUT', {
          name: '检出源码',
          inputs: [{ id: 'version', name: 'Git 版本', type: 'GIT_REF' }],
        }),
        node('candidate-next', 'CHECKOUT', { name: '检出源码' }),
        node('candidate-tag', 'CHECKOUT'),
        node('candidate-dependency', 'CHECKOUT'),
        node(build, 'BUILD', {
          build: {
            buildLocation: 'TARGET',
            dependencies: ['web-next', 'api'],
            buildCommand: [
              'set -eu',
              'test -s "$VEYOPS_GRAPH_DEPENDENCY_ROOT/web-next/index.html"',
              'test -s "$VEYOPS_GRAPH_DEPENDENCY_ROOT/api/index.html"',
              'if cmp -s index.html "$VEYOPS_GRAPH_DEPENDENCY_ROOT/web-next/index.html"; then exit 8; fi',
              'mkdir -p dist',
              'cp index.html dist/index.html',
            ].join('\n'),
            artifacts: [{ id: 'apiBundle', name: 'API 目录', type: 'DIRECTORY', path: 'dist' }],
          },
        }),
      ],
      [
        edge('candidate-multi-source', 'candidate-main'),
        edge('candidate-main', 'candidate-next'),
        edge('candidate-next', 'candidate-tag'),
        edge('candidate-tag', 'candidate-dependency'),
        edge('candidate-dependency', build),
        edge(build, 'candidate-api-output'),
      ],
      {
        'candidate-main': { repository: value(baseRepository) },
        'candidate-next': {
          repository: value(baseRepository),
          version: value({ kind: 'BRANCH', value: 'acceptance-next' }),
        },
        'candidate-tag': {
          repository: value(baseRepository),
          version: value({ kind: 'TAG', value: 'acceptance-next' }),
        },
        'candidate-dependency': { repository: value(apiRepository.id) },
        [build]: {
          workspace: output('candidate-main', 'workspace'),
          'dependency_web-next': output('candidate-next', 'workspace'),
          dependency_api: output('candidate-dependency', 'workspace'),
          service: value({ serviceId: apiService.id }),
          targets: targets(composeA),
        },
      },
      {
        apiBundle: {
          type: 'ARTIFACT',
          artifactType: 'DIRECTORY',
          binding: output(build, 'apiBundle'),
        },
      },
    );
  });
  const built = await execute('candidate-multi-source', {}, { version, checkIdempotency: true });
  assert.deepEqual(
    built.entry.checkouts.map(({ repositoryId, commitSha }) => [repositoryId, commitSha]),
    [
      [baseRepository, source.commitSha],
      [baseRepository, source.nextCommitSha],
      [baseRepository, source.commitSha],
      [apiRepository.id, source.nextCommitSha],
    ],
  );
  const { draft: dependencyDraft } = await api.get(graph);
  const missingDependency = dependencyDraft.canvas.endpoints.find(
    ({ startId }) => startId === 'candidate-multi-source',
  );
  delete missingDependency.inputBindings[build].dependency_api;
  const { issues } = await api.post(graph + '/validate', {
    definition: { flows: [], canvas: dependencyDraft.canvas },
  });
  const dependencyIssue = issues.find(
    ({ nodeId, fieldId }) => nodeId === build && fieldId === 'dependency_api',
  );
  assert.equal(dependencyIssue?.flowId, 'candidate-multi-source');
  const bundle = built.detail.outputs.apiBundle;
  assert.equal(bundle.name, 'API 目录');
  assert.equal(bundle.type, 'DIRECTORY');
  assert.equal(bundle.instances.length, 1);
  assert.equal(bundle.instances[0].serverId, composeA);
  const [registered] = built.artifacts;
  assert.equal(registered.id, bundle.instances[0].instanceId);
  assert.deepEqual(
    new Set(
      registered.sources.map(({ repositoryId, commitSha }) => repositoryId + ':' + commitSha),
    ),
    new Set(
      built.entry.checkouts.map(({ repositoryId, commitSha }) => repositoryId + ':' + commitSha),
    ),
  );

  const pair = 'candidate-pair';
  const partial = 'candidate-partial';
  const temporary = 'candidate-temp';
  const child = 'candidate-temp-child';
  const versionWithRelease = await publish(api, graph, (canvas) => {
    const release = (id, name) =>
      node(id, 'DEPLOY_ARTIFACT', {
        deploy: { method: 'FILE', deployPath: '/srv/veyops-stage0/' + name },
      });
    const web = 'candidate-release-web';
    const apiId = 'candidate-release-api';
    addFlow(
      canvas,
      pair,
      'candidate-pair-output',
      [
        node('candidate-fork', 'PARALLEL'),
        release(web, 'contract-web'),
        release(apiId, 'contract-api'),
        node('candidate-join', 'JOIN'),
      ],
      [
        edge(pair, 'candidate-fork'),
        edge('candidate-fork', web),
        edge('candidate-fork', apiId),
        edge(web, 'candidate-join'),
        edge(apiId, 'candidate-join'),
        edge('candidate-join', 'candidate-pair-output'),
      ],
      {
        [web]: {
          service: value({ serviceId: webService }),
          artifact: artifact(managerArtifact.artifactId),
          targets: targets(testA),
        },
        [apiId]: {
          service: value({ serviceId: apiService.id }),
          artifact: artifact(bundle.artifactId),
          targets: targets(composeA),
        },
      },
      {
        webRelease: { type: 'RELEASE', binding: output(web, 'release') },
        apiRelease: { type: 'RELEASE', binding: output(apiId, 'release') },
      },
    );
    const deploy = 'candidate-release-partial';
    const probe = 'candidate-survivor-probe';
    const end = 'candidate-partial-output';
    addFlow(
      canvas,
      partial,
      end,
      [
        release(deploy, 'contract-partial'),
        node(probe, 'HEALTH_CHECK', { healthCheck: { command: 'exit 0' } }),
      ],
      [
        edge(partial, deploy),
        edge(deploy, end, 'SUCCESS'),
        edge(deploy, probe, 'PARTIAL_SUCCESS'),
        edge(probe, end),
      ],
      {
        [deploy]: {
          service: value({ serviceId: webService }),
          artifact: artifact(files.test.artifactId),
          targets: targets(testA, testB),
        },
        [probe]: { release: output(deploy, 'release'), targets: targets(testA) },
      },
      {
        result: {
          type: 'RELEASE',
          binding: {
            kind: 'FIRST_AVAILABLE',
            sources: [output(probe, 'release'), output(deploy, 'release')],
          },
        },
      },
    );
    const childRelease = 'candidate-temp-release';
    addFlow(
      canvas,
      child,
      'candidate-temp-child-output',
      [release(childRelease, 'contract-temporary')],
      [edge(child, childRelease), edge(childRelease, 'candidate-temp-child-output')],
      {
        [childRelease]: {
          service: value({ serviceId: webService }),
          artifact: { kind: 'INPUT', fieldId: 'directory' },
          targets: targets(testA),
        },
      },
      { release: { type: 'RELEASE', binding: output(childRelease, 'release') } },
    );
    canvas.nodes.find(({ id }) => id === child).inputs = [
      {
        id: 'directory',
        name: '目录',
        type: 'ARTIFACT',
        artifactType: 'DIRECTORY',
        required: true,
      },
    ];
    addFlow(
      canvas,
      temporary,
      'candidate-temp-output',
      [
        node('candidate-temp-checkout', 'CHECKOUT'),
        node('candidate-temp-build', 'BUILD', {
          build: {
            buildLocation: 'TARGET',
            buildCommand: 'mkdir -p dist && cp index.html dist/',
            artifacts: [{ name: 'temporary', type: 'DIRECTORY', path: 'dist', persist: false }],
          },
        }),
        node('candidate-temp-call', 'FLOW_CALL', { flowId: child }),
      ],
      [
        edge(temporary, 'candidate-temp-checkout'),
        edge('candidate-temp-checkout', 'candidate-temp-build'),
        edge('candidate-temp-build', 'candidate-temp-call'),
        edge('candidate-temp-call', 'candidate-temp-output'),
      ],
      {
        'candidate-temp-checkout': { repository: value(baseRepository) },
        'candidate-temp-build': {
          workspace: output('candidate-temp-checkout', 'workspace'),
          service: value({ serviceId: webService }),
          targets: targets(testA),
        },
        'candidate-temp-call': { directory: output('candidate-temp-build', 'temporary') },
      },
      { release: { type: 'RELEASE', binding: output('candidate-temp-call', 'release') } },
    );
  });
  const paired = await execute(pair, {}, { version: versionWithRelease, checkIdempotency: true });
  for (const [field, service, server, target, directory] of [
    ['webRelease', webService, testA, 'test-a', 'contract-web'],
    ['apiRelease', apiService.id, composeA, 'production-a', 'contract-api'],
  ]) {
    const result = paired.detail.outputs[field];
    assert.equal(result.serviceId, service);
    assert.equal(result.status, 'SUCCESS');
    const [entry] = result.targets;
    assert.equal(entry.serverId, server);
    const record = paired.releases.find(({ id }) => id === entry.deploymentId);
    assert.equal(record?.artifactId, entry.artifactInstanceId);
    assert.equal(
      (
        await readFile(`/accept/targets/${target}/deploy/${directory}/current/index.html`, 'utf8')
      ).trim(),
      html,
    );
  }
  await writeFile(
    '/accept/targets/test-b/deploy/contract-partial',
    'fixture blocks release directory\n',
    {
      flag: 'wx',
    },
  );
  const recovered = await execute(
    partial,
    {},
    { version: versionWithRelease, expected: 'PARTIAL_FAILED' },
  );
  const deployEvidence = recovered.detail.nodes.find(
    ({ nodeId }) => nodeId === 'candidate-release-partial',
  );
  const failed = deployEvidence.output.release.targets.find(({ serverId }) => serverId === testB);
  assert.equal(failed.status, 'FAILED');
  assert.ok(failed.errorSummary);
  assert.ok(failed.plannedArtifactInstanceId);
  const check = recovered.detail.outputs.result;
  assert.equal(check.operation, 'CHECK');
  assert.equal(check.healthStatus, 'HEALTHY');
  assert.deepEqual(
    check.targets.map(({ serverId }) => serverId),
    [testA],
  );
  const nested = await execute(temporary, {}, { version: versionWithRelease });
  const tempBuild = nested.detail.nodes.find(({ nodeId }) => nodeId === 'candidate-temp-build');
  const temporaryArtifact = tempBuild.output.temporary;
  assert.equal(temporaryArtifact.scope, 'TEMPORARY');
  assert.equal(temporaryArtifact.rootRunId, nested.detail.id);
  assert.equal(
    nested.detail.outputs.release.targets[0].artifactInstanceId,
    temporaryArtifact.instances[0].instanceId,
  );
  assert.equal(
    nested.artifacts.some(({ artifactId }) => artifactId === temporaryArtifact.artifactId),
    false,
  );
  await api.call(
    'POST',
    graph + '/flows/' + child + '/preview',
    {
      version: versionWithRelease,
      inputs: { parameters: { directory: { artifactId: temporaryArtifact.artifactId } } },
    },
    400,
  );
  assert.equal(
    (
      await readFile('/accept/targets/test-a/deploy/contract-temporary/current/index.html', 'utf8')
    ).trim(),
    html,
  );
  const testSetId = fixture.environmentSetIds['test-config'];
  const setPath = project + '/environment-sets/' + testSetId;
  const set = await api.get(setPath);
  const oldChoice = {
    version: fixture.version,
    inputs: { parameters: { environmentSet: testSetId } },
  };
  const targetFiles = graph + '/flows/target-files';
  const oldPlan = await api.post(targetFiles + '/preview', oldChoice);
  const oldVariables = set.variables.map(({ key, value, description, isSecret }) => ({
    key,
    ...(description && { description }),
    isSecret,
    ...(isSecret ? { keepSecret: true } : { value }),
  }));
  const changedSet = await api.call('PATCH', setPath, {
    expectedRevision: set.revision,
    variables: [...oldVariables, { key: 'ACCEPT_CONFIG_PROBE', value: 'changed' }],
  });
  const newPlan = await api.post(targetFiles + '/preview', oldChoice);
  assert.notEqual(oldPlan.configurationHash, newPlan.configurationHash);
  await api.call(
    'POST',
    targetFiles + '/run',
    {
      ...oldChoice,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: oldPlan.configurationHash,
      expectedPlanSections: oldPlan.planSections,
    },
    409,
  );
  await api.call('PATCH', setPath, {
    expectedRevision: changedSet.revision,
    variables: oldVariables,
  });
  return {
    multiSourceRun: built.detail.id,
    gitVersions: built.entry.checkouts,
    dependencyIssue,
    staleConfigurationRejected: true,
    dualReleaseRun: paired.detail.id,
    partialReleaseRun: recovered.detail.id,
    temporaryChildRun: nested.detail.id,
    failedTarget: failed,
    verifiedTarget: check.targets[0],
  };
}

module.exports = { prepareP2Repository, verifyP2Contract };
