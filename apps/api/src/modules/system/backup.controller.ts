import { Controller, Get, Header, HttpCode, Module, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { BackupService } from './backup.service';

@Roles('ADMIN')
@Controller('backups')
class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list() {
    return this.backups.list();
  }

  @Post()
  create(@Req() request: AuthRequest) {
    return this.backups.create(request.user.id);
  }

  @Post(':id/verify')
  @HttpCode(200)
  verify(@Param('id') id: string, @Req() request: AuthRequest) {
    return this.backups.verify(id, request.user.id);
  }

  @Get(':id/download')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Param('id') id: string,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.backups.download(id, request.user.id);
    if (response.destroyed) file.getStream().destroy();
    else response.once('close', () => file.getStream().destroy());
    return file;
  }
}

@Module({ providers: [BackupService], controllers: [BackupController] })
export class BackupModule {}
