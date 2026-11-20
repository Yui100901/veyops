import { Module } from '@nestjs/common';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { ExecutionGraphsController } from './execution-graphs.controller';
import { ExecutionGraphsService } from './execution-graphs.service';
import { GraphRunnerController } from './graph-runner.controller';
import { GraphRunnerService } from './graph-runner.service';
import { GraphTriggerHooksController, GraphTriggersController } from './graph-triggers.controller';
import { GraphTriggersService } from './graph-triggers.service';
import { CommandCenterModule } from '../command-center/command-center.module';
import { GraphNodeTasks } from './graph-node-tasks';

@Module({
  imports: [PipelinesModule, CommandCenterModule],
  controllers: [
    ExecutionGraphsController,
    GraphRunnerController,
    GraphTriggersController,
    GraphTriggerHooksController,
  ],
  providers: [ExecutionGraphsService, GraphRunnerService, GraphTriggersService, GraphNodeTasks],
})
export class ExecutionGraphsModule {}
