import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  orderedFlowNodes,
  SaveGraphDraftDto,
  validateGraphDefinition,
  type GraphFlow,
} from '../modules/execution-graphs/execution-graph-definition';
import { GraphCompileError } from '../modules/execution-graphs/graph-fields';

function example(): GraphFlow {
  return {
    id: 'review',
    name: 'Review',
    nodes: [
      { id: 'end', type: 'END', name: 'End' },
      { id: 'second', type: 'LOG', name: 'Second branch', message: 'no' },
      { id: 'start', type: 'START', name: 'Start' },
      { id: 'check', type: 'CONDITION', name: 'Check', condition: { key: 'input', value: 'yes' } },
      { id: 'first', type: 'LOG', name: 'First branch', message: 'yes' },
      { id: 'join', type: 'JOIN', name: 'Join' },
    ],
    edges: [
      { from: 'start', to: 'check' },
      { from: 'check', to: 'first', when: 'TRUE' },
      { from: 'check', to: 'second', when: 'FALSE' },
      { from: 'first', to: 'join' },
      { from: 'second', to: 'join' },
      { from: 'join', to: 'end' },
    ],
  };
}

test('execution graph validates edges, branch labels and calls independently of node array order', () => {
  const flow = example();
  validateGraphDefinition({ flows: [flow] });
  assert.deepEqual(
    orderedFlowNodes(flow).map(({ id }) => id),
    ['start', 'check', 'first', 'second', 'join', 'end'],
  );
  flow.edges[2]!.when = 'TRUE';
  assert.throws(() => validateGraphDefinition({ flows: [flow] }), (error: unknown) => {
    assert.ok(error instanceof GraphCompileError);
    assert.equal(error.issue.flowId, flow.id);
    assert.equal(error.issue.nodeId, 'check');
    assert.deepEqual(error.issue.edge, flow.edges[2]);
    return true;
  });

  const cyclic = example();
  cyclic.nodes.push(
    { id: 'a', type: 'LOG', name: 'A', message: 'a' },
    { id: 'b', type: 'LOG', name: 'B', message: 'b' },
  );
  cyclic.edges.push({ from: 'a', to: 'b' }, { from: 'b', to: 'a' });
  assert.throws(() => validateGraphDefinition({ flows: [cyclic] }), /包含环/);

  const recursive = example();
  Object.assign(
    recursive.nodes.find(({ id }) => id === 'first')!,
    {
      type: 'FLOW_CALL',
      message: undefined,
      flowId: 'review',
    },
  );
  assert.throws(() => validateGraphDefinition({ flows: [recursive] }), /循环依赖/);
});

