import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { Database } from '../../core/database/schema';
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
import type { CurrentUser } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { recentDeployments } from '../deployments/deployment-history';
import { DeliveryFilters } from './delivery-filters';
import { byProject, projectAddressLinks } from './project-card-data';
import { pipelineSourceRepositories } from '../pipelines/pipeline-node-config';
import type { PipelineDefinition } from '../pipelines/pipeline.types';
import {
  lockProjectGraph,
  ProjectRelationsController,
  ProjectRelationsService,
  requireProject,
} from './project-relations';
import {
  branchCache,
  httpCloneUrl,
  isGitCredentialType,
  RepositoryMetadataController,
  RepositoryMetadataService,
} from './repository-metadata.service';

class ProjectDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) slug!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) tags?: string[];
}
class RepositoryDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @MaxLength(2048) cloneUrl!: string;
  // Accepted for older clients. The remote HEAD determines the recorded default branch.
  @IsOptional() @IsString() @MaxLength(100) defaultBranch?: string;
  @IsOptional() @IsUUID() credentialId?: string | null;
  @IsOptional() @IsIn(['GITHUB', 'GITLAB', 'GITEA', 'BITBUCKET', 'CUSTOM']) provider?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
class ServiceDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) slug!: string;
  @IsIn(['WEB', 'API', 'WORKER', 'SCHEDULED_JOB', 'STATIC_SITE', 'DOCKER_SERVICE', 'CUSTOM'])
  serviceType = 'WEB';
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
class EnvironmentDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) slug!: string;
  @IsIn(['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION', 'CUSTOM']) environmentType =
    'DEVELOPMENT';
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

const repositoryDto = (row: Selectable<Database['repositories']>, cache = branchCache(row)) => ({
  id: row.id,
  name: row.name,
  cloneUrl: row.clone_url,
  provider: row.provider,
  defaultBranch: cache.defaultBranch,
  branchSyncStatus: cache.status,
  branchCount: cache.branches.length,
  credentialId: row.credential_id,
  description: row.description,
});
const serviceDto = (row: Selectable<Database['services']>) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  serviceType: row.service_type,
  description: row.description,
});
const environmentDto = (row: Selectable<Database['environments']>) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  environmentType: row.environment_type,
  description: row.description,
});

