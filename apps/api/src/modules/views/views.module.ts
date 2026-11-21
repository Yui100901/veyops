import { Body, Controller, Delete, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { SaveViewDto } from './views.dto';
import { ViewsRepository } from './views.repository';
import { ViewsService } from './views.service';

@Controller('views')
class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get() list(@Req() req: AuthRequest) {
    return this.views.list(req.user.id);
  }

  @Get(':id') detail(
    @Param('id') id: string,
    @Req() req: AuthRequest,
    @Query('serviceId', new ParseUUIDPipe({ optional: true })) serviceId?: string,
    @Query('serverId', new ParseUUIDPipe({ optional: true })) serverId?: string,
    @Query('groupId', new ParseUUIDPipe({ optional: true })) groupId?: string,
  ) {
    return this.views.detail(req.user.id, id, { serviceId, serverId, groupId });
  }

  @Roles('ADMIN', 'OPERATOR') @Post() create(@Body() input: SaveViewDto, @Req() req: AuthRequest) {
    return this.views.save(req.user.id, input);
  }

  @Roles('ADMIN', 'OPERATOR') @Patch(':id') update(
    @Param('id') id: string,
    @Body() input: SaveViewDto,
    @Req() req: AuthRequest,
  ) {
    return this.views.save(req.user.id, input, id);
  }

  @Roles('ADMIN', 'OPERATOR') @Delete(':id') remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.views.remove(req.user.id, id);
  }
}

@Module({ controllers: [ViewsController], providers: [ViewsRepository, ViewsService] })
export class ViewsModule {}
