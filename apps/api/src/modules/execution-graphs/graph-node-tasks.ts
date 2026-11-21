import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from '../../core/database/schema';
import { DatabaseService } from '../../core/database/database.service';
import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
import {
  executionVariableName,
  resolveExecutionVariables,
  type ExecutionVariables,
} from '../../infrastructure/execution-variables';
import { SshExecutionError, SshService } from '../../infrastructure/ssh/ssh.service';
import { TargetResolver } from '../command-center/target-resolver.service';
import { BuildsService, type BuildSession } from '../builds/builds.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  directDeploymentSelection,
  type DeploymentSelection,
} from '../deployment-targets/deployment-selection';
import { PipelineDefinitionDto } from '../pipelines/pipeline.dto';
import { relativePath, shellQuote } from '../pipelines/pipeline.validation';
import {
  deliveryExecutionProfile,
  graphDeliveryEnvironment,
  graphUnscopedArtifactService,
} from '../pipelines/delivery-execution-profile';
import type { PipelineSnapshot, NamedArtifactDefinition } from '../pipelines/pipeline.types';
import { withPlanIssue } from './graph-execution-plan-issues';
import {
  RepositoryMetadataService,
  type GraphCheckoutSnapshot,
} from '../projects/repository-metadata.service';
import { ServiceConfigsService } from '../service-configs/service-configs.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import type { CreateTaskInput, TaskExecutionContext, TaskRecord } from '../tasks/tasks.types';
import type { GraphNode } from './execution-graph-definition';
import { validateGraphValue, type GraphField } from './graph-fields';
import { graphNodeRequiresIsolation, isGraphTriggerKind } from './graph-automatic-delivery';
import { GraphScriptOutput } from './graph-script-output';
import {
  environmentFilePath,
  graphVariableSources,
  mergeEnvironmentSet,
  type GraphEnvironmentPlan,
  type GraphEnvironmentSource,
  type GraphVariableSource,
} from './graph-environment';
import type { FrozenEnvironmentSet } from '../projects/environment-sets.service';
import {
  createGraphWorkspace,
  graphTriggerVariables,
  openGraphWorkspace,
  ownedGraphWorkspace,
  unversionedArtifactCommit,
  unversionedArtifactRepository,
  workspaceReference,
  workspaceArtifactSource,
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
  environmentSet?: FrozenEnvironmentSet | null;
  parameters?: Record<string, unknown>;
  serviceId?: string;
  values?: Record<string, unknown>;
  runId?: string;
  rootRunId?: string;
  nodeRunId?: string;
  trigger?: Record<string, unknown>;
  nodeEnvironment?: ExecutionVariables;
  nodeEnvironmentSources?: GraphVariableSource[];
  credentialNonces?: Readonly<Record<string, string>>;
}

export type GraphNodePlan =
  | { type: 'CHECKOUT'; source: GraphCheckoutSnapshot }
  | {
      type: ScriptNode;
      serverId?: string;
      serverName?: string;
      targetHash?: string;
      targetSelection?: DeploymentSelection;
      serviceId?: string;
      environmentId?: string;
      environment?: ExecutionVariables;
      configuredVariableSources?: GraphVariableSource[];
      variableSources?: GraphVariableSource[];
      environmentFile?: GraphEnvironmentPlan;
    }
  | {
      type: 'LOAD_ENV';
      environmentId?: string;
      environmentFile?: GraphEnvironmentPlan;
      variables?: GraphVariableSource[];
    }
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
  environmentFile?: GraphEnvironmentPlan;
  variableSources?: GraphVariableSource[];
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
  text(value) ??
  (value && typeof value === 'object'
    ? text('serviceId' in value ? value.serviceId : 'id' in value ? value.id : undefined)
    : undefined);
const workspaceOf = (value: unknown) =>
  value &&
  typeof value === 'object' &&
  'runId' in value &&
  'nodeRunId' in value &&
  typeof value.runId === 'string' &&
  typeof value.nodeRunId === 'string'
    ? (value as GraphWorkspaceRef)
    : undefined;
const sourceOf = (value: unknown) =>
  value && typeof value === 'object' ? (value as GraphEnvironmentSource) : undefined;
