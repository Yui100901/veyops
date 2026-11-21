import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { safeDeployPath } from '../pipelines/pipeline.validation';

export type ReleaseScope = Pick<
  PipelineSnapshot,
  'projectId' | 'serviceId' | 'environmentId' | 'graphDeployment'
> & { definition: Pick<PipelineSnapshot['definition'], 'artifactType' | 'deployPath'> };

export function normalizeReleasePath(path: string) {
  return safeDeployPath(posix.normalize(safeDeployPath(path)));
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

export function deploymentScopeKey(scope: ReleaseScope, serverId: string) {
  const { definition, projectId, serviceId, environmentId, graphDeployment } = scope;
  const compose = (graphDeployment?.method ?? definition.artifactType) !== 'FILE';
  const location = compose
    ? (graphDeployment?.composeProject ??
      (graphDeployment
        ? graphComposeProject(scope)
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
