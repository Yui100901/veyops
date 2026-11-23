import { graphRecord, type GraphBinding } from './graph-fields';

export function graphScalarProjection(
  binding: Extract<GraphBinding, { kind: 'PROJECT_VALUE' }>,
  value: unknown,
  workspace: unknown,
  executionServerId?: string,
): string | undefined {
  if (!graphRecord(value)) return;
  if (binding.projection === 'WORKSPACE_PATH') {
    if (
      !executionServerId &&
      graphRecord(workspace) &&
      typeof value.nodeRunId === 'string' &&
      typeof value.runId === 'string' &&
      value.nodeRunId === workspace.nodeRunId &&
      value.runId === workspace.runId
    )
      return '/workspace/repo';
    return;
  }
  const selection = binding.serverId ?? executionServerId;
  const instances: unknown[] = Array.isArray(value.instances)
    ? value.instances.filter(
        (entry) => graphRecord(entry) && (!selection || entry.serverId === selection),
      )
    : [];
  if (instances.length !== 1 || !graphRecord(instances[0])) return;
  const instance = instances[0];
  if (binding.projection === 'ARTIFACT_PATH') {
    if (
      executionServerId &&
      instance.serverId === executionServerId &&
      instance.location === 'SERVER_PATH' &&
      typeof instance.path === 'string'
    )
      return instance.path;
    return;
  }
  const property = {
    IMAGE_NAME: 'imageReference',
    IMAGE_ID: 'imageId',
    IMAGE_DIGEST: 'digest',
  }[binding.projection];
  const projected = instance[property];
  return typeof projected === 'string' && projected.length ? projected : undefined;
}
