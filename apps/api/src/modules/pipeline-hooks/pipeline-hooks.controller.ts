import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public, Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { SavePipelineWebhookDto } from './pipeline-hooks.dto';
import { PipelineHooksService } from './pipeline-hooks.service';

@Controller('pipelines/:id/webhook')
@Roles('ADMIN')
export class PipelineHookSettingsController {
  constructor(private readonly hooks: PipelineHooksService) {}

  @Get()
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.hooks.get(id);
  }

  @Put()
  save(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() input: SavePipelineWebhookDto,
    @Req() req: AuthRequest,
  ) {
    return this.hooks.save(id, input, req.user.id);
  }

  @Post('preview')
  preview(@Param('id', new ParseUUIDPipe()) id: string, @Body() input: SavePipelineWebhookDto) {
    return this.hooks.previewBinding(id, input);
  }
}

@Controller('webhooks/gitea')
export class GiteaWebhookController {
  constructor(private readonly hooks: PipelineHooksService) {}

  @Post(':id')
  @HttpCode(200)
  @Public('webhook')
  deliver(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('x-gitea-event') event: string | undefined,
    @Headers('x-gitea-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.hooks.deliver(id, event, signature, req.rawBody);
  }
}
