import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';

export interface ArtifactSource {
  repositoryId: string;
  commitSha: string;
  ref?: string;
  subject?: string;
  workspace?: { runId: string; nodeRunId: string };
  path?: string;
}

export function artifactSourceRef(source: { branch?: string; tag?: string; commitSha: string }) {
  if (source.tag) return 'refs/tags/' + source.tag;
  if (source.branch) return 'refs/heads/' + source.branch;
  return source.commitSha;
}

export async function readArtifactSources(db: Kysely<Database>, ids: readonly string[]) {
  const result = new Map<string, ArtifactSource[]>();
  if (!ids.length) return result;
  const rows = await db
    .selectFrom('artifacts')
    .leftJoin('artifact_sources as origin', 'origin.artifact_id', 'artifacts.id')
    .select([
      'artifacts.id',
      'origin.repository_id',
      'origin.commit_sha',
      'origin.git_ref',
      'origin.commit_subject',
      'origin.workspace_run_id',
      'origin.workspace_node_run_id',
      'origin.path',
    ])
    .where('artifacts.id', 'in', ids)
    .where('artifacts.source_manifest', '=', 1)
    .orderBy('origin.position')
    .execute();
  for (const row of rows) {
    let sources = result.get(row.id);
    if (!sources) result.set(row.id, (sources = []));
    if (row.repository_id && row.commit_sha)
      sources.push({
        repositoryId: row.repository_id,
        commitSha: row.commit_sha,
        ref: row.git_ref ?? undefined,
        subject: row.commit_subject ?? undefined,
        workspace:
          row.workspace_run_id && row.workspace_node_run_id
            ? { runId: row.workspace_run_id, nodeRunId: row.workspace_node_run_id }
            : undefined,
        path: row.path ?? undefined,
      });
  }
  return result;
}
