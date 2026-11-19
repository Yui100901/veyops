import { Module } from '@nestjs/common';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { ExecutionGraphsController } from './execution-graphs.controller';
import { ExecutionGraphsService } from './execution-graphs.service';
import { GraphRunnerController } from './graph-runner.controller';
import { GraphRunnerService } from './graph-runner.service';

@Module({
  imports: [PipelinesModule],
  controllers: [ExecutionGraphsController, GraphRunnerController],
  providers: [ExecutionGraphsService, GraphRunnerService],
})
export class ExecutionGraphsModule {}
