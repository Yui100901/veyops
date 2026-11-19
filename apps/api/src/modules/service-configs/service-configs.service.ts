import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { randomUUID } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { Database } from '../../core/database/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { DeploymentTargetsService } from '../deployment-targets/deployment-targets.service';
import {
  DeploymentSelectionDto,
  directDeploymentSelection,
  selectedServerIds,
  storedDeploymentSelection,
} from '../deployment-targets/deployment-selection';
import { relativePath } from '../pipelines/pipeline.validation';
import { SystemSettingsService } from '../system/system-settings.service';
import { readReleasePolicy } from '../deployments/release-policy';
import type { ReleasePolicy } from '../pipelines/pipeline.types';
import { lockAvailableArtifacts } from '../artifacts/artifact-availability';

class HealthCheckDto {
  @IsOptional() @IsString() @MaxLength(2048) httpUrl?: string;
  @IsOptional() @IsBoolean() compose?: boolean;
  @IsInt() @Min(1) @Max(20) attempts = 1;
  @IsInt() @Min(0) @Max(60) intervalSeconds = 0;
  @IsInt() @Min(1) @Max(300) timeoutSeconds = 120;
}

class ReleasePolicyDto implements ReleasePolicy {
  @IsBoolean() requireApproval = false;
  @IsBoolean() archivePushedImage = false;
  @IsIn(['OFF', 'PREVIOUS_HEALTHY', 'PINNED']) rollbackMode: ReleasePolicy['rollbackMode'] = 'OFF';
  @IsOptional() @IsUUID() pinnedDeploymentId?: string;
  @IsObject() @ValidateNested() @Type(() => HealthCheckDto) healthCheck = new HealthCheckDto();
}

class ServiceConfigDto extends DeploymentSelectionDto {
  @IsOptional() @IsIn(['BUILD_ONLY', 'DEPLOY']) executionMode?: 'BUILD_ONLY' | 'DEPLOY' | null;
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['TARGET', 'MANAGER'])
  buildLocation?: 'TARGET' | 'MANAGER';
  @IsIn(['FILE', 'DOCKER_IMAGE']) artifactType = 'FILE';
  @IsIn(['FILE', 'DOCKER_COMPOSE']) deployMethod = 'FILE';
  @IsOptional() @IsString() @MaxLength(1024) deployPath = '';
  @IsOptional() @IsString() @MaxLength(65536) buildCommand = '';
  @IsOptional() @IsString() @MaxLength(300) workingDirectory = '';
  @IsOptional() @IsString() @MaxLength(1024) outputPath = '';
  @IsOptional() @IsString() @MaxLength(1024) composeFilePath = '';
  @IsOptional() @IsString() @MaxLength(65536) startCommand = '';
  @IsOptional() @IsString() @MaxLength(65536) stopCommand?: string;
  @IsOptional() @IsString() @MaxLength(65536) healthCheckCommand = '';
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => ReleasePolicyDto)
  releasePolicy?: ReleasePolicyDto;
}
class VariableDto {
  @IsString() @Matches(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/) key!: string;
  @IsOptional() @IsString() @MaxLength(65536) value?: string;
  @IsOptional() @IsUUID() credentialId?: string;
}
class VariablesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => VariableDto)
  variables!: VariableDto[];
}
class RepoLinkDto {
  @IsUUID() repositoryId!: string;
  @IsOptional() @IsString() @MaxLength(1024) repoPath = '.';
  @IsOptional() @IsBoolean() isPrimary = false;
}
class RepoLinksDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepoLinkDto)
  repositories!: RepoLinkDto[];
}
const present = (r: Selectable<Database['service_environment_configs']>) => ({
  id: r.id,
  serviceId: r.service_id,
  environmentId: r.environment_id,
  targetId: r.target_id,
  executionMode: r.execution_mode,
  ...storedDeploymentSelection(r.target_selection_json),
  targetSelection: storedDeploymentSelection(r.target_selection_json) ?? null,
  buildLocation: r.build_location,
  artifactType: r.artifact_type,
  deployMethod: r.deploy_method,
  deployPath: r.deploy_path,
  buildCommand: r.build_command,
  workingDirectory: r.working_directory,
  outputPath: r.build_output_path,
  composeFilePath: r.compose_file_path,
  startCommand: r.start_command,
  stopCommand: r.stop_command,
  healthCheckCommand: (JSON.parse(r.health_check_json) as { command?: string }).command || '',
  releasePolicy: readReleasePolicy(r.release_policy_json),
});

