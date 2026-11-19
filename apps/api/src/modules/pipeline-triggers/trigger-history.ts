import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';

export function commitTriggerKey(
  pipelineId: string,
  version: number,
  environmentId: string,
  branch: string,
  sha: string,
  configurationHash: string,
) {
  return (
    'auto:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          pipelineId,
          version,
          environmentId,
          branch,
          sha.toLowerCase(),
          configurationHash,
        ]),
      )
      .digest('hex')
  );
}

export type TriggerEvent = {
  pipelineId: string;
  kind: 'SCHEDULE' | 'POLL' | 'WEBHOOK';
  status: 'QUEUED' | 'DUPLICATE' | 'FAILED' | 'SKIPPED';
  version?: number;
  environmentId?: string;
  branch?: string;
  commitSha?: string;
  mode?: 'BUILD_ONLY' | 'DEPLOY';
  taskId?: string;
  reason?: string;
  scheduledAt?: number;
  triggerId?: string;
};

export async function recordPipelineTrigger(db: Kysely<Database>, event: TriggerEvent) {
  await db
    .insertInto('pipeline_trigger_history')
    .values({
      id: randomUUID(),
      pipeline_id: event.pipelineId,
      kind: event.kind,
      status: event.status,
      version: event.version ?? null,
      environment_id: event.environmentId ?? null,
      branch: event.branch ?? null,
      commit_sha: event.commitSha ?? null,
      mode: event.mode ?? null,
      task_id: event.taskId ?? null,
      reason: event.reason ?? null,
      scheduled_at: event.scheduledAt ?? null,
      trigger_id: event.triggerId ?? null,
      created_at: Date.now(),
    })
    .execute();
}
