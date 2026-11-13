import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { PipelinesService } from './pipelines.service';
import { CreatePipelineDto, RunPipelineDto, UpdatePipelineDto } from './pipeline.dto';
@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}
  @Get() list(@Query('projectId') projectId?: string) {
    return this.pipelines.list(projectId);
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.pipelines.get(id);
  }
  @Get(':id/versions') versions(@Param('id') id: string) {
    return this.pipelines.versions(id);
  }
  @Post() @Roles('ADMIN', 'OPERATOR') create(
    @Body() input: CreatePipelineDto,
    @Req() req: AuthRequest,
  ) {
    return this.pipelines.create(input, req.user.id);
  }
  @Patch(':id') @Roles('ADMIN', 'OPERATOR') update(
    @Param('id') id: string,
    @Body() input: UpdatePipelineDto,
    @Req() req: AuthRequest,
  ) {
    return this.pipelines.update(id, input, req.user.id);
  }
  @Delete(':id') @Roles('ADMIN', 'OPERATOR') remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.pipelines.remove(id, req.user.id);
  }
  @Post(':id/preview') @Roles('ADMIN', 'OPERATOR') preview(
    @Param('id') id: string,
    @Body() input: RunPipelineDto,
  ) {
    return this.pipelines.preview(id, input);
  }
  @Post(':id/run') @Roles('ADMIN', 'OPERATOR') run(
    @Param('id') id: string,
    @Body() input: RunPipelineDto,
    @Req() req: AuthRequest,
  ) {
    return this.pipelines.run(id, input, req.user.id);
  }
}
