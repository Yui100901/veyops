import { OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ExecutionOptionsDto } from './command.dto';
import { CommandParameterDto } from './command-parameters';

export class SaveCommandTemplateDto {
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 2000) description = '';
  @IsString() @Length(1, 65536) command!: string;
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout = 300;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => CommandParameterDto)
  parameters?: CommandParameterDto[];
}

export class RunCommandTemplateDto extends OmitType(ExecutionOptionsDto, ['timeout'] as const) {
  @IsOptional() @IsInt() @Min(1) @Max(3600) timeout?: number;
  @IsOptional() @IsInt() @Min(1) version?: number;
  @IsOptional() @IsObject() parameters?: Record<string, unknown>;
}
