import { createHash } from 'node:crypto';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';

function stableUuid(parts: readonly unknown[]) {
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function artifactIdentity(snapshot: PipelineSnapshot, name?: string, serverId?: string) {
  const producer = snapshot.graph?.nodeRunId ?? snapshot.runId;
  const artifactId = stableUuid(['artifact', snapshot.projectId, producer, name ?? 'artifact']);
  return {
    artifactId,
    instanceId: stableUuid(['instance', artifactId, serverId ?? 'manager']),
  };
}
