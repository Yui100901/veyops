import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { MonitoringService } from './monitoring.service';
import { trendMetric } from './monitor-trend';

class MonitoringSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(15) @Max(3600) intervalSeconds?: number;
  @IsOptional() @IsInt() @Min(1) @Max(90) retentionDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) concurrency?: number;
}
class HostMonitoringDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(64) interfaceName?: string | null;
}
@Controller('monitoring')
class MonitoringController {
  constructor(private readonly service: MonitoringService) {}
  @Get('settings') settings() {
    return this.service.settings();
  }
  @Roles('ADMIN') @Patch('settings') updateSettings(
    @Body() dto: MonitoringSettingsDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.updateSettings(dto, req.user.id);
  }
  @Get('servers') list(@Query('summary') summary?: string) {
    if (summary !== undefined && summary !== 'true' && summary !== 'false')
      throw new BadRequestException('summary 参数无效');
    return this.service.list(summary === 'true');
  }
  @Get('servers/:id') detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('hours') hours?: string,
    @Query('metric') metric?: string,
    @Query('mount') mount?: string,
    @Query('interfaceName') interfaceName?: string,
  ) {
    if (hours !== undefined && hours !== '1' && hours !== '24')
      throw new BadRequestException('请选择 1 或 24 小时');
    const selected = trendMetric(metric);
    return selected
      ? this.service.trend(id, Number(hours ?? '1'), selected, mount, interfaceName)
      : this.service.detail(id, Number(hours ?? '1'));
  }
  @Roles('ADMIN', 'OPERATOR') @Patch('servers/:id') updateHost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HostMonitoringDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.updateHost(id, dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post('servers/:id/refresh') refresh(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.refresh(id);
  }
}
@Module({
  controllers: [MonitoringController],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}
