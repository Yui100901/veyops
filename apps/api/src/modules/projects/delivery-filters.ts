import { IsOptional, IsUUID, Matches } from 'class-validator';

export class DeliveryFilters {
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsUUID() environmentId?: string;
  @IsOptional() @Matches(/^[a-f\d]{1,64}$/i) commit?: string;
}

export class DeliveryRecordFilters extends DeliveryFilters {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() recordId?: string;
  @IsOptional() @IsUUID() pipelineRunId?: string;
  @IsOptional() @IsUUID() taskId?: string;
}
