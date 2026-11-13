import { IsBoolean, IsString, IsUUID, Length } from 'class-validator';

export class SavePipelineWebhookDto {
  @IsUUID() environmentId!: string;
  @IsUUID() targetId!: string;
  @IsString() @Length(1, 255) branch!: string;
  @IsUUID() secretCredentialId!: string;
  @IsBoolean() enabled!: boolean;
}
