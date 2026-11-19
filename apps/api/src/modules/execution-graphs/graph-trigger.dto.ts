import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

export const graphTriggerKinds = ['CRON', 'WEBHOOK', 'API', 'UPSTREAM'] as const;
export type GraphTriggerKind = (typeof graphTriggerKinds)[number];
export const upstreamResults = ['SUCCESS', 'FAILED', 'ANY'] as const;
export type UpstreamResult = (typeof upstreamResults)[number];
export const graphDeliveryId = /^[A-Za-z0-9_-]{1,120}$/;
const flowId = /^[A-Za-z0-9_-]{1,80}$/;

export class GraphTriggerDto {
  @IsString() @Length(1, 100) name!: string;
  @IsIn(graphTriggerKinds) kind!: GraphTriggerKind;
  @Matches(flowId) flowId!: string;
  @IsInt() @Min(1) version!: number;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(500) inputValue?: string;
  @IsOptional() @IsString() @Length(1, 160) cron?: string;
  @IsOptional() @IsString() @Length(1, 80) timeZone?: string;
  @IsOptional() @IsUUID() credentialId?: string;
  @IsOptional() @Matches(flowId) upstreamFlowId?: string;
  @IsOptional() @IsIn(upstreamResults) upstreamStatus?: UpstreamResult;
}

export class GraphWebhookDto {
  @IsOptional() @IsString() @MaxLength(500) inputValue?: string;
}

export class InvokeGraphTriggerDto extends GraphWebhookDto {
  @Matches(graphDeliveryId) eventId!: string;
}
