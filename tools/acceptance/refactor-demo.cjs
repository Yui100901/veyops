const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join, resolve } = require('node:path');
const { load } = require('js-yaml');

const demoPath = resolve(__dirname, '../../examples/refactor-stage0/project.yaml');
const namePattern = /^[a-z][a-z0-9-]{0,54}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const maxGitRequest = 128 * 1024;
const maxGitResponse = 16 * 1024 * 1024;
const fingerprintPattern = /^(?:SHA256:[A-Za-z0-9+/]{43}=?|[a-fA-F0-9]{64})$/;

const sshHost = (host) =>
  host.includes(':') ? new URL(`http://[${host}]/`).hostname.slice(1, -1) : host.toLowerCase();
function hostDigest(fingerprint) {
  assert.match(fingerprint, fingerprintPattern, 'SSH 指纹格式无效');
  return fingerprint.startsWith('SHA256:')
    ? Buffer.from(fingerprint.slice(7), 'base64').toString('hex')
    : fingerprint.toLowerCase();
}

function loadDemo(file = demoPath) {
  const demo = load(readFileSync(file, 'utf8'));
  assert.equal(demo?.format, 'veyops-refactor-demo-v1', '演示定义版本无效');
  assert.equal(demo.graph?.projectId, demo.project?.id, '演示图的项目别名不匹配');
  assert.equal(demo.repositories?.length, 1, '此演示要求一个可复现的 Git 仓库');
  assert.ok(demo.services?.length && demo.environmentSets?.length && demo.graph.flows?.length);
  for (const rows of [
    demo.services,
    demo.environmentSets,
    demo.credentialPlaceholders,
    demo.platformResources.servers,
    demo.platformResources.groups,
    demo.repositories,
    demo.graph.nodes,
    demo.graph.flows,
  ]) {
    assert.ok(
      rows.every(({ id }) => namePattern.test(id)),
      '演示别名无效',
    );
    assert.equal(new Set(rows.map(({ id }) => id)).size, rows.length, '存在重复的演示别名');
  }
  return demo;
}

function objectHash(type, bytes) {
  return createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
}

function gitSnapshot(snapshot, parent, write) {
  const root = new Map();
  for (const [path, content] of Object.entries(snapshot.files)) {
    const parts = path.split('/');
    assert.ok(
      parts.every(
        (part) =>
          /^[a-zA-Z0-9_.-]+$/.test(part) && !['.', '..', '.git'].includes(part.toLowerCase()),
      ),
      'Git 样本文件路径无效',
    );
    assert.equal(typeof content, 'string', 'Git 样本只支持 UTF-8 文本');
    const name = parts.pop();
    let directory = root;
    for (const part of parts) {
      if (!directory.has(part)) directory.set(part, new Map());
      directory = directory.get(part);
      assert.ok(directory instanceof Map, 'Git 样本文件与目录重名');
    }
    assert.ok(!directory.has(name), 'Git 样本文件与目录重名');
    directory.set(name, Buffer.from(content.replace(/\r\n/g, '\n')));
  }
  const add = (type, bytes) => {
    const oid = objectHash(type, bytes);
    if (write) assert.equal(write(type, bytes), oid, 'Git 对象摘要与样本定义不匹配');
    return oid;
  };
  const tree = (directory) => {
    const entries = [...directory].map(([name, value]) => ({
      name,
      value,
      isTree: value instanceof Map,
    }));
    entries.sort((a, b) =>
      Buffer.compare(
        Buffer.from(a.name + (a.isTree ? '/' : '')),
        Buffer.from(b.name + (b.isTree ? '/' : '')),
      ),
    );
    return add(
      'tree',
      Buffer.concat(
        entries.flatMap(({ name, value, isTree }) => [
          Buffer.from(`${isTree ? '40000' : '100644'} ${name}\0`),
          Buffer.from(isTree ? tree(value) : add('blob', value), 'hex'),
        ]),
      ),
    );
  };
  for (const identity of [snapshot.author, snapshot.committer])
    assert.match(identity, /^[^<>\r\n]+ <[^<>\r\n]+>$/, 'Git 样本身份无效');
  assert.match(snapshot.timestamp, /^\d+ [+-]\d{4}$/, 'Git 样本时间无效');
  assert.ok(
    typeof snapshot.message === 'string' && !snapshot.message.includes('\0'),
    'Git 样本提交说明无效',
  );
  return add(
    'commit',
    Buffer.from(
      [
        `tree ${tree(root)}`,
        ...(parent ? [`parent ${parent}`] : []),
        `author ${snapshot.author} ${snapshot.timestamp}`,
        `committer ${snapshot.committer} ${snapshot.timestamp}`,
        '',
        snapshot.message.replace(/\r\n/g, '\n').trimEnd(),
        '',
      ].join('\n'),
    ),
  );
}

