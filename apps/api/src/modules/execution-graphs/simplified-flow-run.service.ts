import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kysely, Transaction } from 'kysely';
import { dataDirectory } from '../../core/config';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { ExecutionPlanIssueError } from '../../core/execution-plan-issue';
import { resolveExecutionVariables } from '../../infrastructure/execution-variables';
import { SshExecutionError } from '../../infrastructure/ssh/ssh.service';
import { artifactIdentity } from '../artifacts/artifact-identities';
import {
  ArtifactPhysicalService,
  type ArtifactPhysical,
} from '../artifacts/artifact-physical.service';
import { artifactPathDigest } from '../artifacts/artifact-physical-paths';
import { ArtifactsService, deploymentFingerprint } from '../artifacts/artifacts.service';
import { BuildsService, type BuildSession } from '../builds/builds.service';
import { CredentialsService } from '../credentials/credentials.service';
import {
  confirmDeploymentMembers,
  directDeploymentSelection,
  selectedServerIds,
  type DeploymentSelection,
} from '../deployment-targets/deployment-selection';
import {
  deliveryExecutionProfile,
  graphDeliveryEnvironment,
  graphUnscopedArtifactService,
  type DeliveryExecutionProfile,
} from '../pipelines/delivery-execution-profile';
import { PipelineDefinitionDto } from '../pipelines/pipeline.dto';
import { assertGraphCompose } from '../pipelines/graph-compose';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { PipelinesService } from '../pipelines/pipelines.service';
import { normalizeRelativePath, shellQuote } from '../pipelines/pipeline.validation';
import {
  resolveEnvironmentSet,
  type FrozenEnvironmentSet,
} from '../projects/environment-sets.service';
import { RepositoryMetadataService } from '../projects/repository-metadata.service';
import { ServersService } from '../servers/servers.service';
import { SystemSettingsService } from '../system/system-settings.service';
import { redactTaskLog } from '../tasks/task-log.service';
import type { CreateTaskInput, TaskExecutionContext, TaskRecord } from '../tasks/tasks.types';
import type { GraphFlow, GraphNode } from './execution-graph-definition';
import {
  assertAutomaticTargets,
  assertGraphAutomation,
  graphCheckoutEvent,
  type GraphAutomation,
} from './graph-automatic-delivery';
import {
  environmentSetSummary,
  mergeGraphNodeEnvironment,
  type GraphEnvironmentFilePin,
  type GraphVariableSnapshot,
} from './graph-environment';
import {
  FlowWorkspaceService,
  type FlowCheckout,
  type FlowWorkspacePlacement,
} from './flow-workspace.service';
import type { GitRefValue } from './graph-run-bindings';
import type { GraphInputsDto } from './graph-runner.controller';
import {
  graphGateHash,
  sameIds,
  type GraphGateDecision,
  type GraphGateScope,
} from './graph-release-gates';
import {
  simplifiedImageName,
  simplifiedReleaseImage,
  simplifiedSourceDirectory,
  type SimplifiedFinish,
  type SimplifiedStart,
} from './simplified-flow-definition';
import {
  graphTriggerVariables,
  unversionedArtifactCommit,
  unversionedArtifactRepository,
} from './graph-workspace';

const workspaceArtifact = 'workspace';
export const flowImageTagVariable = 'VEYOPS_IMAGE_TAG';

export function flowImageTag(runId: string) {
  return `run-${runId}`;
}

type FlowRunIdentity = {
  id: string;
  project_id: string;
  flow_id: string;
  version: number;
  created_by: string;
  configuration_hash: string;
};
type NodeRunIdentity = { id: string; node_id: string };
type FixedRelease = {
  nodeId: string;
  serviceId: string;
  targets: DeploymentSelection;
  serverIds: string[];
  artifactId?: string;
  knownHash?: string;
  planHash: string;
  method: 'FILE' | 'COMPOSE';
  image?: { id: string; name: string };
  path: string;
  deployPath: string;
  workspaceComposePath?: string;
  rollbackBaseline?: Record<string, string>;
  requireApproval: boolean;
  requireCodeReview: boolean;
  profile: DeliveryExecutionProfile;
};

export type SimplifiedRunPlan = {
  placement: FlowWorkspacePlacement;
  serviceId?: string;
  buildSelection?: DeploymentSelection;
  sources: (FlowCheckout & { id: string })[];
  environment: GraphVariableSnapshot;
  dotenv?: GraphEnvironmentFilePin;
  finish: SimplifiedFinish;
  release?: FixedRelease;
  value?: string;
  automation?: GraphAutomation;
  trigger?: Record<string, unknown>;
};

export function workspaceRetention(finish: SimplifiedFinish, currentFileRelease: boolean) {
  if (finish.saveWorkspace === false) return currentFileRelease ? 'RUN' : 'OFF';
  return finish.retention ?? 'PERSISTENT';
}

export type SimplifiedSnapshotRequest = {
  workspace: boolean;
  imageIds: string[];
  expectedImageId?: string;
  checkoutCompleted: boolean;
};

export type SimplifiedActionPayload = {
  runId: string;
  projectId: string;
  nodeId: string;
  node: GraphNode;
  stage: 'ACTION' | 'SNAPSHOT';
  priorWorkspacePath?: string;
  snapshot?: SimplifiedSnapshotRequest;
  plan: SimplifiedRunPlan;
};

type Facts = Record<string, unknown> & { workspacePath?: string; snapshotReady?: boolean };

