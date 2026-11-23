import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  canvasCatalog,
  canvasIssues,
  compileCanvas,
  withDraftCanvas,
} from '../modules/execution-graphs/execution-graph-canvas';
import {
  SaveGraphDraftDto,
  type GraphCanvas,
  type GraphFlow,
  type GraphNode,
} from '../modules/execution-graphs/execution-graph-definition';
import {
  graphCatalog,
  GraphCompileError,
  type GraphBinding,
  type GraphField,
} from '../modules/execution-graphs/graph-fields';
import {
  checkedParameters,
  inspectDeclaredNodeOutputs,
  inspectNodeEnvironment,
  inspectNodeInputs,
} from '../modules/execution-graphs/graph-run-bindings';
import { graphResourceReferences } from '../modules/projects/project-resource-extraction';

const sharedCanvas = (): GraphCanvas => ({
  nodes: [
    { id: 'build-start', type: 'START', name: '构建代码' },
    { id: 'deploy-start', type: 'START', name: '部署应用' },
    { id: 'report', type: 'LOG', name: '总结', message: '完成' },
    { id: 'end', type: 'END', name: '检查状态' },
  ],
  edges: [
    { from: 'build-start', to: 'report' },
    { from: 'deploy-start', to: 'report' },
    { from: 'report', to: 'end' },
  ],
  endpoints: [
    { startId: 'build-start', endId: 'end' },
    { startId: 'deploy-start', endId: 'end' },
  ],
  templates: [{ id: 'template-report', type: 'LOG', name: '通用总结', message: '模板日志' }],
});

test('each paired start defines its own named flow and independent incoming edges at shared nodes', () => {
  const canvas = sharedCanvas();
  const { flows } = compileCanvas(canvas, true);
  assert.deepEqual(
    flows.map(({ id, name }) => ({ id, name })),
    canvas.nodes.slice(0, 2).map(({ id, name }) => ({ id, name })),
  );
  assert.deepEqual(
    flows[0]!.nodes.map(({ id }) => id),
    ['build-start', 'report', 'end'],
  );
  assert.deepEqual(
    flows[1]!.nodes.map(({ id }) => id),
    ['deploy-start', 'report', 'end'],
  );
  assert.deepEqual(flows[1]!.edges, [
    { from: 'deploy-start', to: 'report' },
    { from: 'report', to: 'end' },
  ]);
  assert.equal(canvas.templates[0]!.message, '模板日志');
});

test('the compiled start reads explicit run parameters with their original provenance', () => {
  const canvas = sharedCanvas();
  canvas.nodes[1]!.inputs = [
    { id: 'savedArtifact', name: '已登记产物', type: 'ARTIFACT', required: true },
    { id: 'profile', name: '环境', type: 'TEXT', required: true, defaultValue: 'stable' },
  ];
  const flow = compileCanvas(canvas, true).flows[1]!;
  const start = flow.nodes[0]!;
  const artifact = { artifactId: '44f3a210-87ea-4bb2-b345-956476f09ee5' };
  const inspected = inspectNodeInputs(flow, start, {
    context: {},
    parameters: { savedArtifact: artifact, profile: 'staging' },
    parameterSources: { profile: { kind: 'TRIGGER_EVENT', eventField: 'environment' } },
  });
  assert.deepEqual({ ...inspected.values }, { savedArtifact: artifact, profile: 'staging' });
  assert.deepEqual(inspected.evidence[1]?.source, {
    kind: 'TRIGGER_EVENT',
    fieldId: 'profile',
    eventField: 'environment',
  });
  assert.deepEqual(
    inspectNodeInputs(flow, start, { context: {} }).evidence.map(({ state }) => state),
    ['ERROR', 'DEFAULTED'],
  );
  assert.equal(
    inspectNodeInputs(flow, start, {
      context: {},
      pendingArtifacts: new Set(['savedArtifact']),
    }).evidence[0]?.state,
    'DEFERRED',
  );
});

