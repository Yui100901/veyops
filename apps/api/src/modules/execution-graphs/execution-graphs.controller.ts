import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import {
  ExpectedGraphRevisionDto,
  ExtractGraphFlowDto,
  SaveGraphDraftDto,
} from './execution-graph-definition';
import { ExecutionGraphsService } from './execution-graphs.service';

@Controller('projects/:projectId/execution-graph')
export class ExecutionGraphsController {
  constructor(private readonly graphs: ExecutionGraphsService) {}

  @Get()
  get(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.graphs.get(projectId);
  }
  @Put('draft')
  @Roles('ADMIN', 'OPERATOR')
  save(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: SaveGraphDraftDto,
    @Req() req: AuthRequest,
  ) {
    return this.graphs.save(projectId, input, req.user.id);
  }
  @Post('publish')
  @Roles('ADMIN', 'OPERATOR')
  publish(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: ExpectedGraphRevisionDto,
    @Req() req: AuthRequest,
  ) {
    return this.graphs.publish(projectId, input.expectedRevision, req.user.id);
  }
  @Get('versions')
  versions(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.graphs.versions(projectId);
  }
  @Get('versions/:version')
  version(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.graphs.version(projectId, version);
  }
  @Post('versions/:version/restore')
  @Roles('ADMIN', 'OPERATOR')
  restore(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() input: ExpectedGraphRevisionDto,
    @Req() req: AuthRequest,
  ) {
    return this.graphs.restore(projectId, version, input.expectedRevision, req.user.id);
  }
  @Post('extract/preview')
  @Roles('ADMIN', 'OPERATOR')
  previewExtraction(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: ExtractGraphFlowDto,
  ) {
    return this.graphs.previewExtraction(projectId, input);
  }
  @Post('extract')
  @Roles('ADMIN', 'OPERATOR')
  extract(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: ExtractGraphFlowDto,
    @Req() req: AuthRequest,
  ) {
    return this.graphs.extract(projectId, input, req.user.id);
  }
}
