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
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsInt,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { artifactCleanupBatch, ArtifactRetentionService } from './artifact-retention.service';

class ScopeQuery {
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

class PruneDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(artifactCleanupBatch)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  artifactIds!: string[];

  @Equals(true)
  confirmed!: true;
}

class PinDto {
  @IsBoolean()
  pinned!: boolean;
}

function artifactScope({ serviceId, environmentId }: ScopeQuery) {
  if (!serviceId && !environmentId) return undefined;
  if (!serviceId || !environmentId) throw new BadRequestException('请同时指定服务和环境');
  return { serviceId, environmentId };
}

@Controller('artifact-retention')
@Roles('ADMIN')
class ArtifactRetentionController {
  constructor(private readonly service: ArtifactRetentionService) {}

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

  @Post('prune')
  prune(@Body() input: PruneDto, @Req() req: AuthRequest) {
    return this.service.prune(input.artifactIds, req.user.id);
  }

  @Put('artifacts/:id/pin')
  pin(@Param('id', ParseUUIDPipe) id: string, @Body() body: PinDto, @Req() req: AuthRequest) {
    return this.service.pin(id, body.pinned, req.user.id);
  }
}

@Global()
@Module({
  providers: [ArtifactRetentionService],
  controllers: [ArtifactRetentionController],
  exports: [ArtifactRetentionService],
})
export class ArtifactRetentionModule {}
