import { Injectable, OnModuleInit } from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import { ExecuteCommandDto, TargetSelectionDto } from './command.dto';
import { TargetResolver } from './target-resolver.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { MultiTargetExecutor } from '../../infrastructure/ssh/multi-target.executor';
import { AuditService } from '../audit/audit.service';
import type { Database } from '../../core/database/schema';
import type { Transaction } from 'kysely';
import type { CreateTaskInput, TaskPayload } from '../tasks/tasks.types';
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
  async prepareExecution(
    input: ExecuteCommandDto,
    template?: TaskPayload['commandTemplate'],
  ): Promise<CreateTaskInput> {
    const scope = await this.targets.executionScope(input);
    return {
      type: 'COMMAND',
      name: input.name ?? '临时命令',
      scope,
      payload: {
        targets: await this.targets.resolveForExecution(input),
        steps: [{ name: '执行命令', command: input.command }],
        strategy: input.strategy,
        maxParallel:
          input.maxParallel ??
          (await this.settings.get(scope?.projectId)).defaultMaxParallelTargets,
        failurePolicy: input.failurePolicy,
        timeout: input.timeout,
        commandTemplate: template,
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
  async execute(
    input: ExecuteCommandDto,
    userId: string,
    template?: TaskPayload['commandTemplate'],
    beforeInsert?: (tx: Transaction<Database>) => Promise<void>,
  ) {
    return this.submitPrepared(await this.prepareExecution(input, template), userId, beforeInsert);
  }
  async submitPrepared(
    input: CreateTaskInput,
    userId: string,
    beforeInsert?: (tx: Transaction<Database>) => Promise<void>,
  ) {
    const task = await this.tasks.create(input, userId, beforeInsert);
    const template = input.payload.commandTemplate;
    await this.audit.record(userId, 'command.execute', 'task', task.id, {
      targetCount: (await this.tasks.targets(task.id)).length,
      ...(template ? { templateId: template.id, version: template.version } : {}),
    });
    return task;
  }
  history() {
    return this.tasks.list('COMMAND');
  }
}
