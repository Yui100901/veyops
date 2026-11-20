const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { readFile, readlink, mkdir, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');

const [revision, image] = process.argv.slice(2);
assert.match(revision, /^[a-f0-9]{40}$/);
assert.match(image, /^[a-zA-Z0-9.:/_-]+$/);
assert.equal(process.env.DOCKER_HOST, 'unix:///accept/docker.sock');

function command(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', ...options }).trim();
}

function docker(...args) {
  return command('/accept/bin/docker', ['--host=unix:///accept/docker.sock', ...args]);
}

function smartGit(root) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://manager');
    if (!/^\/site\.git\/(?:info\/refs|git-upload-pack)$/.test(url.pathname)) {
      res.writeHead(404).end();
      return;
    }
    const backend = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: req.headers['content-length'] ?? '',
        HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
        REMOTE_ADDR: req.socket.remoteAddress,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    req.pipe(backend.stdin).on('error', () => undefined);
    const chunks = [];
    backend.stdout.on('data', (chunk) => chunks.push(chunk));
    backend.on('error', () => res.writeHead(500).end());
    backend.on('close', () => {
      if (res.writableEnded) return;
      const result = Buffer.concat(chunks);
      const split = result.indexOf('\r\n\r\n');
      if (split < 0) return res.writeHead(500).end();
      for (const row of result.subarray(0, split).toString().split('\r\n')) {
        const colon = row.indexOf(':');
        const key = row.slice(0, colon);
        const value = row.slice(colon + 1).trim();
        if (key === 'Status') res.statusCode = Number(value.slice(0, 3));
        else if (colon > 0) res.setHeader(key, value);
      }
      res.end(result.subarray(split + 4));
    });
  });
}

async function fixtureRepository() {
  const cwd = '/accept/repo/source';
  await mkdir(cwd, { recursive: true });
  const files = {
    '.env.test': 'P1_MARKER=test\n',
    '.env.prod': 'P1_MARKER=prod\n',
    Dockerfile: `FROM ${image}\nCOPY dist/ /site/\nHEALTHCHECK --interval=1s --timeout=1s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/\nCMD ["httpd","-f","-p","8080","-h","/site"]\n`,
    'compose.yaml': 'services:\n  web:\n    image: ${VEYOPS_IMAGE}\n    network_mode: none\n',
  };
  for (const [name, value] of Object.entries(files)) await writeFile(cwd + '/' + name, value);
  const git = (...args) => command('git', ['-C', cwd, ...args]);
  git('init', '-b', 'main');
  git('add', '.');
  git(
    '-c',
    'user.name=VeyOps acceptance',
    '-c',
    'user.email=p1@example.test',
    'commit',
    '-m',
    'P1 acceptance site',
  );
  git('clone', '--bare', cwd, '/accept/repo/site.git');
  return git('rev-parse', 'HEAD');
}

