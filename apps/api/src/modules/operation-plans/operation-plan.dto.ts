import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExecutionOptionsDto } from '../command-center/command.dto';

export class PlanStepDto {
  @IsString() @Length(1, 120) name!: string;
  @IsString() @Length(1, 65536) command!: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout?: number;
  @IsOptional() @IsIn(['STOP', 'CONTINUE']) failurePolicy?: 'STOP' | 'CONTINUE';
}
export class CreatePlanDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 2000) description = '';
  @IsOptional() @IsString() @Length(0, 100) category = 'CUSTOM';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PlanStepDto)
  steps!: PlanStepDto[];
}
export class RunPlanDto extends ExecutionOptionsDto {
  @IsOptional() @IsInt() @Min(1) version?: number;
}
