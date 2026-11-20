import { ConflictException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { readArtifactSources, type ArtifactSource } from '../artifacts/artifact-sources';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import type { TaskPayload } from '../tasks/tasks.types';
import type { ReviewSource } from './source-review.service';

type ReleaseScope = Pick<PipelineSnapshot, 'projectId' | 'serviceId' | 'environmentId'>;

export class SourceReviewConflict extends ConflictException {}

export function buildReviewSources(snapshot: PipelineSnapshot): ReviewSource[] {
  if (snapshot.graph) {
    const workspace = snapshot.graph.workspace;
    if (
      workspace?.repositoryId !== snapshot.definition.repositoryId ||
      workspace?.commitSha !== snapshot.commitSha
    )
      return [];
    const variableWorkspace = snapshot.graph.variables?.workspace;
    return [workspace, variableWorkspace]
      .filter((item) => item !== undefined)
      .map((item) => ({ repositoryId: item.repositoryId ?? '', commitSha: item.commitSha ?? '' }));
  }
  const checkoutNodes = snapshot.definition.nodes?.filter((node) => node.type === 'CHECKOUT');
  if (!checkoutNodes?.length)
    return [{ repositoryId: snapshot.definition.repositoryId, commitSha: snapshot.commitSha }];
  return checkoutNodes.map((node) => ({
    repositoryId: node.repositoryId ?? snapshot.definition.repositoryId,
    commitSha: snapshot.nodeSources?.[node.id]?.commitSha ?? '',
  }));
}

export async function releaseArtifactSources(
  db: Kysely<Database>,
  scope: ReleaseScope,
  artifactIds: readonly string[],
): Promise<ArtifactSource[]> {
  const ids = [...new Set(artifactIds)];
  if (!ids.length) throw new SourceReviewConflict('没有可供代码审核核对的发布产物');
  const rows = await db
    .selectFrom('artifacts as artifact')
    .innerJoin('pipeline_runs as build', 'build.id', 'artifact.pipeline_run_id')
    .innerJoin('tasks as task', 'task.id', 'build.task_id')
    .select(['artifact.id', 'artifact.source_commit', 'build.commit_sha', 'task.payload_json'])
    .where('artifact.id', 'in', ids)
    .where('artifact.project_id', '=', scope.projectId)
    .where('artifact.service_id', '=', scope.serviceId)
    .where('build.project_id', '=', scope.projectId)
    .where('build.service_id', '=', scope.serviceId)
    .where('build.environment_id', '=', scope.environmentId)
    .orderBy('artifact.id')
    .execute();
  if (rows.length !== ids.length)
    throw new SourceReviewConflict('发布产物不属于当前项目、服务或环境');
  const descriptors = await readArtifactSources(db, ids);
  const sources = rows.flatMap((row) => {
    const persisted = descriptors.get(row.id);
    if (persisted?.length) return persisted;
    if (persisted === undefined && row.source_commit === row.commit_sha) {
      const build = (JSON.parse(row.payload_json) as TaskPayload).pipeline;
      if (build && build.mode !== 'DEPLOY_ARTIFACT' && build.commitSha === row.commit_sha) {
        // Older builds can prove scope from one checkout recorded in the original task.
        const legacy = buildReviewSources(build);
        const origin = legacy[0];
        if (
          origin?.repositoryId &&
          origin.commitSha === row.source_commit &&
          legacy.every(
            ({ repositoryId, commitSha }) =>
              repositoryId === origin.repositoryId && commitSha === origin.commitSha,
          )
        )
          return [origin];
      }
    }
    throw new SourceReviewConflict(`产物 ${row.id} 缺少可核验的仓库与 Git 提交来源`);
  });
  return [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()];
}
