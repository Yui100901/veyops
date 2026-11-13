import { Injectable, OnModuleInit } from '@nestjs/common';
import { TasksService } from '../tasks/tasks.service';
import { ExecuteCommandDto, TargetSelectionDto } from './command.dto';
import { TargetResolver } from './target-resolver.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { MultiTargetExecutor } from '../../infrastructure/ssh/multi-target.executor';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class CommandCenterService implements OnModuleInit {
  constructor(
    private readonly tasks: TasksService,
    private readonly targets: TargetResolver,
    private readonly registry: TaskHandlerRegistry,
    private readonly executor: MultiTargetExecutor,
    private readonly audit: AuditService,
  ) {}
  onModuleInit() {
    this.registry.register({
      type: 'COMMAND',
      execute: (task, context) => this.executor.execute(task, context),
    });
  }
  async preview(input: TargetSelectionDto) {
    const targets = await this.targets.resolve(input);
    return {
      count: targets.length,
      targets: targets.map((server) => ({ id: server.id, name: server.name, host: server.host })),
    };
  }
  async execute(input: ExecuteCommandDto, userId: string) {
    const task = await this.tasks.create(
      {
        type: 'COMMAND',
        name: input.name ?? '临时命令',
        payload: {
          targets: await this.targets.resolve(input),
          steps: [{ name: '执行命令', command: input.command }],
          strategy: input.strategy,
          maxParallel: input.maxParallel,
          failurePolicy: input.failurePolicy,
          timeout: input.timeout,
        },
      },
      userId,
    );
    await this.audit.record(userId, 'command.execute', 'task', task.id, {
      targetCount: (await this.tasks.targets(task.id)).length,
    });
    return task;
  }
  history() {
    return this.tasks.list('COMMAND');
  }
}