test('built-in start presets accept an artifact group and can omit optional version and directory', () => {
  const canvas = sharedCanvas();
  const fields = graphCatalog.inputPresets.filter(({ id }) =>
    ['artifacts', 'version', 'outputDir'].includes(id),
  );
  assert.equal(fields.length, 3);
  canvas.nodes[1]!.inputs = fields;
  const flow = compileCanvas(canvas, true).flows[1]!;
  const artifacts = [
    { artifactId: '44f3a210-87ea-4bb2-b345-956476f09ee5' },
    { artifactId: '44f3a210-87ea-4bb2-b345-956476f09ee6' },
  ];
  const parameters = checkedParameters(flow, { artifacts });
  const inspected = inspectNodeInputs(flow, flow.nodes[0]!, { context: {}, parameters });
  assert.deepEqual({ ...inspected.values }, { artifacts });
  assert.deepEqual(
    inspected.evidence.map(({ fieldId, state }) => [fieldId, state]),
    [
      ['version', 'OMITTED'],
      ['artifacts', 'RESOLVED'],
      ['outputDir', 'OMITTED'],
    ],
  );
  assert.throws(() => checkedParameters(flow, { artifacts: [] }), /输入构建产物组/);
});

test('draft accepts disconnected nodes and unplaced templates but cannot publish an incomplete flow', () => {
  const canvas = sharedCanvas();
  canvas.nodes.push(
    { id: 'unused', type: 'START', name: '尚未接入' },
    { id: 'other-end', type: 'END', name: '其他结束' },
  );
  canvas.templates.push({ id: 'template-shell', type: 'SHELL', name: '预建 Shell' });
  assert.equal(compileCanvas(canvas, true).flows.length, 2);
  canvas.endpoints[0]!.endId = 'other-end';
  assert.deepEqual(
    compileCanvas(canvas, false).flows.map(({ id }) => id),
    ['deploy-start'],
  );
  assert.throws(() => compileCanvas(canvas, true), /路径必须全部到达/);
  canvas.endpoints.push({ startId: 'build-start', endId: 'end' });
  assert.throws(() => compileCanvas(canvas, false), /一个开始节点只能配对一个结束节点/);
});

test('all branches of a paired start must reach its selected end', () => {
  const canvas = sharedCanvas();
  canvas.nodes.push(
    { id: 'condition', type: 'CONDITION', name: '选择', condition: { key: 'input', value: 'ok' } },
    { id: 'dead-end', type: 'LOG', name: '悬空节点', message: '待连接' },
  );
  canvas.edges[0] = { from: 'build-start', to: 'condition' };
  canvas.edges.push(
    { from: 'condition', to: 'report', when: 'TRUE' },
    { from: 'condition', to: 'dead-end', when: 'FALSE' },
  );
  assert.deepEqual(
    compileCanvas(canvas, false).flows.map(({ id }) => id),
    ['deploy-start'],
  );
  assert.throws(() => compileCanvas(canvas, true), /悬空节点/);
  const [issue] = canvasIssues(canvas);
  assert.equal(issue?.flowId, 'build-start');
  assert.deepEqual(issue?.edge, { from: 'condition', to: 'dead-end', when: 'FALSE' });
});

test('older flows get a deterministic canvas without altering stored execution identities', () => {
  const flow: GraphFlow = {
    id: 'stable-rule-flow',
    name: '原发布名称',
    nodes: [
      { id: 'legacy-start', type: 'START', name: '开始' },
      { id: 'stable-rule-flow', type: 'LOG', name: '日志', message: '历史节点' },
      { id: 'legacy-end', type: 'END', name: '完成' },
    ],
    edges: [
      { from: 'legacy-start', to: 'stable-rule-flow' },
      { from: 'stable-rule-flow', to: 'legacy-end' },
    ],
  };
  const adapted = withDraftCanvas({ flows: [flow] });
  assert.deepEqual(adapted, withDraftCanvas({ flows: [flow] }));
  assert.deepEqual(adapted.flows, [flow]);
  assert.deepEqual(adapted.canvas.endpoints, [{ startId: flow.id, endId: 'legacy-end' }]);
  assert.equal(compileCanvas(adapted.canvas, true).flows[0]!.id, flow.id);
  assert.equal(adapted.canvas.nodes[0]!.name, flow.name);
  assert.notEqual(adapted.canvas.nodes[1]!.id, flow.id);
});

