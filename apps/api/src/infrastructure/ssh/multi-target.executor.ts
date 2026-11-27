import { Injectable, Optional } from '@nestjs/common';
import { setTimeout as pause } from 'node:timers/promises';
import { SshExecutionError, SshService, type SshTarget } from './ssh.service';
import { TaskExecutionContext, TaskRecord, TaskStatus } from '../../modules/tasks/tasks.types';
import { InteractiveCommandInputs } from './interactive-command-inputs';

@Injectable()
export class MultiTargetExecutor {
  constructor(
    private readonly ssh: SshService,
    @Optional() private readonly inputs?: InteractiveCommandInputs,
  ) {}
  async execute(task: TaskRecord, context: TaskExecutionContext): Promise<void> {
    const { targets, steps, strategy, maxParallel, failurePolicy, timeout, interactive } =
      task.payload;
    const abortSiblings = new AbortController();
    const signal = AbortSignal.any([context.signal, abortSiblings.signal]);
    let failed = false;
    const runner = async (target: SshTarget, targetId: string) => {
      try {
        let targetStatus: TaskStatus = 'SUCCESS';
        let targetExitCode: number | null = 0;
        let targetError: string | undefined;
        context.log(`\n── ${target.name} (${target.host}) ──\n`, target.id);
        for (const [stepIndex, step] of steps.entries()) {
          if (signal.aborted) {
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
            if (interactive && (!this.inputs || !context.leaseOwner))
              throw new SshExecutionError('交互输入服务或 Worker 租约不可用');
            const result = await this.ssh.execute(target, step.command, {
              timeout: step.timeout ?? timeout,
              signal,
              variables: task.payload.environment,
              onData: (text) => context.log(text, target.id),
              ...(interactive && {
                interactiveInput: (write, inputSignal) =>
                  this.inputs!.receive(task.id, targetId, context.leaseOwner!, write, inputSignal),
              }),
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
            if (
              stepStatus === 'NEEDS_ATTENTION' ||
              stepStatus === 'TIMED_OUT' ||
              step.failurePolicy !== 'CONTINUE' ||
              signal.aborted
            )
              break;
          }
        }
        await context.finishTarget(targetId, targetStatus, targetExitCode, targetError);
        if (targetStatus !== 'SUCCESS') failed = true;
      } finally {
        if (interactive) await this.inputs?.clear(targetId);
      }
    };
    const limit = strategy === 'SEQUENTIAL' ? 1 : Math.min(maxParallel, targets.length);
    if (!limit) return;
    const pending = [...targets];
    const active = new Set<Promise<void>>();
    let firstFailure: { error: unknown } | undefined;
    const stop = (error: unknown) => {
      firstFailure ??= { error };
      abortSiblings.abort();
    };
    const blocked = () => signal.aborted || (failed && failurePolicy === 'STOP');
    try {
      while (pending.length && !blocked()) {
        let started = false;
        if (active.size < limit) {
          for (const [index, target] of pending.entries()) {
            if (blocked()) break;
            const id = context.tryStartTarget
              ? await context.tryStartTarget(target.id)
              : await context.startTarget(target.id);
            if (!id) {
              if (strategy === 'SEQUENTIAL') break;
              continue;
            }
            pending.splice(index, 1);
            const work = runner(target, id)
              .catch(stop)
              .finally(() => active.delete(work));
            active.add(work);
            started = true;
            break;
          }
        }
        if (!started && !blocked()) {
          if (active.size === limit) await Promise.race(active);
          else
            await Promise.race([
              ...active,
              pause(250, undefined, { signal }).catch(() => undefined),
            ]);
        }
      }
    } catch (error) {
      stop(error);
    }
    await Promise.all(active);
    if (firstFailure) throw firstFailure.error;
  }
}
