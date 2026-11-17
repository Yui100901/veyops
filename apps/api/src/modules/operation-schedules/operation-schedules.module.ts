import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { CommandCenterModule } from '../command-center/command-center.module';
import { OperationPlansModule } from '../operation-plans/operation-plans.module';
import {
  ApproveOperationScheduleRunDto,
  EnableOperationScheduleDto,
  PreviewOperationScheduleDto,
  SaveOperationScheduleDto,
} from './operation-schedule.dto';
import { OperationSchedulesService } from './operation-schedules.service';

@Controller('operation-schedules')
export class OperationSchedulesController {
  constructor(private readonly schedules: OperationSchedulesService) {}

  @Get() list(@Req() request: AuthRequest) {
    return this.schedules.list(request.user);
  }
  @Get('time-zone') timeZone() {
    return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  @Post('preview') @Roles('ADMIN', 'OPERATOR') preview(@Body() input: PreviewOperationScheduleDto) {
    return this.schedules.preview(input);
  }
  @Post() @Roles('ADMIN', 'OPERATOR') create(
    @Body() input: SaveOperationScheduleDto,
    @Req() request: AuthRequest,
  ) {
    return this.schedules.save(input, request.user);
  }
  @Patch(':id') @Roles('ADMIN', 'OPERATOR') edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: SaveOperationScheduleDto,
    @Req() request: AuthRequest,
  ) {
    return this.schedules.save(input, request.user, id);
  }
  @Post(':id/enable') @Roles('ADMIN', 'OPERATOR') enable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: EnableOperationScheduleDto,
    @Req() request: AuthRequest,
  ) {
    return this.schedules.enable(id, input.expectedConfigurationHash, request.user);
  }
  @Post(':id/disable') @Roles('ADMIN', 'OPERATOR') disable(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthRequest,
  ) {
    return this.schedules.disable(id, request.user);
  }
  @Delete(':id') @Roles('ADMIN', 'OPERATOR') remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: AuthRequest,
  ) {
    return this.schedules.disable(id, request.user, true);
  }
  @Get(':id/runs') history(@Param('id', ParseUUIDPipe) id: string, @Req() request: AuthRequest) {
    return this.schedules.history(id, request.user);
  }
  @Post(':id/runs/:runId/approve') @Roles('ADMIN', 'OPERATOR') approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() input: ApproveOperationScheduleRunDto,
    @Req() request: AuthRequest,
  ) {
    return this.schedules.approve(id, runId, request.user, input.confirmed);
  }
}

@Global()
@Module({
  imports: [CommandCenterModule, OperationPlansModule],
  controllers: [OperationSchedulesController],
  providers: [OperationSchedulesService],
  exports: [OperationSchedulesService],
})
export class OperationSchedulesModule {}