function demoCommits(demo, write) {
  const { sourceSnapshot, nextSnapshot } = demo.repositories[0];
  assert.ok(sourceSnapshot?.files && nextSnapshot?.files, '演示仓库需要基线和候选两个源码快照');
  assert.match(sourceSnapshot.commitSha, shaPattern);
  const commitSha = gitSnapshot(sourceSnapshot, undefined, write);
  assert.equal(commitSha, sourceSnapshot.commitSha, '演示文件无法重现声明的固定 Git 提交');
  const nextCommitSha = gitSnapshot(
    {
      ...sourceSnapshot,
      ...nextSnapshot,
      files: { ...sourceSnapshot.files, ...nextSnapshot.files },
    },
    commitSha,
    write,
  );
  return { commitSha, nextCommitSha };
}

function prepareDemoRepository(demo, gitRoot) {
  const expected = demoCommits(demo);
  const branch = demo.repositories[0].sourceSnapshot.defaultBranch;
  assert.match(branch, namePattern, 'Git 默认分支无效');
  assert.notEqual(branch, 'acceptance-next');
  const repositoryPath = resolve(gitRoot, 'storefront.git');
  const git = (args, input) =>
    execFileSync('git', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  if (existsSync(repositoryPath)) {
    assert.equal(git(['-C', repositoryPath, 'rev-parse', '--is-bare-repository']), 'true');
    assert.equal(
      git(['-C', repositoryPath, 'rev-parse', 'HEAD']),
      expected.commitSha,
      '已有 Git 仓库不属于此演示',
    );
    assert.equal(
      git(['-C', repositoryPath, 'rev-parse', 'refs/heads/acceptance-next']),
      expected.nextCommitSha,
    );
    return { ...expected, repositoryPath };
  }
  mkdirSync(gitRoot, { recursive: true });
  git(['init', '--bare', '--object-format=sha1', `--initial-branch=${branch}`, repositoryPath]);
  demoCommits(demo, (type, input) =>
    git(['-C', repositoryPath, 'hash-object', '-w', '-t', type, '--stdin'], input),
  );
  git([
    '-C',
    repositoryPath,
    'update-ref',
    `refs/heads/${branch}`,
    expected.commitSha,
    '0000000000000000000000000000000000000000',
  ]);
  git([
    '-C',
    repositoryPath,
    'update-ref',
    'refs/heads/acceptance-next',
    expected.nextCommitSha,
    '0000000000000000000000000000000000000000',
  ]);
  return { ...expected, repositoryPath };
}

function serveDemoGit(gitRoot) {
  return createServer((req, res) => {
    if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//'))
      return res.writeHead(404).end();
    const url = new URL(req.url, 'http://localhost');
    const allowed = /^\/(?:storefront|dependency)\.git\/(info\/refs|git-upload-pack)$/.exec(
      url.pathname,
    );
    const discovery =
      req.method === 'GET' &&
      allowed?.[1] === 'info/refs' &&
      url.search === '?service=git-upload-pack';
    const fetch = req.method === 'POST' && allowed?.[1] === 'git-upload-pack' && !url.search;
    if (!discovery && !fetch) return res.writeHead(404).end();
    const backend = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: resolve(gitRoot),
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
      timeout: 30000,
    });
    let requestSize = 0;
    let responseSize = 0;
    const chunks = [];
    const fail = (status) => {
      backend.kill();
      if (!res.writableEnded) res.writeHead(status).end();
    };
    res.on('close', () => backend.kill());
    req.on('data', (chunk) => {
      requestSize += chunk.length;
      if (requestSize > maxGitRequest) fail(413);
    });
    req.on('error', () => fail(400));
    req.pipe(backend.stdin).on('error', () => undefined);
    backend.stdout.on('data', (chunk) => {
      responseSize += chunk.length;
      if (responseSize > maxGitResponse) fail(502);
      else chunks.push(chunk);
    });
    backend.on('error', () => fail(502));
    backend.on('close', (status) => {
      if (res.writableEnded) return;
      const payload = Buffer.concat(chunks);
      const headerEnd = payload.indexOf('\r\n\r\n');
      if (status !== 0 || headerEnd < 0) return res.writeHead(502).end();
      for (const line of payload.subarray(0, headerEnd).toString().split('\r\n')) {
        const split = line.indexOf(':');
        if (split <= 0) continue;
        const key = line.slice(0, split);
        const value = line.slice(split + 1).trim();
        if (key.toLowerCase() === 'status' && /^\d{3}\b/.test(value))
          res.statusCode = Number(value.slice(0, 3));
        else res.setHeader(key, value);
      }
      res.end(payload.subarray(headerEnd + 4));
    });
  });
}

