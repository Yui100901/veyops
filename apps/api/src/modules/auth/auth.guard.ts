import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  HttpException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import type { Role, SessionUser } from './auth.decorators';
export type AuthRequest = Request & { user: SessionUser };
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly attempts = new Map<string, { count: number; start: number }>();
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (!readOnly) {
      // Browser CSRF defense; no CORS is enabled. Nonbrowser clients may omit Origin.
      if (request.headers['sec-fetch-site'] === 'cross-site')
        throw new ForbiddenException('不允许跨站请求');
      const origin = request.headers.origin;
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          throw new ForbiddenException('无效 Origin');
        }
        if (host !== request.get('host')) throw new ForbiddenException('不允许跨站请求');
      }
    }
    const publicAccess = this.reflector.getAllAndOverride<true | 'webhook'>('public', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publicAccess) {
      if (!readOnly) {
        const now = Date.now();
        for (const [key, entry] of this.attempts)
          if (now - entry.start > 60_000) this.attempts.delete(key);
        const key = `${publicAccess === 'webhook' ? 'webhook' : 'auth'}:${request.ip || 'unknown'}`;
        const entry = this.attempts.get(key) || { count: 0, start: now };
        entry.count++;
        this.attempts.set(key, entry);
        if (entry.count > (publicAccess === 'webhook' ? 120 : 15))
          throw new HttpException('请求过于频繁，请稍后重试', 429);
      }
      return true;
    }
    request.user = await this.auth.resolve(request.cookies?.veyops_session as string | undefined);
    if (
      request.user.mustChangePassword &&
      !this.reflector.get<boolean>('allowPasswordChangeRequired', context.getHandler())
    )
      throw new ForbiddenException('首次登录必须先修改密码');
    const roles = this.reflector.getAllAndOverride<Role[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (roles && !roles.includes(request.user.role))
      throw new ForbiddenException('当前角色无权执行此操作');
    return true;
  }
}
