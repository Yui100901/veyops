import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export class SaveViewDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsArray()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  projectIds!: string[];

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
