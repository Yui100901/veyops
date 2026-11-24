import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasCatalog, compileCanvas } from '../modules/execution-graphs/execution-graph-canvas';
import type {
  GraphCanvas,
  GraphNode,
} from '../modules/execution-graphs/execution-graph-definition';
import { GraphCompileError, type GraphField } from '../modules/execution-graphs/graph-fields';
import { expandGraphTemplate } from '../modules/execution-graphs/graph-flow-templates';
import {
  assertRuntimeParameterOverrides,
  checkedParameters,
  declaredScope,
  graphEnvironmentSetId,
  inspectNodeInputs,
} from '../modules/execution-graphs/graph-run-bindings';

const repositoryId = 'a3d7b94a-2862-499e-b47f-7e2af06d8d72';
const firstServer = 'a3d7b94a-2862-499e-b47f-7e2af06d8d73';
const otherServer = 'a3d7b94a-2862-499e-b47f-7e2af06d8d74';
const serviceId = 'a3d7b94a-2862-499e-b47f-7e2af06d8d75';
const environmentSetId = 'a3d7b94a-2862-499e-b47f-7e2af06d8d76';
const alternateService = 'a3d7b94a-2862-499e-b47f-7e2af06d8d77';
const main = { kind: 'BRANCH', value: 'main' };
const alternate = { kind: 'BRANCH', value: 'review-alt' };
const input = (fieldId: string) => ({ kind: 'INPUT' as const, fieldId });
const output = (nodeId: string, fieldId: string) => ({ kind: 'OUTPUT' as const, nodeId, fieldId });
const file = { id: 'dist', name: '文件', type: 'FILE' as const, path: 'build.tar' };

function start(id = 'start', serverId = firstServer): GraphNode {
  const fields: GraphField[] = [
    {
      id: 'repository',
      name: '仓库',
      type: 'REPOSITORY',
      defaultValue: repositoryId,
      runtimeOverride: false,
    },
    { id: 'gitVersion', name: '版本', type: 'GIT_REF', defaultValue: main, runtimeOverride: true },
    {
      id: 'builder',
      name: '构建服务器',
      type: 'TARGETS',
      purpose: 'BUILD_TARGETS',
      defaultValue: { serverIds: [serverId] },
      runtimeOverride: false,
    },
    {
      id: 'releaser',
      name: '发布服务器',
      type: 'TARGETS',
      purpose: 'RELEASE_TARGETS',
      defaultValue: { serverIds: [otherServer] },
      runtimeOverride: false,
    },
    {
      id: 'service',
      name: '服务',
      type: 'SERVICE',
      defaultValue: { serviceId },
      runtimeOverride: false,
    },
    {
      id: 'environmentSet',
      name: '变量集合',
      type: 'ENVIRONMENT_SET',
      defaultValue: environmentSetId,
      runtimeOverride: false,
    },
  ];
  return { id, name: id, type: 'START', contract: 'PRESET', inputs: fields };
}

function fixture(): GraphCanvas {
  const nodes: GraphNode[] = [
    start(),
    { id: 'code', name: '代码', type: 'FUNCTION', operation: 'CHECKOUT' },
    {
      id: 'env',
      name: '环境文件',
      type: 'FUNCTION',
      operation: 'LOAD_ENV',
      loadEnvironment: { envFile: '.env.build' },
    },
    { id: 'check', name: '测试', type: 'FUNCTION', operation: 'CHECK', shell: { command: 'true' } },
    {
      id: 'build',
      name: '构建',
      type: 'FUNCTION',
      operation: 'BUILD',
      build: { buildCommand: 'true', artifacts: [file] },
    },
    {
      id: 'release',
      name: '部署',
      type: 'FUNCTION',
      operation: 'DEPLOY_ARTIFACT',
      deploy: { method: 'FILE', deployPath: '/srv/test-app', startCommand: 'true' },
    },
    {
      id: 'health',
      name: '检查发布',
      type: 'FUNCTION',
      operation: 'HEALTH_CHECK',
      healthCheck: { command: 'true' },
    },
    { id: 'end', name: '结束', type: 'END' },
  ];
  const edges = nodes.slice(1).map(({ id }, index) => ({ from: nodes[index]!.id, to: id }));
  return { nodes, edges, endpoints: [{ startId: 'start', endId: 'end' }], templates: [] };
}

