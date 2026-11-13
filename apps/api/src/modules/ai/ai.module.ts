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
@Global()
@Module({
  imports: [CommandCenterModule],
  controllers: [AiController],
  providers: [
    AiRepository,
    AiProvidersService,
    AiPolicyService,
    AiToolsService,
    AiProposalsService,
    AiService,
    OpenAiCompatibleService,
  ],
  exports: [AiProvidersService, AiService],
})
export class AiModule {}
