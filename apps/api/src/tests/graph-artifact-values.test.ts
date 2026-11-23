import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  graphArtifactDefinitions,
  graphArtifactOutputs,
  type GraphArtifactRow,
} from '../modules/execution-graphs/graph-artifact-values';
import { artifactBindingRefs } from '../modules/execution-graphs/graph-run-bindings';

function artifactRows(root?: string): GraphArtifactRow[] {
  const logicalId = randomUUID();
  const runId = randomUUID();
  const nodeRunId = randomUUID();
  return Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(),
    logical_artifact_id: logicalId,
    temporary_root_id: root ?? null,
    artifact_name: 'directory',
    artifact_type: 'FILE',
    artifact_kind: 'DIRECTORY',
    storage_type: 'REMOTE_FILE',
    server_id: randomUUID(),
    source_commit: 'a'.repeat(40),
    checksum: String(index).repeat(64),
    image_digest: null,
    graph_run_id: runId,
    graph_node_run_id: nodeRunId,
    physical_json: JSON.stringify({
      location: 'SERVER_PATH',
      path: '/fixture/dist-' + index,
      ownerToken: 'private-token',
      hostKeyFingerprint: 'private-host-fingerprint',
    }),
  }));
}

test('a named artifact stays one logical value when the target count grows', () => {
  const rows = artifactRows();
  const declarations = [{ id: 'directory', name: '构建目录', type: 'DIRECTORY' as const }];
  assert.equal(graphArtifactDefinitions(declarations)[0]?.name, 'directory');
  for (const count of [1, 3]) {
    const output = graphArtifactOutputs(rows.slice(0, count), declarations);
    assert.equal(output.artifacts.length, 1);
    const directory = output.named.get('directory')!;
    assert.equal(directory.artifactId, rows[0]?.logical_artifact_id);
    assert.equal(directory.name, '构建目录');
    assert.equal(directory.type, 'DIRECTORY');
    assert.equal(directory.scope, 'PERSISTENT');
    assert.deepEqual(
      directory.instances.map(({ instanceId, serverId }) => [instanceId, serverId]),
      rows.slice(0, count).map(({ id, server_id }) => [id, server_id]),
    );
    assert.deepEqual(artifactBindingRefs(directory), [{ artifactId: directory.artifactId }]);
    assert.doesNotMatch(JSON.stringify(output), /private-token|private-host-fingerprint/);
  }
});

test('keeps actual image identities and temporary scope within logical outputs', () => {
  const root = randomUUID();
  const rows = artifactRows(root).map((row, index) => ({
    ...row,
    artifact_name: 'image',
    artifact_kind: 'DOCKER_IMAGE',
    artifact_type: 'DOCKER_IMAGE',
    storage_type: 'REMOTE_IMAGE',
    image_digest: 'sha256:' + String(index).repeat(64),
    physical_json: JSON.stringify({ location: 'DOCKER_ENGINE', imageReference: 'fixture/app' }),
  }));
  const image = graphArtifactOutputs(rows, [{ name: 'image' }]).named.get('image')!;
  assert.equal(image.rootRunId, root);
  assert.equal(image.scope, 'TEMPORARY');
  assert.deepEqual(
    image.instances.map(({ imageId }) => imageId),
    rows.map(({ image_digest }) => image_digest),
  );
  assert.deepEqual(artifactBindingRefs(image), [{ artifactId: image.artifactId, rootRunId: root }]);
  assert.throws(() => artifactBindingRefs({ ...image, rootRunId: undefined }), /无效/);
});

test('normalizes legacy per-instance lists without broadening explicit instance selection', () => {
  const [{ logical_artifact_id: artifactId, id: first }, { id: second }] = artifactRows() as [
    GraphArtifactRow,
    GraphArtifactRow,
  ];
  assert.deepEqual(
    artifactBindingRefs([
      { artifactId, instanceId: second },
      { artifactId, instanceId: first },
    ]),
    [{ artifactId, instanceIds: [first, second].sort() }],
  );
  const temp = { temporaryArtifactId: randomUUID() };
  assert.deepEqual(artifactBindingRefs([temp, temp]), [temp]);
  assert.throws(() => artifactBindingRefs({ ...temp, artifactId }), /无效/);
});
