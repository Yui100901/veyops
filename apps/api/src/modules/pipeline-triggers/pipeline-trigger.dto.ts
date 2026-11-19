import { Type } from 'class-transformer';
import {
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
  Min,
  ValidateNested,
} from 'class-validator';
import { OperationScheduleTimingDto } from '../operation-schedules/operation-schedule.dto';

import { DeploymentSelectionDto } from '../deployment-targets/deployment-selection';

export class PipelineTriggerDto extends DeploymentSelectionDto {
  @IsIn(['SCHEDULE', 'POLL']) kind!: 'SCHEDULE' | 'POLL';
  @IsInt() @Min(1) version!: number;
  @IsUUID() environmentId!: string;
  @IsString() @Length(1, 255) branch!: string;
  @IsDefined()
  @IsObject()
  @Type(() => OperationScheduleTimingDto)
  @ValidateNested()
  timing!: OperationScheduleTimingDto;
  @IsOptional() @IsBoolean() buildCurrent?: boolean;
}
export class SavePipelineTriggerDto extends PipelineTriggerDto {
  @Matches(/^[a-f0-9]{64}$/) expectedConfigurationHash!: string;
}
