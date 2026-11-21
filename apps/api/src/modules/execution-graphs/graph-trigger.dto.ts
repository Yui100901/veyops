import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
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

export const triggerEventFields = [
  'repository',
  'commit',
  'ref',
  'eventId',
  'scheduledAt',
  'upstreamRunId',
  'upstreamStatus',
] as const;
export type GraphParameterMapping =
  | { source: 'VALUE'; value: unknown }
  | { source: 'UPSTREAM_OUTPUT'; fieldId: string }
  | { source: 'EVENT'; field: (typeof triggerEventFields)[number] };

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
  @IsOptional() @IsObject() parameterMappings?: Record<string, GraphParameterMapping>;
  @IsOptional() @IsUUID() repositoryId?: string;
  @IsOptional() @Matches(/^refs\/(?:heads|tags)\/[A-Za-z0-9_./-]{0,200}$/) refPrefix?: string;
}

export class GraphWebhookDto {
  @IsOptional() @IsString() @MaxLength(500) inputValue?: string;
  @IsOptional() @IsUUID() repositoryId?: string;
  @IsOptional() @Matches(/^refs\/(?:heads|tags)\/[^\s\u0000]{1,256}$/) ref?: string;
  @IsOptional() @Matches(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i) commitSha?: string;
}

export class InvokeGraphTriggerDto extends GraphWebhookDto {
  @Matches(graphDeliveryId) eventId!: string;
}
