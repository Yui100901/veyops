import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  canvasIssues,
  compileCanvas,
  withDraftCanvas,
} from '../modules/execution-graphs/execution-graph-canvas';
import {
  SaveGraphDraftDto,
  type GraphCanvas,
  type GraphFlow,
} from '../modules/execution-graphs/execution-graph-definition';
import type { GraphBinding, GraphField } from '../modules/execution-graphs/graph-fields';

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
      { id: 'deploy', name: '部署 Web', type: 'DEPLOY_ARTIFACT' },
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
  assert.equal(issue.nodeId, 'deploy');
  assert.match(issue.message, /FALSE/);
  bindings.deploy!.artifact = {
    kind: 'FIRST_AVAILABLE',
    sources: [output('build', 'image'), output('secondary-build', 'image')],
  };
  assert.deepEqual(canvasIssues(graph), []);
});
