import { ConflictException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { deploymentScopeKey, type ReleaseScope } from '../deployments/deployment-scope';
export { graphComposeProject } from '../deployments/deployment-scope';

export async function graphRollbackBaselines(
  db: Kysely<Database>,
  scope: ReleaseScope,
  targets: readonly string[],
  artifactIds?: readonly string[],
  expected?: Record<string, string>,
) {
  if (expected && Object.keys(expected).length !== targets.length)
    throw new ConflictException('回滚目标必须对应全部固定服务器');
  const rows = await db
    .selectFrom('deployment_records')
    .select([
      'id',
      'server_id',
      'artifact_id',
      'status',
      'activated_at',
      'health_status',
      'release_snapshot_json',
    ])
    .where(
      'release_scope_key',
      'in',
      targets.map((id) => deploymentScopeKey(scope, id)),
    )
    .where((eb) => eb.or([eb('activated_at', 'is not', null), eb('status', '=', 'SUCCESS')]))
    .orderBy(
      (eb) => eb.fn.coalesce('activated_at', 'started_at'),
      (order) => order.desc().nullsLast(),
    )
    .orderBy('id', 'desc')
    .execute();
  return Object.fromEntries(
    targets.map((serverId) => {
      const actual = rows.find((row) => row.server_id === serverId);
      if (
        !actual ||
        actual.status !== 'SUCCESS' ||
        !actual.release_snapshot_json ||
        (expected && (!Object.hasOwn(expected, serverId) || expected[serverId] !== actual.id))
      )
        throw new ConflictException('回滚前当前发布已变化或无法核对，请重新预览');
      if (
        artifactIds?.length &&
        !rows.some(
          (row) =>
            row.server_id === serverId &&
            row.id !== actual.id &&
            row.status === 'SUCCESS' &&
            row.release_snapshot_json &&
            row.activated_at !== null &&
            row.health_status !== 'FAILED' &&
            row.health_status !== 'UNKNOWN' &&
            row.artifact_id &&
            row.artifact_id !== actual.artifact_id &&
            artifactIds.includes(row.artifact_id),
        )
      )
        throw new ConflictException('回滚产物必须在同一服务、目标和部署路径中成功发布过');
      return [serverId, actual.id];
    }),
  );
}
