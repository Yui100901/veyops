import { Global, Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TaskHandlerRegistry } from './task-handler.registry';
import { TaskLogService } from './task-log.service';
import { TaskWorkerService } from './task-worker.service';

@Global()
@Module({
  controllers: [TasksController],
  providers: [TasksService, TaskHandlerRegistry, TaskLogService, TaskWorkerService],
  exports: [TasksService, TaskHandlerRegistry],
})
export class TasksModule {}
