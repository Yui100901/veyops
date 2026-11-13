import { SetMetadata } from '@nestjs/common';
export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';
export const Public = () => SetMetadata('public', true);
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export interface CurrentUser {
  id: string;
  username: string;
  role: Role;
}
