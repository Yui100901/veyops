import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { AllowPasswordChangeRequired, Public } from './auth.decorators';
import type { AuthRequest } from './auth.guard';
class LoginDto {
  @IsString() @MinLength(2) @MaxLength(64) username!: string;
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
}
class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(256) currentPassword!: string;
  @IsString() @MinLength(12) @MaxLength(256) newPassword!: string;
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Get('status') status() {
    return this.auth.status();
  }
  @Public() @Post('login') async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.cookie(await this.auth.login(dto.username, dto.password), res);
  }
  @AllowPasswordChangeRequired() @Get('me') me(@Req() req: AuthRequest) {
    return req.user;
  }
  @AllowPasswordChangeRequired() @Post('logout') async logout(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.logout(req.cookies?.veyops_session);
    res.clearCookie('veyops_session', { path: '/' });
    return result;
  }
  @AllowPasswordChangeRequired()
  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @Req() req: AuthRequest,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.changePassword(
      req.user.id,
      req.cookies?.veyops_session,
      dto.currentPassword,
      dto.newPassword,
    );
    res.clearCookie('veyops_session', { path: '/' });
    return result;
  }
  private cookie(session: Awaited<ReturnType<AuthService['login']>>, res: Response) {
    res.cookie('veyops_session', session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.COOKIE_SECURE === 'true',
      expires: new Date(session.expiresAt),
      path: '/',
    });
    return session.user;
  }
}
