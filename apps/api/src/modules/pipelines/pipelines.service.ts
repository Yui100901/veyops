import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { findLegacyWebhookTask } from './legacy-webhook-task';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { ServersService } from '../servers/servers.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { AuditService } from '../audit/audit.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { ServiceConfigsService } from '../service-configs/service-configs.service';
import { lockRegistry, RegistriesService } from '../registries/registries.service';
import { PipelineExecutor } from './pipeline-executor.service';
import { webhookBuildSocket } from '../builds/builds.service';
import { PipelineAnalysisService } from '../ai/pipeline-analysis.service';
import { SystemSettingsService } from '../system/system-settings.service';
import { RepositoryMetadataService } from '../projects/repository-metadata.service';
import {
  confirmDeploymentMembers,
  directDeploymentSelection,
  selectedServerIds,
} from '../deployment-targets/deployment-selection';
import type { CreateTaskInput, TaskPayload, TaskRecord, TaskStatus } from '../tasks/tasks.types';
import {
  ArtifactDeployDto,
  ArtifactDeployPreviewDto,
  ConfirmedPipelineRunDto,
  CreatePipelineDto,
  PipelineDefinitionDto,
  RunPipelineDto,
  UpdatePipelineDto,
} from './pipeline.dto';
import type {
  AutomaticPipelineTrigger,
  PipelineDefinition,
  PipelineExecutionMode,
  PipelineSnapshot,
} from './pipeline.types';
import {
  pipelineNodeSecrets,
  pipelineSourceRepositories,
  resolvePipelineSources,
  validatePipelineNodes,
} from './pipeline-node-config';
import { safeDeployPath, validateDefinition, validateGitUrl } from './pipeline.validation';
import { storeDeliveryProfile, type DeliveryExecutionProfile } from './delivery-execution-profile';
import { ownedGraphWorkspace, type GraphExecutionScope } from '../execution-graphs/graph-workspace';
import { SourceReviewService } from '../deployments/source-review.service';

