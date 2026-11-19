import { IsBoolean, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { DeploymentSelectionDto } from '../deployment-targets/deployment-selection';

export class SavePipelineWebhookDto extends DeploymentSelectionDto {
  @IsUUID() environmentId!: string;
  @IsString() @Length(1, 255) branch!: string;
  @IsUUID() secretCredentialId!: string;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsBoolean() followMode?: boolean;
  @IsOptional() @Matches(/^[a-f0-9]{64}$/) expectedBindingHash?: string;
}
