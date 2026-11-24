import type { Selectable } from 'kysely';
import type { ArtifactsTable } from '../../core/database/schema';
import type { ArtifactPhysical } from '../artifacts/artifact-physical.service';
import type { NamedArtifactDefinition } from '../pipelines/pipeline.types';
import { unversionedArtifactCommit } from './graph-workspace';

export function graphArtifactPortId(declaration: { id?: string; name: string }) {
  return declaration.id ?? declaration.name;
}

export function graphArtifactDefinitions(
  declarations: (NamedArtifactDefinition & { id?: string; referenceName?: string })[],
): NamedArtifactDefinition[] {
  return declarations.map((declaration) => ({
    name: graphArtifactPortId(declaration),
    type: declaration.type,
    path: declaration.path,
    collection: declaration.collection,
    excludePaths: declaration.excludePaths,
    imageReference: declaration.imageReference,
    required: declaration.required,
    persist: declaration.persist,
    composeFilePath: declaration.composeFilePath,
  }));
}

export type GraphArtifactRow = Pick<
  Selectable<ArtifactsTable>,
  | 'id'
  | 'logical_artifact_id'
  | 'temporary_root_id'
  | 'artifact_name'
  | 'artifact_type'
  | 'artifact_kind'
  | 'storage_type'
  | 'server_id'
  | 'source_commit'
  | 'checksum'
  | 'image_digest'
  | 'graph_run_id'
  | 'graph_node_run_id'
  | 'physical_json'
>;

export function graphArtifactInstance(row: GraphArtifactRow) {
  const physical = row.physical_json
    ? (JSON.parse(row.physical_json) as ArtifactPhysical)
    : undefined;
  return {
    instanceId: row.id,
    serverId: row.server_id,
    checksum: row.checksum,
    imageId:
      physical?.imageId ??
      (['LOCAL_IMAGE', 'REMOTE_IMAGE'].includes(row.storage_type) ? row.image_digest : null),
    digest: row.storage_type === 'REGISTRY_IMAGE' ? row.image_digest : null,
    imageReference: physical?.imageReference,
    path: physical?.path,
    location: physical?.location,
    collection: physical?.collection,
  };
}

function graphArtifactValue(row: GraphArtifactRow, name?: string) {
  return {
    artifactId: row.logical_artifact_id ?? row.id,
    name: name ?? row.artifact_name ?? 'artifact',
    type: row.artifact_kind ?? row.artifact_type,
    scope: row.temporary_root_id ? ('TEMPORARY' as const) : ('PERSISTENT' as const),
    ...(row.temporary_root_id && { rootRunId: row.temporary_root_id }),
    runId: row.graph_run_id,
    nodeRunId: row.graph_node_run_id,
    commitSha: row.source_commit === unversionedArtifactCommit ? null : row.source_commit,
    instances: [] as ReturnType<typeof graphArtifactInstance>[],
  };
}

export function graphArtifactOutputs(
  rows: readonly GraphArtifactRow[],
  declarations: readonly { id?: string; name: string }[],
) {
  const names = new Map(
    declarations.map((declaration) => [graphArtifactPortId(declaration), declaration.name]),
  );
  const byId = new Map<string, ReturnType<typeof graphArtifactValue>>();
  const named = new Map<string, ReturnType<typeof graphArtifactValue>>();
  for (const row of rows) {
    const id = row.logical_artifact_id ?? row.id;
    const port = row.artifact_name ?? 'artifact';
    const existing = byId.get(id);
    const value = existing ?? graphArtifactValue(row, names.get(port));
    value.instances.push(graphArtifactInstance(row));
    if (!existing) {
      byId.set(id, value);
      named.set(port, value);
    }
  }
  // Legacy unnamed builds used a single aggregate outlet. The standard outlet
  // remains available alongside the explicitly plural collection.
  if (rows.length && !names.size && byId.size === 1 && !named.has('artifact'))
    named.set('artifact', byId.values().next().value!);
  return { named, artifacts: [...byId.values()] };
}
