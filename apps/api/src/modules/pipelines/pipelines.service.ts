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
import { DatabaseService } from '../../core/database/database.service';
import { ServersService } from '../servers/servers.service';
import { TasksService } from '../tasks/tasks.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { AuditService } from '../audit/audit.service';
import { ServiceConfigsService } from '../service-configs/service-configs.service';
import { RegistriesService } from '../registries/registries.service';
import { PipelineExecutor } from './pipeline-executor.service';
import {
  CreatePipelineDto,
  PipelineDefinitionDto,
  RunPipelineDto,
  UpdatePipelineDto,
} from './pipeline.dto';
import type { PipelineDefinition, PipelineSnapshot } from './pipeline.types';
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
  ) {}
  onModuleInit() {
    this.handlers.register({
      type: 'PIPELINE',
      execute: (task, context) => this.executor.execute(task, context),
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
  private async resources(projectId: string, serviceId: string, definition: PipelineDefinition) {
    validateDefinition(definition);
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
    if (definition.registryId) await this.registries.get(definition.registryId);
    return repository;
  }
  async create(input: CreatePipelineDto, userId: string) {
    await this.resources(input.projectId, input.serviceId, input.definition);
    const id = randomUUID(),
      now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
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
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(input.commitSha))
      throw new BadRequestException('部署必须固定完整Git Commit SHA');
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
    if (!target) throw new BadRequestException('部署目标不存在');
    const members = await this.database.db
      .selectFrom('deployment_target_servers')
      .select('server_id')
      .where('target_id', '=', target.id)
      .orderBy('sort_order')
      .execute();
    const servers = await this.servers.snapshot(members.map((m) => m.server_id));
    if (servers.some((s) => !s.credentialId || !s.hostKeyFingerprint))
      throw new BadRequestException('所有部署目标必须配置凭据和已确认指纹');
    const env = await this.configs.readSnapshot(
      pipeline.serviceId,
      input.environmentId,
      input.targetId,
    );
    const definition = plainToInstance(
      PipelineDefinitionDto,
      JSON.parse(version.definition_json),
    ) as PipelineDefinition;
    const config = env.config as Record<string, unknown> | null;
    if (config)
      for (const name of [
        'buildLocation',
        'artifactType',
        'buildCommand',
        'outputPath',
        'deployPath',
        'composeFilePath',
        'startCommand',
        'healthCheckCommand',
        'dockerfilePath',
      ])
        if (typeof config[name] === 'string' && config[name] !== '')
          (definition as unknown as Record<string, unknown>)[name] = config[name];
    const errors = await validate(plainToInstance(PipelineDefinitionDto, definition));
    if (errors.length) throw new BadRequestException('有效Pipeline配置不合法');
    const repository = await this.resources(pipeline.projectId, pipeline.serviceId, definition);
    return { pipeline, version, environment, target, servers, definition, repository, env };
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
            repository: { url: p.repository.clone_url, credentialId: p.repository.credential_id },
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
      version: p.version.version,
      commitSha: input.commitSha.toLowerCase(),
      definition: p.definition,
      configurationHash: this.configurationHash(p),
    };
  }
  async run(
    id: string,
    input: RunPipelineDto & { expectedServerIds?: string[]; expectedConfigurationHash?: string },
    userId: string,
  ) {
    if (input.confirmed !== true) throw new BadRequestException('必须确认执行部署');
    const p = await this.prepare(id, input);
    if (
      input.expectedServerIds &&
      JSON.stringify([...input.expectedServerIds].sort()) !==
        JSON.stringify(p.servers.map((s) => s.id).sort())
    )
      throw new ConflictException('部署目标已变化，请重新确认');
    if (
      input.expectedConfigurationHash &&
      input.expectedConfigurationHash !== this.configurationHash(p)
    )
      throw new ConflictException('部署配置已变化，请重新确认');
    const runId = randomUUID();
    const commit = input.commitSha.toLowerCase();
    const snapshot: PipelineSnapshot = {
      runId,
      pipelineId: id,
      pipelineVersionId: p.version.id,
      projectId: p.pipeline.projectId,
      serviceId: p.pipeline.serviceId,
      environmentId: p.environment.id,
      targetId: p.target.id,
      commitSha: commit,
      repository: { url: p.repository.clone_url, credentialId: p.repository.credential_id },
      definition: p.definition,
      variables: p.env.variables,
      secretVariables: p.env.secretVariables,
    };
    const task = await this.tasks.create(
      {
        type: 'PIPELINE',
        name: `${p.pipeline.name} · v${p.version.version} · ${commit.slice(0, 8)}`,
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
          gitRef: commit,
          commitSha: commit,
          buildLocation: p.definition.buildLocation,
          artifactType: p.definition.artifactType,
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
    );
    await this.audit.record(userId, 'pipeline.run', 'task', task.id, {
      pipelineId: id,
      version: p.version.version,
      commit,
      targetCount: p.servers.length,
    });
    return task;
  }
}