const variablesOf = (value: unknown) =>
  value && typeof value === 'object' ? (value as GraphEnvironmentRef) : undefined;

export function graphCheckoutOutputs(
  snapshot: GraphCheckoutSnapshot,
  workspace?: GraphWorkspaceRef,
  subject?: string,
): Record<string, unknown> {
  const { repositoryId, repositoryName, branch, tag, commitSha, fullClone } = snapshot;
  const ref =
    snapshot.ref ?? (branch ? 'refs/heads/' + branch : tag ? 'refs/tags/' + tag : commitSha);
  const metadata = { repositoryId, repositoryName, ref, branch, tag, commitSha, subject };
  const source = { ...metadata, fullClone };
  return { ...metadata, source, workspace: workspace ? { ...workspace, subject } : source };
}

function scriptInputSources(fields: readonly GraphField[], values: Record<string, unknown>) {
  return fields.flatMap(({ id, exportName, type }) =>
    !Object.hasOwn(values, id) || values[id] === undefined
      ? []
      : [
          {
            key: exportName ?? id,
            source: 'NODE' as const,
            isSecret: type === 'CREDENTIAL',
          },
        ],
  );
}

function scriptVariables(
  fields: readonly GraphField[],
  values: Record<string, unknown>,
  nodeEnvironment?: ExecutionVariables,
  credentialNonces?: Readonly<Record<string, string>>,
): ExecutionVariables {
  const variables: Record<string, string> = Object.create(null);
  const secretVariables: Record<string, string> = Object.create(null);
  const secretCredentialNonces: Record<string, string> = Object.assign(
    Object.create(null),
    nodeEnvironment?.secretCredentialNonces,
  );
  for (const field of fields) {
    const key = field.exportName ?? field.id;
    if (!executionVariableName.test(key) || /^VEYOPS_/i.test(key))
      throw new BadRequestException('脚本参数必须使用可导出的环境变量名');
    const value = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
    if (value === undefined && field.required === false) continue;
    if (!validateGraphValue({ ...field, required: true }, value))
      throw new ExecutionPlanIssueError({
        code: 'INPUT',
        fieldId: field.id,
        fieldName: field.name,
        message: '脚本需要有效的「' + field.name + '」输入',
      });
    if (field.type === 'CREDENTIAL') {
      const id = resourceId(value)!;
      secretVariables[key] = id;
      if (credentialNonces && Object.hasOwn(credentialNonces, id))
        secretCredentialNonces[key] = credentialNonces[id]!;
    } else variables[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  for (const [key, value] of Object.entries(nodeEnvironment?.variables ?? {})) {
    delete secretVariables[key];
    delete secretCredentialNonces[key];
    variables[key] = value;
  }
  for (const [key, id] of Object.entries(nodeEnvironment?.secretVariables ?? {})) {
    delete variables[key];
    secretVariables[key] = id;
    const nonce = nodeEnvironment?.secretCredentialNonces?.[key];
    if (nonce) secretCredentialNonces[key] = nonce;
    else delete secretCredentialNonces[key];
  }
  return { variables, secretVariables, secretCredentialNonces };
}

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

  async prepareEnvironment(
    projectId: string,
    input: GraphEnvironmentSource,
    config?: GraphNode['loadEnvironment'],
    scope?: GraphNodeScope,
  ): Promise<GraphEnvironmentPlan | undefined> {
    if (!config?.envFile && !config?.pathRule) return undefined;
    const { repositoryId, commitSha, branch, tag } = input;
    const origin = { repositoryId, commitSha, branch, tag };
    const required = config.required !== false;
    const source = 'NODE' as const;
    const key = config.pathRule?.key;
    const skipped = {
      ...origin,
      status: 'SKIPPED' as const,
      source,
      required,
      mappingKey: key,
      variables: [],
    };
    let requestedPath = config.envFile;
    if (config.pathRule && key) {
      const parameters = scope?.parameters ?? {};
      const variables = scope?.environmentSet?.variables ?? {};
      if (
        !Object.hasOwn(parameters, key) &&
        Object.hasOwn(scope?.environmentSet?.secretVariables ?? {}, key)
      )
        throw new ExecutionPlanIssueError({
          code: 'CONFIGURATION',
          fieldId: 'envFile',
          message: '环境文件映射不能读取敏感变量',
        });
      const selector = Object.hasOwn(parameters, key)
        ? parameters[key]
        : Object.hasOwn(variables, key)
          ? variables[key]
          : undefined;
      const paths = config.pathRule.paths;
      requestedPath =
        typeof selector === 'string' && Object.hasOwn(paths, selector)
          ? paths[selector]
          : undefined;
      if (!requestedPath && required)
        throw new ExecutionPlanIssueError({
          code: 'CONFIGURATION',
          fieldId: 'envFile',
          message: '必需环境文件的路径映射未命中 · ' + key,
        });
    }
    if (!requestedPath) return skipped;
    const path = environmentFilePath(
      posix.join(config.directory ?? '.', environmentFilePath(requestedPath)),
    );
    if (!repositoryId || !commitSha)
      throw new ExecutionPlanIssueError({
        code: 'REPOSITORY',
        fieldId: 'source',
        message: '加载仓库环境文件需要绑定固定提交的 Git 源码',
      });
    const entry = await this.repositories
      .inspectGraphEnvironmentFile(projectId, { repositoryId, commitSha }, [path])
      .catch((error: unknown) =>
        withPlanIssue(error, {
          code: 'CONFIGURATION',
          fieldId: 'envFile',
          fieldName: '环境文件',
          repositoryId,
          commitSha,
        }),
      );
    if (!entry) {
      if (required)
        throw new ExecutionPlanIssueError({
          code: 'CONFIGURATION',
          fieldId: 'envFile',
          fieldName: '环境文件',
          repositoryId,
          commitSha,
          message: '固定 Git 提交中缺少必需的环境文件 ' + path,
        });
      return { ...skipped, path };
    }
    return {
      ...origin,
      repositoryId,
      commitSha,
      status: 'PINNED',
      source,
      path: entry.path,
      required,
      mappingKey: key,
      variables: entry.keys.map((key) => ({ key, source: 'FILE', isSecret: true })),
    };
  }

  async prepare(projectId: string, node: GraphNode, scope: GraphNodeScope): Promise<GraphNodePlan> {
    const values = scope.values ?? {};
    if (node.type === 'CHECKOUT') {
      const config = node.checkout;
      const repositoryId = resourceId(values.repository);
      if (!repositoryId)
        throw new ExecutionPlanIssueError({
          code: 'REPOSITORY',
          fieldId: 'repository',
          message: 'Git 拉取需要项目仓库',
        });
      const value = values.version;
      if (
        value !== undefined &&
        !validateGraphValue(
          { id: 'version', name: 'Git 版本', type: 'GIT_REF', required: true },
          value,
        )
      )
        throw new ExecutionPlanIssueError({
          code: 'REPOSITORY',
          fieldId: 'version',
          repositoryId,
          message: 'Git 版本必须为有效分支、标签或完整提交 SHA',
        });
      const ref =
        value && typeof value === 'object' && 'kind' in value && 'value' in value
          ? value
          : undefined;
      const kind = ref?.kind ?? 'BRANCH';
      if (kind !== 'BRANCH' && kind !== 'TAG' && kind !== 'COMMIT')
        throw new ExecutionPlanIssueError({
          code: 'REPOSITORY',
          fieldId: 'version',
          repositoryId,
          message: 'Git 版本类型无效',
        });
      const version = text(ref?.value);
      return {
        type: 'CHECKOUT',
        source: await this.repositories
          .planGraphCheckout(projectId, {
            repositoryId,
            mode: kind,
            branch: kind === 'BRANCH' ? version : undefined,
            tag: kind === 'TAG' ? version : undefined,
            commitSha: kind === 'COMMIT' ? version : undefined,
            fullClone: config?.fullClone,
          })
          .catch((error: unknown) =>
            withPlanIssue(error, {
              code: 'REPOSITORY',
              fieldId: error instanceof NotFoundException ? 'repository' : 'version',
              repositoryId,
            }),
          ),
      };
    }
    if (node.type === 'LOAD_ENV') {
      const workspace = sourceOf(values.workspace);
      const source = sourceOf(values.source);
      if (
        source?.repositoryId &&
        workspace?.repositoryId &&
        (source.repositoryId !== workspace.repositoryId || source.commitSha !== workspace.commitSha)
      )
        throw new ExecutionPlanIssueError({
          code: 'REPOSITORY',
          fieldId: 'source',
          message: '环境文件所绑定的源码与工作区来自不同 Git 提交',
        });
      const environmentId = resourceId(values.environment) ?? scope.environmentId;
      const environmentFile = await this.prepareEnvironment(
        projectId,
        (workspace?.repositoryId ? workspace : source) ?? {},
        node.loadEnvironment,
        scope,
      );
      const configured = mergeEnvironmentSet(
        await this.configs.resolveVariables(projectId, undefined, scope.serviceId),
        scope.environmentSet ?? undefined,
      );
      return {
        type: 'LOAD_ENV',
        environmentId,
        environmentFile,
        variables: graphVariableSources(environmentFile, configured.variableSources),
      };
    }
    if (node.type === 'REGISTER_ARTIFACT')
      return { type: 'REGISTER_ARTIFACT', declarations: node.registerArtifacts?.artifacts ?? [] };
    if (node.type !== 'SHELL' && node.type !== 'CHECK')
      throw new BadRequestException('不支持的功能节点');

    const serviceId = resourceId(values.service) ?? scope.serviceId;
    const variableRef = variablesOf(values.variables);
    const environmentId =
      resourceId(values.environment) ?? variableRef?.environmentId ?? scope.environmentId;
    const { variableSources: configured, ...environment } = mergeEnvironmentSet(
      await this.configs.resolveVariables(projectId, undefined, serviceId),
      scope.environmentSet ?? undefined,
    );
    const targetValue = values.targets;
    const serverId = node.shell?.serverId;
    const selection = targetValue
      ? typeof targetValue === 'string'
        ? { serverIds: [targetValue] }
        : (targetValue as DeploymentSelection)
      : serverId
        ? { serverIds: [serverId] }
        : undefined;
    const scriptInputs = scriptInputSources(node.shell?.params ?? [], values);
    const variableSources = graphVariableSources(variableRef?.environmentFile, configured, [
      ...scriptInputs,
      ...(scope.nodeEnvironmentSources ?? []),
    ]);
    const base = {
      type: node.type,
      serviceId,
      environmentId,
      environment,
      configuredVariableSources: configured,
      variableSources,
      environmentFile: variableRef?.environmentFile,
    };
    if (node.shell?.location === 'MANAGER' || !selection) return base;
    const target = await this.targets.preview(selection);
    if (target.targets.length !== 1)
      throw new ConflictException('Shell 或检查节点必须选择一台可用的服务器');
    return {
      ...base,
      serverId: target.targets[0]!.id,
      serverName: target.targets[0]!.name,
      targetHash: target.targetHash,
      targetSelection: directDeploymentSelection(selection, defaults.maxParallel),
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
      plan.type === 'REGISTER_ARTIFACT'
        ? graphDeliveryEnvironment(projectId).id
        : (resourceId(values.environment) ??
          variablesOf(environmentRef)?.environmentId ??
          scope.environmentId);
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
      if (plan.environmentFile?.status === 'PINNED') {
        const source = workspace?.repositoryId ? workspace : sourceOf(values.source);
        if (
          source?.repositoryId !== plan.environmentFile.repositoryId ||
          source.commitSha !== plan.environmentFile.commitSha
        )
          throw new ConflictException('环境节点实际源码与已确认计划不一致');
      }
      return {
        ...base,
        payload: {
          ...base.payload,
          graphModule: { ...settings, environmentFile: plan.environmentFile },
        },
      };
    }
    if (plan.type === 'REGISTER_ARTIFACT') {
      if (!self || !environmentId) throw new BadRequestException('登记产物需要已确认的执行图运行');
      const ownerServiceId = serviceId ?? graphUnscopedArtifactService(projectId).id;
      await this.configs.resolveVariables(projectId, undefined, serviceId);
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
        ownerServiceId,
        scope.nodeRunId!,
        1,
        node.name,
        definition,
        [],
      );
      const pipeline: PipelineSnapshot = {
        graph: {
          runId: scope.runId!,
          rootRunId: scope.rootRunId ?? scope.runId,
          nodeRunId: scope.nodeRunId!,
          workspace,
        },
        artifactSources: workspaceArtifactSource(workspace),
        runId: randomUUID(),
        pipelineId: profile.id,
        pipelineVersionId: profile.versionId,
        projectId,
        serviceId: ownerServiceId,
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
    const variableRef = variablesOf(environmentRef);
    if (
      plan.variableSources &&
      (plan.environmentId !== environmentId ||
        plan.serviceId !== serviceId ||
        !isDeepStrictEqual(plan.environmentFile, variableRef?.environmentFile))
    )
      throw new ConflictException('脚本节点实际环境与已确认计划不一致');
    const file =
      variableRef &&
      typeof variableRef === 'object' &&
      'workspace' in variableRef &&
      'envFile' in variableRef
        ? { workspace: workspaceOf(variableRef.workspace), envFile: text(variableRef.envFile) }
        : undefined;
    const variables: GraphEnvironmentRef | undefined = plan.environmentFile
      ? { environmentFile: plan.environmentFile, environmentId }
      : file?.workspace && file.envFile
        ? {
            workspace: await this.repositoryWorkspace(projectId, file.workspace),
            envFile: relativePath(file.envFile),
            environmentId,
          }
        : undefined;
    const parameters = scriptVariables(
      config.params ?? [],
      values,
      scope.nodeEnvironment,
      scope.credentialNonces,
    );
    const source = values.source;
    const commitSha =
      source && typeof source === 'object' && 'commitSha' in source
        ? text(source.commitSha)
        : workspace?.commitSha;
    const platform = {
      ...graphTriggerVariables(scope.trigger),
      ...(commitSha && { VEYOPS_GIT_COMMIT_SHA: commitSha }),
    };
    const variableSources = graphVariableSources(
      plan.environmentFile,
      plan.configuredVariableSources ?? plan.variableSources ?? [],
      [
        ...scriptInputSources(config.params ?? [], values),
        ...(scope.nodeEnvironmentSources ?? []),
        ...Object.keys(platform).map((key) => ({
          key,
          source: 'SYSTEM' as const,
          isSecret: false,
        })),
      ],
    );
    return {
      ...base,
      payload: {
        ...base.payload,
        targets,
        environment:
          plan.environmentId !== environmentId || plan.serviceId !== serviceId
            ? await this.configs.resolveVariables(projectId, undefined, serviceId)
            : plan.environment,
        graphModule: {
          ...settings,
          workspace: workspace ?? (!targets.length ? self : undefined),
          variables,
          variableSources,
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
    if (isGraphTriggerKind(module.trigger?.kind) && graphNodeRequiresIsolation(module.type))
      throw new ConflictException('该执行图节点尚未启用隔离自动执行');
    if (module.type === 'CHECKOUT') {
      const { commitSha, branch, tag } = module.source!;
      let subject: string | undefined;
      await createGraphWorkspace(module.workspace!, async (destination) => {
        const checkout = await this.repositories.checkoutGraphSource(
          module.projectId,
          module.source!,
          context.signal,
          destination,
        );
        subject = checkout?.subject;
      });
      context.log(
        '\u6e90\u7801\u68c0\u51fa\u5b8c\u6210 · ' +
          (tag ?? branch ?? '固定提交') +
          ' · ' +
          commitSha +
          '\n',
      );
      return graphCheckoutOutputs(module.source!, module.workspace!, subject);
    }
    if (module.type === 'LOAD_ENV') {
      return {
        variables: {
          environmentFile: module.environmentFile,
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
            ...(declaration.type === 'DOCKER_IMAGE' && { sources: [] }),
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
            physical: output.physical,
            persist: declaration.persist,
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
    const scoped = this.shellSnapshot(task, module);
    const inherited = (variables: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(variables).filter(([key]) => !Object.hasOwn(parameters.values, key)),
      );
    const snapshot = {
      ...scoped,
      variables: inherited(scoped.variables),
      secretVariables: inherited(scoped.secretVariables),
      secretCredentialNonces: inherited(scoped.secretCredentialNonces ?? {}),
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
    const output = new GraphScriptOutput((line) => context.log(line, target?.id), secrets);
    const onData = output.write.bind(output);
    const targetRunId = target && (await context.startTarget(target.id));
    let exitCode: number | null = null;
    let declared: Record<string, unknown>;
    try {
      if (target) {
        const directory = module.targetDirectory
          ? 'cd -P -- ' + shellQuote(relativePath(module.targetDirectory)) + ' || exit $?\n'
          : '';
        const result = await this.ssh.execute(target, directory + shell.command, {
          timeout: shell.timeout,
          signal: context.signal,
          variables: { variables: values, secretVariables: {} },
          secrets,
          onData,
        });
        exitCode = result.exitCode;
        output.finish();
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
          onData,
        );
        exitCode = result.exitCode;
        output.finish(result);
      } else {
        throw new Error('缺少脚本工作区');
      }
      if (exitCode !== 0 && !shell.continueOnFailure) throw new Error('脚本退出码 ' + exitCode);
      declared = output.values(shell.outputs);
    } catch (error) {
      output.finish();
      if (targetRunId)
        await context.finishTarget(
          targetRunId,
          error instanceof SshExecutionError ? error.kind : 'FAILED',
          exitCode,
          error instanceof Error ? error.message : '脚本执行失败',
        );
      throw error;
    }
    if (targetRunId)
      await context.finishTarget(
        targetRunId,
        exitCode === 0 ? 'SUCCESS' : 'FAILED',
        exitCode,
        exitCode === 0 ? undefined : '脚本退出码 ' + exitCode,
      );
    return {
      exitCode,
      report: { exitCode, passed: exitCode === 0, ...(target && { serverId: target.id }) },
      ...(!target && module.workspace && { workspace: module.workspace }),
      ...declared,
    };
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
      secretCredentialNonces: task.payload.environment?.secretCredentialNonces,
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
          'artifacts.logical_artifact_id',
          'artifacts.temporary_root_id',
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
        ...(row.temporary_root_id
          ? { temporaryArtifactId: row.id }
          : { id: row.id, artifactId: row.logical_artifact_id ?? row.id, instanceId: row.id }),
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
          'deployment_records.rollback_of_deployment_id',
        ])
        .where('pipeline_runs.task_id', '=', taskId)
        .orderBy('deployment_records.started_at', 'asc')
        .orderBy('deployment_records.id')
        .execute();
      const targets = [
        ...new Map(
          rows.flatMap((row) =>
            row.server_id
              ? [
                  [
                    row.server_id,
                    {
                      serverId: row.server_id,
                      deploymentId: row.id,
                      rollbackOfDeploymentId: row.rollback_of_deployment_id ?? undefined,
                      status: ['SUCCESS', 'CANCELLED', 'SKIPPED', 'NEEDS_ATTENTION'].includes(
                        row.status,
                      )
                        ? row.status
                        : 'FAILED',
                      health:
                        row.health_status === 'FAILED'
                          ? 'UNHEALTHY'
                          : row.health_status === 'HEALTHY'
                            ? 'HEALTHY'
                            : row.health_status === 'UNKNOWN'
                              ? 'UNKNOWN'
                              : 'NOT_CHECKED',
                      consumedArtifacts: row.artifact_id ? [{ artifactId: row.artifact_id }] : [],
                    },
                  ] as const,
                ]
              : [],
          ),
        ).values(),
      ];
      const successes = targets.filter((target) => target.status === 'SUCCESS').length;
      const status = targets.some((target) => target.status === 'NEEDS_ATTENTION')
        ? 'NEEDS_ATTENTION'
        : !successes
          ? 'FAILED'
          : successes === targets.length
            ? 'SUCCESS'
            : 'PARTIAL_SUCCESS';
      return {
        release: {
          operation: 'DEPLOY',
          service: { serviceId: rows[0]?.service_id },
          serviceId: rows[0]?.service_id,
          environmentId: rows[0]?.environment_id,
          status,
          targets,
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
