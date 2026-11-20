import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { lstat } from 'node:fs/promises';
import { posix } from 'node:path';
import type { Database } from '../../core/database/schema';
import { DatabaseService } from '../../core/database/database.service';
import {
  executionVariableName,
  resolveExecutionVariables,
  type ExecutionVariables,
} from '../../infrastructure/execution-variables';
import { SshService } from '../../infrastructure/ssh/ssh.service';
import { TargetResolver } from '../command-center/target-resolver.service';
import { BuildsService, type BuildSession } from '../builds/builds.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { CredentialsService } from '../credentials/credentials.service';
import type { DeploymentSelection } from '../deployment-targets/deployment-selection';
import { PipelineDefinitionDto } from '../pipelines/pipeline.dto';
import { relativePath, shellQuote } from '../pipelines/pipeline.validation';
import { deliveryExecutionProfile } from '../pipelines/delivery-execution-profile';
import type { PipelineSnapshot, NamedArtifactDefinition } from '../pipelines/pipeline.types';
import {
  RepositoryMetadataService,
  type GraphCheckoutSnapshot,
} from '../projects/repository-metadata.service';
import { ServiceConfigsService } from '../service-configs/service-configs.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import type { CreateTaskInput, TaskExecutionContext, TaskRecord } from '../tasks/tasks.types';
import type { GraphNode } from './execution-graph-definition';
import {
  createGraphWorkspace,
  graphTriggerVariables,
  graphWorkspaceEntry,
  openGraphWorkspace,
  ownedGraphWorkspace,
  unversionedArtifactCommit,
  unversionedArtifactRepository,
  workspaceReference,
  type GraphEnvironmentRef,
  type GraphWorkspaceRef,
} from './graph-workspace';
const defaults = {
  strategy: 'SEQUENTIAL',
  maxParallel: 1,
  failurePolicy: 'STOP',
  timeout: 180,
} as const;
type ScriptNode = 'SHELL' | 'CHECK';
type NativeModule = 'CHECKOUT' | ScriptNode | 'LOAD_ENV' | 'REGISTER_ARTIFACT';

export interface GraphNodeScope {
  environmentId?: string;
  serviceId?: string;
  values?: Record<string, unknown>;
  runId?: string;
  nodeRunId?: string;
  trigger?: Record<string, unknown>;
}

export type GraphNodePlan =
  | { type: 'CHECKOUT'; source: GraphCheckoutSnapshot }
  | {
      type: ScriptNode;
      serverId?: string;
      serverName?: string;
      targetHash?: string;
      serviceId?: string;
      environmentId?: string;
      environment?: ExecutionVariables;
    }
  | { type: 'LOAD_ENV' }
  | { type: 'REGISTER_ARTIFACT'; declarations: NamedArtifactDefinition[] };

