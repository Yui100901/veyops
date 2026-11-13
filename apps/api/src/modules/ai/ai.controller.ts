import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { AuthRequest } from '../auth/auth.guard';
import { AiChatDto, AiPolicyDto, CreateAiProviderDto, UpdateAiProviderDto } from './ai.dto';
import { AiProvidersService } from './ai-providers.service';
import { AiService } from './ai.service';
import { AiPolicyService } from './ai-policy.service';
import { AiProposalsService } from './ai-proposals.service';

@Controller('ai')
export class AiController {
  constructor(
    private readonly providers: AiProvidersService,
    private readonly ai: AiService,
    private readonly policy: AiPolicyService,
    private readonly proposals: AiProposalsService,
  ) {}
  @Get('providers') listProviders() {
    return this.providers.list();
  }
  @Roles('ADMIN') @Post('providers') createProvider(
    @Body() input: CreateAiProviderDto,
    @Req() req: AuthRequest,
  ) {
    return this.providers.create(input, req.user.id);
  }
  @Roles('ADMIN') @Patch('providers/:id') updateProvider(
    @Param('id') id: string,
    @Body() input: UpdateAiProviderDto,
    @Req() req: AuthRequest,
  ) {
    return this.providers.update(id, input, req.user.id);
  }
  @Roles('ADMIN') @Delete('providers/:id') removeProvider(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.providers.remove(id, req.user.id);
  }
  @Roles('ADMIN') @Post('providers/:id/test') testProvider(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.providers.test(id, req.user.id);
  }
  @Get('policies') listPolicies() {
    return this.policy.list();
  }
  @Roles('ADMIN') @Patch('policies') updatePolicy(
    @Body() input: AiPolicyDto,
    @Req() req: AuthRequest,
  ) {
    return this.policy.update(input, req.user);
  }
  @Post('chat') chat(@Body() input: AiChatDto, @Req() req: AuthRequest) {
    return this.ai.chat(input, req.user);
  }
  @Get('conversations') conversations(@Req() req: AuthRequest) {
    return this.ai.conversations(req.user.id);
  }
  @Get('conversations/:id/messages') messages(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.ai.messages(id, req.user.id);
  }
  @Get('proposals') listProposals(@Req() req: AuthRequest) {
    return this.proposals.list(req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post('proposals/:id/confirm') confirm(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.proposals.confirm(id, req.user);
  }
  @Post('proposals/:id/reject') reject(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.proposals.reject(id, req.user);
  }
}
