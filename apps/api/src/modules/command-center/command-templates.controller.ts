import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { RunCommandTemplateDto, SaveCommandTemplateDto } from './command-template.dto';
import { CommandTemplatesService } from './command-templates.service';

@Controller('command-templates')
export class CommandTemplatesController {
  constructor(private readonly templates: CommandTemplatesService) {}

  @Get() list() {
    return this.templates.list();
  }
  @Get(':id/versions') versions(@Param('id') id: string) {
    return this.templates.versions(id);
  }
  @Post() @Roles('ADMIN', 'OPERATOR') create(
    @Body() input: SaveCommandTemplateDto,
    @Req() req: AuthRequest,
  ) {
    return this.templates.create(input, req.user.id);
  }
  @Patch(':id') @Roles('ADMIN', 'OPERATOR') update(
    @Param('id') id: string,
    @Body() input: SaveCommandTemplateDto,
    @Req() req: AuthRequest,
  ) {
    return this.templates.update(id, input, req.user.id);
  }
  @Delete(':id') @Roles('ADMIN', 'OPERATOR') remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.templates.remove(id, req.user.id);
  }
  @Post(':id/run') @Roles('ADMIN', 'OPERATOR') run(
    @Param('id') id: string,
    @Body() input: RunCommandTemplateDto,
    @Req() req: AuthRequest,
  ) {
    return this.templates.run(id, input, req.user.id);
  }
}
