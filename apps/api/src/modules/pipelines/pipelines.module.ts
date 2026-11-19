import { PipelineTriggersController } from '../pipeline-triggers/pipeline-triggers.controller';
import { PipelineTriggersService } from '../pipeline-triggers/pipeline-triggers.service';
import { Global, Module } from '@nestjs/common';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import { PipelineExecutor } from './pipeline-executor.service';
import { BuildsService } from '../builds/builds.service';
import { ArtifactsController, ArtifactsService } from '../artifacts/artifacts.service';
import { DeploymentsController, DeploymentsService } from '../deployments/deployments.service';
import { RegistriesController, RegistriesService } from '../registries/registries.service';
import {
  ReleaseRequestsController,
  ReleaseRequestsService,
} from '../deployments/release-requests.service';
@Global()
@Module({
  controllers: [
    PipelineTriggersController,
    PipelinesController,
    ArtifactsController,
    DeploymentsController,
    ReleaseRequestsController,
    RegistriesController,
  ],
  providers: [
    PipelineTriggersService,
    PipelinesService,
    PipelineExecutor,
    BuildsService,
    ArtifactsService,
    DeploymentsService,
    ReleaseRequestsService,
    RegistriesService,
  ],
  exports: [
    PipelineTriggersService,
    PipelinesService,
    ArtifactsService,
    DeploymentsService,
    RegistriesService,
  ],
})
export class PipelinesModule {}
