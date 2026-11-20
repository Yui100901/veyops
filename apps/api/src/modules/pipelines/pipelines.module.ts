import { Global, Module } from '@nestjs/common';
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
    ArtifactsController,
    DeploymentsController,
    ReleaseRequestsController,
    RegistriesController,
  ],
  providers: [
    PipelinesService,
    PipelineExecutor,
    BuildsService,
    ArtifactsService,
    DeploymentsService,
    ReleaseRequestsService,
    RegistriesService,
  ],
  exports: [PipelinesService, ArtifactsService, DeploymentsService, RegistriesService],
})
export class PipelinesModule {}
