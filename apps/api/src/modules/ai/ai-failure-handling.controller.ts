import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, Req } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { Roles } from '../auth/auth.decorators';
import { AuthRequest } from '../auth/auth.guard';
import type { InitializationComponent } from './ai-deployment-tools.service';
import { AiFailureHandlingService } from './ai-failure-handling.service';

class FailureSettingsDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional()
  @IsIn(['docker', 'node', 'nginx', 'compose'])
  component?: InitializationComponent | null;
}
@Controller('ai/services/:serviceId/environments/:environmentId/failure-handling')
export class AiFailureHandlingController {
  constructor(private readonly failures: AiFailureHandlingService) {}
  @Get() get(
    @Param('serviceId', ParseUUIDPipe) service: string,
    @Param('environmentId', ParseUUIDPipe) env: string,
    @Req() req: AuthRequest,
    @Query('taskId', new ParseUUIDPipe({ optional: true })) taskId?: string,
  ) {
    return this.failures.view(service, env, req.user, taskId);
  }
  @Roles('ADMIN') @Patch() configure(
    @Param('serviceId', ParseUUIDPipe) service: string,
    @Param('environmentId', ParseUUIDPipe) env: string,
    @Body() input: FailureSettingsDto,
    @Req() req: AuthRequest,
  ) {
    return this.failures.configure(service, env, input, req.user);
  }
}
