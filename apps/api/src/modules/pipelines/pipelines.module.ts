import { Global, Module } from '@nestjs/common';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import { PipelineExecutor } from './pipeline-executor.service';
import { BuildsService } from '../builds/builds.service';
import { ArtifactsController, ArtifactsService } from '../artifacts/artifacts.service';
import { DeploymentsController, DeploymentsService } from '../deployments/deployments.service';
import { RegistriesController, RegistriesService } from '../registries/registries.service';
@Global()
@Module({
  controllers: [
    PipelinesController,
    ArtifactsController,
    DeploymentsController,
    RegistriesController,
  ],
  providers: [
    PipelinesService,
    PipelineExecutor,
    BuildsService,
    ArtifactsService,
    DeploymentsService,
    RegistriesService,
  ],
  exports: [PipelinesService, ArtifactsService, DeploymentsService, RegistriesService],
})
export class PipelinesModule {}
