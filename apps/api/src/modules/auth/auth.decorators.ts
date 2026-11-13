import { SetMetadata } from '@nestjs/common';
export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';
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
