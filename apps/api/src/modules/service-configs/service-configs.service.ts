import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Global,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
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
import { createHmac, randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { encryptionKey } from '../../core/config';
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
import { lockProjectGraph } from '../projects/project-guards';
import { unavailableReference } from '../projects/project-resource-protection';
import {
  CredentialsService,
  variableCredentialType,
  variableCredentialValue,
} from '../credentials/credentials.service';

class HealthCheckDto {
  @IsOptional() @IsString() @MaxLength(2048) httpUrl?: string;
  @IsOptional() @IsBoolean() compose?: boolean;
  @IsInt() @Min(1) @Max(20) attempts = 1;
  @IsInt() @Min(0) @Max(60) intervalSeconds = 0;
  @IsInt() @Min(1) @Max(300) timeoutSeconds = 120;
}

class ReleasePolicyDto implements ReleasePolicy {
  @IsBoolean() requireApproval = false;
  @IsBoolean() requireCodeReview = false;
  @IsBoolean() archivePushedImage = false;
  @IsIn(['OFF', 'PREVIOUS_HEALTHY', 'PINNED']) rollbackMode: ReleasePolicy['rollbackMode'] = 'OFF';
  @IsOptional() @IsUUID() pinnedDeploymentId?: string;
  @IsObject() @ValidateNested() @Type(() => HealthCheckDto) healthCheck = new HealthCheckDto();
}

export class ServiceConfigDto extends DeploymentSelectionDto {
  @IsOptional() @IsIn(['BUILD_ONLY', 'DEPLOY']) executionMode?: 'BUILD_ONLY' | 'DEPLOY' | null;
  @IsOptional()
  @IsIn(['TARGET', 'MANAGER'])
  buildLocation?: 'TARGET' | 'MANAGER' | null;
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
  @IsOptional() @IsBoolean() isSecret?: boolean;
  @IsOptional() @IsBoolean() keepSecret?: boolean;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}
export class VariablesDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  expectedRevision!: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => VariableDto)
  variables!: VariableDto[];
}
const variableScopes = {
  project: ['project_variables', 'project_id'],
  environment: ['environment_variables', 'environment_id'],
} as const;
const variableSources = {
  project: 'PROJECT',
  environment: 'ENVIRONMENT',
  serviceEnvironment: 'SERVICE_ENVIRONMENT',
} as const;
type VariableScope =
  | { kind: 'project'; id: string }
  | { kind: 'environment'; id: string }
  | { kind: 'serviceEnvironment'; serviceId: string; environmentId: string };
type VariableRow = Omit<Selectable<Database['project_variables']>, 'project_id'>;
export type VariableSource = {
  key: string;
  source: (typeof variableSources)[keyof typeof variableSources] | 'SYSTEM';
  isSecret: boolean;
};
const variableFields = [
  'id',
  'key',
  'value_text',
  'credential_id',
  'is_secret',
  'description',
  'created_at',
  'updated_at',
] as const;
const systemVariableName = /^VEYOPS_(PROJECT|SERVICE)_(ID|SLUG)$/i;
const secretMask = '••••••••••••';

