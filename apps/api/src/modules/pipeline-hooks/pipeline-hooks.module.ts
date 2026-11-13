import { Module } from '@nestjs/common';
import { PipelinesModule } from '../pipelines/pipelines.module';
import {
  GiteaWebhookController,
  PipelineHookSettingsController,
} from './pipeline-hooks.controller';
import { PipelineHooksService } from './pipeline-hooks.service';

@Module({
  imports: [PipelinesModule],
  controllers: [PipelineHookSettingsController, GiteaWebhookController],
  providers: [PipelineHooksService],
})
export class PipelineHooksModule {}
