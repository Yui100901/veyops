import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { activeFlowStatuses } from '../execution-graphs/graph-run-lifecycle';
import { projectResourceReferences } from '../projects/project-resource-references';

export const activeArtifactTaskStatuses = [
  'PENDING',
  'RUNNING',
  'CANCEL_REQUESTED',
  'NEEDS_ATTENTION',
];
const protectedRunStatuses = [...activeFlowStatuses, 'NEEDS_ATTENTION'];

export async function protectedArtifacts(db: Kysely<Database>) {
  const [deployments, configs, tasks] = await Promise.all([
    db
      .selectFrom('deployment_records')
      .select([
        'id',
        'artifact_id',
        'pipeline_run_id',
        'release_scope_key',
        'status',
        'health_status',
        'activated_at',
        'previous_deployment_id',
      ])
      .where((eb) =>
        eb.or([
          eb('activated_at', 'is not', null),
          eb('status', 'in', ['SUCCESS', 'RUNNING', 'NEEDS_ATTENTION']),
        ]),
      )
      .orderBy(
        (eb) => eb.fn.coalesce('activated_at', 'started_at'),
        (order) => order.desc().nullsLast(),
      )
      .orderBy('id', 'desc')
      .execute(),
    db.selectFrom('service_environment_configs').select('release_policy_json').execute(),
    db
      .selectFrom('tasks')
      .select('payload_json')
      .where('task_type', '=', 'PIPELINE')
      .where('status', 'in', activeArtifactTaskStatuses)
      .execute(),
  ]);
  const protectedIds = new Set<string>();
  const previousIds = new Set<string>();
  const current = new Set<string>();
  const healthy = new Set<string>();
  const pinnedDeploymentIds = new Set(
    configs.flatMap(({ release_policy_json }) => {
      const { pinnedDeploymentId } = JSON.parse(release_policy_json ?? '{}') as {
        pinnedDeploymentId?: string;
      };
      return pinnedDeploymentId ? [pinnedDeploymentId] : [];
    }),
  );
  const pinnedRuns = new Set(
    deployments
      .filter(({ id }) => pinnedDeploymentIds.has(id))
      .map(({ pipeline_run_id }) => pipeline_run_id),
  );
  for (const deployment of deployments) {
    const scope = deployment.release_scope_key;
    if (deployment.status === 'RUNNING' || deployment.status === 'NEEDS_ATTENTION') {
      if (deployment.artifact_id) protectedIds.add(deployment.artifact_id);
      if (deployment.previous_deployment_id) previousIds.add(deployment.previous_deployment_id);
    }
    if (deployment.activated_at === null && deployment.status !== 'SUCCESS') continue;
    if (
      deployment.artifact_id &&
      (!scope || !current.has(scope) || pinnedRuns.has(deployment.pipeline_run_id))
    )
      protectedIds.add(deployment.artifact_id);
    if (!scope) continue;
    current.add(scope);
    if (
      deployment.status === 'SUCCESS' &&
      deployment.health_status === 'HEALTHY' &&
      deployment.artifact_id &&
      !healthy.has(scope)
    ) {
      protectedIds.add(deployment.artifact_id);
      healthy.add(scope);
    }
  }
  for (const deployment of deployments)
    if (previousIds.has(deployment.id) && deployment.artifact_id)
      protectedIds.add(deployment.artifact_id);
  for (const task of tasks) {
    const payload = JSON.parse(task.payload_json) as {
      pipeline?: { deploymentArtifacts?: { id: string }[] };
    };
    for (const artifact of payload.pipeline?.deploymentArtifacts ?? [])
      protectedIds.add(artifact.id);
  }
  return protectedIds;
}

export async function graphArtifactProtection(
  db: Kysely<Database>,
  projectIds: readonly string[],
  productionIds: readonly string[],
  temporaryRoots: readonly string[],
) {
  const references = new Set<string>();
  for (const id of new Set(projectIds)) {
    const result = await projectResourceReferences(db, id, {
      resourceType: 'ARTIFACT',
      states: ['CONFIGURED', 'RUNNABLE', 'PENDING'],
    });
    for (const reference of result) references.add(reference.resourceId);
  }
  // A finished subflow can still own an output used by its active parent.
  const ancestors = new Map<string, { parent: string | null; active: boolean }>();
  let frontier = [...new Set(productionIds)];
  while (frontier.length) {
    const runs = await db
      .selectFrom('execution_flow_runs')
      .select(['id', 'parent_run_id', 'status'])
      .where('id', 'in', frontier)
      .execute();
    for (const id of frontier) ancestors.set(id, { parent: null, active: false });
    for (const run of runs)
      ancestors.set(run.id, {
        parent: run.parent_run_id,
        active: protectedRunStatuses.includes(run.status),
      });
    frontier = [
      ...new Set(
        runs.flatMap(({ parent_run_id }) =>
          parent_run_id && !ancestors.has(parent_run_id) ? [parent_run_id] : [],
        ),
      ),
    ];
  }
  const activeProduction = new Set<string>();
  for (const id of productionIds) {
    const visited = new Set<string>();
    for (let runId: string | null = id; runId && !visited.has(runId);) {
      visited.add(runId);
      const run = ancestors.get(runId);
      if (run?.active) {
        activeProduction.add(id);
        break;
      }
      runId = run?.parent ?? null;
    }
  }
  const activeTemporaryRoots = new Set<string>();
  if (temporaryRoots.length) {
    // Walk the active descendants of this batch's roots in one recursive SQL query.
    const descendants = await db
      .withRecursive('artifact_run_family(root_id, run_id, state)', (cte) =>
        cte
          .selectFrom('execution_flow_runs')
          .select(['id as root_id', 'id as run_id', 'status as state'])
          .where('id', 'in', [...new Set(temporaryRoots)])
          .unionAll(
            cte
              .selectFrom('execution_flow_runs as child')
              .innerJoin('artifact_run_family as family', 'child.parent_run_id', 'family.run_id')
              .select(['family.root_id', 'child.id as run_id', 'child.status as state']),
          ),
      )
      .selectFrom('artifact_run_family')
      .select('root_id')
      .where('state', 'in', protectedRunStatuses)
      .distinct()
      .execute();
    for (const { root_id } of descendants) activeTemporaryRoots.add(root_id);
  }
  return { references, activeProduction, activeTemporaryRoots };
}