function graphDefinition({ repositoryId, serviceId, commitSha }) {
  const field = (id, type, props = {}) => ({ id, type, name: id, required: true, ...props });
  const input = (fieldId) => ({ kind: 'INPUT', fieldId });
  const output = (nodeId, fieldId) => ({ kind: 'OUTPUT', nodeId, fieldId });
  const scoped = field('environment', 'ENVIRONMENT');
  const buildTargets = field('buildTargets', 'TARGETS');
  const historic = (kind) => field('artifact', 'ARTIFACT', { multiple: true, artifactType: kind });
  const nodes = [];
  const edges = [];
  const endpoints = [];
  const node = (id, type, props = {}) => (nodes.push({ id, type, name: id, ...props }), id);
  const path = (...ids) => edges.push(...ids.slice(1).map((to, i) => ({ from: ids[i], to })));
  // Shared release nodes accept the bound artifact from this build or a start input.
  const endRelease = node('end-release', 'END', { outputs: [field('release', 'RELEASE')] });
  const release = node('release', 'DEPLOY_ARTIFACT');
  path(release, endRelease);
  const endBuild = node('end-build', 'END', {
    outputs: [
      field('site', 'ARTIFACT', {
        multiple: true,
        artifactType: 'DIRECTORY',
        source: 'CURRENT_RUN',
      }),
      field('image', 'ARTIFACT', {
        multiple: true,
        artifactType: 'DOCKER_IMAGE',
        source: 'CURRENT_RUN',
      }),
    ],
  });
  for (const location of ['manager', 'target']) {
    const git = node('git-' + location, 'CHECKOUT', {
      checkout: { repositoryId, mode: 'COMMIT', commitSha },
    });
    const approve = node('review-' + location, 'APPROVAL');
    const load = node('env-' + location, 'LOAD_ENV');
    const build = node('build-' + location, 'BUILD', {
      build: {
        buildLocation: location.toUpperCase(),
        buildImage: image,
        buildCommand:
          'test -n "$P1_MARKER"; mkdir -p dist; printf \'%s\\n\' "$P1_MARKER" > dist/index.html',
        artifacts: [
          { name: 'site', type: 'DIRECTORY', path: 'dist', required: true },
          { name: 'image', type: 'DOCKER_IMAGE', path: 'Dockerfile', required: true },
        ],
      },
    });
    path(git, load, build, endBuild);
    path(git, approve, load);
    path(build, release);
    const buildInputs = {
      [load]: { workspace: output(git, 'workspace'), environment: input('environment') },
      [build]: {
        workspace: output(git, 'workspace'),
        variables: output(load, 'variables'),
        environment: input('environment'),
        ...(location === 'target' && { targets: input('buildTargets') }),
      },
    };
    const inputs = location === 'target' ? [scoped, buildTargets] : [scoped];
    for (const variant of ['only', 'reviewed']) {
      const entry = node(location + '-' + variant, 'START', { inputs });
      path(entry, git);
      endpoints.push({
        startId: entry,
        endId: endBuild,
        serviceId,
        edgeSelections: { [git]: [variant === 'reviewed' ? approve : load] },
        inputBindings: buildInputs,
        outputBindings: { site: output(build, 'site'), image: output(build, 'image') },
      });
    }
    for (const kind of ['site', 'image']) {
      const entry = node(`${location}-combined-${kind}`, 'START', { inputs });
      path(entry, git);
      endpoints.push({
        startId: entry,
        endId: endRelease,
        serviceId,
        edgeSelections: { [git]: [load] },
        inputBindings: {
          ...buildInputs,
          [release]: { artifact: output(build, kind), environment: input('environment') },
        },
        outputBindings: { release: output(release, 'release') },
      });
    }
  }
  for (const [name, kind] of [
    ['site', 'DIRECTORY'],
    ['image', 'DOCKER_IMAGE'],
  ]) {
    const entry = node('historical-' + name, 'START', { inputs: [scoped, historic(kind)] });
    path(entry, release);
    endpoints.push({
      startId: entry,
      endId: endRelease,
      serviceId,
      inputBindings: {
        [release]: { artifact: input('artifact'), environment: input('environment') },
      },
      outputBindings: { release: output(release, 'release') },
    });
  }
  return { flows: [], canvas: { nodes, edges, endpoints, templates: [] } };
}

