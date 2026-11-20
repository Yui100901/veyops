import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { compileCanvas, withDraftCanvas } from '../modules/execution-graphs/execution-graph-canvas';
import {
  SaveGraphDraftDto,
  type GraphCanvas,
  type GraphFlow,
} from '../modules/execution-graphs/execution-graph-definition';

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
  assert.throws(() => compileCanvas(canvas, true), /须选择仓库/);
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
