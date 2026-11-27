import { Injectable, OnModuleInit } from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import { ExecuteCommandDto, TargetSelectionDto } from './command.dto';
import { TargetResolver } from './target-resolver.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { MultiTargetExecutor } from '../../infrastructure/ssh/multi-target.executor';
import { AuditService } from '../audit/audit.service';
import type { CreateTaskInput } from '../tasks/tasks.types';
import { SystemSettingsService } from '../system/system-settings.service';

@Injectable()
export class CommandCenterService implements OnModuleInit {
  constructor(
    private readonly tasks: TasksService,
    private readonly targets: TargetResolver,
    private readonly registry: TaskHandlerRegistry,
    private readonly executor: MultiTargetExecutor,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
  ) {}
  onModuleInit() {
    this.registry.register({
      type: 'COMMAND',
      execute: (task, context) => this.executor.execute(task, context),
    });
  }
  preview(input: TargetSelectionDto) {
    return this.targets.preview(input);
  }
  private async prepareExecution(input: ExecuteCommandDto): Promise<CreateTaskInput> {
    const scope = await this.targets.executionScope(input);
    const settings = await this.settings.get(scope?.projectId);
    return {
      type: 'COMMAND',
      name: input.name ?? '临时命令',
      scope,
      payload: {
        ...(input.interactive && { interactive: true }),
        targets: await this.targets.resolveForExecution(input),
        steps: [{ name: '执行命令', command: input.command }],
        strategy: input.strategy,
        maxParallel: input.maxParallel ?? settings.defaultMaxParallelTargets,
        failurePolicy: input.failurePolicy ?? settings.defaultOperationFailurePolicy,
        timeout: input.timeout ?? settings.defaultOperationTimeoutSeconds,
        commandSelection: {
          targets: {
            serverIds: input.serverIds,
            groupIds: input.groupIds,
            deploymentTargetIds: input.deploymentTargetIds,
            tags: input.tags,
            projectIds: input.projectIds,
            environmentIds: input.environmentIds,
          },
          confirmedTargetHash: input.expectedTargetHash,
        },
      },
    };
  }
  async execute(input: ExecuteCommandDto, userId: string) {
    const task = await this.tasks.create(await this.prepareExecution(input), userId);
    await this.audit.record(userId, 'command.execute', 'task', task.id, {
      targetCount: (await this.tasks.targets(task.id)).length,
    });
    return task;
  }
  history() {
    return this.tasks.list('COMMAND');
  }
}
