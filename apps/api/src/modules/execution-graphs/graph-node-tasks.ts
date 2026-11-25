import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from '../../core/database/schema';
import { DatabaseService } from '../../core/database/database.service';
import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
import {
  executionVariableName,
  resolveExecutionVariables,
  type ExecutionVariables,
} from '../../infrastructure/execution-variables';
import {
  SshExecutionError,
  SshService,
  type SshTarget,
} from '../../infrastructure/ssh/ssh.service';
import { TargetResolver } from '../command-center/target-resolver.service';
import { BuildsService, enterSourceDirectory, type BuildSession } from '../builds/builds.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import {
  ArtifactOutputMissing,
  ArtifactPhysicalService,
  type ArtifactPhysical,
} from '../artifacts/artifact-physical.service';
import { artifactIdentity } from '../artifacts/artifact-identities';
import { CredentialsService } from '../credentials/credentials.service';
import {
  directDeploymentSelection,
  type DeploymentSelection,
} from '../deployment-targets/deployment-selection';
import { PipelineDefinitionDto } from '../pipelines/pipeline.dto';
import { PipelineExecutor } from '../pipelines/pipeline-executor.service';
import { normalizeRelativePath, relativePath, shellQuote } from '../pipelines/pipeline.validation';
import { assertGraphCompose } from '../pipelines/graph-compose';
import { createTargetWorkspace, targetWorkspacePath } from '../pipelines/target-workspace';
import { SystemSettingsService } from '../system/system-settings.service';
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
import { unavailableReference } from '../projects/project-resource-protection';
import { resolveGraphRepositorySelector } from '../projects/graph-repository-selectors';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import type { CreateTaskInput, TaskExecutionContext, TaskRecord } from '../tasks/tasks.types';
import type { GraphNode } from './execution-graph-definition';
import type { GraphFieldEvidence } from './graph-run-bindings';
import { graphArtifactDefinitions, graphArtifactOutputs } from './graph-artifact-values';
import {
  graphScriptInputs,
  graphScriptOutputs,
  graphArtifactDeclarations,
  validateGraphValue,
  type GraphField,
  type GraphGitFetchMode,
} from './graph-fields';
import {
  assertAutomaticTargets,
  assertGraphAutomation,
  graphCheckoutEvent,
  graphNodeRequiresIsolation,
  isGraphTriggerKind,
  type GraphAutomation,
} from './graph-automatic-delivery';
import { GraphScriptOutput } from './graph-script-output';
import { SimplifiedFlowRunService } from './simplified-flow-run.service';
import { graphReleaseResult, type GraphReleaseResult } from './graph-release-gates';
import { readReleaseOutput } from './graph-release-result';
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
type NativeModule = 'CHECKOUT' | ScriptNode | 'LOAD_ENV' | 'REGISTER_ARTIFACT' | 'HEALTH_CHECK';

export interface GraphNodeScope {
  automation?: GraphAutomation;
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
  fetchModeDeferred?: boolean;
  inputEvidence?: readonly GraphFieldEvidence[];
  scriptWorkspace?: { plan?: ScriptWorkspacePlan };
  scriptArtifact?: ScriptArtifactPlan;
}

type ScriptArtifactPlan = {
  path: string;
  instances?: string[];
  producers?: { nodeId: string; fieldId: string }[];
};

export type ScriptWorkspaceCandidate = {
  producerNodeId?: string;
  producerField?: string;
  repositoryId?: string;
  commitSha?: string;
  deferred: boolean;
};

export type ScriptWorkspacePlan = ScriptWorkspaceCandidate & {
  candidates?: ScriptWorkspaceCandidate[];
  optional?: boolean;
};

