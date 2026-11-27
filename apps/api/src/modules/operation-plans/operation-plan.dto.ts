import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ExecutionOptionsDto } from '../command-center/command.dto';
import { CommandParameterDto } from '../command-center/command-parameters';
import type { OperationChain, OperationChainEdge, OperationChainNode } from './operation-chain';

export class PlanStepDto {
  @IsString() @Length(1, 120) name!: string;
  @IsString() @Length(1, 65536) command!: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout?: number;
  @IsOptional() @IsIn(['STOP', 'CONTINUE']) failurePolicy?: 'STOP' | 'CONTINUE';
}
export class PlanCheckDto {
  @IsString() @Length(1, 120) name!: string;
  @IsString() @Length(1, 65536) command!: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout?: number;
}

class OperationChainNodeDto implements OperationChainNode {
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,64}$/) id!: string;
  @IsIn(['START', 'COMMAND', 'CONDITION', 'END']) type!: OperationChainNode['type'];
  @IsString() @Length(1, 120) name!: string;
  @IsNumber() @Min(0) @Max(20_000) x!: number;
  @IsNumber() @Min(0) @Max(20_000) y!: number;
  @IsOptional() @IsString() @Length(1, 65536) command?: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout?: number;
  @IsOptional() @IsIn(['STOP', 'CONTINUE']) failurePolicy?: 'STOP' | 'CONTINUE';
  @IsOptional() @IsIn(['OS', 'PACKAGE_MANAGER']) fact?: OperationChainNode['fact'];
}

class OperationChainEdgeDto implements OperationChainEdge {
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,64}$/) from!: string;
  @IsString() @Matches(/^[a-zA-Z0-9_-]{1,64}$/) to!: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{0,47}$/)
  when?: string;
}

class OperationChainDto implements OperationChain {
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(82)
  @ValidateNested({ each: true })
  @Type(() => OperationChainNodeDto)
  nodes!: OperationChainNodeDto[];
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(160)
  @ValidateNested({ each: true })
  @Type(() => OperationChainEdgeDto)
  edges!: OperationChainEdgeDto[];
}

export class CreatePlanDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 2000) description = '';
  @IsOptional() @IsString() @Length(0, 100) category = 'CUSTOM';
  @IsOptional() @IsString() @Length(0, 200) osRequirements?: string;
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OperationChainDto)
  chain?: OperationChainDto;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PlanStepDto)
  steps?: PlanStepDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @ValidateNested({ each: true })
  @Type(() => PlanCheckDto)
  preChecks?: PlanCheckDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @ValidateNested({ each: true })
  @Type(() => PlanCheckDto)
  postChecks?: PlanCheckDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => CommandParameterDto)
  parameters?: CommandParameterDto[];
}
export class RunPlanDto extends ExecutionOptionsDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsObject() parameters?: Record<string, unknown>;
}