function stable(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );
}

const byKey = (rows) => [...rows].sort((a, b) => a.key.localeCompare(b.key));
const ids = (rows) => Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, row.id]));

function mapped(values, alias, type) {
  assert.ok(Object.hasOwn(values, alias), `演示定义引用了未知${type} ${alias}`);
  return values[alias];
}

const modules = {
  'git.checkout': 'CHECKOUT',
  'delivery.build': 'BUILD',
  'environment.load': 'LOAD_ENV',
  'shell.run': 'SHELL',
  'artifact.register': 'REGISTER_ARTIFACT',
  'delivery.source-review': 'SOURCE_REVIEW',
  'deploy.artifact': 'DEPLOY_ARTIFACT',
  'deploy.rollback': 'ROLLBACK_ARTIFACT',
  'deploy.health': 'HEALTH_CHECK',
  'control.condition': 'CONDITION',
};

function compileDemoGraph(demo, references, options) {
  const { repositoryIds, serviceIds, environmentSetIds, groupIds, serverIds } = references;
  const configBinding = (bind, port) =>
    bind.kind === 'VALUE' && port === 'repository'
      ? { ...bind, value: mapped(repositoryIds, bind.value, '仓库') }
      : structuredClone(bind);
  const param = ({ id, type, defaultValue, options: choices, ...attributes }) => {
    const convert = (value) => {
      if (type === 'SERVICE') return { serviceId: mapped(serviceIds, value.serviceId, '服务') };
      if (type === 'ENVIRONMENT_SET') return mapped(environmentSetIds, value, '变量集合');
      if (type === 'TARGETS')
        return {
          ...value,
          ...(value.groupIds && {
            groupIds: value.groupIds.map((group) => mapped(groupIds, group, '分组')),
          }),
          ...(value.serverIds && {
            serverIds: value.serverIds.map((server) => mapped(serverIds, server, '服务器')),
          }),
        };
      return value;
    };
    return {
      id,
      name: id,
      type,
      ...attributes,
      ...(defaultValue !== undefined && { defaultValue: convert(defaultValue) }),
      ...(choices && { options: choices.map(convert) }),
    };
  };

  const nodes = demo.graph.nodes.map((entry, index) => {
    const { id, module: moduleId, moduleVersion, configuration: config = {}, outputs } = entry;
    const type = moduleId ? mapped(modules, moduleId, '模块') : entry.type;
    const node = {
      id,
      name: id,
      referenceName: id,
      type,
      position: { x: 290 + (index % 4) * 235, y: 65 + Math.floor(index / 4) * 150 },
    };
    if (moduleId) Object.assign(node, { moduleId, moduleVersion });
    switch (type) {
      case 'CHECKOUT':
        return node;
      case 'LOAD_ENV':
        return { ...node, loadEnvironment: config };
      case 'SHELL':
        return {
          ...node,
          shell: {
            ...config,
            params: (config.params ?? []).map(param),
            ...(outputs?.length && {
              artifacts: outputs.map(({ id, ...declaration }) => ({ ...declaration, id, name: id })),
            }),
          },
        };
      case 'REGISTER_ARTIFACT':
        return {
          ...node,
          registerArtifacts: {
            artifacts: outputs.map(({ id: name, ...declaration }) => ({ ...declaration, name })),
          },
        };
      case 'BUILD': {
        assert.ok(
          ['copy-static-site', 'docker-image', 'copy-static-and-image'].includes(config.preset),
          '未知演示构建动作',
        );
        const image = config.preset !== 'copy-static-site';
        const files = config.preset !== 'docker-image';
        const report = outputs.some(({ id: name }) => name === 'runReport');
        return {
          ...node,
          build: {
            buildLocation: config.location,
            artifactType: files ? 'FILE' : 'DOCKER_IMAGE',
            ...(config.location === 'MANAGER' && { buildImage: options.buildImage }),
            ...(image && {
              dockerfilePath: config.dockerfilePath,
              imageRepository: 'veyops-demo-storefront',
            }),
            ...(files && {
              outputPath: 'dist',
              buildCommand: [
                'mkdir -p dist && cp index.html dist/index.html || exit 2',
                ...(report
                  ? [
                      'test -n "$GIT_SHA" && test "$GIT_SHA" = "$VEYOPS_GIT_COMMIT_SHA" || exit 2',
                      'test "$FILE_PROFILE" = "$ENV" || exit 2',
                      'case "$ENV:$LOG_LEVEL" in test:debug|production:warn) ;; *) exit 2 ;; esac',
                      'mkdir -p reports',
                      `printf '{"commitSha":"%s","fileProfile":"%s"}\\n' "$GIT_SHA" "$FILE_PROFILE" > reports/summary.json`,
                    ]
                  : []),
              ].join('\n'),
            }),
            artifacts: outputs.map(({ id: name, ...declaration }) => ({ ...declaration, name })),
          },
        };
      }
      case 'APPROVAL':
      case 'SOURCE_REVIEW':
        return { ...node, approval: config };
      case 'DEPLOY_ARTIFACT':
      case 'ROLLBACK_ARTIFACT':
        return {
          ...node,
          deploy: {
            ...config,
            ...(config.composeSource?.kind === 'REPOSITORY_FILE' && {
              composeSource: {
                ...config.composeSource,
                repositoryId: mapped(repositoryIds, config.composeSource.repositoryId, '仓库'),
              },
            }),
          },
        };
      case 'HEALTH_CHECK':
        return { ...node, healthCheck: config };
      case 'CONDITION':
        return { ...node, condition: config };
      default:
        throw new Error(`不支持的演示功能节点 ${type}`);
    }
  });
  const byId = Object.fromEntries(demo.graph.nodes.map((node) => [node.id, node]));
  const edges = new Map();
  const endpoints = [];
  for (const [index, flow] of demo.graph.flows.entries()) {
    assert.equal(flow.start.id, flow.id, '演示开始节点与流 ID 必须一致');
    const path = [flow.id, ...flow.path, flow.end.id];
    const branch = flow.onUnhealthy && [flow.path.at(-1), ...flow.onUnhealthy, flow.end.id];
    const typedSet = flow.start.environmentSet;
    const environmentSet =
      typedSet?.mode === 'FIXED'
        ? {
            ...typedSet,
            environmentSetId: mapped(environmentSetIds, typedSet.environmentSetId, '变量集合'),
          }
        : typedSet;
    const parameters = (flow.start.parameters ?? []).map(param);
    const outputs = flow.end.outputs.map(({ source, ...descriptor }) =>
      param({
        ...descriptor,
        required: true,
        type: descriptor.type === 'SERVICE_RESULT' ? 'RELEASE' : descriptor.type,
      }),
    );
    nodes.push(
      {
        id: flow.id,
        name: flow.name,
        referenceName: flow.id,
        type: 'START',
        inputs: parameters,
        environmentSet,
        position: { x: 30, y: 50 + index * 108 },
      },
      {
        id: flow.end.id,
        name: flow.name + '完成',
        referenceName: flow.end.id,
        type: 'END',
        outputs,
        position: { x: 1270, y: 50 + index * 108 },
      },
    );
    const edgeSelections = {};
    function append(segments, when) {
      for (const [i, from] of segments.slice(0, -1).entries()) {
        const to = segments[i + 1];
        const condition = i === 0 ? when : undefined;
        edges.set(`${from}/${to}/${condition ?? ''}`, {
          from,
          to,
          ...(condition && { when: condition }),
        });
        if (!condition) edgeSelections[from] = [to];
      }
    }
    if (branch) {
      append(path.slice(0, -1));
      append(path.slice(-2), 'TRUE');
      append(branch, 'FALSE');
    } else append(path);
    const active = [...new Set([...flow.path, ...(flow.onUnhealthy ?? [])])];
    for (const id of active) mapped(byId, id, '节点');
    endpoints.push({
      startId: flow.id,
      endId: flow.end.id,
      serviceId: parameters.find(({ type }) => type === 'SERVICE')?.defaultValue?.serviceId,
      edgeSelections,
      inputBindings: Object.fromEntries(
        Object.entries(flow.bindings ?? {}).map(([nodeId, entries]) => [
          nodeId,
          Object.fromEntries(
            Object.entries(entries).map(([port, bind]) => [port, configBinding(bind, port)]),
          ),
        ]),
      ),
      environmentBindings: Object.fromEntries(
        active.flatMap((id) => (byId[id].environment ? [[id, byId[id].environment]] : [])),
      ),
      outputBindings: Object.fromEntries(flow.end.outputs.map(({ id, source }) => [id, source])),
    });
  }
  assert.equal(new Set(nodes.map(({ id }) => id)).size, nodes.length, '演示图节点标识必须唯一');
  return { flows: [], canvas: { nodes, endpoints, edges: [...edges.values()], templates: [] } };
}

