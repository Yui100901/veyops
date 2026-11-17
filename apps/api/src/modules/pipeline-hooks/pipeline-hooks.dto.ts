import { IsBoolean, IsString, IsUUID, Length } from 'class-validator';
import { DeploymentSelectionDto } from '../deployment-targets/deployment-selection';

export class SavePipelineWebhookDto extends DeploymentSelectionDto {
  @IsUUID() environmentId!: string;
  @IsString() @Length(1, 255) branch!: string;
  @IsUUID() secretCredentialId!: string;
  @IsBoolean() enabled!: boolean;
}
