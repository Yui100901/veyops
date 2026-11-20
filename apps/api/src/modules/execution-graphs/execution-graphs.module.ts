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
import { GraphMigrationController } from './graph-migration.controller';
import { GraphMigrationService } from './graph-migration.service';

@Module({
  imports: [PipelinesModule, CommandCenterModule],
  controllers: [
    ExecutionGraphsController,
    GraphRunnerController,
    GraphTriggersController,
    GraphTriggerHooksController,
    GraphMigrationController,
  ],
  providers: [
    ExecutionGraphsService,
    GraphRunnerService,
    GraphTriggersService,
    GraphNodeTasks,
    GraphMigrationService,
  ],
})
export class ExecutionGraphsModule {}
