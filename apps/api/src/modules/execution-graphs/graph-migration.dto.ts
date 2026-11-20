import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { MigrationComparisonInput } from './graph-migration-plan';

export class GraphMigrationComparisonDto implements MigrationComparisonInput {
  @IsOptional() @IsUUID() environmentId?: string;
  @IsOptional() @Matches(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i) commitSha?: string;
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
  @IsOptional() @IsUUID() artifactId?: string;
  @IsOptional() @IsUUID() targetId?: string;
  @IsOptional() @IsString() @MaxLength(500) value?: string;
}

export class StageGraphMigrationDto {
  @Matches(/^[a-f0-9]{64}$/) planHash!: string;
  @IsArray()
  @ArrayMaxSize(512)
  @ArrayUnique()
  @IsString({ each: true })
  acknowledgements!: string[];
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => GraphMigrationComparisonDto)
  comparison?: GraphMigrationComparisonDto;
}

export class SwitchGraphMigrationDto {
  @Matches(/^[a-f0-9]{64}$/) planHash!: string;
  @IsInt() @Min(1) targetVersion!: number;
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  triggerIds!: string[];
  @IsBoolean() confirmed!: boolean;
}

export class RestoreGraphMigrationDto {
  @IsUUID() cutoverId!: string;
  @IsBoolean() confirmed!: boolean;
}
