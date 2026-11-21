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
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Type } from 'class-transformer';
import type { Selectable } from 'kysely';
import type { Database } from '../../core/database/schema';
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { DatabaseService } from '../../core/database/database.service';
import { initialGraphDraft } from '../../core/database/execution-graphs-migration';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { CurrentUser } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { recentDeployments } from '../deployments/deployment-history';
import { byProject, projectAddressLinks } from './project-card-data';
import { projectServices, saveServiceAddresses, serviceDto } from './service-addresses';
import { pipelineSourceRepositories } from '../pipelines/pipeline-node-config';
import type { PipelineDefinition } from '../pipelines/pipeline.types';
import {
  graphDeliveryEnvironment,
  graphDeliveryEnvironmentSlug,
  graphUnscopedArtifactServiceSlug,
} from '../pipelines/delivery-execution-profile';
import { assertProjectResourceRemovable } from './project-resource-protection';
import { projectResourceInventory } from './project-resource-references';
import { relativePath } from '../pipelines/pipeline.validation';
import {
  DeploymentSelectionDto,
  directDeploymentSelection,
  selectedServerIds,
  storedDeploymentSelection,
  type DeploymentSelection,
} from '../deployment-targets/deployment-selection';
import { SystemSettingsService } from '../system/system-settings.service';
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
  @ValidateIf((_object, value) => value !== undefined)
  @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) slug?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['WEB', 'API', 'WORKER', 'SCHEDULED_JOB', 'STATIC_SITE', 'DOCKER_SERVICE', 'CUSTOM'])
  serviceType?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @Allow() addresses?: unknown;
}
class UpdateServiceDto extends ServiceDto {
  @IsInt() @Min(1) expectedRevision!: number;
}
class EnvironmentDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/)
  slug?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION', 'CUSTOM'])
  environmentType?: 'DEVELOPMENT' | 'TESTING' | 'STAGING' | 'PRODUCTION' | 'CUSTOM';
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(300) repositoryEnvFile?: string | null;
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DeploymentSelectionDto)
  defaultTargetSelection?: DeploymentSelectionDto | null;
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
const environmentDto = (row: Selectable<Database['environments']>) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  environmentType: row.environment_type,
  repositoryEnvFile: row.repository_env_file,
  defaultTargetSelection: storedDeploymentSelection(row.default_target_selection_json) ?? null,
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
    private readonly settings: SystemSettingsService,
  ) {}
  async list(includeAddresses = false) {
    const db = this.database.db;
    const activeProjects = db.selectFrom('projects').where('deleted_at', 'is', null);
    const [rows, services, envs, environmentSets, addresses] = await Promise.all([
      activeProjects.selectAll().orderBy('created_at', 'desc').execute(),
      db.selectFrom('services').select(['project_id']).where('archived_at', 'is', null).execute(),
      db
        .selectFrom('environments')
        .select(['project_id'])
        .where('archived_at', 'is', null)
        .where('slug', '!=', graphDeliveryEnvironmentSlug)
        .execute(),
      db
        .selectFrom('project_environment_sets')
        .select('project_id as projectId')
        .where('archived_at', 'is', null)
        .execute(),
      includeAddresses
        ? projectAddressLinks(db)
            .where('service.project_id', 'in', activeProjects.select('id'))
            .execute()
        : [],
    ]);
    const links = byProject(addresses);
    const sets = byProject(environmentSets);
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
      environmentSetCount: sets.get(r.id)?.length ?? 0,
      ...(includeAddresses && { addresses: links.get(r.id) ?? [] }),
    }));
  }
  async get(id: string, includeArchived = false) {
    const db = this.database.db;
    let query = db.selectFrom('projects').selectAll().where('id', '=', id);
    if (!includeArchived) query = query.where('deleted_at', 'is', null);
    const project = await query.executeTakeFirst();
    if (!project) throw new NotFoundException('项目不存在');
    const [repositories, services, environments, environmentSets] = await Promise.all([
      db
        .selectFrom('repositories')
        .selectAll()
        .where('project_id', '=', id)
        .where('archived_at', 'is', null)
        .orderBy('created_at')
        .execute(),
      projectServices(db, id),
      db
        .selectFrom('environments')
        .selectAll()
        .where('project_id', '=', id)
        .where('archived_at', 'is', null)
        .where('slug', '!=', graphDeliveryEnvironmentSlug)
        .orderBy('created_at')
        .execute(),
      db
        .selectFrom('project_environment_sets')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('project_id', '=', id)
        .where('archived_at', 'is', null)
        .executeTakeFirstOrThrow(),
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
      environmentSetCount: Number(environmentSets.count),
      repositories: repositories.map((row) => repositoryDto(row)),
      services,
      environments: environments.map(environmentDto),
    };
  }
  async deliveryContext(id: string) {
    const project = await this.get(id, true);
    const db = this.database.db;
    const [archivedServices, archivedEnvironments, archivedRepositories] = await Promise.all([
      db
        .selectFrom('services')
        .select(['id', 'name'])
        .where('project_id', '=', id)
        .where('archived_at', 'is not', null)
        .where('slug', '!=', graphUnscopedArtifactServiceSlug)
        .orderBy('name')
        .execute(),
      db
        .selectFrom('environments')
        .select(['id', 'name'])
        .where('project_id', '=', id)
        .where('archived_at', 'is not', null)
        .where('slug', '!=', graphDeliveryEnvironmentSlug)
        .orderBy('name')
        .execute(),
      db
        .selectFrom('repositories')
        .select('id')
        .where('project_id', '=', id)
        .where('archived_at', 'is not', null)
        .execute(),
    ]);
    return {
      ...project,
      archivedServices,
      archivedEnvironments,
      archivedRepositories: archivedRepositories.map(({ id }) => id),
    };
  }
  async detail(id: string) {
    const project = await this.get(id);
    const db = this.database.db;
    const [dependencies, dependents, deploymentRows, deployments] = await Promise.all([
      this.relations.dependencies(id),
      this.relations.dependents(id),
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
            .innerJoin('environments', 'environments.id', 'configs.environment_id')
            .select('configs.target_id')
            .where('services.project_id', '=', id)
            .where('services.archived_at', 'is', null)
            .where('environments.archived_at', 'is', null),
        )
        .orderBy('targets.name')
        .orderBy('targets.id')
        .orderBy('members.sort_order')
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
      dependencies,
      dependents,
      deploymentTargets: [...deploymentTargets.values()],
      recentDeployments: deployments,
    };
  }

  async serviceRecentDeployments(projectId: string, serviceId: string, environmentId?: string) {
    const db = this.database.db;
    await requireProject(db, projectId);
    const service = await db
      .selectFrom('services')
      .select('id')
      .where('id', '=', serviceId)
      .where('project_id', '=', projectId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!service) throw new NotFoundException('服务不在当前项目中');
    if (environmentId) {
      const environment = await db
        .selectFrom('environments')
        .select('id')
        .where('id', '=', environmentId)
        .where('project_id', '=', projectId)
        .where('archived_at', 'is', null)
        .where('slug', '!=', graphDeliveryEnvironmentSlug)
        .executeTakeFirst();
      if (!environment) throw new NotFoundException('环境不在当前项目中');
    }
    return recentDeployments(db, { projectId, serviceId, environmentId }, 5);
  }

  async resourceReferences(projectId: string) {
    await requireProject(this.database.db, projectId);
    return projectResourceInventory(this.database.db, projectId);
  }
  async create(dto: ProjectDto, userId: string) {
    const id = randomUUID();
    const now = Date.now();
    try {
      await this.database.db.transaction().execute(async (tx) => {
        await tx
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
        await tx
          .insertInto('execution_graphs')
          .values({
            id,
            project_id: id,
            revision: 1,
            draft_json: initialGraphDraft,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await this.audit.record(userId, 'project.create', 'project', id, {}, tx);
      });
    } catch (error) {
      if (hasConstraint(error, 'SQLITE_CONSTRAINT_UNIQUE', '23505'))
        throw new ConflictException('项目标识已存在');
      throw error;
    }
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
          .where('archived_at', 'is', null)
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
          .where('archived_at', 'is', null)
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
  async listServices(projectId: string) {
    const db = this.database.db;
    await requireProject(db, projectId);
    return projectServices(db, projectId);
  }
  async serviceDetail(projectId: string, serviceId: string) {
    const db = this.database.db;
    await requireProject(db, projectId);
    const [service] = await projectServices(db, projectId, serviceId);
    if (!service) throw new NotFoundException('服务不存在');
    return service;
  }
  async service(
    projectId: string,
    dto: ServiceDto | UpdateServiceDto,
    userId: string,
    serviceId?: string,
  ) {
    const db = this.database.db;
    const id = serviceId ?? randomUUID();
    const name = dto.name?.trim();
    if (dto.name !== undefined && !name) throw new BadRequestException('请输入服务名称');
    const expectedRevision = 'expectedRevision' in dto ? dto.expectedRevision : undefined;
    return db
      .transaction()
      .execute(async (tx) => {
        await lockProjectGraph(tx);
        await requireProject(tx, projectId);
        const now = Date.now();
        const values = {
          name,
          slug: dto.slug,
          service_type: dto.serviceType,
          description: dto.description ?? undefined,
          updated_at: now,
        };
        const previous = serviceId
          ? await tx
              .selectFrom('services')
              .select('revision')
              .where('id', '=', serviceId)
              .where('project_id', '=', projectId)
              .where('archived_at', 'is', null)
              .executeTakeFirst()
          : undefined;
        if (serviceId && !previous) throw new NotFoundException('服务不存在');
        if (previous && previous.revision !== expectedRevision) {
          throw new ConflictException({
            message: '服务已被其他用户修改，请重新载入当前版本',
            details: { currentRevision: previous.revision },
          });
        }
        let row: Selectable<Database['services']>;
        if (previous) {
          row = await tx
            .updateTable('services')
            .set({ ...values, revision: previous.revision + 1 })
            .where('id', '=', id)
            .where('revision', '=', previous.revision)
            .returningAll()
            .executeTakeFirstOrThrow();
        } else {
          if (!name || !dto.slug) throw new BadRequestException('新服务必须设置名称和标识');
          row = await tx
            .insertInto('services')
            .values({
              ...values,
              id,
              name,
              slug: dto.slug,
              project_id: projectId,
              service_type: dto.serviceType ?? 'WEB',
              created_at: now,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        const { addresses, removedIds } = await saveServiceAddresses(tx, id, dto.addresses);
        await this.audit.record(
          userId,
          serviceId ? 'service.update' : 'service.create',
          'project',
          projectId,
          { serviceId: id, revision: row.revision, removedAddressIds: removedIds },
          tx,
        );
        return serviceDto(row, addresses);
      })
      .catch((error: unknown) => {
        if (hasConstraint(error, 'SQLITE_CONSTRAINT_UNIQUE', '23505'))
          throw new ConflictException('该项目中服务标识已存在');
        throw error;
      });
  }
  async environment(
    projectId: string,
    dto: EnvironmentDto,
    userId: string,
    environmentId?: string,
  ) {
    if (environmentId === graphDeliveryEnvironment(projectId).id)
      throw new NotFoundException('环境不存在');
    const db = this.database.db;
    await requireProject(db, projectId);
    const now = Date.now();
    const id = environmentId ?? randomUUID();
    if (!environmentId && (!dto.name || !dto.slug))
      throw new BadRequestException('新环境必须设置名称和标识');
    let selection: DeploymentSelection | undefined;
    if (dto.defaultTargetSelection) {
      const defaults = await this.settings.get(projectId);
      selection = directDeploymentSelection(
        dto.defaultTargetSelection,
        defaults.defaultMaxParallelTargets,
      );
      if (!selection) throw new BadRequestException('请选择环境默认发布的服务器或服务器分组');
    }
    const values = {
      name: dto.name,
      slug: dto.slug,
      environment_type: dto.environmentType,
      repository_env_file:
        dto.repositoryEnvFile === undefined
          ? undefined
          : dto.repositoryEnvFile
            ? relativePath(dto.repositoryEnvFile)
            : null,
      default_target_selection_json:
        dto.defaultTargetSelection === undefined
          ? undefined
          : selection
            ? JSON.stringify(selection)
            : null,
      description: dto.description ?? undefined,
      updated_at: now,
    };
    const row = await db
      .transaction()
      .execute(async (tx) => {
        await lockProjectGraph(tx);
        await requireProject(tx, projectId);
        if (selection) await selectedServerIds(tx, selection);
        return (
          environmentId
            ? tx
                .updateTable('environments')
                .set(values)
                .where('id', '=', id)
                .where('project_id', '=', projectId)
                .where('archived_at', 'is', null)
            : tx.insertInto('environments').values({
                id,
                project_id: projectId,
                created_at: now,
                ...values,
                name: dto.name!,
                slug: dto.slug!,
              })
        )
          .returningAll()
          .executeTakeFirst();
      })
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
    if (table === 'environments' && id === graphDeliveryEnvironment(projectId).id)
      throw new NotFoundException('环境不存在');
    const resourceType = {
      repositories: 'REPOSITORY',
      services: 'SERVICE',
      environments: 'ENVIRONMENT',
    } as const;
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await requireProject(tx, projectId);
      const current = await tx
        .selectFrom(table)
        .select('id')
        .where('id', '=', id)
        .where('project_id', '=', projectId)
        .where('archived_at', 'is', null)
        .executeTakeFirst();
      if (!current) throw new NotFoundException('项目资源不存在');
      await assertProjectResourceRemovable(
        tx,
        { resourceType: resourceType[table], resourceId: id },
        projectId,
      );

      if (table === 'repositories' || table === 'services') {
        // UUID v8 profiles are generated by the graph engine for historical tasks. Explicit
        // Pipeline definitions still exposed to old callers use ordinary UUIDs.
        let definitions = tx
          .selectFrom('pipeline_versions as version')
          .innerJoin('pipelines', 'pipelines.id', 'version.pipeline_id')
          .select('version.definition_json')
          .where('pipelines.project_id', '=', projectId)
          .where('pipelines.enabled', '=', 1)
          .where('pipelines.id', 'not like', '________-____-8___-%');
        if (table === 'services') definitions = definitions.where('pipelines.service_id', '=', id);
        const rows = await definitions.execute();
        if (
          table === 'services'
            ? rows.length > 0
            : rows.some(({ definition_json }) =>
                pipelineSourceRepositories(
                  JSON.parse(definition_json) as PipelineDefinition,
                ).includes(id),
              )
        )
          throw new ConflictException('资源被可运行的旧交付配置引用');
      }
      const now = Date.now();
      await tx
        .updateTable(table)
        .set({ archived_at: now, updated_at: now })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        userId,
        resourceType[table].toLowerCase() + '.archive',
        'project',
        projectId,
        { resourceId: id },
        tx,
      );
    });
    return { success: true, archived: true };
  }
}
@Controller('projects')
class ProjectsController {
  constructor(private readonly service: ProjectsService) {}
  @Get() list(@Query('include') include?: string) {
    return this.service.list(include === 'addresses');
  }
  @Get(':id/resource-references') resourceReferences(@Param('id') id: string) {
    return this.service.resourceReferences(id);
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.service.detail(id);
  }
  @Get(':id/delivery-context') deliveryContext(@Param('id') id: string) {
    return this.service.deliveryContext(id);
  }
  @Get(':id/services') listServices(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.listServices(id);
  }
  @Get(':id/services/:serviceId') serviceDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ) {
    return this.service.serviceDetail(id, serviceId);
  }
  @Get(':id/services/:serviceId/recent-deployments') serviceRecentDeployments(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Query('environmentId', new ParseUUIDPipe({ optional: true })) environmentId?: string,
  ) {
    return this.service.serviceRecentDeployments(id, serviceId, environmentId);
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
    @Body() dto: UpdateServiceDto,
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