function versionOverride(value: unknown): GitRefValue {
  if (
    !value ||
    typeof value !== 'object' ||
    !('kind' in value) ||
    !('value' in value) ||
    !['BRANCH', 'COMMIT', 'TAG'].includes(String(value.kind)) ||
    typeof value.value !== 'string'
  )
    throw new BadRequestException('Git 版本应为分支、标签或完整 SHA');
  return value as GitRefValue;
}

@Injectable()
export class SimplifiedFlowRunService {
  private readonly logger = new Logger(SimplifiedFlowRunService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly workspaces: FlowWorkspaceService,
    private readonly metadata: RepositoryMetadataService,
    private readonly settings: SystemSettingsService,
    private readonly credentials: CredentialsService,
    private readonly servers: ServersService,
    private readonly builds: BuildsService,
    private readonly artifacts: ArtifactsService,
    private readonly physical: ArtifactPhysicalService,
    private readonly pipelines: PipelinesService,
  ) {}

  async plan(
    projectId: string,
    flow: GraphFlow,
    version: number,
    input: GraphInputsDto,
    trigger?: Record<string, unknown>,
    automation?: GraphAutomation,
  ) {
    const start = flow.nodes.find(({ type }) => type === 'START')!;
    const {
      sources = [],
      execution,
      environmentSetId,
      variables = [],
      dotenv,
      release,
    } = start.start ?? {};
    const configuredFinish = flow.nodes.find(({ type }) => type === 'END')?.finish ?? {};
    const finish: SimplifiedFinish = {
      ...configuredFinish,
      images: configuredFinish.images?.map((image) => ({
        ...image,
        name: simplifiedImageName(image.name)!,
      })),
    };
    const releaseNode = flow.nodes.find(
      ({ type }) => type === 'DEPLOY_ARTIFACT' || type === 'ROLLBACK_ARTIFACT',
    );
    const issue = (
      code: 'REPOSITORY' | 'BUILD_TARGET' | 'RELEASE_TARGET' | 'CONFIGURATION',
      fieldId: string,
      message: string,
    ) =>
      new ExecutionPlanIssueError({
        code,
        fieldId,
        message,
        nodeId: start.id,
        nodeName: start.name,
        flowId: flow.id,
      });
    const allowed = new Set([
      ...sources.filter((entry) => entry.allowRefOverride).map(({ id }) => 'git:' + id),
      ...variables
        .filter((entry) => entry.allowOverride && !entry.credentialId)
        .map(({ key }) => 'var:' + key),
      ...(release?.allowArtifactOverride ? ['artifactId'] : []),
    ]);
    const overrides = input.parameters ?? {};
    if (
      Object.keys(overrides).some((key) => !allowed.has(key)) ||
      Object.entries(input).some(
        ([key, value]) => value !== undefined && !['value', 'parameters'].includes(key),
      )
    )
      throw issue('CONFIGURATION', 'start', '请使用开始节点允许临时覆盖的运行参数');
    const useUpstreamArtifact =
      releaseNode && automation?.kind === 'UPSTREAM' && release?.useUpstreamArtifact;
    const upstreamArtifact = useUpstreamArtifact ? trigger?.upstreamArtifactId : undefined;
    const upstreamPending = useUpstreamArtifact && trigger?.upstreamArtifactPending === true;
    const artifact = releaseNode
      ? (upstreamArtifact ?? overrides.artifactId ?? release?.artifactId)
      : undefined;
    if (useUpstreamArtifact && !upstreamArtifact && !upstreamPending)
      throw issue('RELEASE_TARGET', 'release', '关联运行未提供可重发的已登记产物');
    if (
      artifact !== undefined &&
      (typeof artifact !== 'string' || !/^[0-9a-f-]{36}$/i.test(artifact))
    )
      throw issue('RELEASE_TARGET', 'release', '请选择有效的历史产物实例');
    const event = graphCheckoutEvent(trigger);
    const fixedSources = await Promise.all(
      sources.map(async (entry) => {
        if (!entry.repositoryId) throw issue('REPOSITORY', 'sources', '请选择项目仓库');
        const provided = overrides['git:' + entry.id];
        const ref = provided !== undefined ? versionOverride(provided) : entry.ref;
        const matchingEvent =
          event &&
          (trigger?.sourceId === entry.id ||
            (trigger?.sourceId === undefined &&
              sources.filter(({ repositoryId }) => repositoryId === event.repositoryId).length ===
                1 &&
              entry.repositoryId === event.repositoryId))
            ? event
            : undefined;
        try {
          const source = await this.metadata.planGraphCheckout(projectId, {
            repositoryId: entry.repositoryId,
            mode: ref?.kind ?? 'BRANCH',
            branch: ref?.kind === 'BRANCH' ? ref.value : undefined,
            tag: ref?.kind === 'TAG' ? ref.value : undefined,
            commitSha: ref?.kind === 'COMMIT' ? ref.value : undefined,
            event: matchingEvent,
          });
          return {
            id: entry.id,
            source,
            directory: simplifiedSourceDirectory(source.access.clone_url, entry.parentDirectory),
          };
        } catch (error) {
          throw issue(
            'REPOSITORY',
            'sources',
            error instanceof Error ? error.message : '无法解析 Git 来源',
          );
        }
      }),
    );
    if (
      fixedSources.some((a, index) =>
        fixedSources
          .slice(index + 1)
          .some(
            (b) =>
              a.directory === b.directory ||
              a.directory.startsWith(b.directory + '/') ||
              b.directory.startsWith(a.directory + '/'),
          ),
      )
    )
      throw issue('REPOSITORY', 'sources', '源码目录重名或互相包含');
    const defaults = await this.settings.get(projectId);
    const hasWorkspaceActions = flow.nodes.some(({ type }) =>
      ['CHECKOUT', 'BUILD', 'CHECK', 'SHELL'].includes(type),
    );
    const needsWorkspace = hasWorkspaceActions || Boolean(release?.reuseExecutionServer);
    const location =
      execution?.location && execution.location !== 'INHERIT'
        ? execution.location
        : defaults.defaultBuildLocation;
    let placement: FlowWorkspacePlacement = { location: 'MANAGER' };
    let buildSelection: DeploymentSelection | undefined;
    if (location === 'TARGET' && (needsWorkspace || execution?.serverId || execution?.groupId)) {
      const choice = execution?.serverId
        ? { serverIds: [execution.serverId] }
        : execution?.groupId
          ? { groupIds: [execution.groupId] }
          : undefined;
      if (!choice)
        throw issue('BUILD_TARGET', 'execution', '目标端运行需要选择一台构建服务器或分组');
      try {
        buildSelection = directDeploymentSelection(choice, 1)!;
        const ids = await selectedServerIds(this.database.db, buildSelection);
        if (ids.length !== 1) throw new BadRequestException('构建分组必须解析为一台服务器');
        const [target] = await this.servers.snapshot(ids);
        if (!target?.hostKeyFingerprint || !target.credentialId)
          throw new BadRequestException('构建服务器需要 SSH 凭据及已确认的指纹');
        placement = { location, target, root: defaults.targetWorkspaceRoot };
        if (automation) await assertAutomaticTargets(this.database.db, [target]);
      } catch (error) {
        throw issue(
          'BUILD_TARGET',
          'execution',
          error instanceof Error ? error.message : '无法解析构建位置',
        );
      }
    } else if (needsWorkspace && automation) {
      await BuildsService.automaticManagerSocket();
    }
    const selectedSet = environmentSetId
      ? await resolveEnvironmentSet(this.database.db, projectId, environmentSetId)
      : undefined;
    const environment = await this.freezeVariables(
      projectId,
      release?.serviceId,
      selectedSet,
      variables,
      overrides,
    );
    if (automation && (Object.keys(environment.secretVariables).length || dotenv))
      throw issue('CONFIGURATION', 'variables', '自动执行不能使用敏感变量或仓库变量文件');
    const dotenvSource = dotenv && fixedSources.find(({ id }) => id === dotenv.sourceId)?.source;
    const dotenvPin =
      dotenv && dotenvSource
        ? {
            repositoryId: dotenvSource.repositoryId,
            commitSha: dotenvSource.commitSha,
            path: normalizeRelativePath(dotenv.path),
          }
        : undefined;
    if (
      dotenv &&
      (!dotenvPin ||
        !(await this.metadata.inspectGraphEnvironmentFile(projectId, dotenvPin, [dotenvPin.path])))
    )
      throw issue('CONFIGURATION', 'dotenv', '已确认的源码缺少指定的变量文件');
    let fixedRelease: FixedRelease | undefined;
    if (releaseNode) {
      if (!release?.serviceId || !release.deployPath)
        throw issue('RELEASE_TARGET', 'release', '请选择项目服务并填写发布目录');
      const selection =
        release.reuseExecutionServer && placement.location === 'TARGET'
          ? { serverIds: [placement.target.id] }
          : release.reuseExecutionServer
            ? undefined
            : release.targets;
      const targets =
        selection && directDeploymentSelection(selection, defaults.defaultMaxParallelTargets);
      if (!targets) throw issue('RELEASE_TARGET', 'release', '请选择发布服务器或分组');
      if (releaseNode.type === 'ROLLBACK_ARTIFACT' && !artifact)
        throw issue('RELEASE_TARGET', 'release', '请选择已成功发布的回滚产物');
      if (
        !artifact &&
        !upstreamPending &&
        releaseNode.deploy?.method === 'COMPOSE' &&
        !simplifiedReleaseImage(finish, release)
      )
        throw issue(
          'CONFIGURATION',
          'start.release.imageId',
          '请在结束节点登记镜像，选择本次发布项后重新发布执行流',
        );
      if (
        !artifact &&
        !upstreamPending &&
        !hasWorkspaceActions &&
        releaseNode.deploy?.method !== 'COMPOSE'
      )
        throw issue('RELEASE_TARGET', 'release', '请指定已有产物或先配置生成发布内容的动作');
      fixedRelease = await this.planRelease({
        projectId,
        flow,
        version,
        node: releaseNode,
        release,
        environment,
        targets,
        sources: fixedSources,
        artifactId: artifact,
        automation,
        finish,
      });
      fixedRelease.profile.graphReleaseEnvironmentFile = dotenvPin;
      if (automation) await assertAutomaticTargets(this.database.db, fixedRelease.serverIds);
    }
    const plan: SimplifiedRunPlan = {
      placement,
      buildSelection,
      sources: fixedSources,
      serviceId: release?.serviceId,
      environment,
      dotenv: dotenvPin,
      finish,
      release: fixedRelease,
      automation,
      trigger,
      value: input.value === undefined ? undefined : redactTaskLog(input.value),
    };
    return { plan, selectedSet, environmentSet: environmentSetSummary(selectedSet) };
  }

