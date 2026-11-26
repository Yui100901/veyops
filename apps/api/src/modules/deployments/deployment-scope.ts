import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { releasePath } from '../pipelines/pipeline.validation';

export type ReleaseScope = Pick<
  PipelineSnapshot,
  'projectId' | 'serviceId' | 'environmentId' | 'graphDeployment'
> & { definition: Pick<PipelineSnapshot['definition'], 'artifactType' | 'deployPath'> };

export function normalizeReleasePath(path: string) {
  return releasePath(posix.normalize(releasePath(path)));
}

export function graphComposeProject({
  projectId,
  serviceId,
  definition,
}: Pick<ReleaseScope, 'projectId' | 'serviceId' | 'definition'>) {
  return `veyops-${createHash('sha256')
    .update(JSON.stringify([projectId, serviceId, normalizeReleasePath(definition.deployPath)]))
    .digest('hex')
    .slice(0, 24)}`;
}

export async function assignedReleasePaths(
  db: Kysely<Database>,
  { serviceId, environmentId }: Pick<ReleaseScope, 'serviceId' | 'environmentId'>,
  serverIds: readonly string[],
): Promise<Record<string, string>> {
  if (!serverIds.length) return {};
  // A preparation failure leaves the first publication path available for re-planning.
  const ranked = db
    .selectFrom('deployment_records')
    .select(['server_id', 'deploy_path'])
    .select((eb) =>
      eb.fn
        .agg<number>('row_number', [])
        .over((window) =>
          window
            .partitionBy('server_id')
            .orderBy(eb.fn.coalesce('activated_at', 'started_at'), (order) =>
              order.desc().nullsLast(),
            )
            .orderBy('id', 'desc'),
        )
        .as('rank'),
    )
    .where('service_id', '=', serviceId)
    .where('environment_id', '=', environmentId)
    .where('server_id', 'in', serverIds)
    .where('deploy_path', 'is not', null)
    .where((eb) => eb.or([eb('activated_at', 'is not', null), eb('status', '=', 'SUCCESS')]));
  const rows = await db
    .selectFrom(ranked.as('assignment'))
    .select(['server_id', 'deploy_path'])
    .where('rank', '=', 1)
    .execute();
  return Object.fromEntries(
    rows.map(({ server_id, deploy_path }) => [server_id!, normalizeReleasePath(deploy_path!)]),
  );
}

export function releaseScopeForTarget<T extends ReleaseScope>(scope: T, serverId: string): T {
  const graphDeployment = scope.graphDeployment;
  const path = graphDeployment?.targetPaths?.[serverId];
  if (!path || !graphDeployment || path === scope.definition.deployPath) return scope;
  const definition = { ...scope.definition, deployPath: path };
  return {
    ...scope,
    definition,
    graphDeployment: {
      ...graphDeployment,
      ...(graphDeployment.method === 'COMPOSE' && {
        composeProject: graphComposeProject({ ...scope, definition }),
      }),
    },
  };
}

export function deploymentScopeKey(scope: ReleaseScope, serverId: string) {
  const resolved = releaseScopeForTarget(scope, serverId);
  const { definition, projectId, serviceId, environmentId, graphDeployment } = resolved;
  const compose = (graphDeployment?.method ?? definition.artifactType) !== 'FILE';
  const location = compose
    ? (graphDeployment?.composeProject ??
      (graphDeployment
        ? graphComposeProject(resolved)
        : `veyops-${serviceId.slice(0, 8)}-${environmentId.slice(0, 8)}`))
    : normalizeReleasePath(definition.deployPath);
  return JSON.stringify([projectId, serviceId, serverId, compose ? 'COMPOSE' : 'FILE', location]);
}

export function recordedDeploymentLocation(row: {
  project_id: string;
  service_id: string;
  environment_id: string;
  server_id: string | null;
  deploy_path: string | null;
  artifact_type_snapshot: string;
  release_snapshot_json: string | null;
}) {
  if (!row.deploy_path) return null;
  let path: string;
  try {
    path = normalizeReleasePath(row.deploy_path);
  } catch {
    return null;
  }
  try {
    const snapshot = JSON.parse(row.release_snapshot_json ?? 'null') as PipelineSnapshot | null;
    const artifactType = snapshot?.definition?.artifactType ?? row.artifact_type_snapshot;
    if (!row.server_id || (artifactType !== 'FILE' && artifactType !== 'DOCKER_IMAGE'))
      return { path, scope: null };
    return {
      path,
      scope: deploymentScopeKey(
        {
          projectId: row.project_id,
          serviceId: row.service_id,
          environmentId: row.environment_id,
          graphDeployment: snapshot?.graphDeployment,
          definition: { artifactType, deployPath: path },
        },
        row.server_id,
      ),
    };
  } catch {
    // An unidentifiable historical release is still protected from cleanup.
    return { path, scope: null };
  }
}
