import { Type } from 'class-transformer';
import { OmitType } from '@nestjs/swagger';
import type { PipelineExecutionMode } from './pipeline.types';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
  ValidateIf,
} from 'class-validator';

export class PipelineStepDto {
  @IsString() @Length(1, 120) name!: string;
  @IsIn(['SHELL']) type = 'SHELL' as const;
  @IsString() @Length(1, 65536) command!: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout?: number;
}
export class PipelineDefinitionDto {
  @IsUUID() repositoryId!: string;
  @IsIn(['TARGET', 'MANAGER']) buildLocation: 'TARGET' | 'MANAGER' = 'TARGET';
  @IsIn(['FILE', 'DOCKER_IMAGE']) artifactType: 'FILE' | 'DOCKER_IMAGE' = 'FILE';
  @IsString() @Length(1, 200) buildImage = 'node:22-bookworm';
  @IsString() @Length(1, 300) repoPath = '.';
  @IsString() @Length(0, 65536) installCommand = '';
  @IsString() @Length(0, 65536) buildCommand = '';
  @IsString() @Length(1, 300) outputPath = 'dist';
  @IsString() @Length(0, 500) deployPath = '';
  @IsString() @Length(0, 65536) startCommand = '';
  @IsString() @Length(0, 65536) healthCheckCommand = '';
  @IsString() @Length(1, 300) dockerfilePath = 'Dockerfile';
  @IsString() @Length(1, 300) composeFilePath = 'compose.yaml';
  @IsOptional() @IsUUID() registryId?: string;
  @IsOptional() @IsString() @Length(1, 250) imageRepository?: string;
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PipelineStepDto)
  steps: PipelineStepDto[] = [];
}
class PipelineDefinitionInputDto extends OmitType(PipelineDefinitionDto, [
  'buildLocation',
] as const) {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['TARGET', 'MANAGER'])
  buildLocation?: PipelineDefinitionDto['buildLocation'];
}
export class CreatePipelineDto {
  @IsUUID() projectId!: string;
  @IsUUID() serviceId!: string;
  @IsString() @Length(1, 120) name!: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => PipelineDefinitionInputDto)
  definition!: PipelineDefinitionInputDto;
  @IsOptional() @IsBoolean() enabled = true;
}
export class UpdatePipelineDto {
  @IsString() @Length(1, 120) name!: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => PipelineDefinitionInputDto)
  definition!: PipelineDefinitionInputDto;
  @IsOptional() @IsBoolean() enabled = true;
}
export class RunPipelineDto {
  @IsUUID() environmentId!: string;
  @IsUUID() targetId!: string;
  @IsString() @Matches(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/) commitSha!: string;
  @IsBoolean() @Equals(true, { message: '必须确认执行目标和Pipeline版本' }) confirmed!: boolean;
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsIn(['BUILD_ONLY', 'DEPLOY']) mode?: PipelineExecutionMode;
}

export class ConfirmedPipelineRunDto extends RunPipelineDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  expectedServerIds?: string[];
  @IsOptional() @Matches(/^[a-f0-9]{64}$/) expectedConfigurationHash?: string;
}