test('execution graph draft accepts bounded integer canvas coordinates', () => {
  const fixture = example();
  const validate = () =>
    validateSync(
      plainToInstance(SaveGraphDraftDto, {
        expectedRevision: 1,
        definition: {
          flows: [],
          canvas: {
            nodes: fixture.nodes,
            edges: fixture.edges,
            endpoints: [{ startId: 'start', endId: 'end' }],
            templates: [],
          },
        },
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
  fixture.nodes[0]!.position = { x: 0, y: 30000 };
  assert.deepEqual(validate(), []);
  fixture.nodes[0]!.position = { x: 1.5, y: 30001 };
  assert.notEqual(validate().length, 0);
});

function reviewedBuild(): GraphFlow {
  return {
    id: 'reviewed-build',
    name: '构建前审核',
    nodes: [
      { id: 'start', type: 'START', name: '开始' },
      {
        id: 'checkout',
        type: 'CHECKOUT',
        name: '检出',
        checkout: { repositoryId: '93f7655b-229b-489a-a21b-c4c0229cb584' },
      },
      { id: 'review', type: 'SOURCE_REVIEW', name: '审核', approval: { buildNodeId: 'build' } },
      { id: 'build', type: 'BUILD', name: '构建' },
      { id: 'end', type: 'END', name: '结束' },
    ],
    edges: [
      { from: 'start', to: 'checkout' },
      { from: 'checkout', to: 'review' },
      { from: 'review', to: 'build' },
      { from: 'build', to: 'end' },
    ],
    inputBindings: {
      build: {
        workspace: { kind: 'OUTPUT', nodeId: 'checkout', fieldId: 'workspace' },
        review: { kind: 'OUTPUT', nodeId: 'review', fieldId: 'review' },
      },
    },
    environmentBindings: {
      build: {
        GIT_SHA: { kind: 'OUTPUT', nodeId: 'checkout', fieldId: 'commitSha', onMissing: 'ERROR' },
      },
    },
  };
}

test('build bindings compile from the checked-out SHA and the linked source review', () => {
  const flow = reviewedBuild();
  const dto = plainToInstance(SaveGraphDraftDto, {
    expectedRevision: 1,
    definition: { flows: [flow] },
  });
  assert.deepEqual(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }), []);
  const compiled = validateGraphDefinition({ flows: [flow] })[flow.id]!;
  assert.deepEqual(compiled.nodes.review?.inputs, []);
  assert.deepEqual(
    compiled.nodes.build?.environmentBindings.GIT_SHA,
    flow.environmentBindings?.build?.GIT_SHA,
  );
  assert.ok(
    compiled.nodes.build?.dependencies.some(
      ({ nodeId, fieldId, consumerFieldId }) =>
        nodeId === 'checkout' && fieldId === 'commitSha' && consumerFieldId === 'GIT_SHA',
    ),
  );

  flow.environmentBindings!.build!.VEYOPS_PROJECT_ID = { kind: 'VALUE', value: 'override' };
  assert.throws(() => validateGraphDefinition({ flows: [flow] }), /环境变量名或来源格式无效/);
});

test('a build-linked review rejects alternate sources or an optional review proof', () => {
  const flow = reviewedBuild();
  flow.inputBindings!.review = {
    source: { kind: 'OUTPUT', nodeId: 'checkout', fieldId: 'source' },
  };
  assert.throws(() => validateGraphDefinition({ flows: [flow] }), /不能同时绑定源码或产物/);
  delete flow.inputBindings!.review;

  flow.inputBindings!.build!.review!.onMissing = 'OMIT';
  assert.throws(() => validateGraphDefinition({ flows: [flow] }), /凭证不可省略/);
});

test('a build-linked source review cannot authorize a different build', () => {
  const flow = reviewedBuild();
  flow.nodes.push({ id: 'other-build', type: 'BUILD', name: '其他构建' });
  flow.edges = flow.edges.filter((edge) => edge.from !== 'build' || edge.to !== 'end');
  flow.edges.push({ from: 'build', to: 'other-build' }, { from: 'other-build', to: 'end' });
  flow.inputBindings!['other-build'] = { ...flow.inputBindings!.build };

  assert.throws(() => validateGraphDefinition({ flows: [flow] }), /此审核凭证只可供关联构建使用/);
});

test('a linked review and its build must be on the same selectable branches', () => {
  for (const [from, gated] of [
    ['checkout', 'review'],
    ['review', 'build'],
  ] as const) {
    const flow = reviewedBuild();
    flow.nodes.push(
      {
        id: 'condition',
        type: 'CONDITION',
        name: '条件',
        condition: { key: 'input', value: 'yes' },
      },
      { id: 'skip', type: 'LOG', name: '跳过', message: '已跳过' },
    );
    flow.edges = flow.edges.filter((edge) => edge.from !== from || edge.to !== gated);
    flow.edges.push(
      { from, to: 'condition' },
      { from: 'condition', to: gated, when: 'TRUE' },
      { from: 'condition', to: 'skip', when: 'FALSE' },
    );
    if (gated === 'review') {
      flow.nodes.push({ id: 'merge', type: 'JOIN', name: '汇合' });
      flow.edges = flow.edges.filter((edge) => edge.from !== 'review' || edge.to !== 'build');
      flow.edges.push(
        { from: 'skip', to: 'merge' },
        { from: 'review', to: 'merge' },
        { from: 'merge', to: 'build' },
      );
    } else flow.edges.push({ from: 'skip', to: 'end' });
    assert.throws(
      () => validateGraphDefinition({ flows: [flow] }),
      /关联构建与源码审核必须处于同一执行路径/,
    );
  }
});