test('preset flows infer stable action input bindings and distinct per-start target roles', () => {
  const canvas = fixture();
  canvas.nodes.push(start('second', otherServer));
  canvas.edges.push({ from: 'second', to: 'code' });
  canvas.endpoints.push({ startId: 'second', endId: 'end' });
  const compiled = compileCanvas(canvas, true);
  assert.equal(compiled.flows.length, 2);
  for (const flow of compiled.flows) {
    const nodes = flow.compiled!.nodes;
    assert.equal(nodes.code!.inputBindings.repository?.kind, 'INPUT');
    assert.deepEqual(nodes.code!.inputBindings.version, {
      ...input('gitVersion'),
      onMissing: 'REPOSITORY_DEFAULT',
    });
    for (const consumer of ['check', 'build']) {
      assert.deepEqual(nodes[consumer]!.inputBindings.workspace, output('code', 'workspace'));
      assert.deepEqual(nodes[consumer]!.inputBindings.source, output('code', 'source'));
      assert.deepEqual(nodes[consumer]!.inputBindings.variables, output('env', 'variables'));
      assert.deepEqual(nodes[consumer]!.inputBindings.targets, input('builder'));
    }
    assert.deepEqual(nodes.release!.inputBindings.artifact, output('build', 'dist'));
    assert.deepEqual(nodes.release!.inputBindings.targets, input('releaser'));
    assert.deepEqual(nodes.health!.inputBindings, { release: output('release', 'release') });
  }
  const [primary, secondary] = compiled.flows;
  assert.deepEqual(checkedParameters(primary!).builder, { serverIds: [firstServer] });
  assert.deepEqual(checkedParameters(secondary!).builder, { serverIds: [otherServer] });
  assert.deepEqual(checkedParameters(primary!).gitVersion, main);
  assert.equal(
    graphEnvironmentSetId(primary!, { parameters: checkedParameters(primary!) }),
    environmentSetId,
  );
  assert.throws(
    () => assertRuntimeParameterOverrides(primary!, { repository: repositoryId }),
    /不允许本次运行修改/,
  );
  const tag = { kind: 'TAG', value: 'v1.2.3' };
  assert.doesNotThrow(() => assertRuntimeParameterOverrides(primary!, { gitVersion: tag }));
  assert.deepEqual(checkedParameters(primary!, { gitVersion: tag }).gitVersion, tag);
});

test('preset workspace selection diagnoses ambiguity and follows an explicitly selected checkout pair', () => {
  const canvas = fixture();
  canvas.nodes.push({ id: 'other', name: '第二次检出', type: 'FUNCTION', operation: 'CHECKOUT' });
  canvas.edges = canvas.edges.flatMap((edge) =>
    edge.from === 'code'
      ? [
          { from: 'code', to: 'other' },
          { from: 'other', to: edge.to },
        ]
      : [edge],
  );
  assert.throws(() => compileCanvas(canvas, true), /环境文件.*多个兼容的上游来源/);
  canvas.endpoints[0]!.inputBindings = {
    env: { workspace: output('code', 'workspace') },
    check: { source: output('other', 'source') },
    build: { workspace: output('other', 'workspace') },
  };
  const nodes = compileCanvas(canvas, true).flows[0]!.compiled!.nodes;
  assert.deepEqual(nodes.env!.inputBindings.source, output('code', 'source'));
  assert.deepEqual(nodes.check!.inputBindings.workspace, output('other', 'workspace'));
  assert.deepEqual(nodes.build!.inputBindings.source, output('other', 'source'));
  canvas.endpoints[0]!.inputBindings!.build!.source = output('code', 'source');
  assert.throws(() => compileCanvas(canvas, true), /同一次检出/);
});

test('preset actions reject declarations overriding fixed ports and keep custom Shell outputs', () => {
  const canvas = fixture();
  const check = canvas.nodes.find(({ id }) => id === 'check')!;
  check.outputs = [{ id: 'result', name: '额外报告', type: 'TEXT' }];
  assert.throws(() => compileCanvas(canvas, true), /固定端口/);
  check.operation = 'SHELL';
  const compiled = compileCanvas(canvas, true).flows[0]!.compiled!;
  assert.ok(
    compiled.nodes.check!.outputs.some(({ id, type }) => id === 'result' && type === 'TEXT'),
  );
  check.outputs = [{ id: 'report', name: '重定义报告', type: 'TEXT' }];
  assert.throws(() => compileCanvas(canvas, true), /固定端口/);
});

