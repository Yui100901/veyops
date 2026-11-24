const assert = require('node:assert/strict');
require('reflect-metadata');
const {
  compileCanvas,
  canvasIssues,
} = require('../../apps/api/dist/modules/execution-graphs/execution-graph-canvas');
const {
  expandGraphTemplate,
  graphFlowTemplates,
} = require('../../apps/api/dist/modules/execution-graphs/graph-flow-templates');

const variants = ['FILE', 'DIRECTORY', 'DOCKER_IMAGE'];
const chains = {
  MINIMAL_CI_CD: ['CHECKOUT', 'BUILD', 'DEPLOY_ARTIFACT'],
  CI_BUILD: ['CHECKOUT', 'CHECK', 'BUILD'],
  CD_DEPLOY: ['APPROVAL', 'DEPLOY_ARTIFACT', 'HEALTH_CHECK'],
};
assert.deepEqual(
  graphFlowTemplates.map(({ id }) => id),
  Object.keys(chains),
);

function configureFixture(canvas, variant) {
  for (const node of canvas.nodes) {
    if (node.operation === 'CHECK') node.shell.command = 'printf "test fixture\n"';
    if (node.operation === 'BUILD' && variant !== 'DOCKER_IMAGE') {
      node.build.buildCommand = 'printf "build fixture\n"';
      node.build.artifacts[0].path = variant === 'FILE' ? 'dist/fixture.tar.gz' : 'dist';
      if (variant === 'DIRECTORY') node.build.artifacts[0].collection = 'PATH';
    }
    if (node.operation === 'DEPLOY_ARTIFACT') node.deploy.deployPath = '/tmp/veyops-preset-fixture';
    if (node.operation === 'HEALTH_CHECK') node.healthCheck.command = 'test -e current';
  }
}

const canvas = {
  nodes: [
    { id: 'existing-start', type: 'START', name: '已有草稿' },
    { id: 'existing-end', type: 'END', name: '结束' },
  ],
  edges: [{ from: 'existing-start', to: 'existing-end' }],
  endpoints: [{ startId: 'existing-start', endId: 'existing-end' }],
  templates: [],
};
for (const { id, steps, artifactTypes } of graphFlowTemplates) {
  assert.deepEqual(artifactTypes, variants);
  for (const variant of variants) {
    const { canvas: fragment, startId } = expandGraphTemplate(id, variant);
    const [start, ...actions] = fragment.nodes;
    const end = actions.pop();
    const [endpoint] = fragment.endpoints;
    assert.equal(start.id, startId);
    assert.equal(start.type, 'START');
    assert.equal(end.type, 'END');
    assert.equal(endpoint.endId, end.id);
    assert.equal(fragment.edges.length, fragment.nodes.length - 1);
    assert.deepEqual(
      actions.map(({ operation }) => operation),
      chains[id],
    );
    assert.deepEqual(['开始', ...actions.map(({ name }) => name), end.name], steps);
    assert.ok(actions.every(({ type }) => type === 'FUNCTION'));
    assert.ok(canvasIssues(fragment).some(({ fieldId }) => fieldId));
    const checkout = actions.find(({ operation }) => operation === 'CHECKOUT');
    const check = actions.find(({ operation }) => operation === 'CHECK');
    const build = actions.find(({ operation }) => operation === 'BUILD');
    const deploy = actions.find(({ operation }) => operation === 'DEPLOY_ARTIFACT');
    const approval = actions.find(({ operation }) => operation === 'APPROVAL');
    const health = actions.find(({ operation }) => operation === 'HEALTH_CHECK');
    const from = (node, fieldId) => ({ kind: 'OUTPUT', nodeId: node.id, fieldId });
    const input = (fieldId) => ({ kind: 'INPUT', fieldId });
    configureFixture(fragment, variant);
    const { nodes: compiled } = compileCanvas(fragment, true).flows[0].compiled;
    if (checkout) {
      assert.equal(start.inputs.find(({ id }) => id === 'gitVersion').required, false);
      assert.equal(endpoint.inputBindings[checkout.id], undefined);
      assert.deepEqual(compiled[checkout.id].inputBindings.version, {
        ...input('gitVersion'),
        onMissing: 'REPOSITORY_DEFAULT',
      });
    }
    if (build) {
      assert.equal(build.build.buildLocation, undefined);
      assert.deepEqual(endpoint.inputBindings[build.id].workspace, from(checkout, 'workspace'));
      assert.deepEqual(endpoint.inputBindings[build.id].source, from(checkout, 'source'));
      assert.equal(build.build.artifacts[0].id, 'primaryArtifact');
      assert.equal(build.build.artifacts[0].type, variant);
      assert.equal(build.build.artifacts[0].persist, true);
      assert.deepEqual(endpoint.outputBindings.buildArtifact, from(build, 'primaryArtifact'));
    }
    if (check) {
      assert.deepEqual(endpoint.inputBindings[check.id].workspace, from(checkout, 'workspace'));
      assert.deepEqual(endpoint.outputBindings.report, from(check, 'report'));
    }
    if (deploy) {
      assert.equal(deploy.deploy.method, variant === 'DOCKER_IMAGE' ? 'COMPOSE' : 'FILE');
      assert.deepEqual(compiled[deploy.id].inputBindings.targets, input('releaseTargets'));
      assert.deepEqual(compiled[deploy.id].inputBindings.service, input('service'));
      assert.deepEqual(
        endpoint.inputBindings[deploy.id].artifact,
        build ? from(build, 'primaryArtifact') : input('artifact'),
      );
      assert.deepEqual(endpoint.outputBindings.release, from(health ?? deploy, 'release'));
    }
    if (approval) assert.equal(approval.approval.releaseNodeId, deploy.id);
    if (health) {
      assert.equal(health.healthCheck.requireHealthy, true);
      assert.deepEqual(endpoint.inputBindings[health.id].release, from(deploy, 'release'));
      assert.deepEqual(endpoint.outputBindings.healthStatus, from(health, 'status'));
    }

    if (deploy && variant === 'DOCKER_IMAGE') {
      const wrongDelivery = structuredClone(fragment);
      const wrong = wrongDelivery.nodes.find(({ id }) => id === deploy.id);
      wrong.deploy = { method: 'FILE', deployPath: wrong.deploy.deployPath };
      assert.ok(
        canvasIssues(wrongDelivery).some(
          ({ nodeId, fieldId }) => nodeId === deploy.id && fieldId === 'artifact',
        ),
      );
    }
    canvas.nodes.push(...fragment.nodes);
    canvas.edges.push(...fragment.edges);
    canvas.endpoints.push(...fragment.endpoints);
    assert.equal(compileCanvas(canvas, true).flows.length, canvas.endpoints.length);
  }
}
assert.equal(new Set(canvas.nodes.map(({ id }) => id)).size, canvas.nodes.length);
assert.equal(canvas.endpoints[0].startId, 'existing-start');
console.log(
  `Compiled ${canvas.endpoints.length - 1} template and artefact combinations on a shared canvas`,
);
