import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExecutionOptionsDto } from '../command-center/command.dto';
import { CommandParameterDto } from '../command-center/command-parameters';

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
export class CreatePlanDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 2000) description = '';
  @IsOptional() @IsString() @Length(0, 100) category = 'CUSTOM';
  @IsOptional() @IsString() @Length(0, 200) osRequirements?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PlanStepDto)
  steps!: PlanStepDto[];
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
