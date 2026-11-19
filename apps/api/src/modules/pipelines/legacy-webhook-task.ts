import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { TaskPayload } from '../tasks/tasks.types';
import type { PipelineSnapshot } from './pipeline.types';

export async function findLegacyWebhookTask(
  tx: Transaction<Database>,
  snapshot: PipelineSnapshot,
  targets: Omit<TaskPayload, 'pipeline'>,
  gitRef: string,
  legacyTargetId?: string | null,
) {
  // The v1.0 key did not include the pipeline version, environment, or target.
  const key =
    'gitea:' +
    createHash('sha256')
      .update(JSON.stringify([snapshot.pipelineId, gitRef, snapshot.commitSha]))
      .digest('hex');
  const previous = await tx
    .selectFrom('tasks')
    .select(['id', 'payload_json'])
    .where('idempotency_key', '=', key)
    .executeTakeFirst();
  if (!previous) return;
  const payload = JSON.parse(previous.payload_json) as TaskPayload;
  const former = payload.pipeline;
  if (!former || former.mode !== 'BUILD_ONLY' || former.deployAfterBuild) return;
  const binding = (s: PipelineSnapshot) => [
    s.pipelineVersionId,
    s.environmentId,
    s.definition,
    s.repository,
    s.nodeSources,
    s.registry,
    s.secretVariables,
    s.variables,
  ];
  const members = (t: Omit<TaskPayload, 'pipeline'>) => [
    t.strategy,
    t.maxParallel,
    t.failurePolicy,
    t.targets.map((s) => [s.id, s.host, s.port, s.username, s.credentialId, s.hostKeyFingerprint]),
  ];
  const sameTarget = former.targetSelection
    ? isDeepStrictEqual(former.targetSelection, snapshot.targetSelection)
    : former.targetId && former.targetId === legacyTargetId;
  if (
    sameTarget &&
    isDeepStrictEqual(members(payload), members(targets)) &&
    isDeepStrictEqual(binding(former), binding(JSON.parse(JSON.stringify(snapshot))))
  )
    return previous.id;
}
