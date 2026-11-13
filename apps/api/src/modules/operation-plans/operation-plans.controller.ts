import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { OperationPlansService } from './operation-plans.service';
import { CreatePlanDto, RunPlanDto } from './operation-plan.dto';

@Controller('operation-plans')
export class OperationPlansController {
  constructor(private readonly plans: OperationPlansService) {}
  @Get() list() {
    return this.plans.list();
  }
  @Get(':id/versions') versions(@Param('id') id: string) {
    return this.plans.versions(id);
  }
  @Post() @Roles('ADMIN', 'OPERATOR') create(
    @Body() input: CreatePlanDto,
    @Req() req: { user: { id: string } },
  ) {
    return this.plans.create(input, req.user.id);
  }
  @Patch(':id') @Roles('ADMIN', 'OPERATOR') update(
    @Param('id') id: string,
    @Body() input: CreatePlanDto,
    @Req() req: { user: { id: string } },
  ) {
    return this.plans.update(id, input, req.user.id);
  }
  @Post(':id/run') @Roles('ADMIN', 'OPERATOR') run(
    @Param('id') id: string,
    @Body() input: RunPlanDto,
    @Req() req: { user: { id: string } },
  ) {
    return this.plans.run(id, input, req.user.id);
  }
}
