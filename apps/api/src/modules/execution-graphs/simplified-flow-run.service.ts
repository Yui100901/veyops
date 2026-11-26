import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import type { Kysely, Transaction } from 'kysely';
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
import {
  ArtifactsService,
  deploymentFingerprint,
  type HistoricalWorkspace,
} from '../artifacts/artifacts.service';
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
import type { GraphInputsDto } from './graph-runner.controller';
import {
  graphGateHash,
  sameIds,
  type GraphGateDecision,
  type GraphGateScope,
} from './graph-release-gates';
import {
  simplifiedEffectiveFinish,
  simplifiedComposeImageVariable,
  simplifiedImageName,
  simplifiedReleaseImages,
  legacySimplifiedSourceDirectory,
  simplifiedUsesWorkspace,
  simplifiedWorkspaceInput,
  type SimplifiedFinish,
  type SimplifiedStart,
  type HistoricalSimplifiedExecution,
  type HistoricalSimplifiedRelease,
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
  images?: { id: string; name: string }[];
  path: string;
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
  workspaceSource?: HistoricalWorkspace & { fingerprint: string };
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
  expectedImageIds?: Record<string, string>;
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

function releaseImageEntries(release?: FixedRelease) {
  return release?.images ?? (release?.image ? [release.image] : []);
}

function assertSingleReleaseServer(plan: SimplifiedRunPlan) {
  if (
    plan.release &&
    (plan.placement.location !== 'TARGET' ||
      !sameIds(plan.release.serverIds, [plan.placement.target.id]) ||
      !sameIds(plan.release.targets.serverIds, [plan.placement.target.id]) ||
      plan.release.targets.groupIds.length)
  )
    throw new ConflictException('构建与发布必须使用同一台执行服务器，请重新发布执行流');
}

export function publicWorkspaceSource(plan: SimplifiedRunPlan) {
  const source = plan.workspaceSource;
  return source
    ? {
        kind: source.kind,
        artifactId: source.artifactId,
        runId: source.runId,
        createdAt: source.createdAt,
        sizeBytes: source.sizeBytes,
        serverId: source.serverId,
        sources: source.sources,
      }
    : { kind: 'NEW' as const };
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
    const releaseNode = flow.nodes.find(
      ({ type }) => type === 'DEPLOY_ARTIFACT' || type === 'ROLLBACK_ARTIFACT',
    );
    // Published definitions can still contain these fields. Draft writes use the current DTO.
    const legacyRelease = release as HistoricalSimplifiedRelease | undefined;
    const legacyExecution = execution as HistoricalSimplifiedExecution | undefined;
    const workspaceInput = simplifiedWorkspaceInput(flow);
    const issue = (
      code: 'REPOSITORY' | 'BUILD_TARGET' | 'RELEASE_TARGET' | 'CONFIGURATION' | 'ARTIFACT',
      fieldId: string,
      message: string,
    ) =>
      new ExecutionPlanIssueError({
        code,
        fieldId,
        parameterId:
          code === 'ARTIFACT'
            ? fieldId === 'workspaceArtifactId'
              ? fieldId
              : 'artifactId'
            : undefined,
        message,
        nodeId: start.id,
        nodeName: start.name,
        flowId: flow.id,
      });
    const requiresArtifact = release?.artifactSource === 'RUN_PARAMETER';
    const allowed = new Set([
      ...variables
        .filter((entry) => entry.allowOverride && !entry.credentialId)
        .map(({ key }) => 'var:' + key),
      ...(requiresArtifact || release?.allowArtifactOverride ? ['artifactId'] : []),
      ...(workspaceInput && !automation ? ['workspaceArtifactId'] : []),
    ]);
    const overrides = input.parameters ?? {};
    if (Object.keys(overrides).some((key) => key.startsWith('git:')))
      throw issue(
        'CONFIGURATION',
        'sources',
        'Git 版本由已发布的开始节点配置，请调整草稿后重新发布',
      );
    if (overrides.workspaceArtifactId !== undefined && (!workspaceInput || automation))
      throw issue('ARTIFACT', 'workspaceArtifactId', '此入口仅支持手动从历史目录构建');
    if (
      Object.keys(overrides).some((key) => !allowed.has(key)) ||
      Object.entries(input).some(
        ([key, value]) => value !== undefined && !['value', 'parameters'].includes(key),
      )
    )
      throw issue('CONFIGURATION', 'start', '请使用开始节点允许临时覆盖的运行参数');
    if (workspaceInput?.required && overrides.workspaceArtifactId === undefined)
      throw issue(
        'ARTIFACT',
        'workspaceArtifactId',
        '请选择当前项目的历史执行目录。没有可选目录时，请先运行可生成目录产物的构建',
      );
    const historical = overrides.workspaceArtifactId;
    if (historical !== undefined && (typeof historical !== 'string' || !isUUID(historical)))
      throw issue('ARTIFACT', 'workspaceArtifactId', '请选择有效的历史目录实例');
    const workspaceSource =
      historical === undefined
        ? undefined
        : await this.artifacts
            .planHistoricalWorkspace(projectId, historical)
            .catch((error: unknown) => {
              throw issue(
                'ARTIFACT',
                'workspaceArtifactId',
                error instanceof Error ? error.message : '无法核对历史目录',
              );
            });
    const useUpstreamArtifact =
      releaseNode && automation?.kind === 'UPSTREAM' && release?.useUpstreamArtifact;
    const upstreamArtifact = useUpstreamArtifact ? trigger?.upstreamArtifactId : undefined;
    const upstreamPending = useUpstreamArtifact && trigger?.upstreamArtifactPending === true;
    const artifact = releaseNode
      ? (upstreamArtifact ?? overrides.artifactId ?? release?.artifactId)
      : undefined;
    if (useUpstreamArtifact && !upstreamArtifact && !upstreamPending)
      throw issue('RELEASE_TARGET', 'release', '关联运行未提供可重发的已登记产物');
    if (requiresArtifact && overrides.artifactId === undefined)
      throw issue('ARTIFACT', 'artifact', '请选择该服务的历史产物。没有可选产物时，请先运行构建');
    if (artifact !== undefined && (typeof artifact !== 'string' || !isUUID(artifact)))
      throw issue('ARTIFACT', 'artifact', '请选择有效的历史产物实例');
    const configuredFinish = simplifiedEffectiveFinish(
      flow.nodes,
      flow.nodes.find(({ type }) => type === 'END')?.finish ?? {},
      Boolean(artifact || upstreamPending),
    );
    const dockerBuilds = flow.nodes.filter(
      ({ type, build }) => type === 'BUILD' && build?.dockerfilePath,
    );
    const finish: SimplifiedFinish = {
      ...configuredFinish,
      images: configuredFinish.images?.map((image) => ({
        ...image,
        name: simplifiedImageName(image.name)!,
        ...(image.source === 'BUILT_IN' && !image.buildNodeId && dockerBuilds.length === 1
          ? { buildNodeId: dockerBuilds[0]!.id }
          : {}),
      })),
    };
    const event = graphCheckoutEvent(trigger);
    const fixedSources = await Promise.all(
      (workspaceSource ? [] : sources).map(async (entry) => {
        if (!entry.repositoryId) throw issue('REPOSITORY', 'sources', '请选择项目仓库');
        const ref = entry.ref;
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
            directory: legacySimplifiedSourceDirectory(
              source.access.clone_url,
              (entry as typeof entry & { parentDirectory?: string }).parentDirectory ?? '.',
            ),
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
    const { slug: projectSlug } = await this.database.db
      .selectFrom('projects')
      .select('slug')
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    const hasWorkspaceActions = simplifiedUsesWorkspace(flow.nodes);
    const previousTargets = legacyRelease?.targets;
    const previousServerId =
      previousTargets?.serverIds?.length === 1 && !previousTargets.groupIds?.length
        ? previousTargets.serverIds[0]
        : undefined;
    const serverId = execution?.serverId ?? (!hasWorkspaceActions ? previousServerId : undefined);
    if (
      !serverId ||
      legacyExecution?.location === 'MANAGER' ||
      legacyExecution?.groupId ||
      (previousTargets && previousServerId !== serverId)
    ) {
      throw issue(
        'BUILD_TARGET',
        'start.execution.serverId',
        '请选择唯一的执行服务器并重新发布执行流。跨服务器交付请拆成两条依赖链。',
      );
    }
    const buildSelection = directDeploymentSelection({ serverIds: [serverId] }, 1)!;
    let placement: FlowWorkspacePlacement;
    try {
      const ids = await selectedServerIds(this.database.db, buildSelection);
      const [target] = await this.servers.snapshot(ids);
      if (!target?.hostKeyFingerprint || !target.credentialId)
        throw new BadRequestException('执行服务器需要 SSH 凭据及已确认的指纹');
      placement = { location: 'TARGET', target, root: defaults.targetWorkspaceRoot, projectSlug };
      if (automation && (hasWorkspaceActions || releaseNode))
        await assertAutomaticTargets(this.database.db, [target]);
    } catch (error) {
      throw issue(
        'BUILD_TARGET',
        'start.execution.serverId',
        error instanceof Error ? error.message : '无法解析执行服务器',
      );
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
    let dotenvSource: Pick<FlowCheckout['source'], 'repositoryId' | 'commitSha'> | undefined =
      dotenv && fixedSources.find(({ id }) => id === dotenv.sourceId)?.source;
    if (dotenv && workspaceSource) {
      const configured = sources.find(({ id }) => id === dotenv.sourceId);
      const matches = workspaceSource.sources.filter(
        ({ repositoryId }) => repositoryId === configured?.repositoryId,
      );
      if (matches.length !== 1)
        throw issue(
          'ARTIFACT',
          'workspaceArtifactId',
          '所选历史目录不能唯一定位变量文件对应的仓库和提交',
        );
      dotenvSource = matches[0];
    }
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
      throw workspaceSource
        ? issue('ARTIFACT', 'workspaceArtifactId', '所选历史目录的固定源码缺少指定的变量文件')
        : issue('CONFIGURATION', 'dotenv', '已确认的源码缺少指定的变量文件');
    let fixedRelease: FixedRelease | undefined;
    if (releaseNode) {
      if (!release?.serviceId) throw issue('RELEASE_TARGET', 'release', '请选择项目服务');
      if (releaseNode.type === 'ROLLBACK_ARTIFACT' && !artifact)
        throw issue('RELEASE_TARGET', 'release', '请选择已成功发布的回滚产物');
      if (
        !artifact &&
        !upstreamPending &&
        releaseNode.deploy?.method === 'COMPOSE' &&
        !simplifiedReleaseImages(finish, release).length
      )
        throw issue(
          'CONFIGURATION',
          'start.release.imageIds',
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
        projectWorkspace: `${defaults.targetWorkspaceRoot}/${projectSlug}`,
        environment,
        targets: buildSelection,
        sources: fixedSources,
        artifactId: artifact,
        automation,
        finish,
      });
      fixedRelease.profile.graphReleaseEnvironmentFile = dotenvPin;
    }
    const plan: SimplifiedRunPlan = {
      placement,
      buildSelection,
      sources: fixedSources,
      workspaceSource,
      serviceId: release?.serviceId,
      environment,
      dotenv: dotenvPin,
      finish,
      release: fixedRelease,
      automation,
      trigger,
      value: input.value === undefined ? undefined : redactTaskLog(input.value),
    };
    assertSingleReleaseServer(plan);
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
    projectWorkspace: string;
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
      projectWorkspace,
      environment,
      targets,
      sources,
      artifactId,
      automation,
      finish,
    } = input;
    const serviceId = release.serviceId!;
    const deployPath = `${projectWorkspace}/.deployments/${serviceId}`;
    const environmentId = graphDeliveryEnvironment(projectId).id;
    const historical = artifactId
      ? await this.pipelines.deliveryArtifactBuild(projectId, serviceId, environmentId, [
          artifactId,
        ])
      : undefined;
    const method = node.deploy?.method ?? 'FILE';
    const images =
      method === 'COMPOSE' && !artifactId ? simplifiedReleaseImages(finish, release) : [];
    const image = images.length === 1 ? images[0] : undefined;
    const path = normalizeRelativePath((release as HistoricalSimplifiedRelease).contentPath || '.');
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
      deployPath,
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
              ...(images.length > 1 && {
                imageBindings: Object.fromEntries(
                  images.map(({ id, name }) => [simplifiedComposeImageVariable(id), name]),
                ),
              }),
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
      path,
      method,
      image: image && { id: image.id, name: image.name },
      ...(images.length > 1 && { images: images.map(({ id, name }) => ({ id, name })) }),
      profile,
      workspaceComposePath:
        method === 'COMPOSE' && !artifactId && !compose
          ? (release.compose?.path ?? image?.composePath)
          : undefined,
      rollbackBaseline: upcoming.rollbackBaseline,
      requireApproval: upcoming.requireApproval,
      requireCodeReview: upcoming.requireCodeReview,
    };
  }

  async confirm(tx: Transaction<Database>, plan: SimplifiedRunPlan, projectId: string) {
    assertSingleReleaseServer(plan);
    if (plan.placement.location === 'TARGET' && plan.buildSelection)
      await confirmDeploymentMembers(tx, plan.buildSelection, [plan.placement.target.id]);
    if (plan.release)
      await confirmDeploymentMembers(tx, plan.release.targets, plan.release.serverIds);
    if (plan.workspaceSource)
      await this.artifacts.confirmHistoricalWorkspace(tx, projectId, plan.workspaceSource);
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
    const actualSources = plan.workspaceSource
      ? plan.workspaceSource.sources.map(({ checkoutPath, ...source }) => ({
          ...source,
          path: checkoutPath,
        }))
      : (snapshot?.checkoutCompleted ? plan.sources : []).map(({ source, directory }) => ({
          repositoryId: source.repositoryId,
          commitSha: source.commitSha,
          ref: source.ref,
          path: directory,
        }));
    const source = actualSources[0];
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
      artifactSources: actualSources,
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
    if (plan.placement.location !== 'TARGET')
      throw new ConflictException('请选择目标服务器并重新发布执行流');
    assertSingleReleaseServer(plan);
    const requiresWorkspace =
      stage !== 'SNAPSHOT' ||
      snapshot?.workspace ||
      Boolean(priorWorkspacePath) ||
      plan.finish.images?.some(
        (image) => Boolean(image.composePath) && snapshot?.imageIds.includes(image.id),
      ) ||
      (releaseImageEntries(plan.release).some(({ id }) => snapshot?.imageIds.includes(id)) &&
        Boolean(plan.release?.workspaceComposePath));
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
    if (plan.workspaceSource && stage === 'ACTION') {
      const historical = plan.workspaceSource;
      try {
        await this.workspaces.restore(workspace, historical.fingerprint, context, (archive) =>
          this.artifacts.stageHistoricalWorkspace(projectId, historical, archive, context.signal),
        );
      } catch (error) {
        if (context.signal.aborted || error instanceof SshExecutionError) throw error;
        throw new ExecutionPlanIssueError({
          code: 'ARTIFACT',
          fieldId: 'workspaceArtifactId',
          parameterId: 'workspaceArtifactId',
          message: error instanceof Error ? error.message : '无法还原已确认的历史目录',
        });
      }
      facts.workspaceArtifactId = historical.artifactId;
    }
    if (stage === 'SNAPSHOT') {
      if (!snapshot) throw new ConflictException('缺少已确认的留档请求');
      await this.capture(this.captureSession(task, context, plan), plan, workspace.path, snapshot);
      return { ...facts, snapshotReady: true };
    }
    if (node.type === 'CHECKOUT') {
      if (plan.workspaceSource) {
        context.log(
          '历史工作区已准备，跳过 Git 拉取。\n',
          plan.placement.location === 'TARGET' ? plan.placement.target.id : undefined,
        );
        return { ...facts, checkoutSkipped: 'HISTORICAL_WORKSPACE' };
      }
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
    const sourceCommit =
      plan.sources[0]?.source.commitSha ?? plan.workspaceSource?.sources[0]?.commitSha;
    const environment = {
      values: {
        ...file,
        ...values,
        ...graphTriggerVariables(plan.trigger),
        VEYOPS_FLOW_RUN_ID: runId,
        [flowImageTagVariable]: flowImageTag(runId),
        VEYOPS_PROJECT_ID: projectId,
        ...(plan.serviceId && { VEYOPS_SERVICE_ID: plan.serviceId }),
        ...(sourceCommit && { VEYOPS_GIT_COMMIT_SHA: sourceCommit }),
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
      const reference = this.nativeImageReference(runId, node.id);
      const path = normalizeRelativePath(dockerfile);
      const target = plan.placement.target;
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

  private nativeImageReference(runId: string, nodeId?: string) {
    const hex = nodeId && createHash('sha256').update(nodeId).digest('hex');
    const partition = hex
      ? '/' +
        [
          hex.slice(0, 8),
          hex.slice(8, 12),
          '8' + hex.slice(13, 16),
          'a' + hex.slice(17, 20),
          hex.slice(20, 32),
        ].join('-')
      : '';
    return `veyops-build/${runId}${partition}:${unversionedArtifactCommit}-${runId}`;
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
    const retained = await this.database.db
      .selectFrom('artifacts')
      .select('id')
      .where('graph_run_id', '=', runId)
      .where('artifact_name', '=', workspaceArtifact)
      .where('pruned_at', 'is', null)
      .executeTakeFirst();
    if (retained) return;
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
    if (plan.placement.location !== 'TARGET')
      throw new ConflictException('请选择目标服务器并重新发布执行流');
    const target = plan.placement.target;
    if (capture.workspace) {
      if (!workspace) throw new ConflictException('工作区快照缺少实际目录');
      const dotenv = plan.dotenv;
      const dotenvPaths = dotenv
        ? (snapshot.artifactSources ?? []).flatMap(({ repositoryId, commitSha, path }) =>
            path && repositoryId === dotenv.repositoryId && commitSha === dotenv.commitSha
              ? [path + '/' + dotenv.path]
              : [],
          )
        : [];
      const physical = await this.physical.retainFlowWorkspace({
        workspace: { runId: snapshot.graph!.runId, placement: plan.placement, path: workspace },
        excludePaths: dotenvPaths,
        signal: ctx.signal,
      });
      await this.artifacts.create(snapshot, {
        name: workspaceArtifact,
        kind: 'DIRECTORY',
        storageType: 'REMOTE_FILE',
        storageKey: physical.path!,
        serverId: target.id,
        checksum: physical.sha256,
        sizeBytes: physical.sizeBytes,
        physical,
        persist: workspaceRetention(plan.finish, true) === 'PERSISTENT',
      });
      ctx.log('执行目录已校验并登记为产物。\n', target.id);
    }
    for (const id of capture.imageIds) {
      const image = plan.finish.images?.find((entry) => entry.id === id);
      if (!image) throw new ConflictException('留档请求引用了未确认的镜像登记项');
      try {
        await this.captureImage(
          session,
          plan,
          image,
          workspace,
          image.buildNodeId && capture.expectedImageIds
            ? capture.expectedImageIds[image.buildNodeId]
            : capture.expectedImageId,
        );
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
    if (plan.placement.location !== 'TARGET')
      throw new ConflictException('请选择目标服务器并重新发布执行流');
    const target = plan.placement.target;
    const runId = snapshot.graph!.runId;
    const identity = artifactIdentity(
      snapshot,
      entry.name,
      entry.source === 'REGISTRY' ? undefined : target.id,
      entry.id,
    );
    if (await this.artifacts.requireFlowInstance(identity.instanceId, runId)) return;
    const releaseImage = releaseImageEntries(plan.release).some(({ id }) => id === entry.id);
    const releaseComposePath = releaseImage ? plan.release?.workspaceComposePath : undefined;
    const composePath = releaseComposePath ?? entry.composePath;
    const composeYaml = composePath
      ? workspace &&
        (await this.builds.flowComposeSnapshot(session, workspace, composePath, target))
      : undefined;
    if (composePath && (!composeYaml || redactTaskLog(composeYaml) !== composeYaml))
      throw new BadRequestException('Compose 文件缺失或包含应使用凭据引用的内容');
    if (composeYaml)
      assertGraphCompose(
        composeYaml,
        releaseComposePath ? plan.release?.profile.delivery?.imageBindings : undefined,
      );
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
            reference: this.nativeImageReference(runId, entry.buildNodeId),
            id: expectedImageId!,
          }
        : undefined,
    );
    await this.artifacts.create(
      snapshot,
      {
        name: entry.name,
        kind: 'DOCKER_IMAGE',
        storageType: 'REMOTE_IMAGE',
        storageKey: image.imageReference!,
        imageReference: image.imageReference,
        imageId: image.imageId,
        serverId: target.id,
        physical: image,
        composeYaml,
      },
      entry.id,
    );
    ctx.log(`镜像 ${reference} 已校验并登记。\n`, target.id);
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

  private async releaseArtifacts(db: Kysely<Database>, runId: string, release: FixedRelease) {
    const names =
      release.method === 'FILE'
        ? [workspaceArtifact]
        : releaseImageEntries(release).map(({ name }) => name);
    return release.artifactId
      ? db
          .selectFrom('artifacts')
          .selectAll()
          .where('id', '=', release.artifactId)
          .where('service_id', '=', release.serviceId)
          .where('temporary_root_id', 'is', null)
          .where('lifecycle_state', '=', 'ACTIVE')
          .execute()
      : !names.length
        ? []
        : this.artifactRows(db, runId)
            .where('artifact_type', '=', release.method === 'FILE' ? 'FILE' : 'DOCKER_IMAGE')
            .where('artifact_name', 'in', names)
            .orderBy('artifact_name')
            .execute();
  }

  async releaseScope(
    db: Kysely<Database>,
    runId: string,
    release: FixedRelease,
  ): Promise<Extract<GraphGateScope, { kind: 'RELEASE' }>> {
    const artifacts = await this.releaseArtifacts(db, runId, release);
    const expected =
      release.artifactId || release.method === 'FILE' ? 1 : releaseImageEntries(release).length;
    if (!expected || artifacts.length !== expected)
      throw new ConflictException('当前发布缺少已确认的交付产物');
    return {
      kind: 'RELEASE',
      releaseNodeId: release.nodeId,
      serviceId: release.serviceId,
      artifactIds: artifacts.map(({ id }) => id),
      artifactFingerprints: artifacts.map(deploymentFingerprint),
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
    assertSingleReleaseServer(plan);
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
