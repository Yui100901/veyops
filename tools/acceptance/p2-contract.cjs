const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
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

async function verifyAlternativeCheck({
  api,
  graph,
  execute,
  source,
  baseRepository,
  apiRepository,
  serverId,
}) {
  const start = 'candidate-check-start';
  const selector = 'candidate-check-selector';
  const condition = 'candidate-check-condition';
  const checkoutA = 'candidate-check-checkout-a';
  const checkoutB = 'candidate-check-checkout-b';
  const join = 'candidate-check-join';
  const check = 'candidate-check-ssh';
  const end = 'candidate-check-end';
  const chosenContent = execFileSync('git', [
    '--git-dir',
    source.repositoryPath,
    'show',
    `${source.nextCommitSha}:index.html`,
  ]);
  const checksum = createHash('sha256').update(chosenContent).digest('hex');
  const candidates = [
    { nodeId: checkoutA, repositoryId: baseRepository, commitSha: source.commitSha },
    { nodeId: checkoutB, repositoryId: apiRepository, commitSha: source.nextCommitSha },
  ];
  const useFirst = (fieldId) => ({
    kind: 'FIRST_AVAILABLE',
    sources: candidates.map(({ nodeId }) => output(nodeId, fieldId)),
  });
  const version = await publish(api, graph, (canvas) => {
    addFlow(
      canvas,
      start,
      end,
      [
        node(selector, 'FUNCTION', {
          operation: 'SHELL',
          shell: {
            location: 'MANAGER',
            command: `printf '%s\\n' 'VEYOPS_OUTPUT={"CHECK_BRANCH":"b"}'`,
          },
          outputs: [
            { id: 'branch', name: '选择结果', type: 'TEXT', referenceName: 'CHECK_BRANCH' },
          ],
        }),
        node(condition, 'CONDITION', { condition: { key: 'input', value: 'a' } }),
        node(checkoutA, 'CHECKOUT'),
        node(checkoutB, 'CHECKOUT'),
        node(join, 'JOIN'),
        node(check, 'CHECK', {
          shell: {
            location: 'TARGET',
            command: `printf '%s\\n' '${checksum}  index.html' | sha256sum -c -`,
          },
        }),
      ],
      [
        edge(start, selector),
        edge(selector, condition),
        edge(condition, checkoutA, 'TRUE'),
        edge(condition, checkoutB, 'FALSE'),
        edge(checkoutA, join),
        edge(checkoutB, join),
        edge(join, check),
        edge(check, end),
      ],
      {
        [condition]: { value: output(selector, 'branch') },
        ...Object.fromEntries(
          candidates.map(({ nodeId, repositoryId, commitSha }) => [
            nodeId,
            {
              repository: value(repositoryId),
              version: value({ kind: 'COMMIT', value: commitSha }),
            },
          ]),
        ),
        [check]: {
          workspace: useFirst('workspace'),
          source: useFirst('source'),
          targets: targets(serverId),
        },
      },
      { report: { type: 'REPORT', binding: output(check, 'report') } },
    );
  });
  const run = await execute(start, {}, { version });
  assert.deepEqual(
    [...run.entry.checkouts].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    candidates,
  );
  const plannedCheck = run.entry.scripts.find(({ nodeId }) => nodeId === check);
  assert.equal(plannedCheck.serverId, serverId);
  assert.deepEqual(
    plannedCheck.workspace.candidates.map(
      ({ producerNodeId, producerField, repositoryId, commitSha }) => ({
        nodeId: producerNodeId,
        producerField,
        repositoryId,
        commitSha,
      }),
    ),
    candidates.map((candidate) => ({ ...candidate, producerField: 'workspace' })),
  );
  const runNode = (id) => run.detail.nodes.find(({ nodeId }) => nodeId === id);
  assert.equal(runNode(checkoutA)?.status, 'SKIPPED');
  const selected = runNode(checkoutB);
  assert.equal(selected?.status, 'SUCCESS');
  assert.equal(selected.output.source.repositoryId, apiRepository);
  assert.equal(selected.output.source.commitSha, source.nextCommitSha);
  const checked = runNode(check);
  assert.equal(checked?.status, 'SUCCESS');
  assert.deepEqual(
    checked.targets.map(({ serverId, status }) => [serverId, status]),
    [[serverId, 'SUCCESS']],
  );
  for (const fieldId of ['workspace', 'source']) {
    assert.deepEqual(
      checked.inputs.find((entry) => entry.fieldId === fieldId)?.source,
      output(checkoutB, fieldId),
    );
  }
  assert.equal(run.detail.outputs.report.passed, true);
  const log = await api.get(graph + '/runs/' + run.detail.id + '/nodes/' + check + '/logs');
  assert.equal(log.source, 'TASK');
  assert.match(log.content, /index\.html: OK/);
  return {
    runId: run.detail.id,
    candidates,
    selected: selected.output.source,
    checkedOn: serverId,
  };
}