function hasConstraint(error: unknown, ...codes: string[]) {
  return codes.includes((error as { code?: string } | null)?.code ?? '');
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly relations: ProjectRelationsService,
    private readonly metadata: RepositoryMetadataService,
  ) {}
  async runs(projectId: string, filters: DeliveryFilters) {
    let query = this.database.db
      .selectFrom('pipeline_runs as r')
      .innerJoin('tasks as t', 't.id', 'r.task_id')
      .select([
        'r.id',
        'r.service_id as serviceId',
        'r.environment_id as environmentId',
        'r.commit_sha as commitSha',
        'r.task_id as taskId',
        't.name',
        't.status',
        'r.created_at as createdAt',
      ])
      .where('r.project_id', '=', projectId);
    if (filters.serviceId) query = query.where('r.service_id', '=', filters.serviceId);
    if (filters.environmentId) query = query.where('r.environment_id', '=', filters.environmentId);
    if (filters.commit)
      query = query.where('r.commit_sha', 'like', filters.commit.toLowerCase() + '%');
    return query.orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(200).execute();
  }
  async list(includeAddresses = false) {
    const db = this.database.db;
    const activeProjects = db.selectFrom('projects').where('deleted_at', 'is', null);
    const [rows, services, envs, addresses] = await Promise.all([
      activeProjects.selectAll().orderBy('created_at', 'desc').execute(),
      db.selectFrom('services').select(['project_id']).execute(),
      db.selectFrom('environments').select(['project_id']).execute(),
      includeAddresses
        ? projectAddressLinks(db)
            .where('address.project_id', 'in', activeProjects.select('id'))
            .orderBy('address.name')
            .orderBy('address.id')
            .execute()
        : [],
    ]);
    const links = byProject(addresses);
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
      ...(includeAddresses && { addresses: links.get(r.id) ?? [] }),
    }));
  }
  async get(id: string, includeArchived = false) {
    const db = this.database.db;
    let query = db.selectFrom('projects').selectAll().where('id', '=', id);
    if (!includeArchived) query = query.where('deleted_at', 'is', null);
    const project = await query.executeTakeFirst();
    if (!project) throw new NotFoundException('项目不存在');
    const [repositories, services, environments] = await Promise.all([
      db
        .selectFrom('repositories')
        .selectAll()
        .where('project_id', '=', id)
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('services')
        .selectAll()
        .where('project_id', '=', id)
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('environments')
        .selectAll()
        .where('project_id', '=', id)
        .orderBy('created_at')
        .execute(),
    ]);
    return {
      id: project.id,
      ...(includeArchived && { archived: project.deleted_at !== null }),
      name: project.name,
      slug: project.slug,
      description: project.description,
      tags: JSON.parse(project.tags_json) as string[],
      status: project.status,
      createdAt: project.created_at,
      serviceCount: services.length,
      environmentCount: environments.length,
      repositories: repositories.map((row) => repositoryDto(row)),
      services: services.map(serviceDto),
      environments: environments.map(environmentDto),
    };
  }
  async detail(id: string) {
    const project = await this.get(id);
    const db = this.database.db;
    const [addresses, dependencies, deploymentRows, pipelines, deployments] = await Promise.all([
      this.relations.addresses(id),
      this.relations.dependencies(id),
      db
        .selectFrom('deployment_targets as targets')
        .leftJoin('deployment_target_servers as members', 'members.target_id', 'targets.id')
        .select([
          'targets.id as id',
          'targets.name as name',
          'targets.description as description',
          'members.server_id as serverId',
        ])
        .where(
          'targets.id',
          'in',
          db
            .selectFrom('service_environment_configs as configs')
            .innerJoin('services', 'services.id', 'configs.service_id')
            .select('configs.target_id')
            .where('services.project_id', '=', id),
        )
        .orderBy('targets.name')
        .orderBy('targets.id')
        .orderBy('members.sort_order')
        .execute(),
      db
        .selectFrom('pipelines')
        .select(['id', 'name', 'service_id as serviceId', 'current_version as version', 'enabled'])
        .where('project_id', '=', id)
        .orderBy('created_at', 'desc')
        .execute(),
      recentDeployments(db, { projectId: id }),
    ]);
    const deploymentTargets = new Map<
      string,
      { id: string; name: string; description: string; serverIds: string[] }
    >();
    for (const { serverId, ...target } of deploymentRows) {
      const entry = deploymentTargets.get(target.id) ?? { ...target, serverIds: [] };
      if (serverId) entry.serverIds.push(serverId);
      deploymentTargets.set(target.id, entry);
    }
    return {
      ...project,
      addresses,
      dependencies,
      deploymentTargets: [...deploymentTargets.values()],
      pipelines: pipelines.map((pipeline) => ({ ...pipeline, enabled: Boolean(pipeline.enabled) })),
      recentDeployments: deployments,
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
    await requireProject(this.database.db, id);
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
        .where('deleted_at', 'is', null)
        .execute();
    } catch {
      throw new ConflictException('项目标识已存在');
    }
    await this.audit.record(userId, 'project.update', 'project', id);
    return this.get(id);
  }
  async remove(id: string, userId: string) {
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await requireProject(tx, id);
      const dependent = await tx
        .selectFrom('project_dependencies as dependencies')
        .innerJoin('projects', 'projects.id', 'dependencies.project_id')
        .select('dependencies.id')
        .where('dependencies.depends_on_project_id', '=', id)
        .where('projects.deleted_at', 'is', null)
        .executeTakeFirst();
      if (dependent) throw new ConflictException('项目仍被其他项目依赖，请先移除依赖');
      await tx
        .updateTable('projects')
        .set({ deleted_at: Date.now(), updated_at: Date.now() })
        .where('id', '=', id)
        .execute();
    });
    await this.audit.record(userId, 'project.delete', 'project', id);
    return { success: true };
  }
  async repository(
    projectId: string,
    dto: RepositoryDto,
    user: CurrentUser,
    repositoryId?: string,
  ) {
    const db = this.database.db;
    await requireProject(db, projectId);
    const current = repositoryId
      ? await db
          .selectFrom('repositories')
          .selectAll()
          .where('project_id', '=', projectId)
          .where('id', '=', repositoryId)
          .executeTakeFirst()
      : undefined;
    if (repositoryId && !current) throw new NotFoundException('仓库不存在');
    const isHttp = /^https?:\/\//i.test(dto.cloneUrl);
    const cloneUrl = isHttp ? httpCloneUrl(dto.cloneUrl) : dto.cloneUrl;
    if (!isHttp && !/^git@[a-zA-Z0-9_.-]+:[\w./-]+(?:\.git)?$/.test(cloneUrl))
      throw new BadRequestException('请使用 HTTPS URL 或 git@host:path 格式');
    const credentialId =
      dto.credentialId === undefined ? (current?.credential_id ?? null) : dto.credentialId;
    if (
      user.role !== 'ADMIN' &&
      (credentialId !== (current?.credential_id ?? null) ||
        (credentialId && cloneUrl !== current?.clone_url))
    )
      throw new ForbiddenException('仅管理员可修改仓库凭据或使用该凭据的地址');
    if (
      credentialId &&
      (credentialId !== current?.credential_id || cloneUrl !== current?.clone_url)
    ) {
      const credential = await db
        .selectFrom('credentials')
        .select('type')
        .where('id', '=', credentialId)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst();
      if (
        !credential ||
        !(isHttp ? isGitCredentialType(credential.type) : credential.type === 'SSH_KEY')
      )
        throw new BadRequestException('凭据无效或与仓库协议不匹配');
    }
    const now = current ? Math.max(Date.now(), current.updated_at + 1) : Date.now();
    const id = repositoryId ?? randomUUID();
    const accessChanged =
      !current || cloneUrl !== current.clone_url || credentialId !== current.credential_id;
    const values = {
      name: dto.name,
      clone_url: cloneUrl,
      credential_id: credentialId,
      ...(accessChanged && {
        default_branch: '',
        branch_cache_json: null,
        branch_request_id: null,
        branch_error: null,
        branch_checked_at: null,
      }),
      provider: dto.provider ?? current?.provider ?? 'CUSTOM',
      description: dto.description ?? current?.description ?? '',
      updated_at: now,
    };
    const row = current
      ? await db
          .updateTable('repositories')
          .set(values)
          .where('id', '=', id)
          .where('project_id', '=', projectId)
          .where('updated_at', '=', current.updated_at)
          .returningAll()
          .executeTakeFirst()
      : await db
          .insertInto('repositories')
          .values({ id, project_id: projectId, created_at: now, ...values })
          .returningAll()
          .executeTakeFirstOrThrow();
    if (!row) throw new ConflictException('仓库已变化，请刷新后重试');
    await this.audit.record(
      user.id,
      current ? 'repository.update' : 'repository.create',
      'project',
      projectId,
      { repositoryId: id },
    );
    const cache = branchCache(row);
    return repositoryDto(
      row,
      cache.status === 'CURRENT'
        ? cache
        : await this.metadata.refreshBranches(projectId, id, 5_000),
    );
  }
  async service(projectId: string, dto: ServiceDto, userId: string, serviceId?: string) {
    const db = this.database.db;
    await requireProject(db, projectId);
    const now = Date.now();
    const id = serviceId ?? randomUUID();
    const values = {
      name: dto.name,
      slug: dto.slug,
      service_type: dto.serviceType,
      description: dto.description ?? undefined,
      updated_at: now,
    };
    const row = await (
      serviceId
        ? db
            .updateTable('services')
            .set(values)
            .where('id', '=', id)
            .where('project_id', '=', projectId)
        : db
            .insertInto('services')
            .values({ id, project_id: projectId, created_at: now, ...values })
    )
      .returningAll()
      .executeTakeFirst()
      .catch((error: unknown) => {
        if (hasConstraint(error, 'SQLITE_CONSTRAINT_UNIQUE', '23505'))
          throw new ConflictException('该项目中服务标识已存在');
        throw error;
      });
    if (!row) throw new NotFoundException('服务不存在');
    await this.audit.record(
      userId,
      serviceId ? 'service.update' : 'service.create',
      'project',
      projectId,
      { serviceId: id },
    );
    return serviceDto(row);
  }
  async environment(
    projectId: string,
    dto: EnvironmentDto,
    userId: string,
    environmentId?: string,
  ) {
    const db = this.database.db;
    await requireProject(db, projectId);
    const now = Date.now();
    const id = environmentId ?? randomUUID();
    const values = {
      name: dto.name,
      slug: dto.slug,
      environment_type: dto.environmentType,
      description: dto.description ?? undefined,
      updated_at: now,
    };
    const row = await (
      environmentId
        ? db
            .updateTable('environments')
            .set(values)
            .where('id', '=', id)
            .where('project_id', '=', projectId)
        : db
            .insertInto('environments')
            .values({ id, project_id: projectId, created_at: now, ...values })
    )
      .returningAll()
      .executeTakeFirst()
      .catch((error: unknown) => {
        if (hasConstraint(error, 'SQLITE_CONSTRAINT_UNIQUE', '23505'))
          throw new ConflictException('该项目中环境标识已存在');
        throw error;
      });
    if (!row) throw new NotFoundException('环境不存在');
    await this.audit.record(
      userId,
      environmentId ? 'environment.update' : 'environment.create',
      'project',
      projectId,
      { environmentId: id },
    );
    return environmentDto(row);
  }

  async removeResource(
    projectId: string,
    table: 'repositories' | 'services' | 'environments',
    id: string,
    userId: string,
  ) {
    const db = this.database.db;
    const resourceType = {
      repositories: 'repository',
      services: 'service',
      environments: 'environment',
    }[table];
    await db
      .transaction()
      .execute(async (tx) => {
        await lockProjectGraph(tx);
        await requireProject(tx, projectId);
        if (table === 'repositories') {
          // A write lock on the repository also serializes Pipeline version creation.
          const repository = await tx
            .updateTable('repositories')
            .set((eb) => ({ updated_at: eb.ref('updated_at') }))
            .where('id', '=', id)
            .where('project_id', '=', projectId)
            .returning('id')
            .executeTakeFirst();
          if (!repository) throw new NotFoundException('仓库不存在');
          const association = await tx
            .selectFrom('service_repositories')
            .select('repository_id')
            .where('repository_id', '=', id)
            .executeTakeFirst();
          const definitions = await tx
            .selectFrom('pipeline_versions as versions')
            .innerJoin('pipelines', 'pipelines.id', 'versions.pipeline_id')
            .select('versions.definition_json')
            .where('pipelines.project_id', '=', projectId)
            .execute();
          if (
            association ||
            definitions.some(({ definition_json }) =>
              pipelineSourceRepositories(
                JSON.parse(definition_json) as PipelineDefinition,
              ).includes(id),
            )
          )
            throw new ConflictException('仓库被服务或 Pipeline 版本引用，不能删除');
        }
        if (table !== 'repositories') {
          const resource = tx
            .selectFrom(table)
            .select('id')
            .where('id', '=', id)
            .where('project_id', '=', projectId);
          const scope = table === 'services' ? 'service_id' : 'environment_id';
          const configs = tx
            .selectFrom('service_environment_configs')
            .select('id')
            .where(scope, 'in', resource);
          await tx
            .deleteFrom('service_environment_variables')
            .where('config_id', 'in', configs)
            .execute();
          await tx.deleteFrom('service_environment_configs').where(scope, 'in', resource).execute();
          if (table === 'environments')
            await tx
              .deleteFrom('environment_variables')
              .where('environment_id', 'in', resource)
              .execute();
        }
        const row = await tx
          .deleteFrom(table)
          .where('id', '=', id)
          .where('project_id', '=', projectId)
          .returning('id')
          .executeTakeFirst();
        if (!row) throw new NotFoundException('项目资源不存在');
      })
      .catch((error: unknown) => {
        if (
          hasConstraint(error, 'SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER', '23503')
        )
          throw new ConflictException('资源被项目配置或历史记录引用，不能删除');
        throw error;
      });
    await this.audit.record(userId, `${resourceType}.delete`, 'project', projectId, {
      resourceId: id,
    });
    return { success: true };
  }
}
@Controller('projects')
class ProjectsController {
  constructor(private readonly service: ProjectsService) {}
  @Get() list(@Query('include') include?: string) {
    return this.service.list(include === 'addresses');
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.service.detail(id);
  }
  @Get(':id/runs') runs(@Param('id') id: string, @Query() filters: DeliveryFilters) {
    return this.service.runs(id, filters);
  }
  @Get(':id/delivery-context') deliveryContext(@Param('id') id: string) {
    return this.service.get(id, true);
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
    return this.service.repository(id, dto, req.user);
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
  @Roles('ADMIN', 'OPERATOR') @Patch(':id/repositories/:resourceId') updateRepository(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: RepositoryDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.repository(id, dto, req.user, resourceId);
  }
  @Roles('ADMIN', 'OPERATOR') @Patch(':id/services/:resourceId') updateService(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: ServiceDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.service(id, dto, req.user.id, resourceId);
  }
  @Roles('ADMIN', 'OPERATOR') @Patch(':id/environments/:resourceId') updateEnvironment(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Body() dto: EnvironmentDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.environment(id, dto, req.user.id, resourceId);
  }
  @Roles('ADMIN', 'OPERATOR') @Delete(':id/repositories/:resourceId') removeRepository(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.removeResource(id, 'repositories', resourceId, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Delete(':id/services/:resourceId') removeService(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.removeResource(id, 'services', resourceId, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Delete(':id/environments/:resourceId') removeEnvironment(
    @Param('id') id: string,
    @Param('resourceId') resourceId: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.removeResource(id, 'environments', resourceId, req.user.id);
  }
}
@Global()
@Module({
  controllers: [ProjectsController, RepositoryMetadataController, ProjectRelationsController],
  providers: [ProjectsService, RepositoryMetadataService, ProjectRelationsService],
  exports: [ProjectsService, RepositoryMetadataService],
})
export class ProjectsModule {}
