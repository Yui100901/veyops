import { Type } from 'class-transformer';
import { OmitType } from '@nestjs/swagger';
import { pipelineNodeTypes } from './pipeline.types';
import type {
  NamedArtifactDefinition,
  PipelineExecutionMode,
  PipelineNode,
} from './pipeline.types';
import { DeploymentSelectionDto } from '../deployment-targets/deployment-selection';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsObject,
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
export class NamedArtifactDefinitionDto implements NamedArtifactDefinition {
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,64}$/) name!: string;
  @IsIn(['FILE', 'DIRECTORY', 'DOCKER_IMAGE']) type!: NamedArtifactDefinition['type'];
  @IsOptional()
  @IsIn(['WORK_DIRECTORY', 'PATH'])
  collection?: NamedArtifactDefinition['collection'];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) excludePaths?: string[];
  @IsOptional() @IsString() @Length(1, 1024) path?: string;
  @IsOptional() @IsString() @Length(1, 512) imageReference?: string;
  @IsOptional() @IsBoolean() required?: boolean;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() persist?: boolean;
  @IsOptional() @IsString() @Length(1, 1024) composeFilePath?: string;
}
class PipelineNodeVariableDto {
  @IsString() @Matches(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/) key!: string;
  @IsOptional() @IsString() @Length(0, 65536) value?: string;
  @IsOptional() @IsUUID() credentialId?: string;
}
class PipelineNodeDto implements PipelineNode {
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,64}$/) id!: string;
  @IsString() @Length(1, 120) name!: string;
  @IsIn(pipelineNodeTypes) type!: PipelineNode['type'];
  @IsOptional() @IsUUID() repositoryId?: string;
  @IsOptional() @IsString() @Length(1, 255) branch?: string;
  @IsOptional() @IsObject() environmentBranches?: Record<string, string>;
  @IsOptional() @IsString() @Length(1, 300) directory?: string;
  @IsOptional() @IsString() @Length(1, 65536) command?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout?: number;
  @IsOptional() @IsString() @Length(1, 300) envFile?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PipelineNodeVariableDto)
  variables?: PipelineNodeVariableDto[];
}
export class PipelineDefinitionDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => NamedArtifactDefinitionDto)
  artifacts?: NamedArtifactDefinitionDto[];
  @IsOptional() @IsBoolean() inheritBuildLocation?: boolean;
  @IsOptional() @IsIn(['BUILD_ONLY', 'DEPLOY']) defaultMode?: PipelineExecutionMode;
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
  @IsOptional() @IsString() @Length(0, 65536) stopCommand?: string;
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
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => PipelineNodeDto)
  nodes?: PipelineNodeDto[];
}
class PipelineDefinitionInputDto extends OmitType(PipelineDefinitionDto, [
  'buildLocation',
] as const) {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['TARGET', 'MANAGER'])
  buildLocation?: PipelineDefinitionDto['buildLocation'];
}
export class CreatePipelineDto {
  @IsOptional() @IsUUID('4') creationId?: string;
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
export class RunPipelineDto extends DeploymentSelectionDto {
  @IsUUID() environmentId!: string;
  @IsOptional() @IsString() @Matches(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/) commitSha?: string;
  @IsBoolean() @Equals(true, { message: '必须确认执行目标和Pipeline版本' }) confirmed!: boolean;
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsIn(['BUILD_ONLY', 'DEPLOY']) mode?: PipelineExecutionMode;
  @IsOptional() @IsBoolean() allowPartialDeploy?: boolean;
}

export class ConfirmedPipelineRunDto extends RunPipelineDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  expectedServerIds?: string[];
  @IsOptional() @Matches(/^[a-f0-9]{64}$/) expectedConfigurationHash?: string;
}

export class ArtifactDeployPreviewDto extends DeploymentSelectionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  artifactIds!: string[];

  @IsUUID() environmentId!: string;
  @IsOptional() @IsInt() @Min(1) version?: number;
}

export class ArtifactDeployDto extends ArtifactDeployPreviewDto {
  @IsBoolean() @Equals(true) confirmed!: boolean;
  @Matches(/^[a-f0-9]{64}$/) expectedConfigurationHash!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  expectedServerIds?: string[];
}
