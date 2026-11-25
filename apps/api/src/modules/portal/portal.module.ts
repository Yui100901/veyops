import {
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { DatabaseService } from '../../core/database/database.service';
import {
  serviceDeliveryAbnormal,
  serviceDeliveryHeads,
  serviceDeliveryStatus,
} from '../deployments/service-delivery-status';
import { projectAddressLinks } from '../projects/project-card-data';

class PortalQuery {
  @IsOptional() @IsString() @MaxLength(160) q?: string;
  @IsOptional() @IsString() @MaxLength(64) tag?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsIn(['true', 'false']) abnormal?: 'true' | 'false';
}

@Injectable()
export class PortalService {
  constructor(private readonly database: DatabaseService) {}

  async list(filters: PortalQuery) {
    const db = this.database.db;
    const active = db
      .selectFrom('projects')
      .where('deleted_at', 'is', null)
      .$if(Boolean(filters.projectId), (query) => query.where('id', '=', filters.projectId!));
    const inScope = active.select('id');
    const [projectRows, serviceRows, addresses] = await Promise.all([
      active.select(['id', 'name', 'tags_json']).orderBy('name').orderBy('id').execute(),
      db
        .selectFrom('services')
        .select(['id', 'name', 'project_id'])
        .where('project_id', 'in', inScope)
        .where('archived_at', 'is', null)
        .$if(Boolean(filters.serviceId), (query) => query.where('id', '=', filters.serviceId!))
        .orderBy('name')
        .orderBy('id')
        .execute(),
      projectAddressLinks(db)
        .where('service.project_id', 'in', inScope)
        .$if(Boolean(filters.serviceId), (query) =>
          query.where('service.id', '=', filters.serviceId!),
        )
        .execute(),
    ]);
    const byService = new Map<string, { id: string; name: string; url: string }[]>();
    for (const { serviceId, id, name, url } of addresses) {
      const links = byService.get(serviceId);
      if (links) links.push({ id, name, url });
      else byService.set(serviceId, [{ id, name, url }]);
    }
    const byProject = new Map<string, typeof serviceRows>();
    for (const service of serviceRows) {
      const services = byProject.get(service.project_id);
      if (services) services.push(service);
      else byProject.set(service.project_id, [service]);
    }
    const q = filters.q?.trim().toLocaleLowerCase() || '';
    const matches = (...values: string[]) =>
      values.some((value) => value.toLocaleLowerCase().includes(q));
    const tags = new Set<string>();
    const projects = projectRows.flatMap(({ id, name, tags_json }) => {
      const labels = JSON.parse(tags_json) as string[];
      for (const label of labels) tags.add(label);
      if (filters.tag && !labels.includes(filters.tag)) return [];
      const projectMatches = matches(name, ...labels);
      const services = (byProject.get(id) ?? []).flatMap(({ id: serviceId, name: serviceName }) => {
        const links = byService.get(serviceId) ?? [];
        return projectMatches || matches(serviceName, ...links.map(({ name }) => name))
          ? [{ id: serviceId, name: serviceName, addresses: links }]
          : [];
      });
      return services.length || (projectMatches && !filters.serviceId)
        ? [{ id, name, tags: labels, services }]
        : [];
    });
    const heads = await serviceDeliveryHeads(
      db,
      projects.flatMap(({ services }) => services.map(({ id }) => id)),
    );
    const byDelivery = new Map<
      string,
      {
        current: string | null;
        health: string | null;
        healthObservedAt: number | null;
        lastAttempt: string;
        at: number | null;
      }[]
    >();
    for (const { serviceId, current, latestAttempt } of heads) {
      const summary = {
        current: current?.status ?? null,
        health: current?.healthStatus ?? null,
        healthObservedAt: current?.healthObservedAt ?? null,
        lastAttempt: latestAttempt.status,
        at: latestAttempt.finishedAt ?? latestAttempt.startedAt,
      };
      const entries = byDelivery.get(serviceId);
      if (entries) entries.push(summary);
      else byDelivery.set(serviceId, [summary]);
    }
    return {
      projects: projects.flatMap((project) => {
        const services = project.services.flatMap((service) => {
          const targets = byDelivery.get(service.id) ?? [];
          const abnormal = targets.some(serviceDeliveryAbnormal);
          return filters.abnormal === 'true' && !abnormal
            ? []
            : [{ ...service, targets, abnormal }];
        });
        return filters.abnormal === 'true' && !services.length ? [] : [{ ...project, services }];
      }),
      tags: [...tags].sort((left, right) => left.localeCompare(right)),
    };
  }

  async delivery(projectId: string, serviceId: string) {
    const db = this.database.db;
    const service = await db
      .selectFrom('services as service')
      .innerJoin('projects as project', 'project.id', 'service.project_id')
      .select('service.id')
      .where('service.id', '=', serviceId)
      .where('project.id', '=', projectId)
      .where('project.deleted_at', 'is', null)
      .where('service.archived_at', 'is', null)
      .executeTakeFirst();
    if (!service) throw new NotFoundException('项目服务不存在或已归档');
    return serviceDeliveryStatus(db, service.id);
  }
}

@Controller('portal')
class PortalController {
  constructor(private readonly service: PortalService) {}

  @Get() list(@Query() filters: PortalQuery) {
    return this.service.list(filters);
  }
}

@Controller('projects/:id/services/:serviceId/delivery-status')
class ServiceDeliveryStatusController {
  constructor(private readonly portal: PortalService) {}

  @Get() get(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ) {
    return this.portal.delivery(projectId, serviceId);
  }
}

@Module({
  controllers: [PortalController, ServiceDeliveryStatusController],
  providers: [PortalService],
})
export class PortalModule {}
