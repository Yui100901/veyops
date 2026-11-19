import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { PipelineTriggerDto, SavePipelineTriggerDto } from './pipeline-trigger.dto';
import { PipelineTriggersService } from './pipeline-triggers.service';

@Controller('pipelines/:id/triggers')
export class PipelineTriggersController {
  constructor(private readonly triggers: PipelineTriggersService) {}
  @Get() list(@Param('id') id: string) {
    return this.triggers.list(id);
  }
  @Get('history') history(@Param('id') id: string) {
    return this.triggers.history(id);
  }
  @Post('preview') @Roles('ADMIN') preview(
    @Param('id') id: string,
    @Body() input: PipelineTriggerDto,
  ) {
    return this.triggers.preview(id, input);
  }
  @Post() @Roles('ADMIN') save(
    @Param('id') id: string,
    @Body() input: SavePipelineTriggerDto,
    @Req() req: AuthRequest,
  ) {
    return this.triggers.save(id, input, req.user.id);
  }
  @Post(':ruleId') @Roles('ADMIN') edit(
    @Param('id') id: string,
    @Param('ruleId') ruleId: string,
    @Body() input: SavePipelineTriggerDto,
    @Req() req: AuthRequest,
  ) {
    return this.triggers.save(id, input, req.user.id, ruleId);
  }
  @Post(':ruleId/disable') @Roles('ADMIN') disable(
    @Param('id') id: string,
    @Param('ruleId') ruleId: string,
    @Req() req: AuthRequest,
  ) {
    return this.triggers.disable(id, ruleId, req.user.id);
  }
}
