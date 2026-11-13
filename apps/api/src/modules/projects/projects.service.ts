import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';

class ProjectDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) slug!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) tags?: string[];
}
class RepositoryDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @MaxLength(2048) cloneUrl!: string;
  @IsOptional() @IsString() @MaxLength(100) defaultBranch?: string;
  @IsOptional() @IsUUID() credentialId?: string;
}
class ServiceDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) slug!: string;
  @IsIn(['WEB', 'API', 'WORKER', 'SCHEDULED_JOB', 'STATIC_SITE', 'DOCKER_SERVICE', 'CUSTOM'])
  serviceType = 'WEB';
}
class EnvironmentDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) slug!: string;
  @IsIn(['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION', 'CUSTOM']) environmentType =
    'DEVELOPMENT';
}
@Injectable()
export class ProjectsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}
  async list() {
    const rows = await this.database.db
      .selectFrom('projects')
      .selectAll()
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();
    const services = await this.database.db.selectFrom('services').select(['project_id']).execute();
    const envs = await this.database.db.selectFrom('environments').select(['project_id']).execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      description: r.description,
      tags: JSON.parse(r.tags_json) as string[],
      status: r.status,
      createdAt: r.created_at,
      serviceCount: services.filter((s) => s.project_id === r.id).length,
      environmentCount: envs.filter((e) => e.project_id === r.id).length,
    }));
  }
  async get(id: string) {
    const project = (await this.list()).find((p) => p.id === id);
    if (!project) throw new NotFoundException('项目不存在');
    const repositories = await this.database.db
      .selectFrom('repositories')
      .selectAll()
      .where('project_id', '=', id)
      .execute();
    const services = await this.database.db
      .selectFrom('services')
      .selectAll()
      .where('project_id', '=', id)
      .execute();
    const environments = await this.database.db
      .selectFrom('environments')
      .selectAll()
      .where('project_id', '=', id)
      .execute();
    return {
      ...project,
      repositories: repositories.map((r) => ({
        id: r.id,
        name: r.name,
        cloneUrl: r.clone_url,
        provider: r.provider,
        defaultBranch: r.default_branch,
        credentialId: r.credential_id,
      })),
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        serviceType: s.service_type,
      })),
      environments: environments.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        environmentType: e.environment_type,
      })),
    };
  }
  async create(dto: ProjectDto, userId: string) {
    const id = randomUUID();
    const now = Date.now();
    try {
      await this.database.db
        .insertInto('projects')
        .values({
          id,
          name: dto.name,
          slug: dto.slug,
          description: dto.description || '',
          tags_json: JSON.stringify(dto.tags || []),
          status: 'ACTIVE',
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch {
      throw new ConflictException('项目标识已存在');
    }
    await this.audit.record(userId, 'project.create', 'project', id);
    return this.get(id);
  }
  async update(id: string, dto: ProjectDto, userId: string) {
    await this.get(id);
    try {
      await this.database.db
        .updateTable('projects')
        .set({
          name: dto.name,
          slug: dto.slug,
          description: dto.description || '',
          tags_json: JSON.stringify(dto.tags || []),
          updated_at: Date.now(),
        })
        .where('id', '=', id)
        .execute();
    } catch {
      throw new ConflictException('项目标识已存在');
    }
    await this.audit.record(userId, 'project.update', 'project', id);
    return this.get(id);
  }
  async remove(id: string, userId: string) {
    await this.get(id);
    await this.database.db
      .updateTable('projects')
      .set({ deleted_at: Date.now(), updated_at: Date.now() })
      .where('id', '=', id)
      .execute();
    await this.audit.record(userId, 'project.delete', 'project', id);
    return { success: true };
  }
  async repository(projectId: string, dto: RepositoryDto, userId: string) {
    await this.get(projectId);
    if (/^https?:\/\//.test(dto.cloneUrl)) {
      const url = new URL(dto.cloneUrl);
      if (url.username || url.password || url.search || url.hash)
        throw new BadRequestException('仓库地址不能包含凭据、查询或片段，请使用凭据引用');
    } else if (!/^git@[a-zA-Z0-9_.-]+:[\w./-]+(?:\.git)?$/.test(dto.cloneUrl))
      throw new BadRequestException('请使用 HTTPS URL 或 git@host:path 格式');
    if (
      dto.credentialId &&
      !(await this.database.db
        .selectFrom('credentials')
        .select('id')
        .where('id', '=', dto.credentialId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst())
    )
      throw new BadRequestException('凭据无效');
    const now = Date.now();
    const id = randomUUID();
    await this.database.db
      .insertInto('repositories')
      .values({
        id,
        project_id: projectId,
        name: dto.name,
        clone_url: dto.cloneUrl,
        credential_id: dto.credentialId || null,
        default_branch: dto.defaultBranch || 'main',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await this.audit.record(userId, 'repository.create', 'project', projectId);
    return (await this.get(projectId)).repositories.find((r) => r.id === id);
  }
  async service(projectId: string, dto: ServiceDto, userId: string) {
    await this.get(projectId);
    const now = Date.now();
    const id = randomUUID();
    try {
      await this.database.db
        .insertInto('services')
        .values({
          id,
          project_id: projectId,
          name: dto.name,
          slug: dto.slug,
          service_type: dto.serviceType,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch {
      throw new ConflictException('该项目中服务标识已存在');
    }
    await this.audit.record(userId, 'service.create', 'project', projectId);
    return (await this.get(projectId)).services.find((s) => s.id === id);
  }
  async environment(projectId: string, dto: EnvironmentDto, userId: string) {
    await this.get(projectId);
    const now = Date.now();
    const id = randomUUID();
    try {
      await this.database.db
        .insertInto('environments')
        .values({
          id,
          project_id: projectId,
          name: dto.name,
          slug: dto.slug,
          environment_type: dto.environmentType,
          created_at: now,
          updated_at: now,
        })
        .execute();
    } catch {
      throw new ConflictException('该项目中环境标识已存在');
    }
    await this.audit.record(userId, 'environment.create', 'project', projectId);
    return (await this.get(projectId)).environments.find((e) => e.id === id);
  }
}
@Controller('projects')
class ProjectsController {
  constructor(private readonly service: ProjectsService) {}
  @Get() list() {
    return this.service.list();
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.service.get(id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post() create(@Body() dto: ProjectDto, @Req() req: AuthRequest) {
    return this.service.create(dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Patch(':id') update(
    @Param('id') id: string,
    @Body() dto: ProjectDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.update(id, dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Delete(':id') remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.remove(id, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post(':id/repositories') repository(
    @Param('id') id: string,
    @Body() dto: RepositoryDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.repository(id, dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post(':id/services') serviceCreate(
    @Param('id') id: string,
    @Body() dto: ServiceDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.service(id, dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post(':id/environments') environment(
    @Param('id') id: string,
    @Body() dto: EnvironmentDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.environment(id, dto, req.user.id);
  }
}
@Global()
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
