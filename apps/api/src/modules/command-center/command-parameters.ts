import { BadRequestException } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { shellQuote } from '../pipelines/pipeline.validation';

type ParameterValue = string | number | boolean;
const parameterName = /^[A-Z][A-Z0-9_]{0,63}$/;

export class CommandParameterDto {
  @IsString() @Matches(parameterName) name!: string;
  @IsIn(['STRING', 'NUMBER', 'BOOLEAN']) type!: 'STRING' | 'NUMBER' | 'BOOLEAN';
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsOptional() defaultValue?: ParameterValue;
}

function validateValue(parameter: CommandParameterDto, value: unknown) {
  const valid =
    (parameter.type === 'STRING' &&
      typeof value === 'string' &&
      value.length <= 1024 &&
      !value.includes('\0') &&
      (!parameter.required || value.length > 0)) ||
    (parameter.type === 'NUMBER' && typeof value === 'number' && Number.isFinite(value)) ||
    (parameter.type === 'BOOLEAN' && typeof value === 'boolean');
  if (!valid) throw new BadRequestException(`参数 ${parameter.name} 不符合定义`);
}

export function validateParameterDefinitions(parameters: CommandParameterDto[]) {
  const names = new Set<string>();
  for (const parameter of parameters) {
    if (!parameterName.test(parameter.name) || names.has(parameter.name))
      throw new BadRequestException('参数名必须为不重复的大写字母、数字和下划线');
    names.add(parameter.name);
    if (parameter.defaultValue !== undefined) validateValue(parameter, parameter.defaultValue);
  }
  return parameters;
}

export function parameterEnvironment(
  definitions: CommandParameterDto[],
  values: Record<string, unknown> = {},
) {
  const parameters = validateParameterDefinitions(definitions);
  const allowed = new Set(parameters.map((parameter) => parameter.name));
  if (Object.keys(values).some((name) => !allowed.has(name)))
    throw new BadRequestException('提交包含未定义参数');

  return parameters
    .map((parameter) => {
      const value = Object.hasOwn(values, parameter.name)
        ? values[parameter.name]
        : parameter.defaultValue;
      if (value === undefined) {
        if (parameter.required) throw new BadRequestException(`缺少必填参数 ${parameter.name}`);
      } else validateValue(parameter, value);
      return `export VEYOPS_PARAM_${parameter.name}=${shellQuote(String(value ?? ''))}\n`;
    })
    .join('');
}
