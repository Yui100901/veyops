import {
  Body,
  Controller,
  Delete,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Matches } from 'class-validator';
import { Roles } from '../../modules/auth/auth.decorators';
import type { AuthRequest } from '../../modules/auth/auth.guard';
import {
  DeploymentTargetDto,
  DeploymentTargetsService,
} from '../../modules/deployment-targets/deployment-targets.service';
import { ReleaseRequestsService } from '../../modules/deployments/release-requests.service';
import {
  SourceReviewDecisionDto,
  SourceReviewService,
} from '../../modules/deployments/source-review.service';
import { EnvironmentDto, ProjectsService } from '../../modules/projects/projects.service';
import {
  ComposeTemplatesModule,
  ComposeTemplatesService,
  SaveComposeRevisionDto,
} from '../../modules/service-configs/compose-templates.service';
import {
  ServiceConfigDto,
  ServiceConfigsService,
  VariablesDto,
} from '../../modules/service-configs/service-configs.service';

@Controller('projects/:id/environments')
@Roles('ADMIN', 'OPERATOR')
class LegacyProjectEnvironmentController {
  constructor(private readonly service: ProjectsService) {}

  @Post()
  create(@Param('id') id: string, @Body() dto: EnvironmentDto, @Req() req: AuthRequest) {
    return this.service.environment(id, dto, req.user.id);
  }

  @Patch(':resourceId')
  update(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: EnvironmentDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.environment(id, dto, req.user.id, resourceId);
  }

  @Delete(':resourceId')
  remove(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.removeResource(id, 'environments', resourceId, req.user.id);
  }
}

@Controller('deployment-targets')
@Roles('ADMIN', 'OPERATOR')
class LegacyDeploymentTargetController {
  constructor(private readonly service: DeploymentTargetsService) {}

  @Post()
  create(@Body() dto: DeploymentTargetDto, @Req() req: AuthRequest) {
    return this.service.save(dto, req.user.id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: DeploymentTargetDto, @Req() req: AuthRequest) {
    return this.service.save(dto, req.user.id, id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.service.remove(id, req.user.id);
  }
}

@Controller()
@Roles('ADMIN', 'OPERATOR')
class LegacyServiceConfigController {
  constructor(private readonly service: ServiceConfigsService) {}

  @Put('services/:serviceId/environments/:envId/config')
  saveConfig(
    @Param('serviceId') serviceId: string,
    @Param('envId') environmentId: string,
    @Body() dto: ServiceConfigDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.save(serviceId, environmentId, dto, req.user.id, req.user.role === 'ADMIN');
  }

  @Put(['environments/:envId/variables', 'services/:serviceId/environments/:envId/variables'])
  saveVariables(
    @Param('serviceId') serviceId: string | undefined,
    @Param('envId') environmentId: string,
    @Body() dto: VariablesDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveVariables(environmentId, dto, req.user.id, serviceId);
  }
}

@Controller('services/:serviceId/environments/:environmentId/compose-templates')
class LegacyComposeTemplateController {
  constructor(private readonly templates: ComposeTemplatesService) {}

  @Roles('ADMIN', 'OPERATOR')
  @Post()
  save(
    @Param('serviceId') serviceId: string,
    @Param('environmentId') environmentId: string,
    @Body() input: SaveComposeRevisionDto,
    @Req() req: AuthRequest,
  ) {
    return this.templates.save(serviceId, environmentId, input, req.user.id);
  }
}

@Controller('projects/:projectId/services/:serviceId/environments/:environmentId/source-reviews')
class LegacySourceReviewController {
  constructor(private readonly reviews: SourceReviewService) {}

  @Roles('ADMIN')
  @Put(':commitSha')
  decide(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
    @Param('commitSha') commitSha: string,
    @Body() input: SourceReviewDecisionDto,
    @Req() req: AuthRequest,
  ) {
    return this.reviews.recordDecision(
      projectId,
      serviceId,
      environmentId,
      commitSha,
      input,
      req.user.id,
    );
  }
}

class RollbackConfirmationDto {
  @Matches(/^[a-f0-9]{64}$/) confirmationHash!: string;
}

@Controller('deployments')
class LegacyReleaseRequestsController {
  constructor(private readonly releases: ReleaseRequestsService) {}

  @Roles('ADMIN')
  @Post('approvals/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthRequest) {
    return this.releases.approve(id, req.user.id);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post(':id/rollback/preview')
  preview(@Param('id', ParseUUIDPipe) id: string) {
    return this.releases.preview(id);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Post(':id/rollback')
  rollback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RollbackConfirmationDto,
    @Req() req: AuthRequest,
  ) {
    return this.releases.rollback(id, dto.confirmationHash, req.user.id);
  }
}

/** Test-only routes for seeding old delivery configurations and checking historical behavior. */
@Module({
  imports: [ComposeTemplatesModule],
  controllers: [
    LegacyProjectEnvironmentController,
    LegacyDeploymentTargetController,
    LegacyServiceConfigController,
    LegacyComposeTemplateController,
    LegacySourceReviewController,
    LegacyReleaseRequestsController,
  ],
})
export class LegacyDeliveryWriteFixtureModule {}
