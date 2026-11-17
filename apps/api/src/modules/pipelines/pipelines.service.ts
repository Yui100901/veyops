import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
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
import type { PipelineDefinition, PipelineExecutionMode, PipelineSnapshot } from './pipeline.types';
import { safeDeployPath, validateDefinition, validateGitUrl } from './pipeline.validation';

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
  ) {}
  onModuleInit() {
    this.handlers.register({
      type: 'PIPELINE',
      execute: (task, context) => this.executor.execute(task, context),
      onFinalize: (tx, task, userId, status) => this.finishBuild(tx, task, userId, status),
      afterCompletion: (task, signal) => this.analysis.record(task, signal),
    });
  }
  async list(projectId?: string) {
    let q = this.database.db.selectFrom('pipelines').selectAll();
    if (projectId) q = q.where('project_id', '=', projectId);
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
  ) {
    validateDefinition(definition, mode === 'DEPLOY' && !fromArtifact);
    if (fromArtifact) safeDeployPath(definition.deployPath);
    const project = await this.database.db
      .selectFrom('projects')
      .select('id')
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    const service = await this.database.db
      .selectFrom('services')
      .select('project_id')
      .where('id', '=', serviceId)
      .executeTakeFirst();
    const repository = await this.database.db
      .selectFrom('repositories')
      .selectAll()
      .where('id', '=', definition.repositoryId)
      .executeTakeFirst();
    if (!project || service?.project_id !== projectId || repository?.project_id !== projectId)
      throw new BadRequestException('项目、服务和仓库必须存在且属于同一项目');
    validateGitUrl(repository.clone_url);
    const registry =
      mode !== 'BUILD_ONLY' && definition.registryId
        ? await this.registries.get(definition.registryId)
        : undefined;
    return { repository, registry };
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
  async create(input: CreatePipelineDto, userId: string) {
    const definition: PipelineDefinition = {
      ...input.definition,
      buildLocation:
        input.definition.buildLocation ?? (await this.settings.get()).defaultBuildLocation,
    };
    await this.resources(input.projectId, input.serviceId, definition);
    const id = randomUUID(),
      now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      await this.lockRepository(tx, input.projectId, input.definition.repositoryId);
      if (input.definition.registryId) await lockRegistry(tx, input.definition.registryId);
      await tx
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
        .execute();
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
    });
    await this.audit.record(userId, 'pipeline.create', 'pipeline', id);
    return this.get(id);
  }
  async update(id: string, input: UpdatePipelineDto, userId: string) {
    const current = await this.get(id);
    const definition: PipelineDefinition = {
      ...input.definition,
      buildLocation: input.definition.buildLocation ?? current.definition.buildLocation ?? 'TARGET',
    };
    await this.resources(current.projectId, current.serviceId, definition);
    await this.database.db.transaction().execute(async (tx) => {
      await this.lockRepository(tx, current.projectId, input.definition.repositoryId);
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
  private async prepare(id: string, input: RunPipelineDto, fromArtifact = false) {
    const mode = input.mode ?? 'DEPLOY';
    if (mode !== 'BUILD_ONLY' && mode !== 'DEPLOY')
      throw new BadRequestException('无效Pipeline执行模式');
    if (input.allowPartialDeploy && mode !== 'DEPLOY')
      throw new BadRequestException('仅构建不支持部分发布');
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(input.commitSha))
      throw new BadRequestException('Pipeline必须固定完整Git Commit SHA');
    const pipeline = await this.get(id);
    if (!pipeline.enabled) throw new BadRequestException('Pipeline已禁用');
    const version = await this.database.db
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
      .executeTakeFirst();
    if (environment?.project_id !== pipeline.projectId)
      throw new BadRequestException('环境必须属于Pipeline项目');
    const target = await this.database.db
      .selectFrom('deployment_targets')
      .selectAll()
      .where('id', '=', input.targetId)
      .executeTakeFirst();
    if (!target) throw new BadRequestException('执行目标不存在');
    const members = await this.database.db
      .selectFrom('deployment_target_servers')
      .select('server_id')
      .where('target_id', '=', target.id)
      .orderBy('sort_order')
      .execute();
    const servers = await this.servers.snapshot(members.map((m) => m.server_id));
    const env = await this.configs.readSnapshot(
      pipeline.serviceId,
      input.environmentId,
      input.targetId,
    );
    const definition = plainToInstance(
      PipelineDefinitionDto,
      JSON.parse(version.definition_json),
    ) as PipelineDefinition;
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
        if (value) (definition as unknown as Record<string, string>)[name] = value;
      }
      if (config.workingDirectory) definition.repoPath = config.workingDirectory;
    }
    const errors = await validate(plainToInstance(PipelineDefinitionDto, definition));
    if (errors.length) throw new BadRequestException('有效Pipeline配置不合法');
    if (
      (mode === 'DEPLOY' || definition.buildLocation === 'TARGET') &&
      servers.some((s) => !s.credentialId || !s.hostKeyFingerprint)
    )
      throw new BadRequestException('执行目标必须配置SSH凭据和已确认指纹');
    const { repository, registry } = await this.resources(
      pipeline.projectId,
      pipeline.serviceId,
      definition,
      mode,
      fromArtifact,
    );
    return {
      pipeline,
      version,
      environment,
      target,
      servers,
      definition,
      repository,
      registry,
      env,
      mode,
      allowPartialDeploy: input.allowPartialDeploy === true,
    };
  }
  private configurationHash(p: Awaited<ReturnType<PipelinesService['prepare']>>) {
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
            // Preserve existing deploy confirmations made before execution modes were introduced.
            ...(p.mode === 'BUILD_ONLY' ? { mode: p.mode } : {}),
            ...(p.mode === 'DEPLOY' && p.env.config?.releasePolicy && {
              releasePolicy: p.env.config.releasePolicy,
            }),
            ...(p.allowPartialDeploy && { allowPartialDeploy: true }),
            repository: { url: p.repository.clone_url, credentialId: p.repository.credential_id },
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
          }),
        ),
      )
      .digest('hex');
  }
  async preview(id: string, input: RunPipelineDto) {
    const p = await this.prepare(id, input);
    const configurationHash = this.configurationHash(p);
    const aiApprovalHash = createHash('sha256')
      .update(
        JSON.stringify([
          id,
          p.version.id,
          p.environment.id,
          p.target.id,
          p.mode,
          input.commitSha.toLowerCase(),
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
      targetId: p.target.id,
      serverIds: p.servers.map((s) => s.id),
      mode: p.mode,
      requireApproval: p.mode === 'DEPLOY' && Boolean(p.env.config?.releasePolicy?.requireApproval),
      allowPartialDeploy: p.allowPartialDeploy,
      version: p.version.version,
      commitSha: input.commitSha.toLowerCase(),
      definition: p.definition,
      configurationHash,
      aiApprovalHash,
      hasSecretVariables: Object.keys(p.env.secretVariables).length > 0,
    };
  }
  assertAutomaticBuild(preview: { definition: PipelineDefinition; hasSecretVariables: boolean }) {
    if (preview.definition.buildLocation !== 'MANAGER')
      throw new BadRequestException('Webhook 仅支持管理端隔离构建，请修改有效构建位置');
    if (preview.hasSecretVariables)
      throw new BadRequestException('Webhook 自动构建不能使用环境中的敏感变量');
    if (!webhookBuildSocket())
      throw new BadRequestException('请先配置 Webhook 专用 rootless Docker 构建环境');
  }

  private snapshot(
    p: Awaited<ReturnType<PipelinesService['prepare']>>,
    commitSha: string,
  ): PipelineSnapshot {
    return {
      runId: randomUUID(),
      pipelineId: p.pipeline.id,
      pipelineVersionId: p.version.id,
      projectId: p.pipeline.projectId,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      targetId: p.target.id,
      commitSha,
      repository: { url: p.repository.clone_url, credentialId: p.repository.credential_id },
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

    const operator = await tx
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .where('status', '=', 'ACTIVE')
      .where('role', 'in', ['ADMIN', 'OPERATOR'])
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

  private async prepareArtifactDeploy(id: string, input: ArtifactDeployPreviewDto) {
    const artifactIds = [...new Set(input.artifactIds)].sort();
    if (!artifactIds.length || artifactIds.length !== input.artifactIds.length)
      throw new BadRequestException('请选择互不重复的部署产物');
    const db = this.database.db;
    const rows = await db
      .selectFrom('artifacts')
      .innerJoin('pipeline_runs', 'pipeline_runs.id', 'artifacts.pipeline_run_id')
      .innerJoin('pipeline_versions', 'pipeline_versions.id', 'pipeline_runs.pipeline_version_id')
      .innerJoin('tasks', 'tasks.id', 'pipeline_runs.task_id')
      .select([
        'artifacts.id',
        'artifacts.artifact_type',
        'artifacts.checksum',
        'artifacts.compose_checksum',
        'artifacts.image_digest',
        'artifacts.storage_key',
        'artifacts.server_id',
        'artifacts.storage_type',
        'artifacts.registry_id',
        'pipeline_runs.commit_sha',
        'pipeline_runs.id as run_id',
        'pipeline_runs.task_id',
        'pipeline_versions.version',
        'tasks.status',
      ])
      .where('artifacts.id', 'in', artifactIds)
      .where('pipeline_runs.pipeline_id', '=', id)
      .where('pipeline_runs.environment_id', '=', input.environmentId)
      .orderBy('artifacts.id')
      .execute();
    const source = rows[0];
    if (
      !source ||
      rows.length !== artifactIds.length ||
      rows.some((row) => row.run_id !== source.run_id)
    )
      throw new BadRequestException('产物必须来自同一 Pipeline 和环境的一次构建');
    if (source.status !== 'SUCCESS' && source.status !== 'PARTIAL_FAILED')
      throw new ConflictException('来源任务没有可发布的成功构建');
    const candidates = await this.artifacts.deployableIn(db, source.run_id);
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
        version: input.version ?? source.version,
        commitSha: source.commit_sha,
        mode: 'DEPLOY',
      },
      true,
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
        ]),
      )
      .digest('hex');
    return { p, references, source, configurationHash, artifactIds, targets };
  }

  async previewArtifactDeploy(id: string, input: ArtifactDeployPreviewDto) {
    const { p, source, configurationHash, artifactIds, targets } = await this.prepareArtifactDeploy(
      id,
      input,
    );
    return {
      pipelineId: id,
      projectId: p.pipeline.projectId,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      environmentType: p.environment.environment_type,
      targetId: p.target.id,
      serverIds: targets,
      mode: 'DEPLOY_ARTIFACT' as const,
      requireApproval: Boolean(p.env.config?.releasePolicy?.requireApproval),
      version: p.version.version,
      commitSha: source.commit_sha,
      definition: p.definition,
      configurationHash,
      artifactIds,
    };
  }

  async deployArtifact(id: string, input: ArtifactDeployDto, userId: string) {
    if (input.confirmed !== true) throw new BadRequestException('必须确认产物和部署目标');
    const { p, references, source, configurationHash, artifactIds, targets } =
      await this.prepareArtifactDeploy(id, input);
    if (
      input.expectedConfigurationHash !== configurationHash ||
      (input.expectedServerIds &&
        JSON.stringify([...input.expectedServerIds].sort()) !== JSON.stringify([...targets].sort()))
    )
      throw new ConflictException('产物、执行目标或配置已变化，请重新确认');
    const snapshot: PipelineSnapshot = {
      ...this.snapshot(p, source.commit_sha),
      mode: 'DEPLOY_ARTIFACT',
      deploymentArtifacts: references,
      sourceBuildTaskId: source.task_id,
    };
    const task = await this.tasks.create(
      this.taskInput(
        snapshot,
        `${p.pipeline.name} · v${p.version.version} · ${source.commit_sha.slice(0, 8)} · 部署产物`,
        this.executionTargets(p),
      ),
      userId,
    );
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
      triggerType?: 'WEBHOOK';
      idempotencyKey?: string;
      gitRef?: string;
      beforeInsert?: (tx: Transaction<Database>) => Promise<void>;
    } = {},
  ) {
    if (input.confirmed !== true) throw new BadRequestException('必须确认执行Pipeline');
    if (options.triggerType === 'WEBHOOK' && input.mode !== 'BUILD_ONLY')
      throw new BadRequestException('Webhook只允许触发仅构建');
    const p = await this.prepare(id, input);
    if (options.triggerType === 'WEBHOOK')
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
    const commit = input.commitSha.toLowerCase();
    const snapshot: PipelineSnapshot = {
      ...this.snapshot(p, commit),
      mode: 'BUILD_ONLY',
      ...(p.mode === 'DEPLOY' && {
        deployAfterBuild: true,
        allowPartialDeploy: p.allowPartialDeploy,
      }),
      triggerType: options.triggerType ?? 'MANUAL',
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
      options.beforeInsert,
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
