import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';

export async function recentDeployments(
  database: Kysely<Database>,
  scope: { projectId: string } | { serverId: string },
) {
  let query = database
    .selectFrom('deployment_records as deployments')
    .innerJoin('pipeline_runs as runs', 'runs.id', 'deployments.pipeline_run_id')
    .select([
      'deployments.id as id',
      'runs.task_id as taskId',
      'runs.project_id as projectId',
      'deployments.service_id as serviceId',
      'deployments.environment_id as environmentId',
      'deployments.server_id as serverId',
      'deployments.status as status',
      'deployments.health_status as healthStatus',
      'deployments.release_version as releaseVersion',
      'deployments.started_at as startedAt',
      'deployments.finished_at as finishedAt',
    ]);
  if ('projectId' in scope) query = query.where('runs.project_id', '=', scope.projectId);
  else query = query.where('deployments.server_id', '=', scope.serverId);
  return query.orderBy('runs.created_at', 'desc').orderBy('deployments.id').limit(20).execute();
}
