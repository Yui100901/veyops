import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { redactTaskLog } from '../tasks/task-log.service';
import type { TaskPayload } from '../tasks/tasks.types';
import type { GraphReleaseResult } from './graph-release-gates';

function targetStatus(status: string, deploymentStatus?: string) {
  if (status === 'SUCCESS' && !deploymentStatus) return 'NEEDS_ATTENTION';
  const result = status === 'SUCCESS' ? deploymentStatus : status;
  if (
    result === 'SUCCESS' ||
    result === 'FAILED' ||
    result === 'CANCELLED' ||
    result === 'SKIPPED' ||
    result === 'TIMED_OUT'
  )
    return result;
  return 'NEEDS_ATTENTION';
}

export async function readReleaseOutput(
  db: Kysely<Database>,
  taskId: string,
  operation: 'DEPLOY' | 'ROLLBACK',
) {
  const run = await db
    .selectFrom('pipeline_runs as run')
    .innerJoin('tasks as task', 'task.id', 'run.task_id')
    .select(['run.id', 'run.service_id', 'run.environment_id', 'task.payload_json'])
    .where('run.task_id', '=', taskId)
    .executeTakeFirst();
  if (!run) return {};

  const [taskTargets, records] = await Promise.all([
    db
      .selectFrom('task_targets')
      .select(['id', 'server_id', 'status', 'error_summary'])
      .where('task_id', '=', taskId)
      .where('server_id', 'is not', null)
      .orderBy('id')
      .execute(),
    db
      .selectFrom('deployment_records')
      .select([
        'id',
        'task_target_id',
        'artifact_id',
        'server_id',
        'status',
        'health_status',
        'rollback_of_deployment_id',
      ])
      .where('pipeline_run_id', '=', run.id)
      .orderBy('started_at')
      .orderBy('id')
      .execute(),
  ]);
  const snapshot = (JSON.parse(run.payload_json) as TaskPayload).pipeline;
  const planned = new Map(
    (snapshot?.deploymentArtifacts ?? []).map(({ id, serverId }) => [serverId, id]),
  );
  const byTarget = new Map(records.map((record) => [record.task_target_id, record]));
  const targets: GraphReleaseResult['targets'] = taskTargets.flatMap((target) => {
    if (!target.server_id) return [];
    const record = byTarget.get(target.id);
    const status = targetStatus(target.status, record?.status);
    const healthStatus = record?.health_status;
    const error = target.error_summary
      ? redactTaskLog(target.error_summary)
      : !record && target.status === 'SUCCESS'
        ? '目标任务未登记可验证的发布记录'
        : undefined;
    return [
      {
        serverId: target.server_id,
        deploymentId: record?.id,
        rollbackOfDeploymentId: record?.rollback_of_deployment_id ?? undefined,
        artifactInstanceId: record?.artifact_id ?? undefined,
        plannedArtifactInstanceId: planned.get(target.server_id) ?? planned.get(null),
        status,
        health:
          healthStatus === 'HEALTHY'
            ? 'HEALTHY'
            : healthStatus === 'FAILED'
              ? 'UNHEALTHY'
              : healthStatus === 'UNKNOWN'
                ? 'UNKNOWN'
                : 'NOT_CHECKED',
        errorSummary: error,
        consumedArtifacts: record?.artifact_id ? [{ artifactId: record.artifact_id }] : [],
      },
    ];
  });
  const successCount = targets.filter(({ status }) => status === 'SUCCESS').length;
  const status = targets.some((target) => target.status === 'NEEDS_ATTENTION')
    ? 'NEEDS_ATTENTION'
    : !successCount
      ? 'FAILED'
      : successCount === targets.length
        ? 'SUCCESS'
        : 'PARTIAL_SUCCESS';
  return {
    release: {
      operation,
      service: { serviceId: run.service_id },
      serviceId: run.service_id,
      environmentId: run.environment_id,
      status,
      targets,
      deployments: records.map((record) => ({
        id: record.id,
        artifactId: record.artifact_id,
        serverId: record.server_id,
        status: record.status,
        health: record.health_status,
      })),
    },
  };
}
