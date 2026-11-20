import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import {
  GraphMigrationComparisonDto,
  RestoreGraphMigrationDto,
  StageGraphMigrationDto,
  SwitchGraphMigrationDto,
} from './graph-migration.dto';
import { GraphMigrationService } from './graph-migration.service';

@Controller('projects/:id/execution-graph/migration')
@Roles('ADMIN', 'OPERATOR')
export class GraphMigrationController {
  constructor(private readonly migration: GraphMigrationService) {}

  @Get()
  get(@Param('id', ParseUUIDPipe) projectId: string) {
    return this.migration.preview(projectId);
  }

  @Post('preview')
  preview(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() input: GraphMigrationComparisonDto,
  ) {
    return this.migration.preview(projectId, input);
  }

  @Post('stage')
  @Roles('ADMIN')
  stage(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() input: StageGraphMigrationDto,
    @Req() req: AuthRequest,
  ) {
    return this.migration.stage(projectId, input, req.user.id);
  }

  @Post('cutover')
  @Roles('ADMIN')
  cutover(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() input: SwitchGraphMigrationDto,
    @Req() req: AuthRequest,
  ) {
    return this.migration.cutover(projectId, input, req.user.id);
  }

  @Post('restore')
  @Roles('ADMIN')
  restore(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Body() input: RestoreGraphMigrationDto,
    @Req() req: AuthRequest,
  ) {
    return this.migration.restore(projectId, input.cutoverId, input.confirmed, req.user.id);
  }
}
