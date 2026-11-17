import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const notificationStages = ['BUILD', 'DEPLOY', 'ROLLBACK'] as const;
export const notificationLevels = ['NORMAL', 'WARNING', 'FAILURE'] as const;
const smtpSecurity = ['TLS', 'STARTTLS', 'NONE'] as const;

export type NotificationStage = (typeof notificationStages)[number];
export type NotificationLevel = (typeof notificationLevels)[number];

export function isAutomaticTrigger(triggerType?: string) {
  return Boolean(triggerType && triggerType !== 'MANUAL');
}

export interface NotificationSummary {
  success: number;
  failed: number;
  skipped: number;
  needsAttention: number;
  deploymentSkipped: boolean;
  releases: string[];
}

export class NotificationsQuery {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsIn(notificationLevels) level?: NotificationLevel;
  @IsOptional() @IsIn(['true', 'false']) unread?: 'true' | 'false';
}

export class NotificationPreferencesDto {
  @IsOptional() @IsEmail() @MaxLength(254) email!: string | null;
  @IsBoolean() emailEnabled!: boolean;
  @IsIn(notificationLevels) minimumLevel!: NotificationLevel;
}

export class NotificationSubscriptionDto {
  @IsUUID() projectId!: string;
  @IsIn(notificationStages) stage!: NotificationStage;
}

export class NotificationSubscriptionsDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => NotificationSubscriptionDto)
  subscriptions!: NotificationSubscriptionDto[];
}

export class VerifyNotificationEmailDto {
  @Matches(/^\d{6}$/) code!: string;
}

export class NotificationSmtpDto {
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/) host!: string;
  @IsInt() @Min(1) @Max(65535) port!: number;
  @IsIn(smtpSecurity) security!: (typeof smtpSecurity)[number];
  @IsEmail() @MaxLength(254) fromEmail!: string;
  @IsOptional() @IsUUID() credentialId!: string | null;
  @IsString() @MaxLength(500) baseUrl!: string;
}
