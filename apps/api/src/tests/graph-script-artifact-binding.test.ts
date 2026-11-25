import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasCatalog, compileCanvas } from '../modules/execution-graphs/execution-graph-canvas';
import type {
  GraphArtifactDeclaration,
  GraphCanvas,
} from '../modules/execution-graphs/execution-graph-definition';
import { GraphCompileError } from '../modules/execution-graphs/graph-fields';
import { inspectNodeInputs } from '../modules/execution-graphs/graph-run-bindings';

const directory = {
  id: 'snapshot',
  name: '工作目录快照',
  type: 'DIRECTORY',
  path: 'output',
} as const;
const file = { id: 'file', name: '独立文件', type: 'FILE', path: 'output.txt' } as const;
const artifactId = 'a3d7b94a-2862-499e-b47f-7e2af06d8d72';
const source = (fieldId: string = directory.id) => ({
  kind: 'OUTPUT' as const,
  nodeId: 'produce',
  fieldId,
});

function graph(
  contract?: 'PRESET',
  artifacts: GraphArtifactDeclaration[] = [directory, file],
): GraphCanvas {
  return {
    nodes: [
      { id: 'start', type: 'START', name: '开始', contract },
      {
        id: 'produce',
        type: 'FUNCTION',
        operation: 'SHELL',
        name: '生成产物',
        shell: { location: 'MANAGER', command: 'true', artifacts },
      },
      {
        id: 'check',
        type: 'FUNCTION',
        operation: 'CHECK',
        name: '读取报告',
        shell: { location: 'MANAGER', command: 'true', artifactPath: 'reports/' },
      },
      {
        id: 'shell',
        type: 'FUNCTION',
        operation: 'SHELL',
        name: '读取快照',
        shell: { location: 'MANAGER', command: 'true', artifactPath: '.' },
      },
      { id: 'end', type: 'END', name: '结束' },
    ],
    edges: [
      { from: 'start', to: 'produce' },
      { from: 'produce', to: 'check' },
      { from: 'check', to: 'shell' },
      { from: 'shell', to: 'end' },
    ],
    endpoints: [{ startId: 'start', endId: 'end', inputBindings: {} }],
    templates: [],
  };
}

test('checks and scripts infer a single upstream directory in preset and custom flows', () => {
  for (const contract of ['PRESET', undefined] as const) {
    const canvas = graph(contract);
    const flow = compileCanvas(canvas, true).flows[0]!;
    for (const id of ['check', 'shell']) {
      const catalog = canvasCatalog(canvas, 'start', id).start;
      const result = flow.compiled!.nodes[id]!;
      assert.deepEqual(result.inputBindings.artifact, source());
      assert.deepEqual(result.dependencies, [
        { nodeId: 'produce', fieldId: 'snapshot', consumerFieldId: 'artifact' },
      ]);
      assert.deepEqual(catalog?.nodes[id]?.automaticInputBindings.artifact, source());
      assert.equal(canvas.endpoints[0]!.inputBindings?.[id], undefined);
      const inputs = inspectNodeInputs(
        flow,
        flow.nodes.find((node) => node.id === id)!,
        {
          parameters: {},
          context: {},
          outputs: new Map([['produce', { snapshot: { artifactId } }]]),
        },
      );
      assert.deepEqual(inputs.values.artifact, { artifactId });
    }
  }
});

test('multiple compatible directories need an explicit binding', () => {
  const canvas = graph('PRESET', [directory, { ...directory, id: 'alternate', path: 'other' }]);
  assert.throws(
    () => compileCanvas(canvas, true),
    (error) =>
      error instanceof GraphCompileError &&
      error.issues.some(
        ({ nodeId, fieldId, message }) =>
          nodeId === 'check' && fieldId === 'artifact' && message.includes('多个兼容'),
      ),
  );
  assert.equal(
    canvasCatalog(canvas, 'start', 'check').start?.nodes.check?.automaticInputBindings.artifact,
    undefined,
  );
  canvas.endpoints[0]!.inputBindings = {
    check: { artifact: source('alternate') },
    shell: { artifact: source() },
  };
  assert.deepEqual(
    compileCanvas(canvas, true).flows[0]!.compiled!.nodes.check!.inputBindings.artifact,
    source('alternate'),
  );
});

test('file artifacts can still be selected explicitly for entire-artifact reads', () => {
  const canvas = graph(undefined, [file]);
  assert.throws(() => compileCanvas(canvas, true), /缺少必填来源/);
  canvas.nodes.find(({ id }) => id === 'check')!.shell!.artifactPath = '.';
  canvas.endpoints[0]!.inputBindings = {
    check: { artifact: source('file') },
    shell: { artifact: source('file') },
  };
  assert.deepEqual(
    compileCanvas(canvas, true).flows[0]!.compiled!.nodes.shell!.inputBindings.artifact,
    source('file'),
  );
});

test('an inferred directory must cover every branch reaching its consumer', () => {
  const canvas = graph();
  canvas.nodes[0]!.inputs = [{ id: 'side', name: '分支', type: 'TEXT' }];
  canvas.nodes.push({
    id: 'branch',
    type: 'CONDITION',
    name: '分支判断',
    condition: { key: 'input', value: 'build' },
  });
  canvas.edges.splice(
    0,
    1,
    { from: 'start', to: 'branch' },
    { from: 'branch', to: 'produce', when: 'TRUE' },
    { from: 'branch', to: 'check', when: 'FALSE' },
  );
  canvas.endpoints[0]!.inputBindings = {
    branch: { value: { kind: 'INPUT', fieldId: 'side' } },
  };
  assert.throws(() => compileCanvas(canvas, true), /无法覆盖每条到达路径/);
});
