import { Injectable } from '@nestjs/common';
import { SshExecutionError, SshService } from './ssh.service';
import { TaskExecutionContext, TaskRecord, TaskStatus } from '../../modules/tasks/tasks.types';

@Injectable()
export class MultiTargetExecutor {
  constructor(private readonly ssh: SshService) {}
  async execute(task: TaskRecord, context: TaskExecutionContext): Promise<void> {
    const { targets, steps, strategy, maxParallel, failurePolicy, timeout } = task.payload;
    let index = 0;
    let failed = false;
    const runner = async () => {
      while (!context.signal.aborted && !(failed && failurePolicy === 'STOP')) {
        const position = index++;
        const target = targets[position];
        if (!target) return;
        const targetId = await context.startTarget(target.id);
        let targetStatus: TaskStatus = 'SUCCESS';
        let targetExitCode: number | null = 0;
        let targetError: string | undefined;
        context.log(`\n── ${target.name} (${target.host}) ──\n`, target.id);
        for (const [stepIndex, step] of steps.entries()) {
          if (context.signal.aborted) {
            targetStatus = 'CANCELLED';
            targetExitCode = null;
            targetError = '任务已取消';
            break;
          }
          const stepId = await context.startStep(targetId, target.id, step, stepIndex);
          context.log(`步骤 ${stepIndex + 1}/${steps.length}：${step.name}\n`, target.id);
          let stepStatus: TaskStatus = 'SUCCESS';
          let exitCode: number | null = null;
          let error: string | undefined;
          try {
            const result = await this.ssh.execute(target, step.command, {
              timeout: step.timeout ?? timeout,
              signal: context.signal,
              onData: (text) => context.log(text, target.id),
            });
            exitCode = result.exitCode;
            if (result.exitCode !== 0) {
              stepStatus = 'FAILED';
              error = `命令退出码 ${result.exitCode}`;
            }
          } catch (caught) {
            stepStatus = caught instanceof SshExecutionError ? caught.kind : 'FAILED';
            error = caught instanceof Error ? caught.message : 'SSH 执行失败';
          }
          await context.finishStep(stepId, stepStatus, exitCode, error);
          if (stepStatus !== 'SUCCESS') {
            targetStatus = stepStatus;
            targetExitCode = exitCode;
            targetError = error;
            context.log(`步骤结束：${stepStatus} ${error ?? ''}\n`, target.id);
            if (step.failurePolicy !== 'CONTINUE' || context.signal.aborted) break;
          }
        }
        await context.finishTarget(targetId, targetStatus, targetExitCode, targetError);
        if (targetStatus !== 'SUCCESS') failed = true;
      }
    };
    const count = strategy === 'SEQUENTIAL' ? 1 : Math.min(maxParallel, targets.length);
    await Promise.all(Array.from({ length: count }, runner));
  }
}
