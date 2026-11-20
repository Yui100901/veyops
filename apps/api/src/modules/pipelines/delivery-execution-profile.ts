import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { PipelineDefinition } from './pipeline.types';

/**
 * The published graph defines delivery configuration. The execution engine stores
 * a backing key only when a task is queued, so previews never create resources.
 */
export interface DeliveryExecutionProfile {
  id: string;
  versionId: string;
  projectId: string;
  serviceId: string;
  name: string;
  definition: PipelineDefinition;
  authoredFields: string[];
}

function engineId(key: unknown) {
  const hex = createHash('sha256').update(JSON.stringify(key)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function deliveryExecutionProfile(
  projectId: string,
  serviceId: string,
  flowId: string,
  graphVersion: number,
  name: string,
  definition: PipelineDefinition,
  fields: string[],
): DeliveryExecutionProfile {
  const authoredFields = [...new Set(fields)].sort();
  const id = engineId([
    'execution-graph',
    projectId,
    serviceId,
    flowId,
    graphVersion,
    definition,
    authoredFields,
  ]);
  const versionId = engineId([id, 'definition']);
  return { id, versionId, projectId, serviceId, name, definition, authoredFields };
}

export async function storeDeliveryProfile(
  tx: Transaction<Database>,
  profile: DeliveryExecutionProfile,
  userId: string,
) {
  const now = Date.now();
  await tx
    .insertInto('pipelines')
    .values({
      id: profile.id,
      project_id: profile.projectId,
      service_id: profile.serviceId,
      name: profile.name,
      enabled: 1,
      current_version: 1,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
  await tx
    .insertInto('pipeline_versions')
    .values({
      id: profile.versionId,
      pipeline_id: profile.id,
      version: 1,
      definition_json: JSON.stringify(profile.definition),
      created_by: userId,
      created_at: now,
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .execute();
}