@Injectable()
export class PipelinesService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly tasks: TasksService,
    private readonly servers: ServersService,
    private readonly handlers: TaskHandlerRegistry,
    private readonly executor: PipelineExecutor,
    private readonly audit: AuditService,
    private readonly configs: ServiceConfigsService,
    private readonly registries: RegistriesService,
    private readonly analysis: PipelineAnalysisService,
    private readonly settings: SystemSettingsService,
    private readonly artifacts: ArtifactsService,
    private readonly metadata: RepositoryMetadataService,
    @Optional() private readonly sourceReviews?: SourceReviewService,
  ) {}
  onModuleInit() {
    this.handlers.register({
      type: 'PIPELINE',
      execute: (task, context) => this.executor.execute(task, context),
      onFinalize: (tx, task, userId, status) => this.finishBuild(tx, task, userId, status),
      afterCompletion: (task, signal) => this.analysis.record(task, signal),
    });
  }
  async list(projectId?: string, serviceId?: string) {
    let q = this.database.db.selectFrom('pipelines').selectAll();
    if (projectId) q = q.where('project_id', '=', projectId);
    if (serviceId) q = q.where('service_id', '=', serviceId);
    const rows = await q.orderBy('created_at', 'desc').execute();
    return Promise.all(
      rows.map(async (row) => {
        const v = await this.database.db
          .selectFrom('pipeline_versions')
          .selectAll()
          .where('pipeline_id', '=', row.id)
          .where('version', '=', row.current_version)
          .executeTakeFirstOrThrow();
        return {
          id: row.id,
          projectId: row.project_id,
          serviceId: row.service_id,
          name: row.name,
          enabled: row.enabled === 1,
          currentVersion: row.current_version,
          definition: JSON.parse(v.definition_json) as PipelineDefinition,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }),
    );
  }
  async get(id: string) {
    const pipeline = (await this.list()).find((p) => p.id === id);
    if (!pipeline) throw new NotFoundException('Pipeline不存在');
    return pipeline;
  }
  async versions(id: string) {
    await this.get(id);
    return (
      await this.database.db
        .selectFrom('pipeline_versions')
        .selectAll()
        .where('pipeline_id', '=', id)
        .orderBy('version', 'desc')
        .execute()
    ).map((r) => ({
      id: r.id,
      version: r.version,
      definition: JSON.parse(r.definition_json) as PipelineDefinition,
      createdAt: r.created_at,
    }));
  }
  private async resources(
    projectId: string,
    serviceId: string,
    definition: PipelineDefinition,
    mode?: PipelineExecutionMode,
    fromArtifact = false,
    allowArchivedSource = false,
  ) {
    validateDefinition(definition, mode === 'DEPLOY' && !fromArtifact);
    validatePipelineNodes(definition);
    if (fromArtifact) safeDeployPath(definition.deployPath);
    const project = await this.database.db
      .selectFrom('projects')
      .select(['id', 'name'])
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const service = await this.database.db
      .selectFrom('services')
      .select(['project_id', 'name'])
      .where('id', '=', serviceId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    const repositoryIds = fromArtifact
      ? [definition.repositoryId]
      : pipelineSourceRepositories(definition);
    const repositoryRows = await this.database.db
      .selectFrom('repositories')
      .selectAll()
      .where('id', 'in', repositoryIds)
      .where('project_id', '=', projectId)
      .where('archived_at', 'is', null)
      .execute();
    if (
      !project ||
      service?.project_id !== projectId ||
      (!allowArchivedSource && repositoryRows.length !== repositoryIds.length)
    )
      throw new BadRequestException('项目、服务和仓库必须存在且属于同一项目');
    for (const row of repositoryRows) validateGitUrl(row.clone_url);
    const repositories = new Map(repositoryRows.map((row) => [row.id, row]));
    const repository = repositories.get(definition.repositoryId) ?? {
      clone_url: '',
      credential_id: null,
    };
    if (!fromArtifact) {
      const nodeSecrets = pipelineNodeSecrets(definition);
      if (nodeSecrets.length) {
        const active = await this.database.db
          .selectFrom('credentials')
          .select('id')
          .where('id', 'in', nodeSecrets)
          .where('status', '=', 'ACTIVE')
          .execute();
        if (active.length !== nodeSecrets.length)
          throw new BadRequestException('环境节点引用的凭据不存在或已禁用');
      }
      const environmentIds = [
        ...new Set(
          definition.nodes?.flatMap((node) => Object.keys(node.environmentBranches ?? {})),
        ),
      ];
      if (mode === undefined && environmentIds.length) {
        const environments = await this.database.db
          .selectFrom('environments')
          .select('id')
          .where('project_id', '=', projectId)
          .where('id', 'in', environmentIds)
          .execute();
        if (environments.length !== environmentIds.length)
          throw new BadRequestException('源码节点的分支配置包含其他项目的环境');
      }
    }
    const registry =
      mode !== 'BUILD_ONLY' && definition.registryId
        ? await this.registries.get(definition.registryId)
        : undefined;
    return {
      repository,
      repositories,
      registry,
      projectName: project.name,
      serviceName: service.name,
    };
  }

  private async lockRepository(tx: Transaction<Database>, projectId: string, repositoryId: string) {
    const row = await tx
      .updateTable('repositories')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', repositoryId)
      .where('project_id', '=', projectId)
      .returning('clone_url')
      .executeTakeFirst();
    if (!row) throw new BadRequestException('项目仓库不存在');
    validateGitUrl(row.clone_url);
  }
  private async lockNodeCredentials(tx: Transaction<Database>, definition: PipelineDefinition) {
    for (const id of pipelineNodeSecrets(definition).sort()) {
      const locked = await tx
        .updateTable('credentials')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', id)
        .where('status', '=', 'ACTIVE')
        .returning('id')
        .executeTakeFirst();
      if (!locked) throw new BadRequestException('环境节点引用的凭据不存在或已禁用');
    }
  }
  async create(input: CreatePipelineDto, userId: string) {
    const inheritBuildLocation =
      input.definition.inheritBuildLocation || !input.definition.buildLocation;
    const definition: PipelineDefinition = {
      ...input.definition,
      inheritBuildLocation,
      buildLocation: inheritBuildLocation
        ? (await this.settings.get(input.projectId)).defaultBuildLocation
        : input.definition.buildLocation!,
    };
    await this.resources(input.projectId, input.serviceId, definition);
    const id = input.creationId ?? randomUUID(),
      now = Date.now();
    const created = await this.database.db.transaction().execute(async (tx) => {
      for (const repositoryId of pipelineSourceRepositories(definition))
        await this.lockRepository(tx, input.projectId, repositoryId);
      await this.lockNodeCredentials(tx, definition);
      if (input.definition.registryId) await lockRegistry(tx, input.definition.registryId);
      const inserted = await tx
        .insertInto('pipelines')
        .values({
          id,
          project_id: input.projectId,
          service_id: input.serviceId,
          name: input.name,
          enabled: input.enabled ? 1 : 0,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!inserted) {
        const previous = await tx
          .selectFrom('pipelines')
          .innerJoin('pipeline_versions', 'pipeline_versions.pipeline_id', 'pipelines.id')
          .select([
            'pipelines.name',
            'pipelines.enabled',
            'pipelines.current_version',
            'pipeline_versions.definition_json',
          ])
          .where('pipelines.id', '=', id)
          .where('pipelines.project_id', '=', input.projectId)
          .where('pipelines.service_id', '=', input.serviceId)
          .where('pipeline_versions.created_by', '=', userId)
          .where('pipeline_versions.version', '=', 1)
          .executeTakeFirst();
        if (
          !input.creationId ||
          !previous ||
          previous.current_version !== 1 ||
          previous.name !== input.name ||
          previous.enabled !== Number(input.enabled) ||
          previous.definition_json !== JSON.stringify(definition)
        )
          throw new ConflictException('流水线创建请求已被使用，请重新打开已保存的流水线。');
        return false;
      }
      await tx
        .insertInto('pipeline_versions')
        .values({
          id: randomUUID(),
          pipeline_id: id,
          version: 1,
          definition_json: JSON.stringify(definition),
          created_by: userId,
          created_at: now,
        })
        .execute();
      return true;
    });
    if (created) await this.audit.record(userId, 'pipeline.create', 'pipeline', id);
    return this.get(id);
  }
  async update(id: string, input: UpdatePipelineDto, userId: string) {
    const current = await this.get(id);
    const definition: PipelineDefinition = {
      ...input.definition,
      inheritBuildLocation:
        input.definition.inheritBuildLocation ??
        (!input.definition.buildLocation && Boolean(current.definition.inheritBuildLocation)),
      buildLocation: input.definition.inheritBuildLocation
        ? (await this.settings.get(current.projectId)).defaultBuildLocation
        : (input.definition.buildLocation ?? current.definition.buildLocation ?? 'TARGET'),
    };
    await this.resources(current.projectId, current.serviceId, definition);
    await this.database.db.transaction().execute(async (tx) => {
      for (const repositoryId of pipelineSourceRepositories(definition))
        await this.lockRepository(tx, current.projectId, repositoryId);
      await this.lockNodeCredentials(tx, definition);
      if (input.definition.registryId) await lockRegistry(tx, input.definition.registryId);
      const pipeline = await tx
        .updateTable('pipelines')
        .set((eb) => ({
          name: input.name,
          enabled: input.enabled ? 1 : 0,
          current_version: eb('current_version', '+', 1),
          updated_at: Date.now(),
        }))
        .where('id', '=', id)
        .returning('current_version')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('pipeline_versions')
        .values({
          id: randomUUID(),
          pipeline_id: id,
          version: pipeline.current_version,
          definition_json: JSON.stringify(definition),
          created_by: userId,
          created_at: Date.now(),
        })
        .execute();
    });
    await this.audit.record(userId, 'pipeline.update', 'pipeline', id);
    return this.get(id);
  }
  async remove(id: string, userId: string) {
    await this.get(id);
    await this.database.db
      .updateTable('pipelines')
      .set({ enabled: 0, updated_at: Date.now() })
      .where('id', '=', id)
      .execute();
    await this.audit.record(userId, 'pipeline.disable', 'pipeline', id);
    return { success: true };
  }
  private async prepare(
    id: string,
    input: RunPipelineDto,
    fromArtifact = false,
    webhookBranch?: string,
    profile?: DeliveryExecutionProfile,
  ) {
    if (input.mode !== undefined && input.mode !== 'BUILD_ONLY' && input.mode !== 'DEPLOY')
      throw new BadRequestException('无效的交付执行模式');
    const requestedSha = input.commitSha?.toLowerCase();
    if (requestedSha && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(requestedSha))
      throw new BadRequestException('执行必须固定完整 Git 提交 SHA');
    const pipeline = profile
      ? {
          id: profile.id,
          projectId: profile.projectId,
          serviceId: profile.serviceId,
          name: profile.name,
          enabled: true,
          currentVersion: 1,
        }
      : await this.get(id);
    if (!pipeline.enabled) throw new BadRequestException('Pipeline已禁用');
    const version = profile
      ? { id: profile.versionId, version: 1, definition_json: JSON.stringify(profile.definition) }
      : await this.database.db
          .selectFrom('pipeline_versions')
          .selectAll()
          .where('pipeline_id', '=', id)
          .where('version', '=', input.version ?? pipeline.currentVersion)
          .executeTakeFirst();
    if (!version) throw new NotFoundException('Pipeline版本不存在');
    const environment = await this.database.db
      .selectFrom('environments')
      .selectAll()
      .where('id', '=', input.environmentId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (environment?.project_id !== pipeline.projectId)
      throw new BadRequestException('运行环境必须属于当前项目');
    const env = await this.configs.readSnapshot(
      pipeline.serviceId,
      input.environmentId,
      input.targetId,
    );
    const defaults = await this.settings.get(pipeline.projectId);
    const definition = plainToInstance(
      PipelineDefinitionDto,
      JSON.parse(version.definition_json),
    ) as PipelineDefinition;
    const buildOnlyNodes =
      definition.nodes && !definition.nodes.some((node) => node.type === 'DEPLOY');
    if (definition.inheritBuildLocation) definition.buildLocation = defaults.defaultBuildLocation;
    const mode =
      input.mode ??
      env.config?.executionMode ??
      definition.defaultMode ??
      (buildOnlyNodes ? 'BUILD_ONLY' : 'DEPLOY');
    if (mode === 'DEPLOY' && buildOnlyNodes && !fromArtifact)
      throw new BadRequestException('所选流水线版本没有发布节点，可构建后手动部署归档产物');
    if (input.allowPartialDeploy && mode !== 'DEPLOY')
      throw new BadRequestException('仅构建不支持部分发布');
    const config = env.config;
    if (config) {
      for (const name of [
        'buildLocation',
        'artifactType',
        'buildCommand',
        'outputPath',
        'deployPath',
        'composeFilePath',
        'startCommand',
        'stopCommand',
        'healthCheckCommand',
      ] as const) {
        const value = config[name];
        const authored = profile?.authoredFields.includes(name);
        if (
          value &&
          (!profile ||
            (name === 'buildLocation'
              ? profile.definition.inheritBuildLocation
              : name !== 'artifactType' && !authored))
        )
          (definition as unknown as Record<string, string>)[name] = value;
      }
      if (config.workingDirectory && !profile?.authoredFields.includes('repoPath'))
        definition.repoPath = config.workingDirectory;
      const buildNode = definition.nodes?.find((node) => node.type === 'BUILD');
      if (buildNode && config.buildCommand && (!profile || !buildNode.command))
        buildNode.command = config.buildCommand;
    }
    const errors = await validate(plainToInstance(PipelineDefinitionDto, definition));
    if (errors.length) throw new BadRequestException('当前交付配置无效');
    const configured = env.config?.targetSelection;
    const defaultParallel =
      input.serverIds !== undefined || input.groupIds !== undefined
        ? (input.maxParallel ?? configured?.maxParallel ?? defaults.defaultMaxParallelTargets)
        : 1;
    const selection =
      directDeploymentSelection(
        {
          ...input,
          strategy: input.strategy ?? configured?.strategy,
          failurePolicy: input.failurePolicy ?? configured?.failurePolicy,
        },
        defaultParallel,
      ) ?? (input.targetId ? undefined : (configured ?? undefined));
    const legacyId =
      input.targetId ?? (selection ? undefined : (env.config?.targetId ?? undefined));
    const legacy = legacyId
      ? await this.database.db
          .selectFrom('deployment_targets')
          .selectAll()
          .where('id', '=', legacyId)
          .executeTakeFirst()
      : undefined;
    const targetless =
      !selection &&
      !legacyId &&
      profile &&
      mode === 'BUILD_ONLY' &&
      definition.buildLocation === 'MANAGER';
    if (!selection && !legacy && !targetless)
      throw new BadRequestException('请选择服务器或服务器分组');
    const members = selection
      ? await selectedServerIds(this.database.db, selection)
      : !legacy
        ? []
        : (
            await this.database.db
              .selectFrom('deployment_target_servers')
              .select('server_id')
              .where('target_id', '=', legacy.id)
              .orderBy('sort_order')
              .execute()
          ).map((member) => member.server_id);
    const servers = targetless ? [] : await this.servers.snapshot(members);
    const target = selection
      ? {
          id: undefined,
          selection,
          strategy: selection.strategy,
          max_parallel: selection.maxParallel,
          failure_policy: selection.failurePolicy,
        }
      : {
          id: legacy?.id,
          selection: undefined,
          strategy: legacy?.strategy ?? 'SEQUENTIAL',
          max_parallel: legacy?.max_parallel ?? 1,
          failure_policy: legacy?.failure_policy ?? 'STOP',
        };
    if (
      (mode === 'DEPLOY' || definition.buildLocation === 'TARGET') &&
      servers.some((s) => !s.credentialId || !s.hostKeyFingerprint)
    )
      throw new BadRequestException('执行目标必须配置SSH凭据和已确认指纹');
    const { repository, repositories, registry, projectName, serviceName } = await this.resources(
      pipeline.projectId,
      pipeline.serviceId,
      definition,
      mode,
      fromArtifact,
      fromArtifact && !!profile,
    );
    const sources =
      definition.nodes && !fromArtifact
        ? await resolvePipelineSources(
            definition,
            repositories,
            this.metadata,
            environment.id,
            requestedSha,
            webhookBranch,
          )
        : undefined;
    const commitSha = sources?.commitSha ?? requestedSha;
    if (!commitSha) throw new BadRequestException('请选择完整 Git Commit SHA');
    const protectedVariables = new Set(Object.keys(env.secretVariables));
    if (!fromArtifact) {
      for (const node of definition.nodes ?? []) {
        for (const variable of node.variables ?? []) {
          if (protectedVariables.has(variable.key))
            throw new BadRequestException('环境节点不能覆盖凭据变量');
          if (variable.credentialId) protectedVariables.add(variable.key);
        }
      }
    }
    return {
      pipeline,
      targetWorkspaceRoot:
        !fromArtifact && definition.buildLocation === 'TARGET'
          ? defaults.targetWorkspaceRoot
          : undefined,
      version,
      environment,
      target,
      servers,
      definition,
      repository,
      registry,
      projectName,
      serviceName,
      sources,
      commitSha,
      env,
      mode,
      allowPartialDeploy: input.allowPartialDeploy === true,
    };
  }
  private configurationHash(
    p: Awaited<ReturnType<PipelinesService['prepare']>>,
    includeSourceCommits = true,
  ) {
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, canonical(item)]),
            )
          : value;
    return createHash('sha256')
      .update(
        JSON.stringify(
          canonical({
            definition: p.definition,
            targetWorkspaceRoot: p.targetWorkspaceRoot,
            // Preserve existing deploy confirmations made before execution modes were introduced.
            ...(p.mode === 'BUILD_ONLY' ? { mode: p.mode } : {}),
            ...(p.mode === 'DEPLOY' &&
              p.env.config?.releasePolicy && {
                releasePolicy: p.env.config.releasePolicy,
              }),
            ...(p.allowPartialDeploy && { allowPartialDeploy: true }),
            repository: { url: p.repository.clone_url, credentialId: p.repository.credential_id },
            ...(p.sources && {
              nodeSources: Object.fromEntries(
                Object.entries(p.sources.nodeSources).map(([id, source]) => [
                  id,
                  includeSourceCommits
                    ? source
                    : { url: source.url, credentialId: source.credentialId, branch: source.branch },
                ]),
              ),
            }),
            ...((p.sources || includeSourceCommits) && {
              projectName: p.projectName,
              serviceName: p.serviceName,
            }),
            ...(p.registry && {
              registry: {
                registryUrl: p.registry.registryUrl,
                credentialId: p.registry.credentialId,
              },
            }),
            variables: p.env.variables,
            secretVariables: p.env.secretVariables,
            servers: p.servers.map((s) => ({
              id: s.id,
              host: s.host,
              port: s.port,
              username: s.username,
              credentialId: s.credentialId,
              hostKeyFingerprint: s.hostKeyFingerprint,
            })),
            strategy: p.target.strategy,
            maxParallel: p.target.max_parallel,
            failurePolicy: p.target.failure_policy,
            ...(p.target.selection?.groupIds.length && { groupIds: p.target.selection.groupIds }),
          }),
        ),
      )
      .digest('hex');
  }
  async preview(
    id: string,
    input: RunPipelineDto,
    webhookBranch?: string,
    profile?: DeliveryExecutionProfile,
  ) {
    const p = await this.prepare(id, input, false, webhookBranch, profile);
    const configurationHash = this.configurationHash(p);
    const aiApprovalHash = createHash('sha256')
      .update(
        JSON.stringify([
          id,
          p.version.id,
          p.environment.id,
          p.target.id,
          p.mode,
          p.commitSha,
          configurationHash,
        ]),
      )
      .digest('hex');
    return {
      pipelineId: id,
      projectId: p.pipeline.projectId,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      environmentType: p.environment.environment_type,
      targetId: p.target.id ?? null,
      targetSelection: p.target.selection ?? null,
      serverIds: p.servers.map((s) => s.id),
      mode: p.mode,
      requireApproval: p.mode === 'DEPLOY' && Boolean(p.env.config?.releasePolicy?.requireApproval),
      allowPartialDeploy: p.allowPartialDeploy,
      version: p.version.version,
      commitSha: p.commitSha,
      ...(p.sources && { nodeSources: p.sources.preview }),
      definition: p.definition,
      targetWorkspaceRoot: p.targetWorkspaceRoot,
      configurationHash,
      ...(webhookBranch && { webhookConfigurationHash: this.configurationHash(p, false) }),
      aiApprovalHash,
      hasSecretVariables: Object.keys(p.env.secretVariables).length > 0,
    };
  }
  assertAutomaticBuild(preview: { definition: PipelineDefinition; hasSecretVariables: boolean }) {
    if (preview.definition.buildLocation !== 'MANAGER')
      throw new BadRequestException('自动触发仅支持管理端隔离构建，请修改有效构建位置');
    if (preview.hasSecretVariables || pipelineNodeSecrets(preview.definition).length)
      throw new BadRequestException('自动构建不能使用环境或节点中的敏感变量');
    if (!webhookBuildSocket())
      throw new BadRequestException('请先配置 Webhook 专用 rootless Docker 构建环境');
  }

  private snapshot(
    p: Awaited<ReturnType<PipelinesService['prepare']>>,
    commitSha: string,
  ): PipelineSnapshot {
    return {
      ...(p.targetWorkspaceRoot && { targetWorkspaceRoot: p.targetWorkspaceRoot }),
      runId: randomUUID(),
      pipelineId: p.pipeline.id,
      pipelineVersionId: p.version.id,
      projectId: p.pipeline.projectId,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      targetId: p.target.id,
      ...(p.target.selection && {
        targetSelection: p.target.selection,
        targetMemberIds: p.servers.map((server) => server.id),
      }),
      commitSha,
      repository: { url: p.repository.clone_url, credentialId: p.repository.credential_id },
      projectName: p.projectName,
      serviceName: p.serviceName,
      ...(p.sources && { nodeSources: p.sources.nodeSources }),
      ...(p.registry && {
        registry: { registryUrl: p.registry.registryUrl, credentialId: p.registry.credentialId },
      }),
      definition: p.definition,
      variables: p.env.variables,
      secretVariables: p.env.secretVariables,
      releasePolicy: p.env.config?.releasePolicy,
    };
  }

  private taskInput(
    snapshot: PipelineSnapshot,
    name: string,
    payload: Omit<TaskPayload, 'pipeline'>,
    idempotencyKey?: string,
    gitRef = snapshot.commitSha,
  ): CreateTaskInput {
    return {
      type: 'PIPELINE',
      name,
      idempotencyKey,
      scope: {
        projectId: snapshot.projectId,
        serviceId: snapshot.serviceId,
        environmentId: snapshot.environmentId,
        targetId: snapshot.targetId,
      },
      pipelineRun: {
        id: snapshot.runId,
        pipelineId: snapshot.pipelineId,
        pipelineVersionId: snapshot.pipelineVersionId,
        gitRef,
        commitSha: snapshot.commitSha,
        buildLocation: snapshot.definition.buildLocation,
        artifactType: snapshot.definition.artifactType,
        triggerType: snapshot.triggerType,
      },
      payload: { ...payload, pipeline: snapshot },
    };
  }

  private executionTargets(
    p: Awaited<ReturnType<PipelinesService['prepare']>>,
  ): Omit<TaskPayload, 'pipeline'> {
    return {
      targets: p.servers,
      steps: [],
      strategy: p.target.strategy as 'PARALLEL' | 'SEQUENTIAL',
      maxParallel: p.target.max_parallel,
      failurePolicy: p.target.failure_policy as 'STOP' | 'CONTINUE',
      timeout: 1200,
    };
  }

  private async finishBuild(
    tx: Transaction<Database>,
    task: TaskRecord,
    userId: string,
    status: TaskStatus,
  ) {
    const build = task.payload.pipeline;
    if (build?.mode !== 'BUILD_ONLY' || !build.deployAfterBuild) return;
    if (status !== 'SUCCESS' && !(status === 'PARTIAL_FAILED' && build.allowPartialDeploy))
      return { deploymentSkippedReason: '构建未达到发布条件，当前运行版本保留' };

    const automatic = build.triggerType && build.triggerType !== 'MANUAL';
    const operator = await tx
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .where('status', '=', 'ACTIVE')
      .where('role', 'in', automatic ? ['ADMIN'] : ['ADMIN', 'OPERATOR'])
      .where('must_change_password', '=', 0)
      .executeTakeFirst();
    const pipeline = await tx
      .selectFrom('pipelines')
      .innerJoin('projects', 'projects.id', 'pipelines.project_id')
      .select('pipelines.id')
      .where('pipelines.id', '=', build.pipelineId)
      .where('pipelines.enabled', '=', 1)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!operator || !pipeline)
      return { deploymentSkippedReason: '发起人或 Pipeline 已失去执行资格，请人工确认后发布' };

    const completed = new Set(
      (
        await tx
          .selectFrom('task_targets')
          .select('server_id')
          .where('task_id', '=', task.id)
          .where('status', '=', 'SUCCESS')
          .execute()
      ).map((row) => row.server_id),
    );
    const targets = task.payload.targets.filter((target) => completed.has(target.id));
    const candidates = await this.artifacts.deployableIn(tx, build.runId);
    const selected =
      build.definition.buildLocation === 'MANAGER'
        ? candidates.filter((item) => item.serverId === null)
        : candidates.filter((item) => completed.has(item.serverId));
    if (
      !targets.length ||
      !this.artifactsMatchTargets(
        selected,
        targets.map((target) => target.id),
      )
    )
      return { deploymentSkippedReason: '已归档产物与成功构建的目标不匹配，请核查后发布' };

    const deployment: PipelineSnapshot = {
      ...build,
      mode: 'DEPLOY_ARTIFACT',
      runId: randomUUID(),
      deployAfterBuild: undefined,
      allowPartialDeploy: undefined,
      deploymentArtifacts: selected,
      sourceBuildTaskId: task.id,
    };
    const deploymentTaskId = await this.tasks.createInTransaction(
      tx,
      this.taskInput(
        deployment,
        `${task.name} · 部署`,
        { ...task.payload, targets },
        `deploy-from-build:${task.id}`,
      ),
      userId,
    );
    await this.audit.record(
      userId,
      'pipeline.artifact-deploy',
      'task',
      deploymentTaskId,
      {
        sourceBuildTaskId: task.id,
        artifactIds: selected.map((item) => item.id),
        targetCount: targets.length,
      },
      tx,
    );
    return { deploymentTaskId };
  }

  private artifactsMatchTargets(artifacts: { serverId: string | null }[], servers: string[]) {
    if (artifacts.length === 1 && artifacts[0]?.serverId === null) return servers.length > 0;
    const sources = new Set(artifacts.map((artifact) => artifact.serverId));
    return (
      servers.length > 0 &&
      artifacts.length === servers.length &&
      servers.every((id) => sources.has(id))
    );
  }

  async deliveryArtifactBuild(
    projectId: string,
    serviceId: string,
    environmentId: string,
    artifactIds: string[],
  ) {
    if (!artifactIds.length) throw new BadRequestException('请选择构建产物');
    const rows = await this.database.db
      .selectFrom('artifacts')
      .innerJoin('pipeline_runs as build', 'build.id', 'artifacts.pipeline_run_id')
      .innerJoin('tasks as task', 'task.id', 'build.task_id')
      .select([
        'build.id',
        'task.payload_json',
        'build.commit_sha',
        'artifacts.artifact_type',
        'artifacts.artifact_name',
        'artifacts.registry_id',
      ])
      .where('artifacts.id', 'in', artifactIds)
      .where('artifacts.project_id', '=', projectId)
      .where('artifacts.service_id', '=', serviceId)
      .where('build.project_id', '=', projectId)
      .where('build.service_id', '=', serviceId)
      .where('build.environment_id', '=', environmentId)
      .where('task.status', 'in', ['SUCCESS', 'PARTIAL_FAILED'])
      .execute();
    const row = rows[0];
    if (
      !row ||
      rows.length !== artifactIds.length ||
      rows.some(
        (candidate) =>
          candidate.id !== row.id ||
          candidate.artifact_type !== row.artifact_type ||
          candidate.artifact_name !== row.artifact_name,
      )
    )
      throw new BadRequestException('请选择该服务和环境下同一次成功构建的产物');
    const build = (JSON.parse(row.payload_json) as TaskPayload).pipeline;
    if (!build || build.mode === 'DEPLOY_ARTIFACT')
      throw new BadRequestException('产物没有可用的构建记录');
    return {
      definition: {
        ...build.definition,
        artifactType: row.artifact_type as PipelineDefinition['artifactType'],
        registryId: row.registry_id ?? undefined,
      },
      commitSha: row.commit_sha,
    };
  }

  async deliveryArtifactCandidates(projectId: string, serviceId: string, environmentId: string) {
    return this.database.db
      .selectFrom('artifacts')
      .innerJoin('pipeline_runs as build', 'build.id', 'artifacts.pipeline_run_id')
      .innerJoin('tasks as task', 'task.id', 'build.task_id')
      .select(['build.id', 'build.commit_sha', 'task.payload_json', 'task.finished_at'])
      .where('artifacts.project_id', '=', projectId)
      .where('artifacts.service_id', '=', serviceId)
      .where('build.project_id', '=', projectId)
      .where('build.service_id', '=', serviceId)
      .where('build.environment_id', '=', environmentId)
      .where('task.status', 'in', ['SUCCESS', 'PARTIAL_FAILED'])
      .distinct()
      .orderBy('task.finished_at', 'desc')
      .orderBy('build.id', 'desc')
      .execute();
  }

  async deliveryArtifactIds(
    runId: string,
    targetIds: string[],
    artifactKind?: string,
    name?: string,
  ) {
    const artifacts = await this.artifacts.deployableIn(this.database.db, runId);
    const groups = new Map<string, typeof artifacts>();
    for (const artifact of artifacts) {
      if ((artifactKind && artifact.kind !== artifactKind) || (name && artifact.name !== name))
        continue;
      const key = artifact.name ?? '';
      const group = groups.get(key);
      if (group) group.push(artifact);
      else groups.set(key, [artifact]);
    }
    for (const candidates of groups.values()) {
      const managedArchive = candidates.find((artifact) => artifact.serverId === null);
      const selected = managedArchive
        ? [managedArchive]
        : candidates.filter(
            (artifact) => artifact.serverId && targetIds.includes(artifact.serverId),
          );
      if (this.artifactsMatchTargets(selected, targetIds)) return selected.map(({ id }) => id);
    }
    return [];
  }

  resolveDeliveryBranch(projectId: string, repositoryId: string, branch?: string) {
    return this.metadata.planGraphCheckout(projectId, { repositoryId, mode: 'BRANCH', branch });
  }

  private async prepareArtifactDeploy(
    id: string,
    input: ArtifactDeployPreviewDto,
    profile?: DeliveryExecutionProfile,
  ) {
    const artifactIds = [...new Set(input.artifactIds)].sort();
    if (!artifactIds.length || artifactIds.length !== input.artifactIds.length)
      throw new BadRequestException('请选择互不重复的部署产物');
    const db = this.database.db;
    const query = db
      .selectFrom('artifacts')
      .innerJoin('pipeline_runs', 'pipeline_runs.id', 'artifacts.pipeline_run_id')
      .innerJoin('pipeline_versions', 'pipeline_versions.id', 'pipeline_runs.pipeline_version_id')
      .innerJoin('tasks', 'tasks.id', 'pipeline_runs.task_id')
      .select([
        'artifacts.id',
        'artifacts.artifact_type',
        'artifacts.artifact_name',
        'artifacts.artifact_kind',
        'artifacts.checksum',
        'artifacts.compose_checksum',
        'artifacts.image_digest',
        'artifacts.storage_key',
        'artifacts.server_id',
        'artifacts.storage_type',
        'artifacts.registry_id',
        'artifacts.source_commit as artifact_commit',
        'pipeline_runs.commit_sha',
        'pipeline_runs.id as run_id',
        'pipeline_runs.task_id',
        'pipeline_versions.version',
        'tasks.status',
      ])
      .where('artifacts.id', 'in', artifactIds)
      .where('pipeline_runs.environment_id', '=', input.environmentId);
    const scoped = profile
      ? query
          .where('pipeline_runs.project_id', '=', profile.projectId)
          .where('pipeline_runs.service_id', '=', profile.serviceId)
          .where('artifacts.project_id', '=', profile.projectId)
          .where('artifacts.service_id', '=', profile.serviceId)
      : query.where('pipeline_runs.pipeline_id', '=', id);
    const rows = await scoped.orderBy('artifacts.id').execute();
    const source = rows[0];
    if (
      !source ||
      rows.length !== artifactIds.length ||
      rows.some(
        (row) =>
          row.run_id !== source.run_id ||
          row.artifact_name !== source.artifact_name ||
          row.artifact_kind !== source.artifact_kind ||
          (row.artifact_commit !== null && row.artifact_commit !== source.commit_sha),
      )
    )
      throw new BadRequestException('产物必须来自相同服务和环境的一次构建');
    if (source.status !== 'SUCCESS' && source.status !== 'PARTIAL_FAILED')
      throw new ConflictException('来源任务没有可发布的成功构建');
    const candidates = await this.artifacts.deployableIn(db, source.run_id, !!profile);
    const references = candidates.filter((candidate) => artifactIds.includes(candidate.id));
    if (references.length !== rows.length)
      throw new ConflictException('产物缺少可校验的发布所需数据');
    const serverIds = rows.flatMap((row) => (row.server_id ? [row.server_id] : []));
    if (serverIds.length) {
      const successful = await db
        .selectFrom('task_targets')
        .select('server_id')
        .where('task_id', '=', source.task_id)
        .where('server_id', 'in', serverIds)
        .where('status', '=', 'SUCCESS')
        .execute();
      if (successful.length !== new Set(serverIds).size)
        throw new ConflictException('所选产物包含未成功构建的目标');
    } else if (source.status !== 'SUCCESS') {
      throw new ConflictException('来源任务未成功完成');
    }
    const p = await this.prepare(
      id,
      {
        ...input,
        confirmed: true,
        version: profile ? 1 : (input.version ?? source.version),
        commitSha: source.commit_sha,
        mode: 'DEPLOY',
      },
      true,
      undefined,
      profile,
    );
    if (
      rows.some(
        (row) =>
          row.artifact_type !== p.definition.artifactType ||
          (row.storage_type === 'REGISTRY_IMAGE' && row.registry_id !== p.definition.registryId),
      )
    )
      throw new BadRequestException('产物类型或 Registry 与有效部署配置不一致');
    const targets = p.servers.map((server) => server.id);
    if (!this.artifactsMatchTargets(references, targets))
      throw new BadRequestException('目标端构建产物须与所选部署目标逐一匹配');
    const reviewRequired = p.env.config?.releasePolicy?.requireCodeReview;
    if (reviewRequired && !this.sourceReviews) throw new ConflictException('代码审核服务不可用');
    const sourceReview = reviewRequired
      ? await this.sourceReviews?.requireReviewed(
          p.pipeline.projectId,
          p.pipeline.serviceId,
          p.environment.id,
          source.commit_sha,
          { force: true },
        )
      : undefined;
    const configurationHash = createHash('sha256')
      .update(
        JSON.stringify([
          id,
          p.version.id,
          input.environmentId,
          input.targetId,
          this.configurationHash(p),
          rows,
          references,
          sourceReview,
        ]),
      )
      .digest('hex');
    return { p, references, source, configurationHash, artifactIds, targets };
  }

  async previewArtifactDeploy(
    id: string,
    input: ArtifactDeployPreviewDto,
    profile?: DeliveryExecutionProfile,
  ) {
    const { p, source, configurationHash, artifactIds, targets } = await this.prepareArtifactDeploy(
      id,
      input,
      profile,
    );
    const buildTask = await this.database.db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', source.task_id)
      .executeTakeFirstOrThrow();
    const built = (JSON.parse(buildTask.payload_json) as TaskPayload).pipeline;
    const sources = (built?.definition.nodes ?? []).flatMap((node) => {
      const snapshot = built?.nodeSources?.[node.id];
      if (node.type !== 'CHECKOUT' || !snapshot || !built) return [];
      return [
        {
          id: node.id,
          repositoryId: node.repositoryId ?? built.definition.repositoryId,
          commitSha: snapshot.commitSha,
          branch: snapshot.branch,
        },
      ];
    });
    return {
      pipelineId: id,
      projectId: p.pipeline.projectId,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      environmentType: p.environment.environment_type,
      targetId: p.target.id ?? null,
      targetSelection: p.target.selection ?? null,
      serverIds: targets,
      mode: 'DEPLOY_ARTIFACT' as const,
      requireApproval: Boolean(p.env.config?.releasePolicy?.requireApproval),
      requireCodeReview: Boolean(p.env.config?.releasePolicy?.requireCodeReview),
      version: p.version.version,
      commitSha: source.commit_sha,
      sourceBuildTaskId: source.task_id,
      nodeSources: sources.length
        ? sources
        : [{ repositoryId: built?.definition.repositoryId, commitSha: source.commit_sha }],
      definition: p.definition,
      configurationHash,
      artifactIds,
    };
  }

  async previewArtifactDeployPlan(
    id: string,
    input: Omit<ArtifactDeployPreviewDto, 'artifactIds'> & { commitSha: string },
    profile?: DeliveryExecutionProfile,
  ) {
    const p = await this.prepare(
      id,
      { ...input, confirmed: true, mode: 'DEPLOY' },
      true,
      undefined,
      profile,
    );
    const requireCodeReview = Boolean(p.env.config?.releasePolicy?.requireCodeReview);
    if (requireCodeReview && !this.sourceReviews) throw new ConflictException('代码审核服务不可用');
    if (requireCodeReview)
      await this.sourceReviews?.requireReviewed(
        p.pipeline.projectId,
        p.pipeline.serviceId,
        p.environment.id,
        p.commitSha,
        { force: true },
      );
    return {
      version: p.version.version,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      commitSha: p.commitSha,
      serverIds: p.servers.map(({ id }) => id),
      requireApproval: Boolean(p.env.config?.releasePolicy?.requireApproval),
      requireCodeReview,
      configurationHash: this.configurationHash(p),
    };
  }

  async deployArtifact(
    id: string,
    input: ArtifactDeployDto,
    userId: string,
    options: {
      idempotencyKey?: string;
      expectedPlanHash?: string;
      profile?: DeliveryExecutionProfile;
      afterInsert?: (tx: Transaction<Database>, taskId: string) => Promise<void>;
    } = {},
  ) {
    if (input.confirmed !== true) throw new BadRequestException('必须确认产物和部署目标');
    const { p, references, source, configurationHash, artifactIds, targets } =
      await this.prepareArtifactDeploy(id, input, options.profile);
    if (
      input.expectedConfigurationHash !== configurationHash ||
      (options.expectedPlanHash && options.expectedPlanHash !== this.configurationHash(p)) ||
      (input.expectedServerIds &&
        JSON.stringify([...input.expectedServerIds].sort()) !== JSON.stringify([...targets].sort()))
    )
      throw new ConflictException('产物、执行目标或配置已变化，请重新确认');
    const snapshot: PipelineSnapshot = {
      ...this.snapshot(p, source.commit_sha),
      mode: 'DEPLOY_ARTIFACT',
      deploymentArtifacts: references,
      sourceBuildTaskId: source.task_id,
      ...(options.profile && { artifactServiceScope: true }),
    };
    const task = await this.tasks.create(
      this.taskInput(
        snapshot,
        `${p.pipeline.name} · v${p.version.version} · ${source.commit_sha.slice(0, 8)} · 部署产物`,
        this.executionTargets(p),
        options.idempotencyKey,
      ),
      userId,
      async (tx) => {
        if (options.profile) await storeDeliveryProfile(tx, options.profile, userId);
        if (snapshot.targetSelection)
          await confirmDeploymentMembers(tx, snapshot.targetSelection, targets);
      },
      options.afterInsert,
    );
    if (task.pipelineRunId === snapshot.runId)
      await this.audit.record(userId, 'pipeline.artifact-deploy', 'task', task.id, {
        sourceBuildTaskId: source.task_id,
        artifactIds,
        targetCount: targets.length,
      });
    return task;
  }

  async run(
    id: string,
    input: ConfirmedPipelineRunDto,
    userId: string,
    options: {
      triggerType?: AutomaticPipelineTrigger;
      idempotencyKey?: string;
      gitRef?: string;
      beforeInsert?: (tx: Transaction<Database>) => Promise<void>;
      profile?: DeliveryExecutionProfile;
      graph?: GraphExecutionScope;
      afterInsert?: (tx: Transaction<Database>, taskId: string, created: boolean) => Promise<void>;
    } = {},
  ) {
    if (input.confirmed !== true) throw new BadRequestException('请确认执行交付操作');
    if (
      options.triggerType &&
      (!options.gitRef?.startsWith('refs/heads/') ||
        !input.commitSha ||
        !input.expectedConfigurationHash)
    )
      throw new BadRequestException('自动触发必须固定分支、提交和已确认的配置');
    const p = await this.prepare(
      id,
      input,
      false,
      options.triggerType ? options.gitRef?.slice('refs/heads/'.length) : undefined,
      options.profile,
    );
    if ((p.target.selection || p.definition.nodes) && !input.expectedConfigurationHash)
      throw new ConflictException('请先预览并确认服务器、分组和执行配置');
    if (options.triggerType)
      this.assertAutomaticBuild({
        definition: p.definition,
        hasSecretVariables: Object.keys(p.env.secretVariables).length > 0,
      });
    if (
      input.expectedServerIds &&
      JSON.stringify([...input.expectedServerIds].sort()) !==
        JSON.stringify(p.servers.map((s) => s.id).sort())
    )
      throw new ConflictException('执行目标已变化，请重新确认');
    if (
      input.expectedConfigurationHash &&
      input.expectedConfigurationHash !== this.configurationHash(p)
    )
      throw new ConflictException('执行配置已变化，请重新确认');
    const commit = p.commitSha;
    if (options.graph?.workspace) {
      const workspace = await ownedGraphWorkspace(
        this.database.db,
        p.pipeline.projectId,
        options.graph.workspace,
      );
      if (workspace.repositoryId !== p.definition.repositoryId || workspace.commitSha !== commit)
        throw new ConflictException('构建工作区与已确认的源码版本不一致');
    }
    if (options.graph?.variables?.workspace)
      await ownedGraphWorkspace(
        this.database.db,
        p.pipeline.projectId,
        options.graph.variables.workspace,
      );
    const snapshot: PipelineSnapshot = {
      ...this.snapshot(p, commit),
      mode: 'BUILD_ONLY',
      ...(p.mode === 'DEPLOY' && {
        deployAfterBuild: true,
        allowPartialDeploy: p.allowPartialDeploy,
      }),
      triggerType: options.triggerType ?? 'MANUAL',
      graph: options.graph,
    };
    const task = await this.tasks.create(
      this.taskInput(
        snapshot,
        `${p.pipeline.name} · v${p.version.version} · ${commit.slice(0, 8)} · ${p.mode === 'BUILD_ONLY' ? '仅构建' : '构建'}`,
        this.executionTargets(p),
        options.idempotencyKey,
        options.gitRef,
      ),
      userId,
      async (tx) => {
        if (options.profile) await storeDeliveryProfile(tx, options.profile, userId);
        await options.beforeInsert?.(tx);
        if (snapshot.targetSelection)
          await confirmDeploymentMembers(tx, snapshot.targetSelection, snapshot.targetMemberIds!);
        if (
          (options.triggerType === 'WEBHOOK' || options.triggerType === 'POLL') &&
          !snapshot.deployAfterBuild
        )
          return findLegacyWebhookTask(
            tx,
            snapshot,
            this.executionTargets(p),
            options.gitRef!,
            input.targetId ?? p.env.config?.targetId,
          );
      },
      options.afterInsert &&
        (async (tx, taskId) => {
          const run = await tx
            .selectFrom('pipeline_runs')
            .select('id')
            .where('task_id', '=', taskId)
            .executeTakeFirstOrThrow();
          await options.afterInsert!(tx, taskId, run.id === snapshot.runId);
        }),
    );
    if (task.pipelineRunId === snapshot.runId) {
      await this.audit.record(userId, 'pipeline.run', 'task', task.id, {
        pipelineId: id,
        version: p.version.version,
        commit,
        mode: p.mode,
        triggerType: snapshot.triggerType,
        targetCount: p.servers.length,
      });
    }
    return task;
  }
}
