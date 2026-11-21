import { sql, type Kysely, type SelectQueryBuilder } from 'kysely';
import type { Database } from '../../core/database/schema';
import { failedTaskStatuses } from '../tasks/tasks.types';

export const failedDeploymentStatuses: readonly string[] = failedTaskStatuses;
export const failedHealthStatuses = ['FAILED', 'UNKNOWN'];

type ProjectIds = SelectQueryBuilder<Database, 'projects', { id: string }>;

const summaryColumns = [
  'deployment.id as id',
  'run.task_id as taskId',
  'run.project_id as projectId',
  'deployment.service_id as serviceId',
  'deployment.environment_id as environmentId',
  'deployment.server_id as serverId',
  'deployment.status as status',
  'deployment.health_status as healthStatus',
  'deployment.release_version as releaseVersion',
  'deployment.started_at as startedAt',
  'deployment.finished_at as finishedAt',
] as const;

export interface DeploymentHistorySelection {
  serviceId?: string;
  serverIds?: readonly string[];
}

function deploymentRuns(database: Kysely<Database>) {
  return database
    .selectFrom('deployment_records as deployment')
    .innerJoin('pipeline_runs as run', 'run.id', 'deployment.pipeline_run_id');
}

export function deploymentRows(
  database: Kysely<Database>,
  projects: ProjectIds,
  environmentType?: string,
  selection?: DeploymentHistorySelection,
) {
  let query = deploymentRuns(database)
    .innerJoin('environments as environment', 'environment.id', 'deployment.environment_id')
    .where('run.project_id', 'in', projects);
  if (selection?.serviceId) query = query.where('deployment.service_id', '=', selection.serviceId);
  if (selection?.serverIds)
    query = selection.serverIds.length
      ? query.where('deployment.server_id', 'in', selection.serverIds)
      : query.where(sql<boolean>`1 = 0`);
  return environmentType
    ? query.where('environment.environment_type', '=', environmentType)
    : query;
}

export function latestDeploymentTargets(
  database: Kysely<Database>,
  projects: ProjectIds,
  options: DeploymentHistorySelection & {
    environmentType?: string;
    activeServersOnly?: boolean;
    byActualTarget?: boolean;
  } = {},
) {
  let query = deploymentRows(database, projects, options.environmentType, options).where(
    'deployment.server_id',
    'is not',
    null,
  );
  if (options.activeServersOnly) {
    query = query.where(
      'deployment.server_id',
      'in',
      database.selectFrom('servers').select('id').where('is_active', '=', 1),
    );
  }
  return query
    .select([
      'run.project_id as projectId',
      'deployment.service_id as serviceId',
      'deployment.status as status',
      'deployment.health_status as healthStatus',
    ])
    .select((eb) =>
      eb.fn
        .agg<number>('row_number', [])
        .over((window) =>
          window
            .partitionBy([
              'run.project_id',
              'deployment.service_id',
              ...(options.byActualTarget ? [] : ['deployment.environment_id' as const]),
              'deployment.server_id',
              'deployment.release_scope_key',
            ])
            .orderBy(eb.fn.coalesce('deployment.started_at', 'run.created_at'), 'desc')
            .orderBy('run.created_at', 'desc')
            .orderBy('deployment.id', 'desc'),
        )
        .as('targetRank'),
    );
}

export async function serviceDeploymentCounts(database: Kysely<Database>, projects: ProjectIds) {
  const latest = latestDeploymentTargets(database, projects, { activeServersOnly: true });
  const health = database
    .selectFrom(latest.as('latest'))
    .where('targetRank', '=', 1)
    .groupBy('serviceId')
    .select('serviceId')
    .select((eb) => [
      eb.fn
        .countAll<number>()
        .filterWhere(
          eb.or([
            eb('status', 'in', failedDeploymentStatuses),
            eb('healthStatus', 'in', failedHealthStatuses),
          ]),
        )
        .as('abnormal'),
      eb.fn
        .countAll<number>()
        .filterWhere('status', '=', 'SUCCESS')
        .filterWhere('healthStatus', '=', 'HEALTHY')
        .as('healthy'),
    ]);
  const counts = await database
    .selectFrom('services')
    .leftJoin(health.as('health'), 'health.serviceId', 'services.id')
    .where('services.project_id', 'in', projects)
    .select(({ fn }) => [
      fn.countAll<number>().as('total'),
      fn.countAll<number>().filterWhere('health.abnormal', '>', 0).as('abnormal'),
      fn
        .countAll<number>()
        .filterWhere('health.healthy', '>', 0)
        .filterWhere('health.abnormal', '=', 0)
        .as('running'),
    ])
    .executeTakeFirstOrThrow();
  return {
    total: Number(counts.total),
    running: Number(counts.running),
    abnormal: Number(counts.abnormal),
  };
}

export function workspaceRecentDeployments(
  database: Kysely<Database>,
  projects: ProjectIds,
  limit: number,
) {
  return deploymentRows(database, projects)
    .innerJoin('projects as project', 'project.id', 'run.project_id')
    .innerJoin('services as service', 'service.id', 'deployment.service_id')
    .innerJoin('task_targets as target', 'target.id', 'deployment.task_target_id')
    .leftJoin('servers as server', 'server.id', 'deployment.server_id')
    .select(summaryColumns)
    .select([
      'project.name as projectName',
      'service.name as serviceName',
      'environment.name as environmentName',
      'run.created_at as createdAt',
    ])
    .select(({ fn }) => fn.coalesce('server.name', 'target.server_name_snapshot').as('serverName'))
    .orderBy(({ fn }) => fn.coalesce('deployment.started_at', 'run.created_at'), 'desc')
    .orderBy('run.created_at', 'desc')
    .orderBy('deployment.id', 'desc')
    .limit(limit)
    .execute();
}

export async function recentDeployments(
  database: Kysely<Database>,
  scope: { projectId: string; serviceId?: string; environmentId?: string } | { serverId: string },
  limit = 20,
) {
  let query = deploymentRuns(database).select(summaryColumns);
  if ('projectId' in scope) {
    query = query.where('run.project_id', '=', scope.projectId);
    if (scope.serviceId) query = query.where('deployment.service_id', '=', scope.serviceId);
    if (scope.environmentId)
      query = query.where('deployment.environment_id', '=', scope.environmentId);
  } else query = query.where('deployment.server_id', '=', scope.serverId);
  return query.orderBy('run.created_at', 'desc').orderBy('deployment.id').limit(limit).execute();
}