function demoInputs(demo, options) {
  const slug = options.projectSlug ?? demo.project.id;
  assert.match(slug, namePattern, '演示项目标识无效');
  const repository = new URL(options.repositoryBaseUrl);
  assert.ok(
    ['http:', 'https:'].includes(repository.protocol) &&
      repository.pathname === '/' &&
      !repository.username &&
      !repository.password &&
      !repository.hash &&
      !repository.search,
    '演示仓库服务地址需要 HTTP(S) 主机及可选端口',
  );
  const cloneUrl = new URL('storefront.git', repository).href;
  const targets = options.targets ?? {};
  const expectedTargets = demo.platformResources.servers.map(({ id }) => id).sort();
  assert.deepEqual(
    Object.keys(targets).sort(),
    expectedTargets,
    '必须为演示定义中的每台 SSH 主机明确提供连接配置',
  );
  const identities = [];
  for (const id of expectedTargets) {
    const target = targets[id];
    assert.match(target.host ?? '', /^[a-zA-Z0-9:._-]{1,253}$/, `目标 ${id} 的主机无效`);
    assert.match(target.username ?? '', /^[a-zA-Z0-9_.-]{1,64}$/, `目标 ${id} 的用户名无效`);
    assert.ok(
      Number.isInteger(target.port ?? 22) && (target.port ?? 22) > 0 && (target.port ?? 22) < 65536,
      `目标 ${id} 的端口无效`,
    );
    assert.match(
      target.hostKeyFingerprint ?? '',
      fingerprintPattern,
      `目标 ${id} 需要已核对的 SSH 指纹`,
    );
    assert.equal(
      Number(typeof target.password === 'string' && target.password.length > 0) +
        Number(typeof target.privateKey === 'string' && target.privateKey.length > 0),
      1,
      `目标 ${id} 需要密码或私钥其中一种`,
    );
    identities.push(`${sshHost(target.host)}:${target.port ?? 22}`);
  }
  assert.equal(new Set(identities).size, identities.length, '演示目标不能复用同一 SSH 端点');
  const buildImage = options.buildImage ?? 'busybox:1.36';
  assert.match(buildImage, /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/, '管理端演示构建镜像无效');
  const workspaceRoot = options.workspaceRoot;
  if (workspaceRoot !== undefined)
    assert.match(workspaceRoot, /^\/accept\/[a-zA-Z0-9_/-]+$/, '演示工作区须位于 /accept');
  const addresses = options.addresses ?? {};
  const aliases = new Set(demo.services.flatMap(({ addresses }) => addresses.map(({ id }) => id)));
  assert.ok(
    Object.keys(addresses).every((alias) => aliases.has(alias)),
    '存在未知的服务访问地址别名',
  );
  for (const service of demo.services)
    for (const address of service.addresses) {
      const url = new URL(addresses[address.id] ?? address.url);
      assert.ok(
        ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password,
        `服务访问地址 ${address.id} 无效`,
      );
    }
  return { slug, cloneUrl, targets, buildImage, workspaceRoot, addresses };
}