export interface GraphModulePayload {
  type: NativeModule;
  projectId: string;
  serviceId?: string;
  environmentId?: string;
  workspace?: GraphWorkspaceRef;
  source?: GraphCheckoutSnapshot;
  variables?: GraphEnvironmentRef;
  targetDirectory?: string;
  envFile?: string;
  shell?: {
    command: string;
    timeout: number;
    continueOnFailure: boolean;
    parameters: ExecutionVariables;
    outputs: NonNullable<GraphNode['outputs']>;
  };
  trigger?: Record<string, unknown>;
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const resourceId = (value: unknown) =>
  text(value) ?? (value && typeof value === 'object' && 'id' in value ? text(value.id) : undefined);
const workspaceOf = (value: unknown) =>
  value &&
  typeof value === 'object' &&
  'runId' in value &&
  'nodeRunId' in value &&
  typeof value.runId === 'string' &&
  typeof value.nodeRunId === 'string'
    ? (value as GraphWorkspaceRef)
    : undefined;

@Injectable()
export class GraphNodeTasks implements OnModuleInit {
  constructor(
    private readonly repositories: RepositoryMetadataService,
    private readonly targets: TargetResolver,
    private readonly registry: TaskHandlerRegistry,
    private readonly configs: ServiceConfigsService,
    private readonly database: DatabaseService,
    private readonly builds: BuildsService,
    private readonly artifacts: ArtifactsService,
    private readonly ssh: SshService,
    private readonly credentials: CredentialsService,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: 'GRAPH_MODULE',
      execute: async (task, context) => {
        try {
          return { graphOutputs: await this.execute(task, context) };
        } catch (error) {
          context.log(error instanceof Error ? error.message + '\n' : '功能节点失败\n');
          throw error;
        }
      },
    });
  }

  async prepare(projectId: string, node: GraphNode, scope: GraphNodeScope): Promise<GraphNodePlan> {
    const values = scope.values ?? {};
    if (node.type === 'CHECKOUT') {
      const config = node.checkout;
      const repositoryId = resourceId(values.repository) ?? config?.repositoryId;
      if (!repositoryId) throw new BadRequestException('Git 拉取需要项目仓库');
      const value = values.version;
      const ref =
        value && typeof value === 'object' && 'kind' in value && 'value' in value
          ? value
          : undefined;
      const kind = ref?.kind ?? config?.mode ?? 'BRANCH';
      if (kind !== 'BRANCH' && kind !== 'TAG' && kind !== 'COMMIT')
        throw new BadRequestException('Git 版本类型无效');
      const version = text(ref?.value);
      return {
        type: 'CHECKOUT',
        source: await this.repositories.planGraphCheckout(projectId, {
          repositoryId,
          mode: kind,
          branch: kind === 'BRANCH' ? (version ?? config?.branch) : undefined,
          tag: kind === 'TAG' ? (version ?? config?.tag) : undefined,
          commitSha: kind === 'COMMIT' ? (version ?? config?.commitSha) : undefined,
          fullClone: config?.fullClone,
        }),
      };
    }
    if (node.type === 'LOAD_ENV') return { type: 'LOAD_ENV' };
    if (node.type === 'REGISTER_ARTIFACT')
      return { type: 'REGISTER_ARTIFACT', declarations: node.registerArtifacts?.artifacts ?? [] };
    if (node.type !== 'SHELL' && node.type !== 'CHECK')
      throw new BadRequestException('不支持的功能节点');

    const serviceId = resourceId(values.service) ?? scope.serviceId;
    const environmentId = resourceId(values.environment) ?? scope.environmentId;
    const environment = await this.configs.resolveVariables(projectId, environmentId, serviceId);
    const targetValue = values.targets;
    const serverId = node.shell?.serverId;
    const selection = targetValue
      ? typeof targetValue === 'string'
        ? { serverIds: [targetValue] }
        : (targetValue as DeploymentSelection)
      : serverId
        ? { serverIds: [serverId] }
        : undefined;
    const base = { type: node.type, serviceId, environmentId, environment };
    if (node.shell?.location === 'MANAGER' || !selection) return base;
    const target = await this.targets.preview(selection);
    if (target.targets.length !== 1)
      throw new ConflictException('Shell 或检查节点必须选择一台可用的服务器');
    return {
      ...base,
      serverId: target.targets[0]!.id,
      serverName: target.targets[0]!.name,
      targetHash: target.targetHash,
    };
  }

  private async repositoryWorkspace(projectId: string, reference: GraphWorkspaceRef) {
    const available = await ownedGraphWorkspace(this.database.db, projectId, reference);
    await openGraphWorkspace(available);
    return available;
  }

  async task(
    projectId: string,
    node: GraphNode,
    plan: GraphNodePlan,
    idempotencyKey: string,
    scope: GraphNodeScope,
  ): Promise<CreateTaskInput> {
    const values = scope.values ?? {};
    const environmentRef = values.variables;
    const environmentId =
      resourceId(values.environment) ??
      (environmentRef && typeof environmentRef === 'object' && 'environmentId' in environmentRef
        ? text(environmentRef.environmentId)
        : undefined) ??
      scope.environmentId;
    const serviceId = resourceId(values.service) ?? scope.serviceId;
    const identity = { projectId, environmentId, serviceId };
    const self =
      scope.runId && scope.nodeRunId
        ? workspaceReference(
            scope.runId,
            scope.nodeRunId,
            plan.type === 'CHECKOUT' ? plan.source : undefined,
          )
        : undefined;
    const reference = workspaceOf(values.workspace);
    const workspace = reference ? await this.repositoryWorkspace(projectId, reference) : undefined;
    const settings = { type: plan.type, ...identity, trigger: scope.trigger };
    const base: CreateTaskInput = {
      name: node.name,
      type: 'GRAPH_MODULE',
      scope: identity,
      idempotencyKey,
      payload: { ...defaults, targets: [], steps: [] },
    };

    if (plan.type === 'CHECKOUT') {
      if (!self) throw new BadRequestException('缺少源码工作区标识');
      return {
        ...base,
        payload: {
          ...base.payload,
          graphModule: { ...settings, workspace: self, source: plan.source },
        },
      };
    }
    if (plan.type === 'LOAD_ENV') {
      let envFile = node.loadEnvironment?.envFile;
      const directory = node.loadEnvironment?.directory;
      if (envFile && directory)
        envFile = posix.join(relativePath(directory), relativePath(envFile));
      if (environmentId) await this.configs.resolveVariables(projectId, environmentId, serviceId);
      if (!envFile && environmentId) {
        const environment = await this.database.db
          .selectFrom('environments')
          .select(['slug', 'repository_env_file'])
          .where('id', '=', environmentId)
          .where('project_id', '=', projectId)
          .executeTakeFirst();
        if (environment) {
          const candidate = directory
            ? posix.join(relativePath(directory), '.env.' + environment.slug)
            : '.env.' + environment.slug;
          envFile =
            environment.repository_env_file ??
            (workspace && (await graphWorkspaceEntry(workspace, candidate).catch(() => undefined))
              ? candidate
              : undefined);
        }
      }
      if (envFile && !workspace) throw new BadRequestException('加载仓库环境文件需要绑定工作区');
      return {
        ...base,
        payload: {
          ...base.payload,
          graphModule: { ...settings, workspace, envFile: envFile && relativePath(envFile) },
        },
      };
    }
    if (plan.type === 'REGISTER_ARTIFACT') {
      if (!self || !environmentId || !serviceId)
        throw new BadRequestException('登记产物需要服务和环境');
      await this.configs.resolveVariables(projectId, environmentId, serviceId);
      const boundPath = text(values.path);
      const boundImage = text(values.image);
      const files = plan.declarations.filter(({ type }) => type !== 'DOCKER_IMAGE').length;
      const images = plan.declarations.length - files;
      const declarations = plan.declarations.map((declaration) => ({
        ...declaration,
        ...(declaration.type !== 'DOCKER_IMAGE' &&
          (files === 1 || !declaration.path) &&
          boundPath && { path: relativePath(boundPath) }),
        ...(declaration.type === 'DOCKER_IMAGE' &&
          (images === 1 || !declaration.imageReference) &&
          boundImage && { imageReference: boundImage }),
      }));
      if (!declarations.length) throw new BadRequestException('请声明需要登记的产物');
      for (const declaration of declarations) {
        if (
          declaration.type === 'DOCKER_IMAGE'
            ? !declaration.imageReference
            : !declaration.path || !workspace
        )
          throw new BadRequestException('产物需要明确的工作区文件、目录或镜像来源');
      }
      const definition = Object.assign(new PipelineDefinitionDto(), {
        repositoryId: workspace?.repositoryId ?? unversionedArtifactRepository,
        buildLocation: 'MANAGER',
        artifactType: declarations[0]!.type === 'DOCKER_IMAGE' ? 'DOCKER_IMAGE' : 'FILE',
        artifacts: declarations,
      });
      const profile = deliveryExecutionProfile(
        projectId,
        serviceId,
        scope.nodeRunId!,
        1,
        node.name,
        definition,
        [],
      );
      const pipeline: PipelineSnapshot = {
        graph: { runId: scope.runId!, nodeRunId: scope.nodeRunId!, workspace },
        runId: randomUUID(),
        pipelineId: profile.id,
        pipelineVersionId: profile.versionId,
        projectId,
        serviceId,
        environmentId,
        commitSha: workspace?.commitSha ?? unversionedArtifactCommit,
        mode: 'BUILD_ONLY',
        definition,
        repository: { url: '', credentialId: null },
        variables: {},
        secretVariables: {},
      };
      return {
        ...base,
        registrationProfile: profile,
        pipelineRun: {
          id: pipeline.runId,
          pipelineId: pipeline.pipelineId,
          pipelineVersionId: pipeline.pipelineVersionId,
          gitRef: pipeline.commitSha,
          commitSha: pipeline.commitSha,
          buildLocation: definition.buildLocation,
          artifactType: definition.artifactType,
        },
        payload: {
          ...base.payload,
          pipeline,
          graphModule: { ...settings, workspace: workspace ?? self },
        },
      };
    }

    const config = node.shell;
    if (!config?.command?.trim()) throw new BadRequestException('请输入脚本命令');
    if (workspace && plan.serverId)
      throw new BadRequestException('管理端工作区不能直接绑定远程 Shell');
    if (config.location === 'TARGET' && !plan.serverId)
      throw new BadRequestException('目标端 Shell 缺少确认的服务器');
    const targets = plan.serverId
      ? await this.targets.resolveForExecution({
          ...defaults,
          serverIds: [plan.serverId],
          expectedTargetHash: plan.targetHash,
          confirmed: true,
        })
      : [];
    const variableRef = environmentRef;
    const file =
      variableRef &&
      typeof variableRef === 'object' &&
      'workspace' in variableRef &&
      'envFile' in variableRef
        ? { workspace: workspaceOf(variableRef.workspace), envFile: text(variableRef.envFile) }
        : undefined;
    const variables =
      file?.workspace && file.envFile
        ? {
            workspace: await this.repositoryWorkspace(projectId, file.workspace),
            envFile: relativePath(file.envFile),
            environmentId,
          }
        : undefined;
    const parameters: ExecutionVariables = {
      variables: Object.create(null),
      secretVariables: Object.create(null),
    };
    for (const field of config.params ?? []) {
      if (!executionVariableName.test(field.id) || /^VEYOPS_/i.test(field.id))
        throw new BadRequestException('脚本参数必须使用可导出的环境变量名');
      const value = values[field.id];
      if (value === undefined) continue;
      if (field.type === 'CREDENTIAL') {
        const id = resourceId(value);
        if (!id) throw new BadRequestException('脚本参数必须引用有效的凭据');
        parameters.secretVariables[field.id] = id;
      } else {
        parameters.variables[field.id] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
    const source = values.source;
    const commitSha =
      source && typeof source === 'object' && 'commitSha' in source
        ? text(source.commitSha)
        : workspace?.commitSha;
    const platform = {
      ...graphTriggerVariables(scope.trigger),
      ...(commitSha && { VEYOPS_GIT_COMMIT_SHA: commitSha }),
    };
    return {
      ...base,
      payload: {
        ...base.payload,
        targets,
        environment:
          plan.environmentId !== environmentId || plan.serviceId !== serviceId
            ? await this.configs.resolveVariables(projectId, environmentId, serviceId)
            : plan.environment,
        graphModule: {
          ...settings,
          workspace: workspace ?? (!targets.length ? self : undefined),
          variables,
          targetDirectory: config.directory,
          shell: {
            command: config.command,
            timeout: config.timeout ?? defaults.timeout,
            continueOnFailure: config.continueOnFailure === true,
            parameters: { ...parameters, variables: { ...parameters.variables, ...platform } },
            outputs: node.outputs ?? node.shell?.outputs ?? [],
          },
        },
      },
    };
  }

  private async execute(
    task: TaskRecord,
    context: TaskExecutionContext,
  ): Promise<Record<string, unknown>> {
    const module = task.payload.graphModule!;
    if (module.type === 'CHECKOUT') {
      const { repositoryId, commitSha, branch, tag, fullClone } = module.source!;
      await createGraphWorkspace(module.workspace!, (destination) =>
        this.repositories.checkoutGraphSource(
          module.projectId,
          module.source!,
          context.signal,
          destination,
        ),
      );
      context.log(
        '\u6e90\u7801\u68c0\u51fa\u5b8c\u6210 · ' +
          (tag ?? branch ?? '固定提交') +
          ' · ' +
          commitSha +
          '\n',
      );
      return {
        source: { repositoryId, commitSha, branch, tag, fullClone },
        workspace: module.workspace,
      };
    }
    if (module.type === 'LOAD_ENV') {
      if (module.workspace && module.envFile) {
        const file = await graphWorkspaceEntry(module.workspace, module.envFile);
        const info = await lstat(file);
        if (!info.isFile() || info.size > 64 * 1024) throw new Error('环境文件不可读或超过 64 KiB');
      }
      return {
        variables: {
          workspace: module.workspace,
          envFile: module.envFile,
          environmentId: module.environmentId,
        } satisfies GraphEnvironmentRef,
      };
    }

    if (module.type === 'REGISTER_ARTIFACT') {
      const workspace = module.workspace!;
      if (!task.payload.pipeline!.graph?.workspace) await createGraphWorkspace(workspace);
      const session = this.session(task, context, task.payload.pipeline!);
      const result = await this.builds.registerManagerArtifacts(session, workspace);
      try {
        for (const { declaration, output } of result.artifacts ?? []) {
          await this.artifacts.create(session.snapshot, {
            name: declaration.name,
            kind: declaration.type,
            storageKey: output.localArchive ?? output.imageReference!,
            imageReference: output.imageReference,
            imageId: output.imageId,
            archiveKey: output.archiveKey,
            archiveImageId: output.archiveImageId,
            archiveImagePlatform: output.archiveImagePlatform,
            checksum: output.checksum,
            sizeBytes: output.sizeBytes,
            composeYaml: output.composeYaml,
            storageType: output.imageId ? 'LOCAL_IMAGE' : 'LOCAL_FILE',
          });
          context.log('已登记产物 ' + declaration.name + '\n');
        }
        return {};
      } finally {
        await result.cleanup();
      }
    }

    const shell = module.shell!;
    const parameters = await resolveExecutionVariables(this.credentials, shell.parameters);
    const snapshot = {
      ...this.shellSnapshot(task, module),
      graph: module.variables
        ? { runId: '', nodeRunId: '', variables: module.variables }
        : undefined,
    };
    const environment = await this.builds.resolveVariables(snapshot);
    for (const key of ['VEYOPS_PROJECT_ID', 'VEYOPS_SERVICE_ID', 'VEYOPS_GIT_COMMIT_SHA'])
      if (!task.payload.environment?.variables[key]) delete environment.values[key];
    const values = { ...environment.values, ...parameters.values };
    const secrets = [...environment.secrets, ...parameters.secrets].flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
    ]);
    const target = task.payload.targets.at(0);
    let exitCode: number;
    let stdout = '';
    if (target) {
      const directory = module.targetDirectory
        ? 'cd -P -- ' + shellQuote(relativePath(module.targetDirectory)) + '\n'
        : '';
      const result = await this.ssh.execute(target, directory + shell.command, {
        timeout: shell.timeout,
        signal: context.signal,
        variables: { variables: values, secretVariables: {} },
        secrets,
        onData: (chunk, stream) => {
          if (stream === 'stdout') stdout += chunk;
          context.log(chunk, target.id);
        },
      });
      exitCode = result.exitCode;
    } else if (module.workspace) {
      const workspace = await openGraphWorkspace(module.workspace).catch(() =>
        createGraphWorkspace(module.workspace!),
      );
      const result = await this.builds.managerGraphShell(
        this.session(task, context, snapshot, values, secrets),
        workspace,
        shell.command,
        module.targetDirectory ?? '.',
        shell.timeout,
      );
      const match = /(?:^|\n)VEYOPS_EXIT_CODE=(\d+)\s*$/.exec(result.stdout);
      if (!match) throw new Error('脚本退出状态未返回');
      stdout = result.stdout.slice(0, match.index);
      exitCode = Number(match[1]);
    } else {
      throw new Error('缺少脚本工作区');
    }
    if (exitCode !== 0 && !shell.continueOnFailure) throw new Error('脚本退出码 ' + exitCode);
    const report = { exitCode, passed: exitCode === 0 };
    return {
      exitCode,
      report,
      ...(!target && module.workspace && { workspace: module.workspace }),
      ...this.scriptOutputs(shell.outputs, stdout),
    };
  }

  private scriptOutputs(fields: NonNullable<GraphNode['outputs']>, stdout: string) {
    if (!fields.length) return {};
    const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith('VEYOPS_OUTPUT='));
    const declaration = lines.at(-1)?.slice('VEYOPS_OUTPUT='.length);
    if (
      lines.length > 1 ||
      (declaration?.length ?? 0) > 65_536 ||
      declaration?.includes('[REDACTED]')
    )
      throw new Error('脚本输出必须为唯一、不含敏感值的 VEYOPS_OUTPUT JSON 对象');
    let values: Record<string, unknown>;
    try {
      const parsed = declaration ? (JSON.parse(declaration) as unknown) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
      values = parsed as Record<string, unknown>;
    } catch {
      throw new Error('脚本输出不是有效的 JSON 对象');
    }
    return Object.fromEntries(
      fields.flatMap((field) => {
        const value = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
        if (value === undefined && field.required === false) return [];
        const type =
          field.type === 'TEXT'
            ? 'string'
            : field.type === 'NUMBER'
              ? 'number'
              : field.type === 'BOOLEAN'
                ? 'boolean'
                : undefined;
        const matches = (item: unknown) =>
          type !== undefined &&
          typeof item === type &&
          (typeof item !== 'number' || Number.isFinite(item));
        if (field.multiple ? !Array.isArray(value) || !value.every(matches) : !matches(value))
          throw new Error('脚本未提供声明的 ' + field.name + ' 输出');
        return [[field.id, value]];
      }),
    );
  }

  private shellSnapshot(task: TaskRecord, module: GraphModulePayload): PipelineSnapshot {
    return {
      runId: '',
      pipelineId: '',
      pipelineVersionId: '',
      projectId: module.projectId,
      serviceId: module.serviceId ?? '',
      environmentId: module.environmentId ?? '',
      commitSha: module.workspace?.commitSha ?? unversionedArtifactCommit,
      repository: { url: '', credentialId: null },
      definition: Object.assign(new PipelineDefinitionDto(), { buildLocation: 'MANAGER' }),
      variables: task.payload.environment?.variables ?? {},
      secretVariables: task.payload.environment?.secretVariables ?? {},
    };
  }

  private session(
    task: TaskRecord,
    context: TaskExecutionContext,
    snapshot: PipelineSnapshot,
    variables: Record<string, string> = {},
    secrets: string[] = [],
  ): BuildSession {
    return { snapshot, taskId: task.id, context, variables, secrets };
  }

  async output(
    taskId: string,
    node: GraphNode,
    db: Kysely<Database> = this.database.db,
  ): Promise<Record<string, unknown>> {
    if (node.type === 'BUILD' || node.type === 'REGISTER_ARTIFACT') {
      const rows = await db
        .selectFrom('artifacts')
        .innerJoin('pipeline_runs', 'pipeline_runs.id', 'artifacts.pipeline_run_id')
        .select([
          'artifacts.id',
          'artifacts.artifact_name',
          'artifacts.artifact_type',
          'artifacts.artifact_kind',
          'artifacts.storage_type',
          'artifacts.server_id',
          'artifacts.source_commit',
          'artifacts.checksum',
          'artifacts.image_digest',
          'artifacts.graph_run_id',
          'artifacts.graph_node_run_id',
        ])
        .where('pipeline_runs.task_id', '=', taskId)
        .orderBy('artifacts.artifact_name')
        .orderBy('artifacts.id')
        .execute();
      const refs = rows.map((row) => ({
        id: row.id,
        name: row.artifact_name ?? 'artifact',
        type: row.artifact_kind ?? row.artifact_type,
        serverId: row.server_id,
        commitSha: row.source_commit === unversionedArtifactCommit ? null : row.source_commit,
        checksum: row.checksum,
        digest: row.storage_type === 'REGISTRY_IMAGE' ? row.image_digest : null,
        imageId: ['LOCAL_IMAGE', 'REMOTE_IMAGE'].includes(row.storage_type)
          ? row.image_digest
          : null,
        runId: row.graph_run_id,
        nodeRunId: row.graph_node_run_id,
      }));
      const named = new Map<string, typeof refs>();
      for (const ref of refs) named.set(ref.name, [...(named.get(ref.name) ?? []), ref]);
      return { artifacts: refs, ...Object.fromEntries(named) };
    }
    if (node.type === 'DEPLOY_ARTIFACT') {
      const rows = await db
        .selectFrom('deployment_records')
        .innerJoin('pipeline_runs', 'pipeline_runs.id', 'deployment_records.pipeline_run_id')
        .select([
          'deployment_records.id',
          'deployment_records.artifact_id',
          'deployment_records.server_id',
          'deployment_records.status',
          'deployment_records.health_status',
          'deployment_records.service_id',
          'deployment_records.environment_id',
        ])
        .where('pipeline_runs.task_id', '=', taskId)
        .orderBy('deployment_records.id')
        .execute();
      return {
        release: {
          serviceId: rows[0]?.service_id,
          environmentId: rows[0]?.environment_id,
          status:
            rows.length && rows.every((row) => row.status === 'SUCCESS') ? 'SUCCESS' : 'FAILED',
          deployments: rows.map((row) => ({
            id: row.id,
            artifactId: row.artifact_id,
            serverId: row.server_id,
            status: row.status,
            health: row.health_status,
          })),
        },
      };
    }
    const task = await db
      .selectFrom('tasks')
      .select('result_json')
      .where('id', '=', taskId)
      .executeTakeFirst();
    return task?.result_json
      ? ((JSON.parse(task.result_json) as { graphOutputs?: Record<string, unknown> })
          .graphOutputs ?? {})
      : {};
  }
}
