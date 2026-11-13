import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from './auth.decorators';
import type { AuthRequest } from './auth.guard';
class LoginDto {
  @IsString() @MinLength(2) @MaxLength(64) username!: string;
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
}
class SetupDto {
  @IsString() @Matches(/^[a-zA-Z0-9_.-]{2,64}$/) username!: string;
  @IsString() @MinLength(12) @MaxLength(256) password!: string;
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Get('status') status() {
    return this.auth.status();
  }
  @Public() @Post('setup') async setup(
    @Body() dto: SetupDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.cookie(await this.auth.setup(dto.username, dto.password), res);
  }
  @Public() @Post('login') async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.cookie(await this.auth.login(dto.username, dto.password), res);
  }
  @Get('me') me(@Req() req: AuthRequest) {
    return req.user;
  }
  @Post('logout') async logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.logout(req.cookies?.veyops_session);
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
