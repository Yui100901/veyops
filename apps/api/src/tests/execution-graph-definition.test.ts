import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  extractGraphFlow,
  orderedFlowNodes,
  SaveGraphDraftDto,
  validateGraphDefinition,
  type GraphDefinition,
  type GraphFlow,
} from '../modules/execution-graphs/execution-graph-definition';

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
  assert.throws(() => validateGraphDefinition({ flows: [flow] }), /每个分支必须各有一条连线/);

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

test('extraction moves a complete branch group and copies with project-unique node identifiers', () => {
  const initial: GraphDefinition = { flows: [example()] };
  initial.flows[0]!.nodes.find(({ id }) => id === 'check')!.position = { x: 230, y: 40 };
  const input = {
    expectedRevision: 2,
    flowId: 'review',
    nodeIds: ['second', 'check', 'join', 'first'],
    name: 'Check both branches',
    mode: 'REPLACE' as const,
  };
  const replaced = extractGraphFlow(initial, input);
  const [parent, child] = replaced.definition.flows;
  assert.deepEqual(replaced.preview.entryNodeIds, ['check']);
  assert.deepEqual(replaced.preview.exitNodeIds, ['join']);
  assert.equal(replaced.preview.createdFlowId, child!.id);
  assert.deepEqual(
    orderedFlowNodes(parent!).map(({ type }) => type),
    ['START', 'FLOW_CALL', 'END'],
  );
  const replacement = parent!.nodes.find(({ type }) => type === 'FLOW_CALL')!;
  assert.equal(replacement.flowId, child!.id);
  assert.deepEqual(replacement.position, { x: 230, y: 40 });
  assert.ok(child!.nodes.every(({ position }) => !position));
  assert.deepEqual(
    child!.edges.filter(({ from }) => from === 'check'),
    [
      { from: 'check', to: 'first', when: 'TRUE' },
      { from: 'check', to: 'second', when: 'FALSE' },
    ],
  );
  assert.deepEqual(extractGraphFlow(initial, input), replaced);

  const copied = extractGraphFlow(initial, { ...input, mode: 'COPY' });
  assert.deepEqual(copied.definition.flows[0], initial.flows[0]);
  const originalIds = new Set(initial.flows[0]!.nodes.map(({ id }) => id));
  assert.ok(copied.definition.flows[1]!.nodes.every(({ id }) => !originalIds.has(id)));
  validateGraphDefinition(copied.definition);

  const extractedBranch = extractGraphFlow(initial, { ...input, nodeIds: ['second'] });
  const call = extractedBranch.definition.flows[0]!.nodes.find(({ type }) => type === 'FLOW_CALL')!;
  assert.deepEqual(
    extractedBranch.definition.flows[0]!.edges.find(({ to }) => to === call.id),
    { from: 'check', to: call.id, when: 'FALSE' },
  );
  assert.throws(() => extractGraphFlow(initial, { ...input, nodeIds: ['start'] }), /中间节点/);
  assert.throws(
    () => extractGraphFlow(initial, { ...input, nodeIds: ['check', 'first'] }),
    /完整选择/,
  );
});

test('execution graph draft accepts bounded integer canvas coordinates', () => {
  const fixture = example();
  const validate = () =>
    validateSync(
      plainToInstance(SaveGraphDraftDto, { expectedRevision: 1, definition: { flows: [fixture] } }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
  fixture.nodes[0]!.position = { x: 0, y: 30000 };
  assert.deepEqual(validate(), []);
  fixture.nodes[0]!.position = { x: 1.5, y: 30001 };
  assert.notEqual(validate().length, 0);
});
