import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { lockTaskLease, TaskLeaseUnavailableError } from '../tasks/task-lease';

export type DeploymentHealth = 'NOT_CHECKED' | 'HEALTHY' | 'FAILED' | 'UNKNOWN';
@Injectable()
export class DeploymentsService {
  constructor(private readonly database: DatabaseService) {}
  async start(
    s: PipelineSnapshot,
    serverId: string,
    targetId: string,
    lease?: { taskId: string; owner: string },
  ) {
    const id = randomUUID();
    await this.database.db.transaction().execute(async (tx) => {
      if (lease) {
        if (!(await lockTaskLease(tx, lease.taskId, lease.owner)))
          throw new TaskLeaseUnavailableError();
        await tx
          .selectFrom('task_targets')
          .innerJoin('pipeline_runs', 'pipeline_runs.task_id', 'task_targets.task_id')
          .select('task_targets.id')
          .where('pipeline_runs.id', '=', s.runId)
          .where('task_targets.task_id', '=', lease.taskId)
          .where('task_targets.id', '=', targetId)
          .where('task_targets.server_id', '=', serverId)
          .where('task_targets.status', '=', 'RUNNING')
          .executeTakeFirstOrThrow();
      }
      const previous = await tx
        .selectFrom('deployment_records')
        .select('id')
        .where('service_id', '=', s.serviceId)
        .where('environment_id', '=', s.environmentId)
        .where('server_id', '=', serverId)
        .where('status', '=', 'SUCCESS')
        .orderBy('started_at', 'desc')
        .executeTakeFirst();
      await tx
        .insertInto('deployment_records')
        .values({
          id,
          pipeline_run_id: s.runId,
          task_target_id: targetId,
          service_id: s.serviceId,
          environment_id: s.environmentId,
          server_id: serverId,
          status: 'RUNNING',
          release_version: s.commitSha,
          deploy_path: s.definition.deployPath,
          health_status: 'PENDING',
          previous_deployment_id: previous?.id ?? null,
          started_at: Date.now(),
        })
        .execute();
    });
    return id;
  }
  async finish(
    id: string,
    status: string,
    artifactId?: string,
    healthStatus: DeploymentHealth = 'NOT_CHECKED',
    lease?: { taskId: string; owner: string },
  ) {
    return this.database.db.transaction().execute(async (tx) => {
      if (lease && !(await lockTaskLease(tx, lease.taskId, lease.owner, true))) return false;
      let update = tx
        .updateTable('deployment_records')
        .set({
          status,
          artifact_id: artifactId ?? null,
          health_status: healthStatus,
          finished_at: Date.now(),
        })
        .where('id', '=', id)
        .where('status', '=', 'RUNNING');
      if (lease) {
        update = update.where(
          'task_target_id',
          'in',
          tx.selectFrom('task_targets').select('id').where('task_id', '=', lease.taskId),
        );
      }
      return Boolean(await update.returning('id').executeTakeFirst());
    });
  }
  async list(projectId?: string) {
    let q = this.database.db
      .selectFrom('deployment_records')
      .innerJoin('pipeline_runs', 'pipeline_runs.id', 'deployment_records.pipeline_run_id')
      .selectAll('deployment_records');
    if (projectId) q = q.where('pipeline_runs.project_id', '=', projectId);
    return (await q.orderBy('deployment_records.started_at', 'desc').limit(200).execute()).map(
      (r) => ({
        id: r.id,
        pipelineRunId: r.pipeline_run_id,
        artifactId: r.artifact_id,
        serviceId: r.service_id,
        environmentId: r.environment_id,
        serverId: r.server_id,
        status: r.status,
        releaseVersion: r.release_version,
        deployPath: r.deploy_path,
        healthStatus: r.health_status,
        previousDeploymentId: r.previous_deployment_id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      }),
    );
  }
}
@Controller('deployments')
export class DeploymentsController {
  constructor(private readonly service: DeploymentsService) {}
  @Get() list(@Query('projectId') projectId?: string) {
    return this.service.list(projectId);
  }
}
