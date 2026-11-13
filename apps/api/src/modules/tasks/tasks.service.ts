import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Selectable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import { TasksTable } from '../../core/database/schema';
import { CreateTaskInput, TaskExecutionContext } from './tasks.types';
import { TaskLogService } from './task-log.service';

const terminal = new Set([
  'SUCCESS',
  'FAILED',
  'PARTIAL_FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'NEEDS_ATTENTION',
]);
export const isTerminalStatus = (status: string) => terminal.has(status);
export function taskDto(task: Selectable<TasksTable>) {
  return {
    id: task.id,
    type: task.task_type,
    name: task.name,
    status: task.status,
    createdBy: task.created_by,
    createdAt: task.created_at,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
    errorSummary: task.error_summary,
    result: task.result_json ? JSON.parse(task.result_json) : null,
    operationPlanVersionId: task.operation_plan_version_id,
  };
}

@Injectable()
export class TasksService {
  private readonly cancellations = new Map<string, AbortController>();
  constructor(
    private readonly database: DatabaseService,
    private readonly logStore: TaskLogService,
  ) {}
  bindCancellation(id: string, controller: AbortController): () => void {
    this.cancellations.set(id, controller);
    return () => {
      if (this.cancellations.get(id) === controller) this.cancellations.delete(id);
    };
  }
  async create(input: CreateTaskInput, userId: string) {
    const targets = input.payload.targets;
    if (!targets.length || new Set(targets.map((target) => target.id)).size !== targets.length)
      throw new BadRequestException('任务目标必须明确指定且不能重复');
    const id = randomUUID();
    const now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('tasks')
        .values({
          id,
          task_type: input.type,
          name: input.name,
          created_by: userId,
          operation_plan_version_id: input.operationPlanVersionId ?? null,
          project_id: input.scope?.projectId ?? null,
          service_id: input.scope?.serviceId ?? null,
          environment_id: input.scope?.environmentId ?? null,
          target_id: input.scope?.targetId ?? null,
          payload_json: JSON.stringify(input.payload),
          created_at: now,
          updated_at: now,
          available_at: now,
          log_file_key: this.logStore.key(id, now),
        })
        .execute();
      await tx
        .insertInto('task_targets')
        .values(
          targets.map((target) => ({
            id: randomUUID(),
            task_id: id,
            server_id: target.id,
            server_name_snapshot: target.name,
            host_snapshot: target.host,
            port_snapshot: target.port,
            username_snapshot: target.username,
            credential_id_snapshot: target.credentialId,
            fingerprint_snapshot: target.hostKeyFingerprint,
          })),
        )
        .execute();
      if (input.pipelineRun && input.scope) {
        const run = input.pipelineRun;
        await tx
          .insertInto('pipeline_runs')
          .values({
            id: run.id,
            task_id: id,
            pipeline_id: run.pipelineId,
            pipeline_version_id: run.pipelineVersionId,
            project_id: input.scope.projectId,
            service_id: input.scope.serviceId,
            environment_id: input.scope.environmentId,
            target_id: input.scope.targetId,
            git_ref: run.gitRef,
            commit_sha: run.commitSha,
            build_location_snapshot: run.buildLocation,
            artifact_type_snapshot: run.artifactType,
            created_at: now,
          })
          .execute();
      }
    });
    return this.get(id);
  }
  async list(type?: string) {
    let query = this.database.db.selectFrom('tasks').selectAll();
    if (type) query = query.where('task_type', '=', type);
    return (await query.orderBy('created_at', 'desc').limit(100).execute()).map(taskDto);
  }
  async row(id: string) {
    const task = await this.database.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!task) throw new NotFoundException('任务不存在');
    return task;
  }
  async get(id: string) {
    return taskDto(await this.row(id));
  }
  async targets(id: string) {
    await this.row(id);
    const rows = await this.database.db
      .selectFrom('task_targets')
      .selectAll()
      .where('task_id', '=', id)
      .orderBy('server_name_snapshot')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name_snapshot,
      host: row.host_snapshot,
      status: row.status,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorSummary: row.error_summary,
    }));
  }
  async steps(id: string) {
    await this.row(id);
    return (
      await this.database.db
        .selectFrom('task_steps')
        .selectAll()
        .where('task_id', '=', id)
        .orderBy('step_order')
        .execute()
    ).map((row) => ({
      id: row.id,
      targetId: row.task_target_id,
      serverId: row.execution_target_key,
      name: row.step_key,
      order: row.step_order,
      status: row.status,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  }
  async logs(id: string, offset = 0) {
    return this.logStore.read((await this.row(id)).log_file_key, offset);
  }
  async cancel(id: string) {
    const row = await this.row(id);
    if (isTerminalStatus(row.status)) throw new BadRequestException('已结束的任务不能取消');
    const now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      const pending = await tx
        .updateTable('tasks')
        .set({ status: 'CANCELLED', cancel_requested_at: now, finished_at: now, updated_at: now })
        .where('id', '=', id)
        .where('status', '=', 'PENDING')
        .returning('id')
        .executeTakeFirst();
      if (pending)
        await tx
          .updateTable('task_targets')
          .set({ status: 'CANCELLED', finished_at: now })
          .where('task_id', '=', id)
          .where('status', '=', 'PENDING')
          .execute();
      else
        await tx
          .updateTable('tasks')
          .set({ status: 'CANCEL_REQUESTED', cancel_requested_at: now, updated_at: now })
          .where('id', '=', id)
          .where('status', 'in', ['RUNNING', 'CANCEL_REQUESTED'])
          .execute();
    });
    this.cancellations.get(id)?.abort();
    return this.get(id);
  }
  context(task: Selectable<TasksTable>, signal: AbortSignal): TaskExecutionContext {
    return {
      signal,
      log: (text, serverId) => {
        this.logStore.append(
          task.id,
          task.log_file_key!,
          serverId ? `[${serverId}] ${text}` : text,
        );
      },
      startTarget: async (serverId) => {
        const row = await this.database.db
          .updateTable('task_targets')
          .set({ status: 'RUNNING', started_at: Date.now() })
          .where('task_id', '=', task.id)
          .where('server_id', '=', serverId)
          .where('status', '=', 'PENDING')
          .returning('id')
          .executeTakeFirstOrThrow();
        return row.id;
      },
      finishTarget: async (targetId, status, exitCode, error) => {
        await this.database.db
          .updateTable('task_targets')
          .set({
            status,
            exit_code: exitCode,
            error_summary: error ?? null,
            finished_at: Date.now(),
          })
          .where('id', '=', targetId)
          .where('status', '=', 'RUNNING')
          .execute();
      },
      startStep: async (targetId, serverId, step, index) => {
        const id = randomUUID();
        await this.database.db
          .insertInto('task_steps')
          .values({
            id,
            task_id: task.id,
            task_target_id: targetId,
            execution_target_key: serverId,
            step_key: step.key ?? `${index + 1}:${step.name}`,
            step_order: index,
            step_type: 'SSH_COMMAND',
            status: 'RUNNING',
            input_json: JSON.stringify({ name: step.name, timeout: step.timeout }),
            started_at: Date.now(),
          })
          .execute();
        return id;
      },
      finishStep: async (stepId, status, exitCode, error) => {
        await this.database.db
          .updateTable('task_steps')
          .set({
            status,
            exit_code: exitCode,
            result_json: error ? JSON.stringify({ error }) : null,
            finished_at: Date.now(),
          })
          .where('id', '=', stepId)
          .where('status', '=', 'RUNNING')
          .execute();
      },
    };
  }
}
