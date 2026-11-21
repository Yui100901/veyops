import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  IsUUID,
  Max,
  Min,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { artifactCleanupBatch, ArtifactRetentionService } from './artifact-retention.service';
import { ArtifactCleanupService } from './artifact-cleanup.service';

class ScopeQuery {
  @ValidateIf((_input, value) => value !== undefined)
  @IsUUID()
  projectId?: string;

  @ValidateIf((_input, value) => value !== undefined)
  @IsUUID()
  serviceId?: string;

  @ValidateIf((_input, value) => value !== undefined)
  @IsUUID()
  environmentId?: string;
}

class PolicyDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  maxBuilds!: number;

  @IsInt()
  @Min(1)
  @Max(3650)
  maxDays!: number;
}

class ArtifactRefDto {
  @IsUUID()
  artifactId!: string;

  @ValidateIf((_input, value) => value !== undefined)
  @IsUUID()
  instanceId?: string;
}

class CleanupPreviewDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(artifactCleanupBatch)
  @ValidateNested({ each: true })
  @Type(() => ArtifactRefDto)
  artifacts!: ArtifactRefDto[];
}

class PruneDto {
  @ValidateIf((_input, value) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(artifactCleanupBatch)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  artifactIds?: string[];

  @ValidateIf((_input, value) => value !== undefined)
  @Equals(true)
  confirmed?: true;

  @ValidateIf((_input, value) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(artifactCleanupBatch)
  @ValidateNested({ each: true })
  @Type(() => ArtifactRefDto)
  artifacts?: ArtifactRefDto[];

  @ValidateIf((_input, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  planDigest?: string;

  @ValidateIf((_input, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,120}$/)
  idempotencyKey?: string;
}

class PinDto {
  @IsBoolean()
  pinned!: boolean;
}

function artifactScope({ projectId, serviceId, environmentId }: ScopeQuery) {
  if (!projectId && !serviceId && !environmentId) return undefined;
  if (environmentId && !serviceId) throw new BadRequestException('旧服务环境策略需要同时指定服务');
  return { projectId, serviceId, environmentId };
}

@Controller('artifact-retention')
@Roles('ADMIN')
class ArtifactRetentionController {
  constructor(
    private readonly service: ArtifactRetentionService,
    private readonly cleanup: ArtifactCleanupService,
  ) {}

  @Get('policy')
  policy(@Query() query: ScopeQuery) {
    return this.service.settings(artifactScope(query));
  }

  @Put('policy')
  configure(@Query() query: ScopeQuery, @Body() policy: PolicyDto, @Req() req: AuthRequest) {
    return this.service.configure(policy, req.user.id, artifactScope(query));
  }

  @Delete('policy')
  inherit(@Query() query: ScopeQuery, @Req() req: AuthRequest) {
    return this.service.configure(null, req.user.id, artifactScope(query));
  }

  @Get('preview')
  preview() {
    return this.service.preview();
  }

  @Post('preview')
  cleanupPreview(@Body() input: CleanupPreviewDto) {
    return this.cleanup.preview(input.artifacts);
  }

  @Post('prune')
  prune(@Body() input: PruneDto, @Req() req: AuthRequest) {
    if (input.artifacts && input.planDigest && input.idempotencyKey && !input.artifactIds)
      return this.cleanup.confirm(
        input.artifacts,
        input.planDigest,
        input.idempotencyKey,
        req.user.id,
      );
    if (
      input.artifactIds &&
      input.confirmed &&
      !input.artifacts &&
      !input.planDigest &&
      !input.idempotencyKey
    )
      return this.service.prune(input.artifactIds, req.user.id);
    throw new BadRequestException('请提交已预览的产物、计划摘要及幂等键');
  }

  @Get('jobs/:id')
  job(@Param('id', ParseUUIDPipe) id: string) {
    return this.cleanup.get(id);
  }

  @Post('jobs/:id/retry')
  retry(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.cleanup.retry(id, req.user.id);
  }

  @Put('artifacts/:id/pin')
  pin(@Param('id', ParseUUIDPipe) id: string, @Body() body: PinDto, @Req() req: AuthRequest) {
    return this.service.pin(id, body.pinned, req.user.id);
  }
}

@Global()
@Module({
  providers: [ArtifactRetentionService, ArtifactCleanupService],
  controllers: [ArtifactRetentionController],
  exports: [ArtifactRetentionService],
})
export class ArtifactRetentionModule {}