test('checkout node validates branch and exact commit modes when publishing', () => {
  const canvas = sharedCanvas();
  const checkout = canvas.nodes[2]!;
  Object.assign(checkout, {
    type: 'CHECKOUT',
    name: '拉取代码',
    message: undefined,
    checkout: { mode: 'BRANCH' },
  });
  const dto = (input: GraphCanvas) =>
    validateSync(
      plainToInstance(SaveGraphDraftDto, {
        expectedRevision: 1,
        definition: { canvas: input, flows: [] },
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
  assert.deepEqual(dto(canvas), []);
  assert.equal(compileCanvas(canvas, false).flows.length, 2);
  assert.throws(() => compileCanvas(canvas, true), /项目仓库.*缺少必填来源/);
  const repositoryId = 'b3d888e3-13b4-4eb3-bda1-1b483eb130a7';
  checkout.checkout = { repositoryId, mode: 'BRANCH', branch: 'bad..branch' };
  assert.throws(() => compileCanvas(canvas, true), /有效分支/);
  checkout.checkout = { repositoryId, mode: 'BRANCH', branch: 'feature/demo', fullClone: true };
  assert.deepEqual(dto(canvas), []);
  assert.equal(compileCanvas(canvas, true).flows.length, 2);
  checkout.checkout = { repositoryId, mode: 'COMMIT', commitSha: 'a'.repeat(40), fullClone: false };
  assert.deepEqual(dto(canvas), []);
  assert.equal(compileCanvas(canvas, true).flows.length, 2);
});

const repositoryId = 'b3d888e3-13b4-4eb3-bda1-1b483eb130a7';
const serviceId = 'feb87136-05ea-4b38-8e63-85b0b3d4a07b';
const environment: GraphField = { id: 'environment', name: '环境', type: 'ENVIRONMENT' };
const imageInput: GraphField = {
  id: 'image',
  name: '已有镜像',
  type: 'ARTIFACT',
  artifactType: 'DOCKER_IMAGE',
};
const output = (nodeId: string, fieldId: string): GraphBinding => ({
  kind: 'OUTPUT',
  nodeId,
  fieldId,
});

test('editable function templates compile typed inputs, outputs, and environment overrides', () => {
  const canvas = sharedCanvas();
  const mode: GraphField = { id: 'mode', type: 'GIT_FETCH_MODE', name: '拉取方式', required: true };
  const version = { kind: 'COMMIT', value: 'a'.repeat(40) };
  const script: GraphNode = {
    id: 'script',
    name: '选择拉取方式',
    type: 'FUNCTION',
    operation: 'SHELL',
    shell: { location: 'MANAGER', command: 'printf "working\\n"', params: [mode] },
    inputDefaults: { mode: 'FULL' },
    outputs: [mode],
    environmentDefaults: { REGION: 'us-west', TRACE: 'off' },
  };
  canvas.nodes[2] = {
    id: 'report',
    type: 'FUNCTION',
    operation: 'CHECKOUT',
    name: '拉取代码',
    inputDefaults: { repository: repositoryId, version, fetchMode: 'LATEST' },
  };
  canvas.nodes.push(script);
  canvas.templates.push({
    ...canvas.nodes[2],
    id: 'template-checkout',
  });
  canvas.edges[0] = { from: 'build-start', to: 'script' };
  canvas.edges.push({ from: 'script', to: 'report' });
  const endpoint = canvas.endpoints[0]!;
  endpoint.inputBindings = {
    report: { fetchMode: { ...output('script', 'mode'), onMissing: 'USE_DEFAULT' } },
  };
  endpoint.environmentBindings = {
    script: { TRACE: { kind: 'VALUE', value: 'on' } },
  };
  assert.deepEqual(
    validateSync(
      plainToInstance(SaveGraphDraftDto, {
        expectedRevision: 1,
        definition: { canvas },
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    ),
    [],
  );
  const definition = compileCanvas(canvas, true);
  assert.ok(definition.canvas);
  assert.equal(definition.canvas.nodes[2]!.type, 'FUNCTION');
  assert.equal(definition.canvas.templates.at(-1)!.operation, 'CHECKOUT');
  const flow = definition.flows[0]!;
  const checkout = flow.nodes.find(({ id }) => id === 'report')!;
  assert.equal(checkout.type, 'CHECKOUT');
  assert.equal(checkout.operation, undefined);
  assert.equal(checkout.moduleId, 'git.checkout');
  const values = (mode: string) => new Map([['script', { mode }]]);
  const prepared = inspectNodeInputs(flow, checkout, { context: {}, outputs: values('FULL') });
  assert.deepEqual(
    { ...prepared.values },
    { repository: repositoryId, version, fetchMode: 'FULL' },
  );
  assert.equal(
    inspectNodeInputs(flow, checkout, { context: {}, producerStatus: () => 'SUCCESS' }).values
      .fetchMode,
    'LATEST',
  );
  assert.equal(
    inspectNodeInputs(flow, checkout, { context: {}, outputs: values('unexpected') }).evidence.at(
      -1,
    )?.state,
    'ERROR',
  );
  const scriptNode = flow.nodes.find(({ id }) => id === 'script')!;
  const { variables } = inspectNodeEnvironment(flow, scriptNode, { context: {} });
  assert.deepEqual({ ...variables.variables }, { REGION: 'us-west', TRACE: 'on' });
  assert.ok(
    graphResourceReferences(definition, { state: 'RUNNABLE', sourceId: 'graph' }).some(
      (item) => item.resourceId === repositoryId && item.fieldId === 'repository',
    ),
  );
  canvas.nodes[2]!.inputDefaults!.fetchMode = 'INVALID';
  assert.equal(canvasIssues(canvas)[0]!.fieldId, 'fetchMode');
});

test('declared single inputs consume the latest upstream reference before their own defaults', () => {
  const repository: GraphField = {
    id: 'repository',
    name: '仓库名称',
    referenceName: 'GIT_REPOSITORY_NAME',
    type: 'REPOSITORY',
    defaultValue: 'http://git.example.test/default.git',
  };
  const artifactDirectory: GraphField = {
    id: 'path',
    name: '产物目录',
    referenceName: 'ARTIFACT_DIR',
    type: 'PATH',
    defaultValue: './dist',
  };
  const script = (id: string, nodeOutputs: GraphField[]): GraphNode => ({
    id,
    type: 'FUNCTION',
    operation: 'SHELL',
    name: id,
    shell: { location: 'MANAGER', command: 'printf ok' },
    outputs: nodeOutputs,
  });
  const canvas: GraphCanvas = {
    nodes: [
      { id: 'start', name: '开始', type: 'START' },
      script('earlier', [{ ...repository, id: 'selected', defaultValue: undefined }]),
      script('nearer', [{ ...repository, id: 'different', defaultValue: undefined }]),
      {
        id: 'fetch',
        name: '自定义拉取',
        type: 'FUNCTION',
        operation: 'CHECKOUT',
        inputs: [repository],
        outputs: [{ id: 'branch', name: '实际分支', referenceName: 'ACTUAL_BRANCH', type: 'TEXT' }],
      },
      { ...script('deploy', []), inputs: [artifactDirectory] },
      { id: 'end', name: '结束', type: 'END' },
    ],
    edges: ['start', 'earlier', 'nearer', 'fetch', 'deploy'].map((from, index) => ({
      from,
      to: ['earlier', 'nearer', 'fetch', 'deploy', 'end'][index]!,
    })),
    endpoints: [{ startId: 'start', endId: 'end' }],
    templates: [],
  };
  const flow = compileCanvas(canvas, true).flows[0]!;
  const fetch = flow.nodes.find(({ id }) => id === 'fetch')!;
  const expected = {
    kind: 'FIRST_AVAILABLE',
    sources: [output('nearer', 'different'), output('earlier', 'selected')],
    onMissing: 'USE_DEFAULT',
  };
  assert.deepEqual(flow.compiled?.nodes.fetch?.inputBindings.repository, expected);
  assert.deepEqual(
    canvasCatalog(canvas, 'start', 'fetch').start?.nodes.fetch?.automaticInputBindings.repository,
    expected,
  );
  const outputs = new Map<string, Record<string, unknown>>([
    ['earlier', { selected: 'http://git.example.test/earlier.git' }],
    ['nearer', { different: 'http://git.example.test/nearer.git' }],
  ]);
  assert.equal(
    inspectNodeInputs(flow, fetch, { context: {}, outputs }).values.repository,
    'http://git.example.test/nearer.git',
  );
  assert.equal(
    inspectNodeInputs(flow, fetch, { context: {}, producerStatus: () => 'SKIPPED' }).values
      .repository,
    repository.defaultValue,
  );
  assert.equal(
    inspectNodeInputs(
      flow,
      flow.nodes.find(({ id }) => id === 'deploy')!,
      { context: {} },
    ).values.path,
    './dist',
  );
  assert.equal(inspectDeclaredNodeOutputs(fetch, {})[0]?.state, 'ERROR');
  assert.equal(inspectDeclaredNodeOutputs(fetch, { branch: 'main' })[0]?.state, 'RESOLVED');
  repository.multiple = true;
  assert.match(canvasIssues(canvas)[0]!.message, /单值必填/);
  repository.multiple = false;
  repository.options = [];
  assert.match(canvasIssues(canvas)[0]!.message, /选项约束/);
});

function deliveryCanvas(): GraphCanvas {
  return {
    nodes: [
      { id: 'build-start', name: '仅构建', type: 'START', inputs: [environment] },
      { id: 'combined-start', name: '构建并部署', type: 'START', inputs: [environment] },
      { id: 'deploy-start', name: '仅部署', type: 'START', inputs: [environment, imageInput] },
      {
        id: 'source',
        name: '检出仓库',
        type: 'CHECKOUT',
        checkout: { repositoryId, mode: 'TAG', tag: 'v1.2' },
      },
      {
        id: 'build',
        name: '构建 JAR 和镜像',
        type: 'BUILD',
        build: {
          artifacts: [
            { name: 'jar', type: 'FILE', path: 'target/main.jar' },
            { name: 'image', type: 'DOCKER_IMAGE', imageReference: 'app/main:current' },
          ],
        },
      },
      {
        id: 'deploy',
        name: '部署 Web',
        type: 'DEPLOY_ARTIFACT',
        deploy: { method: 'FILE', deployPath: '/srv/veyops/test' },
      },
      {
        id: 'artifacts-end',
        name: '构建产物',
        type: 'END',
        outputs: [
          {
            id: 'jar',
            name: 'JAR',
            type: 'ARTIFACT',
            artifactType: 'FILE',
            source: 'CURRENT_RUN',
            multiple: true,
          },
          {
            id: 'image',
            name: '镜像',
            type: 'ARTIFACT',
            artifactType: 'DOCKER_IMAGE',
            source: 'CURRENT_RUN',
            multiple: true,
          },
        ],
      },
      {
        id: 'release-end',
        name: '发布结果',
        type: 'END',
        outputs: [{ id: 'web', name: 'Web 发布', type: 'RELEASE' }],
      },
    ],
    edges: [
      { from: 'build-start', to: 'source' },
      { from: 'combined-start', to: 'source' },
      { from: 'source', to: 'build' },
      { from: 'build', to: 'artifacts-end' },
      { from: 'build', to: 'deploy' },
      { from: 'deploy-start', to: 'deploy' },
      { from: 'deploy', to: 'release-end' },
    ],
    endpoints: [
      {
        startId: 'build-start',
        endId: 'artifacts-end',
        serviceId,
        inputBindings: { build: { workspace: output('source', 'workspace') } },
        outputBindings: { jar: output('build', 'jar'), image: output('build', 'image') },
      },
      {
        startId: 'combined-start',
        endId: 'release-end',
        serviceId,
        inputBindings: {
          build: { workspace: output('source', 'workspace') },
          deploy: { artifact: output('build', 'image') },
        },
        outputBindings: { web: output('deploy', 'release') },
      },
      {
        startId: 'deploy-start',
        endId: 'release-end',
        serviceId,
        inputBindings: { deploy: { artifact: { kind: 'INPUT', fieldId: 'image' } } },
        outputBindings: { web: output('deploy', 'release') },
      },
    ],
    templates: [],
  };
}

test('three entries share functional nodes and retain independent typed bindings in the published graph', () => {
  const canvas = deliveryCanvas();
  assert.deepEqual(canvasIssues(canvas), []);
  assert.deepEqual(
    validateSync(
      plainToInstance(SaveGraphDraftDto, {
        expectedRevision: 1,
        definition: { canvas },
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    ),
    [],
  );
  const { flows } = compileCanvas(canvas, true);
  assert.deepEqual(
    flows.map((flow) => flow.nodes.map((node) => node.id)),
    [
      ['build-start', 'source', 'build', 'artifacts-end'],
      ['combined-start', 'source', 'build', 'deploy', 'release-end'],
      ['deploy-start', 'deploy', 'release-end'],
    ],
  );
  assert.deepEqual(
    flows.map((flow) => flow.inputBindings?.deploy?.artifact),
    [undefined, output('build', 'image'), { kind: 'INPUT', fieldId: 'image' }],
  );
  assert.equal(flows[0]!.nodes.find((node) => node.id === 'build')?.moduleVersion, 1);
});

test('publishing identifies missing input, incorrect type and untrusted managed references', () => {
  const canvas = deliveryCanvas();
  const deploy = canvas.endpoints[2]!;
  delete deploy.inputBindings!.deploy!.artifact;
  assert.deepEqual(
    canvasIssues(canvas).map(({ flowId, nodeId, fieldId }) => [flowId, nodeId, fieldId]),
    [['deploy-start', 'deploy', 'artifact']],
  );
  deploy.inputBindings!.deploy!.artifact = { kind: 'INPUT', fieldId: 'environment' };
  assert.match(canvasIssues(canvas)[0]!.message, /数据类型/);
  deploy.inputBindings!.deploy!.artifact = { kind: 'INPUT', fieldId: 'image' };
  canvas.nodes[2]!.inputs!.push({
    id: 'arbitrary-workspace',
    name: '伪造工作区',
    type: 'WORKSPACE',
  });
  assert.match(canvasIssues(canvas)[0]!.message, /绑定上游模块输出/);
});

test('publishing reports missing inputs for every affected flow in canvas order', () => {
  const canvas = deliveryCanvas();
  delete canvas.endpoints[1]!.inputBindings!.deploy!.artifact;
  delete canvas.endpoints[2]!.inputBindings!.deploy!.artifact;
  const issues = canvasIssues(canvas);
  assert.deepEqual(
    issues.map(({ flowId, nodeId, fieldId }) => [flowId, nodeId, fieldId]),
    [
      ['combined-start', 'deploy', 'artifact'],
      ['deploy-start', 'deploy', 'artifact'],
    ],
  );
  assert.throws(
    () => compileCanvas(canvas, true),
    (error: unknown) => {
      assert.ok(error instanceof GraphCompileError);
      assert.deepEqual(error.issue, issues[0]);
      assert.deepEqual(error.issues, issues);
      return true;
    },
  );
});

test('a shared build reports its missing workspace only in the affected flow', () => {
  const canvas = deliveryCanvas();
  delete canvas.endpoints[0]!.inputBindings!.build!.workspace;
  const [issue] = canvasIssues(canvas);
  assert.deepEqual(
    [issue?.flowId, issue?.nodeId, issue?.fieldId],
    ['build-start', 'build', 'workspace'],
  );
  const candidates = canvasCatalog(canvas, 'build-start', 'build')['build-start']!.nodes.build!
    .candidates;
  assert.ok(
    candidates.some(
      ({ binding, availability }) =>
        availability === 'ALWAYS' &&
        binding.kind === 'OUTPUT' &&
        binding.nodeId === 'source' &&
        binding.fieldId === 'workspace',
    ),
  );
  canvas.endpoints[0]!.inputBindings!.build!.workspace = output('source', 'workspace');
  assert.deepEqual(canvasIssues(canvas), []);
});

test('a branch that bypasses release points to the required ending result and live edge', () => {
  const canvas = deliveryCanvas();
  canvas.nodes.push({
    id: 'skip-release',
    type: 'CONDITION',
    name: '决定是否发布',
    condition: { key: 'input', value: 'yes' },
  });
  const bypass = { from: 'skip-release', to: 'release-end', when: 'FALSE' as const };
  canvas.edges = canvas.edges.filter(({ from, to }) => from !== 'build' || to !== 'deploy');
  canvas.edges.push(
    { from: 'build', to: 'skip-release' },
    { from: 'skip-release', to: 'deploy', when: 'TRUE' },
    bypass,
  );
  const [issue] = canvasIssues(canvas);
  assert.equal(issue?.flowId, 'combined-start');
  assert.equal(issue?.nodeId, 'release-end');
  assert.equal(issue?.fieldId, 'web');
  assert.equal(issue?.sourceNodeId, 'deploy');
  assert.deepEqual(issue?.edge, bypass);
});

test('an ordinary branch with two routes to the same end requires an entry-specific selection', () => {
  const graph = deliveryCanvas();
  graph.nodes.push({ id: 'approve', name: '审批', type: 'APPROVAL' });
  graph.edges.push({ from: 'combined-start', to: 'approve' }, { from: 'approve', to: 'source' });
  assert.match(canvasIssues(graph)[0]!.message, /明确选择出线/);
  graph.endpoints[1]!.edgeSelections = { 'combined-start': ['approve'] };
  const flows = compileCanvas(graph, true).flows;
  assert.equal(flows[1]!.edges.find((edge) => edge.from === 'combined-start')?.to, 'approve');
  assert(!flows[0]!.nodes.some((node) => node.id === 'approve'));
});

test('conditional consumers require the producer on every active branch and allow available alternatives', () => {
  const graph = deliveryCanvas();
  graph.endpoints = [graph.endpoints[1]!];
  graph.nodes.push(
    {
      id: 'condition',
      type: 'CONDITION',
      name: '需要重新构建',
      condition: { key: 'input', value: 'yes' },
    },
    { id: 'secondary-build', type: 'BUILD', name: '替代构建', build: graph.nodes[4]!.build },
    { id: 'join', type: 'JOIN', name: '合并' },
  );
  graph.edges = graph.edges.filter(
    (edge) =>
      !(
        edge.from === 'combined-start' ||
        edge.from === 'source' ||
        (edge.from === 'build' && edge.to === 'deploy')
      ),
  );
  graph.edges.push(
    { from: 'combined-start', to: 'source' },
    { from: 'source', to: 'condition' },
    { from: 'condition', to: 'build', when: 'TRUE' },
    { from: 'condition', to: 'secondary-build', when: 'FALSE' },
    { from: 'build', to: 'join' },
    { from: 'secondary-build', to: 'join' },
    { from: 'join', to: 'deploy' },
  );
  const bindings = graph.endpoints[0]!.inputBindings!;
  bindings['secondary-build'] = { workspace: output('source', 'workspace') };
  const issue = canvasIssues(graph)[0]!;
  assert.equal(issue.flowId, 'combined-start');
  assert.equal(issue.nodeId, 'deploy');
  assert.equal(issue.fieldId, 'artifact');
  assert.deepEqual(issue.edge, { from: 'condition', to: 'secondary-build', when: 'FALSE' });
  assert.match(issue.message, /FALSE/);
  bindings.deploy!.artifact = {
    kind: 'FIRST_AVAILABLE',
    sources: [output('build', 'image'), output('secondary-build', 'image')],
  };
  assert.deepEqual(canvasIssues(graph), []);
  bindings.condition = { value: { kind: 'VALUE', value: 'yes' } };
  const candidates = canvasCatalog(graph, 'combined-start', 'deploy')['combined-start']!.nodes
    .deploy!.candidates;
  assert.ok(
    !candidates.some(
      ({ binding }) => binding.kind === 'OUTPUT' && binding.nodeId === 'secondary-build',
    ),
  );
});
