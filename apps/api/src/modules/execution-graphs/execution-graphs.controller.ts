import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import {
  ExpectedGraphRevisionDto,
  SaveGraphDraftDto,
  ValidateGraphDraftDto,
} from './execution-graph-definition';
import { ExecutionGraphsService } from './execution-graphs.service';
import { GraphCompileError, graphCatalog, safeGraphId } from './graph-fields';
import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
import { ExpandGraphTemplateDto, graphFlowTemplates } from './graph-flow-templates';

@Controller('projects/:projectId/execution-graph')
export class ExecutionGraphsController {
  constructor(private readonly graphs: ExecutionGraphsService) {}

  @Post('versions/:version/retire')
  @Roles('ADMIN', 'OPERATOR')
  retire(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() req: AuthRequest,
  ) {
    return this.graphs.retire(projectId, version, req.user.id);
  }

  @Get()
  get(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.graphs.get(projectId);
  }
  @Get('catalog')
  async catalog(@Param('projectId', ParseUUIDPipe) projectId: string) {
    await this.graphs.get(projectId);
    return { ...graphCatalog, flowTemplates: graphFlowTemplates };
  }
  @Post('draft/templates/expand')
  @Roles('ADMIN', 'OPERATOR')
  expandTemplate(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: ExpandGraphTemplateDto,
  ) {
    return this.graphs.expandTemplate(projectId, input);
  }
  @Post('catalog')
  @Roles('ADMIN', 'OPERATOR')
  async draftCatalog(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('flow') flowId: string,
    @Query('node') nodeId: string,
    @Body() input: ValidateGraphDraftDto,
  ) {
    if (!safeGraphId(flowId) || !safeGraphId(nodeId))
      throw new BadRequestException('请选择要查看的开始节点与功能节点');
    return {
      ...graphCatalog,
      flows: await this.graphs.draftCatalog(projectId, input.definition, flowId, nodeId),
    };
  }
  @Post('validate')
  @Roles('ADMIN', 'OPERATOR')
  validate(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: ValidateGraphDraftDto,
  ) {
    return this.graphs.validate(projectId, input.definition);
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
  async publish(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() input: ExpectedGraphRevisionDto,
    @Req() req: AuthRequest,
  ) {
    try {
      return await this.graphs.publish(projectId, input.expectedRevision, req.user.id);
    } catch (error) {
      if (!(error instanceof GraphCompileError)) throw error;
      throw new ExecutionPlanIssueError({ code: 'CONFIGURATION', ...error.issue });
    }
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
}