  private async freezeVariables(
    projectId: string,
    serviceId: string | undefined,
    set: FrozenEnvironmentSet | undefined,
    entries: NonNullable<SimplifiedStart['variables']>,
    overrides: Record<string, unknown>,
  ): Promise<GraphVariableSnapshot> {
    const base = await this.pipelines.graphVariables(
      projectId,
      serviceId ?? graphUnscopedArtifactService(projectId).id,
      set,
    );
    const variables: Record<string, string> = Object.create(null);
    const secretVariables: Record<string, string> = Object.create(null);
    const secretCredentialNonces: Record<string, string> = Object.create(null);
    for (const { key, value, credentialId } of entries) {
      const supplied = overrides['var:' + key];
      if (credentialId) {
        const row = await this.database.db
          .selectFrom('credentials')
          .select('nonce')
          .where('id', '=', credentialId)
          .where('status', '=', 'ACTIVE')
          .where('type', 'in', ['API_KEY', 'API_SECRET', 'CUSTOM_SECRET', 'USERNAME_PASSWORD'])
          .executeTakeFirst();
        if (!row) throw new BadRequestException('流程变量的凭据不可用');
        secretVariables[key] = credentialId;
        secretCredentialNonces[key] = row.nonce;
      } else {
        const text = supplied ?? value ?? '';
        if (
          typeof text !== 'string' ||
          text.includes('\0') ||
          text.length > 65536 ||
          redactTaskLog(text) !== text
        )
          throw new BadRequestException('流程变量包含不支持的字符或明文凭据');
        variables[key] = text;
      }
    }
    const keys = new Set(entries.map(({ key }) => key));
    return {
      ...mergeGraphNodeEnvironment(base, { variables, secretVariables, secretCredentialNonces }),
      variableSources: [
        ...base.variableSources.filter(({ key }) => !keys.has(key)),
        ...entries.map(({ key, credentialId }) => ({
          key,
          source: 'NODE' as const,
          isSecret: Boolean(credentialId),
        })),
      ],
    };
  }

