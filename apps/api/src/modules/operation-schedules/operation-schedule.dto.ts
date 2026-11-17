import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
} from 'class-validator';
import type { ScheduleTiming } from './operation-schedule-time';

export class OperationScheduleTimingDto {
  @IsIn(['ONCE', 'INTERVAL', 'CRON']) type!: ScheduleTiming['type'];
  @IsOptional() @IsString() @Length(1, 120) timeZone?: string;
  @IsOptional() @IsInt() @Min(1) @Max(8.64e15) runAt?: number;
  @IsOptional() @IsInt() @Min(1) @Max(31_536_000) intervalSeconds?: number;
  @IsOptional() @IsString() @Length(1, 160) cron?: string;
}

export class OperationScheduleTargetDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  serverIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  groupIds?: string[];
}

export class PreviewOperationScheduleDto {
  @IsString() @Length(1, 120) name!: string;
  @IsIn(['COMMAND_TEMPLATE', 'OPERATION_PLAN']) kind!: 'COMMAND_TEMPLATE' | 'OPERATION_PLAN';
  @IsUUID() sourceId!: string;
  @IsInt() @Min(1) sourceVersion!: number;
  @IsDefined()
  @IsObject()
  @Type(() => OperationScheduleTimingDto)
  @ValidateNested()
  timing!: OperationScheduleTimingDto;
  @IsDefined()
  @IsObject()
  @Type(() => OperationScheduleTargetDto)
  @ValidateNested()
  target!: OperationScheduleTargetDto;
  @IsOptional() @IsObject() parameters?: Record<string, string | number | boolean>;
  @IsOptional() @IsIn(['PARALLEL', 'SEQUENTIAL']) strategy?: 'PARALLEL' | 'SEQUENTIAL';
  @IsOptional() @IsInt() @Min(1) @Max(10) maxParallel?: number;
  @IsOptional() @IsIn(['CONTINUE', 'STOP']) failurePolicy?: 'CONTINUE' | 'STOP';
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeoutSeconds?: number;
  @IsOptional() @IsBoolean() requireConfirmation?: boolean;
}

export class SaveOperationScheduleDto extends PreviewOperationScheduleDto {
  @IsBoolean() enabled!: boolean;
  @Matches(/^[a-f0-9]{64}$/) expectedConfigurationHash!: string;
}

export class EnableOperationScheduleDto {
  @Matches(/^[a-f0-9]{64}$/) expectedConfigurationHash!: string;
}

export class ApproveOperationScheduleRunDto {
  @IsBoolean() @Equals(true) confirmed!: true;
}
