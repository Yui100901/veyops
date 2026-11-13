import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAiProviderDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @MaxLength(2048) baseUrl!: string;
  @IsString() @MinLength(1) @MaxLength(120) model!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4096) apiKey?: string;
  @IsOptional() @IsUUID() credentialId?: string;
  @IsOptional() @IsInt() @Min(5) @Max(180) timeoutSeconds = 60;
  @IsOptional() @IsBoolean() enabled = true;
}
export class UpdateAiProviderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(2048) baseUrl?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) model?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4096) apiKey?: string;
  @IsOptional() @IsUUID() credentialId?: string;
  @IsOptional() @IsInt() @Min(5) @Max(180) timeoutSeconds?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
export type AiMode = 'READ_ONLY' | 'CONFIRM' | 'FULL_CONTROL';
export class AiPolicyDto {
  @IsIn(['READ_ONLY', 'CONFIRM', 'FULL_CONTROL']) mode!: AiMode;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) serverIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) projectIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) allowedActions?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) deniedActions?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  requireConfirmActions?: string[];
}
export class AiChatDto {
  @IsString() @MinLength(1) @MaxLength(16000) message!: string;
  @IsOptional() @IsUUID() conversationId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() providerId?: string;
}
