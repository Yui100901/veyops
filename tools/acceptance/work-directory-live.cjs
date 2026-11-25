const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdir, readFile, readlink, writeFile } = require('node:fs/promises');
const { Client } = require('ssh2');

const output = (nodeId, fieldId) => ({ kind: 'OUTPUT', nodeId, fieldId });
const value = (entry) => ({ kind: 'VALUE', value: entry });
const input = (fieldId) => ({ kind: 'INPUT', fieldId });
const node = (id, type, configuration = {}) => ({ id, name: id, type, ...configuration });
const targets = (...serverIds) => value({ serverIds });
const edge = (from, to) => ({ from, to });
const location = '/srv/veyops-stage0/contract-work-snapshot';
const contents = '<main>Acceptance work folder</main>\n';

function addFlow(canvas, startNode, end, nodes, edges, inputBindings, outputBindings) {
  canvas.nodes.push(
    startNode,
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
    startId: startNode.id,
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

function git(repository, ...args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
}

async function makeRepository() {
  const repo = '/accept/snapshot-source';
  await mkdir(repo);
  git(repo, 'init', '-b', 'main');
  await mkdir(repo + '/apps/api', { recursive: true });
  await writeFile(repo + '/index.html', 'outside build working directory\n');
  await writeFile(repo + '/apps/api/index.html', contents);
  await writeFile(repo + '/apps/api/.env.test', 'FIXTURE_SECRET=masked\n');
  git(repo, 'add', '.');
  git(
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Build from a nested workspace',
  );
  const sha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'clone', '--bare', repo, '/accept/repo/work-snapshot.git');
  return sha;
}

async function testTarget(command) {
  const key = (await readFile('/accept/host-ssh/test-b.pub', 'utf8')).trim().split(/\s+/)[1];
  const fingerprint = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex');
  const privateKey = await readFile('/accept/host-ssh/fixture-admin', 'utf8');
  const ssh = new Client();
  try {
    return await new Promise((resolve, reject) => {
      ssh.on('error', reject);
      ssh.on('ready', () => {
        ssh.exec(command, (error, channel) => {
          if (error) return reject(error);
          let text = '';
          channel.on('data', (chunk) => {
            text += chunk;
          });
          channel.stderr.on('data', (chunk) => {
            text += chunk;
          });
          channel.on('close', (code) =>
            code === 0 ? resolve(text) : reject(new Error(text || 'fixture SSH failed')),
          );
        });
      });
      ssh.connect({
        host: 'test-b',
        username: 'root',
        privateKey,
        hostVerifier: (hostKey) =>
          createHash('sha256').update(hostKey).digest('hex') === fingerprint,
        readyTimeout: 8000,
      });
    });
  } finally {
    ssh.end();
  }
}

async function verifyWorkDirectory({ api, fixture, execute }) {
  const sha = await makeRepository();
  const project = await api.post('/projects', {
    name: '工作目录跨机验收',
    slug: 'candidate-work-directory',
  });
  const projectPath = '/projects/' + project.id;
  const graph = projectPath + '/execution-graph';
  const repository = await api.post(projectPath + '/repositories', {
    name: 'Nested working-directory fixture',
    cloneUrl: 'http://manager:8088/work-snapshot.git',
  });
  const service = await api.post(projectPath + '/services', {
    name: '工作目录交付',
    slug: 'snapshot-service',
    serviceType: 'WEB',
  });
  const testA = fixture.serverIds['test-a'];
  const testB = fixture.serverIds['test-b'];
  const checkout = 'snapshot-checkout';
  const build = 'snapshot-build';
  const check = 'snapshot-reports';
  const inspect = 'snapshot-full';
  const deploy = 'snapshot-deploy';
  const release = (id, targetPath = location, artifactPath = 'dist/') =>
    node(id, 'DEPLOY_ARTIFACT', {
      deploy: { method: 'FILE', deployPath: targetPath, artifactPath },
    });
  const start = 'snapshot-start';
  const end = 'snapshot-end';
  const buildHistory = 'snapshot-history';
  const historyDeploy = 'snapshot-history-deploy';
  const publishedVersion = await publish(api, graph, (canvas) => {
    assert.equal(canvas.endpoints.length, 1);
    canvas.nodes = [];
    canvas.edges = [];
    canvas.endpoints = [];
    addFlow(
      canvas,
      node(start, 'START', {
        inputs: [
          {
            id: 'repository',
            name: '仓库',
            type: 'REPOSITORY',
            defaultValue: repository.id,
            runtimeOverride: false,
          },
          {
            id: 'gitVersion',
            name: '版本',
            type: 'GIT_REF',
            defaultValue: { kind: 'COMMIT', value: sha },
            runtimeOverride: false,
          },
        ],
      }),
      end,
      [
        node(checkout, 'CHECKOUT'),
        node(build, 'BUILD', {
          build: {
            buildLocation: 'TARGET',
            repoPath: 'apps/api',
            installCommand:
              'set -eu; test -s index.html; mkdir -p nested; cd nested; printf ok > install.marker',
            buildCommand: [
              'set -eu',
              'test -f nested/install.marker',
              'mkdir -p dist reports .git .veyops',
              'cp index.html dist/index.html',
              'printf "%s" "$VEYOPS_GIT_COMMIT_SHA" > reports/commit.txt',
              'touch .git/fake .veyops/fake private.txt',
              'cd nested',
            ].join('\n'),
            artifacts: [
              {
                id: 'snapshot',
                name: '工作目录快照',
                type: 'DIRECTORY',
                collection: 'WORK_DIRECTORY',
                excludePaths: ['private.txt'],
              },
            ],
          },
        }),
        node(check, 'CHECK', {
          shell: {
            location: 'TARGET',
            artifactPath: 'reports/',
            directory: 'apps/api',
            command:
              'set -eu; test -f index.html; test "$(cat "$VEYOPS_ARTIFACT_DIR/commit.txt")" = "$VEYOPS_GIT_COMMIT_SHA"; test ! -e "$VEYOPS_ARTIFACT_DIR/dist"',
          },
        }),
        node(inspect, 'SHELL', {
          shell: {
            location: 'TARGET',
            artifactPath: '.',
            command:
              'set -eu; cd "$VEYOPS_ARTIFACT_DIR"; test -f dist/index.html; test -f nested/install.marker; test ! -e .git; test ! -e .env.test; test ! -e .veyops; test ! -e private.txt',
          },
        }),
        release(deploy),
      ],
      [
        edge(start, checkout),
        edge(checkout, build),
        edge(build, check),
        edge(check, inspect),
        edge(inspect, deploy),
        edge(deploy, end),
      ],
      {
        [checkout]: { repository: input('repository'), version: input('gitVersion') },
        [build]: {
          workspace: output(checkout, 'workspace'),
          service: value({ serviceId: service.id }),
          targets: targets(testA),
        },
        [check]: {
          workspace: output(checkout, 'workspace'),
          targets: targets(testB),
        },
        [inspect]: { targets: targets(testB) },
        [deploy]: {
          service: value({ serviceId: service.id }),
          artifact: output(build, 'snapshot'),
          targets: targets(testB),
        },
      },
      {
        snapshot: {
          type: 'ARTIFACT',
          artifactType: 'DIRECTORY',
          binding: output(build, 'snapshot'),
        },
        report: { type: 'REPORT', binding: output(check, 'report') },
        release: { type: 'RELEASE', binding: output(deploy, 'release') },
      },
    );
  });
  const run = await execute(start, {}, { projectId: project.id, version: publishedVersion });
  const { snapshot, report, release: released } = run.detail.outputs;
  const instance = snapshot.instances[0];
  assert.equal(instance.serverId, testA);
  assert.equal(
    run.artifacts.find(({ id }) => id === instance.instanceId).physical.collection,
    'WORK_DIRECTORY',
  );
  assert.equal(snapshot.commitSha, sha);
  assert.equal(report.passed, true);
  assert.equal(released.targets[0].serverId, testB);
  assert.equal(released.targets[0].artifactInstanceId, instance.instanceId);
  for (const [id, path] of [
    [check, 'reports'],
    [inspect, '.'],
  ]) {
    assert.deepEqual(run.entry.scripts.find(({ nodeId }) => nodeId === id).artifact, {
      path,
      producers: [{ nodeId: build, fieldId: 'snapshot' }],
    });
  }
  const releasePath = '/accept/targets/test-b/deploy/contract-work-snapshot/current';
  const activation = await readlink(releasePath);
  assert.equal(await readFile(releasePath + '/index.html', 'utf8'), contents);
  for (const omitted of ['reports', 'private.txt', '.env.test']) {
    await assert.rejects(readFile(releasePath + '/' + omitted), { code: 'ENOENT' });
  }
  const replay = await publish(api, graph, (canvas) => {
    addFlow(
      canvas,
      node(buildHistory, 'START'),
      'snapshot-history-end',
      [release(historyDeploy)],
      [edge(buildHistory, historyDeploy), edge(historyDeploy, 'snapshot-history-end')],
      {
        [historyDeploy]: {
          service: value({ serviceId: service.id }),
          artifact: value({ artifactId: snapshot.artifactId, instanceId: instance.instanceId }),
          targets: targets(testB),
        },
      },
      {},
    );
  });
  const lock =
    '/var/tmp/.veyops-deployment-locks/path-' + createHash('sha256').update(location).digest('hex');
  await testTarget(
    `set -eu; umask 077; mkdir -- '${lock}'; printf work-snapshot-acceptance > '${lock}/owner'`,
  );
  let failed;
  try {
    const failure = await execute(
      buildHistory,
      {},
      { projectId: project.id, version: replay, expected: 'FAILED' },
    );
    const delivery = await api.get(projectPath + '/services/' + service.id + '/delivery-status');
    const target = delivery.find(({ serverId }) => serverId === testB);
    assert.equal(target.current.deploymentRecordId, released.targets[0].deploymentId);
    assert.equal(target.latestAttempt.releaseRunId, failure.detail.id);
    assert.equal(target.latestAttempt.releaseNodeId, historyDeploy);
    assert.equal(target.latestAttempt.phase, 'PREPARE');
    assert.equal(target.latestAttempt.deploymentRecordId, null);
    assert.ok(target.latestAttempt.taskTargetId && target.latestAttempt.errorSummary);
    assert.equal(await readlink(releasePath), activation);
    failed = target.latestAttempt;
  } finally {
    await testTarget(
      `set -eu; test "$(cat '${lock}/owner')" = work-snapshot-acceptance; rm -- '${lock}/owner'; rmdir -- '${lock}'`,
    );
  }
  const recovered = await execute(buildHistory, {}, { projectId: project.id, version: replay });
  const restored = recovered.releases.find(({ artifactId }) => artifactId === instance.instanceId);
  assert.ok(restored?.isCurrent);
  assert.equal(await readFile(releasePath + '/index.html', 'utf8'), contents);
  return {
    buildRunId: run.detail.id,
    commitSha: sha,
    artifactInstanceId: instance.instanceId,
    sourceServerId: testA,
    destinationServerId: testB,
    prepareFailure: failed,
    recoveredRunId: recovered.detail.id,
  };
}

module.exports = { verifyWorkDirectory };
