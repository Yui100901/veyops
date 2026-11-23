const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');

const root = resolve(__dirname, '../..');
const createWebRequire = createRequire(join(root, 'apps/web/package.json'));
const loadViteDependency = createRequire(createWebRequire.resolve('vite'));
const { buildSync } = loadViteDependency('esbuild');
const { compileCanvas } = require(
  join(root, 'apps/api/dist/modules/execution-graphs/execution-graph-canvas.js'),
);
const { outputFiles } = buildSync({
  stdin: {
    contents: `
      export { applyGraphPreset, graphTemplates, makeNode } from './graph-presets';
      export { effectiveNodeType, isReleaseNode } from './execution-graph-definition';
    `,
    resolveDir: join(root, 'apps/web/src/pages'),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const moduleFromBundle = { exports: {} };
Function('module', 'exports', outputFiles[0].text)(moduleFromBundle, moduleFromBundle.exports);
const { applyGraphPreset, graphTemplates, makeNode, effectiveNodeType, isReleaseNode } =
  moduleFromBundle.exports;

const project = { repositories: [] };

function prepareForPublication(nodes) {
  for (const node of nodes) {
    if (effectiveNodeType(node) === 'SHELL' && !node.shell.command)
      node.shell.command = 'printf "fixture\\n"';
    if (effectiveNodeType(node) === 'BUILD') node.build.buildCommand = 'printf "fixture\\n"';
    if (isReleaseNode(node)) node.deploy.deployPath = '/tmp/veyops-preset-fixture';
  }
}

let count = 0;
for (const preset of graphTemplates) {
  for (const variant of ['FILE', 'DIRECTORY', 'DOCKER_IMAGE']) {
    const start = makeNode('START', project);
    const end = makeNode('END', project);
    const peer = makeNode('START', project);
    const canvas = {
      nodes: [start, end, peer],
      edges: [
        { from: start.id, to: end.id },
        { from: peer.id, to: end.id },
      ],
      templates: [],
      endpoints: [
        { startId: start.id, endId: end.id },
        { startId: peer.id, endId: end.id },
      ],
    };
    const latest = preset.name === '仅部署';
    const next = applyGraphPreset(canvas, start, preset.nodes, project, variant, latest);
    const active = next.endpoints[0];
    const startDef = next.nodes.find(({ id }) => id === start.id);
    assert.notEqual(active.endId, end.id, 'Required new results must not affect a shared end');
    assert.equal(next.endpoints[1].endId, end.id);
    assert.equal(
      next.nodes.find(({ id }) => id === end.id),
      end,
    );
    const build = next.nodes.find((node) => effectiveNodeType(node) === 'BUILD');
    const checkout = next.nodes.find((node) => effectiveNodeType(node) === 'CHECKOUT');
    const deploy = next.nodes.find(isReleaseNode);
    if (checkout)
      assert.equal(startDef.inputs.find(({ id }) => id === 'gitVersion').required, false);
    if (build) {
      assert.equal(build.build.buildLocation, undefined);
      assert.deepEqual(active.inputBindings[build.id].workspace, {
        kind: 'OUTPUT',
        nodeId: checkout.id,
        fieldId: 'workspace',
      });
      assert.equal(build.build.artifacts[0].id, 'primaryArtifact');
      assert.equal(build.build.artifacts[0].type, variant);
      assert.equal(active.outputBindings.buildArtifact.fieldId, 'primaryArtifact');
      if (deploy) {
        assert.equal(active.inputBindings[deploy.id].artifact.fieldId, 'primaryArtifact');
        assert.notEqual(
          active.inputBindings[build.id].targets.fieldId,
          active.inputBindings[deploy.id].targets.fieldId,
        );
        assert.deepEqual(
          active.inputBindings[build.id].service,
          active.inputBindings[deploy.id].service,
        );
      }
    } else if (deploy) {
      const field = active.inputBindings[deploy.id].artifact.fieldId;
      const artifact = startDef.inputs.find(({ id }) => id === field);
      assert.equal(Boolean(artifact.multiple), false);
      assert.equal(artifact.selection, latest ? 'LATEST_COMPATIBLE' : undefined);
    }
    prepareForPublication(next.nodes);
    const published = compileCanvas(next, true);
    assert.equal(published.flows.length, 2);
    const flow = published.flows.find(({ id }) => id === start.id);
    assert.deepEqual(flow.nodes.slice(1, -1).map(effectiveNodeType), preset.nodes);
    count++;
  }
}

// An existing custom field can share a name or ID with a preset. References to it
// remain bound while the inserted nodes use the correct typed ports.
const start = makeNode('START', project);
const end = makeNode('END', project);
const sibling = makeNode('START', project);
const sameName = makeNode('CHECKOUT', project);
const existingInput = { id: 'service', name: '已有服务', type: 'SERVICE', required: true };
start.inputs = [
  existingInput,
  { id: 'gitVersion', name: '版本说明', type: 'TEXT', required: false },
];
end.outputs = [{ id: 'buildArtifact', name: '原结果', type: 'TEXT', required: false }];
sibling.inputs = [{ id: 'repository', name: '仓库', type: 'REPOSITORY', required: true }];
const existingOutput = { kind: 'INPUT', fieldId: 'gitVersion', onMissing: 'OMIT' };
const existingSource = { kind: 'INPUT', fieldId: 'repository' };
const siblingEnd = makeNode('END', project);
const original = {
  nodes: [start, end, sibling, sameName, siblingEnd],
  edges: [
    { from: start.id, to: end.id },
    { from: sibling.id, to: sameName.id },
    { from: sameName.id, to: siblingEnd.id },
  ],
  templates: [],
  endpoints: [
    { startId: start.id, endId: end.id, outputBindings: { buildArtifact: existingOutput } },
    {
      startId: sibling.id,
      endId: siblingEnd.id,
      inputBindings: { [sameName.id]: { repository: existingSource } },
    },
  ],
};
const topology = graphTemplates.find(({ name }) => name === '构建并部署');
const next = applyGraphPreset(original, start, topology.nodes, project, 'DIRECTORY');
const build = next.nodes.find((node) => effectiveNodeType(node) === 'BUILD');
const checkout = next.nodes.find(
  (node) => effectiveNodeType(node) === 'CHECKOUT' && node.id !== sameName.id,
);
assert.equal(checkout.name, sameName.name);
assert.equal(next.endpoints[0].inputBindings[build.id].workspace.nodeId, checkout.id);
assert.equal(next.endpoints[0].inputBindings[build.id].service.fieldId, existingInput.id);
assert.notEqual(next.endpoints[0].inputBindings[checkout.id].version.fieldId, 'gitVersion');
assert.deepEqual(next.endpoints[0].outputBindings.buildArtifact, existingOutput);
assert.deepEqual(next.endpoints[1].inputBindings[sameName.id].repository, existingSource);
prepareForPublication(next.nodes);
compileCanvas(next, true);
console.log(
  `Compiled ${count} preset combinations and verified existing bindings survive insertion.`,
);