  private async planRelease(input: {
    projectId: string;
    flow: GraphFlow;
    version: number;
    node: GraphNode;
    release: NonNullable<SimplifiedStart['release']>;
    environment: GraphVariableSnapshot;
    targets: DeploymentSelection;
    sources: SimplifiedRunPlan['sources'];
    artifactId?: string;
    automation?: GraphAutomation;
    finish: SimplifiedFinish;
  }): Promise<FixedRelease> {
    const {
      projectId,
      flow,
      version,
      node,
      release,
      environment,
      targets,
      sources,
      artifactId,
      automation,
      finish,
    } = input;
    const serviceId = release.serviceId!;
    const environmentId = graphDeliveryEnvironment(projectId).id;
    const historical = artifactId
      ? await this.pipelines.deliveryArtifactBuild(projectId, serviceId, environmentId, [
          artifactId,
        ])
      : undefined;
    const method = node.deploy?.method ?? 'FILE';
    const image =
      method === 'COMPOSE' && !artifactId ? simplifiedReleaseImage(finish, release) : undefined;
    const path = normalizeRelativePath(release.contentPath || '.');
    const compose =
      release.compose?.sourceId && sources.find(({ id }) => id === release.compose!.sourceId);
    if (artifactId && release.compose && !compose)
      throw new BadRequestException('历史镜像只能使用归档配置或已确认的仓库 Compose 文件');
    const definition = Object.assign(new PipelineDefinitionDto(), {
      repositoryId:
        historical?.definition.repositoryId ??
        sources[0]?.source.repositoryId ??
        unversionedArtifactRepository,
      artifactType: method === 'FILE' ? 'FILE' : 'DOCKER_IMAGE',
      ...(method === 'COMPOSE' && {
        registryId: historical?.definition.registryId ?? image?.registryId,
      }),
      deployPath: release.deployPath,
      ...(node.deploy && {
        startCommand: node.deploy.startCommand,
        stopCommand: node.deploy.stopCommand,
        healthCheckCommand: node.deploy.healthCheckCommand,
        composeFilePath: node.deploy.composeFilePath,
      }),
    });
    const profile: DeliveryExecutionProfile = {
      ...deliveryExecutionProfile(
        projectId,
        serviceId,
        flow.id + ':' + node.id,
        version,
        node.name,
        definition,
        Object.keys(node.deploy ?? {}),
      ),
      graphVariables: environment,
      delivery:
        method === 'FILE'
          ? { method, artifactPath: path }
          : {
              method,
              composeSource: compose
                ? {
                    kind: 'REPOSITORY_FILE',
                    repositoryId: compose.source.repositoryId,
                    commitSha: compose.source.commitSha,
                    path: release.compose!.path,
                  }
                : { kind: 'ARTIFACT' },
            },
    };
    if (node.type === 'ROLLBACK_ARTIFACT') profile.delivery!.rollback = 'CURRENT';
    const selection = { ...targets, environmentId };
    const upcoming = await this.pipelines.previewArtifactDeployPlan(
      profile.id,
      {
        ...selection,
        commitSha:
          sources[0]?.source.commitSha ?? historical?.commitSha ?? unversionedArtifactCommit,
      },
      profile,
      automation,
    );
    const known = artifactId
      ? await this.pipelines.previewArtifactDeploy(
          profile.id,
          { ...selection, artifactIds: [artifactId] },
          profile,
          automation,
        )
      : undefined;
    return {
      nodeId: node.id,
      serviceId,
      targets,
      serverIds: upcoming.serverIds,
      artifactId,
      knownHash: known?.configurationHash,
      planHash: upcoming.configurationHash,
      deployPath: release.deployPath!,
      path,
      method,
      image: image && { id: image.id, name: image.name },
      profile,
      workspaceComposePath: method === 'COMPOSE' && !compose ? release.compose?.path : undefined,
      rollbackBaseline: upcoming.rollbackBaseline,
      requireApproval: upcoming.requireApproval,
      requireCodeReview: upcoming.requireCodeReview,
    };
  }

