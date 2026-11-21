import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { DeploymentSelectionDto } from '../deployment-targets/deployment-selection';
import { GraphRunnerService } from './graph-runner.service';
import { GraphReleaseInspectionService } from './graph-release-inspection.service';

export class GraphInputsDto extends DeploymentSelectionDto {
  @IsOptional() @IsObject() parameters?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) value?: string;
  @IsOptional() @IsUUID() environmentId?: string;
  @IsOptional() @Matches(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i) commitSha?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  artifactIds?: string[];
}
export class GraphPreviewDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => GraphInputsDto) inputs?: GraphInputsDto;
}
export class GraphRunDto extends GraphPreviewDto {
  @Matches(/^[a-f0-9]{64}$/) expectedConfigurationHash!: string;
  @IsOptional() @IsObject() expectedPlanSections?: Record<string, string>;
  @Matches(/^[a-zA-Z0-9_-]{1,120}$/) idempotencyKey!: string;
}

export class GraphApprovalDecisionDto {
  @IsIn(['APPROVE', 'REJECT']) decision!: 'APPROVE' | 'REJECT';
  @IsOptional() @Matches(/^[a-f0-9]{64}$/) expectedScopeHash?: string;
}

@Controller('projects/:id/execution-graph')
export class GraphRunnerController {
  constructor(
    private readonly runner: GraphRunnerService,
    private readonly inspections: GraphReleaseInspectionService,
  ) {}

  @Post('flows/:flowId/preview')
  @Roles('ADMIN', 'OPERATOR')
  preview(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('flowId') flowId: string,
    @Body() body: GraphPreviewDto,
  ) {
    return this.runner.preview(projectId, flowId, body);
  }

  @Post('flows/:flowId/run')
  @Roles('ADMIN', 'OPERATOR')
  run(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('flowId') flowId: string,
    @Body() body: GraphRunDto,
    @Req() req: AuthRequest,
  ) {
    return this.runner.run(projectId, flowId, body, req.user.id);
  }

  @Get('runs')
  list(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Query('before', new ParseUUIDPipe({ optional: true })) before?: string,
  ) {
    return this.runner.list(projectId, before);
  }

  @Get('runs/:runId')
  get(@Param('id', ParseUUIDPipe) projectId: string, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.runner.get(projectId, runId);
  }

  @Post('runs/:runId/nodes/:nodeId/decision')
  @Roles('ADMIN')
  decideApproval(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: GraphApprovalDecisionDto,
    @Req() req: AuthRequest,
  ) {
    return this.runner.decideApproval(
      projectId,
      runId,
      nodeId,
      body.decision,
      req.user.id,
      body.expectedScopeHash,
    );
  }

  @Post('runs/:runId/cancel')
  @Roles('ADMIN', 'OPERATOR')
  cancel(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Req() req: AuthRequest,
  ) {
    return this.runner.cancel(projectId, runId, req.user.id);
  }

  @Post('runs/:runId/nodes/:nodeId/targets/:serverId/inspect-release')
  @Roles('ADMIN', 'OPERATOR')
  inspectRelease(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('nodeId') nodeId: string,
    @Param('serverId', ParseUUIDPipe) serverId: string,
    @Req() req: AuthRequest,
  ) {
    return this.inspections.inspect(projectId, runId, nodeId, serverId, req.user);
  }
}