async function verifyV2Templates({ api, fixture, execute, source, html }) {
  const project = await api.post('/projects', {
    name: '流程模板实机验收',
    slug: 'candidate-template-project',
  });
  const projectPath = `/projects/${project.id}`;
  const graph = `${projectPath}/execution-graph`;
  const seed = await api.get(graph);
  const minimal = seed.draft.canvas;
  assert.equal(seed.revision, 1);
  assert.equal(seed.publishedVersion, null);
  assert.equal(minimal.endpoints.length, 1);
  assert.equal(minimal.edges.length, 4);
  assert.deepEqual(
    minimal.nodes.map(({ operation, type }) => operation ?? type),
    ['START', 'CHECKOUT', 'BUILD', 'DEPLOY_ARTIFACT', 'END'],
  );
  const minimalId = minimal.endpoints[0].startId;
  assert.deepEqual((await api.get(graph)).draft.canvas, minimal);

  const templateIds = ['MINIMAL_CI_CD', 'CI_BUILD', 'CD_DEPLOY'];
  const { flowTemplates } = await api.get(graph + '/catalog');
  assert.deepEqual(
    flowTemplates.map(({ id }) => id),
    templateIds,
  );
  const [ci, cd] = await Promise.all(
    templateIds
      .slice(1)
      .map((templateId) =>
        api.post(graph + '/draft/templates/expand', { templateId, artifactType: 'DIRECTORY' }),
      ),
  );
  assert.deepEqual((await api.get(graph)).draft.canvas, minimal);
  assert.equal((await api.get(graph)).revision, seed.revision);

  const repository = await api.post(projectPath + '/repositories', {
    name: '模板源码',
    cloneUrl: 'http://manager:8088/storefront.git',
  });
  const service = await api.post(projectPath + '/services', {
    name: '候选模板服务',
    slug: 'candidate-template-service',
    serviceType: 'API',
  });
  const serverId = fixture.serverIds['test-a'];
  const buildTargets = { serverIds: [serverId] };
  const releaseTargets = { serverIds: [serverId] };
  const configureBuild = (fragment) => {
    const build = fragment.nodes.find(({ operation }) => operation === 'BUILD');
    build.build.buildLocation = 'TARGET';
    build.build.buildCommand = 'test -s index.html && mkdir -p dist && cp index.html dist/';
    build.build.artifacts[0].path = 'dist';
  };
  const directory = 'contract-execution-template';
  const configureDeploy = (fragment) => {
    const deploy = fragment.nodes.find(({ operation }) => operation === 'DEPLOY_ARTIFACT');
    assert.equal(deploy.deploy.method, 'FILE');
    deploy.deploy.deployPath = '/srv/veyops-stage0/' + directory;
    return deploy;
  };
  configureBuild(ci.canvas);
  const check = ci.canvas.nodes.find(({ operation }) => operation === 'CHECK');
  Object.assign(check.shell, { location: 'TARGET', command: 'test -s index.html' });
  ci.canvas.endpoints[0].inputBindings[check.id].targets = {
    kind: 'INPUT',
    fieldId: 'buildTargets',
  };
  const cdDeploy = configureDeploy(cd.canvas);
  const health = cd.canvas.nodes.find(({ operation }) => operation === 'HEALTH_CHECK');
  assert.equal(health.healthCheck.requireHealthy, true);
  health.healthCheck.command = 'test -s index.html || exit 10';
  const version = await publish(api, graph, (canvas) => {
    configureBuild(canvas);
    configureDeploy(canvas);
    for (const { canvas: fragment } of [ci, cd]) {
      canvas.nodes.push(...fragment.nodes);
      canvas.edges.push(...fragment.edges);
      canvas.endpoints.push(...fragment.endpoints);
    }
  });

  const previewCheck = graph + '/flows/' + ci.startId + '/preview';
  for (const [buildTargets, status] of [
    [undefined, 400],
    [{ serverIds: [serverId, fixture.serverIds['test-b']] }, 409],
  ]) {
    const response = await api.request('POST', previewCheck, {
      version,
      inputs: { parameters: { repository: repository.id, buildTargets } },
    });
    const { error } = await response.json();
    assert.equal(response.status, status, error?.message);
    assert.equal(error.planIssue.nodeId, check.id);
    assert.equal(error.planIssue.fieldId, 'targets');
    assert.equal(error.planIssue.fieldSection, 'input');
  }

  const assertBuilt = (run, sha) => {
    assert.deepEqual(
      run.entry.checkouts.map(({ repositoryId, commitSha }) => [repositoryId, commitSha]),
      [[repository.id, sha]],
    );
    const produced = run.detail.outputs.buildArtifact;
    assert.equal(produced.type, 'DIRECTORY');
    assert.equal(produced.commitSha, sha);
    const [instance] = produced.instances;
    assert.equal(instance.serverId, serverId);
    assert.ok(
      run.artifacts.some(
        ({ id, artifactId }) => id === instance.instanceId && artifactId === produced.artifactId,
      ),
    );
    return produced;
  };
  const previous = await execute(
    ci.startId,
    {
      repository: repository.id,
      service: { serviceId: service.id },
      buildTargets,
    },
    { projectId: project.id, version },
  );
  const old = assertBuilt(previous, source.commitSha);
  assert.equal(previous.detail.outputs.report.passed, true);
  assert.deepEqual(previous.releases, []);
  const plannedCheck = previous.entry.scripts.find(({ nodeId }) => nodeId === check.id);
  assert.equal(plannedCheck.serverId, serverId);
  assert.equal(plannedCheck.directory, '.');
  assert.equal(plannedCheck.workspace.commitSha, source.commitSha);

  const minimalRun = await execute(
    minimalId,
    {
      repository: repository.id,
      gitVersion: { kind: 'COMMIT', value: source.nextCommitSha },
      service: { serviceId: service.id },
      buildTargets,
      releaseTargets,
    },
    { projectId: project.id, version, checkIdempotency: true },
  );
  const fresh = assertBuilt(minimalRun, source.nextCommitSha);
  assert.equal(
    minimalRun.detail.outputs.release.targets[0].artifactInstanceId,
    fresh.instances[0].instanceId,
  );
  const contentPath = `/accept/targets/test-a/deploy/${directory}/current/index.html`;
  const nextHtml = execFileSync(
    'git',
    ['--git-dir', source.repositoryPath, 'show', `${source.nextCommitSha}:index.html`],
    { encoding: 'utf8' },
  );
  assert.equal((await readFile(contentPath, 'utf8')).trim(), nextHtml.trim());

  const cdRun = await execute(
    cd.startId,
    {
      artifact: { artifactId: old.artifactId },
      service: { serviceId: service.id },
      releaseTargets,
    },
    {
      projectId: project.id,
      version,
      decision: {
        releaseNodeId: cdDeploy.id,
        serviceId: service.id,
        serverIds: [serverId],
      },
    },
  );
  const { release, healthStatus } = cdRun.detail.outputs;
  const [legacyInstance] = old.instances;
  assert.equal(healthStatus, 'HEALTHY');
  assert.equal(release.serviceId, service.id);
  assert.equal(release.targets[0].serverId, serverId);
  assert.equal(release.targets[0].health, 'HEALTHY');
  assert.equal(release.targets[0].artifactInstanceId, legacyInstance.instanceId);
  assert.deepEqual(cdRun.entry.decisions[0].scope.artifactIds, [legacyInstance.instanceId]);
  assert.equal(cdRun.releases[0].artifactId, legacyInstance.instanceId);
  assert.equal(cdRun.releases[0].rollbackOfDeploymentId, null);
  assert.equal((await readFile(contentPath, 'utf8')).trim(), html);

  return {
    catalog: templateIds,
    seed: { projectId: project.id, startId: minimalId, revision: seed.revision },
    ci: { flowId: ci.startId, runId: previous.detail.id, artifactId: old.artifactId },
    minimal: { flowId: minimalId, runId: minimalRun.detail.id, artifactId: fresh.artifactId },
    cd: { flowId: cd.startId, runId: cdRun.detail.id, artifactId: old.artifactId, healthStatus },
  };
}

