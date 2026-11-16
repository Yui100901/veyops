import { IsIn, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { userRoles, type Role } from './auth.decorators';

const statuses = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof statuses)[number];

export class TemporaryPasswordDto {
  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;
}

export class CreateUserDto extends TemporaryPasswordDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, {
    message: '用户名须为 2–64 位字母、数字、点、下划线或连字符，并以字母或数字开头',
  })
  username!: string;

  @IsIn(userRoles)
  role!: Role;
}

export class UpdateUserDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(userRoles)
  role?: Role;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(statuses)
  status?: UserStatus;
}
