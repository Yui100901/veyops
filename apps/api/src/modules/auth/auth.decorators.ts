import { SetMetadata } from '@nestjs/common';
export const userRoles = ['ADMIN', 'OPERATOR', 'VIEWER'] as const;
export type Role = (typeof userRoles)[number];
export const Public = (category?: 'webhook') => SetMetadata('public', category || true);
export const Roles = (...roles: Role[]) => SetMetadata('roles', roles);
export const AllowPasswordChangeRequired = () => SetMetadata('allowPasswordChangeRequired', true);
export interface CurrentUser {
  id: string;
  username: string;
  role: Role;
}
export interface SessionUser extends CurrentUser {
  mustChangePassword: boolean;
}
