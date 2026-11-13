import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { isTerminalStatus } from '../tasks/tasks.service';
import type { TaskRecord } from '../tasks/tasks.types';
import { AiPipelineAnalyzer } from './ai-pipeline-analyzer.service';

@Injectable()
export class PipelineAnalysisService {
  constructor(
    private readonly database: DatabaseService,
    private readonly analyzer: AiPipelineAnalyzer,
  ) {}

  async record(task: TaskRecord, signal: AbortSignal) {
    const snapshot = task.payload.pipeline;
    if (!snapshot || !this.analyzer.isEnabled() || signal.aborted) return;
    const db = this.database.db;
    const row = await db
      .selectFrom('tasks')
      .select(['status', 'result_json'])
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    if (!isTerminalStatus(row.status) || row.status === 'CANCELLED') return;
    const result = JSON.parse(row.result_json ?? '{}') as Record<string, unknown>;
    if (result.aiAnalysis) return;
    const targetStatuses = await db
      .selectFrom('task_targets')
      .select('status')
      .where('task_id', '=', task.id)
      .execute();
    const steps = await db
      .selectFrom('task_steps')
      .select(['step_key as phase', 'status', 'exit_code as exitCode'])
      .where('task_id', '=', task.id)
      .orderBy((eb) =>
        eb
          .case()
          .when('status', 'in', ['FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'])
          .then(0)
          .else(1)
          .end(),
      )
      .orderBy('step_order')
      .limit(64)
      .execute();
    const succeeded = targetStatuses.filter((target) => target.status === 'SUCCESS').length;
    const failed = targetStatuses.filter((target) =>
      ['FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'].includes(target.status),
    ).length;
    const analysis = await this.analyzer.analyze(
      {
        status: row.status,
        mode: snapshot.mode ?? 'DEPLOY',
        targetCounts: { total: targetStatuses.length, succeeded, failed },
        steps,
      },
      signal,
    );
    if (signal.aborted) return;
    await db
      .updateTable('tasks')
      .set({
        result_json: JSON.stringify({
          ...result,
          aiAnalysis: analysis ? { status: 'SUCCESS', ...analysis } : { status: 'UNAVAILABLE' },
        }),
      })
      .where('id', '=', task.id)
      .where('status', '=', row.status)
      .where('result_json', row.result_json === null ? 'is' : '=', row.result_json)
      .execute();
  }
}
