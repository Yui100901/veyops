import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public, Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { GraphTriggerDto, GraphWebhookDto, InvokeGraphTriggerDto } from './graph-trigger.dto';
import { GraphTriggersService } from './graph-triggers.service';

@Controller('projects/:id/execution-graph/triggers')
export class GraphTriggersController {
  constructor(private readonly triggers: GraphTriggersService) {}

  @Get()
  list(@Param('id', ParseUUIDPipe) projectId: string) {
    return this.triggers.list(projectId);
  }

  @Post()
  @Roles('ADMIN')
  create(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() body: GraphTriggerDto,
    @Req() req: AuthRequest,
  ) {
    return this.triggers.save(projectId, body, req.user.id);
  }

  @Patch(':triggerId')
  @Roles('ADMIN')
  update(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('triggerId', ParseUUIDPipe) triggerId: string,
    @Body() body: GraphTriggerDto,
    @Req() req: AuthRequest,
  ) {
    return this.triggers.save(projectId, body, req.user.id, triggerId);
  }

  @Get(':triggerId/events')
  events(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('triggerId', ParseUUIDPipe) triggerId: string,
  ) {
    return this.triggers.events(projectId, triggerId);
  }

  @Post(':triggerId/invoke')
  @HttpCode(202)
  @Roles('ADMIN', 'OPERATOR')
  invoke(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('triggerId', ParseUUIDPipe) triggerId: string,
    @Body() body: InvokeGraphTriggerDto,
    @Req() req: AuthRequest,
  ) {
    return this.triggers.invoke(projectId, triggerId, body, req.user.id);
  }
}

@Controller('graph-webhooks')
export class GraphTriggerHooksController {
  constructor(private readonly triggers: GraphTriggersService) {}

  @Post(':triggerId')
  @HttpCode(202)
  @Public('webhook')
  receive(
    @Param('triggerId', ParseUUIDPipe) triggerId: string,
    @Body() body: GraphWebhookDto,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.triggers.webhook(triggerId, {
      timestamp: req.get('x-veyops-timestamp'),
      eventId: req.get('x-veyops-delivery'),
      signature: req.get('x-veyops-signature'),
      raw: req.is('application/json') ? req.rawBody : undefined,
      inputValue: body.inputValue,
    });
  }
}
