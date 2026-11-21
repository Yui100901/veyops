import { Global, Module } from '@nestjs/common';
import { PipelinesModule } from '../../modules/pipelines/pipelines.module';
import { PipelinesController } from '../../modules/pipelines/pipelines.controller';
import { PipelineTriggersController } from '../../modules/pipeline-triggers/pipeline-triggers.controller';
import { PipelineTriggersService } from '../../modules/pipeline-triggers/pipeline-triggers.service';
import { PipelineHooksModule } from '../../modules/pipeline-hooks/pipeline-hooks.module';
import { LegacyDeliveryWriteFixtureModule } from './legacy-delivery-write-fixture.module';

/** Historical delivery and trigger regressions can still exercise the underlying executor. */
@Global()
@Module({
  imports: [PipelinesModule, PipelineHooksModule, LegacyDeliveryWriteFixtureModule],
  controllers: [PipelinesController, PipelineTriggersController],
  providers: [PipelineTriggersService],
  exports: [PipelineTriggersService],
})
export class LegacyDeliveryFixtureModule {}
