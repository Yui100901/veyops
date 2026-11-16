import { Global, Module } from '@nestjs/common';
import { CommandCenterModule } from '../command-center/command-center.module';
import { OpenAiCompatibleService } from '../../infrastructure/ai-provider/openai-compatible.service';
import { AiRepository } from './ai.repository';
import { AiProvidersService } from './ai-providers.service';
import { AiPolicyService } from './ai-policy.service';
import { AiToolsService } from './ai-tools.service';
import { AiProposalsService } from './ai-proposals.service';
import { AiService } from './ai.service';
import { AiController } from './ai.controller';
import { AiPipelineAnalyzer } from './ai-pipeline-analyzer.service';
import { PipelineAnalysisService } from './pipeline-analysis.service';
import { AiRepositoryAnalysisService } from './ai-repository-analysis.service';
import { AiDeploymentToolsService } from './ai-deployment-tools.service';
import { AiSourceChangeService } from './ai-source-change.service';
import { OperationPlansModule } from '../operation-plans/operation-plans.module';
@Global()
@Module({
  imports: [CommandCenterModule, OperationPlansModule],
  controllers: [AiController],
  providers: [
    AiRepository,
    AiProvidersService,
    AiPolicyService,
    AiToolsService,
    AiProposalsService,
    AiService,
    OpenAiCompatibleService,
    AiPipelineAnalyzer,
    PipelineAnalysisService,
    AiRepositoryAnalysisService,
    AiDeploymentToolsService,
    AiSourceChangeService,
  ],
  exports: [AiProvidersService, AiService, PipelineAnalysisService],
})
export class AiModule {}