export type GraphNodePlan =
  | { type: 'CHECKOUT'; source: GraphCheckoutSnapshot; fetchModeDeferred?: boolean }
  | {
      type: 'HEALTH_CHECK';
      scope?: { selection: DeploymentSelection; serverIds: string[]; targetHash: string };
    }
  | {
      type: ScriptNode;
      serverId?: string;
      serverName?: string;
      targetHash?: string;
      targetSelection?: DeploymentSelection;
      targetWorkspaceRoot?: string;
      directory: string;
      workspace?: ScriptWorkspacePlan;
      artifact?: ScriptArtifactPlan;
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
  automation?: GraphAutomation;
  type: NativeModule;
  projectId: string;
  serviceId?: string;
  environmentId?: string;
  workspace?: GraphWorkspaceRef;
  source?: GraphCheckoutSnapshot;
  variables?: GraphEnvironmentRef;
  targetDirectory?: string;
  targetWorkspaceRoot?: string;
  environmentFile?: GraphEnvironmentPlan;
  variableSources?: GraphVariableSource[];
  shell?: {
    command: string;
    timeout: number;
    continueOnFailure: boolean;
    parameters: ExecutionVariables;
    outputs: NonNullable<GraphNode['outputs']>;
    artifact?: { instanceId: string; rootId: string; path: string };
  };
  trigger?: Record<string, unknown>;
  healthCheck?: { command: string; timeoutSeconds: number; release: GraphReleaseResult };
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

function sameSource(left: GraphEnvironmentSource, right: GraphEnvironmentSource) {
  return left.repositoryId === right.repositoryId && left.commitSha === right.commitSha;
}

function workspaceIssue(message: string) {
  return new ExecutionPlanIssueError({
    code: 'INPUT',
    fieldId: 'workspace',
    fieldSection: 'input',
    message,
  });
}

export function graphCheckoutOutputs(
  snapshot: GraphCheckoutSnapshot,
  workspace?: GraphWorkspaceRef,
  subject?: string,
  fetchModeDeferred = false,
): Record<string, unknown> {
  const { repositoryId, repositoryName, branch, tag, commitSha, fullClone } = snapshot;
  const ref =
    snapshot.ref ?? (branch ? 'refs/heads/' + branch : tag ? 'refs/tags/' + tag : commitSha);
  const metadata = { repositoryId, repositoryName, ref, branch, tag, commitSha, subject };
  const source = { ...metadata, ...(!fetchModeDeferred && { fullClone }) };
  return {
    ...metadata,
    version: { kind: 'COMMIT', value: commitSha },
    ...(!fetchModeDeferred && { fetchMode: graphCheckoutFetchMode(fullClone) }),
    source,
    workspace: workspace ? { ...workspace, subject } : source,
  };
}

export function graphCheckoutFetchMode(fullClone: boolean): GraphGitFetchMode {
  return fullClone ? 'FULL' : 'LATEST';
}

function checkoutFullClone(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'FULL' || value === 'LATEST') return value === 'FULL';
  throw new ExecutionPlanIssueError({
    code: 'REPOSITORY',
    fieldId: 'fetchMode',
    message: '拉取方式必须为仅拉取指定提交或完整历史',
  });
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
    private readonly physical: ArtifactPhysicalService,
    private readonly systemSettings: SystemSettingsService,
    @Optional() private readonly pipelineExecutor?: PipelineExecutor,
    @Optional() private readonly simplified?: SimplifiedFlowRunService,
  ) {}

  onModuleInit() {
    this.registry.register({
      type: 'GRAPH_MODULE',
      execute: async (task, context) => {
        try {
          if (task.payload.simplifiedAction) {
            if (!this.simplified) throw new ConflictException('运行工作区服务不可用');
            return { graphOutputs: await this.simplified.execute(task, context) };
          }
          return { graphOutputs: await this.execute(task, context) };
        } catch (error) {
          context.log(error instanceof Error ? error.message + '\n' : '功能节点失败\n');
          throw error;
        }
      },
    });
  }

  private async scriptRepositoryValues(
    projectId: string,
    fields: readonly GraphField[],
    values: Record<string, unknown>,
  ) {
    const resolved = { ...values };
    for (const field of fields) {
      const value = values[field.id];
      if (field.type !== 'REPOSITORY' || value === undefined) continue;
      const entries = Array.isArray(value) ? value : [value];
      const addresses: string[] = [];
      for (const entry of entries) {
        try {
          const id = await resolveGraphRepositorySelector(
            this.database.db,
            projectId,
            String(entry),
          );
          const repository = await this.database.db
            .selectFrom('repositories')
            .select('clone_url')
            .where('id', '=', id)
            .where('project_id', '=', projectId)
            .where('archived_at', 'is', null)
            .executeTakeFirst();
          if (!repository) throw new NotFoundException('项目仓库不存在或已归档');
          addresses.push(repository.clone_url);
        } catch (error) {
          withPlanIssue(error, {
            code: 'REPOSITORY',
            fieldId: field.id,
            fieldName: field.name,
          });
        }
      }
      resolved[field.id] = Array.isArray(value) ? addresses : addresses[0];
    }
    return resolved;
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
    if (node.type === 'HEALTH_CHECK') {
      if (!values.targets) return { type: 'HEALTH_CHECK' };
      const selection = directDeploymentSelection(
        typeof values.targets === 'string'
          ? { serverIds: [values.targets] }
          : (values.targets as DeploymentSelection),
        defaults.maxParallel,
      );
      if (!selection) throw new BadRequestException('请选择健康检查目标');
      const target = await this.targets.preview(selection);
      if (scope.automation)
        await assertAutomaticTargets(
          this.database.db,
          target.targets.map(({ id }) => id),
        ).catch((error: unknown) =>
          withPlanIssue(error, { code: 'RELEASE_TARGET', fieldId: 'targets' }),
        );
      return {
        type: 'HEALTH_CHECK',
        scope: {
          selection,
          serverIds: target.targets.map(({ id }) => id),
          targetHash: target.targetHash,
        },
      };
    }
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
      const fullClone = checkoutFullClone(values.fetchMode) ?? config?.fullClone;
      const event = graphCheckoutEvent(scope.trigger, node.id);
      return {
        type: 'CHECKOUT',
        ...(scope.fetchModeDeferred && { fetchModeDeferred: true }),
        source: await this.repositories
          .planGraphCheckout(projectId, {
            repositoryId,
            mode: kind,
            branch: kind === 'BRANCH' ? version : undefined,
            tag: kind === 'TAG' ? version : undefined,
            commitSha: kind === 'COMMIT' ? version : undefined,
            fullClone,
            event,
          })
          .catch((error: unknown) =>
            withPlanIssue(error, {
              code: 'REPOSITORY',
              fieldId: error instanceof NotFoundException ? 'repository' : 'version',
              repositoryId,
              ...(event?.repositoryId === repositoryId && { commitSha: event.commitSha }),
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
    if (node.type === 'REGISTER_ARTIFACT') {
      if (scope.automation) await BuildsService.automaticManagerSocket();
      return {
        type: 'REGISTER_ARTIFACT',
        declarations: graphArtifactDefinitions(node.registerArtifacts?.artifacts ?? []),
      };
    }
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
    const scriptInputs = scriptInputSources(graphScriptInputs(node), values);
    const variableSources = graphVariableSources(variableRef?.environmentFile, configured, [
      ...scriptInputs,
      ...(scope.nodeEnvironmentSources ?? []),
    ]);
    if (scope.automation && variableSources.some(({ isSecret }) => isSecret))
      throw new BadRequestException('自动脚本不能使用环境或节点中的敏感变量');
    const input = scope.inputEvidence?.find(({ fieldId }) => fieldId === 'workspace');
    const workspace = sourceOf(values.workspace);
    const source = sourceOf(values.source);
    if (
      !scope.scriptWorkspace &&
      workspace?.repositoryId &&
      source &&
      !sameSource(workspace, source)
    )
      throw workspaceIssue('脚本绑定的源码与工作区来自不同 Git 提交');
    const plannedWorkspace: ScriptWorkspacePlan | undefined = scope.scriptWorkspace
      ? scope.scriptWorkspace.plan
      : workspace || input?.state === 'DEFERRED'
        ? {
            producerNodeId: input?.source?.nodeId,
            producerField: input?.source?.fieldId,
            repositoryId: workspace?.repositoryId ?? source?.repositoryId,
            commitSha: workspace?.commitSha ?? source?.commitSha,
            deferred: input?.state === 'DEFERRED',
          }
        : undefined;
    const base = {
      type: node.type,
      serviceId,
      environmentId,
      environment,
      configuredVariableSources: configured,
      variableSources,
      environmentFile: variableRef?.environmentFile,
      directory: relativePath(node.shell?.directory || '.'),
      workspace: plannedWorkspace,
      artifact: scope.scriptArtifact,
    };
    const manager = async () => {
      if (scope.automation) await BuildsService.automaticManagerSocket();
      return base;
    };
    if (node.shell?.location === 'MANAGER') return manager();
    const targetIssue = {
      code: 'BUILD_TARGET',
      fieldId: 'targets',
      fieldSection: 'input',
      targetSource: 'RUN_INPUT',
    } as const;
    const targetSelection = selection && directDeploymentSelection(selection, defaults.maxParallel);
    if (!targetSelection) {
      if (node.shell?.location === 'TARGET')
        throw new ExecutionPlanIssueError({
          ...targetIssue,
          message: '目标端脚本或检查需要选择一台可用的服务器',
        });
      return manager();
    }
    const target = await this.targets
      .preview(targetSelection)
      .catch((error: unknown) => withPlanIssue(error, targetIssue));
    if (target.targets.length !== 1)
      throw new ExecutionPlanIssueError(
        {
          ...targetIssue,
          message: '目标端脚本或检查需要选择一台可用的服务器',
        },
        409,
      );
    if (scope.automation)
      await assertAutomaticTargets(
        this.database.db,
        target.targets.map(({ id }) => id),
      ).catch((error: unknown) => withPlanIssue(error, targetIssue));
    return {
      ...base,
      serverId: target.targets[0]!.id,
      serverName: target.targets[0]!.name,
      targetHash: target.targetHash,
      targetSelection,
      targetWorkspaceRoot: (await this.systemSettings.get(projectId)).targetWorkspaceRoot,
    };
  }

  private async repositoryWorkspace(projectId: string, reference: GraphWorkspaceRef) {
    const available = await ownedGraphWorkspace(this.database.db, projectId, reference);
    await openGraphWorkspace(available);
    return available;
  }

  async assertScriptArtifactPath(projectId: string, instanceId: string, path: string) {
    const row = await this.database.db
      .selectFrom('artifacts')
      .select('physical_json')
      .where('project_id', '=', projectId)
      .where('id', '=', instanceId)
      .where('lifecycle_state', '=', 'ACTIVE')
      .where('pruned_at', 'is', null)
      .executeTakeFirst();
    if (!row?.physical_json) throw new ConflictException('所选产物没有可验证的文件或目录实物');
    await this.artifacts.verifyFileSelection(row.physical_json, normalizeRelativePath(path));
  }

  private async scriptArtifactPhysical(
    projectId: string,
    input: NonNullable<NonNullable<GraphModulePayload['shell']>['artifact']>,
  ) {
    const row = await this.database.db
      .selectFrom('artifacts')
      .select(['physical_json', 'temporary_root_id'])
      .where('project_id', '=', projectId)
      .where('id', '=', input.instanceId)
      .where('lifecycle_state', '=', 'ACTIVE')
      .where('pruned_at', 'is', null)
      .executeTakeFirst();
    if (!row?.physical_json || (row.temporary_root_id && row.temporary_root_id !== input.rootId))
      throw new ConflictException('所选脚本产物已不可用');
    return JSON.parse(row.physical_json) as ArtifactPhysical;
  }

  private async confirmedScriptWorkspace(
    plan: ScriptWorkspacePlan | undefined,
    workspace: GraphWorkspaceRef | undefined,
    scope: GraphNodeScope,
  ) {
    if (!workspace && scope.values?.workspace === undefined && (!plan || plan.optional)) return;
    if (!plan || !workspace) throw workspaceIssue('脚本实际工作区与已确认计划不一致');
    const binding = scope.inputEvidence?.find(({ fieldId }) => fieldId === 'workspace')?.source;
    const candidates = (plan.candidates ?? [plan]).filter(
      ({ producerNodeId, producerField }) =>
        (!producerNodeId && !producerField) ||
        (binding?.nodeId === producerNodeId && binding?.fieldId === producerField),
    );
    if (!candidates.length) throw workspaceIssue('脚本实际工作区来源与已确认计划不一致');
    const match = candidates.find(
      ({ repositoryId, commitSha, deferred }) =>
        ((deferred && repositoryId === undefined) || repositoryId === workspace.repositoryId) &&
        ((deferred && commitSha === undefined) || commitSha === workspace.commitSha),
    );
    if (!match) throw workspaceIssue('脚本实际工作区与已确认计划不一致');
    if (binding?.kind !== 'OUTPUT') return;
    if (!scope.runId || !match.producerNodeId || !match.producerField)
      throw workspaceIssue('脚本实际工作区必须由已确认的上游节点提供');
    const producer = await this.database.db
      .selectFrom('execution_node_runs')
      .select('output_json')
      .where('run_id', '=', scope.runId)
      .where('node_id', '=', match.producerNodeId)
      .where('status', '=', 'SUCCESS')
      .executeTakeFirst();
    const original = producer?.output_json
      ? workspaceOf(JSON.parse(producer.output_json)[match.producerField])
      : undefined;
    if (
      original?.nodeRunId !== workspace.nodeRunId ||
      original.runId !== workspace.runId ||
      !sameSource(original, workspace)
    )
      throw workspaceIssue('脚本实际工作区必须由已确认的上游节点提供');
  }

  private artifactTask(
    task: CreateTaskInput,
    module: GraphModulePayload,
    scope: GraphNodeScope,
    declarations: NamedArtifactDefinition[],
    workspace: GraphWorkspaceRef | undefined,
    buildLocation: 'MANAGER' | 'TARGET',
  ): CreateTaskInput {
    if (!scope.runId || !scope.nodeRunId)
      throw new BadRequestException('登记产物需要已确认的执行图运行');
    const { projectId, serviceId } = module;
    const ownerServiceId = serviceId ?? graphUnscopedArtifactService(projectId).id;
    const environmentId = graphDeliveryEnvironment(projectId).id;
    const definition = Object.assign(new PipelineDefinitionDto(), {
      repositoryId: workspace?.repositoryId ?? unversionedArtifactRepository,
      repoPath: module.targetDirectory ?? '.',
      buildLocation,
      artifactType: declarations[0]!.type === 'DOCKER_IMAGE' ? 'DOCKER_IMAGE' : 'FILE',
      artifacts: declarations,
    });
    const profile = deliveryExecutionProfile(
      projectId,
      ownerServiceId,
      scope.nodeRunId,
      1,
      task.name,
      definition,
      [],
    );
    const pipeline: PipelineSnapshot = {
      graph: {
        runId: scope.runId,
        rootRunId: scope.rootRunId ?? scope.runId,
        nodeRunId: scope.nodeRunId,
        workspace,
      },
      artifactSources: workspaceArtifactSource(workspace),
      graphAutomation: scope.automation,
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
      ...task,
      registrationProfile: profile,
      pipelineRun: {
        id: pipeline.runId,
        pipelineId: profile.id,
        pipelineVersionId: profile.versionId,
        gitRef: pipeline.commitSha,
        commitSha: pipeline.commitSha,
        buildLocation,
        artifactType: definition.artifactType,
      },
      payload: { ...task.payload, pipeline, graphModule: module },
    };
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
    const workspace = reference
      ? await this.repositoryWorkspace(projectId, reference).catch((error: unknown) => {
          if (plan.type === 'SHELL' || plan.type === 'CHECK')
            throw workspaceIssue('绑定的工作区必须由当前项目的成功节点提供，且目录仍然有效');
          throw error;
        })
      : undefined;
    const settings = {
      type: plan.type,
      ...identity,
      trigger: scope.trigger,
      automation: scope.automation,
    };
    const base: CreateTaskInput = {
      name: node.name,
      type: 'GRAPH_MODULE',
      scope: identity,
      idempotencyKey,
      payload: { ...defaults, targets: [], steps: [] },
    };

    if (plan.type === 'HEALTH_CHECK') {
      const release = graphReleaseResult(values.release);
      const selected = plan.scope
        ? release.targets.filter(({ serverId }) => plan.scope!.serverIds.includes(serverId))
        : release.targets;
      if (
        release.operation === 'CHECK' ||
        (release.status !== 'SUCCESS' && !(release.status === 'PARTIAL_SUCCESS' && plan.scope)) ||
        (serviceId && release.serviceId !== serviceId) ||
        (plan.scope && selected.length !== plan.scope.serverIds.length) ||
        !selected.length ||
        selected.some(({ status, deploymentId }) => status !== 'SUCCESS' || !deploymentId)
      )
        throw new ConflictException('健康检查目标必须匹配已确认且成功激活的发布');
      if (!node.healthCheck?.command || !this.pipelineExecutor)
        throw new BadRequestException('健康检查命令或执行器不可用');
      const targets = await this.targets.resolveForExecution({
        ...defaults,
        ...(plan.scope?.selection ?? { serverIds: selected.map(({ serverId }) => serverId) }),
        expectedTargetHash: plan.scope?.targetHash,
        confirmed: true,
      });
      return {
        ...base,
        scope: { ...identity, serviceId: release.serviceId },
        payload: {
          ...base.payload,
          targets,
          graphModule: {
            ...settings,
            serviceId: release.serviceId,
            healthCheck: {
              release: { ...release, targets: selected },
              command: node.healthCheck.command,
              timeoutSeconds: node.healthCheck.timeoutSeconds ?? 30,
            },
          },
        },
      };
    }

    if (plan.type === 'CHECKOUT') {
      if (!self) throw new BadRequestException('缺少源码工作区标识');
      const fullClone = checkoutFullClone(values.fetchMode);
      if (
        plan.fetchModeDeferred
          ? fullClone === undefined
          : fullClone !== undefined && fullClone !== plan.source.fullClone
      )
        throw new ConflictException('实际拉取方式与已确认计划不一致');
      const source =
        plan.fetchModeDeferred && fullClone !== undefined
          ? { ...plan.source, fullClone }
          : plan.source;
      return {
        ...base,
        payload: {
          ...base.payload,
          graphModule: { ...settings, workspace: self, source },
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
      return this.artifactTask(
        base,
        { ...settings, workspace: workspace ?? self },
        scope,
        declarations,
        workspace,
        'MANAGER',
      );
    }

    const config = node.shell;
    if (!config?.command?.trim()) throw new BadRequestException('请输入脚本命令');
    await this.confirmedScriptWorkspace(plan.workspace, workspace, scope);
    const source = sourceOf(values.source);
    if (workspace && source && !sameSource(workspace, source))
      throw workspaceIssue('脚本实际源码与工作区来自不同 Git 提交');
    if (config.location === 'TARGET' && !plan.serverId)
      throw new BadRequestException('目标端 Shell 缺少确认的服务器');
    const targets = plan.serverId
      ? await this.targets.resolveForExecution({
          ...defaults,
          ...(plan.targetSelection ?? { serverIds: [plan.serverId] }),
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
    const fields = graphScriptInputs(node);
    const parameters = scriptVariables(
      fields,
      await this.scriptRepositoryValues(projectId, fields, values),
      scope.nodeEnvironment,
      scope.credentialNonces,
    );
    const commitSha = source?.commitSha ?? workspace?.commitSha;
    const platform = {
      ...graphTriggerVariables(scope.trigger),
      ...(commitSha && { VEYOPS_GIT_COMMIT_SHA: commitSha }),
    };
    const variableSources = graphVariableSources(
      plan.environmentFile,
      plan.configuredVariableSources ?? plan.variableSources ?? [],
      [
        ...scriptInputSources(fields, values),
        ...(scope.nodeEnvironmentSources ?? []),
        ...Object.keys(platform).map((key) => ({
          key,
          source: 'SYSTEM' as const,
          isSecret: false,
        })),
      ],
    );
    const task: CreateTaskInput = {
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
          targetDirectory: plan.directory ?? config.directory,
          targetWorkspaceRoot: plan.targetWorkspaceRoot,
          shell: {
            command: config.command,
            timeout: config.timeout ?? defaults.timeout,
            continueOnFailure: config.continueOnFailure === true,
            parameters: { ...parameters, variables: { ...parameters.variables, ...platform } },
            outputs: graphScriptOutputs(node),
            ...(scope.scriptArtifact?.instances?.length === 1 &&
              plan.artifact &&
              plan.artifact.path === scope.scriptArtifact.path && {
                artifact: {
                  instanceId: scope.scriptArtifact.instances[0]!,
                  rootId: scope.rootRunId!,
                  path: plan.artifact.path,
                },
              }),
          },
        },
      },
    };
    const authored = graphArtifactDeclarations(node) ?? [];
    if (!authored.length) return task;
    const declarations = graphArtifactDefinitions(
      authored.map((artifact) => {
        if (!artifact.pathInput) return artifact;
        const value = text(values[artifact.pathInput]);
        if (!value && !artifact.path) throw new BadRequestException('脚本的产物路径输入缺少实际值');
        return value ? { ...artifact, path: relativePath(value) } : artifact;
      }),
    );
    return this.artifactTask(
      task,
      task.payload.graphModule!,
      scope,
      declarations,
      workspace,
      targets.length ? 'TARGET' : 'MANAGER',
    );
  }

  private async execute(
    task: TaskRecord,
    context: TaskExecutionContext,
  ): Promise<Record<string, unknown>> {
    const module = task.payload.graphModule!;
    if (module.automation) {
      const { created_by: ownerId } = await this.database.db
        .selectFrom('tasks')
        .select('created_by')
        .where('id', '=', task.id)
        .executeTakeFirstOrThrow();
      await assertGraphAutomation(
        this.database.db,
        module.projectId,
        ownerId,
        module.automation,
        graphNodeRequiresIsolation(module.type),
      );
      if (task.payload.targets.length)
        await assertAutomaticTargets(this.database.db, task.payload.targets);
    } else if (isGraphTriggerKind(module.trigger?.kind) && graphNodeRequiresIsolation(module.type))
      throw new ConflictException('该执行图节点尚未启用隔离自动执行');
    if (module.type === 'HEALTH_CHECK') {
      const { release, command, timeoutSeconds } = module.healthCheck!;
      if (!this.pipelineExecutor) throw new ConflictException('健康检查执行器不可用');
      const targets: GraphReleaseResult['targets'] = [];
      for (const target of release.targets) {
        context.signal.throwIfAborted();
        if (!target.deploymentId) throw new ConflictException('没有可验证的目标发布记录');
        const id = await context.startTarget(target.serverId);
        const result = await this.pipelineExecutor.checkGraphRelease(
          module.projectId,
          target.serverId,
          target.deploymentId,
          command,
          timeoutSeconds,
          context,
          task.id,
        );
        // A confirmed negative health verdict is a successful probe for branch dispatch.
        const status = result.health === 'UNKNOWN' ? 'NEEDS_ATTENTION' : 'SUCCESS';
        await context.finishTarget(id, status, result.probeExitCode, result.healthReason);
        targets.push({ ...target, ...result, status });
      }
      const status = targets.some(({ health }) => health === 'UNKNOWN')
        ? 'UNKNOWN'
        : targets.some(({ health }) => health === 'UNHEALTHY')
          ? 'UNHEALTHY'
          : 'HEALTHY';
      return {
        healthy: status === 'HEALTHY',
        status,
        release: {
          ...release,
          operation: 'CHECK',
          status: status === 'UNKNOWN' ? 'NEEDS_ATTENTION' : 'SUCCESS',
          healthStatus: status,
          targets,
        },
      };
    }
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
      await this.collectManagerArtifacts(
        this.session(task, context, task.payload.pipeline!),
        workspace,
      );
      return {};
    }

    const shell = module.shell!;
    if (
      module.automation &&
      (Object.keys(shell.parameters.secretVariables).length ||
        Object.keys(task.payload.environment?.secretVariables ?? {}).length ||
        module.variables)
    )
      throw new ConflictException('自动脚本不能使用环境或节点中的敏感变量');
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
    const artifactSession =
      task.payload.pipeline && this.session(task, context, task.payload.pipeline, values, secrets);
    const shellSession = this.session(task, context, snapshot, values, secrets);
    let targetWorkspace: string | undefined;
    let artifactScratch: string | undefined;
    let sourceRoot: string | undefined;
    let uncertainExecution = false;
    let exitCode: number | null = null;
    let declared: Record<string, unknown>;
    try {
      if (target) {
        const relativeDirectory = relativePath(module.targetDirectory || '.');
        let directory = module.targetDirectory
          ? 'cd -P -- ' + shellQuote(relativePath(module.targetDirectory)) + ' || exit $?\n'
          : '';
        if (
          module.targetWorkspaceRoot ||
          module.automation ||
          module.workspace ||
          artifactSession
        ) {
          if (!module.targetWorkspaceRoot) throw new ConflictException('缺少已确认的脚本工作目录');
          const name = 'veyops-script-' + task.id;
          const workspaceReceipt = await this.builds.remoteCapture(
            target,
            createTargetWorkspace(module.targetWorkspaceRoot, name),
            shellSession,
            30,
          );
          targetWorkspace = targetWorkspacePath(workspaceReceipt, name);
          if (module.workspace)
            await this.builds.transferGraphWorkspace(
              target,
              targetWorkspace,
              shellSession,
              module.workspace,
            );
          sourceRoot = module.workspace ? targetWorkspace + '/repo' : targetWorkspace;
          directory = enterSourceDirectory(sourceRoot, relativeDirectory) + '\n';
        }
        if (shell.artifact) {
          if (!targetWorkspace) throw new ConflictException('缺少脚本产物工作区');
          const physical = await this.scriptArtifactPhysical(module.projectId, shell.artifact);
          const archive = targetWorkspace + '/input.tar.gz';
          const input = targetWorkspace + '/input';
          let checksum: string;
          if (physical.location === 'SERVER_PATH' && physical.serverId === target.id) {
            ({ checksum } = await this.physical.stageServerArchive(
              physical,
              target,
              archive,
              context.signal,
              shell.artifact.path,
            ));
          } else {
            artifactScratch = await mkdtemp(join(tmpdir(), 'veyops-script-artifact-'));
            const local = join(artifactScratch, 'input.tar.gz');
            ({ checksum } = await this.physical.stageLocalPathArchive(
              physical,
              local,
              shell.artifact.path,
              context.signal,
            ));
            await this.ssh.upload(target, local, archive, { timeout: 300, signal: context.signal });
          }
          await this.builds.remote(
            target,
            [
              'set -eu',
              'test "$(sha256sum < ' +
                shellQuote(archive) +
                ' | cut -d " " -f1)" = ' +
                shellQuote(checksum),
              'umask 077',
              'mkdir -- ' + shellQuote(input),
              'tar --no-same-owner --no-same-permissions -xf ' +
                shellQuote(archive) +
                ' -C ' +
                shellQuote(input),
            ].join('\n'),
            shellSession,
            180,
            '脚本产物归档校验或展开失败',
          );
          values.VEYOPS_ARTIFACT_DIR = input;
          await context.log(
            '读取产物 ' + shell.artifact.instanceId + ' · ' + shell.artifact.path + '\n',
            target.id,
          );
        }
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
        let archive: string | undefined;
        if (shell.artifact) {
          const physical = await this.scriptArtifactPhysical(module.projectId, shell.artifact);
          artifactScratch = await mkdtemp(join(tmpdir(), 'veyops-script-artifact-'));
          archive = join(artifactScratch, 'input.tar.gz');
          await this.physical.stageLocalPathArchive(
            physical,
            archive,
            shell.artifact.path,
            context.signal,
          );
          values.VEYOPS_ARTIFACT_DIR = '/run/veyops/artifact';
          await context.log(
            '读取产物 ' + shell.artifact.instanceId + ' · ' + shell.artifact.path + '\n',
          );
        }
        const result = await this.builds.managerGraphShell(
          shellSession,
          workspace,
          shell.command,
          module.targetDirectory ?? '.',
          shell.timeout,
          onData,
          archive,
        );
        exitCode = result.exitCode;
        output.finish(result);
      } else {
        throw new Error('缺少脚本工作区');
      }
      if (exitCode !== 0 && !shell.continueOnFailure) throw new Error('脚本退出码 ' + exitCode);
      declared = output.values(shell.outputs);
      const serviceRefs = shell.outputs.flatMap((field) => {
        if (field.type !== 'SERVICE' || declared[field.id] === undefined) return [];
        const value = declared[field.id];
        return (Array.isArray(value) ? value : [value]).map((service) => ({
          field,
          resourceType: 'SERVICE' as const,
          resourceId: resourceId(service)!,
        }));
      });
      const invalidService = await unavailableReference(
        this.database.db,
        module.projectId,
        serviceRefs,
      );
      if (invalidService)
        throw new ExecutionPlanIssueError({
          code: 'CONFIGURATION',
          fieldId: invalidService.field.id,
          fieldName: invalidService.field.name,
          message: '脚本输出的项目服务不存在、已归档或不属于当前项目',
        });
      if (artifactSession) {
        if (target && targetWorkspace && sourceRoot)
          await this.collectTargetArtifacts(artifactSession, target, targetWorkspace, sourceRoot);
        else if (module.workspace)
          await this.collectManagerArtifacts(artifactSession, module.workspace);
      }
    } catch (error) {
      output.finish();
      uncertainExecution = error instanceof SshExecutionError && error.kind === 'NEEDS_ATTENTION';
      if (targetRunId)
        await context.finishTarget(
          targetRunId,
          error instanceof SshExecutionError ? error.kind : 'FAILED',
          exitCode,
          error instanceof Error ? error.message : '脚本执行失败',
        );
      throw error;
    } finally {
      if (artifactScratch) await rm(artifactScratch, { recursive: true, force: true });
      if (target && targetWorkspace && !uncertainExecution) {
        const work = shellQuote(targetWorkspace);
        try {
          const cleanup = await this.ssh.execute(
            target,
            `test ! -L ${work} && test "$(cd -P -- ${work} && pwd -P)" = ${work} && rm -rf -- ${work}`,
            { timeout: 30 },
          );
          if (cleanup.exitCode !== 0) context.log('脚本临时工作目录清理失败\n', target.id);
        } catch {
          context.log('脚本临时工作目录清理失败\n', target.id);
        }
      }
      if (target && targetWorkspace && uncertainExecution)
        context.log('远程执行结果待核查，保留本次脚本工作目录\n', target.id);
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

  private async collectManagerArtifacts(session: BuildSession, workspace: GraphWorkspaceRef) {
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
        session.context.log('已登记产物 ' + declaration.name + '\n');
      }
    } finally {
      await result.cleanup();
    }
  }

  private async collectTargetArtifacts(
    session: BuildSession,
    target: SshTarget,
    workspace: string,
    sourceRoot: string,
  ) {
    const { snapshot, context } = session;
    for (const declaration of snapshot.definition.artifacts ?? []) {
      const image = declaration.type === 'DOCKER_IMAGE';
      try {
        const physical =
          declaration.type === 'DOCKER_IMAGE'
            ? await this.physical.describeImage({
                target,
                reference: declaration.imageReference!,
                owner: 'EXTERNAL',
                signal: context.signal,
              })
            : await this.physical.collectServerPath({
                target,
                workspace: sourceRoot,
                relativePath: posix.join(
                  snapshot.definition.repoPath,
                  relativePath(declaration.path!),
                ),
                kind: declaration.type,
                instanceId: artifactIdentity(snapshot, declaration.name, target.id).instanceId,
                signal: context.signal,
              });
        let composeYaml: string | undefined;
        if (image && declaration.composeFilePath) {
          const directory = snapshot.definition.repoPath;
          const file = declaration.composeFilePath;
          try {
            composeYaml = await this.builds.remoteComposeSnapshot(target, workspace, session, {
              root: sourceRoot,
              directory,
              path: file,
            });
            if (!composeYaml) throw new Error('无法读取 Compose 文件');
            assertGraphCompose(composeYaml);
          } catch (error) {
            if (
              context.signal.aborted ||
              (error instanceof SshExecutionError && error.kind !== 'FAILED')
            )
              throw error;
            throw new ExecutionPlanIssueError({
              code: 'ARTIFACT',
              fieldSection: 'output',
              fieldId: declaration.name,
              artifactField: 'composeFilePath',
              message: `产物「${declaration.name}」的 Compose 文件「${posix.join(directory, file)}」归档失败：${error instanceof Error ? error.message : '文件不可用'}`,
            });
          }
        }
        await this.artifacts.create(snapshot, {
          name: declaration.name,
          kind: declaration.type,
          storageKey: physical.imageReference ?? physical.path!,
          storageType: image ? 'REMOTE_IMAGE' : 'REMOTE_FILE',
          serverId: target.id,
          physical,
          imageReference: physical.imageReference,
          imageId: physical.imageId,
          checksum: physical.sha256,
          sizeBytes: physical.sizeBytes,
          composeYaml,
          persist: declaration.persist,
        });
        context.log('已登记产物 ' + declaration.name + '\n', target.id);
      } catch (error) {
        if (declaration.required !== false || !(error instanceof ArtifactOutputMissing))
          throw error;
        context.log('可选产物 ' + declaration.name + ' 不存在，已略过\n', target.id);
      }
    }
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
      graphAutomation: module.automation,
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
    simplified = false,
  ): Promise<Record<string, unknown>> {
    const declarations = graphArtifactDeclarations(node);
    let artifactValues = {};
    if (
      !simplified &&
      (node.type === 'BUILD' || node.type === 'REGISTER_ARTIFACT' || declarations?.length)
    ) {
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
          'artifacts.physical_json',
        ])
        .where('pipeline_runs.task_id', '=', taskId)
        .orderBy('artifacts.artifact_name')
        .orderBy('artifacts.id')
        .execute();
      const { named, artifacts } = graphArtifactOutputs(rows, declarations ?? []);
      artifactValues = { ...Object.fromEntries(named), artifacts };
      if (node.type === 'BUILD' || node.type === 'REGISTER_ARTIFACT') return artifactValues;
    }
    if (node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT')
      return readReleaseOutput(
        db,
        taskId,
        node.type === 'ROLLBACK_ARTIFACT' ? 'ROLLBACK' : 'DEPLOY',
      );
    const task = await db
      .selectFrom('tasks')
      .select('result_json')
      .where('id', '=', taskId)
      .executeTakeFirst();
    return {
      ...(task?.result_json &&
        (JSON.parse(task.result_json) as { graphOutputs?: Record<string, unknown> }).graphOutputs),
      ...artifactValues,
    };
  }
}
