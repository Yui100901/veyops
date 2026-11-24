import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';

export async function serviceDeliveryHeads(database: Kysely<Database>, serviceIds: string[]) {
  if (!serviceIds.length) return [];
  const base = database
    .selectFrom('deployment_records as record')
    .innerJoin('pipeline_runs as run', 'run.id', 'record.pipeline_run_id')
    .leftJoin('servers as server', 'server.id', 'record.server_id')
    .leftJoin('task_targets as target', 'target.id', 'record.task_target_id')
    .select([
      'record.id',
      'record.service_id as serviceId',
      'record.environment_id as environmentId',
      'record.server_id as serverId',
      'record.status',
      'record.health_status as healthStatus',
      'record.activated_at as activatedAt',
      'record.health_observed_at as healthObservedAt',
      'record.started_at as startedAt',
      'record.finished_at as finishedAt',
      'run.created_at as runCreatedAt',
    ])
    .select(({ fn }) => [
      fn.coalesce('server.name', 'target.server_name_snapshot').as('serverName'),
      fn.coalesce('record.release_scope_key', 'record.environment_id').as('scopeKey'),
    ])
    .where('record.server_id', 'is not', null)
    .where('record.service_id', 'in', serviceIds);
  const ranked = (current: boolean) =>
    database
      .selectFrom(base.as('heads'))
      .selectAll()
      .$if(current, (query) =>
        query.where((eb) =>
          eb.or([eb('activatedAt', 'is not', null), eb('status', '=', 'SUCCESS')]),
        ),
      )
      .select((eb) =>
        eb.fn
          .agg<number>('row_number', [])
          .over((window) =>
            window
              .partitionBy(['serviceId', 'serverId', 'scopeKey'])
              .orderBy(
                current
                  ? eb.fn.coalesce('activatedAt', 'startedAt', 'runCreatedAt')
                  : eb.fn.coalesce('startedAt', 'runCreatedAt'),
                'desc',
              )
              .orderBy('runCreatedAt', 'desc')
              .orderBy('id', 'desc'),
          )
          .as('rank'),
      );
  const latest = (active: boolean) =>
    database.selectFrom(ranked(active).as('ranked')).selectAll().where('rank', '=', 1).execute();
  const [current, attempted] = await Promise.all([latest(true), latest(false)]);
  const key = (row: (typeof attempted)[number]) =>
    JSON.stringify([row.serviceId, row.serverId, row.scopeKey]);
  const active = new Map(current.map((row) => [key(row), row]));
  const status = (row: (typeof attempted)[number]) => ({
    id: row.id,
    status: row.status,
    healthStatus: row.healthStatus,
    healthObservedAt: row.healthObservedAt,
    activatedAt: row.activatedAt,
    startedAt: row.startedAt ?? row.runCreatedAt,
    finishedAt: row.finishedAt,
  });
  return attempted
    .sort(
      (left, right) =>
        (left.serverName ?? '').localeCompare(right.serverName ?? '') ||
        left.id.localeCompare(right.id),
    )
    .map((row) => {
      const activeRecord = active.get(key(row));
      return {
        serviceId: row.serviceId,
        serverId: row.serverId!,
        serverName: row.serverName,
        environmentId: row.environmentId,
        current: activeRecord ? status(activeRecord) : null,
        latestAttempt: status(row),
      };
    });
}

export async function serviceDeliveryStatus(database: Kysely<Database>, serviceId: string) {
  const heads = await serviceDeliveryHeads(database, [serviceId]);
  const ids = [
    ...new Set(
      heads.flatMap(({ current, latestAttempt }) =>
        current ? [current.id, latestAttempt.id] : [latestAttempt.id],
      ),
    ),
  ];
  if (!ids.length) return [];
  const records = await database
    .selectFrom('deployment_records as record')
    .innerJoin('pipeline_runs as release', 'release.id', 'record.pipeline_run_id')
    .leftJoin('artifacts as artifact', 'artifact.id', 'record.artifact_id')
    .leftJoin('pipeline_runs as build', 'build.id', 'artifact.pipeline_run_id')
    .leftJoin('execution_node_runs as releaseNode', 'releaseNode.task_id', 'release.task_id')
    .leftJoin('environments as environment', 'environment.id', 'record.environment_id')
    .select([
      'record.id',
      'record.release_version as releaseVersion',
      'release.task_id as releaseTaskId',
      'releaseNode.run_id as releaseRunId',
      'releaseNode.node_id as releaseNodeId',
      'build.task_id as buildTaskId',
      'artifact.graph_run_id as buildRunId',
      'artifact.id as artifactInstanceId',
      'artifact.logical_artifact_id as artifactId',
      'artifact.artifact_name as artifactName',
      'environment.name as environmentName',
    ])
    .select(({ fn }) => fn.coalesce('artifact.source_commit', 'release.commit_sha').as('commitSha'))
    .where('record.id', 'in', ids)
    .execute();
  const instances = [
    ...new Set(
      records.flatMap(({ artifactInstanceId }) => (artifactInstanceId ? [artifactInstanceId] : [])),
    ),
  ];
  const sources = instances.length
    ? await database
        .selectFrom('artifact_sources as source')
        .leftJoin('repositories as repository', 'repository.id', 'source.repository_id')
        .select([
          'source.artifact_id as instanceId',
          'source.repository_id as repositoryId',
          'repository.name as repositoryName',
          'source.commit_sha as commitSha',
          'source.git_ref as ref',
        ])
        .where('source.artifact_id', 'in', instances)
        .orderBy('source.position')
        .execute()
    : [];
  const byRecord = new Map(records.map((record) => [record.id, record]));
  const byInstance = new Map<string, Omit<(typeof sources)[number], 'instanceId'>[]>();
  for (const { instanceId, ...source } of sources) {
    const matching = byInstance.get(instanceId);
    if (matching) matching.push(source);
    else byInstance.set(instanceId, [source]);
  }
  const enrich = (head: (typeof heads)[number]['latestAttempt']) => {
    const record = byRecord.get(head.id);
    return {
      ...head,
      ...record,
      artifactId: record?.artifactId ?? record?.artifactInstanceId,
      sources: byInstance.get(record?.artifactInstanceId ?? '') ?? [],
    };
  };
  return heads.map((head) => ({
    ...head,
    current: head.current ? enrich(head.current) : null,
    latestAttempt: enrich(head.latestAttempt),
  }));
}
