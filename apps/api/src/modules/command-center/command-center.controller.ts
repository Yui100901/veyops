import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Roles, type CurrentUser } from '../auth/auth.decorators';
import { CommandCenterService } from './command-center.service';
import { ExecuteCommandDto, InteractiveCommandInputDto, TargetSelectionDto } from './command.dto';
import { InteractiveCommandInputs } from '../../infrastructure/ssh/interactive-command-inputs';

@Controller('commands')
export class CommandCenterController {
  constructor(
    private readonly commands: CommandCenterService,
    private readonly interactive: InteractiveCommandInputs,
  ) {}
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
  @Post(':taskId/input') @Roles('ADMIN', 'OPERATOR') input(
    @Param('taskId') taskId: string,
    @Body() body: InteractiveCommandInputDto,
    @Req() req: { user: CurrentUser },
  ) {
    return this.interactive.send(taskId, body, req.user);
  }
}