function variableRevision(scope: VariableScope, rows: VariableRow[]) {
  const entries = [...rows]
    .sort((left, right) => left.key.localeCompare(right.key, 'en'))
    .map((row) => variableFields.map((field) => row[field]));
  return createHmac('sha256', encryptionKey())
    .update('variable-scope\0')
    .update(JSON.stringify([scope, entries]))
    .digest('hex');
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
    private readonly credentials: CredentialsService,
  ) {}
  private async project(id: string, db = this.database.db) {
    const row = await db
      .selectFrom('projects')
      .select(['id', 'slug'])
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('项目不存在');
    return row;
  }
  private async service(id: string, db = this.database.db) {
    const r = await db
      .selectFrom('services')
      .innerJoin('projects', 'projects.id', 'services.project_id')
      .select(['services.id', 'services.slug', 'services.project_id'])
      .where('services.id', '=', id)
      .where('services.archived_at', 'is', null)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('服务不存在');
    return r;
  }
  private async environment(id: string, db = this.database.db) {
    const r = await db
      .selectFrom('environments')
      .innerJoin('projects', 'projects.id', 'environments.project_id')
      .select(['environments.id', 'environments.project_id'])
      .where('environments.id', '=', id)
      .where('environments.archived_at', 'is', null)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('环境不存在');
    return r;
  }
  private async assertScope(serviceId: string, environmentId: string, db = this.database.db) {
    const s = await this.service(serviceId, db),
      e = await this.environment(environmentId, db);
    if (s.project_id !== e.project_id) throw new BadRequestException('服务和环境必须属于同一项目');
    return s.project_id;
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
    const projectId = await this.assertScope(serviceId, environmentId);
    const defaults = await this.settings.get(projectId);
    const selection = directDeploymentSelection(input, defaults.defaultMaxParallelTargets);
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
    const buildLocation =
      input.buildLocation === undefined ? defaults.defaultBuildLocation : input.buildLocation;
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
      await lockProjectGraph(tx);
      await this.assertScope(serviceId, environmentId, tx);
      if (
        input.targetId &&
        (await unavailableReference(tx, projectId, [
          { resourceType: 'LEGACY_TARGET', resourceId: input.targetId },
        ]))
      )
        throw new NotFoundException('部署目标不存在');
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
    const { project_id } = await this.environment(environmentId);
    return {
      config,
      ...(await this.resolveVariables(project_id, environmentId, serviceId)),
    };
  }
  async resolveVariables(
    projectId: string,
    environmentId?: string | null,
    serviceId?: string | null,
    db = this.database.db,
  ) {
    const [project, service] = await Promise.all([
      this.project(projectId, db),
      serviceId ? this.service(serviceId, db) : undefined,
    ]);
    if (service && service.project_id !== project.id)
      throw new BadRequestException('服务必须属于当前项目');
    const scopes: VariableScope[] = [{ kind: 'project', id: projectId }];
    if (environmentId) {
      const environment = await this.environment(environmentId, db);
      if (environment.project_id !== projectId)
        throw new BadRequestException('环境必须属于当前项目');
      scopes.push({ kind: 'environment', id: environmentId });
    }
    if (environmentId && serviceId)
      scopes.push({ kind: 'serviceEnvironment', serviceId, environmentId });
    const layers = await Promise.all(
      scopes.map(async (scope) => ({
        source: variableSources[scope.kind],
        rows: await this.variableQuery(db, scope).execute(),
      })),
    );
    const all = new Map(
      layers.flatMap(({ source, rows }) =>
        rows
          .filter(({ key }) => !systemVariableName.test(key))
          .map((row) => [row.key, { ...row, source }] as const),
      ),
    );
    const system = {
      VEYOPS_PROJECT_ID: project.id,
      VEYOPS_PROJECT_SLUG: project.slug,
      ...(service && { VEYOPS_SERVICE_ID: service.id, VEYOPS_SERVICE_SLUG: service.slug }),
    };
    const variables: Record<string, string> = {
      ...Object.fromEntries(
        [...all].flatMap(([key, row]) => (row.is_secret ? [] : [[key, row.value_text ?? '']])),
      ),
      ...system,
    };
    const sources: VariableSource[] = [
      ...[...all].map(([key, row]) => ({
        key,
        source: row.source,
        isSecret: Boolean(row.is_secret),
      })),
      ...Object.keys(system).map((key) => ({ key, source: 'SYSTEM' as const, isSecret: false })),
    ];
    return {
      variables,
      secretVariables: Object.fromEntries(
        [...all].flatMap(([key, row]) =>
          row.is_secret && row.credential_id ? [[key, row.credential_id]] : [],
        ),
      ) as Record<string, string>,
      variableSources: sources.sort((a, b) => a.key.localeCompare(b.key)),
    };
  }
  private variableQuery(db: Kysely<Database>, scope: VariableScope) {
    const variables =
      scope.kind === 'serviceEnvironment'
        ? db
            .selectFrom('service_environment_variables')
            .select(variableFields)
            .where('service_id', '=', scope.serviceId)
            .where('environment_id', '=', scope.environmentId)
        : db
            .selectFrom(variableScopes[scope.kind][0])
            .select(variableFields)
            .where(variableScopes[scope.kind][1], '=', scope.id);
    return db.selectFrom(variables.as('scope_variables')).selectAll();
  }
  private async environmentVariableScope(environmentId: string, serviceId?: string) {
    if (!serviceId) {
      await this.environment(environmentId);
      return { kind: 'environment', id: environmentId } as const;
    }
    await this.assertScope(serviceId, environmentId);
    return { kind: 'serviceEnvironment', serviceId, environmentId } as const;
  }
  private async presentVariables(db: Kysely<Database>, rows: VariableRow[]) {
    const refs = [
      ...new Set(rows.flatMap((row) => (row.credential_id ? [row.credential_id] : []))),
    ];
    const externalRefs = refs.length
      ? await db
          .selectFrom('credentials')
          .select('id')
          .where('id', 'in', refs)
          .where('type', '!=', variableCredentialType)
          .execute()
      : [];
    const external = new Set(externalRefs.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      value: row.is_secret ? null : row.value_text,
      isSecret: !!row.is_secret,
      ...(row.credential_id && external.has(row.credential_id)
        ? { credentialId: row.credential_id }
        : {}),
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
  private async listVariableScope(scope: VariableScope) {
    const db = this.database.db;
    const rows = await this.variableQuery(db, scope).orderBy('key').execute();
    return this.presentVariableScope(db, scope, rows);
  }
  private async presentVariableScope(
    db: Kysely<Database>,
    scope: VariableScope,
    rows: VariableRow[],
  ) {
    return {
      revision: variableRevision(scope, rows),
      variables: await this.presentVariables(db, rows),
    };
  }
  async listProjectVariables(projectId: string) {
    await this.project(projectId);
    return this.listVariableScope({ kind: 'project', id: projectId });
  }
  async listVariables(environmentId: string, serviceId?: string) {
    return this.listVariableScope(await this.environmentVariableScope(environmentId, serviceId));
  }
  async listInheritedVariables(environmentId: string) {
    const { project_id } = await this.environment(environmentId);
    const db = this.database.db;
    const localKeys = this.variableQuery(db, { kind: 'environment', id: environmentId })
      .clearSelect()
      .select('key');
    const inherited = await this.variableQuery(db, { kind: 'project', id: project_id })
      .where('key', 'not in', localKeys)
      .orderBy('key')
      .execute();
    return this.presentVariables(db, inherited);
  }
  async saveProjectVariables(projectId: string, input: VariablesDto, userId: string) {
    await this.project(projectId);
    return this.saveVariableScope({ kind: 'project', id: projectId }, input, userId);
  }
  async saveVariables(
    environmentId: string,
    input: VariablesDto,
    userId: string,
    serviceId?: string,
  ) {
    const scope = await this.environmentVariableScope(environmentId, serviceId);
    return this.saveVariableScope(scope, input, userId);
  }
  private async lockVariableScope(tx: Transaction<Database>, scope: VariableScope) {
    if (scope.kind === 'serviceEnvironment') {
      await this.assertScope(scope.serviceId, scope.environmentId, tx);
      return;
    }
    const table = scope.kind === 'project' ? 'projects' : 'environments';
    // The parent lock serializes even concurrent writes to an initially empty scope.
    let lock = tx.updateTable(table).set((eb) => ({ updated_at: eb.ref('updated_at') }));
    if (table === 'projects') lock = lock.where('deleted_at', 'is', null);
    if (table === 'environments') lock = lock.where('archived_at', 'is', null);
    const parent = await lock.where('id', '=', scope.id).returning('id').executeTakeFirst();
    if (!parent) throw new NotFoundException('变量所属资源不存在');
  }
  private async saveVariableScope(scope: VariableScope, input: VariablesDto, userId: string) {
    if (new Set(input.variables.map((v) => v.key)).size !== input.variables.length)
      throw new BadRequestException('变量名不能重复');
    const reserved = input.variables.find((v) => systemVariableName.test(v.key));
    if (reserved) throw new BadRequestException(`${reserved.key} 由系统提供`);
    return this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await this.lockVariableScope(tx, scope);
      const current = await this.variableQuery(tx, scope).execute();
      if (variableRevision(scope, current) !== input.expectedRevision)
        throw new ConflictException('此处变量已被其他操作更新，请重新加载最新变量后再修改。');
      const old = new Map(current.map((row) => [row.key, row]));
      const rows: VariableRow[] = [];
      for (const variable of input.variables) {
        rows.push(await this.prepareVariable(tx, variable, userId, old.get(variable.key)));
      }
      if (scope.kind === 'serviceEnvironment')
        await tx
          .deleteFrom('service_environment_variables')
          .where('service_id', '=', scope.serviceId)
          .where('environment_id', '=', scope.environmentId)
          .execute();
      else {
        const [table, parent] = variableScopes[scope.kind];
        await tx.deleteFrom(table).where(parent, '=', scope.id).execute();
      }
      if (rows.length) {
        if (scope.kind === 'project')
          await tx
            .insertInto('project_variables')
            .values(rows.map((row) => ({ ...row, project_id: scope.id })))
            .execute();
        else if (scope.kind === 'environment')
          await tx
            .insertInto('environment_variables')
            .values(rows.map((row) => ({ ...row, environment_id: scope.id })))
            .execute();
        else
          await tx
            .insertInto('service_environment_variables')
            .values(
              rows.map((row) => ({
                ...row,
                service_id: scope.serviceId,
                environment_id: scope.environmentId,
              })),
            )
            .execute();
      }
      await this.auditVariableScope(scope, userId, 'update', { count: rows.length }, tx);
      return this.presentVariableScope(tx, scope, rows);
    });
  }
  private async prepareVariable(
    tx: Transaction<Database>,
    variable: VariableDto,
    userId: string,
    previous?: VariableRow,
  ): Promise<VariableRow> {
    const { key, value, credentialId, keepSecret } = variable;
    const hasValue = typeof value === 'string';
    const isSecret =
      variable.isSecret ?? !!(credentialId || keepSecret || (!hasValue && previous?.is_secret));
    if (value?.includes('\0')) throw new BadRequestException(`变量 ${key} 不能包含空字符`);
    if (isSecret && value === secretMask)
      throw new BadRequestException(`请为敏感变量 ${key} 提供实际值或选择保留原值`);
    if (
      (hasValue && credentialId) ||
      (keepSecret && (hasValue || credentialId)) ||
      (!isSecret && (!hasValue || credentialId || keepSecret))
    )
      throw new BadRequestException(`变量 ${key} 的值与敏感设置不匹配`);
    let ref: string | null = null;
    if (isSecret) {
      if (credentialId) {
        const external = await tx
          .selectFrom('credentials')
          .select('id')
          .where('id', '=', credentialId)
          .where('type', '!=', variableCredentialType)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (!external) throw new BadRequestException(`变量 ${key} 的凭据不存在或已禁用`);
        ref = external.id;
      } else if (hasValue) {
        ref = await this.credentials.storeVariableValue(tx, userId, key, value);
      } else if (previous?.is_secret) {
        ref = previous.credential_id;
      }
      if (!ref) throw new BadRequestException(`请为敏感变量 ${key} 输入值`);
    }
    const description = variable.description ?? previous?.description ?? '';
    const valueText = isSecret ? null : (value ?? '');
    const now = Date.now();
    const unchanged =
      previous?.credential_id === ref &&
      previous.value_text === valueText &&
      previous.description === description;
    return {
      id: previous?.id ?? randomUUID(),
      key,
      value_text: valueText,
      credential_id: ref,
      is_secret: isSecret ? 1 : 0,
      description,
      created_at: previous?.created_at ?? now,
      updated_at: unchanged ? previous.updated_at : now,
    };
  }
  async revealProjectVariable(projectId: string, key: string, userId: string) {
    await this.project(projectId);
    return this.revealVariableScope({ kind: 'project', id: projectId }, key, userId);
  }
  async revealVariable(environmentId: string, key: string, userId: string, serviceId?: string) {
    const scope = await this.environmentVariableScope(environmentId, serviceId);
    return this.revealVariableScope(scope, key, userId);
  }
  private async revealVariableScope(scope: VariableScope, key: string, userId: string) {
    const row = await this.variableQuery(this.database.db, scope)
      .where('key', '=', key)
      .where('is_secret', '=', 1)
      .executeTakeFirst();
    if (!row?.credential_id) throw new NotFoundException('敏感变量不存在');
    const value = variableCredentialValue(await this.credentials.decrypt(row.credential_id));
    if (value === undefined) throw new BadRequestException('凭据不含可用的变量值');
    await this.auditVariableScope(scope, userId, 'reveal', { key });
    return { value };
  }
  private auditVariableScope(
    scope: VariableScope,
    userId: string,
    action: 'update' | 'reveal',
    details: Record<string, unknown>,
    tx?: Transaction<Database>,
  ) {
    const project = scope.kind === 'project';
    return this.audit.record(
      userId,
      `${project ? 'project' : 'environment'}.variables.${action}`,
      project ? 'project' : 'environment',
      scope.kind === 'serviceEnvironment' ? scope.environmentId : scope.id,
      {
        ...(scope.kind === 'serviceEnvironment' && { serviceId: scope.serviceId }),
        ...details,
      },
      tx,
    );
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
    if (
      new Set(input.repositories.map((r) => r.repositoryId)).size !== input.repositories.length ||
      input.repositories.filter((r) => r.isPrimary).length > 1
    )
      throw new BadRequestException('仓库关联重复或主要仓库不唯一');
    for (const r of input.repositories) {
      if (r.repoPath.startsWith('/') || r.repoPath.split(/[\\/]/).includes('..'))
        throw new BadRequestException('仓库子目录必须位于仓库中');
    }
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const service = await this.service(serviceId, tx);
      if (
        await unavailableReference(
          tx,
          service.project_id,
          input.repositories.map(({ repositoryId }) => ({
            resourceType: 'REPOSITORY',
            resourceId: repositoryId,
          })),
        )
      )
        throw new BadRequestException('仓库必须可用且属于同一项目');
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
  @Get('projects/:projectId/variables') projectVars(@Param('projectId') project: string) {
    return this.service.listProjectVariables(project);
  }
  @Roles('ADMIN', 'OPERATOR') @Put('projects/:projectId/variables') saveProjectVars(
    @Param('projectId') project: string,
    @Body() dto: VariablesDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.saveProjectVariables(project, dto, req.user.id);
  }
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store')
  @Post('projects/:projectId/variables/:key/reveal')
  revealProjectVar(
    @Param('projectId') project: string,
    @Param('key') key: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.revealProjectVariable(project, key, req.user.id);
  }
  @Get('environments/:envId/variables') envVars(@Param('envId') e: string) {
    return this.service.listVariables(e);
  }
  @Get('environments/:envId/variables/inherited') inheritedEnvVars(@Param('envId') e: string) {
    return this.service.listInheritedVariables(e);
  }
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store')
  @Post('environments/:envId/variables/:key/reveal')
  revealEnvVar(@Param('envId') e: string, @Param('key') key: string, @Req() req: AuthRequest) {
    return this.service.revealVariable(e, key, req.user.id);
  }
  @Get('services/:serviceId/environments/:envId/variables') serviceVars(
    @Param('serviceId') s: string,
    @Param('envId') e: string,
  ) {
    return this.service.listVariables(e, s);
  }
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store')
  @Post('services/:serviceId/environments/:envId/variables/:key/reveal')
  revealServiceVar(
    @Param('serviceId') s: string,
    @Param('envId') e: string,
    @Param('key') key: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.revealVariable(e, key, req.user.id, s);
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