async function run() {
  const sha = await fixtureRepository();
  const git = smartGit('/accept/repo');
  git.listen(8088, '0.0.0.0');
  await once(git, 'listening');
  let app;
  try {
    const { createApp } = require('/app/apps/api/dist/bootstrap.js');
    app = await createApp();
    app.useLogger(false);
    await app.listen(3000, '0.0.0.0');
    const api = 'http://127.0.0.1:3000/api/v1';
    let cookie = '';
    async function call(method, path, body, expected) {
      const res = await fetch(api + path, {
        method,
        headers: { 'Content-Type': 'application/json', cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(35000),
      });
      if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
      const json = await res.json();
      if (expected) assert.equal(res.status, expected, JSON.stringify(json));
      else if (!res.ok)
        throw new Error(`${method} ${path} returned ${res.status} ${JSON.stringify(json.error)}`);
      return json.data;
    }
    const post = (path, data) => call('POST', path, data);
    const get = (path) => call('GET', path);
    const put = (path, data) => call('PUT', path, data);
    const password = randomBytes(25).toString('hex');
    await post('/auth/login', { username: 'root', password: process.env.ADMIN_PASSWORD });
    await post('/auth/change-password', {
      currentPassword: process.env.ADMIN_PASSWORD,
      newPassword: password,
    });
    await post('/auth/login', { username: 'root', password });
    const credential = await post('/credentials', {
      name: 'Isolated P1 target',
      type: 'SSH_KEY',
      secret: { privateKey: await readFile('/accept/host-ssh/fixture-admin', 'utf8') },
    });
    const servers = {};
    for (const [scope, host, key] of [['test', 'target', 'fixture-host'], ['prod', 'target-prod', 'fixture-prod']]) {
      const publicKey = (await readFile(`/accept/host-ssh/${key}.pub`, 'utf8')).split(' ')[1];
      const hostKeyFingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64').replace(/=+$/, '');
      const server = await post('/servers', {
        name: `P1 ${scope} SSH namespace`, host, username: 'root', credentialId: credential.id, hostKeyFingerprint,
      });
      const probe = await post('/servers/' + server.id + '/test');
      assert.notEqual(probe.success, false, JSON.stringify(probe));
      servers[scope] = server;
    }
    const project = await post('/projects', {
      name: 'P1 candidate acceptance',
      slug: 'p1-acceptance',
    });
    const base = '/projects/' + project.id;
    await call('PATCH', base + '/execution-settings', {
      targetWorkspaceRoot: '/accept/target/workspace',
    });
    const repository = await post(base + '/repositories', {
      name: 'Acceptance site',
      cloneUrl: 'http://manager:8088/site.git',
    });
    const service = await post(base + '/services', {
      name: 'Acceptance web',
      slug: 'site',
      serviceType: 'WEB',
    });
    const environments = {};
    const configs = {};
    for (const [slug, type] of [
      ['test', 'TESTING'],
      ['prod', 'PRODUCTION'],
    ]) {
      const env = await post(base + '/environments', {
        name: slug,
        slug,
        environmentType: type,
        repositoryEnvFile: '.env.' + slug,
        defaultTargetSelection: { serverIds: [servers[slug].id] },
      });
      environments[slug] = env;
      configs[slug] = {
        artifactType: slug === 'test' ? 'FILE' : 'DOCKER_IMAGE',
        deployMethod: slug === 'test' ? 'FILE' : 'DOCKER_COMPOSE',
        deployPath: '/srv/veyops-acceptance/' + slug,
        composeFilePath: 'compose.yaml',
        healthCheckCommand:
          slug === 'test'
            ? 'node -e "fetch(\'http://127.0.0.1:18080/\').then(r=>process.exit(r.ok?0:1))"'
            : '',
        releasePolicy: {
          requireApproval: slug === 'prod',
          requireCodeReview: true,
          rollbackMode: 'PREVIOUS_HEALTHY',
          ...(slug === 'prod' && {
            healthCheck: { compose: true, attempts: 5, intervalSeconds: 1, timeoutSeconds: 15 },
          }),
        },
      };
      await put(`/services/${service.id}/environments/${env.id}/config`, configs[slug]);
      await put(`${base}/services/${service.id}/environments/${env.id}/source-reviews/${sha}`, {
        repositoryId: repository.id,
        decision: 'APPROVED',
        reason: 'Pinned acceptance fixture reviewed',
      });
    }
    const graph = base + '/execution-graph';
    const previous = await get(graph);
    const definition = graphDefinition({
      repositoryId: repository.id,
      serviceId: service.id,
      commitSha: sha,
    });
    const draft = await put(graph + '/draft', { expectedRevision: previous.revision, definition });
    const version = (await post(graph + '/publish', { expectedRevision: draft.revision }))
      .publishedVersion;
    const recorded = [];
    async function execute(flow, slug, keys = {}, options = {}) {
      const path = `${graph}/flows/${flow}`;
      const choice = {
        version: options.version ?? version,
        inputs: { parameters: {
          environment: environments[slug].id,
          ...(flow.startsWith('target-') && { buildTargets: { serverIds: [servers[slug].id] } }),
          ...keys,
        } },
      };
      const plan = await post(path + '/preview', choice);
      const envFile = plan.executionPlan?.environmentFiles?.find(
        (file) => file.path === '.env.' + slug,
      );
      if (!flow.startsWith('historical')) {
        assert.ok(envFile, JSON.stringify(plan.executionPlan?.environmentFiles));
        assert.equal(envFile.commitSha, sha);
      }
      if (flow === 'manager-only') {
        assert.ok(plan.executionPlan.targets.every((target) => !target.servers.length));
      }
      const queued = await post(path + '/run', {
        ...choice,
        idempotencyKey: randomUUID(),
        expectedConfigurationHash: plan.configurationHash,
        expectedPlanSections: plan.planSections,
      });
      const decisions = new Set();
      let detail;
      for (let i = 0; i < 140; i++) {
        detail = await get(graph + '/runs/' + queued.id);
        if (!['QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED'].includes(detail.status)) break;
        for (const step of detail.nodes) {
          if (
            step.type === 'APPROVAL' &&
            step.status === 'WAITING' &&
            !decisions.has(step.nodeId)
          ) {
            await post(graph + '/runs/' + queued.id + '/nodes/' + step.nodeId + '/decision', {
              decision: 'APPROVE',
            });
            decisions.add(step.nodeId);
          }
          if (
            step.type === 'DEPLOY_ARTIFACT' &&
            step.taskId &&
            slug === 'prod' &&
            !decisions.has(step.taskId)
          ) {
            const approvals = await get('/deployments/approvals?projectId=' + project.id);
            if (approvals.some((item) => item.id === step.taskId)) {
              await post('/deployments/approvals/' + step.taskId + '/approve', { confirmed: true });
              decisions.add(step.taskId);
            }
          }
        }
        await sleep(650);
      }
      if (detail.status !== (options.expected ?? 'SUCCESS')) {
        const tasks = detail.nodes.filter((step) => step.taskId);
        const logs = [];
        for (const step of tasks)
          logs.push([
            step.nodeId,
            (await get('/tasks/' + step.taskId + '/logs')).content.slice(-2600),
          ]);
        throw new Error(
          `${flow}/${slug}: ${detail.status} ${JSON.stringify(detail.nodes.map(({ nodeId, status }) => [nodeId, status]))} ${JSON.stringify(logs)}`,
        );
      }
      const artifactIds = detail.artifactIds ?? [];
      const artifacts = (await get('/artifacts?projectId=' + project.id)).filter((item) =>
        artifactIds.includes(item.id),
      );
      if (!flow.startsWith('historical') && !options.expected) {
        assert.deepEqual(artifacts.map(({ name }) => name).sort(), ['image', 'site']);
        assert.match(artifacts.find(({ name }) => name === 'image').imageId, /^sha256:[a-f0-9]{64}$/);
      }
      for (const artifact of artifacts) {
        assert.equal(artifact.sourceCommit, sha);
        assert.ok(
          artifact.sources?.some(
            (source) => source.repositoryId === repository.id && source.commitSha === sha,
          ),
        );
        if (artifact.checksum && artifact.downloadAvailable) {
          const downloaded = await fetch(api + '/artifacts/' + artifact.id + '/download', {
            headers: { cookie },
          });
          assert.equal(downloaded.status, 200);
          assert.equal(
            createHash('sha256')
              .update(Buffer.from(await downloaded.arrayBuffer()))
              .digest('hex'),
            artifact.checksum,
          );
        }
      }
      const releases = (await get('/deployments?projectId=' + project.id)).filter(
        (item) => item.graphRunId === detail.id,
      );
      let runningImageId;
      if ((flow.includes('combined') && !options.expected) || flow.startsWith('historical')) {
        const forward = releases.filter((item) => !item.rollbackOfDeploymentId);
        assert.equal(forward.length, 1);
        assert.equal(forward[0].serverId, servers[slug].id);
        if (keys.artifact) assert.equal(forward[0].artifactId, keys.artifact[0]);
        else assert.ok(artifacts.some(({ id }) => id === forward[0].artifactId));
        if (options.expected === undefined) {
          if (slug === 'prod') {
            const names = docker(
              'ps',
              '--filter',
              'label=com.docker.compose.service=web',
              '--format',
              '{{.ID}}',
            ).split('\n');
            assert.equal(names.length, 1);
            runningImageId = docker('inspect', '--format', '{{.Image}}', names[0]);
            assert.equal(runningImageId, artifacts.find((item) => item.id === forward[0].artifactId)?.imageId);
            assert.equal(
              docker('exec', names[0], 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/'),
              slug,
            );
          } else {
            assert.equal(
              (await readFile('/accept/target/test/current/index.html', 'utf8')).trim(),
              slug,
            );
            assert.equal((await (await fetch('http://target:18080/')).text()).trim(), slug);
          }
        }
      }
      const row = {
        flow,
        environment: slug,
        runId: detail.id,
        graphVersion: choice.version,
        sha,
        configurationHash: plan.configurationHash,
        environmentFile: envFile?.path,
        status: detail.status,
        runningImageId,
        approvalIds: [...decisions],
        artifacts: artifacts.map(({ id, name, checksum, imageDigest, imageId, archiveImageId }) => ({
          id,
          name,
          checksum,
          imageDigest,
          imageId,
          archiveImageId,
        })),
        releases: releases.map(
          ({ id, artifactId, serverId, status, healthStatus, rollbackStatus, rollbackOfDeploymentId }) => ({
            id,
            artifactId,
            serverId,
            status,
            healthStatus,
            rollbackStatus,
            rollbackOfDeploymentId,
          }),
        ),
      };
      recorded.push(row);
      console.log(JSON.stringify(row));
      return { detail, artifacts, releases };
    }
    await execute('manager-only', 'test');
    await execute('manager-only', 'prod');
    await execute('target-reviewed', 'test');
    await execute('target-reviewed', 'prod');
    for (const [location, slug, kind] of [
      ['manager', 'test', 'site'],
      ['target', 'test', 'site'],
      ['manager', 'prod', 'image'],
      ['target', 'prod', 'image'],
    ]) {
      await execute(`${location}-combined-${kind}`, slug);
    }
    const select = (scope, name) =>
      get(
        `/artifacts?projectId=${project.id}&serviceId=${service.id}&environmentId=${environments[scope].id}&repositoryId=${repository.id}&commit=${sha}`,
      ).then((items) => items.filter((item) => item.name === name).at(-1)?.id);
    const fileRelease = await execute('historical-site', 'test', { artifact: [await select('test', 'site')] });
    await execute('historical-image', 'prod', { artifact: [await select('prod', 'image')] });
    const active = await readlink('/accept/target/test/current');
    const failDefinition = structuredClone(definition);
    failDefinition.canvas.nodes.find((entry) => entry.id === 'build-manager').build.buildCommand =
      'exit 23';
    const failedDraft = await put(graph + '/draft', {
      expectedRevision: draft.revision,
      definition: failDefinition,
    });
    const failedVersion = (
      await post(graph + '/publish', { expectedRevision: failedDraft.revision })
    ).publishedVersion;
    const stopped = await execute(
      'manager-combined-site',
      'test',
      {},
      { version: failedVersion, expected: 'FAILED' },
    );
    assert.equal(stopped.detail.nodes.find((node) => node.nodeId === 'release').status, 'SKIPPED');
    assert.equal(await readlink('/accept/target/test/current'), active);
    const testConfig = `/services/${service.id}/environments/${environments.test.id}/config`;
    await put(testConfig, { ...configs.test, healthCheckCommand: 'exit 31' });
    const failure = await execute(
      'historical-site',
      'test',
      { artifact: [await select('test', 'site')] },
      { expected: 'FAILED' },
    );
    const failedRelease = failure.releases.find((item) => !item.rollbackOfDeploymentId);
    const restored = failure.releases.find((item) => item.rollbackOfDeploymentId === failedRelease.id);
    assert.equal(failedRelease.rollbackStatus, 'SUCCESS');
    assert.equal(restored.artifactId, fileRelease.releases[0].artifactId);
    assert.equal(restored.healthStatus, 'HEALTHY');
    assert.equal((await (await fetch('http://target:18080/')).text()).trim(), 'test');
    await put(testConfig, configs.test);
    const olderRelease = recorded.find(({ flow }) => flow === 'manager-combined-site').releases[0];
    const rollbackPath = '/deployments/' + olderRelease.id + '/rollback';
    const rollbackPlan = await post(rollbackPath + '/preview', {});
    const manual = await post(rollbackPath, { confirmationHash: rollbackPlan.confirmationHash });
    let task;
    for (let i = 0; i < 100; i++) {
      task = await get('/tasks/' + manual.id);
      if (!['PENDING', 'RUNNING'].includes(task.status)) break;
      await sleep(500);
    }
    assert.equal(task.status, 'SUCCESS', JSON.stringify(task));
    const [manualRelease] = await get('/deployments?projectId=' + project.id + '&taskId=' + manual.id);
    assert.equal(manualRelease.isCurrent, true);
    assert.equal(manualRelease.artifactId, olderRelease.artifactId);
    assert.equal(manualRelease.rollbackOfDeploymentId, olderRelease.id);
    assert.equal((await (await fetch('http://target:18080/')).text()).trim(), 'test');

    const backup = await post('/backups', {});
    const backupPath = '/backups/' + backup.id;
    assert.equal((await post(backupPath + '/verify', {})).id, backup.id);
    const bundle = await fetch(api + backupPath + '/download', { headers: { cookie } });
    assert.equal(bundle.status, 200);
    await writeFile('/accept/backup.tar.gz', Buffer.from(await bundle.arrayBuffer()));
    await mkdir('/accept/backup-extracted');
    command('tar', ['-xzf', '/accept/backup.tar.gz', '-C', '/accept/backup-extracted']);
    const { restoreBackup } = require('/app/apps/api/dist/core/database/backup.js');
    const restoredDb = '/accept/restored/database/app.db';
    await restoreBackup({
      dataDir: '/accept/restored',
      database: { client: 'sqlite', path: restoredDb },
      key: Buffer.from(process.env.ENCRYPTION_KEY, 'hex'),
    }, '/accept/backup-extracted');
    const db = require('/app/node_modules/better-sqlite3')(restoredDb, { readonly: true });
    try {
      assert.equal(db.prepare('select commit_sha from artifact_sources where artifact_id = ?').pluck().get(olderRelease.artifactId), sha);
      assert.equal(db.prepare('select status from deployment_records where id = ?').pluck().get(manualRelease.id), 'SUCCESS');
    } finally {
      db.close();
    }
    console.log(
      'VEYOPS_P1_DELIVERY_OK ' + JSON.stringify({
        revision, projectId: project.id, recorded,
        manualRollback: { taskId: manual.id, deploymentId: manualRelease.id, restoredArtifactId: manualRelease.artifactId },
        backup: backup.id,
      }),
    );
  } finally {
    if (app) await app.close();
    await new Promise((done) => git.close(done));
  }
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
