import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  Equals,
} from 'class-validator';

export class TargetSelectionDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) serverIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) groupIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  deploymentTargetIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) tags?: string[];
}
export class ExecutionOptionsDto extends TargetSelectionDto {
  @IsBoolean() @Equals(true, { message: '必须确认目标及命令后才能执行' }) confirmed!: boolean;
  @IsOptional() @IsIn(['PARALLEL', 'SEQUENTIAL']) strategy: 'PARALLEL' | 'SEQUENTIAL' = 'PARALLEL';
  @IsOptional() @IsInt() @Min(1) @Max(10) maxParallel = 3;
  @IsOptional() @IsIn(['STOP', 'CONTINUE']) failurePolicy: 'STOP' | 'CONTINUE' = 'CONTINUE';
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout = 300;
}
export class ExecuteCommandDto extends ExecutionOptionsDto {
  @IsOptional() @IsString() @Length(1, 120) name?: string;
  @IsString() @Length(1, 65536) command!: string;
}