async function initializeDemo(demo, options) {
  const { call } = options;
  assert.equal(typeof call, 'function', '初始化需要已认证的 API 客户端');
  const { slug, cloneUrl, targets, buildImage, workspaceRoot, addresses } = demoInputs(
    demo,
    options,
  );
  const commits = demoCommits(demo);
  const buildOptions = { buildImage };
  const syntheticReferences = {
    repositoryIds: Object.fromEntries(demo.repositories.map(({ id }) => [id, id])),
    serviceIds: Object.fromEntries(demo.services.map(({ id }) => [id, id])),
    environmentSetIds: Object.fromEntries(demo.environmentSets.map(({ id }) => [id, id])),
    groupIds: Object.fromEntries(demo.platformResources.groups.map(({ id }) => [id, id])),
    serverIds: Object.fromEntries(demo.platformResources.servers.map(({ id }) => [id, id])),
  };
  compileDemoGraph(demo, syntheticReferences, buildOptions);
  for (const service of demo.services)
    mapped(syntheticReferences.repositoryIds, service.repositoryId, '仓库');
  for (const group of demo.platformResources.groups)
    for (const id of group.serverIds) mapped(syntheticReferences.serverIds, id, '服务器');
  const credentialAliases = new Set(demo.credentialPlaceholders.map(({ id }) => id));
  for (const { variables } of demo.environmentSets)
    for (const { credentialId } of variables)
      assert.ok(
        credentialId === undefined || credentialAliases.has(credentialId),
        '变量集合引用了未声明的演示凭据',
      );
  const fixtureDigest = createHash('sha256').update(stable(demo)).digest('hex');
  const marker = `veyops-refactor-demo-v1 ${slug} ${fixtureDigest}`;
  const resourceName = (alias) => `veyops-demo ${slug} ${alias}`;
  const credentialScope = createHash('sha256').update(marker).digest('hex').slice(0, 16);
  const credentialPrefix = (alias) =>
    `veyops-demo ${credentialScope} ${slug.slice(0, 24)} ${alias}-`;
  const get = (path) => call('GET', path);
  const post = (path, body) => call('POST', path, body);
  const put = (path, body) => call('PUT', path, body);
  function find(list, predicate, label) {
    const found = list.filter(predicate);
    assert.ok(found.length <= 1, `${label} 存在多条匹配记录，请先核对演示实例`);
    return found[0];
  }
  const [projects, currentServers, currentGroups, currentCredentials] = await Promise.all([
    get('/projects'),
    get('/servers'),
    get('/server-groups'),
    get('/credentials'),
  ]);
  let project = find(projects, (row) => row.slug === slug, '演示项目');
  if (project) assert.equal(project.description, marker, '同标识项目不属于此演示版本');
  const servers = {};
  for (const { id } of demo.platformResources.servers) {
    const previous = find(
      currentServers,
      ({ name }) => name === resourceName(id),
      `演示主机 ${id}`,
    );
    const target = targets[id];
    const host = sshHost(target.host);
    const port = target.port ?? 22;
    assert.ok(
      !currentServers.some(
        (server) =>
          server.id !== previous?.id && sshHost(server.host) === host && server.port === port,
      ),
      `目标 ${id} 的 SSH 地址已被其他平台主机使用`,
    );
    if (!previous) continue;
    assert.equal(previous.description, marker, `同名主机 ${id} 不属于此演示版本`);
    assert.equal(sshHost(previous.host), host, `演示主机 ${id} 地址已变更`);
    assert.equal(previous.port, port, `演示主机 ${id} 端口已变更`);
    assert.equal(previous.username, target.username, `演示主机 ${id} 授权用户已变更`);
    assert.equal(
      hostDigest(previous.hostKeyFingerprint),
      hostDigest(target.hostKeyFingerprint),
      `演示主机 ${id} 指纹已变更`,
    );
    const credential = currentCredentials.find(
      ({ id: candidate }) => candidate === previous.credentialId,
    );
    assert.ok(
      credential?.name.startsWith(credentialPrefix(`ssh-${id}`)),
      `演示主机 ${id} 凭据已变更`,
    );
    assert.equal(credential?.type, target.privateKey ? 'SSH_KEY' : 'SSH_PASSWORD');
    assert.equal(credential?.status, 'ACTIVE');
    servers[id] = previous;
  }
  const groups = {};
  for (const { id, serverIds } of demo.platformResources.groups) {
    const previous = find(currentGroups, ({ name }) => name === resourceName(id), `演示分组 ${id}`);
    if (!previous) continue;
    assert.equal(previous.description, marker, `同名分组 ${id} 不属于此演示版本`);
    assert.deepEqual(
      previous.serverIds,
      serverIds.map((alias) => servers[alias]?.id),
      `演示分组 ${id} 成员已变更`,
    );
    groups[id] = previous;
  }
  if (!project)
    project = await post('/projects', {
      slug,
      name: demo.project.name,
      description: marker,
      tags: ['veyops-demo'],
    });
  const base = '/projects/' + project.id;
  const graph = base + '/execution-graph';
  const detail = await get(base);
  const before = await get(graph);
  if (workspaceRoot !== undefined) {
    const settings = await get(base + '/execution-settings');
    if (
      settings.overrides.targetWorkspaceRoot === undefined ||
      settings.overrides.targetWorkspaceRoot === null
    )
      await call('PATCH', base + '/execution-settings', { targetWorkspaceRoot: workspaceRoot });
    else
      assert.equal(settings.overrides.targetWorkspaceRoot, workspaceRoot, '演示项目工作区已变更');
  }
  const globals = await get(base + '/variables');
  const projectVariables = Object.entries(demo.project.variables ?? {}).map(([key, value]) => ({
    key,
    value,
  }));
  if (projectVariables.length && !globals.variables.length)
    await put(base + '/variables', {
      expectedRevision: globals.revision,
      variables: projectVariables,
    });
  else
    assert.deepEqual(
      byKey(globals.variables.map(({ key, value }) => ({ key, value }))),
      byKey(projectVariables),
      '演示项目公共变量已变更',
    );

  const credentials = {};
  function createCredential(alias, type, secret) {
    return post('/credentials', {
      name: credentialPrefix(alias) + randomBytes(5).toString('hex'),
      type,
      secret,
      metadata: { description: marker },
    });
  }
  for (const { id } of demo.platformResources.servers) {
    if (servers[id]) continue;
    const target = targets[id];
    const endpoint = { host: sshHost(target.host), port: target.port ?? 22 };
    const probe = await post('/servers/host-key/probe', endpoint);
    assert.equal(
      hostDigest(probe.fingerprint),
      hostDigest(target.hostKeyFingerprint),
      `目标 ${id} 的实际 SSH 指纹与预期不符`,
    );
    assert.match(probe.acceptanceToken, /^[A-Za-z0-9_-]{43}$/, 'SSH 指纹确认令牌无效');
    const credential = await createCredential(
      `ssh-${id}`,
      target.privateKey ? 'SSH_KEY' : 'SSH_PASSWORD',
      target.privateKey ? { privateKey: target.privateKey } : { password: target.password },
    );
    servers[id] = await post('/servers', {
      name: resourceName(id),
      description: marker,
      tags: ['veyops-demo'],
      ...endpoint,
      username: target.username,
      credentialId: credential.id,
      hostKeyAcceptanceToken: probe.acceptanceToken,
    });
  }
  for (const { id, serverIds } of demo.platformResources.groups) {
    if (!groups[id])
      groups[id] = await post('/server-groups', {
        name: resourceName(id),
        description: marker,
        serverIds: serverIds.map((alias) => servers[alias].id),
      });
  }

  const repos = {};
  for (const { id } of demo.repositories) {
    const previous = find(detail.repositories, ({ name }) => name === id, `演示仓库 ${id}`);
    if (previous) {
      assert.equal(previous.cloneUrl, cloneUrl, `演示仓库 ${id} 地址已变更`);
      assert.equal(previous.description, marker, `同名仓库 ${id} 不属于此演示版本`);
    }
    repos[id] =
      previous ?? (await post(base + '/repositories', { name: id, description: marker, cloneUrl }));
  }
  const services = {};
  for (const { id, name, repositoryId, addresses: serviceAddresses } of demo.services) {
    const previous = find(detail.services, (row) => row.slug === id, `演示服务 ${id}`);
    const links = serviceAddresses.map(({ id: alias, name: label, url }) => ({
      name: label,
      url: new URL(addresses[alias] ?? url).href,
    }));
    if (previous) {
      assert.equal(previous.description, marker, `同标识服务 ${id} 不属于此演示版本`);
      assert.deepEqual(
        previous.addresses.map(({ name, url }) => ({ name, url })),
        links,
        `演示服务 ${id} 地址已变更`,
      );
    }
    const service =
      previous ??
      (await post(base + '/services', {
        slug: id,
        name,
        description: marker,
        serviceType: 'WEB',
        addresses: links,
      }));
    const repoPath = `/services/${service.id}/repositories`;
    const linked = await get(repoPath);
    const primary = repos[repositoryId].id;
    if (!linked.length)
      await put(repoPath, {
        repositories: [{ repositoryId: primary, repoPath: '.', isPrimary: true }],
      });
    else
      assert.ok(
        linked.length === 1 && linked[0].repositoryId === primary && linked[0].isPrimary,
        `演示服务 ${id} 主仓库已变更`,
      );
    services[id] = service;
  }
  const sets = {};
  const existed = await get(base + '/environment-sets');
  for (const { id, name, variables } of demo.environmentSets) {
    const setPath = base + '/environment-sets';
    const previous = find(existed, (row) => row.name === name, `演示变量集合 ${id}`);
    if (previous) {
      assert.equal(previous.description, marker, `同名变量集合 ${id} 不属于此演示版本`);
      const current = await get(setPath + '/' + previous.id);
      const projectVariables = (rows) =>
        byKey(
          rows.map(({ key, value, isSecret }) => ({
            key,
            value: isSecret ? null : value,
            isSecret: Boolean(isSecret),
          })),
        );
      assert.deepEqual(
        projectVariables(current.variables),
        projectVariables(variables),
        `演示变量集合 ${id} 内容已变更`,
      );
      assert.ok(
        current.variables.every((row) => !row.isSecret || row.secretSource === 'CREDENTIAL'),
      );
    } else {
      for (const { credentialId } of variables) {
        if (!credentialId || credentials[credentialId]) continue;
        credentials[credentialId] = await createCredential(credentialId, 'CUSTOM_SECRET', {
          value: `fixture://${slug}/${credentialId}`,
        });
      }
    }
    sets[id] =
      previous ??
      (await post(setPath, {
        name,
        description: marker,
        variables: variables.map(({ credentialId, ...fields }) => ({
          ...fields,
          ...(credentialId && { credentialId: credentials[credentialId].id }),
        })),
      }));
  }

  const references = {
    repositoryIds: ids(repos),
    serviceIds: ids(services),
    environmentSetIds: ids(sets),
    groupIds: ids(groups),
    serverIds: ids(servers),
  };
  const definition = compileDemoGraph(demo, references, buildOptions);
  const matches = (canvas) => stable(canvas) === stable(definition.canvas);
  assert.ok(
    matches(before.draft.canvas) || (before.revision === 1 && !before.publishedVersion),
    '演示执行图草稿已被编辑，初始化未覆盖',
  );
  let version = before.publishedVersion;
  if (version) {
    const published = await get(graph + '/versions/' + version);
    assert.ok(
      !published.retiredAt && matches(published.definition.canvas),
      '当前发布版本与演示定义不一致',
    );
  } else {
    const validation = await post(graph + '/validate', { definition });
    assert.ok(validation.issues.length === 0, JSON.stringify(validation.issues));
    const draft = matches(before.draft.canvas)
      ? before
      : await put(graph + '/draft', { expectedRevision: before.revision, definition });
    version = (await post(graph + '/publish', { expectedRevision: draft.revision }))
      .publishedVersion;
  }

  return { projectId: project.id, version, ...references, ...commits };
}