async function verifyScriptCompose({
  api,
  project,
  graph,
  execute,
  repositoryId,
  serverId,
  source,
}) {
  const service = await api.post(project + '/services', {
    name: '脚本镜像验收服务',
    slug: 'candidate-script-compose',
    serviceType: 'WEB',
  });
  const start = 'candidate-script-compose';
  const checkout = start + '-checkout';
  const script = start + '-image';
  const deploy = start + '-deploy';
  const health = start + '-health';
  const end = start + '-end';
  const image = 'veyops-acceptance-script:1';
  const template = [
    'services:',
    '  web:',
    '    image: ${VEYOPS_IMAGE}',
    '    ports:',
    "      - '18082:8080'",
    '',
  ].join('\n');
  const checksum = createHash('sha256').update(template).digest('hex');
  const version = await publish(api, graph, (canvas) => {
    addFlow(
      canvas,
      start,
      end,
      [
        node(checkout, 'CHECKOUT'),
        node(script, 'SHELL', {
          shell: {
            location: 'TARGET',
            command: [
              'set -eu',
              'test -s index.html',
              'mkdir -p ops',
              "cat >ops/deployment.yaml <<'VEYOPS_COMPOSE'",
              template.trimEnd(),
              'VEYOPS_COMPOSE',
              'docker build -t ' + image + ' .',
            ].join('\n'),
            artifacts: [
              {
                id: 'image',
                name: '脚本镜像',
                type: 'DOCKER_IMAGE',
                imageReference: image,
                composeFilePath: 'ops/deployment.yaml',
                persist: false,
              },
            ],
          },
        }),
        node(deploy, 'DEPLOY_ARTIFACT', {
          deploy: {
            method: 'COMPOSE',
            deployPath: '/srv/veyops-stage0/contract-script-compose',
            composeSource: { kind: 'ARTIFACT' },
          },
        }),
        node(health, 'HEALTH_CHECK', {
          healthCheck: {
            command:
              'node -e "fetch(\'http://127.0.0.1:18082/\').then(r=>{if(!r.ok)process.exitCode=1})"',
            requireHealthy: true,
          },
        }),
      ],
      [
        edge(start, checkout),
        edge(checkout, script),
        edge(script, deploy),
        edge(deploy, health),
        edge(health, end),
      ],
      {
        [checkout]: {
          repository: value(repositoryId),
          version: value({ kind: 'COMMIT', value: source.commitSha }),
        },
        [script]: {
          workspace: output(checkout, 'workspace'),
          source: output(checkout, 'source'),
          service: value({ serviceId: service.id }),
          targets: targets(serverId),
        },
        [deploy]: {
          artifact: output(script, 'image'),
          service: value({ serviceId: service.id }),
          targets: targets(serverId),
        },
        [health]: { release: output(deploy, 'release') },
      },
      { release: { type: 'RELEASE', binding: output(health, 'release') } },
    );
  });
  const result = await execute(start, {}, { version });
  const released = result.detail.outputs.release.targets[0];
  assert.equal(released.serverId, serverId);
  assert.equal(released.health, 'HEALTHY');
  const record = result.releases.find(({ id }) => id === released.deploymentId);
  assert.equal(record.artifactId, released.artifactInstanceId);
  assert.equal(record.composeRelease.template.source, 'ARCHIVE');
  assert.equal(record.composeRelease.template.path, 'ops/deployment.yaml');
  assert.equal(record.composeRelease.template.checksum, checksum);
  assert.match(record.composeRelease.imageId, /^sha256:[a-f0-9]{64}$/);
  return {
    runId: result.detail.id,
    commitSha: source.commitSha,
    deployment: record.composeRelease,
  };
}

async function verifyP2Contract({ api, fixture, execute, source, shellArtifactId, files, html }) {
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
        node('candidate-main', 'FUNCTION', {
          name: '检出源码',
          operation: 'CHECKOUT',
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
      [release(web, 'contract-web'), release(apiId, 'contract-api')],
      [
        edge(pair, web),
        edge(pair, apiId),
        edge(web, 'candidate-pair-output'),
        edge(apiId, 'candidate-pair-output'),
      ],
      {
        [web]: {
          service: value({ serviceId: webService }),
          artifact: artifact(shellArtifactId),
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
    alternativeCheck: await verifyAlternativeCheck({
      api,
      graph,
      execute,
      source,
      baseRepository,
      apiRepository: apiRepository.id,
      serverId: testA,
    }),
    templates: await verifyV2Templates({ api, fixture, execute, source, html }),
    scriptCompose: await verifyScriptCompose({
      api,
      project,
      graph,
      execute,
      repositoryId: baseRepository,
      serverId: composeA,
      source,
    }),
  };
}

module.exports = { prepareP2Repository, verifyP2Contract };
