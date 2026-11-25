import { sql, type Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { redactTaskLog } from '../tasks/task-log.service';

export async function serviceDeliveryHeads(
  database: Kysely<Database>,
  serviceIds: readonly string[] | undefined,
  serverIds?: readonly string[],
) {
  if (serviceIds?.length === 0 || serverIds?.length === 0 || (!serviceIds && !serverIds)) return [];
  const records = database
    .selectFrom('deployment_records as record')
    .innerJoin('pipeline_runs as run', 'run.id', 'record.pipeline_run_id')
    .leftJoin('servers as server', 'server.id', 'record.server_id')
    .leftJoin('task_targets as target', 'target.id', 'record.task_target_id')
    .select([
      'record.id',
      'record.id as deploymentRecordId',
      'record.task_target_id as taskTargetId',
      'run.task_id as releaseTaskId',
      'record.service_id as serviceId',
      'record.environment_id as environmentId',
      'record.server_id as serverId',
      'record.status',
      'record.health_status as healthStatus',
      'record.activated_at as activatedAt',
      'record.health_observed_at as healthObservedAt',
      'record.started_at as startedAt',
      'record.finished_at as finishedAt',
      'run.created_at as queuedAt',
    ])
    .select(({ fn }) => [
      fn.coalesce('server.name', 'target.server_name_snapshot').as('serverName'),
      fn.coalesce('record.release_scope_key', 'record.environment_id').as('scopeKey'),
      'target.release_scope_key as targetScopeKey',
      'target.started_at as targetStartedAt',
      'target.error_summary as errorSummary',
    ])
    .where('record.server_id', 'is not', null)
    .$if(Boolean(serviceIds), (query) => query.where('record.service_id', 'in', serviceIds!))
    .$if(Boolean(serverIds), (query) => query.where('record.server_id', 'in', serverIds!));

  const fields = [
    'id',
    'deploymentRecordId',
    'taskTargetId',
    'releaseTaskId',
    'serviceId',
    'environmentId',
    'serverId',
    'status',
    'healthStatus',
    'activatedAt',
    'healthObservedAt',
    'startedAt',
    'finishedAt',
    'queuedAt',
    'serverName',
    'scopeKey',
    'errorSummary',
  ] as const;
  const evidence = database
    .with('records', () => records)
    // The first record is the release the target tried. Automatic restoration may add a second.
    .with('primaryRecords', (db) =>
      db
        .selectFrom('records')
        .selectAll()
        .select((eb) =>
          eb.fn
            .agg<number>('row_number', [])
            .over((window) =>
              window
                .partitionBy(['taskTargetId', 'scopeKey'])
                .orderBy(eb.fn.coalesce('startedAt', 'queuedAt'))
                .orderBy('id'),
            )
            .as('ordinal'),
        )
        .where('targetScopeKey', 'is not', null)
        .whereRef('targetScopeKey', '=', 'scopeKey'),
    )
    .with('attempts', (db) =>
      db
        .selectFrom('task_targets as target')
        .innerJoin('pipeline_runs as run', 'run.task_id', 'target.task_id')
        .innerJoin('tasks as task', 'task.id', 'target.task_id')
        .leftJoin('servers as server', 'server.id', 'target.server_id')
        .leftJoin('primaryRecords as record', (join) =>
          join
            .onRef('record.taskTargetId', '=', 'target.id')
            .onRef('record.scopeKey', '=', 'target.release_scope_key')
            .on('record.ordinal', '=', 1),
        )
        .select([
          'target.id',
          'record.deploymentRecordId',
          'target.id as taskTargetId',
          'target.task_id as releaseTaskId',
          'run.service_id as serviceId',
          'run.environment_id as environmentId',
          'target.server_id as serverId',
          'target.status',
          'record.healthStatus',
          'record.activatedAt',
          'record.healthObservedAt',
          'target.started_at as startedAt',
          'target.finished_at as finishedAt',
          'task.created_at as queuedAt',
        ])
        .select(({ fn }) => [
          fn
            .coalesce('server.name', 'target.server_name_snapshot')
            .$castTo<string | null>()
            .as('serverName'),
          'target.release_scope_key as scopeKey',
          'target.error_summary as errorSummary',
        ])
        .$if(Boolean(serviceIds), (query) => query.where('run.service_id', 'in', serviceIds!))
        .$if(Boolean(serverIds), (query) => query.where('target.server_id', 'in', serverIds!))
        .where('target.server_id', 'is not', null)
        .where('target.release_scope_key', 'is not', null)
        .where('target.started_at', 'is not', null)
        .unionAll(
          db
            .selectFrom('records')
            .select(fields)
            .where((eb) =>
              eb.or([
                eb('targetScopeKey', 'is', null),
                eb('targetStartedAt', 'is', null),
                eb('targetScopeKey', '!=', eb.ref('scopeKey')),
              ]),
            ),
        ),
    );
  const rows = await evidence
    .with('ranked', (db) =>
      db
        .selectFrom('attempts')
        .select(fields)
        .select(sql<'ATTEMPT' | 'CURRENT'>`'ATTEMPT'`.as('kind'))
        .select((eb) =>
          eb.fn
            .agg<number>('row_number', [])
            .over((window) =>
              window
                .partitionBy(['serviceId', 'serverId', 'scopeKey'])
                .orderBy(eb.fn.coalesce('startedAt', 'queuedAt'), 'desc')
                .orderBy('queuedAt', 'desc')
                .orderBy('id', 'desc'),
            )
            .as('rank'),
        )
        .unionAll(
          db
            .selectFrom('records')
            .select(fields)
            .select(sql<'ATTEMPT' | 'CURRENT'>`'CURRENT'`.as('kind'))
            .select((eb) =>
              eb.fn
                .agg<number>('row_number', [])
                .over((window) =>
                  window
                    .partitionBy(['serviceId', 'serverId', 'scopeKey'])
                    .orderBy(eb.fn.coalesce('activatedAt', 'startedAt', 'queuedAt'), 'desc')
                    .orderBy('queuedAt', 'desc')
                    .orderBy('id', 'desc'),
                )
                .as('rank'),
            )
            .where((eb) =>
              eb.or([
                eb('activatedAt', 'is not', null),
                // Legacy successful releases predate explicit activation evidence.
                eb.and([eb('targetScopeKey', 'is', null), eb('status', '=', 'SUCCESS')]),
              ]),
            ),
        ),
    )
    .selectFrom('ranked')
    .selectAll()
    .where('rank', '=', 1)
    .execute();
  type HeadRow = (typeof rows)[number];
  const key = (row: HeadRow) => JSON.stringify([row.serviceId, row.serverId, row.scopeKey]);
  const active = new Map(
    rows.filter((row) => row.kind === 'CURRENT').map((row) => [key(row), row]),
  );
  const status = (row: HeadRow) => ({
    id: row.id,
    deploymentRecordId: row.deploymentRecordId,
    taskTargetId: row.taskTargetId,
    releaseTaskId: row.releaseTaskId,
    environmentId: row.environmentId,
    status: row.status,
    healthStatus: row.healthStatus,
    healthObservedAt: row.healthObservedAt,
    activatedAt: row.activatedAt,
    startedAt: row.startedAt ?? row.queuedAt,
    finishedAt: row.finishedAt,
    phase: row.deploymentRecordId ? ('RELEASE' as const) : ('PREPARE' as const),
    errorSummary:
      row.kind === 'ATTEMPT' && row.errorSummary
        ? redactTaskLog(row.errorSummary).slice(0, 1000)
        : null,
  });
  return rows
    .filter((row) => row.kind === 'ATTEMPT')
    .sort(
      (left, right) =>
        (left.serverName ?? '').localeCompare(right.serverName ?? '') ||
        (left.scopeKey ?? '').localeCompare(right.scopeKey ?? ''),
    )
    .map((row) => {
      const activeRecord = active.get(key(row));
      return {
        serviceId: row.serviceId,
        serverId: row.serverId!,
        serverName: row.serverName,
        environmentId: row.environmentId,
        scopeKey: row.scopeKey!,
        current: activeRecord ? status(activeRecord) : null,
        latestAttempt: status(row),
      };
    });
}

export async function serviceDeliveryStatus(database: Kysely<Database>, serviceId: string) {
  const heads = await serviceDeliveryHeads(database, [serviceId]);
  return deliveryDetails(database, heads);
}

export async function deployedServicesForServers(
  database: Kysely<Database>,
  serverIds: readonly string[],
) {
  const heads = (await serviceDeliveryHeads(database, undefined, [...new Set(serverIds)])).filter(
    ({ current }) => current !== null,
  );
  if (!heads.length) return [];
  const [services, details] = await Promise.all([
    database
      .selectFrom('services as service')
      .innerJoin('projects as project', 'project.id', 'service.project_id')
      .select([
        'service.id as serviceId',
        'service.name as serviceName',
        'project.id as projectId',
        'project.name as projectName',
      ])
      .where('service.id', 'in', [...new Set(heads.map(({ serviceId }) => serviceId))])
      .where('service.archived_at', 'is', null)
      .where('project.deleted_at', 'is', null)
      .execute(),
    deliveryDetails(database, heads),
  ]);
  const byService = new Map(services.map((service) => [service.serviceId, service]));
  return details.flatMap((detail) => {
    const service = byService.get(detail.serviceId);
    return service && detail.current ? [{ ...detail, ...service, current: detail.current }] : [];
  });
}

async function deliveryDetails(
  database: Kysely<Database>,
  heads: Awaited<ReturnType<typeof serviceDeliveryHeads>>,
) {
  if (!heads.length) return [];
  const releases = heads.flatMap(({ current, latestAttempt }) =>
    current ? [current, latestAttempt] : [latestAttempt],
  );
  const recordIds = [
    ...new Set(
      releases.flatMap(({ deploymentRecordId }) =>
        deploymentRecordId ? [deploymentRecordId] : [],
      ),
    ),
  ];
  const taskIds = [...new Set(releases.map(({ releaseTaskId }) => releaseTaskId))];
  const environmentIds = [...new Set(releases.map(({ environmentId }) => environmentId))];
  const [records, nodes, environments] = await Promise.all([
    recordIds.length
      ? database
          .selectFrom('deployment_records as record')
          .innerJoin('pipeline_runs as release', 'release.id', 'record.pipeline_run_id')
          .leftJoin('artifacts as artifact', 'artifact.id', 'record.artifact_id')
          .leftJoin('pipeline_runs as build', 'build.id', 'artifact.pipeline_run_id')
          .select([
            'record.id',
            'record.release_version as releaseVersion',
            'build.task_id as buildTaskId',
            'artifact.graph_run_id as buildRunId',
            'artifact.id as artifactInstanceId',
            'artifact.logical_artifact_id as artifactId',
            'artifact.artifact_name as artifactName',
          ])
          .select(({ fn }) =>
            fn.coalesce('artifact.source_commit', 'release.commit_sha').as('commitSha'),
          )
          .where('record.id', 'in', recordIds)
          .execute()
      : [],
    database
      .selectFrom('execution_node_runs')
      .select(['task_id as releaseTaskId', 'run_id as releaseRunId', 'node_id as releaseNodeId'])
      .where('task_id', 'in', taskIds)
      .execute(),
    database
      .selectFrom('environments')
      .select(['id', 'name'])
      .where('id', 'in', environmentIds)
      .execute(),
  ]);
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
  const byTask = new Map(nodes.map((node) => [node.releaseTaskId, node]));
  const environmentNames = new Map(environments.map(({ id, name }) => [id, name]));
  const byInstance = new Map<string, Omit<(typeof sources)[number], 'instanceId'>[]>();
  for (const { instanceId, ...source } of sources) {
    const matching = byInstance.get(instanceId);
    if (matching) matching.push(source);
    else byInstance.set(instanceId, [source]);
  }
  const enrich = (head: (typeof heads)[number]['latestAttempt']) => {
    const record = head.deploymentRecordId ? byRecord.get(head.deploymentRecordId) : undefined;
    return {
      ...record,
      ...head,
      ...byTask.get(head.releaseTaskId),
      environmentName: environmentNames.get(head.environmentId) ?? null,
      artifactId: record?.artifactId ?? record?.artifactInstanceId,
      sources: byInstance.get(record?.artifactInstanceId ?? '') ?? [],
    };
  };
  return heads.map((head) => ({
    ...head,
    ...releaseLocation(head.scopeKey),
    current: head.current ? enrich(head.current) : null,
    latestAttempt: enrich(head.latestAttempt),
  }));
}

function releaseLocation(scopeKey: string) {
  if (!scopeKey.startsWith('[')) return {};
  try {
    const scope: unknown = JSON.parse(scopeKey);
    if (!Array.isArray(scope)) return {};
    const method: unknown = scope[3];
    const location: unknown = scope[4];
    if ((method === 'COMPOSE' || method === 'FILE') && typeof location === 'string')
      return { method, location };
  } catch {
    return {};
  }
  return {};
}
const abnormalHealth = new Set(['FAILED', 'UNHEALTHY', 'UNKNOWN']);
const abnormalResults = new Set(['FAILED', 'PARTIAL_FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION']);

export function serviceDeliveryAbnormal(target: {
  current: string | null;
  health: string | null;
  lastAttempt: string;
}) {
  return (
    abnormalResults.has(target.current ?? '') ||
    abnormalHealth.has(target.health ?? '') ||
    abnormalResults.has(target.lastAttempt)
  );
}