test('preset deployment requires express branch alternatives when no artifact dominates', () => {
  const first = start();
  first.inputs!.push({ id: 'side', name: '分支', type: 'TEXT' });
  const left: GraphNode = {
    id: 'left',
    type: 'FUNCTION',
    operation: 'SHELL',
    name: '左产物',
    shell: { location: 'MANAGER', command: 'true', artifacts: [file] },
  };
  const right: GraphNode = {
    id: 'right',
    type: 'FUNCTION',
    operation: 'SHELL',
    name: '右产物',
    shell: { location: 'MANAGER', command: 'true' },
  };
  const canvas: GraphCanvas = {
    nodes: [
      first,
      {
        id: 'branch',
        name: '分支判断',
        type: 'CONDITION',
        condition: { key: 'input', value: 'left' },
      },
      left,
      right,
      {
        id: 'deploy',
        name: '发布',
        type: 'FUNCTION',
        operation: 'DEPLOY_ARTIFACT',
        deploy: { method: 'FILE', deployPath: '/srv/test-app' },
      },
      { id: 'end', name: '结束', type: 'END' },
    ],
    edges: [
      { from: 'start', to: 'branch' },
      { from: 'branch', to: 'left', when: 'TRUE' },
      { from: 'branch', to: 'right', when: 'FALSE' },
      { from: 'left', to: 'deploy' },
      { from: 'right', to: 'deploy' },
      { from: 'deploy', to: 'end' },
    ],
    endpoints: [
      { startId: 'start', endId: 'end', inputBindings: { branch: { value: input('side') } } },
    ],
    templates: [],
  };
  assert.throws(() => compileCanvas(canvas, true), /无法覆盖每条到达路径/);
  right.shell!.artifacts = [file];
  assert.throws(() => compileCanvas(canvas, true), /多个兼容的上游来源/);
  canvas.endpoints[0]!.inputBindings!.deploy = {
    artifact: {
      kind: 'FIRST_AVAILABLE',
      sources: [output('left', 'dist'), output('right', 'dist')],
    },
  };
  const flow = compileCanvas(canvas, true).flows[0]!;
  assert.equal(flow.compiled!.nodes.deploy!.inputBindings.artifact?.kind, 'FIRST_AVAILABLE');
});

test('minimal default template uses the start contract and retains five stable actions', () => {
  const { canvas } = expandGraphTemplate('MINIMAL_CI_CD');
  assert.equal(canvas.nodes[0]!.contract, 'PRESET');
  assert.deepEqual(
    canvas.nodes.map(({ type, operation }) => operation ?? type),
    ['START', 'CHECKOUT', 'BUILD', 'DEPLOY_ARTIFACT', 'END'],
  );
});

function withNamedGroups() {
  const canvas = fixture();
  canvas.nodes[0]!.inputs!.push(
    { id: 'repository-2', name: '联调', type: 'REPOSITORY', defaultValue: repositoryId },
    { id: 'gitVersion-2', name: '联调版本', type: 'GIT_REF', defaultValue: alternate },
    { id: 'service-2', name: '联调目标', type: 'SERVICE', defaultValue: alternateService },
    {
      id: 'releaseTargets-2',
      name: '联调服务器',
      type: 'TARGETS',
      purpose: 'RELEASE_TARGETS',
      defaultValue: { serverIds: [firstServer] },
    },
  );
  canvas.endpoints[0]!.inputBindings = {
    code: { repository: input('repository-2') },
    release: { service: input('service-2') },
  };
  return canvas;
}

test('preset catalog, publication and runtime use the selected named source and release group', () => {
  const canvas = withNamedGroups();
  canvas.endpoints[0]!.serviceId = serviceId;
  const code = canvasCatalog(canvas, 'start', 'code').start?.nodes.code;
  const release = canvasCatalog(canvas, 'start', 'release').start?.nodes.release;
  assert.deepEqual(code?.automaticInputBindings.version, {
    ...input('gitVersion-2'),
    onMissing: 'REPOSITORY_DEFAULT',
  });
  assert.ok(
    code?.sourceGroups?.some(
      ({ id, companion }) => id === 'repository-2' && companion?.id === 'gitVersion-2',
    ),
  );
  assert.deepEqual(release?.automaticInputBindings.targets, input('releaseTargets-2'));
  const flow = compileCanvas(canvas, true).flows[0]!;
  const nodes = flow.compiled!.nodes;
  assert.deepEqual(nodes.build?.inputBindings.service, input('service-2'));
  assert.deepEqual(nodes.release?.inputBindings.service, input('service-2'));
  assert.deepEqual(nodes.release?.inputBindings.targets, input('releaseTargets-2'));
  assert.deepEqual(
    declaredScope(flow, { parameters: checkedParameters(flow) }).serviceId,
    alternateService,
  );
  const parameters = checkedParameters(flow, { gitVersion: { kind: 'TAG', value: 'v1.2.3' } });
  const checkout = flow.nodes.find(({ id }) => id === 'code')!;
  assert.deepEqual(
    inspectNodeInputs(flow, checkout, { parameters, context: {} }).values.version,
    alternate,
  );
  const pinned = { kind: 'COMMIT', value: 'a'.repeat(40) };
  const override = checkedParameters(flow, { gitVersion: main, 'gitVersion-2': pinned });
  assert.deepEqual(
    inspectNodeInputs(flow, checkout, { parameters: override, context: {} }).values.version,
    pinned,
  );
});

