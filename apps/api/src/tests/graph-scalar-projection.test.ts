import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphScalarProjection } from '../modules/execution-graphs/graph-scalar-projection';
import { graphConditionOutput } from '../modules/execution-graphs/graph-run-lifecycle';
import { type GraphNode } from '../modules/execution-graphs/execution-graph-definition';

const source = { kind: 'OUTPUT', nodeId: 'source', fieldId: 'value' } as const;

test('projection selects exactly one image and limits paths to the actual execution workspace', () => {
  const instances = [
    { serverId: 'a', imageId: 'first', path: '/verified/a', location: 'SERVER_PATH' },
    { serverId: 'b', imageId: 'second', path: '/verified/b', location: 'SERVER_PATH' },
  ];
  const image = { kind: 'PROJECT_VALUE', source, projection: 'IMAGE_ID' } as const;
  assert.equal(graphScalarProjection(image, { instances }, undefined), undefined);
  assert.equal(
    graphScalarProjection({ ...image, serverId: 'b' }, { instances }, undefined),
    'second',
  );
  assert.equal(graphScalarProjection(image, { instances }, undefined, 'a'), 'first');
  const directory = { ...image, projection: 'ARTIFACT_PATH' } as const;
  assert.equal(graphScalarProjection(directory, { instances }, undefined, 'a'), '/verified/a');
  assert.equal(
    graphScalarProjection({ ...directory, serverId: 'b' }, { instances }, undefined, 'a'),
    undefined,
  );
  const checkout = { ...image, projection: 'WORKSPACE_PATH' } as const;
  const workspace = { nodeRunId: 'checkout-run', runId: 'root-run' };
  assert.equal(graphScalarProjection(checkout, workspace, workspace), '/workspace/repo');
  assert.equal(
    graphScalarProjection(checkout, workspace, { ...workspace, runId: 'other' }),
    undefined,
  );
  assert.equal(graphScalarProjection(checkout, workspace, workspace, 'a'), undefined);
});

test('a switch branch identifier survives reordering its matching values', () => {
  const first: GraphNode = {
    id: 'switch',
    name: '分流',
    type: 'SWITCH',
    switch: { cases: ['alpha', 'beta'] },
  };
  const second: GraphNode = { ...first, switch: { cases: ['beta', 'alpha'] } };
  const original = graphConditionOutput(first, 'CASE:0');
  assert.equal(graphConditionOutput(second, 'CASE:1').branchId, original.branchId);
  assert.notEqual(graphConditionOutput(first, 'CASE:1').branchId, original.branchId);
  assert.deepEqual(graphConditionOutput(first, 'DEFAULT'), {
    matched: 'DEFAULT',
    branchId: 'DEFAULT',
  });
});