async function signIn(apiBase, password) {
  const base = new URL(apiBase);
  assert.ok(
    ['http:', 'https:'].includes(base.protocol) &&
      !base.username &&
      !base.password &&
      !base.search &&
      !base.hash,
  );
  const endpoint = base.href.replace(/\/$/, '');
  assert.equal(base.pathname.replace(/\/$/, ''), '/api/v1', 'apiBase 需要包含 /api/v1');
  assert.ok(typeof password === 'string' && password, '请设置 VEYOPS_DEMO_ADMIN_PASSWORD');
  let cookie;
  const call = async (method, path, body) => {
    const response = await fetch(endpoint + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(35000),
      headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const update = response.headers.get('set-cookie');
    if (update) cookie = update.split(';')[0];
    const json = await response.json();
    if (!response.ok)
      throw new Error(`${method} ${path} (${response.status}) ${json.error?.message ?? ''}`);
    return json.data;
  };
  await call('POST', '/auth/login', { username: 'root', password });
  const identity = await call('GET', '/auth/me');
  assert.ok(
    identity.role === 'ADMIN' && !identity.mustChangePassword,
    '请使用已修改初始密码的管理员账号',
  );
  return call;
}

async function main() {
  const [action, configPath, fixturePath] = process.argv.slice(2);
  assert.ok(
    ['init', 'git'].includes(action) && configPath,
    '用法: node tools/acceptance/refactor-demo.cjs git <目录> [project.yaml] 或 init <配置.json> [project.yaml]',
  );
  const demo = loadDemo(fixturePath);
  if (action === 'git') return prepareDemoRepository(demo, configPath);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  demoInputs(demo, config);
  const call = await signIn(config.apiBase, process.env.VEYOPS_DEMO_ADMIN_PASSWORD);
  return initializeDemo(demo, { ...config, call });
}

if (require.main === module)
  main()
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    })
    .catch((error) => {
      process.stderr.write(error.message + '\n');
      process.exitCode = 1;
    });

module.exports = {
  loadDemo,
  demoCommits,
  prepareDemoRepository,
  serveDemoGit,
  compileDemoGraph,
  initializeDemo,
};