test('preset group diagnostics identify the consumer and the missing or mismatched start member', () => {
  const canvas = withNamedGroups();
  const bindings = canvas.endpoints[0]!.inputBindings!;
  const hasIssue = (nodeId: string, port: string, fieldId: string) => (error: unknown) =>
    error instanceof GraphCompileError &&
    error.issues.some(
      (issue) =>
        issue.nodeId === nodeId &&
        issue.fieldId === port &&
        issue.sourceNodeId === 'start' &&
        issue.sourceFieldId === fieldId,
    );
  bindings.code!.version = input('gitVersion');
  assert.throws(() => compileCanvas(canvas, true), hasIssue('code', 'version', 'gitVersion-2'));
  delete bindings.code!.version;
  bindings.release!.targets = input('releaser');
  assert.throws(
    () => compileCanvas(canvas, true),
    hasIssue('release', 'targets', 'releaseTargets-2'),
  );
  delete bindings.release!.targets;
  canvas.nodes[0]!.inputs = canvas.nodes[0]!.inputs!.filter(({ id }) => id !== 'repository-2');
  assert.doesNotThrow(() => compileCanvas(canvas, false));
  assert.throws(() => compileCanvas(canvas, true), hasIssue('code', 'repository', 'repository-2'));
});

test('single preset group can use same-host start configuration and an empty Git version', () => {
  const canvas = fixture();
  const startNode = canvas.nodes[0]!;
  startNode.sameHostRelease = true;
  startNode.inputs = startNode.inputs!.flatMap((field) =>
    field.id === 'builder'
      ? [{ ...field, id: 'buildTargets' }]
      : field.id === 'gitVersion'
        ? [{ ...field, required: false, defaultValue: undefined }]
        : field.id === 'releaser'
          ? []
          : [field],
  );
  const flow = compileCanvas(canvas, true).flows[0]!;
  assert.deepEqual(flow.compiled?.nodes.release?.inputBindings.targets, input('buildTargets'));
  const values = inspectNodeInputs(
    flow,
    flow.nodes.find(({ id }) => id === 'code')!,
    {
      context: {},
      parameters: checkedParameters(flow),
    },
  ).values;
  assert.equal(values.repository, repositoryId);
  assert.equal(values.version, undefined);
});

test('preset BUILD directly consuming a named source selects its Git version', () => {
  const canvas = withNamedGroups();
  canvas.nodes = canvas.nodes.filter(({ id }) => id !== 'code' && id !== 'env' && id !== 'check');
  canvas.edges = canvas.nodes
    .slice(1)
    .map(({ id }, index) => ({ from: canvas.nodes[index]!.id, to: id }));
  const bindings = canvas.endpoints[0]!.inputBindings!;
  delete bindings.code;
  bindings.build = { repository: input('repository-2') };
  const nodes = compileCanvas(canvas, true).flows[0]!.compiled!.nodes;
  assert.deepEqual(nodes.build?.inputBindings.repository, input('repository-2'));
  assert.deepEqual(nodes.build?.inputBindings.version, {
    ...input('gitVersion-2'),
    onMissing: 'REPOSITORY_DEFAULT',
  });
});

test('preset publication rejects node-level direct and legacy fixed resources', () => {
  const canvas = fixture();
  canvas.nodes[0]!.inputs = canvas.nodes[0]!.inputs!.filter(({ id }) => id !== 'repository');
  const checkout = canvas.nodes.find(({ id }) => id === 'code')!;
  checkout.inputDefaults = { repository: repositoryId };
  assert.doesNotThrow(() => compileCanvas(canvas, false));
  assert.throws(() => compileCanvas(canvas, true), /inputDefaults\.repository/);
  delete checkout.inputDefaults;
  checkout.checkout = { repositoryId, fullClone: true };
  assert.throws(() => compileCanvas(canvas, true), /checkout\.repositoryId/);
  checkout.checkout = { fullClone: true };
  canvas.nodes[0]!.inputs!.push({
    id: 'repository',
    name: '仓库',
    type: 'REPOSITORY',
    defaultValue: repositoryId,
  });
  assert.doesNotThrow(() => compileCanvas(canvas, true));
  const build = canvas.nodes.find(({ id }) => id === 'build')!;
  build.build!.buildLocation = 'MANAGER';
  assert.throws(() => compileCanvas(canvas, true), /build\.buildLocation/);
});