@Injectable()
export class ServiceConfigsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly targets: DeploymentTargetsService,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
  ) {}
  private async service(id: string) {
    const r = await this.database.db
      .selectFrom('services')
      .innerJoin('projects', 'projects.id', 'services.project_id')
      .select(['services.id', 'services.project_id'])
      .where('services.id', '=', id)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('服务不存在');
    return r;
  }
  private async environment(id: string) {
    const r = await this.database.db
      .selectFrom('environments')
      .innerJoin('projects', 'projects.id', 'environments.project_id')
      .select(['environments.id', 'environments.project_id'])
      .where('environments.id', '=', id)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('环境不存在');
    return r;
  }
  private async assertScope(serviceId: string, environmentId: string) {
    const s = await this.service(serviceId),
      e = await this.environment(environmentId);
    if (s.project_id !== e.project_id) throw new BadRequestException('服务和环境必须属于同一项目');
  }
  async get(serviceId: string, environmentId: string) {
    await this.assertScope(serviceId, environmentId);
    const r = await this.database.db
      .selectFrom('service_environment_configs')
      .selectAll()
      .where('service_id', '=', serviceId)
      .where('environment_id', '=', environmentId)
      .executeTakeFirst();
    return r ? present(r) : null;
  }
  async save(
    serviceId: string,
    environmentId: string,
    input: ServiceConfigDto,
    userId: string,
    admin = true,
  ) {
    if (input.workingDirectory) relativePath(input.workingDirectory);
    const policy = input.releasePolicy;
    if (policy && !admin) throw new ForbiddenException('仅管理员可以修改发布保护策略');
    if (policy?.healthCheck.httpUrl) {
      const url = URL.canParse(policy.healthCheck.httpUrl)
        ? new URL(policy.healthCheck.httpUrl)
        : undefined;
      if (
        !url ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new BadRequestException('健康检查地址必须是无凭据的 HTTP 或 HTTPS URL');
      policy.healthCheck.httpUrl = url.toString();
    }
    if (policy?.healthCheck.compose && input.deployMethod !== 'DOCKER_COMPOSE')
      throw new BadRequestException('Compose 健康检查需要 Docker Compose 部署');
    if (policy?.rollbackMode === 'PINNED' && !policy.pinnedDeploymentId)
      throw new BadRequestException('请选择已健康验收的回滚版本');
    await this.assertScope(serviceId, environmentId);
    const defaults = await this.settings.get();
    const selection = directDeploymentSelection(input, defaults.defaultMaxParallelTargets);
    if (!selection && !input.targetId) throw new BadRequestException('请选择服务器或服务器分组');
    if (input.targetId) await this.targets.get(input.targetId);
    if ((input.artifactType === 'FILE') !== (input.deployMethod === 'FILE'))
      throw new BadRequestException('产物类型与部署方式不匹配');
    if (
      input.deployPath &&
      (!input.deployPath.startsWith('/') ||
        input.deployPath === '/' ||
        input.deployPath.split('/').includes('..'))
    )
      throw new BadRequestException('部署目录必须为安全绝对路径');
    const buildLocation = input.buildLocation ?? defaults.defaultBuildLocation;
    const now = Date.now(),
      values = {
        ...(input.executionMode !== undefined && { execution_mode: input.executionMode }),
        target_id: input.targetId ?? null,
        target_selection_json: selection ? JSON.stringify(selection) : null,
        build_location: input.buildLocation,
        artifact_type: input.artifactType,
        deploy_method: input.deployMethod,
        deploy_path: input.deployPath,
        build_command: input.buildCommand,
        working_directory: input.workingDirectory,
        build_output_path: input.outputPath,
        compose_file_path: input.composeFilePath,
        start_command: input.startCommand,
        stop_command: input.stopCommand,
        health_check_json: JSON.stringify({ command: input.healthCheckCommand }),
        ...(policy && { release_policy_json: JSON.stringify(policy) }),
        updated_at: now,
      };
    const config = await this.database.db.transaction().execute(async (tx) => {
      if (selection) await selectedServerIds(tx, selection);
      if (policy?.rollbackMode === 'PINNED') {
        const baseline = await tx
          .selectFrom('deployment_records')
          .select(['pipeline_run_id', 'artifact_id'])
          .where('id', '=', policy.pinnedDeploymentId!)
          .where('service_id', '=', serviceId)
          .where('environment_id', '=', environmentId)
          .where('status', '=', 'SUCCESS')
          .where('health_status', '=', 'HEALTHY')
          .where('release_snapshot_json', 'is not', null)
          .executeTakeFirst();
        if (!baseline?.artifact_id)
          throw new BadRequestException('固定回滚版本必须属于当前服务环境且具备健康发布记录');
        const artifacts = await tx
          .selectFrom('deployment_records')
          .select('artifact_id')
          .where('pipeline_run_id', '=', baseline.pipeline_run_id)
          .where('service_id', '=', serviceId)
          .where('environment_id', '=', environmentId)
          .where('status', '=', 'SUCCESS')
          .where('health_status', '=', 'HEALTHY')
          .execute();
        await lockAvailableArtifacts(
          tx,
          artifacts.flatMap((row) => (row.artifact_id ? [row.artifact_id] : [])),
        );
      }
      return tx
        .insertInto('service_environment_configs')
        .values({
          id: randomUUID(),
          service_id: serviceId,
          environment_id: environmentId,
          ...values,
          build_location: buildLocation,
          created_at: now,
        })
        .onConflict((conflict) =>
          conflict.columns(['service_id', 'environment_id']).doUpdateSet(values),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    await this.audit.record(userId, 'service-environment.configure', 'service', serviceId, {
      environmentId,
    });
    return present(config);
  }
  async readSnapshot(serviceId: string, environmentId: string, targetId?: string) {
    const config = await this.get(serviceId, environmentId);
    if (targetId) await this.targets.get(targetId);
    const env = await this.database.db
      .selectFrom('environment_variables')
      .selectAll()
      .where('environment_id', '=', environmentId)
      .execute();
    const service = config
      ? await this.database.db
          .selectFrom('service_environment_variables')
          .selectAll()
          .where('config_id', '=', config.id)
          .execute()
      : [];
    const all = new Map([...env, ...service].map((r) => [r.key, r]));
    const variables: Record<string, string> = {},
      secretVariables: Record<string, string> = {};
    for (const [key, r] of all) {
      if (r.is_secret && r.credential_id) secretVariables[key] = r.credential_id;
      else variables[key] = r.value_text || '';
    }
    return { config, variables, secretVariables };
  }
  async listVariables(environmentId: string, serviceId?: string) {
    await this.environment(environmentId);
    if (serviceId) {
      const config = await this.get(serviceId, environmentId);
      if (!config) return [];
      return (
        await this.database.db
          .selectFrom('service_environment_variables')
          .selectAll()
          .where('config_id', '=', config.id)
          .execute()
      ).map((r) => ({
        key: r.key,
        ...(r.is_secret
          ? { credentialId: r.credential_id, isSecret: true }
          : { value: r.value_text, isSecret: false }),
      }));
    }
    return (
      await this.database.db
        .selectFrom('environment_variables')
        .selectAll()
        .where('environment_id', '=', environmentId)
        .execute()
    ).map((r) => ({
      key: r.key,
      ...(r.is_secret
        ? { credentialId: r.credential_id, isSecret: true }
        : { value: r.value_text, isSecret: false }),
    }));
  }
  async saveVariables(
    environmentId: string,
    input: VariablesDto,
    userId: string,
    serviceId?: string,
  ) {
    await this.environment(environmentId);
    const config = serviceId ? await this.get(serviceId, environmentId) : null;
    if (serviceId && !config) throw new BadRequestException('请先保存服务环境配置');
    if (new Set(input.variables.map((v) => v.key)).size !== input.variables.length)
      throw new BadRequestException('变量名不能重复');
    for (const v of input.variables) {
      if ((v.value !== undefined) === (v.credentialId !== undefined))
        throw new BadRequestException('每个变量必须且只能提供普通值或凭据引用');
      if (
        v.credentialId &&
        !(await this.database.db
          .selectFrom('credentials')
          .select('id')
          .where('id', '=', v.credentialId)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst())
      )
        throw new BadRequestException('敏感变量凭据不存在或已禁用');
    }
    await this.database.db.transaction().execute(async (tx) => {
      // Serialize replacements on the parent row even when the old set is empty.
      if (config) {
        const parent = await tx
          .updateTable('service_environment_configs')
          .set((eb) => ({ updated_at: eb.ref('updated_at') }))
          .where('id', '=', config.id)
          .returning('id')
          .executeTakeFirst();
        if (!parent) throw new NotFoundException('服务环境配置不存在');
        await tx
          .deleteFrom('service_environment_variables')
          .where('config_id', '=', config.id)
          .execute();
      } else {
        const parent = await tx
          .updateTable('environments')
          .set((eb) => ({ updated_at: eb.ref('updated_at') }))
          .where('id', '=', environmentId)
          .returning('id')
          .executeTakeFirst();
        if (!parent) throw new NotFoundException('环境不存在');
        await tx
          .deleteFrom('environment_variables')
          .where('environment_id', '=', environmentId)
          .execute();
      }
      for (const v of input.variables) {
        const row = {
          id: randomUUID(),
          key: v.key,
          value_text: v.value ?? null,
          credential_id: v.credentialId ?? null,
          is_secret: v.credentialId ? 1 : 0,
        };
        if (config)
          await tx
            .insertInto('service_environment_variables')
            .values({ ...row, config_id: config.id })
            .execute();
        else
          await tx
            .insertInto('environment_variables')
            .values({ ...row, environment_id: environmentId })
            .execute();
      }
    });
    await this.audit.record(userId, 'environment.variables.update', 'environment', environmentId, {
      serviceId: serviceId || null,
      count: input.variables.length,
    });
    return this.listVariables(environmentId, serviceId);
  }
  async links(serviceId: string) {
    await this.service(serviceId);
    return (
      await this.database.db
        .selectFrom('service_repositories')
        .selectAll()
        .where('service_id', '=', serviceId)
        .execute()
    ).map((r) => ({
      repositoryId: r.repository_id,
      repoPath: r.repo_path,
      isPrimary: !!r.is_primary,
    }));
  }
  async saveLinks(serviceId: string, input: RepoLinksDto, userId: string) {
    const s = await this.service(serviceId);
    if (
      new Set(input.repositories.map((r) => r.repositoryId)).size !== input.repositories.length ||
      input.repositories.filter((r) => r.isPrimary).length > 1
    )
      throw new BadRequestException('仓库关联重复或主要仓库不唯一');
    for (const r of input.repositories) {
      if (r.repoPath.startsWith('/') || r.repoPath.split(/[\\/]/).includes('..'))
        throw new BadRequestException('仓库子目录必须位于仓库中');
      if (
        !(await this.database.db
          .selectFrom('repositories')
          .select('id')
          .where('id', '=', r.repositoryId)
          .where('project_id', '=', s.project_id)
          .executeTakeFirst())
      )
        throw new BadRequestException('仓库必须属于同一项目');
    }
    await this.database.db.transaction().execute(async (tx) => {
      const parent = await tx
        .updateTable('services')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', serviceId)
        .returning('id')
        .executeTakeFirst();
      if (!parent) throw new NotFoundException('服务不存在');
      await tx.deleteFrom('service_repositories').where('service_id', '=', serviceId).execute();
      for (const r of input.repositories)
        await tx
          .insertInto('service_repositories')
          .values({
            service_id: serviceId,
            repository_id: r.repositoryId,
            repo_path: r.repoPath,
            is_primary: r.isPrimary ? 1 : 0,
          })
          .execute();
    });
    await this.audit.record(userId, 'service.repositories.update', 'service', serviceId);
    return this.links(serviceId);
  }
}
@Controller()
class ServiceConfigsController {
  constructor(private readonly service: ServiceConfigsService) {}
  @Get('services/:serviceId/environments/:envId/config') get(
    @Param('serviceId') s: string,
    @Param('envId') e: string,
  ) {
    return this.service.get(s, e);
  }
  @Roles('ADMIN', 'OPERATOR') @Put('services/:serviceId/environments/:envId/config') save(
    @Param('serviceId') s: string,
    @Param('envId') e: string,
    @Body() dto: ServiceConfigDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.save(s, e, dto, req.user.id, req.user.role === 'ADMIN');
  }
  @Get('environments/:envId/variables') envVars(@Param('envId') e: string) {
    return this.service.listVariables(e);
  }
  @Roles('ADMIN', 'OPERATOR') @Put('environments/:envId/variables') saveEnvVars(
    @Param('envId') e: string,
    @Body() dto: VariablesDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveVariables(e, dto, req.user.id);
  }
  @Get('services/:serviceId/environments/:envId/variables') serviceVars(
    @Param('serviceId') s: string,
    @Param('envId') e: string,
  ) {
    return this.service.listVariables(e, s);
  }
  @Roles('ADMIN', 'OPERATOR')
  @Put('services/:serviceId/environments/:envId/variables')
  saveServiceVars(
    @Param('serviceId') s: string,
    @Param('envId') e: string,
    @Body() dto: VariablesDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveVariables(e, dto, req.user.id, s);
  }
  @Get('services/:serviceId/repositories') links(@Param('serviceId') s: string) {
    return this.service.links(s);
  }
  @Roles('ADMIN', 'OPERATOR') @Put('services/:serviceId/repositories') saveLinks(
    @Param('serviceId') s: string,
    @Body() dto: RepoLinksDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveLinks(s, dto, req.user.id);
  }
}
@Global()
@Module({
  controllers: [ServiceConfigsController],
  providers: [ServiceConfigsService],
  exports: [ServiceConfigsService],
})
export class ServiceConfigsModule {}