  async confirm(tx: Transaction<Database>, plan: SimplifiedRunPlan) {
    if (plan.placement.location === 'TARGET' && plan.buildSelection)
      await confirmDeploymentMembers(tx, plan.buildSelection, [plan.placement.target.id]);
    if (plan.release)
      await confirmDeploymentMembers(tx, plan.release.targets, plan.release.serverIds);
  }

  task(
    run: FlowRunIdentity,
    row: NodeRunIdentity,
    node: GraphNode,
    plan: SimplifiedRunPlan,
    stage: SimplifiedActionPayload['stage'],
    priorWorkspacePath?: string,
    snapshot?: SimplifiedSnapshotRequest,
  ): CreateTaskInput {
    const target = plan.placement.location === 'TARGET' ? plan.placement.target : undefined;
    const timeout =
      stage === 'SNAPSHOT' ? 600 : (node.build?.timeout ?? node.shell?.timeout ?? 1200);
    const payload: CreateTaskInput['payload'] = {
      simplifiedAction: {
        projectId: run.project_id,
        runId: run.id,
        nodeId: node.id,
        node,
        plan,
        stage,
        priorWorkspacePath,
        snapshot,
      },
      targets: target ? [target] : [],
      steps: [],
      strategy: 'SEQUENTIAL',
      maxParallel: 1,
      failurePolicy: 'STOP',
      timeout,
    };
    const serviceId = plan.serviceId ?? graphUnscopedArtifactService(run.project_id).id;
    const environmentId = graphDeliveryEnvironment(run.project_id).id;
    const task: CreateTaskInput = {
      type: 'GRAPH_MODULE',
      name: node.name + (stage === 'SNAPSHOT' ? ' · 固化交付' : ''),
      idempotencyKey: 'execution-flow:' + row.id + (stage === 'SNAPSHOT' ? ':snapshot' : ''),
      payload,
      scope: {
        projectId: run.project_id,
        serviceId: stage === 'SNAPSHOT' ? serviceId : plan.serviceId,
        environmentId,
      },
    };
    if (stage !== 'SNAPSHOT') return task;
    const actualSources = snapshot?.checkoutCompleted ? plan.sources : [];
    const source = actualSources[0]?.source;
    const commitSha = source?.commitSha ?? unversionedArtifactCommit;
    const definition = Object.assign(new PipelineDefinitionDto(), {
      repositoryId: source?.repositoryId ?? unversionedArtifactRepository,
      buildLocation: plan.placement.location,
      artifactType: 'FILE',
    });
    const profile = deliveryExecutionProfile(
      run.project_id,
      serviceId,
      run.id,
      run.version,
      task.name,
      definition,
      [],
    );
    const pipeline: PipelineSnapshot = {
      graph: { runId: run.id, rootRunId: run.id, nodeRunId: row.id },
      artifactSources: actualSources.map(({ source, directory }) => ({
        repositoryId: source.repositoryId,
        commitSha: source.commitSha,
        ref: source.ref,
        path: directory,
      })),
      runId: randomUUID(),
      pipelineId: profile.id,
      pipelineVersionId: profile.versionId,
      projectId: run.project_id,
      serviceId,
      environmentId,
      commitSha,
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
        gitRef: commitSha,
        commitSha,
        buildLocation: definition.buildLocation,
        artifactType: 'FILE',
      },
      payload: { ...payload, pipeline },
    };
  }

  async verifyTask(run: FlowRunIdentity, plan: SimplifiedRunPlan, tx: Transaction<Database>) {
    if (plan.placement.location === 'TARGET') {
      const target = plan.placement.target;
      const [current] = await this.servers.snapshot([target.id], tx);
      if (JSON.stringify(current) !== JSON.stringify(target))
        throw new ConflictException('构建服务器的 SSH 配置发生变化，请重新预览');
      if (plan.automation) await assertAutomaticTargets(tx, [target]);
    }
    if (plan.automation)
      await assertGraphAutomation(tx, run.project_id, run.created_by, plan.automation);
  }

  async execute(task: TaskRecord, context: TaskExecutionContext): Promise<Facts> {
    const placement = task.payload.simplifiedAction!.plan.placement;
    const target =
      placement.location === 'TARGET' ? await context.startTarget(placement.target.id) : undefined;
    try {
      const result = await this.executeAction(task, context);
      if (target) await context.finishTarget(target, 'SUCCESS', 0);
      return result;
    } catch (error) {
      if (
        target &&
        !context.signal.aborted &&
        !(error instanceof SshExecutionError && error.kind === 'NEEDS_ATTENTION')
      ) {
        await context.finishTarget(
          target,
          error instanceof SshExecutionError ? error.kind : 'FAILED',
          null,
          '工作区动作失败，详见任务日志',
        );
      }
      throw error;
    }
  }

  private async executeAction(task: TaskRecord, context: TaskExecutionContext): Promise<Facts> {
    const { runId, projectId, node, stage, plan, priorWorkspacePath, snapshot } =
      task.payload.simplifiedAction!;
    const requiresWorkspace =
      stage !== 'SNAPSHOT' ||
      snapshot?.workspace ||
      Boolean(priorWorkspacePath) ||
      (plan.release?.image &&
        snapshot?.imageIds.includes(plan.release.image.id) &&
        Boolean(plan.release.workspaceComposePath));
    if (!requiresWorkspace && snapshot) {
      await this.capture(this.captureSession(task, context, plan), plan, undefined, snapshot);
      return { snapshotReady: true, location: plan.placement.location };
    }
    const workspace = await this.workspaces.open(
      runId,
      plan.placement,
      context.signal,
      priorWorkspacePath,
    );
    if (!priorWorkspacePath) {
      const linked = await this.database.db
        .updateTable('execution_flow_runs')
        .set({ workspace_path: workspace.path })
        .where('id', '=', runId)
        .where((eb) =>
          eb.or([eb('workspace_path', 'is', null), eb('workspace_path', '=', workspace.path)]),
        )
        .returning('id')
        .executeTakeFirst();
      if (!linked) throw new ConflictException('运行的工作区位置已变化');
    }
    const facts: Facts = { workspacePath: workspace.path, location: plan.placement.location };
    if (stage === 'SNAPSHOT') {
      if (!snapshot) throw new ConflictException('缺少已确认的留档请求');
      await this.capture(this.captureSession(task, context, plan), plan, workspace.path, snapshot);
      return { ...facts, snapshotReady: true };
    }
    if (node.type === 'CHECKOUT') {
      const actual = await this.workspaces.checkout(
        workspace,
        projectId,
        plan.sources,
        context,
        node.checkout?.fullClone,
      );
      return { ...facts, sources: actual };
    }
    const { values, secrets } = await resolveExecutionVariables(this.credentials, plan.environment);
    const file = plan.dotenv
      ? await this.metadata.readGraphEnvironmentFile(projectId, plan.dotenv)
      : {};
    const environment = {
      values: {
        ...file,
        ...values,
        ...graphTriggerVariables(plan.trigger),
        VEYOPS_FLOW_RUN_ID: runId,
        [flowImageTagVariable]: flowImageTag(runId),
        VEYOPS_PROJECT_ID: projectId,
        ...(plan.serviceId && { VEYOPS_SERVICE_ID: plan.serviceId }),
        ...(plan.sources[0] && { VEYOPS_GIT_COMMIT_SHA: plan.sources[0].source.commitSha }),
      },
      secrets: [...secrets, ...Object.values(file).filter(Boolean)],
    };
    const directory = normalizeRelativePath(
      (node.type === 'BUILD' ? node.build?.repoPath : node.shell?.directory) || '.',
    );
    const commands =
      node.type === 'BUILD'
        ? [node.build?.installCommand, node.build?.buildCommand]
        : [node.shell?.command];
    for (const command of commands.filter((value): value is string => Boolean(value?.trim()))) {
      await this.workspaces.command(
        workspace,
        {
          taskId: task.id,
          directory,
          command,
          timeout: task.payload.timeout,
          variables: environment,
          image: node.build?.buildImage,
          automation: plan.automation,
        },
        context,
      );
    }
    const dockerfile = node.type === 'BUILD' && node.build?.dockerfilePath;
    if (dockerfile) {
      const reference = this.nativeImageReference(runId);
      const path = normalizeRelativePath(dockerfile);
      const target = plan.placement.location === 'TARGET' ? plan.placement.target : undefined;
      if (target) {
        const file = shellQuote(path);
        await this.workspaces.command(
          workspace,
          {
            taskId: task.id,
            directory,
            timeout: task.payload.timeout,
            command: `set -eu\nfile=$(realpath -e -- ${file})\ncase "$file" in "$PWD"/*) ;; *) exit 1 ;; esac\ntest -f "$file"\ndocker build --tag ${shellQuote(reference)} --file "$file" .`,
          },
          context,
        );
      } else
        await this.builds.buildFlowImage(
          { taskId: task.id, context, secrets: environment.secrets },
          workspace.path,
          directory,
          path,
          reference,
          task.payload.timeout,
          Boolean(plan.automation),
        );
      const image = await this.physical.describeImage({
        target,
        reference,
        owner: 'MANAGED',
        builderId: plan.automation ? 'manager-webhook' : 'manager',
        signal: context.signal,
      });
      if (!image.imageId) throw new ConflictException('Docker 构建未返回可验证的镜像 ID');
      return { ...facts, directory, exitCode: 0, imageId: image.imageId };
    }
    return { ...facts, directory, exitCode: 0 };
  }

  private nativeImageReference(runId: string) {
    return `veyops-build/${runId}:${unversionedArtifactCommit}-${runId}`;
  }

  private captureSession(
    task: TaskRecord,
    context: TaskExecutionContext,
    plan: SimplifiedRunPlan,
  ): BuildSession {
    return {
      taskId: task.id,
      context,
      variables: {},
      secrets: [],
      snapshot: { ...task.payload.pipeline!, graphAutomation: plan.automation },
    };
  }

  async cleanup(runId: string, plan: SimplifiedRunPlan, path: string) {
    await this.workspaces.cleanup({ runId, placement: plan.placement, path }).catch(() => {
      this.logger.warn(`执行流 ${runId} 的工作区清理失败`);
    });
  }

  private async capture(
    session: BuildSession,
    plan: SimplifiedRunPlan,
    workspace: string | undefined,
    capture: SimplifiedSnapshotRequest,
  ) {
    const { snapshot, context: ctx } = session;
    const target = plan.placement.location === 'TARGET' ? plan.placement.target : undefined;
    if (capture.workspace) {
      if (!workspace) throw new ConflictException('工作区快照缺少实际目录');
      const identity = artifactIdentity(snapshot, workspaceArtifact, target?.id);
      const dotenv = plan.dotenv;
      const dotenvPaths = dotenv
        ? plan.sources.flatMap(({ source, directory }) =>
            source.repositoryId === dotenv.repositoryId && source.commitSha === dotenv.commitSha
              ? [directory + '/' + dotenv.path]
              : [],
          )
        : [];
      const input = {
        workspace,
        relativePath: '.',
        kind: 'DIRECTORY' as const,
        collection: 'WORK_DIRECTORY' as const,
        excludePaths: [...(plan.finish.excludePaths ?? []), ...dotenvPaths],
        instanceId: identity.instanceId,
        signal: ctx.signal,
      };
      const physical = target
        ? await this.physical.collectServerPath({ ...input, target })
        : await this.physical.collectBuilderPath(input);
      let archive: { path: string; checksum: string; sizeBytes: number } | undefined;
      if (!target) {
        const root = join(dataDirectory, 'artifacts');
        await mkdir(root, { recursive: true, mode: 0o700 });
        const directory = await mkdtemp(join(root, '.flow-'));
        const path = join(root, identity.instanceId + '.tar.gz');
        try {
          const staged = join(directory, 'snapshot.tar.gz');
          await this.physical.stageBuilderArchive(physical, staged, '.', ctx.signal);
          await chmod(staged, 0o600);
          await link(staged, path).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          });
          const digest = await artifactPathDigest(path, 'FILE', ctx.signal);
          archive = { path, checksum: digest.sha256, sizeBytes: digest.sizeBytes };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      await this.artifacts.create(snapshot, {
        name: workspaceArtifact,
        kind: 'DIRECTORY',
        storageType: target ? 'REMOTE_FILE' : 'LOCAL_FILE',
        storageKey: archive?.path ?? physical.path!,
        serverId: target?.id,
        checksum: archive?.checksum ?? physical.sha256,
        sizeBytes: archive?.sizeBytes ?? physical.sizeBytes,
        physical,
        persist: workspaceRetention(plan.finish, true) === 'PERSISTENT',
      });
      ctx.log('工作区快照已校验并登记。\n', target?.id);
    }
    for (const id of capture.imageIds) {
      const image = plan.finish.images?.find((entry) => entry.id === id);
      if (!image) throw new ConflictException('留档请求引用了未确认的镜像登记项');
      try {
        await this.captureImage(session, plan, image, workspace, capture.expectedImageId);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const reason = error instanceof Error ? redactTaskLog(error.message) : '无法核对镜像实物';
        throw new ConflictException(`镜像「${image.name}」登记失败。${reason}`);
      }
    }
  }

  private async captureImage(
    session: BuildSession,
    plan: SimplifiedRunPlan,
    entry: NonNullable<SimplifiedFinish['images']>[number],
    workspace: string | undefined,
    expectedImageId?: string,
  ) {
    const { snapshot, context: ctx } = session;
    const target = plan.placement.location === 'TARGET' ? plan.placement.target : undefined;
    const runId = snapshot.graph!.runId;
    const identity = artifactIdentity(
      snapshot,
      entry.name,
      entry.source === 'REGISTRY' ? undefined : target?.id,
      entry.id,
    );
    if (await this.artifacts.requireFlowInstance(identity.instanceId, runId)) return;
    const composePath =
      plan.release?.image?.id === entry.id ? plan.release.workspaceComposePath : undefined;
    const composeYaml = composePath
      ? workspace &&
        (await this.builds.flowComposeSnapshot(session, workspace, composePath, target))
      : undefined;
    if (composePath && (!composeYaml || redactTaskLog(composeYaml) !== composeYaml))
      throw new BadRequestException('Compose 文件缺失或包含应使用凭据引用的内容');
    if (composeYaml) assertGraphCompose(composeYaml);
    if (entry.source === 'REGISTRY') {
      const reference = entry.reference!;
      const digest = reference.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
      if (!digest) throw new BadRequestException('Registry 镜像需要使用固定 Digest');
      const physical: ArtifactPhysical = {
        kind: 'DOCKER_IMAGE',
        location: 'REGISTRY',
        owner: 'EXTERNAL',
        registryId: entry.registryId,
        imageReference: reference,
        digest,
      };
      if ((await this.physical.verify(physical, undefined, ctx.signal)).status !== 'AVAILABLE')
        throw new ConflictException('Registry 无法验证指定的镜像 Digest');
      const registrySnapshot = {
        ...snapshot,
        definition: { ...snapshot.definition, registryId: entry.registryId },
      };
      await this.artifacts.create(
        registrySnapshot,
        {
          name: entry.name,
          kind: 'DOCKER_IMAGE',
          storageType: 'REGISTRY_IMAGE',
          storageKey: reference,
          imageReference: reference,
          imageDigest: digest,
          physical,
          composeYaml,
        },
        entry.id,
      );
      return;
    }
    const reference = `${entry.name}:${flowImageTag(runId)}`;
    if (entry.source === 'BUILT_IN' && !expectedImageId)
      throw new ConflictException('本次未取得内置 Docker 构建的镜像 ID');
    const image = await this.physical.describeFlowImage(
      reference,
      plan.automation ? 'manager-webhook' : 'manager',
      target,
      ctx.signal,
      entry.source === 'BUILT_IN'
        ? {
            reference: this.nativeImageReference(runId),
            id: expectedImageId!,
          }
        : undefined,
    );
    const archive = target
      ? undefined
      : await this.builds.archiveFlowImage(session, image.imageId!, reference, identity.instanceId);
    await this.artifacts.create(
      snapshot,
      {
        name: entry.name,
        kind: 'DOCKER_IMAGE',
        storageType: target ? 'REMOTE_IMAGE' : 'LOCAL_IMAGE',
        storageKey: archive?.imageReference ?? image.imageReference!,
        imageReference: archive?.imageReference ?? image.imageReference,
        imageId: image.imageId,
        serverId: target?.id,
        physical: target ? image : undefined,
        composeYaml,
        archiveKey: archive?.archiveKey,
        checksum: archive?.checksum,
        sizeBytes: archive?.sizeBytes,
      },
      entry.id,
    );
    ctx.log(`镜像 ${reference} 已校验并登记。\n`, target?.id);
  }

  private artifactRows(db: Kysely<Database>, runId: string, includeInactive = false) {
    return db
      .selectFrom('artifacts')
      .selectAll()
      .where('graph_run_id', '=', runId)
      .$if(!includeInactive, (query) => query.where('lifecycle_state', '=', 'ACTIVE'));
  }

  async snapshotArtifacts(db: Kysely<Database>, runId: string, includeInactive = false) {
    return this.artifactRows(db, runId, includeInactive).orderBy('artifact_name').execute();
  }

  private async releaseArtifact(db: Kysely<Database>, runId: string, release: FixedRelease) {
    return release.artifactId
      ? db
          .selectFrom('artifacts')
          .selectAll()
          .where('id', '=', release.artifactId)
          .where('service_id', '=', release.serviceId)
          .where('temporary_root_id', 'is', null)
          .where('lifecycle_state', '=', 'ACTIVE')
          .executeTakeFirst()
      : release.method === 'COMPOSE' && !release.image
        ? undefined
        : this.artifactRows(db, runId)
            .where('artifact_type', '=', release.method === 'FILE' ? 'FILE' : 'DOCKER_IMAGE')
            .where(
              'artifact_name',
              '=',
              release.method === 'FILE' ? workspaceArtifact : release.image!.name,
            )
            .executeTakeFirst();
  }

  async releaseScope(
    db: Kysely<Database>,
    runId: string,
    release: FixedRelease,
  ): Promise<Extract<GraphGateScope, { kind: 'RELEASE' }>> {
    const artifact = await this.releaseArtifact(db, runId, release);
    if (!artifact) throw new ConflictException('当前发布缺少已确认的交付产物');
    return {
      kind: 'RELEASE',
      releaseNodeId: release.nodeId,
      serviceId: release.serviceId,
      artifactIds: [artifact.id],
      artifactFingerprints: [deploymentFingerprint(artifact)],
      serverIds: [...release.serverIds].sort(),
      rollbackBaseline: release.rollbackBaseline,
    };
  }

  async deploy(
    run: FlowRunIdentity,
    row: NodeRunIdentity,
    plan: SimplifiedRunPlan,
    afterInsert: (tx: Transaction<Database>, id: string) => Promise<void>,
  ) {
    const release = plan.release!;
    const scope = await this.releaseScope(this.database.db, run.id, release);
    const profile = { ...release.profile, artifactRootRunId: run.id };
    const input = {
      ...release.targets,
      environmentId: graphDeliveryEnvironment(run.project_id).id,
      artifactIds: scope.artifactIds,
    };
    const checked = await this.pipelines.previewArtifactDeploy(
      profile.id,
      input,
      profile,
      plan.automation,
    );
    if (
      !sameIds(checked.serverIds, release.serverIds) ||
      (release.knownHash && checked.configurationHash !== release.knownHash)
    )
      throw new ConflictException('发布目标或已确认的交付实物发生变化，请重新预览');
    const gates = await this.database.db
      .selectFrom('execution_node_runs')
      .select(['node_id', 'node_type', 'output_json'])
      .where('run_id', '=', run.id)
      .where('status', '=', 'SUCCESS')
      .where('node_type', 'in', ['APPROVAL', 'SOURCE_REVIEW'])
      .execute();
    const approved = gates.flatMap(({ node_id, node_type, output_json }) => {
      const decision = JSON.parse(output_json ?? '{}') as GraphGateDecision;
      if (
        decision.decision !== 'APPROVE' ||
        !decision.actorId ||
        !decision.scopeHash ||
        !decision.scope ||
        decision.scopeHash !==
          graphGateHash(run.id, node_id, run.configuration_hash, decision.scope)
      )
        return [];
      if (
        node_type === 'APPROVAL' &&
        decision.scopeHash !== graphGateHash(run.id, node_id, run.configuration_hash, scope)
      )
        return [];
      return [
        { type: node_type, nodeId: node_id, actorId: decision.actorId, hash: decision.scopeHash },
      ];
    });
    const approval = approved.find(({ type }) => type === 'APPROVAL');
    const review = approved.find(({ type }) => type === 'SOURCE_REVIEW');
    const hasApproval = gates.some(({ node_type }) => node_type === 'APPROVAL');
    if ((release.requireApproval || release.rollbackBaseline || hasApproval) && !approval)
      throw new ConflictException('发布或回滚需要有效的产物审批');
    if (release.requireCodeReview && !review) throw new ConflictException('发布需要有效的源码审核');
    await this.pipelines.deployArtifact(
      profile.id,
      {
        ...input,
        confirmed: true,
        expectedServerIds: release.serverIds,
        expectedConfigurationHash: checked.configurationHash,
      },
      run.created_by,
      {
        idempotencyKey: 'execution-flow:' + row.id,
        profile,
        graphAutomation: plan.automation,
        expectedPlanHash: release.planHash,
        rollbackExpected: release.rollbackBaseline,
        graphGate: { runId: run.id, nodeId: row.node_id, approval, review },
        afterInsert,
      },
    );
  }
}
