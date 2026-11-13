import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { CommandCenterService } from './command-center.service';
import { ExecuteCommandDto, TargetSelectionDto } from './command.dto';

@Controller('commands')
export class CommandCenterController {
  constructor(private readonly commands: CommandCenterService) {}
  @Post('preview') @Roles('ADMIN', 'OPERATOR') preview(@Body() input: TargetSelectionDto) {
    return this.commands.preview(input);
  }
  @Post('execute') @Roles('ADMIN', 'OPERATOR') execute(
    @Body() input: ExecuteCommandDto,
    @Req() req: { user: { id: string } },
  ) {
    return this.commands.execute(input, req.user.id);
  }
  @Get('executions') history() {
    return this.commands.history();
  }
}
