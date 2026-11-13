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
import { ServiceConfigsService } from '../service-configs/service-configs.service';
import { RegistriesService } from '../registries/registries.service';
import { PipelineExecutor } from './pipeline-executor.service';
import { webhookBuildSocket } from '../builds/builds.service';
import { PipelineAnalysisService } from '../ai/pipeline-analysis.service';
import {
  ConfirmedPipelineRunDto,
  CreatePipelineDto,
  PipelineDefinitionDto,
  RunPipelineDto,
  UpdatePipelineDto,
} from './pipeline.dto';
import type { PipelineDefinition, PipelineExecutionMode, PipelineSnapshot } from './pipeline.types';
import { validateDefinition, validateGitUrl } from './pipeline.validation';

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
  ) {}
  onModuleInit() {
    this.handlers.register({
      type: 'PIPELINE',
      execute: (task, context) => this.executor.execute(task, context),
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
  ) {
    validateDefinition(definition, mode === 'DEPLOY');
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
    await this.resources(input.projectId, input.serviceId, input.definition);
    const id = randomUUID(),
      now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      await this.lockRepository(tx, input.projectId, input.definition.repositoryId);
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
          definition_json: JSON.stringify(input.definition),
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
    await this.resources(current.projectId, current.serviceId, input.definition);
    await this.database.db.transaction().execute(async (tx) => {
      await this.lockRepository(tx, current.projectId, input.definition.repositoryId);
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
          definition_json: JSON.stringify(input.definition),
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
  private async prepare(id: string, input: RunPipelineDto) {
    const mode = input.mode ?? 'DEPLOY';
    if (mode !== 'BUILD_ONLY' && mode !== 'DEPLOY')
      throw new BadRequestException('无效Pipeline执行模式');
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
    return {
      pipelineId: id,
      projectId: p.pipeline.projectId,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      environmentType: p.environment.environment_type,
      targetId: p.target.id,
      serverIds: p.servers.map((s) => s.id),
      mode: p.mode,
      version: p.version.version,
      commitSha: input.commitSha.toLowerCase(),
      definition: p.definition,
      configurationHash: this.configurationHash(p),
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
    const runId = randomUUID();
    const commit = input.commitSha.toLowerCase();
    const snapshot: PipelineSnapshot = {
      mode: p.mode,
      triggerType: options.triggerType ?? 'MANUAL',
      runId,
      pipelineId: id,
      pipelineVersionId: p.version.id,
      projectId: p.pipeline.projectId,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      targetId: p.target.id,
      commitSha: commit,
      repository: { url: p.repository.clone_url, credentialId: p.repository.credential_id },
      ...(p.registry && {
        registry: { registryUrl: p.registry.registryUrl, credentialId: p.registry.credentialId },
      }),
      definition: p.definition,
      variables: p.env.variables,
      secretVariables: p.env.secretVariables,
    };
    const task = await this.tasks.create(
      {
        type: 'PIPELINE',
        idempotencyKey: options.idempotencyKey,
        name: `${p.pipeline.name} · v${p.version.version} · ${commit.slice(0, 8)}${p.mode === 'BUILD_ONLY' ? ' · 仅构建' : ''}`,
        scope: {
          projectId: snapshot.projectId,
          serviceId: snapshot.serviceId,
          environmentId: snapshot.environmentId,
          targetId: snapshot.targetId,
        },
        pipelineRun: {
          id: runId,
          pipelineId: id,
          pipelineVersionId: p.version.id,
          gitRef: options.gitRef ?? commit,
          commitSha: commit,
          buildLocation: p.definition.buildLocation,
          artifactType: p.definition.artifactType,
          triggerType: options.triggerType,
        },
        payload: {
          targets: p.servers,
          steps: [],
          strategy: p.target.strategy as 'PARALLEL' | 'SEQUENTIAL',
          maxParallel: p.target.max_parallel,
          failurePolicy: p.target.failure_policy as 'STOP' | 'CONTINUE',
          timeout: 1200,
          pipeline: snapshot,
        },
      },
      userId,
      options.beforeInsert,
    );
    if (task.pipelineRunId === runId) {
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
