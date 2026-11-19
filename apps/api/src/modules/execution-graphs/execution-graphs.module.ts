import { Module } from '@nestjs/common';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { ExecutionGraphsController } from './execution-graphs.controller';
import { ExecutionGraphsService } from './execution-graphs.service';
import { GraphRunnerController } from './graph-runner.controller';
import { GraphRunnerService } from './graph-runner.service';
import { GraphTriggerHooksController, GraphTriggersController } from './graph-triggers.controller';
import { GraphTriggersService } from './graph-triggers.service';

@Module({
  imports: [PipelinesModule],
  controllers: [
    ExecutionGraphsController,
    GraphRunnerController,
    GraphTriggersController,
    GraphTriggerHooksController,
  ],
  providers: [ExecutionGraphsService, GraphRunnerService, GraphTriggersService],
})
export class ExecutionGraphsModule {}
