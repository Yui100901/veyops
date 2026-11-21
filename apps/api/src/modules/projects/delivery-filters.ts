import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DeliveryFilters {
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsUUID() environmentId?: string;
  @IsOptional() @Matches(/^[a-f\d]{1,64}$/i) commit?: string;
}

export class DeliveryRecordFilters extends DeliveryFilters {
  @IsOptional() @IsUUID() repositoryId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() recordId?: string;
  @IsOptional() @IsUUID() pipelineRunId?: string;
  @IsOptional() @IsUUID() taskId?: string;
}

export class ArtifactFilters extends DeliveryRecordFilters {
  @IsOptional() @IsUUID() environmentSetId?: string;
  @IsOptional() @IsUUID() serverId?: string;
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsString() @MaxLength(300) ref?: string;
  @IsOptional() @Matches(/^[a-f\d]{1,64}$/i) commitSha?: string;
  @IsOptional() @IsIn(['FILE', 'DIRECTORY', 'DOCKER_IMAGE']) kind?: string;
  @IsOptional()
  @IsIn(['NOT_CHECKED', 'AVAILABLE', 'MISSING', 'CHANGED', 'UNVERIFIABLE'])
  verificationStatus?: string;
}
