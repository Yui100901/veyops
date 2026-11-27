import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import { encryptionKey } from '../../core/config';
import type { Database } from '../../core/database/schema';
import { ExecutionPlanIssueError, type ExecutionPlanIssue } from '../../core/execution-plan-issue';
import type { ExecutionVariables } from '../../infrastructure/execution-variables';
import { AuditService } from '../audit/audit.service';
import { lockAvailableArtifacts } from '../artifacts/artifact-availability';
import { artifactSourceRef } from '../artifacts/artifact-sources';
import { archivedComposeTemplate, deploymentFingerprint } from '../artifacts/artifacts.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { PipelineDefinitionDto } from '../pipelines/pipeline.dto';
import { unhealthyGraphProbeExitCode } from '../pipelines/graph-release-health';
import type { PipelineDefinition } from '../pipelines/pipeline.types';
import {
  deliveryExecutionProfile,
  ensureGraphDeliveryEnvironment,
  ensureGraphUnscopedArtifactService,
  graphDeliveryEnvironment,
  graphUnscopedArtifactService,
  type DeliveryExecutionProfile,
} from '../pipelines/delivery-execution-profile';
import { pendingReleaseApprovalTime } from '../deployments/release-policy';
import { SourceReviewConflict } from '../deployments/release-source-policy';
import type { ComposeTemplateReference } from '../service-configs/compose-template-reference';
import type { SourceReviewProof } from '../deployments/source-review.service';
import { lockProjectGraph, requireProject } from '../projects/project-guards';
import { runResourceReferences } from '../projects/project-resource-references';
import { unavailableReference } from '../projects/project-resource-protection';
import { defaultServerConcurrency, SystemSettingsService } from '../system/system-settings.service';
import { canAdmitServerWork, nextServerWorkOrder } from '../tasks/server-execution-queue';
import {
  confirmDeploymentMembers,
  directDeploymentSelection,
  selectedServerIds,
} from '../deployment-targets/deployment-selection';
import { RepositoryMetadataService } from '../projects/repository-metadata.service';
import { resolveGraphRepositorySelector } from '../projects/graph-repository-selectors';
import { graphRepositoryUrl } from '../projects/http-clone-url';
import {
  resolveEnvironmentSet,
  type EnvironmentSetSummary,
  type FrozenEnvironmentSet,
} from '../projects/environment-sets.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { TasksService } from '../tasks/tasks.service';
import { terminalTaskStatuses, type TaskPayload } from '../tasks/tasks.types';
import { redactTaskLog } from '../tasks/task-log.service';
import { variableCredentialType } from '../credentials/credentials.service';
import {
  defaultApprovalSeconds,
  orderedFlowNodes,
  type GraphDefinition,
  type GraphFlow,
  type GraphNode,
} from './execution-graph-definition';
import type {
  GraphInputsDto,
  GraphPreviewDto,
  GraphRunDefaultsDto,
  GraphRunDto,
} from './graph-runner.controller';
import { graphInputIssue, withNodePlanIssue, withPlanIssue } from './graph-execution-plan-issues';
import {
  GraphNodeTasks,
  graphCheckoutFetchMode,
  graphCheckoutOutputs,
  type GraphNodePlan,
  type GraphNodeScope,
} from './graph-node-tasks';
import { latestReleaseInspections } from './graph-release-inspection.service';
import { ScriptWorkspacePreview } from './graph-script-workspaces';
import {
  assertAutomaticGraphFlow,
  assertAutomaticTargets,
  assertGraphAutomation,
  graphCheckoutEvent,
  graphNodeRequiresIsolation,
  isGraphTriggerKind,
  type GraphAutomation,
} from './graph-automatic-delivery';
import {
  graphVariableSources,
  environmentSetSummary,
  publicEnvironmentFile,
  type GraphEnvironmentPlan,
  type GraphVariableSource,
} from './graph-environment';
import {
  unversionedArtifactCommit,
  unversionedArtifactRepository,
  type GraphEnvironmentRef,
  type GraphWorkspaceRef,
} from './graph-workspace';
import {
  graphArtifactDeclarations,
  graphScriptInputs,
  type GraphBinding,
  type GraphField,
  type GraphGitFetchMode,
} from './graph-fields';
import {
  artifactBindingRefs,
  artifactReferenceInstances,
  bindingContext,
  assertRuntimeParameterOverrides,
  bindingValue,
  checkedParameters,
  declaredScope,
  directEnvironmentCredentials,
  fieldIssue,
  flowEnd,
  flowStart,
  graphEnvironmentSetId,
  inspectDeclaredNodeOutputs,
  inspectNodeEnvironment,
  inspectNodeInputs,
  inspectFlowOutputs,
  nodeInputBinding,
  presetReleaseServiceIds,
  outputSources,
  publicParameters,
  referenceId,
  stringValue,
  startParameterSources,
  type GraphFieldEvidence,
  type GraphFieldSource,
  type GraphArtifactRef,
  type GitRefValue,
  type Values,
} from './graph-run-bindings';
import {
  graphArtifactDefinitions,
  graphArtifactInstance,
  graphArtifactPortId,
} from './graph-artifact-values';
import { normalizeRelativePath } from '../pipelines/pipeline.validation';
import {
  flowImageTag,
  flowImageTagVariable,
  publicWorkspaceSource,
  SimplifiedFlowRunService,
  type SimplifiedRunPlan,
  type SimplifiedSnapshotRequest,
  workspaceRetention,
} from './simplified-flow-run.service';
import { simplifiedEffectiveFinish, simplifiedUsesWorkspace } from './simplified-flow-definition';
import {
  activeFlowStatuses,
  branchMatch,
  failureStatus,
  graphConditionOutput,
  flowSelection,
  graphNodeOutput,
  graphPreviewRouting,
  graphTaskKeyPrefix,
  isDelivery,
  isRelease,
  isNodeTerminal,
} from './graph-run-lifecycle';
import {
  artifactReviewSources,
  assertReviewedSources,
  graphGateHash,
  graphReleaseResult,
  readGraphGate,
  reviewSources,
  sameIds,
  type GraphGateDecision,
  type GraphGateProof,
  type GraphGateScope,
  type GraphReleaseGate,
} from './graph-release-gates';

type Run = Selectable<Database['execution_flow_runs']>;
type NodeRun = Selectable<Database['execution_node_runs']>;
type DeliveryPreview =
  | Awaited<ReturnType<PipelinesService['preview']>>
  | Awaited<ReturnType<PipelinesService['previewArtifactDeploy']>>;
type ResolvedDeliveryConfiguration = NonNullable<DeliveryPreview['executionConfiguration']>;
type DeliveryConfiguration = Omit<ResolvedDeliveryConfiguration, 'targets'> & {
  targets: Omit<ResolvedDeliveryConfiguration['targets'], 'source'> & {
    source: ResolvedDeliveryConfiguration['targets']['source'] | 'NODE';
  };
};
interface Delivery {
  nodeId: string;
  flowId: string;
  pipelineId: string;
  pipelineVersion: number;
  serviceId: string;
  serviceUnscoped?: boolean;
  environmentId: string;
  commitSha: string;
  serverIds: string[];
  requireApproval: boolean;
  requireCodeReview?: boolean;
  sourceReviews?: SourceReviewProof[] | null;
  sourceReviewPendingMaterialization?: boolean;
  artifactIds: string[];
  artifactFromNodeId?: string;
  artifactFromField?: string;
  artifactFromParameterId?: string;
  artifactBinding?: GraphBinding;
  alternatives?: Delivery[];
  artifactRefs?: Values[];
  artifactSkipped?: { artifactId: string; reason: string }[];
  targetInputs?: GraphInputsDto;
  configuration?: DeliveryConfiguration;
  environmentFile?: GraphEnvironmentPlan;
  buildEnvironment?: {
    fixed: Record<string, string>;
    sources: GraphVariableSource[];
  };
  dependencySources?: Record<string, { repositoryId: string; commitSha: string }>;
  sourceSnapshot?: {
    id?: string;
    repositoryId?: string;
    commitSha: string;
    branch?: string;
    tag?: string;
    ref?: string;
    path?: string;
  }[];
  pipelineHash: string;
  profile?: DeliveryExecutionProfile;
  rollbackBaseline?: Record<string, string>;
  composeTemplate?: ComposeTemplateReference;
}
interface RunSnapshot {
  inputs: GraphInputsDto;
  simplified?: SimplifiedRunPlan;
  environmentSet?: EnvironmentSetSummary | null;
  frozenEnvironment?: FrozenEnvironmentSet;
  parameterSources?: Record<string, GraphFieldSource>;
  credentials?: Record<string, string>;
  checkoutProvenance?: Record<string, CheckoutProvenance>;
  deliveries?: Record<string, Delivery | GraphNodePlan>;
  rootId?: string;
  trigger?: Values;
  automation?: GraphAutomation;
  children?: Record<string, PreparedChild>;
}

interface PreparedChild {
  inputHash: string;
  deferredArtifactFields?: string[];
  inputs: GraphInputsDto;
  environmentSet: EnvironmentSetSummary | null;
  frozenEnvironment?: FrozenEnvironmentSet;
  parameterSources: Record<string, GraphFieldSource>;
  checkoutProvenance: Record<string, CheckoutProvenance>;
  selectedNodeIds: string[];
  plans: Record<string, Delivery | GraphNodePlan>;
  children: Record<string, PreparedChild>;
  produced: Record<string, PreparedProduction[]>;
  confirmedOutputs: Values;
}

interface NodeEvidence {
  inputs?: GraphFieldEvidence[];
  environment?: GraphFieldEvidence[];
  outputFields?: GraphFieldEvidence[];
  issue?: ExecutionPlanIssue;
  variableSources?: GraphVariableSource[];
  snapshotTaskId?: string;
}

type SimplifiedStage = 'ACTION' | 'SNAPSHOT' | 'RELEASE' | 'HEALTH';
const workspaceActions = new Set(['CHECKOUT', 'SHELL', 'CHECK', 'BUILD']);

function parallelBuildDirectory(node?: GraphNode) {
  if (node?.type !== 'BUILD') return undefined;
  const directory = normalizeRelativePath(node.build?.repoPath || '.');
  return directory === '.' ? undefined : directory;
}

function separateBuildDirectories(first?: string, second?: string) {
  return Boolean(
    first && second && first !== second &&
    !first.startsWith(second + '/') && !second.startsWith(first + '/'),
  );
}

interface CheckoutProvenance {
  versionSource: string;
  requestedVersion?: GitRefValue;
  triggerRepositoryId?: string;
  triggerCommitSha?: string;
  fetchMode?: GraphGitFetchMode;
  fetchModeDeferred?: boolean;
}

const variableCredentialTypes = ['API_KEY', 'API_SECRET', 'CUSTOM_SECRET', 'USERNAME_PASSWORD'];

function childRequiresFixedPlan(flow: GraphFlow, definition: GraphDefinition) {
  const reachable = new Set([flow.id]);
  for (const flowId of reachable) {
    for (const node of definition.flows.find(({ id }) => id === flowId)?.nodes ?? []) {
      if (
        isDelivery(node) ||
        isNativeTask(node) ||
        (node.environmentSet && node.environmentSet.mode !== 'NONE')
      )
        return true;
      if (node.type === 'FLOW_CALL' && node.flowId) reachable.add(node.flowId);
    }
  }
  return false;
}

function checkoutProvenance(
  flow: GraphFlow,
  node: GraphNode,
  values: Values,
  fields: GraphFieldEvidence[],
  trigger?: Values,
): CheckoutProvenance {
  const version = values.version as GitRefValue | undefined;
  const entry = fields.find(({ fieldId }) => fieldId === 'version');
  const source = entry?.source;
  const eventCommit = source?.kind === 'TRIGGER_EVENT' && source.eventField === 'commit';
  const eventRef = source?.kind === 'TRIGGER_EVENT' && source.eventField === 'ref';
  const sourceRepository = values.source as { repositoryId?: string } | undefined;
  const repositoryId =
    referenceId(values.repository) ?? sourceRepository?.repositoryId ?? node.build?.repositoryId;
  const triggerRepositoryId = stringValue(trigger?.repositoryId);
  const triggerCommitSha = stringValue(trigger?.commitSha)?.toLowerCase();
  if (
    eventCommit &&
    (!triggerRepositoryId ||
      triggerRepositoryId !== repositoryId ||
      version?.kind !== 'COMMIT' ||
      version.value.toLowerCase() !== triggerCommitSha)
  )
    throw fieldIssue(flow, node, {
      fieldId: 'version',
      name: 'Git 版本',
      state: 'ERROR',
      type: 'GIT_REF',
      source,
      message: '事件提交必须来自实际检出的仓库，跨仓库运行可显式绑定分支或标签',
    });
  return {
    versionSource: !version
      ? 'REPOSITORY_DEFAULT'
      : eventCommit
        ? 'TRIGGER_COMMIT'
        : eventRef
          ? 'TRIGGER_REF'
          : (source?.kind ?? 'VALUE'),
    requestedVersion: version,
    triggerRepositoryId,
    triggerCommitSha,
  };
}

interface PreparedProduction {
  definition: PipelineDefinition;
  serverIds?: string[];
  commitSha: string;
  serviceId?: string;
  environmentId?: string;
  kind?: GraphField['artifactType'];
  collection?: 'WORK_DIRECTORY' | 'PATH';
  sourceSnapshot?: Delivery['sourceSnapshot'];
  externalPreflight?: boolean;
}

const outputKey = (nodeId: string, fieldId: string) => `${nodeId}:${fieldId}`;

const planKey = (flowId: string, nodeId: string) => `${flowId}:${nodeId}`;
function publicDelivery(delivery: Delivery, definition: GraphDefinition) {
  const native = Boolean(delivery.profile);
  const flow = definition.flows.find(({ id }) => id === delivery.flowId);
  const nodeName = (nodeId?: string) => flow?.nodes.find(({ id }) => id === nodeId)?.name;
  return {
    ...delivery,
    ...(delivery.serviceUnscoped && { serviceId: null }),
    flowName: flow?.name,
    nodeName: nodeName(delivery.nodeId),
    artifactFromNodeName: nodeName(delivery.artifactFromNodeId),
    pipelineHash: undefined,
    profile: undefined,
    method: delivery.profile?.delivery?.method,
    artifactPath: delivery.profile?.delivery?.artifactPath,
    composeSource: delivery.profile?.delivery?.composeSource,
    alternatives: undefined,
    artifactBinding: undefined,
    targetInputs: undefined,
    configuration: undefined,
    environmentFile: undefined,
    buildEnvironment: undefined,
    possibleArtifacts: delivery.alternatives?.map((candidate) => ({
      nodeId: candidate.artifactFromNodeId,
      nodeName: nodeName(candidate.artifactFromNodeId),
      fieldId: candidate.artifactFromField,
      commitSha: candidate.commitSha,
      artifactIds: candidate.artifactIds,
      artifactRefs: candidate.artifactRefs,
      sourceSnapshot: candidate.sourceSnapshot,
      sourceReviews: candidate.sourceReviews,
      sourceReviewPendingMaterialization: candidate.sourceReviewPendingMaterialization,
    })),
    ...(native && { pipelineId: undefined, pipelineVersion: undefined }),
  };
}
function isNativeTask(node: Pick<GraphNode, 'type'>) {
  return ['CHECKOUT', 'SHELL', 'CHECK', 'LOAD_ENV', 'REGISTER_ARTIFACT', 'HEALTH_CHECK'].includes(
    node.type,
  );
}

interface AutomaticRunOrigin {
  triggerType: 'CRON' | 'WEBHOOK' | 'API' | 'UPSTREAM';
  metadata?: Values;
  authorization: GraphAutomation;
  beforeInsert?: (tx: Transaction<Database>) => Promise<void>;
  afterInsert?: (tx: Transaction<Database>, runId: string) => Promise<void>;
}

export interface GraphPlanAccessScope {
  serverIds: string[];
  repositoryIds: string[];
  serviceIds: string[];
  unbounded: boolean;
}

export type GraphPlanAuthorizer = (scope: GraphPlanAccessScope) => void | Promise<void>;

export interface GraphRunControl {
  authorizePlan?: GraphPlanAuthorizer;
  requestIdentity?: string;
  beforeInsert?: (tx: Transaction<Database>) => Promise<void>;
  afterInsert?: (tx: Transaction<Database>, runId: string) => Promise<void>;
}

interface PlanContext {
  trigger?: Values;
  automation?: GraphAutomation;
  allowRetired?: boolean;
  rootId?: string;
  authorizePlan?: GraphPlanAuthorizer;
  definitionOverride?: { graphId: string; definition: GraphDefinition };
  pendingArtifactParameters?: ReadonlySet<string>;
}

function digest(value: unknown) {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
  return createHash('sha256').update(encoded).digest('hex');
}

function buildVariableFingerprint(variables: ExecutionVariables, key: string) {
  return createHmac('sha256', encryptionKey())
    .update('execution-plan:build-node-variable\0')
    .update(
      digest([
        key,
        variables.variables[key],
        variables.secretVariables[key],
        variables.secretCredentialNonces?.[key],
      ]),
    )
    .digest('hex');
}

function checkRequest(previous: { request_hash: string }, hash: string) {
  if (previous.request_hash !== hash) throw new ConflictException('此提交标识已用于另一组运行参数');
}

function taskStatus(status: string, availableAt: number) {
  if (status === 'PENDING')
    return availableAt === pendingReleaseApprovalTime ? 'WAITING' : 'QUEUED';
  return status;
}

class FlowWorkspaceBusy extends Error {}

@Injectable()
export class GraphRunnerService implements OnModuleInit {
  private readonly logger = new Logger(GraphRunnerService.name);
  private cursor?: { id: string; created_at: number };
  private pumping?: Promise<void>;
  constructor(
    private readonly database: DatabaseService,
    private readonly pipelines: PipelinesService,
    private readonly audit: AuditService,
    @Optional() private readonly registry?: TaskHandlerRegistry,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly nodeTasks?: GraphNodeTasks,
    @Optional() private readonly repositories?: RepositoryMetadataService,
    @Optional() private readonly simplifiedRuns?: SimplifiedFlowRunService,
    @Optional() private readonly settings?: SystemSettingsService,
  ) {}

  onModuleInit() {
    this.registry?.registerGraphPump((taskId) => (taskId ? this.taskChanged(taskId) : this.tick()));
  }

  private async published(
    projectId: string,
    version: number,
    db = this.database.db,
    runnable = false,
  ) {
    const row = await db
      .selectFrom('execution_graph_versions as version')
      .innerJoin('execution_graphs as graph', 'graph.id', 'version.graph_id')
      .select(['graph.id as graphId', 'version.definition_json', 'version.retired_at'])
      .where('graph.project_id', '=', projectId)
      .where('version.version', '=', version)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('项目执行图发布版本不存在');
    if (runnable && row.retired_at !== null) throw new ConflictException('该执行图版本已停用');
    return { graphId: row.graphId, definition: JSON.parse(row.definition_json) as GraphDefinition };
  }

  private flow(definition: GraphDefinition, id: string) {
    const flow = definition.flows.find((f) => f.id === id);
    if (!flow) throw new NotFoundException('此版本中没有该执行流');
    return flow;
  }

  private currentFlow(definition: GraphDefinition, id: string) {
    const flow = this.flow(definition, id);
    if (definition.canvas?.model !== 'FLOW_V2' || flow.model !== 'FLOW_V2')
      throw new ConflictException('此执行流使用旧版编排，请发布简化执行链（FLOW_V2）后运行');
    return flow;
  }

  private async pinnedSource(
    projectId: string,
    repositoryId: string,
    ref?: GitRefValue,
    branch?: string,
  ) {
    if (this.repositories)
      return this.repositories.planGraphCheckout(projectId, {
        repositoryId,
        mode: ref?.kind ?? 'BRANCH',
        branch: ref?.kind === 'BRANCH' ? ref.value : branch,
        tag: ref?.kind === 'TAG' ? ref.value : undefined,
        commitSha: ref?.kind === 'COMMIT' ? ref.value : undefined,
      });
    if (ref?.kind === 'COMMIT') return { repositoryId, commitSha: ref.value };
    return this.pipelines.resolveDeliveryBranch(projectId, repositoryId, branch);
  }

  private async artifactReferences(
    projectId: string,
    refs: GraphArtifactRef[],
    field?: GraphField,
    options: {
      targets?: readonly string[];
      rootId?: string;
      db?: Kysely<Database>;
      single?: boolean;
      distributeFile?: boolean;
    } = {},
  ) {
    if (!refs.length) return [];
    const ids = refs.flatMap((ref) => {
      const instances = artifactReferenceInstances(ref);
      return instances.length ? instances : 'artifactId' in ref ? [ref.artifactId] : [];
    });
    const logical = refs.flatMap((ref) =>
      'artifactId' in ref && !artifactReferenceInstances(ref).length ? [ref.artifactId] : [],
    );
    const rows = await (options.db ?? this.database.db)
      .selectFrom('artifacts')
      .leftJoin('pipeline_runs as build', 'build.id', 'artifacts.pipeline_run_id')
      .leftJoin('tasks as build_task', 'build_task.id', 'build.task_id')
      .select([
        'artifacts.id',
        'artifacts.logical_artifact_id',
        'artifacts.temporary_root_id',
        'artifacts.storage_type',
        'artifacts.artifact_type',
        'artifacts.artifact_kind',
        'artifacts.artifact_name',
        'artifacts.checksum',
        'artifacts.image_digest',
        'artifacts.compose_checksum',
        'artifacts.image_repository',
        'artifacts.storage_key',
        'build_task.payload_json as build_payload',
        'artifacts.server_id',
        'artifacts.service_id',
        'artifacts.source_commit',
        'artifacts.graph_run_id',
        'artifacts.graph_node_run_id',
        'artifacts.physical_json',
        'build.environment_id',
      ])
      .where('artifacts.project_id', '=', projectId)
      .where((eb) =>
        logical.length
          ? eb.or([
              eb('artifacts.id', 'in', ids),
              eb('artifacts.logical_artifact_id', 'in', logical),
            ])
          : eb('artifacts.id', 'in', ids),
      )
      .where('artifacts.lifecycle_state', '=', 'ACTIVE')
      .where((eb) =>
        eb.or([
          eb.and([
            eb('artifacts.pruned_at', 'is', null),
            eb('artifacts.archive_deleted_at', 'is', null),
          ]),
          eb('artifacts.storage_type', '=', 'REGISTRY_IMAGE'),
        ]),
      )
      .where((eb) =>
        eb.or([
          eb('build_task.id', 'is', null),
          eb('build_task.status', 'in', ['SUCCESS', 'PARTIAL_FAILED']),
        ]),
      )
      .orderBy('artifacts.id')
      .execute();
    const selected = new Map<string, (typeof rows)[number]>();
    for (const ref of refs) {
      const restrictedInstances = artifactReferenceInstances(ref);
      const candidates = rows.filter((row) => {
        const kind = row.artifact_kind ?? row.artifact_type;
        if (field?.artifactType && kind !== field.artifactType) return false;
        if ('temporaryArtifactId' in ref)
          return Boolean(
            options.rootId &&
            row.temporary_root_id === options.rootId &&
            row.id === ref.temporaryArtifactId,
          );
        if (row.temporary_root_id !== (ref.rootRunId ?? null)) return false;
        if (ref.rootRunId && ref.rootRunId !== options.rootId) return false;
        if (restrictedInstances.length)
          return (
            restrictedInstances.includes(row.id) &&
            (row.logical_artifact_id ?? row.id) === ref.artifactId
          );
        return row.id === ref.artifactId || row.logical_artifact_id === ref.artifactId;
      });
      if (
        !candidates.length ||
        (restrictedInstances.length && candidates.length !== restrictedInstances.length)
      )
        throw new ExecutionPlanIssueError({
          code: 'ARTIFACT',
          fieldId: 'artifact',
          message: '选中的产物不可用、身份或类型不匹配，或不在当前运行的使用范围内',
        });
      for (const row of candidates) selected.set(row.id, row);
    }
    const matching = [...selected.values()];
    if (
      options.single &&
      new Set(matching.map((row) => row.logical_artifact_id ?? row.id)).size > 1
    )
      throw new ExecutionPlanIssueError({
        code: 'ARTIFACT',
        fieldId: 'artifact',
        message: '一次发布需选择一件具名逻辑产物',
      });
    const effectiveServer = (row: (typeof rows)[number]) =>
      row.storage_type === 'REGISTRY_IMAGE' ? null : row.server_id;
    const sameHost = options.targets?.map((serverId) =>
      matching.filter((row) => effectiveServer(row) === serverId),
    );
    const transferable = matching.filter((row) => effectiveServer(row) === null);
    let instances = matching;
    if (sameHost?.length) {
      if (sameHost.every((group) => group.length === 1)) instances = sameHost.flat();
      else if (sameHost.every((group) => group.length <= 1) && transferable.length === 1)
        instances = transferable;
      else if (
        options.distributeFile &&
        matching.length === 1 &&
        matching[0]?.physical_json &&
        (matching[0].artifact_kind === 'FILE' || matching[0].artifact_kind === 'DIRECTORY')
      )
        instances = matching;
      else {
        const index = sameHost.findIndex((group) => group.length !== 1);
        throw new ExecutionPlanIssueError({
          code: 'ARTIFACT',
          fieldId: 'artifact',
          serverId: options.targets?.[index],
          message: sameHost[index]?.length
            ? '所选目标存在多个同机实例，请固定唯一产物实例'
            : '所选目标缺少同机产物实例或可验证的分发来源',
        });
      }
    }
    return instances.map((row) => {
      const kind = row.artifact_kind ?? row.artifact_type;
      const payload = row.build_payload
        ? (JSON.parse(row.build_payload) as TaskPayload)
        : undefined;
      const scriptArtifact =
        payload?.graphModule?.type === 'SHELL' || payload?.graphModule?.type === 'CHECK';
      return {
        ...graphArtifactInstance(row),
        id: row.id,
        artifactId: row.logical_artifact_id ?? row.id,
        ...(row.temporary_root_id
          ? { scope: 'TEMPORARY' as const, rootRunId: row.temporary_root_id }
          : { scope: 'PERSISTENT' as const }),
        name: row.artifact_name,
        type: kind,
        checksum: row.checksum,
        digest: row.image_digest,
        imageRepository: row.image_repository,
        imageReference: row.artifact_type === 'DOCKER_IMAGE' ? row.storage_key : undefined,
        composeTemplate: archivedComposeTemplate(
          row.build_payload,
          row.artifact_name,
          row.compose_checksum,
        ),
        serverId: row.server_id,
        serviceId: row.service_id,
        environmentId: row.environment_id,
        commitSha: row.source_commit,
        ...(scriptArtifact && {
          workspaceRepositoryId: payload?.pipeline?.definition.repositoryId,
        }),
        runId: row.graph_run_id,
        nodeRunId: row.graph_node_run_id,
      };
    });
  }

  private async scriptArtifactInstance(
    projectId: string,
    value: unknown,
    rootId: string | undefined,
    serverId: string | undefined,
    path: string,
  ) {
    const candidates = (
      await this.artifactReferences(projectId, artifactBindingRefs(value), undefined, {
        rootId,
        single: true,
      })
    ).filter(({ type }) => type === 'FILE' || type === 'DIRECTORY');
    const local = candidates.filter((candidate) => candidate.serverId === (serverId ?? null));
    const selected =
      local.length === 1 ? local[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected || (selected.type === 'FILE' && path !== '.'))
      throw new ExecutionPlanIssueError({
        code: 'ARTIFACT',
        fieldId: 'artifact',
        message: '请选择唯一可读取的文件或目录产物实例',
      });
    await this.nodeTasks!.assertScriptArtifactPath(projectId, selected.id, path);
    return selected.id;
  }

  private async artifactParameter(
    projectId: string,
    flow: GraphFlow,
    field: GraphField,
    value: unknown,
    rootId?: string,
  ) {
    try {
      const refs = artifactBindingRefs(value);
      await this.artifactReferences(projectId, refs, field, { rootId });
      return field.multiple ? refs : refs[0];
    } catch (error) {
      if (error instanceof ExecutionPlanIssueError)
        throw graphInputIssue(flow, error.issue.message, field);
      throw error;
    }
  }

  private async validateNodeResources(
    projectId: string,
    fields: readonly GraphField[],
    values: Values,
    rootId?: string,
    db: Kysely<Database> = this.database.db,
  ) {
    const references = fields.flatMap<{
      field: GraphField;
      resourceType:
        'REPOSITORY' | 'SERVICE' | 'ENVIRONMENT' | 'ENVIRONMENT_SET' | 'SERVER' | 'SERVER_GROUP';
      resourceId: string;
    }>((field) => {
      const value = values[field.id];
      if (value === undefined) return [];
      const entries = Array.isArray(value) ? value : [value];
      const types = ['REPOSITORY', 'SERVICE', 'ENVIRONMENT', 'ENVIRONMENT_SET'] as const;
      const resourceType = types.find((type) => type === field.type);
      if (resourceType)
        return entries.flatMap((entry) => {
          const resourceId = referenceId(entry);
          return resourceId ? [{ field, resourceType, resourceId }] : [];
        });
      if (field.type !== 'TARGETS') return [];
      return entries.flatMap((entry) => {
        const { serverIds = [], groupIds = [] } = entry as {
          serverIds?: string[];
          groupIds?: string[];
        };
        return [
          ...serverIds.map((resourceId) => ({
            field,
            resourceType: 'SERVER' as const,
            resourceId,
          })),
          ...groupIds.map((resourceId) => ({
            field,
            resourceType: 'SERVER_GROUP' as const,
            resourceId,
          })),
        ];
      });
    });
    const unavailable = await unavailableReference(db, projectId, references);
    if (unavailable)
      throw new ExecutionPlanIssueError({
        code: 'INPUT',
        fieldId: unavailable.field.id,
        fieldName: unavailable.field.name,
        message: unavailable.field.name + '引用的项目资源不可用或不在当前项目范围内',
      });
    for (const field of fields) {
      if (field.type !== 'ARTIFACT' || values[field.id] === undefined) continue;
      try {
        await this.artifactReferences(projectId, artifactBindingRefs(values[field.id]), field, {
          rootId,
          db,
        });
      } catch (error) {
        if (!(error instanceof ExecutionPlanIssueError)) throw error;
        throw new ExecutionPlanIssueError({
          ...error.issue,
          fieldId: field.id,
          fieldName: field.name,
        });
      }
    }
  }

  private async resolveParameters(
    projectId: string,
    flow: GraphFlow,
    input: GraphInputsDto,
    rootId?: string,
    pendingArtifacts?: ReadonlySet<string>,
  ) {
    const parameters = checkedParameters(flow, input.parameters, true, pendingArtifacts);
    const inputs = { ...input, parameters };
    const scope = declaredScope(flow, inputs);
    for (const field of flowStart(flow).inputs ?? []) {
      const value = parameters[field.id];
      if (value === undefined) continue;
      if (field.type === 'ARTIFACT')
        parameters[field.id] = await this.artifactParameter(projectId, flow, field, value, rootId);
      const table =
        field.type === 'REPOSITORY'
          ? 'repositories'
          : field.type === 'ENVIRONMENT'
            ? 'environments'
            : field.type === 'ENVIRONMENT_SET'
              ? 'project_environment_sets'
              : field.type === 'SERVICE'
                ? 'services'
                : undefined;
      if (table) {
        const ids = (Array.isArray(value) ? value : [value]).map(referenceId);
        if (ids.some((id) => !id)) throw graphInputIssue(flow, '项目资源引用无效', field);
        const selected = new Set(ids as string[]);
        if (field.type === 'REPOSITORY') {
          for (const id of selected) {
            if (!graphRepositoryUrl(id)) continue;
            try {
              await resolveGraphRepositorySelector(this.database.db, projectId, id);
              selected.delete(id);
            } catch (error) {
              if (!(error instanceof HttpException)) throw error;
              throw graphInputIssue(flow, error.message, field);
            }
          }
        }
        if (!selected.size) continue;
        const rows = await this.database.db
          .selectFrom(table)
          .select('id')
          .where('project_id', '=', projectId)
          .where('archived_at', 'is', null)
          .where('id', 'in', [...selected])
          .execute();
        if (rows.length !== selected.size)
          throw graphInputIssue(flow, field.name + ' 不属于当前项目', field);
      }
    }
    if (scope.environmentId) inputs.environmentId = scope.environmentId;
    Object.assign(inputs, scope.targets);
    return inputs;
  }

  private async completeArtifactParameters(
    projectId: string,
    flow: GraphFlow,
    inputs: GraphInputsDto,
    pendingArtifacts?: ReadonlySet<string>,
  ) {
    const remaining = (flowStart(flow).inputs ?? []).filter(
      (field) =>
        !pendingArtifacts?.has(field.id) &&
        field.selection === 'LATEST_COMPATIBLE' &&
        inputs.parameters?.[field.id] === undefined,
    );
    if (!remaining.length) return;
    const { serviceId } = declaredScope(flow, inputs);
    if (!serviceId) throw graphInputIssue(flow, '获取最新产物需要选择项目服务', remaining[0]);
    for (const field of remaining) {
      const results = await this.database.db
        .selectFrom('artifacts')
        .innerJoin('pipeline_runs as build', 'build.id', 'artifacts.pipeline_run_id')
        .innerJoin('tasks', 'tasks.id', 'build.task_id')
        .select(['artifacts.id', 'artifacts.logical_artifact_id'])
        .where('artifacts.project_id', '=', projectId)
        .where('artifacts.service_id', '=', serviceId)
        .where('tasks.status', '=', 'SUCCESS')
        .where('artifacts.temporary_root_id', 'is', null)
        .where('artifacts.lifecycle_state', '=', 'ACTIVE')
        .where('artifacts.pruned_at', 'is', null)
        .where('artifacts.archive_deleted_at', 'is', null)
        .$if(Boolean(field.artifactType), (qb) =>
          qb.where(
            (eb) => eb.fn.coalesce('artifact_kind', 'artifact_type'),
            '=',
            field.artifactType!,
          ),
        )
        .orderBy('artifacts.created_at', 'desc')
        .orderBy('artifacts.id', 'asc')
        .execute();
      const first = results[0];
      if (!first) throw graphInputIssue(flow, `参数「${field.name}」没有可用产物`, field);
      inputs.parameters![field.id] = await this.artifactParameter(projectId, flow, field, [
        { artifactId: first.logical_artifact_id ?? first.id },
      ]);
    }
  }

  private async delivery(
    projectId: string,
    flow: GraphFlow,
    graphVersion: number,
    node: GraphNode,
    inputs: GraphInputsDto,
    values: Values,
    production: ReadonlyMap<string, PreparedProduction[]>,
    environmentSet: FrozenEnvironmentSet | undefined,
    rootId?: string,
    parameterProduction: ReadonlyMap<string, PreparedProduction[]> = new Map(),
    automation?: GraphAutomation,
  ): Promise<Delivery> {
    const start = flowStart(flow);
    const scope = declaredScope(flow, inputs);
    const serviceId =
      referenceId(values.service) ??
      scope.serviceId ??
      (node.type === 'BUILD' ? graphUnscopedArtifactService(projectId).id : undefined);
    const environmentId = graphDeliveryEnvironment(projectId).id;
    if (!serviceId)
      throw new ExecutionPlanIssueError({
        code: 'CONFIGURATION',
        fieldId: 'service',
        message: '请选择项目服务',
      });
    if (!flow.compiled?.presetResourceGroups && flow.serviceId && serviceId !== flow.serviceId)
      throw new ExecutionPlanIssueError({
        code: 'CONFIGURATION',
        fieldId: 'service',
        message: '节点服务必须与执行流关联服务一致',
      });
    const base = {
      environmentId,
      ...(values.targets as GraphInputsDto | undefined),
    };
    const targetBinding = nodeInputBinding(flow, node, 'targets');
    const describe = (
      configuration?: ResolvedDeliveryConfiguration,
    ): DeliveryConfiguration | undefined =>
      configuration && {
        ...configuration,
        settings: configuration.settings.map((setting) =>
          node.type === 'BUILD' &&
          setting.field === 'buildLocation' &&
          (start.buildLocation === 'MANAGER' || start.buildLocation === 'TARGET')
            ? { ...setting, source: 'START' }
            : setting,
        ),
        targets: {
          ...configuration.targets,
          source:
            configuration.targets.source === 'RUN_INPUT' &&
            targetBinding &&
            targetBinding.kind !== 'INPUT'
              ? ('NODE' as const)
              : configuration.targets.source,
        },
      };
    const graphVariables = await this.pipelines.graphVariables(
      projectId,
      serviceId,
      environmentSet,
    );
    const makeProfile = (
      definition: PipelineDefinition,
      fields: string[] = [],
    ): DeliveryExecutionProfile => ({
      ...deliveryExecutionProfile(
        projectId,
        serviceId,
        flow.id + ':' + node.id,
        graphVersion,
        node.name,
        definition,
        fields,
      ),
      graphVariables,
    });
    const wrap = (
      preview: DeliveryPreview,
      profile: DeliveryExecutionProfile,
      sourceRef?: { branch?: string; tag?: string },
    ): Delivery => ({
      nodeId: node.id,
      flowId: flow.id,
      pipelineId: profile.id,
      pipelineVersion: preview.version,
      profile,
      serviceId: preview.serviceId,
      serviceUnscoped: preview.serviceId === graphUnscopedArtifactService(projectId).id,
      environmentId: preview.environmentId,
      commitSha: preview.commitSha,
      serverIds: preview.serverIds,
      requireApproval: preview.requireApproval,
      requireCodeReview: 'requireCodeReview' in preview && preview.requireCodeReview === true,
      ...('sourceReviews' in preview && { sourceReviews: preview.sourceReviews }),
      artifactIds: 'artifactIds' in preview ? preview.artifactIds : [],
      rollbackBaseline: 'rollbackBaseline' in preview ? preview.rollbackBaseline : undefined,
      composeTemplate: 'graphDeployment' in preview ? preview.graphDeployment?.template : undefined,
      sourceSnapshot: preview.nodeSources ?? [
        {
          repositoryId: preview.definition.repositoryId,
          commitSha: preview.commitSha,
          ...(sourceRef?.branch && { branch: sourceRef.branch }),
          ...(sourceRef?.tag && { tag: sourceRef.tag }),
        },
      ],
      pipelineHash: preview.configurationHash,
      targetInputs: base,
      configuration: describe(preview.executionConfiguration),
    });
    if (node.type === 'BUILD') {
      const build = node.build ?? {};
      const { branch, commitSha: pinned, dependencies = [], ...settings } = build;
      const source = (values.source ?? values.workspace) as
        { repositoryId?: string; commitSha?: string; branch?: string; tag?: string } | undefined;
      const repositoryId =
        referenceId(values.repository) ?? source?.repositoryId ?? settings.repositoryId;
      if (!repositoryId)
        throw new ExecutionPlanIssueError({
          code: 'REPOSITORY',
          fieldId: 'repository',
          message: '构建缺少源码或仓库',
        });
      const workspace = values.workspace as typeof source;
      if (
        (source?.repositoryId && source.repositoryId !== repositoryId) ||
        (workspace?.repositoryId &&
          (workspace.repositoryId !== repositoryId || workspace.commitSha !== source?.commitSha))
      )
        throw new ExecutionPlanIssueError({
          code: 'REPOSITORY',
          fieldId: 'workspace',
          repositoryId,
          message: '构建仓库、检出提交与工作区绑定不一致',
        });
      if (dependencies.length && (!workspace?.repositoryId || !workspace.commitSha))
        throw new ExecutionPlanIssueError({
          code: 'REPOSITORY',
          fieldId: 'workspace',
          repositoryId,
          message: '多仓构建需要绑定主源码工作区',
        });
      const dependencySources = Object.fromEntries(
        dependencies.map((alias) => {
          const dependency = values['dependency_' + alias] as typeof source;
          if (!dependency?.repositoryId || !dependency.commitSha)
            throw new ExecutionPlanIssueError({
              code: 'REPOSITORY',
              fieldId: 'dependency_' + alias,
              message: '源码依赖缺少已固定的检出工作区 · ' + alias,
            });
          return [
            alias,
            {
              repositoryId: dependency.repositoryId,
              commitSha: dependency.commitSha,
              ref: artifactSourceRef({ ...dependency, commitSha: dependency.commitSha }),
              path: 'dependencies/' + alias,
            },
          ];
        }),
      );
      const ref = values.version as GitRefValue | undefined;
      const sha = source?.commitSha ?? pinned ?? (ref ? undefined : inputs.commitSha);
      const fixed = sha
        ? { commitSha: sha, branch: source?.branch, tag: source?.tag }
        : await this.pinnedSource(projectId, repositoryId, ref, branch).catch((error: unknown) =>
            withPlanIssue(error, {
              code: 'REPOSITORY',
              fieldId: error instanceof NotFoundException ? 'repository' : 'version',
              repositoryId,
            }),
          );
      const startSelectedTarget =
        start.contract === 'PRESET' && Boolean(base.serverIds?.length || base.groupIds?.length);
      const location =
        start.buildLocation ??
        (startSelectedTarget ? 'TARGET' : (settings.buildLocation ?? 'INHERIT'));
      const definition = Object.assign(new PipelineDefinitionDto(), settings, {
        repositoryId,
        ...(location !== 'INHERIT' && { buildLocation: location }),
        inheritBuildLocation: location === 'INHERIT',
        ...(settings.artifacts && { artifacts: graphArtifactDefinitions(settings.artifacts) }),
      });
      const variableBinding = values.variables as GraphEnvironmentRef | undefined;
      const profile = makeProfile(definition, Object.keys(settings));
      const preview = await this.pipelines.preview(
        profile.id,
        {
          ...base,
          commitSha: fixed.commitSha,
          mode: 'BUILD_ONLY',
          confirmed: true,
        },
        undefined,
        profile,
      );
      if (start.sameHostRelease && preview.definition.buildLocation === 'MANAGER')
        throw new ExecutionPlanIssueError({
          code: 'BUILD_TARGET',
          flowId: flow.id,
          flowName: flow.name,
          nodeId: start.id,
          nodeName: start.name,
          fieldId: 'buildLocation',
          fieldSection: 'execution',
          message: '当前使用管理端构建。请在开始节点选择目标端构建，或取消构建与发布同机',
        });
      if (automation)
        await this.pipelines
          .assertGraphAutomaticBuild(preview, preview.serverIds)
          .catch((error: unknown) =>
            withPlanIssue(error, {
              code: 'BUILD_TARGET',
              fieldId: preview.definition.buildLocation === 'MANAGER' ? 'buildLocation' : 'targets',
            }),
          );
      const environmentFile = variableBinding?.environmentFile;
      const reviewed = wrap(preview, profile, {
        branch: 'branch' in fixed ? fixed.branch : undefined,
        tag: 'tag' in fixed ? fixed.tag : undefined,
      });
      return {
        ...reviewed,
        dependencySources,
        sourceSnapshot: [
          ...(reviewed.sourceSnapshot ?? []),
          ...Object.values(dependencySources),
          ...(environmentFile?.status === 'PINNED' &&
          (environmentFile.repositoryId !== repositoryId ||
            environmentFile.commitSha !== fixed.commitSha)
            ? [
                {
                  repositoryId: environmentFile.repositoryId,
                  commitSha: environmentFile.commitSha,
                  ref: artifactSourceRef(environmentFile),
                  path: environmentFile.path,
                },
              ]
            : []),
        ],
        environmentFile,
      };
    }

    const { method: configuredMethod, composeSource, ...deploySettings } = node.deploy ?? {};
    const artifactPath = deploySettings.artifactPath?.trim()
      ? normalizeRelativePath(deploySettings.artifactPath.trim())
      : undefined;
    const afterRelease =
      flow.compiled?.nodes[node.id]?.inputBindings.afterRelease ??
      flow.inputBindings?.[node.id]?.afterRelease;
    const fromBuild = (definition: PipelineDefinition, type?: string): DeliveryExecutionProfile => {
      if (
        type &&
        ((configuredMethod === 'COMPOSE' && type !== 'DOCKER_IMAGE') ||
          (configuredMethod === 'FILE' && !['FILE', 'DIRECTORY'].includes(type)))
      )
        throw new ExecutionPlanIssueError({
          code: 'ARTIFACT',
          fieldId: 'artifact',
          message:
            configuredMethod === 'COMPOSE'
              ? 'Compose 发布需要 Docker 镜像'
              : '文件发布需要文件或目录产物',
        });
      const artifactType =
        type === 'DOCKER_IMAGE' ? 'DOCKER_IMAGE' : type ? 'FILE' : definition.artifactType;
      const method = configuredMethod ?? (artifactType === 'DOCKER_IMAGE' ? 'COMPOSE' : 'FILE');
      const profile = makeProfile(
        Object.assign(
          new PipelineDefinitionDto(),
          {
            repositoryId: definition.repositoryId,
            artifactType,
            registryId: definition.registryId,
            imageRepository: definition.imageRepository,
          },
          deploySettings,
        ),
        Object.keys(deploySettings),
      );
      return {
        ...profile,
        delivery: {
          method,
          ...(artifactPath && { artifactPath }),
          ...(method === 'COMPOSE' && {
            composeSource:
              composeSource?.kind === 'REPOSITORY_FILE'
                ? {
                    kind: 'REPOSITORY_FILE',
                    repositoryId: composeSource.repositoryId!,
                    commitSha: composeSource.commitSha!,
                    path: composeSource.path!,
                  }
                : { kind: 'ARTIFACT' },
          }),
          ...(node.type === 'ROLLBACK_ARTIFACT' && {
            rollback: afterRelease ? 'AFTER_RELEASE' : 'CURRENT',
          }),
        },
      };
    };
    const binding =
      flow.compiled?.nodes[node.id]?.inputBindings.artifact ??
      flow.inputBindings?.[node.id]?.artifact;
    const plans: Delivery[] = [];
    const requested = artifactBindingRefs(values.artifact ?? inputs.artifactIds);
    const inputField =
      binding?.kind === 'INPUT'
        ? start.inputs?.find((field) => field.id === binding.fieldId)
        : undefined;
    const existing = async (references: GraphArtifactRef[]) => {
      const selection = directDeploymentSelection(base, 1);
      const targets = selection ? await selectedServerIds(this.database.db, selection) : undefined;
      const refs = await this.artifactReferences(projectId, references, inputField, {
        targets,
        rootId,
        single: true,
        distributeFile: configuredMethod !== 'COMPOSE',
      });
      const ids = refs.map(({ id }) => id);
      if (refs.some((ref) => ref.serviceId !== serviceId))
        throw new ExecutionPlanIssueError({
          code: 'ARTIFACT',
          fieldId: 'artifact',
          message: '产物不属于当前项目服务',
        });
      const source = await this.pipelines.deliveryArtifactBuild(
        projectId,
        serviceId,
        environmentId,
        ids,
      );
      const profile = {
        ...fromBuild(source.definition, refs[0]?.type),
        ...(rootId &&
          references.some((ref) => 'temporaryArtifactId' in ref || ref.rootRunId) && {
            artifactRootRunId: rootId,
          }),
      };
      const preview = await this.pipelines.previewArtifactDeploy(
        profile.id,
        { ...base, artifactIds: ids },
        profile,
        automation,
      );
      const wrapped = wrap(preview, profile);
      const archives = refs.flatMap((ref) => (ref.composeTemplate ? [ref.composeTemplate] : []));
      const archive = archives[0];
      return {
        ...wrapped,
        composeTemplate:
          wrapped.composeTemplate ??
          (profile.delivery?.method === 'COMPOSE' &&
          archive &&
          archives.length === refs.length &&
          archives.every(({ checksum }) => checksum === archive.checksum)
            ? archive
            : undefined),
        artifactRefs: refs.map((ref) => ({
          ...ref,
          verificationStatus: 'AVAILABLE',
        })),
      };
    };
    if (requested.length) {
      plans.push(await existing(requested));
    } else if (
      inputField?.selection === 'LATEST_COMPATIBLE' &&
      !parameterProduction.has(inputField.id)
    ) {
      const latest = await this.latestDeliveryArtifact(projectId, serviceId, existing, inputField);
      plans.push(latest.plan);
      inputs.parameters![inputField.id] = inputField.multiple ? [latest.ref] : latest.ref;
    }
    const previous = outputSources(binding).flatMap(({ nodeId, fieldId }) =>
      (production.get(outputKey(nodeId, fieldId)) ?? []).map((producer) => ({
        producer,
        nodeId,
        fieldId,
        parameterId: undefined as string | undefined,
      })),
    );
    const inherited = inputField ? (parameterProduction.get(inputField.id) ?? []) : [];
    for (const source of [
      ...previous,
      ...inherited.map((producer) => ({
        producer,
        nodeId: undefined,
        fieldId: undefined,
        parameterId: inputField!.id,
      })),
    ]) {
      const { producer } = source;
      if (producer.collection === 'WORK_DIRECTORY' && !artifactPath)
        throw new ExecutionPlanIssueError({
          code: 'ARTIFACT',
          fieldId: 'artifactPath',
          message: '请选择本次工作目录快照中的子路径，或填写 . 使用整个目录',
        });
      if (!producer.externalPreflight && producer.serviceId !== serviceId)
        throw new ExecutionPlanIssueError({
          code: 'ARTIFACT',
          fieldId: 'artifact',
          message: '上游产物须属于本次部署的项目服务',
        });
      const profile = fromBuild(
        producer.definition,
        producer.kind ??
          (producer.externalPreflight
            ? configuredMethod === 'COMPOSE'
              ? 'DOCKER_IMAGE'
              : 'FILE'
            : undefined),
      );
      const plan = await this.pipelines.previewArtifactDeployPlan(
        profile.id,
        {
          ...base,
          commitSha: producer.commitSha,
        },
        profile,
        automation,
      );
      const missingTarget =
        producer.serverIds?.length &&
        !(producer.kind === 'DOCKER_IMAGE' && producer.definition.registryId) &&
        !(
          producer.serverIds.length === 1 &&
          (producer.kind === 'FILE' || producer.kind === 'DIRECTORY')
        )
          ? plan.serverIds.find((id) => !producer.serverIds!.includes(id))
          : undefined;
      if (missingTarget)
        throw new ExecutionPlanIssueError({
          code: 'ARTIFACT',
          fieldId: 'artifact',
          serverId: missingTarget,
          sourceNodeId: source.nodeId,
          sourceFieldId: source.fieldId,
          message: '部署目标没有对应的同机产物生产位置',
        });
      plans.push({
        nodeId: node.id,
        flowId: flow.id,
        pipelineId: profile.id,
        pipelineVersion: plan.version,
        profile,
        serviceId: plan.serviceId,
        environmentId: plan.environmentId,
        commitSha: plan.commitSha,
        serverIds: plan.serverIds,
        requireApproval: plan.requireApproval,
        requireCodeReview: plan.requireCodeReview,
        sourceReviewPendingMaterialization: plan.sourceReviewPendingMaterialization,
        rollbackBaseline: plan.rollbackBaseline,
        composeTemplate: plan.graphDeployment?.template,
        artifactIds: [],
        artifactFromNodeId: source.nodeId,
        artifactFromField: source.fieldId,
        artifactFromParameterId: source.parameterId,
        sourceSnapshot: producer.sourceSnapshot,
        pipelineHash: plan.configurationHash,
        targetInputs: base,
        configuration: describe(plan.executionConfiguration),
      });
    }
    if (!plans.length)
      throw new ExecutionPlanIssueError({
        code: 'ARTIFACT',
        fieldId: 'artifact',
        message: '请绑定可部署的已登记产物或上游具名产物',
      });
    return {
      ...plans[0]!,
      artifactBinding: binding,
      ...(plans.length > 1 && { alternatives: plans }),
    };
  }

  private async latestDeliveryArtifact(
    projectId: string,
    serviceId: string,
    preview: (refs: GraphArtifactRef[]) => Promise<Delivery>,
    field: GraphField,
  ) {
    const candidates = await this.database.db
      .selectFrom('artifacts')
      .innerJoin('pipeline_runs as build', 'build.id', 'artifacts.pipeline_run_id')
      .innerJoin('tasks as task', 'task.id', 'build.task_id')
      .select(['artifacts.id', 'artifacts.logical_artifact_id'])
      .where('artifacts.project_id', '=', projectId)
      .where('artifacts.service_id', '=', serviceId)
      .where('artifacts.temporary_root_id', 'is', null)
      .where('artifacts.lifecycle_state', '=', 'ACTIVE')
      .where('task.status', 'in', ['SUCCESS', 'PARTIAL_FAILED'])
      .$if(Boolean(field.artifactType), (builder) =>
        builder.where(
          (eb) => eb.fn.coalesce('artifact_kind', 'artifact_type'),
          '=',
          field.artifactType!,
        ),
      )
      .orderBy('task.finished_at', 'desc')
      .orderBy('artifacts.created_at', 'desc')
      .orderBy('artifacts.id')
      .execute();
    const ids = new Set(candidates.map(({ id, logical_artifact_id }) => logical_artifact_id ?? id));
    const skipped: NonNullable<Delivery['artifactSkipped']> = [];
    for (const artifactId of ids) {
      const ref = { artifactId };
      try {
        const plan = await preview([ref]);
        return { ref, plan: { ...plan, artifactSkipped: skipped } };
      } catch (error) {
        if (
          error instanceof SourceReviewConflict ||
          (error instanceof ExecutionPlanIssueError && error.issue.code === 'RELEASE_TARGET')
        )
          throw error;
        if (!(error instanceof HttpException) || ![400, 404, 409].includes(error.getStatus()))
          throw error;
        if (skipped.length < 30) skipped.push({ artifactId, reason: redactTaskLog(error.message) });
      }
    }
    throw new ExecutionPlanIssueError({
      code: 'ARTIFACT',
      fieldId: 'artifact',
      message: '当前服务没有可验证且与所选目标兼容的产物',
    });
  }

  private async prepareSimplified(
    projectId: string,
    graphId: string,
    definition: GraphDefinition,
    flow: GraphFlow,
    request: GraphPreviewDto,
    trigger?: Values,
    automation?: GraphAutomation,
    authorizePlan?: GraphPlanAuthorizer,
  ) {
    if (!this.simplifiedRuns) throw new ConflictException('运行工作区服务不可用');
    if (automation) assertAutomaticGraphFlow(definition, flow.id, automation.kind);
    const { plan, selectedSet, environmentSet } = await this.simplifiedRuns.plan(
      projectId,
      flow,
      request.version,
      request.inputs ?? {},
      trigger,
      automation,
    );
    const target = plan.placement.location === 'TARGET' ? plan.placement.target : undefined;
    const release = plan.release;
    const inputs: GraphInputsDto = { value: plan.value, parameters: plan.environment.variables };
    const selection = flowSelection(flow, inputs);
    const selectedNodes = selection.ordered.filter(({ id }) => selection.selected.has(id));
    plan.finish = simplifiedEffectiveFinish(
      selectedNodes,
      plan.finish,
      Boolean(release?.artifactId || plan.trigger?.upstreamArtifactPending),
    );
    const workspaceDisposition = simplifiedUsesWorkspace(selectedNodes)
      ? workspaceRetention(
          plan.finish,
          release?.method === 'FILE' &&
            !release.artifactId &&
            selection.selected.has(release.nodeId),
        )
      : 'OFF';
    if (release && selection.selected.has(release.nodeId)) {
      const required = [
        [
          release.requireApproval || Boolean(release.rollbackBaseline),
          'APPROVAL',
          '发布前需要人工审批',
        ],
        [release.requireCodeReview, 'SOURCE_REVIEW', '发布前需要审核实际源码'],
      ] as const;
      for (const [enabled, type, message] of required) {
        if (
          enabled &&
          !selection.ordered.some((node) => node.type === type && selection.selected.has(node.id))
        )
          throw new ExecutionPlanIssueError({
            code: 'CONFIGURATION',
            flowId: flow.id,
            nodeId: release.nodeId,
            message,
          });
      }
    }
    const routing = graphPreviewRouting(flow, selection).edges;
    const checkout = flow.nodes.find(({ type }) => type === 'CHECKOUT');
    const sources = plan.sources.map(({ id, source, directory }) => ({
      id,
      repositoryId: source.repositoryId,
      repositoryName: source.repositoryName,
      commitSha: source.commitSha,
      ref: source.ref,
      branch: source.branch,
      tag: source.tag,
      path: directory,
    }));
    if (authorizePlan)
      await authorizePlan({
        serverIds: [
          ...new Set([
            ...(target ? [target.id] : []),
            ...(release?.serverIds ?? []),
            ...(plan.workspaceSource?.serverId ? [plan.workspaceSource.serverId] : []),
          ]),
        ],
        repositoryIds: [
          ...new Set(
            [...sources, ...(plan.workspaceSource?.sources ?? [])].map(
              ({ repositoryId }) => repositoryId,
            ),
          ),
        ],
        serviceIds: plan.serviceId ? [plan.serviceId] : [],
        unbounded:
          flow.nodes.some(({ type }) => ['CHECK', 'SHELL', 'BUILD'].includes(type)) ||
          Boolean(release?.artifactId),
      });
    const publicRelease: Delivery | undefined = release && {
      nodeId: release.nodeId,
      flowId: flow.id,
      pipelineId: release.profile.id,
      pipelineVersion: 1,
      serviceId: release.serviceId,
      environmentId: graphDeliveryEnvironment(projectId).id,
      commitSha: sources[0]?.commitSha ?? unversionedArtifactCommit,
      serverIds: release.serverIds,
      requireApproval: release.requireApproval,
      requireCodeReview: release.requireCodeReview,
      artifactIds: release.artifactId ? [release.artifactId] : [],
      rollbackBaseline: release.rollbackBaseline,
      sourceSnapshot: sources,
      pipelineHash: release.planHash,
      profile: release.profile,
    };
    const deliveries = publicRelease
      ? [
          {
            ...publicDelivery(publicRelease, definition),
            artifactPath: release?.path === '.' ? undefined : release?.path,
          },
        ]
      : [];
    const plans: Record<string, Delivery | GraphNodePlan> = Object.fromEntries(
      flow.nodes
        .filter(({ type }) => type === 'HEALTH_CHECK')
        .map(({ id }) => [id, { type: 'HEALTH_CHECK' as const }]),
    );
    const configurationHash = digest([graphId, request.version, flow.id, plan]);
    const preview = {
      ...deliveries[0],
      projectId,
      graphId,
      flowId: flow.id,
      flowName: flow.name,
      version: request.version,
      configurationHash,
      environmentSet,
      parameters: {},
      parameterSources: {},
      routing,
      nodes: selection.ordered.map(({ id, name, type }) => ({
        nodeId: id,
        name,
        type,
        selected: selection.selected.has(id),
        conditional: false,
      })),
      deliveries,
      checkouts: checkout
        ? sources.map((source) => ({
            ...source,
            nodeId: checkout.id,
            flowId: flow.id,
            versionSource: 'START',
            fullClone: checkout.checkout?.fullClone,
            directory: source.path,
          }))
        : [],
      scripts: selection.ordered
        .filter(({ type }) => ['BUILD', 'CHECK', 'SHELL'].includes(type))
        .map((node) => ({
          nodeId: node.id,
          flowId: flow.id,
          serverId: target?.id,
          serverName: target?.name,
          directory: normalizeRelativePath(
            (node.type === 'BUILD' ? node.build?.repoPath : node.shell?.directory) || '.',
          ),
        })),
      gates: flow.nodes.flatMap(({ id, name, type }) =>
        type === 'APPROVAL' ||
        type === 'SOURCE_REVIEW' ||
        type === 'HEALTH_CHECK' ||
        type === 'ROLLBACK_ARTIFACT'
          ? [{ nodeId: id, flowId: flow.id, name, kind: type, releaseNodeId: release?.nodeId }]
          : [],
      ),
      executionPlan: {
        targets: [],
        settings: [],
        environmentFiles: [],
        variables: [],
        deferred: [],
      },
      planSections: { 开始配置与交付: configurationHash } as Record<string, string>,
      simplified: {
        location: plan.placement.location,
        serverId: target?.id,
        serverName: target?.name,
        sources,
        workspaceSource: simplifiedUsesWorkspace(selectedNodes)
          ? publicWorkspaceSource(plan)
          : undefined,
        finish: plan.finish,
        imageTagVariable: plan.finish.images?.some(({ source }) => source !== 'REGISTRY')
          ? flowImageTagVariable
          : undefined,
        workspaceRetention: workspaceDisposition,
        release: release && {
          serviceId: release.serviceId,
          serverIds: release.serverIds,
          artifactId: release.artifactId,
          contentPath: release.path === '.' ? undefined : release.path,
          method: release.method,
          image: release.image,
          images: release.images,
          compose:
            release.profile.delivery?.composeSource?.kind === 'REPOSITORY_FILE'
              ? { path: release.profile.delivery.composeSource.path }
              : release.workspaceComposePath
                ? { path: release.workspaceComposePath }
                : undefined,
        },
      },
    };
    const credentials = Object.fromEntries(
      Object.entries(plan.environment.secretVariables).flatMap(([key, credentialId]) => {
        const nonce = plan.environment.secretCredentialNonces?.[key];
        return nonce ? [[credentialId, nonce]] : [];
      }),
    );
    const children: Record<string, PreparedChild> = {};
    const parameterSources: Record<string, GraphFieldSource> = {};
    const checkoutProvenance: Record<string, CheckoutProvenance> = {};
    return {
      preview,
      flow,
      inputs,
      plans,
      children,
      environmentSet,
      frozenEnvironment: selectedSet,
      parameterSources,
      checkoutProvenance,
      credentials,
      environmentSets: selectedSet ? [selectedSet] : [],
      simplified: plan,
    };
  }

  private async prepare(
    projectId: string,
    flowId: string,
    request: GraphPreviewDto,
    {
      trigger,
      automation,
      allowRetired = false,
      rootId,
      authorizePlan,
      definitionOverride,
      pendingArtifactParameters,
    }: PlanContext = {},
  ) {
    await requireProject(this.database.db, projectId);
    const { graphId, definition } =
      definitionOverride ??
      (await this.published(projectId, request.version, this.database.db, !allowRetired));
    const flow = rootId ? this.flow(definition, flowId) : this.currentFlow(definition, flowId);
    if (flow.model === 'FLOW_V2')
      return this.prepareSimplified(
        projectId,
        graphId,
        definition,
        flow,
        request,
        trigger,
        automation,
        authorizePlan,
      );
    if (!rootId && !automation) {
      assertRuntimeParameterOverrides(flow, request.inputs?.parameters);
      if (
        flowStart(flow).contract === 'PRESET' &&
        Object.entries(request.inputs ?? {}).some(
          ([field, value]) => value !== undefined && !['parameters', 'value'].includes(field),
        )
      )
        throw graphInputIssue(flow, '请使用当前开始节点允许覆盖的运行参数');
    }
    if (automation) assertAutomaticGraphFlow(definition, flowId, automation.kind);
    const inputs = await this.resolveParameters(
      projectId,
      flow,
      request.inputs ?? {},
      rootId,
      pendingArtifactParameters,
    );
    const parameterSources = startParameterSources(
      flow,
      request.inputs?.parameters,
      trigger?.parameterSources as Values | undefined,
    );
    if (inputs.value && redactTaskLog(inputs.value) !== inputs.value)
      throw graphInputIssue(flow, '条件值只接受普通文本，请移除凭据');
    const checkoutRows: ({
      nodeId: string;
      flowId: string;
      repositoryId: string;
      repositoryName?: string;
      ref?: string;
      branch?: string;
      tag?: string;
      commitSha: string;
      fullClone?: boolean;
    } & CheckoutProvenance)[] = [];
    const scripts: {
      nodeId: string;
      flowId: string;
      serverId?: string;
      serverName?: string;
      serviceId?: string;
      environmentId?: string;
      directory: string;
      workspace?: Extract<GraphNodePlan, { type: 'SHELL' | 'CHECK' }>['workspace'];
      artifact?: Extract<GraphNodePlan, { type: 'SHELL' | 'CHECK' }>['artifact'];
    }[] = [];
    const publishedDeliveries: Delivery[] = [];
    const plannedServices = new Set<string>();
    const gates: {
      flowId: string;
      nodeId: string;
      name: string;
      kind: 'SOURCE_REVIEW' | 'APPROVAL' | 'HEALTH_CHECK' | 'ROLLBACK_ARTIFACT';
      releaseNodeId?: string;
      buildNodeId?: string;
    }[] = [];
    const scriptsPrepared: { flowId: string; nodeId: string; plan: GraphNodePlan }[] = [];
    const environmentFiles: ({ flowId: string; nodeId: string } & NonNullable<
      ReturnType<typeof publicEnvironmentFile>
    >)[] = [];
    const nativeVariables: {
      flowId: string;
      nodeId: string;
      key: string;
      source: string;
      sensitive: boolean;
      overriddenSources?: string[];
    }[] = [];
    const deferred: {
      flowId: string;
      nodeId: string;
      field: string;
      producerNodeId?: string;
      producerField?: string;
    }[] = [];
    let invocations = 0;
    let unbounded = false;
    const sets = new Map<string, Promise<FrozenEnvironmentSet>>();
    const credentials: Record<string, string> = Object.create(null);
    const evidenceByNode = new Map<string, NodeEvidence>();
    let rootRouting: ReturnType<typeof graphPreviewRouting> | undefined;
    const prepareFlow = async (
      current: GraphFlow,
      args: GraphInputsDto,
      inputHash = '',
      sources = startParameterSources(current, args.parameters),
      parameterProduction: ReadonlyMap<string, PreparedProduction[]> = new Map(),
    ): Promise<PreparedChild> => {
      if (++invocations > 100) throw new BadRequestException('一次运行展开的子流过多');
      const plans = new Map<string, Delivery | GraphNodePlan>();
      const production = new Map<string, PreparedProduction[]>();
      const children: Record<string, PreparedChild> = Object.create(null);
      const outputs = new Map<string, Values>();
      const checkouts: Record<string, CheckoutProvenance> = Object.create(null);
      const setId = graphEnvironmentSetId(current, args);
      const setFieldId = flowStart(current).environmentSet?.fieldId;
      if (setId && !sets.has(setId))
        sets.set(setId, resolveEnvironmentSet(this.database.db, projectId, setId));
      const environmentSet = await (setId ? sets.get(setId) : undefined)?.catch(
        (error: unknown) => {
          if (!(error instanceof HttpException)) throw error;
          throw graphInputIssue(
            current,
            error.message,
            flowStart(current).inputs?.find(({ id }) => id === setFieldId),
          );
        },
      );
      const state = {
        ...bindingContext(projectId, current, args, outputs, trigger),
        environmentSet,
        credentialNonces: credentials,
        parameterSources: sources,
        pendingArtifacts: new Set(parameterProduction.keys()),
        producerStatus: (id: string): string | undefined =>
          previewSelected?.has(id) === false ? 'SKIPPED' : undefined,
      };
      let previewSelected: ReadonlySet<string> | undefined;
      let selection = flowSelection(current, args, state);
      previewSelected = selection.selected;
      let scriptWorkspaces: ScriptWorkspacePreview | undefined;
      const scope = declaredScope(current, args);
      for (const node of selection.ordered) {
        if (!previewSelected.has(node.id)) continue;
        const key = planKey(current.id, node.id);
        const child = node.type === 'FLOW_CALL' ? this.flow(definition, node.flowId!) : undefined;
        const input = inspectNodeInputs(current, node, state, child);
        const values = input.values;
        for (const field of input.evidence) {
          if (field.state === 'ERROR') {
            const startField = (flowStart(current).inputs ?? []).find(
              ({ id }) => field.source?.fieldId === id,
            );
            if (field.type === 'ARTIFACT' && startField?.selection === 'LATEST_COMPATIBLE') {
              field.state = 'DEFERRED';
              field.message = '预览将选择最新兼容产物';
            } else {
              throw fieldIssue(current, node, field);
            }
          }
          if (field.state !== 'DEFERRED') continue;
          const needsResolved =
            field.type === 'CREDENTIAL' ||
            ['targets', 'service'].includes(field.fieldId) ||
            (node.type === 'CHECKOUT' && ['repository', 'version'].includes(field.fieldId));
          if (needsResolved)
            throw fieldIssue(current, node, { ...field, message: '此字段需要在预览时固定' });
          deferred.push({
            flowId: current.id,
            nodeId: node.id,
            field: field.fieldId,
            producerNodeId: field.source?.nodeId,
            producerField: field.source?.fieldId,
          });
        }
        const configuredCredentials = [
          ...directEnvironmentCredentials(current, node),
          ...input.fields.flatMap((field) =>
            field.type === 'CREDENTIAL' && typeof values[field.id] === 'string'
              ? [values[field.id] as string]
              : [],
          ),
        ];
        for (const id of new Set(configuredCredentials)) {
          if (Object.hasOwn(credentials, id)) continue;
          const credential = await this.database.db
            .selectFrom('credentials')
            .select('nonce')
            .where('id', '=', id)
            .where('status', '=', 'ACTIVE')
            .where('type', 'in', variableCredentialTypes)
            .executeTakeFirst();
          if (!credential)
            throw new ExecutionPlanIssueError({
              code: 'CONFIGURATION',
              flowId: current.id,
              nodeId: node.id,
              message: '节点引用的变量凭据不存在、已停用或类型不匹配',
            });
          credentials[id] = credential.nonce;
        }
        const environment = inspectNodeEnvironment(current, node, {
          ...state,
          nodeInputs: values,
          nodeInputFields: input.fields,
          nodeInputEvidence: input.evidence,
        });
        const invalid = environment.evidence.find(({ state }) => state === 'ERROR');
        if (invalid) throw fieldIssue(current, node, invalid);
        evidenceByNode.set(key, { inputs: input.evidence, environment: environment.evidence });
        const nodeScope = {
          serviceId: referenceId(values.service) ?? scope.serviceId,
          environmentId: referenceId(values.environment) ?? scope.environmentId,
        };
        if (nodeScope.serviceId) plannedServices.add(nodeScope.serviceId);
        if (
          node.type === 'SOURCE_REVIEW' ||
          node.type === 'APPROVAL' ||
          node.type === 'HEALTH_CHECK' ||
          node.type === 'ROLLBACK_ARTIFACT'
        )
          gates.push({
            flowId: current.id,
            nodeId: node.id,
            name: node.name,
            kind: node.type,
            releaseNodeId: node.approval?.releaseNodeId,
            buildNodeId: node.approval?.buildNodeId,
          });
        const checkoutAddress =
          (node.type === 'CHECKOUT' || node.type === 'BUILD') &&
          graphRepositoryUrl(values.repository);
        const selectedRepositoryId = checkoutAddress
          ? await resolveGraphRepositorySelector(
              this.database.db,
              projectId,
              checkoutAddress,
            ).catch((error: unknown) =>
              withPlanIssue(error, {
                code: 'REPOSITORY',
                flowId: current.id,
                flowName: current.name,
                nodeId: node.id,
                nodeName: node.name,
                fieldId: 'repository',
                ...nodeScope,
              }),
            )
          : undefined;
        const nativeValues = selectedRepositoryId
          ? { ...values, repository: selectedRepositoryId }
          : values;
        if (node.type === 'CHECKOUT' || (node.type === 'BUILD' && values.version))
          checkouts[node.id] = checkoutProvenance(
            current,
            node,
            nativeValues,
            input.evidence,
            trigger,
          );
        if (isDelivery(node)) {
          const delivery = await this.delivery(
            projectId,
            current,
            request.version,
            node,
            args,
            nativeValues,
            production,
            environmentSet,
            rootId,
            parameterProduction,
            automation,
          ).catch((error: unknown) => withNodePlanIssue(error, current, node, nodeScope));
          if (automation && node.type !== 'BUILD') {
            const targetIds = [
              ...new Set(
                [delivery, ...(delivery.alternatives ?? [])].flatMap((item) => item.serverIds),
              ),
            ];
            await assertAutomaticTargets(this.database.db, targetIds).catch((error: unknown) =>
              withPlanIssue(error, {
                ...nodeScope,
                code: 'RELEASE_TARGET',
                fieldId: 'targets',
                flowId: current.id,
                flowName: current.name,
                nodeId: node.id,
                nodeName: node.name,
              }),
            );
          }
          if (node.type === 'BUILD' && environment.evidence.length) {
            if (automation && environment.evidence.some(({ sensitive }) => sensitive))
              throw fieldIssue(current, node, {
                ...environment.evidence.find(({ sensitive }) => sensitive)!,
                message: '自动构建不能使用节点环境中的敏感变量',
              });
            for (const field of environment.evidence.filter(({ state }) => state === 'DEFERRED')) {
              deferred.push({
                flowId: current.id,
                nodeId: node.id,
                field: field.fieldId,
                producerNodeId: field.source?.nodeId,
                producerField: field.source?.fieldId,
              });
            }
            delivery.buildEnvironment = {
              fixed: Object.fromEntries(
                environment.evidence
                  .filter(({ state }) => state !== 'DEFERRED')
                  .map(({ fieldId }) => [
                    fieldId,
                    buildVariableFingerprint(environment.variables, fieldId),
                  ]),
              ),
              sources: environment.sources,
            };
          }
          plans.set(key, delivery);
          publishedDeliveries.push(delivery);
          if (node.type === 'BUILD' && delivery.profile) {
            const definition = delivery.profile.definition;
            const named = definition.artifacts ?? [
              { name: 'artifact', type: definition.artifactType },
            ];
            const source = {
              definition,
              commitSha: delivery.commitSha,
              serviceId: delivery.serviceId,
              environmentId: delivery.environmentId,
              sourceSnapshot: delivery.sourceSnapshot,
              serverIds: delivery.serverIds,
            };
            for (const artifact of named)
              production.set(outputKey(node.id, graphArtifactPortId(artifact)), [
                { ...source, kind: artifact.type, collection: artifact.collection },
              ]);
            if (named.length === 1)
              production.set(outputKey(node.id, 'artifacts'), [
                { ...source, kind: named[0]!.type },
              ]);
          }
        } else if (isNativeTask(node)) {
          const scriptWorkspace =
            node.type === 'SHELL' || node.type === 'CHECK'
              ? (scriptWorkspaces ??= new ScriptWorkspacePreview(
                  current,
                  selection.ordered,
                )).prepare(node, state, selection.matches)
              : undefined;
          const workspacePlan = scriptWorkspace?.plan;
          if (workspacePlan?.candidates || workspacePlan?.optional) {
            const sourceVaries =
              nodeInputBinding(current, node, 'source')?.kind === 'FIRST_AVAILABLE';
            evidenceByNode.set(key, {
              inputs: input.evidence.map((field) =>
                field.fieldId === 'workspace' || (field.fieldId === 'source' && sourceVaries)
                  ? {
                      ...field,
                      state: 'DEFERRED',
                      value: undefined,
                      source: undefined,
                      message: '由实际执行路径确定，候选来源见脚本位置',
                    }
                  : field,
              ),
              environment: environment.evidence,
            });
          }
          if (['SHELL', 'CHECK', 'HEALTH_CHECK', 'REGISTER_ARTIFACT'].includes(node.type))
            unbounded = true;
          if (!this.nodeTasks)
            withNodePlanIssue(new BadRequestException('执行节点服务不可用'), current, node);
          await this.validateNodeResources(
            projectId,
            graphScriptInputs(node),
            values,
            rootId,
          ).catch((error: unknown) => withNodePlanIssue(error, current, node, nodeScope));
          const plan = await this.nodeTasks
            .prepare(projectId, node, {
              ...nodeScope,
              environmentSet: environmentSet ?? null,
              parameters: args.parameters,
              values,
              inputEvidence: input.evidence,
              scriptWorkspace,
              trigger,
              automation,
              fetchModeDeferred: input.evidence.some(
                ({ fieldId, state }) => fieldId === 'fetchMode' && state === 'DEFERRED',
              ),
              nodeEnvironment: environment.variables,
              nodeEnvironmentSources: environment.sources,
            })
            .catch((error: unknown) => withNodePlanIssue(error, current, node, nodeScope));
          if (
            (plan.type === 'SHELL' || plan.type === 'CHECK') &&
            node.shell?.artifactPath?.trim()
          ) {
            const path = normalizeRelativePath(node.shell.artifactPath.trim());
            const binding = nodeInputBinding(current, node, 'artifact');
            const evidence = input.evidence.find(({ fieldId }) => fieldId === 'artifact');
            if (evidence?.state === 'DEFERRED') {
              plan.artifact = { path, producers: outputSources(binding) };
            } else {
              const instance = await this.scriptArtifactInstance(
                projectId,
                values.artifact,
                rootId,
                plan.serverId,
                path,
              ).catch((error: unknown) => withNodePlanIssue(error, current, node, nodeScope));
              plan.artifact = { path, instances: [instance] };
            }
          }
          if (automation && plan.type === 'HEALTH_CHECK' && !plan.scope) {
            const predecessors = outputSources(nodeInputBinding(current, node, 'release'));
            const targetIds = [
              ...new Set(
                predecessors.flatMap(({ nodeId }) => {
                  const source = plans.get(planKey(current.id, nodeId));
                  return source && 'serverIds' in source
                    ? [source, ...(source.alternatives ?? [])].flatMap((item) => item.serverIds)
                    : [];
                }),
              ),
            ];
            if (!targetIds.length)
              throw new ExecutionPlanIssueError({
                code: 'RELEASE_TARGET',
                flowId: current.id,
                nodeId: node.id,
                fieldId: 'targets',
                message: '自动健康检查需要明确指定目标或绑定本流程已预检的发布结果',
              });
            await assertAutomaticTargets(this.database.db, targetIds).catch((error: unknown) =>
              withPlanIssue(error, {
                ...nodeScope,
                code: 'RELEASE_TARGET',
                fieldId: 'targets',
                flowId: current.id,
                flowName: current.name,
                nodeId: node.id,
                nodeName: node.name,
              }),
            );
          }
          plans.set(key, plan);
          if (plan.type === 'LOAD_ENV') {
            outputs.set(node.id, {
              variables: {
                environmentFile: plan.environmentFile,
                environmentId: plan.environmentId,
              },
            });
            const file = publicEnvironmentFile(plan.environmentFile);
            if (file) environmentFiles.push({ flowId: current.id, nodeId: node.id, ...file });
            nativeVariables.push(
              ...(plan.variables ?? []).map(({ key, source, isSecret, overriddenSources }) => ({
                flowId: current.id,
                nodeId: node.id,
                key,
                source,
                sensitive: isSecret,
                overriddenSources,
              })),
            );
          } else if (plan.type === 'SHELL' || plan.type === 'CHECK') {
            scriptsPrepared.push({ flowId: current.id, nodeId: node.id, plan });
            nativeVariables.push(
              ...(plan.variableSources ?? []).map(
                ({ key, source, isSecret, overriddenSources }) => ({
                  flowId: current.id,
                  nodeId: node.id,
                  key,
                  source,
                  sensitive: isSecret,
                  overriddenSources,
                }),
              ),
            );
          }
          const declarations = graphArtifactDeclarations(node);
          if (declarations?.length) {
            const origins = workspacePlan
              ? [
                  ...(workspacePlan.candidates ?? [workspacePlan]),
                  ...(workspacePlan.optional ? [undefined] : []),
                ]
              : [values.workspace as Values | undefined];
            const sources = new Map<string, PreparedProduction>();
            for (const origin of origins) {
              const repositoryId =
                stringValue(origin?.repositoryId) ?? unversionedArtifactRepository;
              const commitSha = stringValue(origin?.commitSha) ?? unversionedArtifactCommit;
              sources.set(`${repositoryId}:${commitSha}`, {
                definition: Object.assign(new PipelineDefinitionDto(), { repositoryId }),
                commitSha,
                serviceId: referenceId(values.service) ?? scope.serviceId,
                environmentId: referenceId(values.environment) ?? scope.environmentId,
                ...(repositoryId !== unversionedArtifactRepository && {
                  sourceSnapshot: [{ repositoryId, commitSha }],
                }),
                ...('serverId' in plan && plan.serverId && { serverIds: [plan.serverId] }),
              });
            }
            for (const artifact of declarations)
              production.set(
                outputKey(node.id, graphArtifactPortId(artifact)),
                [...sources.values()].map((source) => ({ ...source, kind: artifact.type })),
              );
            if (declarations.length === 1)
              production.set(
                outputKey(node.id, 'artifacts'),
                [...sources.values()].map((source) => ({ ...source, kind: declarations[0]!.type })),
              );
          }
          if (plan.type === 'CHECKOUT') {
            const { repositoryId, repositoryName, ref, branch, tag, commitSha, fullClone } =
              plan.source;
            if (selectedRepositoryId && selectedRepositoryId !== repositoryId)
              throw fieldIssue(current, node, {
                fieldId: 'repository',
                name: '仓库',
                type: 'REPOSITORY',
                state: 'ERROR',
                message: '仓库地址匹配的项目仓库已变化，请重新预览',
              });
            outputs.set(
              node.id,
              graphCheckoutOutputs(plan.source, undefined, undefined, plan.fetchModeDeferred),
            );
            const mode = plan.fetchModeDeferred
              ? { fetchModeDeferred: true as const }
              : { fetchMode: graphCheckoutFetchMode(fullClone) };
            checkouts[node.id] = {
              ...checkouts[node.id]!,
              ...mode,
              ...(plan.source.eventPinned && {
                versionSource: 'TRIGGER_COMMIT',
                requestedVersion: { kind: 'COMMIT', value: commitSha },
              }),
            };
            checkoutRows.push({
              nodeId: node.id,
              flowId: current.id,
              repositoryId,
              repositoryName,
              ref,
              branch,
              tag,
              commitSha,
              ...(!plan.fetchModeDeferred && { fullClone }),
              ...checkouts[node.id]!,
            });
          } else if (plan.type === 'SHELL' || plan.type === 'CHECK') {
            if (scriptWorkspace)
              scriptWorkspaces?.recordOutputs(node.id, scriptWorkspace.inputs, !plan.serverId);
            if (!plan.serverId && values.workspace)
              outputs.set(node.id, { workspace: values.workspace });
            scripts.push({
              nodeId: node.id,
              flowId: current.id,
              serverId: plan.serverId,
              serverName: plan.serverName,
              serviceId: plan.serviceId,
              environmentId: plan.environmentId,
              directory: plan.directory,
              workspace: plan.workspace,
              artifact: plan.artifact,
            });
          }
        } else if (child) {
          const bound = values;
          const pending = input.evidence.filter(({ state }) => state === 'DEFERRED');
          const forwarded = new Map<string, PreparedProduction[]>();
          for (const field of pending) {
            if (field.type !== 'ARTIFACT') continue;
            const binding =
              current.compiled?.nodes[node.id]?.inputBindings[field.fieldId] ??
              current.inputBindings?.[node.id]?.[field.fieldId];
            const options = outputSources(binding).flatMap(
              ({ nodeId, fieldId }) => production.get(outputKey(nodeId, fieldId)) ?? [],
            );
            if (binding?.kind === 'INPUT')
              options.push(...(parameterProduction.get(binding.fieldId) ?? []));
            if (options.length) forwarded.set(field.fieldId, options);
          }
          const unresolved = pending.find(({ fieldId }) => !forwarded.has(fieldId));
          if (unresolved && childRequiresFixedPlan(child, definition))
            throw new ExecutionPlanIssueError({
              code: 'INPUT',
              flowId: current.id,
              nodeId: node.id,
              fieldId: unresolved.fieldId,
              sourceNodeId: unresolved.source?.nodeId,
              sourceFieldId: unresolved.source?.fieldId,
              message: '子流使用外部资源，该参数需要在预览时固定',
            });
          if (unresolved) unbounded = true;
          if (!unresolved) {
            const childArgs = await this.resolveParameters(
              projectId,
              child,
              {
                ...args,
                parameters: bound,
              },
              rootId,
              new Set(forwarded.keys()),
            );
            const prepared = await prepareFlow(
              child,
              childArgs,
              digest(bound),
              Object.fromEntries(
                input.evidence.flatMap((entry) =>
                  entry.source ? [[entry.fieldId, entry.source]] : [],
                ),
              ),
              forwarded,
            );
            children[node.id] = prepared;
            outputs.set(node.id, prepared.confirmedOutputs);
            for (const [fieldId, sources] of Object.entries(prepared.produced))
              production.set(outputKey(node.id, fieldId), sources);
          }
        }
        if (outputs.has(node.id)) {
          selection = flowSelection(current, args, state);
          previewSelected = selection.selected;
        }
      }
      const produced: Record<string, PreparedProduction[]> = Object.create(null);
      const confirmedOutputs: Values = Object.create(null);
      await this.completeArtifactParameters(
        projectId,
        current,
        args,
        new Set(parameterProduction.keys()),
      );
      evidenceByNode.set(planKey(current.id, flowEnd(current).id), {
        outputFields: inspectFlowOutputs(current, state).evidence,
      });
      for (const [fieldId, binding] of Object.entries(current.outputBindings ?? {})) {
        const value = bindingValue(binding, state);
        if (value !== undefined) confirmedOutputs[fieldId] = value;
        const sources = outputSources(binding).flatMap(
          (source) => production.get(outputKey(source.nodeId, source.fieldId)) ?? [],
        );
        if (binding.kind === 'INPUT')
          sources.push(...(parameterProduction.get(binding.fieldId) ?? []));
        if (sources.length) produced[fieldId] = sources;
      }
      if (current.id === flowId)
        rootRouting = graphPreviewRouting(current, flowSelection(current, args, state));
      return {
        inputHash,
        ...(parameterProduction.size && {
          deferredArtifactFields: [...parameterProduction.keys()],
        }),
        inputs: args,
        environmentSet: environmentSetSummary(environmentSet),
        frozenEnvironment: environmentSet,
        parameterSources: sources,
        checkoutProvenance: checkouts,
        selectedNodeIds: [...previewSelected],
        plans: Object.fromEntries(plans),
        children,
        produced,
        confirmedOutputs,
      };
    };
    const pendingProduction = new Map<string, PreparedProduction[]>();
    for (const field of flowStart(flow).inputs ?? []) {
      if (!pendingArtifactParameters?.has(field.id)) continue;
      pendingProduction.set(field.id, [
        {
          definition: Object.assign(new PipelineDefinitionDto(), {
            repositoryId: unversionedArtifactRepository,
          }),
          commitSha: unversionedArtifactCommit,
          kind: field.artifactType,
          externalPreflight: true,
        },
      ]);
    }
    const prepared = await prepareFlow(flow, inputs, '', parameterSources, pendingProduction);
    const sourceEvent = graphCheckoutEvent(trigger);
    if (
      sourceEvent &&
      !checkoutRows.some(
        (row) =>
          graphCheckoutEvent(trigger, row.nodeId) &&
          row.versionSource === 'TRIGGER_COMMIT' &&
          row.repositoryId === sourceEvent.repositoryId &&
          row.ref === sourceEvent.ref &&
          row.commitSha === sourceEvent.commitSha,
      )
    )
      throw graphInputIssue(flow, '源码事件未匹配已发布配置中的检出仓库和分支');
    if (authorizePlan) {
      const deliveries = publishedDeliveries.flatMap((plan) => [
        plan,
        ...(plan.alternatives ?? []),
      ]);
      const unique = (values: (string | undefined)[]) => [
        ...new Set(values.filter((value): value is string => Boolean(value))),
      ];
      await authorizePlan({
        serverIds: unique([
          ...deliveries.flatMap(({ serverIds, artifactRefs }) => [
            ...serverIds,
            ...(artifactRefs ?? []).map((ref) => stringValue(ref.serverId)),
          ]),
          ...scripts.map(({ serverId }) => serverId),
        ]),
        repositoryIds: unique([
          ...checkoutRows.map(({ repositoryId }) => repositoryId),
          ...scripts.flatMap(({ workspace }) =>
            workspace
              ? (workspace.candidates ?? [workspace]).map(({ repositoryId }) => repositoryId)
              : [],
          ),
          ...environmentFiles.map((file) =>
            'repositoryId' in file ? file.repositoryId : undefined,
          ),
          ...deliveries.flatMap((plan) => {
            const source = plan.profile?.delivery?.composeSource;
            return [
              ...(plan.sourceSnapshot ?? []).map(({ repositoryId }) => repositoryId),
              source?.kind === 'REPOSITORY_FILE' ? source.repositoryId : undefined,
            ];
          }),
        ]).filter((id) => id !== unversionedArtifactRepository),
        serviceIds: unique([
          ...deliveries
            .filter(({ serviceUnscoped }) => !serviceUnscoped)
            .map(({ serviceId }) => serviceId),
          ...plannedServices,
          flow.compiled?.presetResourceGroups ? undefined : flow.serviceId,
        ]),
        unbounded,
      });
    }
    const selectedNodes = new Set(prepared.selectedNodeIds);
    const edgeKey = ({ from, to, when }: { from: string; to: string; when?: string }) =>
      JSON.stringify([from, to, when]);
    const rootNodeIds = new Set(flow.nodes.map(({ id }) => id));
    const rootEdges = new Set(flow.edges.map(edgeKey));
    const routing = [
      ...(rootRouting?.edges ?? []),
      ...(definition.canvas?.edges ?? [])
        .filter((edge) => rootNodeIds.has(edge.from) && !rootEdges.has(edgeKey(edge)))
        .map((edge) => ({ ...edge, status: 'OUTSIDE_FLOW' as const })),
    ];
    const publicDeliveries = publishedDeliveries.map((delivery) =>
      publicDelivery(delivery, definition),
    );
    const executionPlan = {
      targets: publishedDeliveries.flatMap(({ flowId, nodeId, configuration }) =>
        configuration ? [{ flowId, nodeId, ...configuration.targets }] : [],
      ),
      settings: publishedDeliveries.flatMap(({ flowId, nodeId, configuration }) =>
        (configuration?.settings ?? []).map((item) => ({ flowId, nodeId, ...item })),
      ),
      environmentFiles: [
        ...environmentFiles,
        ...publishedDeliveries.flatMap(({ flowId, nodeId, environmentFile }) => {
          const file = publicEnvironmentFile(environmentFile);
          return file ? [{ flowId, nodeId, ...file }] : [];
        }),
      ],
      variables: [
        ...nativeVariables,
        ...publishedDeliveries.flatMap(
          ({ flowId, nodeId, configuration, environmentFile, buildEnvironment }) =>
            graphVariableSources(
              environmentFile,
              (configuration?.variables ?? []).map(({ key, source, sensitive, ...meta }) => ({
                key,
                source,
                isSecret: sensitive,
                ...meta,
              })),
              buildEnvironment?.sources,
            ).map(({ key, source, isSecret, overriddenSources }) => ({
              flowId,
              nodeId,
              key,
              source,
              sensitive: isSecret,
              overriddenSources,
            })),
        ),
      ],
      deferred,
    };
    const planSections: Record<string, string> = Object.create(null);
    const section = (flowId: string, nodeId: string, label: string, value: unknown) => {
      const flowName = definition.flows.find(({ id }) => id === flowId)?.name;
      const nodeName = definition.flows
        .find(({ id }) => id === flowId)
        ?.nodes.find(({ id }) => id === nodeId)?.name;
      planSections[
        `${flowName ?? flowId} / ${nodeName ?? nodeId}（${flowId}/${nodeId}） · ${label}`
      ] = digest(value);
    };
    for (const row of executionPlan.targets) section(row.flowId, row.nodeId, '执行目标及成员', row);
    for (const row of executionPlan.settings) section(row.flowId, row.nodeId, row.field, row);
    for (const row of executionPlan.environmentFiles)
      section(row.flowId, row.nodeId, '环境文件', row);
    for (const row of checkoutRows) section(row.flowId, row.nodeId, '检出仓库与提交', row);
    section(flowId, flowStart(flow).id, '变量集合及修订', prepared.environmentSet);
    section(flowId, flowStart(flow).id, '执行路线', routing);
    for (const { flowId, nodeId, plan } of scriptsPrepared) {
      if (plan.type !== 'SHELL' && plan.type !== 'CHECK') continue;
      section(flowId, nodeId, '执行目标及成员', [plan.serverId, plan.serverName, plan.targetHash]);
      section(flowId, nodeId, '脚本工作区和执行目录', [
        plan.workspace,
        plan.directory,
        plan.targetWorkspaceRoot,
      ]);
      section(flowId, nodeId, '变量及其来源', [
        plan.variableSources,
        createHmac('sha256', encryptionKey())
          .update('execution-plan:native-vars\0')
          .update(digest(plan.environment ?? null))
          .digest('hex'),
      ]);
    }
    for (const row of publishedDeliveries) {
      section(row.flowId, row.nodeId, '变量及其来源', [
        row.configuration?.variableFingerprint,
        row.buildEnvironment?.fixed,
        executionPlan.variables.filter(
          (item) => item.flowId === row.flowId && item.nodeId === row.nodeId,
        ),
      ]);
      section(row.flowId, row.nodeId, '源码、产物和发布审批', [
        row.sourceSnapshot,
        row.artifactRefs,
        row.artifactIds,
        row.artifactFromNodeId,
        row.artifactFromField,
        row.alternatives?.map(({ sourceSnapshot, artifactFromNodeId, artifactFromField }) => [
          sourceSnapshot,
          artifactFromNodeId,
          artifactFromField,
        ]),
        row.requireCodeReview,
        row.sourceReviews,
        row.sourceReviewPendingMaterialization,
        row.requireApproval,
        row.profile?.delivery,
        row.rollbackBaseline,
        row.composeTemplate,
      ]);
    }
    const configurationHash = digest([
      graphId,
      request.version,
      flowId,
      inputs,
      trigger,
      prepared,
      credentials,
      routing,
    ]);
    const preview = {
      ...publicDeliveries[0],
      projectId,
      graphId,
      flowId,
      flowName: flow.name,
      version: request.version,
      configurationHash,
      environmentSet: prepared.environmentSet,
      parameters: publicParameters(flow, inputs.parameters),
      parameterSources,
      routing,
      nodes: orderedFlowNodes(flow).map(({ id, name, type }) => ({
        nodeId: id,
        name,
        type,
        selected: selectedNodes.has(id),
        conditional: selectedNodes.has(id) && rootRouting?.certain.has(id) === false,
        ...evidenceByNode.get(planKey(flow.id, id)),
      })),
      deliveries: publicDeliveries,
      checkouts: checkoutRows,
      scripts,
      gates,
      executionPlan,
      planSections,
    };
    return {
      preview,
      flow,
      inputs,
      plans: prepared.plans,
      children: prepared.children,
      environmentSet: prepared.environmentSet,
      frozenEnvironment: prepared.frozenEnvironment,
      parameterSources,
      checkoutProvenance: prepared.checkoutProvenance,
      credentials,
      environmentSets: await Promise.all(sets.values()),
      simplified: undefined,
    };
  }

  async preview(
    projectId: string,
    flowId: string,
    request: GraphPreviewDto,
    context?: PlanContext,
  ) {
    return (await this.prepare(projectId, flowId, request, context)).preview;
  }
  private async lockProject(tx: Transaction<Database>, projectId: string) {
    const active = await tx
      .updateTable('projects')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!active) throw new NotFoundException('项目不存在或已归档');
  }

  private async insertRun(
    tx: Transaction<Database>,
    values: Parameters<typeof this.runValues>[0],
    flow: GraphFlow,
    inputs: GraphInputsDto,
    deliveries: Record<string, Delivery | GraphNodePlan>,
  ) {
    const snapshot = JSON.parse(values.inputs_json) as RunSnapshot;
    const placement = snapshot.simplified?.placement;
    const serverId = placement?.location === 'TARGET' && !values.parent_run_id
      ? placement.target.id
      : null;
    const queuedAt = serverId ? await nextServerWorkOrder(tx, serverId) : Date.now();
    const row = await tx
      .insertInto('execution_flow_runs')
      .values({
        ...this.runValues(values),
        execution_server_id: serverId,
        created_at: queuedAt,
      })
      .onConflict((c) => c.columns(['project_id', 'created_by', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!row) return undefined;
    const initialContext = snapshot.simplified
      ? undefined
      : {
          ...bindingContext(values.project_id, flow, inputs, undefined, snapshot.trigger),
          environmentSet: snapshot.frozenEnvironment,
          parameterSources: snapshot.parameterSources,
        };
    const { ordered, selected } = flowSelection(flow, inputs, initialContext);
    await tx
      .insertInto('execution_node_runs')
      .values(
        ordered.map((node, position) => ({
          id: randomUUID(),
          run_id: row.id,
          node_id: node.id,
          node_type: node.type,
          name: node.name,
          position,
          status: selected.has(node.id) ? 'PENDING' : 'SKIPPED',
          finished_at: selected.has(node.id) ? null : row.created_at,
          dispatch_json: Object.hasOwn(deliveries, planKey(flow.id, node.id))
            ? JSON.stringify(deliveries[planKey(flow.id, node.id)])
            : Object.hasOwn(deliveries, node.id)
              ? JSON.stringify(deliveries[node.id])
              : null,
          log: selected.has(node.id) ? '' : '条件分支未被选中。',
        })),
      )
      .execute();
    await this.audit.record(
      row.created_by,
      'execution-flow.run',
      'flow-run',
      row.id,
      {
        projectId: row.project_id,
        flowId: row.flow_id,
        version: row.version,
        parentRunId: row.parent_run_id,
        triggerType: row.trigger_type ?? (row.parent_run_id ? 'FLOW_CALL' : 'MANUAL'),
      },
      tx,
    );
    return row;
  }

  private runValues(
    values: Omit<
      Run,
      'created_at' | 'finished_at' | 'status' | 'task_id' | 'trigger_type' | 'workspace_path'
      | 'execution_server_id' | 'execution_admitted_at'
    > &
      Pick<Partial<Run>, 'trigger_type'>,
  ) {
    return { ...values, status: 'QUEUED', created_at: Date.now() };
  }

  private async confirmLatestVersion(db: Kysely<Database>, projectId: string, version: number) {
    const graph = await db
      .selectFrom('execution_graphs')
      .select('published_version')
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    if (graph?.published_version !== version)
      throw new ConflictException('已发布版本已变化，请刷新后运行');
  }

  async runDefaults(
    projectId: string,
    flowId: string,
    request: GraphRunDefaultsDto,
    userId: string,
  ) {
    const db = this.database.db;
    await requireProject(db, projectId);
    const requestIdentity = digest(['MANUAL_DEFAULTS', flowId, request.version]);
    const previous = await db
      .selectFrom('execution_flow_runs')
      .select(['id', 'request_hash', 'version'])
      .where('project_id', '=', projectId)
      .where('created_by', '=', userId)
      .where('idempotency_key', '=', request.idempotencyKey)
      .executeTakeFirst();
    if (previous) {
      checkRequest(previous, requestIdentity);
      this.currentFlow((await this.published(projectId, request.version)).definition, flowId);
      await this.advance(previous.id);
      return { outcome: 'STARTED' as const, runId: previous.id, version: previous.version };
    }
    await this.confirmLatestVersion(db, projectId, request.version);
    const preview = await this.preview(projectId, flowId, { version: request.version });
    const gate = preview.gates.find(
      ({ kind }) => kind === 'APPROVAL' || kind === 'SOURCE_REVIEW' || kind === 'ROLLBACK_ARTIFACT',
    );
    const release = preview.deliveries.find(
      (entry) => entry.requireApproval || entry.requireCodeReview,
    );
    if (gate || release)
      return {
        outcome: 'NEEDS_CONFIRMATION' as const,
        version: request.version,
        nodeId: gate?.nodeId ?? release?.nodeId,
        reason: '请预览发布条件和目标后确认运行',
      };
    const run = await this.run(
      projectId,
      flowId,
      {
        ...request,
        expectedConfigurationHash: preview.configurationHash,
        expectedPlanSections: preview.planSections,
      },
      userId,
      undefined,
      {
        requestIdentity,
        beforeInsert: (tx) => this.confirmLatestVersion(tx, projectId, request.version),
      },
    );
    return { outcome: 'STARTED' as const, runId: run.id, version: run.version };
  }

  async run(
    projectId: string,
    flowId: string,
    request: GraphRunDto,
    userId: string,
    origin?: AutomaticRunOrigin,
    control?: GraphRunControl,
  ) {
    const db = this.database.db;
    const requestHash =
      control?.requestIdentity ??
      digest([
        flowId,
        request.version,
        request.inputs ?? {},
        request.expectedConfigurationHash,
        ...(origin ? [origin.triggerType] : []),
      ]);
    await requireProject(db, projectId);
    const previous = () =>
      db
        .selectFrom('execution_flow_runs')
        .select(['id', 'request_hash'])
        .where('project_id', '=', projectId)
        .where('created_by', '=', userId)
        .where('idempotency_key', '=', request.idempotencyKey)
        .executeTakeFirst();
    const old = await previous();
    if (old) {
      checkRequest(old, requestHash);
      this.currentFlow((await this.published(projectId, request.version)).definition, flowId);
      if (!control) await this.advance(old.id);
      return this.get(projectId, old.id);
    }
    const {
      preview,
      flow,
      plans,
      inputs,
      children,
      environmentSets,
      environmentSet,
      frozenEnvironment,
      checkoutProvenance,
      parameterSources,
      credentials,
      simplified,
    } = await this.prepare(projectId, flowId, request, {
      trigger: origin?.metadata,
      automation: origin?.authorization,
      authorizePlan: control?.authorizePlan,
    }).catch((error: unknown) => {
      if (request.expectedPlanSections && error instanceof HttpException && error.getStatus() < 500)
        throw new ConflictException({
          message: '配置已失效，请重新预览',
          changes: [error.message],
        });
      throw error;
    });
    if (request.expectedConfigurationHash !== preview.configurationHash)
      throw new ConflictException({
        message: '版本、运行参数或实际执行配置已变化，请重新预览',
        changes: request.expectedPlanSections
          ? [
              ...Object.keys(preview.planSections).filter(
                (section) =>
                  request.expectedPlanSections?.[section] !== preview.planSections[section],
              ),
              ...(Object.keys(request.expectedPlanSections).some(
                (section) => !Object.hasOwn(preview.planSections, section),
              )
                ? ['旧计划中的节点或配置来源已变化']
                : []),
            ].slice(0, 30)
          : [],
      });
    const row = await db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await this.lockProject(tx, projectId);
      const confirmed = await this.published(projectId, request.version, tx, true);
      if (simplified) {
        const referenced = [
          simplified.release?.artifactId,
          simplified.workspaceSource?.artifactId,
        ].filter((id): id is string => Boolean(id));
        if (referenced.length) await lockAvailableArtifacts(tx, referenced);
        await this.simplifiedRuns!.confirm(tx, simplified, projectId);
      }
      for (const previous of environmentSets) {
        const latest = await resolveEnvironmentSet(tx, projectId, previous.id).catch(
          (error: unknown) => {
            if (!(error instanceof HttpException)) throw error;
            throw new ConflictException('变量集合已变化，请重新预览');
          },
        );
        if (digest(latest) !== digest(previous))
          throw new ConflictException('变量集合已变化，请重新预览');
      }
      // V2 plans also freeze encrypted values resolved from project variable collections.
      const confirmedCredentialTypes = simplified
        ? [...variableCredentialTypes, variableCredentialType]
        : variableCredentialTypes;
      for (const [credentialId, nonce] of Object.entries(credentials)) {
        const active = await tx
          .selectFrom('credentials')
          .select('id')
          .where('id', '=', credentialId)
          .where('nonce', '=', nonce)
          .where('status', '=', 'ACTIVE')
          .where('type', 'in', confirmedCredentialTypes)
          .executeTakeFirst();
        if (!active) throw new ConflictException('节点引用的凭据已变化，请重新预览');
      }
      if (
        simplified ||
        confirmed.definition.flows.some(({ nodes }) =>
          nodes.some((node) => isDelivery(node) || graphArtifactDeclarations(node)?.length),
        )
      )
        await ensureGraphDeliveryEnvironment(tx, projectId);
      if (
        simplified ||
        confirmed.definition.flows.some(({ nodes }) =>
          nodes.some((node) => node.type === 'BUILD' || graphArtifactDeclarations(node)?.length),
        )
      ) {
        await ensureGraphUnscopedArtifactService(tx, projectId);
      }
      const validateTargets = async (plan: Delivery | GraphNodePlan) => {
        if (!('pipelineId' in plan)) {
          if (plan.type === 'SHELL' || plan.type === 'CHECK') {
            if (plan.serverId && plan.targetSelection)
              await confirmDeploymentMembers(tx, plan.targetSelection, [plan.serverId]);
            if (plan.artifact?.instances?.length)
              await lockAvailableArtifacts(tx, plan.artifact.instances);
          }
          return;
        }
        if (plan.configuration?.targetSelection)
          await confirmDeploymentMembers(tx, plan.configuration.targetSelection, plan.serverIds);
        if (plan.artifactIds.length) await lockAvailableArtifacts(tx, plan.artifactIds);
        for (const alternative of plan.alternatives ?? []) await validateTargets(alternative);
      };
      const validateChildTargets = async (child: PreparedChild) => {
        for (const plan of Object.values(child.plans)) await validateTargets(plan);
        for (const nested of Object.values(child.children)) await validateChildTargets(nested);
      };
      for (const plan of Object.values(plans)) await validateTargets(plan);
      for (const child of Object.values(children)) await validateChildTargets(child);
      const references = runResourceReferences(
        confirmed.definition,
        {
          sourceId: preview.graphId,
          version: request.version,
          flowId,
          state: 'PENDING',
        },
        {
          inputs,
          environmentSet,
          frozenEnvironment,
          credentials,
          deliveries: plans,
          children,
          simplified,
        },
      );
      if (
        await unavailableReference(
          tx,
          projectId,
          references.filter(
            (reference) =>
              reference.resourceType !== 'SERVICE' ||
              reference.resourceId !== graphUnscopedArtifactService(projectId).id,
          ),
        )
      )
        throw new ConflictException('计划引用的资源已变化，请重新预览');
      await origin?.beforeInsert?.(tx);
      await control?.beforeInsert?.(tx);
      const inserted = await this.insertRun(
        tx,
        {
          id: randomUUID(),
          project_id: projectId,
          graph_id: preview.graphId,
          version: request.version,
          flow_id: flowId,
          flow_name: flow.name,
          created_by: userId,
          parent_run_id: null,
          trigger_type: origin?.triggerType ?? null,
          idempotency_key: request.idempotencyKey,
          request_hash: requestHash,
          configuration_hash: preview.configurationHash,
          inputs_json: JSON.stringify({
            inputs,
            environmentSet,
            frozenEnvironment,
            checkoutProvenance,
            parameterSources,
            credentials,
            simplified,
            deliveries: plans,
            children,
            trigger: origin?.metadata,
            automation: origin?.authorization,
          }),
        },
        flow,
        inputs,
        plans,
      );
      if (inserted) {
        await origin?.afterInsert?.(tx, inserted.id);
        await control?.afterInsert?.(tx, inserted.id);
      }
      return inserted;
    });
    if (!row) {
      const stored = (await previous())!;
      checkRequest(stored, requestHash);
      // The other submitter may have committed the graph but not yet dispatched its ready nodes.
      if (!control) await this.advance(stored.id);
      return this.get(projectId, stored.id);
    }
    await this.advance(row.id);
    return this.get(projectId, row.id);
  }

  private lockRun(tx: Transaction<Database>, id: string) {
    return tx
      .updateTable('execution_flow_runs')
      .set((eb) => ({ status: eb.ref('status') }))
      .where('id', '=', id)
      .where('status', 'in', activeFlowStatuses)
      .returningAll()
      .executeTakeFirst();
  }

  private async terminalNode(
    tx: Transaction<Database>,
    node: NodeRun,
    status: string,
    log: string,
    output?: object,
    startedAt = node.started_at,
    finishedAt = Date.now(),
  ) {
    const clean = redactTaskLog(log);
    await tx
      .updateTable('execution_node_runs')
      .set({
        status,
        log: clean,
        started_at: startedAt,
        finished_at: finishedAt,
        output_json: output ? JSON.stringify(output) : null,
      })
      .where('id', '=', node.id)
      .execute();
    node.status = status;
    node.output_json = output ? JSON.stringify(output) : null;
  }

  private async recordDeclaredOutputs(
    tx: Transaction<Database>,
    row: NodeRun,
    flow: GraphFlow,
    node: GraphNode,
    output?: Values,
  ) {
    const outputFields = inspectDeclaredNodeOutputs(
      node,
      output,
      flow.compiled?.nodes[node.id]?.outputs,
    );
    if (!outputFields.length) return;
    const evidence = row.evidence_json ? (JSON.parse(row.evidence_json) as NodeEvidence) : {};
    evidence.outputFields = outputFields;
    const invalid = outputFields.find(({ state }) => state === 'ERROR');
    if (invalid) evidence.issue = fieldIssue(flow, node, invalid).issue;
    row.evidence_json = JSON.stringify(evidence);
    await tx
      .updateTable('execution_node_runs')
      .set({ evidence_json: row.evidence_json })
      .where('id', '=', row.id)
      .execute();
    return invalid ? evidence.issue?.message : undefined;
  }

  private async taskArtifacts(taskIds: string[], db = this.database.db) {
    if (!taskIds.length) return [];
    return db
      .selectFrom('artifacts as a')
      .innerJoin('pipeline_runs as p', 'a.pipeline_run_id', 'p.id')
      .select(['a.id', 'p.task_id as taskId'])
      .where('p.task_id', 'in', taskIds)
      .orderBy('a.id')
      .execute();
  }

  private rollbackExpected(delivery: Delivery, value: unknown) {
    if (delivery.profile?.delivery?.rollback !== 'AFTER_RELEASE') return delivery.rollbackBaseline;
    const result = graphReleaseResult(value);
    if (
      result.operation !== 'CHECK' ||
      result.healthStatus !== 'UNHEALTHY' ||
      !result.targets.some(
        ({ health, probeExitCode }) =>
          health === 'UNHEALTHY' && probeExitCode === unhealthyGraphProbeExitCode,
      ) ||
      result.serviceId !== delivery.serviceId ||
      !sameIds(
        result.targets.map(({ serverId }) => serverId),
        delivery.serverIds,
      ) ||
      result.targets.some(
        ({ health, status, probeExitCode, deploymentId }) =>
          status !== 'SUCCESS' ||
          !deploymentId ||
          !(
            (health === 'HEALTHY' && probeExitCode === 0) ||
            (health === 'UNHEALTHY' && probeExitCode === unhealthyGraphProbeExitCode)
          ),
      )
    )
      throw new ConflictException('回滚需要同一服务和目标上明确不健康的发布结果');
    return Object.fromEntries(
      result.targets.map(({ serverId, deploymentId }) => [serverId, deploymentId!]),
    );
  }

  private async releaseScope(
    db: Kysely<Database>,
    run: Run,
    rootId: string,
    releaseNodeId: string,
    plan: Delivery,
    values: Values,
  ): Promise<Extract<GraphGateScope, { kind: 'RELEASE' }>> {
    const refs = await this.artifactReferences(
      run.project_id,
      artifactBindingRefs(values.artifact ?? plan.artifactIds),
      undefined,
      { db, rootId, targets: plan.serverIds, single: true },
    );
    if (!refs.length || refs.some(({ serviceId }) => serviceId !== plan.serviceId))
      throw new ConflictException('审批需要已登记且归属当前服务的实际产物');
    const artifactIds = refs.map(({ id }) => id).sort();
    if (plan.artifactIds.length && digest([...plan.artifactIds].sort()) !== digest(artifactIds))
      throw new ConflictException('待审批的产物实例与确认计划不一致');
    const artifacts = await db
      .selectFrom('artifacts')
      .selectAll()
      .where('id', 'in', artifactIds)
      .execute();
    if (artifacts.length !== artifactIds.length)
      throw new ConflictException('待审批的产物实例已变化');
    return {
      kind: 'RELEASE',
      releaseNodeId,
      serviceId: plan.serviceId,
      serverIds: [...plan.serverIds].sort(),
      artifactIds,
      artifactFingerprints: artifacts.map(deploymentFingerprint).sort(),
      rollbackBaseline: this.rollbackExpected(plan, values.afterRelease),
    };
  }

  private async sourceReviewScope(
    db: Kysely<Database>,
    run: Run,
    node: GraphNode,
    rootId: string,
    nodes: ReadonlyMap<string, NodeRun>,
    flow: GraphFlow,
    bindings: Parameters<typeof inspectNodeInputs>[2],
  ): Promise<Extract<GraphGateScope, { kind: 'SOURCE_REVIEW' }>> {
    const buildNodeId = node.approval?.buildNodeId;
    if (buildNodeId) {
      const target = nodes.get(buildNodeId);
      if (target?.node_type !== 'BUILD' || !target.dispatch_json || target.status === 'SKIPPED')
        throw new ConflictException('找不到待审核的已确认构建计划');
      const build = JSON.parse(target.dispatch_json) as Delivery;
      if (build.nodeId !== buildNodeId || build.flowId !== run.flow_id)
        throw new ConflictException('已确认的构建计划与本次审核范围不一致');
      const sources = reviewSources(build.sourceSnapshot ?? []);
      if (!sources.length) throw new ConflictException('构建计划缺少已固定的源码来源');
      return { kind: 'SOURCE_REVIEW', buildNodeId, sources, artifactIds: [] };
    }

    const input = inspectNodeInputs(flow, node, bindings);
    const invalid = input.evidence.find(({ state }) => state === 'ERROR' || state === 'DEFERRED');
    if (invalid) throw fieldIssue(flow, node, invalid);
    const source = input.values.source as { repositoryId: string; commitSha: string } | undefined;
    if (source) return { kind: 'SOURCE_REVIEW', sources: reviewSources([source]), artifactIds: [] };

    const refs = await this.artifactReferences(
      run.project_id,
      artifactBindingRefs(input.values.artifact),
      undefined,
      { db, rootId },
    );
    const artifactIds = refs.map(({ id }) => id).sort();
    return {
      kind: 'SOURCE_REVIEW',
      sources: await artifactReviewSources(db, artifactIds),
      artifactIds,
    };
  }

  private async waitAtNode(
    tx: Transaction<Database>,
    row: NodeRun,
    node: GraphNode,
    now: number,
    scope?: GraphGateScope,
    configurationHash?: string,
  ) {
    const startedAt = row.started_at ?? now;
    if (node.type === 'DELAY') {
      const wakeAt = startedAt + node.delaySeconds! * 1000;
      if (wakeAt <= now) {
        await this.terminalNode(tx, row, 'SUCCESS', '延时已完成。', { wakeAt }, startedAt, now);
        return;
      }
      if (row.status !== 'WAITING')
        await this.markWaiting(tx, row, startedAt, '等待延时结束。', { wakeAt });
      return;
    }
    const expiresAt = approvalDeadline(node, startedAt);
    if (expiresAt <= now) {
      await this.expireApproval(tx, row, expiresAt, now);
    } else if (row.status !== 'WAITING') {
      await this.markWaiting(
        tx,
        row,
        startedAt,
        node.type === 'SOURCE_REVIEW' ? '等待管理员审核实际源码。' : '等待管理员审批。',
        {
          expiresAt,
          ...(scope && {
            scope,
            scopeHash: graphGateHash(row.run_id, node.id, configurationHash!, scope),
          }),
        },
      );
    }
  }

  private async markWaiting(
    tx: Transaction<Database>,
    row: NodeRun,
    startedAt: number,
    log: string,
    output: { wakeAt: number } | GraphGateDecision,
  ) {
    await tx
      .updateTable('execution_node_runs')
      .set({ status: 'WAITING', started_at: startedAt, log, output_json: JSON.stringify(output) })
      .where('id', '=', row.id)
      .execute();
    row.status = 'WAITING';
  }

  private async expireApproval(
    tx: Transaction<Database>,
    row: NodeRun,
    expiresAt: number,
    now: number,
  ) {
    await this.terminalNode(
      tx,
      row,
      'TIMED_OUT',
      '审批等待已超时。',
      {
        ...(JSON.parse(row.output_json ?? '{}') as GraphGateDecision),
        decision: 'EXPIRED',
        expiresAt,
        decidedAt: now,
      },
      row.started_at,
      now,
    );
    await this.audit.record(
      null,
      'execution-flow.approval.expired',
      'flow-run',
      row.run_id,
      {
        nodeId: row.node_id,
        expiresAt,
      },
      tx,
    );
  }

  private async admitTargetRun(tx: Transaction<Database>, run: Run) {
    const serverId = run.execution_server_id;
    if (!serverId || run.execution_admitted_at !== null || run.status === 'CANCEL_REQUESTED')
      return true;
    const limit = (await this.settings?.get(undefined, tx))?.maxConcurrentFlowsPerServer ??
      defaultServerConcurrency;
    if (!(await canAdmitServerWork(tx, serverId, 'FLOW', run.id, limit))) return false;
    await tx.updateTable('execution_flow_runs').set({ execution_admitted_at: Date.now() })
      .where('id', '=', run.id).execute();
    return true;
  }

  private async settle(runId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (!run) return undefined;
      if (!(await this.admitTargetRun(tx, run))) return undefined;
      const { definition } = await this.published(run.project_id, run.version, tx);
      const flow = this.flow(definition, run.flow_id);
      const snapshot = JSON.parse(run.inputs_json) as RunSnapshot;
      const plan = snapshot.simplified;
      const dockerBuilds =
        plan ? flow.nodes.filter(({ type, build }) => type === 'BUILD' && build?.dockerfilePath) : [];
      const rows = await tx
        .selectFrom('execution_node_runs')
        .selectAll()
        .where('run_id', '=', run.id)
        .orderBy('position')
        .execute();
      const byId = new Map(rows.map((row) => [row.node_id, row]));
      const outputs = new Map<string, Values>(
        rows.flatMap((row) =>
          (row.status === 'SUCCESS' ||
            (row.status === 'PARTIAL_FAILED' &&
              isRelease({ type: row.node_type as GraphNode['type'] }))) &&
          row.output_json
            ? [[row.node_id, JSON.parse(row.output_json) as Values]]
            : [],
        ),
      );
      const trigger = snapshot.trigger ?? { triggeredAt: run.created_at };
      const bindings = plan
        ? { context: {}, outputs }
        : {
            ...bindingContext(run.project_id, flow, snapshot.inputs, outputs, trigger),
            environmentSet: snapshot.frozenEnvironment,
            parameterSources: snapshot.parameterSources,
            credentialNonces: snapshot.credentials,
            producerStatus: (id: string) => byId.get(id)?.status,
          };
      let selection = flowSelection(flow, snapshot.inputs, bindings);
      const tasks = rows.flatMap((row) => (row.task_id ? [row.task_id] : []));
      const children = rows.flatMap((row) => (row.child_run_id ? [row.child_run_id] : []));
      const jobStates = tasks.length
        ? await tx
            .selectFrom('tasks')
            .select([
              'id',
              'status',
              'available_at',
              'started_at',
              'finished_at',
              'error_summary',
              'payload_json',
              'result_json',
            ])
            .where('id', 'in', tasks)
            .execute()
        : [];
      const childStates = children.length
        ? await tx
            .selectFrom('execution_flow_runs')
            .select(['id', 'status', 'created_at', 'finished_at'])
            .where('id', 'in', children)
            .execute()
        : [];
      const byTask = new Map(jobStates.map((job) => [job.id, job]));
      const byChild = new Map(childStates.map((child) => [child.id, child]));
      const snapshotReady = new Set<string>();
      let workspacePath = run.workspace_path ?? undefined;
      if (plan) {
        for (const row of rows) {
          const fact = JSON.parse(row.output_json ?? '{}') as Values;
          if (
            fact.snapshotReady === true ||
            (JSON.parse(row.evidence_json ?? '{}') as NodeEvidence).snapshotTaskId
          )
            snapshotReady.add(row.node_id);
          if (typeof fact.workspacePath === 'string') workspacePath ??= fact.workspacePath;
        }
      }
      const busy = jobStates.some(
        (task) => !isNodeTerminal(taskStatus(task.status, task.available_at)),
      );
      const busyActions = rows.flatMap((row) => {
        const task = row.task_id && byTask.get(row.task_id);
        const action = flow.nodes.find(({ id }) => id === row.node_id);
        return task && action && !isNodeTerminal(taskStatus(task.status, task.available_at))
          ? [action]
          : [];
      });
      const ready: {
        node: NodeRun;
        action: GraphNode;
        values: Values;
        environment: ReturnType<typeof inspectNodeEnvironment>;
        stage?: SimplifiedStage;
        workspacePath?: string;
        capture?: SimplifiedSnapshotRequest;
      }[] = [];
      const cancel: string[] = [];
      const now = Date.now();
      for (const node of selection.ordered) {
        const row = byId.get(node.id)!;
        if (isNodeTerminal(row.status)) continue;
        if (row.task_id) {
          const task = byTask.get(row.task_id)!;
          let status = taskStatus(task.status, task.available_at);
          if (isNodeTerminal(status)) {
            const payload = plan ? (JSON.parse(task.payload_json) as TaskPayload) : undefined;
            const action = payload?.simplifiedAction;
            const output = action
              ? (JSON.parse(task.result_json ?? '{}') as { graphOutputs?: Values }).graphOutputs
              : (status === 'SUCCESS' ||
                    isRelease(node) ||
                    (node.type === 'HEALTH_CHECK' && status === 'NEEDS_ATTENTION')) &&
                  this.nodeTasks
                ? await this.nodeTasks.output(task.id, node, tx, Boolean(plan))
                : undefined;
            if (typeof output?.workspacePath === 'string') workspacePath ??= output.workspacePath;
            if (action?.stage === 'SNAPSHOT' && status === 'SUCCESS' && output?.snapshotReady) {
              const previousEvidence = JSON.parse(row.evidence_json ?? '{}') as NodeEvidence;
              row.evidence_json = JSON.stringify({ ...previousEvidence, snapshotTaskId: task.id });
              row.output_json = JSON.stringify(output);
              await tx
                .updateTable('execution_node_runs')
                .set({
                  task_id: null,
                  status: 'PENDING',
                  output_json: row.output_json,
                  evidence_json: row.evidence_json,
                })
                .where('id', '=', row.id)
                .execute();
              row.task_id = null;
              row.status = 'PENDING';
              snapshotReady.add(node.id);
              continue;
            }
            if (node.type === 'HEALTH_CHECK') {
              if (output?.status === 'UNKNOWN') status = 'NEEDS_ATTENTION';
              else if (
                status === 'SUCCESS' &&
                node.healthCheck?.requireHealthy &&
                output?.status === 'UNHEALTHY'
              )
                status = 'FAILED';
            }
            if (isRelease(node) && !action && status === 'SUCCESS') {
              const release = output?.release as { status?: string } | undefined;
              if (release?.status !== 'SUCCESS') status = 'NEEDS_ATTENTION';
            }
            const invalidOutput =
              status === 'SUCCESS' && !plan
                ? await this.recordDeclaredOutputs(tx, row, flow, node, output)
                : undefined;
            if (invalidOutput) status = 'FAILED';
            await this.terminalNode(
              tx,
              row,
              status,
              invalidOutput ??
                task.error_summary ??
                (node.type === 'HEALTH_CHECK' && status === 'NEEDS_ATTENTION'
                  ? '健康状态未知，需人工核查当前发布。'
                  : node.type === 'HEALTH_CHECK' &&
                      status === 'FAILED' &&
                      output?.status === 'UNHEALTHY'
                    ? '发布健康检查未通过。'
                    : undefined) ??
                (status === 'SUCCESS'
                  ? '节点任务已完成，详情见关联任务。'
                  : '节点任务已结束，详情见关联任务。'),
              output,
              task.started_at,
              task.finished_at ?? now,
            );
            if (
              output &&
              !invalidOutput &&
              (status === 'SUCCESS' || (status === 'PARTIAL_FAILED' && isRelease(node)))
            )
              outputs.set(node.id, output);
            const issue = task.result_json
              ? (JSON.parse(task.result_json) as { graphIssue?: ExecutionPlanIssue }).graphIssue
              : undefined;
            if (issue) {
              const evidence = row.evidence_json
                ? (JSON.parse(row.evidence_json) as NodeEvidence)
                : {};
              evidence.issue = {
                ...issue,
                flowId: flow.id,
                flowName: flow.name,
                nodeId: node.id,
                nodeName: node.name,
              };
              await tx
                .updateTable('execution_node_runs')
                .set({ evidence_json: JSON.stringify(evidence) })
                .where('id', '=', row.id)
                .execute();
            }
            selection = flowSelection(flow, snapshot.inputs, bindings);
          } else {
            row.status = status;
            if (run.status === 'CANCEL_REQUESTED' && status !== 'CANCEL_REQUESTED')
              cancel.push(task.id);
          }
          continue;
        }
        if (row.child_run_id) {
          const child = byChild.get(row.child_run_id)!;
          if (isNodeTerminal(child.status)) {
            const childOutputs = await tx
              .selectFrom('execution_node_runs')
              .select(['node_id', 'output_json'])
              .where('run_id', '=', child.id)
              .where('node_type', '=', 'END')
              .where('output_json', 'is not', null)
              .orderBy('position')
              .execute();
            const result = JSON.parse(childOutputs[0]?.output_json ?? '{}') as Values;
            const invalidOutput =
              child.status === 'SUCCESS'
                ? await this.recordDeclaredOutputs(tx, row, flow, node, result)
                : undefined;
            await this.terminalNode(
              tx,
              row,
              invalidOutput ? 'FAILED' : child.status,
              invalidOutput ??
                (child.status === 'SUCCESS'
                  ? '子执行流已完成。'
                  : '子执行流未成功，详情见子运行。'),
              {
                childRunId: child.id,
                ...result,
              },
              child.created_at,
              child.finished_at ?? now,
            );
            if (child.status === 'SUCCESS' && !invalidOutput) outputs.set(node.id, result);
            selection = flowSelection(flow, snapshot.inputs, bindings);
          } else row.status = child.status;
          continue;
        }
        if (run.status === 'CANCEL_REQUESTED') {
          await this.terminalNode(
            tx,
            row,
            row.status === 'WAITING' ? 'CANCELLED' : 'SKIPPED',
            '执行流已请求取消。',
          );
          continue;
        }
        if (!selection.selected.has(node.id)) {
          await this.terminalNode(tx, row, 'SKIPPED', '条件分支未被选中。');
          continue;
        }
        const parents = selection.incoming.get(node.id) ?? [];
        const failedParent = parents.find(({ from, when }) => {
          const status = byId.get(from)!.status;
          if (!isNodeTerminal(status)) return false;
          return when === 'PARTIAL_SUCCESS'
            ? status !== 'PARTIAL_FAILED' || selection.matches.get(from) !== 'PARTIAL_SUCCESS'
            : status !== 'SUCCESS';
        });
        if (failedParent) {
          const parent = byId.get(failedParent.from)!;
          await this.terminalNode(tx, row, 'SKIPPED', `上游节点「${parent.name}」未成功。`);
          continue;
        }
        if (parents.some(({ from }) => !isNodeTerminal(byId.get(from)!.status))) continue;
        if (plan && this.simplifiedRuns) {
          const selectedRelease =
            plan.release && selection.selected.has(plan.release.nodeId) ? plan.release : undefined;
          const historicalArtifactId = selectedRelease?.artifactId;
          const preparingRelease =
            selectedRelease &&
            !historicalArtifactId &&
            ((node.type === 'APPROVAL' && row.status !== 'WAITING') ||
              node.id === selectedRelease.nodeId);
          const needsArtifactFacts = Boolean(preparingRelease) || node.type === 'END';
          if (needsArtifactFacts && busy) continue;
          const artifacts = needsArtifactFacts
            ? await this.simplifiedRuns.snapshotArtifacts(tx, run.id)
            : [];
          const currentFileRelease = Boolean(preparingRelease && selectedRelease.method === 'FILE');
          const workspaceSnapshot = artifacts.some(
            ({ artifact_type, artifact_name }) =>
              artifact_type === 'FILE' && artifact_name === 'workspace',
          );
          const workspaceUsed =
            Boolean(workspacePath) &&
            rows.some(
              ({ node_id, node_type }) => workspaceActions.has(node_type) && outputs.has(node_id),
            );
          if (currentFileRelease && !workspaceUsed && !workspaceSnapshot) {
            await this.terminalNode(tx, row, 'FAILED', '本次文件发布前没有已完成的工作区动作。');
            continue;
          }
          const collectWorkspace =
            (currentFileRelease || node.type === 'END') &&
            workspaceUsed &&
            workspaceRetention(plan.finish, currentFileRelease) !== 'OFF' &&
            !workspaceSnapshot;
          const checkoutCompleted = rows.some(
            ({ node_id, node_type }) => node_type === 'CHECKOUT' && outputs.has(node_id),
          );
          const images = plan.finish.images ?? [];
          // A parallel build task can settle earlier in this same pass.
          const expectedImageIds = Object.fromEntries(
            (needsArtifactFacts ? dockerBuilds : []).flatMap(({ id }) => {
              const imageId = stringValue(outputs.get(id)?.imageId);
              return imageId ? [[id, imageId]] : [];
            }),
          );
          const expectedImageId =
            dockerBuilds.length === 1 ? expectedImageIds[dockerBuilds[0]!.id] : undefined;
          const releaseImages =
            preparingRelease && selectedRelease.method === 'COMPOSE'
              ? (selectedRelease.images ?? (selectedRelease.image ? [selectedRelease.image] : []))
                  .map(({ id }) => images.find((entry) => entry.id === id))
              : [];
          const hasBuiltImage = (image: (typeof images)[number]) =>
            image.source !== 'BUILT_IN' ||
            Boolean(image.buildNodeId ? expectedImageIds[image.buildNodeId] : expectedImageId);
          const missingImage = releaseImages.find((image) => image && !hasBuiltImage(image));
          if (
            preparingRelease &&
            selectedRelease.method === 'COMPOSE' &&
            (!releaseImages.length || releaseImages.includes(undefined) || missingImage)
          ) {
            await this.terminalNode(
              tx,
              row,
              'FAILED',
              missingImage
                ? `镜像「${missingImage.name}」的 Docker 构建未执行，无法发布。`
                : '未找到本次发布所选的镜像登记项。',
            );
            continue;
          }
          const imageIds = (node.type === 'END' ? images : releaseImages.filter((image) => image !== undefined))
            .filter(
              (image) =>
                hasBuiltImage(image) &&
                !artifacts.some(
                  ({ artifact_type, artifact_name }) =>
                    artifact_type === 'DOCKER_IMAGE' && artifact_name === image.name,
                ),
            )
            .map(({ id }) => id);
          const capture = needsArtifactFacts
            ? {
                workspace: collectWorkspace,
                imageIds,
                expectedImageId,
                expectedImageIds,
                checkoutCompleted,
              }
            : undefined;
          const shouldSnapshot = capture?.workspace || Boolean(capture?.imageIds.length);
          if (shouldSnapshot && snapshotReady.has(node.id)) {
            await this.terminalNode(tx, row, 'FAILED', '未找到本次已登记的交付产物。');
            continue;
          }
          const script = workspaceActions.has(node.type);
          const release = selectedRelease && outputs.get(selectedRelease.nodeId)?.release;
          const stage = shouldSnapshot
            ? 'SNAPSHOT'
            : script
              ? 'ACTION'
              : isRelease(node)
                ? 'RELEASE'
                : node.type === 'HEALTH_CHECK'
                  ? 'HEALTH'
                  : undefined;
          if (stage) {
            const directory = stage === 'ACTION' ? parallelBuildDirectory(node) : undefined;
            if (rows.some((entry) => entry.status === 'NEEDS_ATTENTION')) {
              await this.terminalNode(
                tx,
                row,
                'SKIPPED',
                '同次运行存在状态未确认的动作，停止派发后续任务。',
              );
            } else if (
              (!busy && !ready.length) ||
              (directory &&
                busyActions.every((action) =>
                  separateBuildDirectories(directory, parallelBuildDirectory(action)),
                ) &&
                ready.every((entry) =>
                  entry.stage === 'ACTION' &&
                  separateBuildDirectories(directory, parallelBuildDirectory(entry.action)),
                ))
            ) {
              ready.push({
                node: row,
                action: node,
                values: stage === 'HEALTH' ? { release } : {},
                stage,
                workspacePath,
                capture,
                environment: { variables: plan.environment, sources: [], evidence: [] },
              });
            }
            continue;
          }
          if (node.type === 'APPROVAL' || node.type === 'SOURCE_REVIEW') {
            try {
              let scope: GraphGateScope | undefined;
              if (row.status !== 'WAITING') {
                if (node.type === 'APPROVAL' && selectedRelease)
                  scope = await this.simplifiedRuns.releaseScope(tx, run.id, selectedRelease);
                if (node.type === 'SOURCE_REVIEW') {
                  const artifactIds = historicalArtifactId ? [historicalArtifactId] : [];
                  const sources = artifactIds.length
                    ? await artifactReviewSources(tx, artifactIds)
                    : reviewSources(plan.sources.map(({ source }) => source));
                  if (!sources.length) throw new ConflictException('源码审核缺少已确认的实际提交');
                  scope = { kind: 'SOURCE_REVIEW', sources, artifactIds };
                }
              }
              await this.waitAtNode(tx, row, node, now, scope, run.configuration_hash);
            } catch (error) {
              if (!(error instanceof HttpException)) throw error;
              await this.terminalNode(tx, row, 'FAILED', error.message, undefined, now);
            }
            continue;
          }
          if (node.type === 'END') {
            try {
              const artifactIds = artifacts.map(({ id }) => id);
              if (historicalArtifactId && release) artifactIds.push(historicalArtifactId);
              const health = [...outputs.values()]
                .map((output) => output.release as { operation?: string } | undefined)
                .find((result) => result?.operation === 'CHECK');
              if (plan.finish.requireRelease) {
                const expected = selectedRelease;
                const result = graphReleaseResult(release);
                const scope =
                  expected && (await this.simplifiedRuns.releaseScope(tx, run.id, expected));
                if (
                  !expected ||
                  !scope ||
                  result.status !== 'SUCCESS' ||
                  result.serviceId !== expected.serviceId ||
                  !sameIds(
                    expected.serverIds,
                    result.targets.map(({ serverId }) => serverId),
                  ) ||
                  result.targets.some(
                    (target) =>
                      target.status !== 'SUCCESS' ||
                      !target.artifactInstanceId ||
                      !scope.artifactIds.includes(target.artifactInstanceId) ||
                      !sameIds(
                        scope.artifactIds,
                        target.consumedArtifacts?.map(({ artifactId }) => artifactId) ??
                          [target.artifactInstanceId],
                      ),
                  )
                )
                  throw new ConflictException('结束节点缺少计划内全部目标的激活及产物证据');
                if (plan.finish.requireRelease === 'HEALTHY') {
                  const checked = graphReleaseResult(health);
                  if (
                    checked.healthStatus !== 'HEALTHY' ||
                    checked.serviceId !== result.serviceId ||
                    !sameIds(
                      checked.targets.map(({ deploymentId }) => deploymentId!),
                      result.targets.map(({ deploymentId }) => deploymentId!),
                    )
                  )
                    throw new ConflictException('结束节点缺少本次激活版本的健康证据');
                }
              }
              await this.terminalNode(
                tx,
                row,
                'SUCCESS',
                '执行流已核对交付结果。',
                {
                  artifactIds,
                  release,
                  health,
                  workspacePath,
                  sources: [...outputs.values()].flatMap((output) =>
                    Array.isArray(output.sources) ? output.sources : [],
                  ),
                },
                now,
              );
            } catch (error) {
              if (!(error instanceof HttpException)) throw error;
              await this.terminalNode(tx, row, 'FAILED', error.message, undefined, now);
            }
            continue;
          }
        }
        if (node.type === 'DELAY' || node.type === 'APPROVAL' || node.type === 'SOURCE_REVIEW') {
          try {
            const rootId = snapshot.rootId ?? run.id;
            let scope: GraphGateScope | undefined;
            if (row.status !== 'WAITING' && node.type === 'SOURCE_REVIEW') {
              scope = await this.sourceReviewScope(tx, run, node, rootId, byId, flow, bindings);
            } else if (row.status !== 'WAITING' && node.approval?.releaseNodeId) {
              const releaseId = node.approval.releaseNodeId;
              const release = flow.nodes.find(({ id }) => id === releaseId);
              const target = byId.get(releaseId);
              if (!release || !target?.dispatch_json)
                throw new ConflictException('没有待审批的已确认发布计划');
              const input = inspectNodeInputs(flow, release, bindings);
              const invalid = input.evidence.find(
                ({ fieldId, state }) =>
                  ['artifact', 'afterRelease'].includes(fieldId) &&
                  ['ERROR', 'DEFERRED'].includes(state),
              );
              if (invalid) throw fieldIssue(flow, release, invalid);
              scope = await this.releaseScope(
                tx,
                run,
                rootId,
                releaseId,
                JSON.parse(target.dispatch_json) as Delivery,
                input.values,
              );
            }
            await this.waitAtNode(tx, row, node, now, scope, run.configuration_hash);
          } catch (error) {
            if (!(error instanceof HttpException)) throw error;
            await this.terminalNode(tx, row, 'FAILED', error.message, undefined, now);
          }
        } else if (isDelivery(node) || isNativeTask(node) || node.type === 'FLOW_CALL') {
          const child = node.type === 'FLOW_CALL' ? this.flow(definition, node.flowId!) : undefined;
          const input = inspectNodeInputs(flow, node, bindings, child);
          const nativePlan =
            row.dispatch_json && isNativeTask(node)
              ? (JSON.parse(row.dispatch_json) as GraphNodePlan)
              : undefined;
          const environment = inspectNodeEnvironment(flow, node, {
            ...bindings,
            nodeInputs: input.values,
            nodeInputFields: input.fields,
            nodeInputEvidence: input.evidence,
            executionServerId:
              nativePlan && 'serverId' in nativePlan ? nativePlan.serverId : undefined,
          });
          const pending = [...input.evidence, ...environment.evidence];
          if (
            pending.some(
              ({ state, source }) =>
                state === 'DEFERRED' &&
                source?.nodeId &&
                byId.has(source.nodeId) &&
                !isNodeTerminal(byId.get(source.nodeId)?.status ?? 'PENDING'),
            )
          )
            continue;
          const invalid = pending.find(({ state }) => state === 'ERROR' || state === 'DEFERRED');
          const evidence: NodeEvidence = {
            inputs: input.evidence,
            environment: environment.evidence,
          };
          if (invalid) {
            evidence.issue = fieldIssue(flow, node, invalid).issue;
            await this.terminalNode(tx, row, 'FAILED', evidence.issue.message, undefined, now);
          } else {
            ready.push({ node: row, action: node, values: input.values, environment });
          }
          row.evidence_json = JSON.stringify(evidence);
          await tx
            .updateTable('execution_node_runs')
            .set({ evidence_json: row.evidence_json })
            .where('id', '=', row.id)
            .execute();
        } else if (node.type === 'END') {
          const output = inspectFlowOutputs(flow, bindings);
          const evidence: NodeEvidence = { outputFields: output.evidence };
          try {
            const invalid = output.evidence.find(
              ({ state }) => state === 'ERROR' || state === 'DEFERRED',
            );
            if (invalid) throw fieldIssue(flow, node, invalid);
            const result = output.values;
            await this.validateNodeResources(
              run.project_id,
              (node.outputs ?? []).filter(({ type }) => type === 'SERVICE'),
              result,
              undefined,
              tx,
            );
            const scope = declaredScope(flow, snapshot.inputs);
            const releaseServices = flow.compiled?.presetResourceGroups
              ? presetReleaseServiceIds(flow, snapshot.inputs.parameters)
              : flow.serviceId
                ? [flow.serviceId]
                : [];
            if (
              releaseServices.length &&
              (node.outputs ?? []).some((field) => field.type === 'RELEASE') &&
              !Object.entries(result).some(
                ([id, value]) =>
                  node.outputs?.find((field) => field.id === id)?.type === 'RELEASE' &&
                  value &&
                  typeof value === 'object' &&
                  'status' in value &&
                  value.status === 'SUCCESS' &&
                  (!('operation' in value) ||
                    value.operation !== 'CHECK' ||
                    ('healthStatus' in value && value.healthStatus === 'HEALTHY')) &&
                  'serviceId' in value &&
                  typeof value.serviceId === 'string' &&
                  releaseServices.includes(value.serviceId) &&
                  (!scope.environmentId ||
                    ('environmentId' in value && value.environmentId === scope.environmentId)),
              )
            )
              throw new BadRequestException('结束节点没有获得关联服务及环境的成功发布结果');
            await this.terminalNode(tx, row, 'SUCCESS', graphNodeOutput(node), result, now);
          } catch (error) {
            await this.terminalNode(
              tx,
              row,
              'FAILED',
              error instanceof HttpException ? error.message : '执行流输出无效',
              undefined,
              now,
            );
            if (error instanceof ExecutionPlanIssueError) evidence.issue = error.issue;
          }
          await tx
            .updateTable('execution_node_runs')
            .set({ evidence_json: JSON.stringify(evidence) })
            .where('id', '=', row.id)
            .execute();
        } else {
          const match = branchMatch(flow, node, snapshot.inputs, bindings);
          if ((node.type === 'CONDITION' || node.type === 'SWITCH') && match === undefined) {
            await this.terminalNode(
              tx,
              row,
              'FAILED',
              '判断节点缺少所选分支的输入。',
              undefined,
              now,
            );
            continue;
          }
          const result = match === undefined ? undefined : graphConditionOutput(node, match);
          await this.terminalNode(tx, row, 'SUCCESS', graphNodeOutput(node, match), result, now);
          if (result) {
            outputs.set(node.id, result);
            selection = flowSelection(flow, snapshot.inputs, bindings);
          }
        }
      }
      const statuses = rows.map(({ status }) => status);
      const finished = statuses.every(isNodeTerminal);
      const endSucceeded = byId.get(flowEnd(flow).id)?.status === 'SUCCESS';
      const status = finished
        ? (failureStatus(statuses) ??
          (run.status === 'CANCEL_REQUESTED' ? 'CANCELLED' : endSucceeded ? 'SUCCESS' : 'FAILED'))
        : run.status === 'CANCEL_REQUESTED'
          ? run.status
          : ready.length || statuses.some((s) => s === 'RUNNING' || s === 'QUEUED')
            ? 'RUNNING'
            : 'WAITING';
      await tx
        .updateTable('execution_flow_runs')
        .set({ status, finished_at: finished ? now : null })
        .where('id', '=', run.id)
        .execute();
      return { run, flow, definition, snapshot, ready, cancel, status, workspacePath };
    });
  }

  private async callChild(
    run: Run,
    node: NodeRun,
    flow: GraphFlow,
    snapshot: RunSnapshot,
    parameters: Values,
  ) {
    const pinned = snapshot.children?.[node.node_id];
    const deferred = new Set(pinned?.deferredArtifactFields ?? []);
    const known = Object.fromEntries(
      Object.entries(parameters).filter(([id]) => !deferred.has(id)),
    );
    if (pinned && pinned.inputHash !== digest(known))
      throw new ConflictException('子流实际参数与已确认的参数不一致');
    const prepared =
      pinned ??
      (await this.prepare(
        run.project_id,
        flow.id,
        { version: run.version, inputs: { ...snapshot.inputs, parameters } },
        {
          trigger: snapshot.trigger,
          automation: snapshot.automation,
          allowRetired: true,
          rootId: snapshot.rootId ?? run.id,
        },
      ));
    const childInputs =
      pinned && deferred.size
        ? await this.resolveParameters(
            run.project_id,
            flow,
            {
              ...prepared.inputs,
              parameters: {
                ...prepared.inputs.parameters,
                ...Object.fromEntries([...deferred].map((id) => [id, parameters[id]])),
              },
            },
            snapshot.rootId ?? run.id,
          )
        : prepared.inputs;
    const confirmedHash =
      'preview' in prepared
        ? prepared.preview.configurationHash
        : digest([run.configuration_hash, node.node_id, prepared]);
    return this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const parent = await this.lockRun(tx, run.id);
      if (!parent || parent.status === 'CANCEL_REQUESTED') return undefined;
      const existing = await tx
        .selectFrom('execution_node_runs')
        .select('child_run_id')
        .where('id', '=', node.id)
        .executeTakeFirstOrThrow();
      if (existing.child_run_id) return existing.child_run_id;
      const rootId = snapshot.rootId ?? run.id;
      const childSnapshot = {
        inputs: childInputs,
        environmentSet: prepared.environmentSet,
        frozenEnvironment: prepared.frozenEnvironment,
        checkoutProvenance: prepared.checkoutProvenance,
        parameterSources: prepared.parameterSources,
        credentials: 'credentials' in prepared ? prepared.credentials : snapshot.credentials,
        rootId,
        trigger: snapshot.trigger,
        automation: snapshot.automation,
        deliveries: prepared.plans,
        children: prepared.children,
      };
      const { definition } = await this.published(run.project_id, run.version, tx);
      const references = runResourceReferences(
        definition,
        { sourceId: run.id, version: run.version, flowId: flow.id, state: 'PENDING' },
        childSnapshot,
      );
      const materialized = await this.artifactReferences(
        run.project_id,
        (flowStart(flow).inputs ?? [])
          .filter(({ type }) => type === 'ARTIFACT')
          .flatMap(({ id }) => artifactBindingRefs(childInputs.parameters?.[id])),
        undefined,
        { db: tx, rootId },
      );
      const localArtifacts = new Set(
        materialized.flatMap((instance) =>
          instance.scope === 'TEMPORARY' ? [instance.id, instance.artifactId] : [],
        ),
      );
      if (
        await unavailableReference(
          tx,
          run.project_id,
          references.filter(
            (reference) =>
              (!pinned || reference.resourceType !== 'ENVIRONMENT_SET') &&
              (reference.resourceType !== 'SERVICE' ||
                reference.resourceId !== graphUnscopedArtifactService(run.project_id).id) &&
              (reference.resourceType !== 'ARTIFACT' || !localArtifacts.has(reference.resourceId)),
          ),
        )
      )
        throw new ConflictException('子执行流所需的资源已变化');
      const concreteIds = materialized.map(({ id }) => id);
      if (concreteIds.length) await lockAvailableArtifacts(tx, concreteIds);
      const child = await this.insertRun(
        tx,
        {
          id: randomUUID(),
          project_id: run.project_id,
          graph_id: run.graph_id,
          version: run.version,
          flow_id: flow.id,
          flow_name: flow.name,
          created_by: run.created_by,
          parent_run_id: run.id,
          idempotency_key: `child:${run.id}:${node.id}`,
          request_hash: run.request_hash,
          configuration_hash: confirmedHash,
          inputs_json: JSON.stringify(childSnapshot),
          trigger_type: snapshot.automation?.kind ?? null,
        },
        flow,
        childInputs,
        prepared.plans,
      );
      if (!child) throw new Error('子执行流登记冲突');
      await tx
        .updateTable('execution_node_runs')
        .set({ child_run_id: child.id, status: 'WAITING', started_at: Date.now() })
        .where('id', '=', node.id)
        .execute();
      return child.id;
    });
  }

  private async linkTask(
    tx: Transaction<Database>,
    run: Run,
    node: NodeRun,
    taskId: string,
    pipelineId?: string,
    workspace?: { buildDirectory?: string },
  ) {
    await this.lockProject(tx, run.project_id);
    const locked = await this.lockRun(tx, run.id);
    if (!locked || locked.status === 'CANCEL_REQUESTED')
      throw new ConflictException('执行流已停止');
    const user = await tx
      .selectFrom('users')
      .select('id')
      .where('id', '=', run.created_by)
      .where('status', '=', 'ACTIVE')
      .where('must_change_password', '=', 0)
      .where('role', 'in', ['ADMIN', 'OPERATOR'])
      .executeTakeFirst();
    if (!user) throw new ConflictException('发起人已失去执行权限');
    if (pipelineId) {
      const pipeline = await tx
        .updateTable('pipelines')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', pipelineId)
        .where('project_id', '=', run.project_id)
        .where('enabled', '=', 1)
        .returning('id')
        .executeTakeFirst();
      if (!pipeline) throw new ConflictException('流水线已停用，请重新预览');
    }
    const current = await tx
      .selectFrom('execution_node_runs')
      .select(['status', 'task_id'])
      .where('id', '=', node.id)
      .executeTakeFirstOrThrow();
    if (current.task_id === taskId) return;
    if (current.status !== 'PENDING') {
      if (workspace) throw new FlowWorkspaceBusy();
      throw new ConflictException('节点已停止等待');
    }
    if (workspace) {
      const outstanding = await tx
        .selectFrom('execution_node_runs as n')
        .innerJoin('tasks as t', 't.id', 'n.task_id')
        .select('t.payload_json')
        .where('n.run_id', '=', run.id)
        .where('n.id', '!=', node.id)
        .where('t.status', 'not in', terminalTaskStatuses)
        .execute();
      // Recheck under the run lock because another scheduler may have linked work since settle.
      const conflicts = outstanding.some(({ payload_json }) => {
        if (!workspace.buildDirectory) return true;
        const action = (JSON.parse(payload_json) as TaskPayload).simplifiedAction;
        return action?.stage !== 'ACTION' ||
          !separateBuildDirectories(workspace.buildDirectory, parallelBuildDirectory(action.node));
      });
      if (conflicts) throw new FlowWorkspaceBusy();
    }
    await tx
      .updateTable('execution_node_runs')
      .set({ task_id: taskId, status: 'QUEUED' })
      .where('id', '=', node.id)
      .execute();
    await tx
      .updateTable('execution_flow_runs')
      .set({ task_id: taskId })
      .where('id', '=', run.id)
      .where('task_id', 'is', null)
      .execute();
  }

  private async dispatchNative(
    run: Run,
    row: NodeRun,
    action: GraphNode,
    values: Values,
    flow: GraphFlow,
    snapshot: RunSnapshot,
    environment: ReturnType<typeof inspectNodeEnvironment>,
  ) {
    if (!this.nodeTasks || !this.tasks || !row.dispatch_json)
      throw new BadRequestException('执行节点服务不可用');
    const plan = JSON.parse(row.dispatch_json) as GraphNodePlan;
    const evidence = row.evidence_json
      ? (JSON.parse(row.evidence_json) as NodeEvidence).inputs
      : undefined;
    let scriptArtifact: GraphNodeScope['scriptArtifact'];
    if ((plan.type === 'SHELL' || plan.type === 'CHECK') && plan.artifact) {
      const { path, instances, producers } = plan.artifact;
      const instance = await this.scriptArtifactInstance(
        run.project_id,
        values.artifact,
        snapshot.rootId ?? run.id,
        plan.serverId,
        path,
      );
      const realized = evidence?.find(({ fieldId }) => fieldId === 'artifact')?.source;
      if (
        (instances && !instances.includes(instance)) ||
        (producers?.length &&
          !producers.some(
            ({ nodeId, fieldId }) => realized?.nodeId === nodeId && realized.fieldId === fieldId,
          ))
      )
        throw new ConflictException('脚本实际读取的产物与已确认计划不一致');
      scriptArtifact = { path, instances: [instance] };
    }
    const scope = snapshot.simplified
      ? {
          serviceId: snapshot.simplified.serviceId,
          environmentId: graphDeliveryEnvironment(run.project_id).id,
        }
      : declaredScope(flow, snapshot.inputs);
    if (!snapshot.simplified)
      await this.validateNodeResources(
        run.project_id,
        graphScriptInputs(action),
        values,
        snapshot.rootId ?? run.id,
      );
    const task = await this.nodeTasks.task(
      run.project_id,
      action,
      plan,
      graphTaskKeyPrefix + row.id,
      {
        runId: run.id,
        rootRunId: snapshot.rootId ?? run.id,
        nodeRunId: row.id,
        serviceId: referenceId(values.service) ?? scope.serviceId,
        environmentId: referenceId(values.environment) ?? scope.environmentId,
        values,
        inputEvidence: evidence,
        scriptArtifact,
        credentialNonces: snapshot.credentials,
        nodeEnvironment: environment.variables,
        nodeEnvironmentSources: environment.sources,
        trigger: snapshot.trigger ?? { triggeredAt: run.created_at },
        automation: snapshot.automation,
      },
    );
    const automation = snapshot.automation;
    const artifactInstances = scriptArtifact?.instances;
    await this.tasks.create(
      task,
      run.created_by,
      automation || artifactInstances?.length
        ? async (tx) => {
            if (artifactInstances?.length) {
              await lockProjectGraph(tx);
              await lockAvailableArtifacts(tx, artifactInstances);
            }
            if (automation) {
              await assertGraphAutomation(
                tx,
                run.project_id,
                run.created_by,
                automation,
                graphNodeRequiresIsolation(action.type),
              );
              if (task.payload.targets.length)
                await assertAutomaticTargets(tx, task.payload.targets);
            }
          }
        : undefined,
      (tx, id) => this.linkTask(tx, run, row, id, undefined, snapshot.simplified ? {} : undefined),
    );
  }

  private async dispatch(
    run: Run,
    node: NodeRun,
    flow: GraphFlow,
    snapshot: RunSnapshot,
    bindings: Values,
    environment: ReturnType<typeof inspectNodeEnvironment>,
  ) {
    const stored = JSON.parse(node.dispatch_json!) as Delivery;
    const rootId = snapshot.rootId ?? run.id;
    const release = node.node_type === 'DEPLOY_ARTIFACT' || node.node_type === 'ROLLBACK_ARTIFACT';
    const revisions = release
      ? await this.artifactReferences(
          run.project_id,
          artifactBindingRefs(bindings.artifact ?? stored.artifactIds),
          undefined,
          {
            rootId,
            targets: stored.serverIds,
            single: true,
            distributeFile: stored.profile?.delivery?.method === 'FILE',
          },
        )
      : [];
    const artifacts = revisions.map(({ id }) => id);
    let delivery = stored;
    if (stored.alternatives) {
      const known = await this.database.db
        .selectFrom('execution_node_runs')
        .select(['node_id', 'output_json'])
        .where('run_id', '=', run.id)
        .where('status', '=', 'SUCCESS')
        .execute();
      const outputs = new Map(
        known.flatMap((result) =>
          result.output_json
            ? [[result.node_id, JSON.parse(result.output_json) as Values] as const]
            : [],
        ),
      );
      const picked = stored.alternatives.find((option) => {
        const actualSource =
          option.artifactFromNodeId && option.artifactFromField
            ? outputs.get(option.artifactFromNodeId)?.[option.artifactFromField]
            : option.artifactFromParameterId
              ? snapshot.inputs.parameters?.[option.artifactFromParameterId]
              : undefined;
        const materialized = option.artifactFromNodeId || option.artifactFromParameterId;
        const produced = materialized ? artifactBindingRefs(actualSource) : [];
        return (
          artifacts.length &&
          (materialized
            ? revisions.every((instance) =>
                produced.some((ref) => {
                  if ('temporaryArtifactId' in ref)
                    return (
                      ref.temporaryArtifactId === instance.id && instance.scope === 'TEMPORARY'
                    );
                  const explicit = artifactReferenceInstances(ref);
                  return (
                    (ref.artifactId === instance.artifactId || ref.artifactId === instance.id) &&
                    ref.rootRunId === ('rootRunId' in instance ? instance.rootRunId : undefined) &&
                    (!explicit.length || explicit.includes(instance.id))
                  );
                }),
              )
            : digest([...option.artifactIds].sort()) === digest([...artifacts].sort())) &&
          revisions.every(
            (artifact) =>
              (!artifact.commitSha || artifact.commitSha === option.commitSha) &&
              (!artifact.workspaceRepositoryId ||
                artifact.workspaceRepositoryId === option.profile?.definition.repositoryId) &&
              (artifact.type === 'DOCKER_IMAGE' ? 'DOCKER_IMAGE' : 'FILE') ===
                option.profile?.definition.artifactType,
          )
        );
      });
      if (!picked) throw new ConflictException('实际产物与已确认的来源不匹配');
      delivery = picked;
    }
    if (
      release &&
      delivery.artifactIds.length &&
      digest([...delivery.artifactIds].sort()) !== digest([...artifacts].sort())
    )
      throw new ExecutionPlanIssueError(
        { code: 'ARTIFACT', fieldId: 'artifact', message: '已确认的产物实例发生变化，请重新预览' },
        409,
      );
    const db = this.database.db;
    const gate: GraphReleaseGate = { runId: run.id, nodeId: node.node_id };
    const linkedReview =
      node.node_type === 'BUILD'
        ? flow.nodes.find(
            ({ type, approval }) =>
              type === 'SOURCE_REVIEW' && approval?.buildNodeId === node.node_id,
          )
        : undefined;
    const review = bindings.review as (GraphGateProof & { runId: string }) | undefined;
    if (linkedReview && review?.nodeId !== linkedReview.id)
      throw new ConflictException('构建缺少本次计划对应的源码审核凭证');
    if (review) {
      if (review.runId !== run.id) throw new ConflictException('源码审核凭证必须来自本次运行');
      const scope = await readGraphGate(db, run.project_id, run.id, review, 'SOURCE_REVIEW');
      if (node.node_type === 'BUILD') {
        assertReviewedSources(scope, delivery.sourceSnapshot ?? [], node.node_id);
        if (scope.kind === 'SOURCE_REVIEW' && scope.artifactIds.length)
          throw new ConflictException('构建需要审核实际源码，已有产物的审核凭证仅可用于发布');
      } else if (scope.kind === 'SOURCE_REVIEW' && scope.buildNodeId) {
        throw new ConflictException('此审核凭证绑定了本次构建');
      }
      gate.review = { nodeId: review.nodeId, actorId: review.actorId, hash: review.hash };
    }
    if (release) {
      const approvalNodes = flow.nodes.filter(
        ({ type, approval }) => type === 'APPROVAL' && approval?.releaseNodeId === node.node_id,
      );
      if (approvalNodes.length) {
        const approved = await db
          .selectFrom('execution_node_runs')
          .select(['node_id', 'output_json'])
          .where('run_id', '=', run.id)
          .where(
            'node_id',
            'in',
            approvalNodes.map(({ id }) => id),
          )
          .where('status', '=', 'SUCCESS')
          .executeTakeFirst();
        const decision: GraphGateDecision = JSON.parse(approved?.output_json ?? '{}');
        if (!approved || !decision.actorId || !decision.scopeHash)
          throw new ConflictException('发布缺少本次运行的管理员审批');
        const proof = {
          nodeId: approved.node_id,
          actorId: decision.actorId,
          hash: decision.scopeHash,
        };
        await readGraphGate(db, run.project_id, run.id, proof, 'APPROVAL');
        const scope = await this.releaseScope(db, run, rootId, node.node_id, delivery, bindings);
        if (graphGateHash(run.id, approved.node_id, run.configuration_hash, scope) !== proof.hash)
          throw new ConflictException('发布范围已变化，需重新预览和审批');
        gate.approval = proof;
      }
    }
    const inputs = delivery.targetInputs ?? snapshot.inputs;
    const { targetId, serverIds, groupIds, strategy, maxParallel, failurePolicy } = inputs;
    const values = {
      targetId,
      serverIds,
      groupIds,
      strategy,
      maxParallel,
      failurePolicy,
      environmentId: delivery.environmentId,
      version: delivery.pipelineVersion,
      confirmed: true as const,
      expectedConfigurationHash: delivery.pipelineHash,
      expectedServerIds: delivery.serverIds,
    };
    const options = {
      idempotencyKey: graphTaskKeyPrefix + node.id,
      profile:
        delivery.profile &&
        (delivery.artifactFromNodeId || delivery.artifactFromParameterId
          ? { ...delivery.profile, artifactRootRunId: rootId }
          : delivery.profile),
      graphAutomation: snapshot.automation,
      graphGate: gate.approval || gate.review ? gate : undefined,
      rollbackExpected: release
        ? this.rollbackExpected(delivery, bindings.afterRelease)
        : undefined,
      afterInsert: (tx: Transaction<Database>, taskId: string) =>
        this.linkTask(tx, run, node, taskId, delivery.pipelineId),
    };
    if (node.node_type === 'BUILD') {
      if (environment.evidence.length && !delivery.buildEnvironment)
        throw new ConflictException('此构建缺少已确认的节点环境计划，请重新预览');
      const changed = Object.entries(delivery.buildEnvironment?.fixed ?? {}).find(
        ([key, expected]) => buildVariableFingerprint(environment.variables, key) !== expected,
      );
      if (changed)
        throw new ExecutionPlanIssueError({
          code: 'CONFIGURATION',
          flowId: flow.id,
          nodeId: node.node_id,
          fieldId: changed[0],
          message: '已确认的构建变量或凭据发生变化，请重新预览',
        });
      const dependencies = Object.fromEntries(
        Object.entries(delivery.dependencySources ?? {}).map(([alias, source]) => {
          const workspace = bindings['dependency_' + alias] as GraphWorkspaceRef | undefined;
          if (
            !workspace ||
            workspace.repositoryId !== source.repositoryId ||
            workspace.commitSha !== source.commitSha
          )
            throw new ConflictException('构建依赖工作区与已确认计划不一致 · ' + alias);
          return [alias, workspace];
        }),
      );
      const bound = bindings.variables as GraphEnvironmentRef | undefined;
      if (
        delivery.configuration &&
        bound &&
        digest(bound.environmentFile ?? null) !== digest(delivery.environmentFile ?? null)
      )
        throw new ConflictException('实际环境文件与已确认的仓库、提交或路径不一致');
      const variables = delivery.environmentFile
        ? {
            ...bound,
            environmentId: bound?.environmentId ?? delivery.environmentId,
            environmentFile: delivery.environmentFile,
          }
        : bound;
      await this.pipelines.run(
        delivery.pipelineId,
        { ...values, mode: 'BUILD_ONLY', commitSha: delivery.commitSha },
        run.created_by,
        {
          ...options,
          ...(delivery.sourceSnapshot?.[0]?.tag
            ? { gitRef: 'refs/tags/' + delivery.sourceSnapshot[0].tag }
            : delivery.sourceSnapshot?.[0]?.branch
              ? { gitRef: 'refs/heads/' + delivery.sourceSnapshot[0].branch }
              : {}),
          graph: {
            runId: run.id,
            rootRunId: rootId,
            nodeRunId: node.id,
            workspace: bindings.workspace as GraphWorkspaceRef | undefined,
            ...(Object.keys(dependencies).length ? { dependencies } : {}),
            variables,
            ...(environment.sources.length && {
              nodeEnvironment: environment.variables,
              nodeEnvironmentSources: environment.sources,
            }),
            trigger: snapshot.trigger ?? { triggeredAt: run.created_at },
          },
        },
      );
    } else {
      if (delivery.artifactFromNodeId || delivery.artifactFromParameterId) {
        const upstream = delivery.artifactFromNodeId
          ? await this.database.db
              .selectFrom('execution_node_runs')
              .select(['task_id', 'child_run_id'])
              .where('run_id', '=', run.id)
              .where('node_id', '=', delivery.artifactFromNodeId)
              .where('status', '=', 'SUCCESS')
              .executeTakeFirstOrThrow()
          : undefined;
        const artifactIds = artifacts;
        if (!artifactIds.length) throw new BadRequestException('上游没有可部署的产物');
        const prepared = await this.pipelines.previewArtifactDeploy(
          delivery.pipelineId,
          {
            ...values,
            artifactIds,
          },
          options.profile,
        );
        if (
          (upstream && !upstream.child_run_id && prepared.sourceBuildTaskId !== upstream.task_id) ||
          prepared.commitSha !== delivery.commitSha
        )
          throw new ConflictException('产物的来源与已确认的上游构建不一致');
        await this.pipelines.deployArtifact(
          delivery.pipelineId,
          {
            ...values,
            artifactIds,
            expectedConfigurationHash: prepared.configurationHash,
          },
          run.created_by,
          { ...options, expectedPlanHash: delivery.pipelineHash },
        );
        return;
      }
      if (digest([...delivery.artifactIds].sort()) !== digest([...artifacts].sort()))
        throw new ConflictException('实际产物实例与已确认计划不一致');
      await this.pipelines.deployArtifact(
        delivery.pipelineId,
        { ...values, artifactIds: delivery.artifactIds },
        run.created_by,
        options,
      );
    }
  }

  private async advance(runId: string, depth = 0) {
    const state = await this.settle(runId);
    if (!state) return;
    if (this.tasks)
      for (const taskId of state.cancel)
        await this.tasks.cancel(taskId, false).catch(() => undefined);
    for (const {
      node,
      action,
      values,
      environment,
      stage,
      workspacePath,
      capture,
    } of state.ready) {
      try {
        const automatic =
          isGraphTriggerKind(state.run.trigger_type) ||
          isGraphTriggerKind(state.snapshot.trigger?.kind);
        const needsAuthorization = isDelivery(action) || graphNodeRequiresIsolation(action.type);
        if (automatic && (needsAuthorization || state.snapshot.automation)) {
          if (!state.snapshot.automation)
            throw new ConflictException('当前节点缺少有效的自动交付授权或隔离策略');
          await assertGraphAutomation(
            this.database.db,
            state.run.project_id,
            state.run.created_by,
            state.snapshot.automation,
            needsAuthorization,
          );
        }
        const delivery = state.snapshot.simplified;
        if (delivery && stage && stage !== 'HEALTH') {
          if (!this.simplifiedRuns || !this.tasks)
            throw new ConflictException('运行工作区服务不可用');
          const link = (tx: Transaction<Database>, id: string) =>
            this.linkTask(tx, state.run, node, id, undefined, {
              buildDirectory: stage === 'ACTION' ? parallelBuildDirectory(action) : undefined,
            });
          if (stage === 'RELEASE')
            await this.simplifiedRuns.deploy(state.run, node, delivery, link);
          else
            await this.tasks.create(
              this.simplifiedRuns.task(
                state.run,
                node,
                action,
                delivery,
                stage,
                workspacePath,
                capture,
              ),
              state.run.created_by,
              (tx) => this.simplifiedRuns!.verifyTask(state.run, delivery, tx),
              link,
            );
        } else if (node.node_type === 'FLOW_CALL') {
          const childId = await this.callChild(
            state.run,
            node,
            this.flow(state.definition, action.flowId!),
            state.snapshot,
            values,
          );
          if (childId && depth < 10) await this.advance(childId, depth + 1);
        } else if (isNativeTask(action)) {
          await this.dispatchNative(
            state.run,
            node,
            action,
            values,
            state.flow,
            state.snapshot,
            environment,
          );
        } else {
          await this.dispatch(state.run, node, state.flow, state.snapshot, values, environment);
        }
      } catch (error) {
        if (error instanceof FlowWorkspaceBusy) continue;
        // A task id proves a committed dispatch even if a response or post-commit audit failed.
        const reason =
          error instanceof HttpException ? error.message : '节点无法提交，请查看任务或重新运行。';
        const previousEvidence = node.evidence_json
          ? (JSON.parse(node.evidence_json) as NodeEvidence)
          : {};
        const issue = error instanceof ExecutionPlanIssueError ? error.issue : undefined;
        await this.database.db
          .updateTable('execution_node_runs')
          .set({
            status: 'FAILED',
            finished_at: Date.now(),
            log: redactTaskLog(reason),
            ...(issue && { evidence_json: JSON.stringify({ ...previousEvidence, issue }) }),
          })
          .where('id', '=', node.id)
          .where('status', '=', 'PENDING')
          .where('task_id', 'is', null)
          .where('child_run_id', 'is', null)
          .execute();
      }
    }
    const final = state.ready.length || state.cancel.length ? await this.settle(runId) : state;
    if (
      final?.snapshot.simplified &&
      final.workspacePath &&
      isNodeTerminal(final.status) &&
      final.status !== 'NEEDS_ATTENTION'
    )
      await this.simplifiedRuns?.cleanup(
        final.run.id,
        final.snapshot.simplified,
        final.workspacePath,
      );
  }

  private async taskChanged(taskId: string) {
    const id = (
      await this.database.db
        .selectFrom('execution_node_runs')
        .select('run_id')
        .where('task_id', '=', taskId)
        .executeTakeFirst()
    )?.run_id;
    await this.advanceHierarchy(id);
  }

  private async advanceHierarchy(runId?: string) {
    let id = runId;
    while (id) {
      await this.advance(id);
      const row: { parent_run_id: string | null } | undefined = await this.database.db
        .selectFrom('execution_flow_runs')
        .select('parent_run_id')
        .where('id', '=', id)
        .executeTakeFirst();
      id = row?.parent_run_id ?? undefined;
    }
  }

  tick() {
    this.pumping ??= this.pump().finally(() => {
      this.pumping = undefined;
    });
    return this.pumping;
  }

  private async pump() {
    const db = this.database.db;
    const query = db
      .selectFrom('execution_flow_runs')
      .select(['id', 'created_at'])
      .where('status', 'in', activeFlowStatuses);
    const cursor = this.cursor;
    const rows = await (cursor ? query.where((eb) => eb.or([
      eb('created_at', '>', cursor.created_at),
      eb.and([eb('created_at', '=', cursor.created_at), eb('id', '>', cursor.id)]),
    ])) : query)
      .orderBy('created_at')
      .orderBy('id')
      .limit(50)
      .execute();
    this.cursor = rows.length === 50 ? rows.at(-1) : undefined;
    for (const { id } of rows) {
      try {
        await this.advance(id);
      } catch {
        this.logger.warn('执行流状态暂未更新，将在下一轮重试。');
      }
    }
  }

  async cancel(projectId: string, id: string, userId: string) {
    const db = this.database.db;
    const cancelled: string[] = [];
    await db.transaction().execute(async (tx) => {
      const target = await tx
        .selectFrom('execution_flow_runs')
        .select(['id', 'status', 'parent_run_id'])
        .where('id', '=', id)
        .where('project_id', '=', projectId)
        .executeTakeFirst();
      if (!target) throw new NotFoundException('执行记录不存在');
      if (isNodeTerminal(target.status)) throw new ConflictException('执行流已经结束');
      let batch = [target.id];
      while (batch.length) {
        await tx
          .updateTable('execution_flow_runs')
          .set({ status: 'CANCEL_REQUESTED' })
          .where('id', 'in', batch)
          .where('status', 'in', activeFlowStatuses)
          .execute();
        cancelled.push(...batch);
        batch = (
          await tx
            .selectFrom('execution_flow_runs')
            .select('id')
            .where('parent_run_id', 'in', batch)
            .execute()
        ).map((row) => row.id);
      }
      await this.audit.record(userId, 'execution-flow.cancel', 'flow-run', id, { projectId }, tx);
    });
    for (const runId of cancelled.reverse()) await this.advance(runId);
    return this.get(projectId, id);
  }

  async decideApproval(
    projectId: string,
    runId: string,
    nodeId: string,
    decision: 'APPROVE' | 'REJECT',
    userId: string,
    expectedScopeHash?: string,
  ) {
    const expired = await this.database.db.transaction().execute(async (tx) => {
      // Serialize the decision with cancellation, timeout, and worker advancement.
      const run = await tx
        .updateTable('execution_flow_runs')
        .set((eb) => ({ status: eb.ref('status') }))
        .where('id', '=', runId)
        .where('project_id', '=', projectId)
        .returningAll()
        .executeTakeFirst();
      if (!run) throw new NotFoundException('执行记录不存在');
      if (isNodeTerminal(run.status) || run.status === 'CANCEL_REQUESTED')
        throw new ConflictException('此执行流已结束或正在取消');
      const row = await tx
        .selectFrom('execution_node_runs')
        .selectAll()
        .where('run_id', '=', runId)
        .where('node_id', '=', nodeId)
        .where('node_type', 'in', ['APPROVAL', 'SOURCE_REVIEW'])
        .executeTakeFirst();
      if (!row) throw new NotFoundException('审批节点不存在');
      if (row.status !== 'WAITING' || row.started_at === null)
        throw new ConflictException('此节点没有等待审批');
      const { definition } = await this.published(projectId, run.version, tx);
      const node = this.flow(definition, run.flow_id).nodes.find(({ id }) => id === nodeId)!;
      const now = Date.now();
      const expiresAt = approvalDeadline(node, row.started_at);
      if (now >= expiresAt) {
        await this.expireApproval(tx, row, expiresAt, now);
        return true;
      }
      const waiting: GraphGateDecision = JSON.parse(row.output_json ?? '{}');
      if (
        waiting.scopeHash !== expectedScopeHash ||
        (waiting.scope &&
          graphGateHash(runId, nodeId, run.configuration_hash, waiting.scope) !== expectedScopeHash)
      )
        throw new ConflictException('审批范围已变化，请刷新并核对当前范围');
      if (node.type === 'SOURCE_REVIEW' && waiting.scope?.kind !== 'SOURCE_REVIEW')
        throw new ConflictException('源码审核缺少有效的固定来源');
      const approved = decision === 'APPROVE';
      await this.terminalNode(
        tx,
        row,
        approved ? 'SUCCESS' : 'FAILED',
        approved
          ? node.type === 'SOURCE_REVIEW'
            ? '管理员已审核通过。'
            : '管理员已批准。'
          : '管理员已拒绝。',
        {
          ...waiting,
          decision,
          actorId: userId,
          decidedAt: now,
          expiresAt,
          ...(approved &&
            node.type === 'SOURCE_REVIEW' && {
              review: { runId, nodeId, actorId: userId, hash: waiting.scopeHash },
            }),
        },
        row.started_at,
        now,
      );
      await this.audit.record(
        userId,
        node.type === 'SOURCE_REVIEW'
          ? 'execution-flow.source-review.decision'
          : 'execution-flow.approval.decision',
        'flow-run',
        runId,
        {
          projectId,
          nodeId,
          decision,
          scopeHash: waiting.scopeHash,
        },
        tx,
      );
      return false;
    });
    await this.advanceHierarchy(runId);
    if (expired) throw new ConflictException('此节点的审批等待已超时');
    return this.get(projectId, runId);
  }

  private runs(projectId: string) {
    return this.database.db
      .selectFrom('execution_flow_runs as r')
      .select([
        'r.id',
        'r.graph_id as graphId',
        'r.project_id as projectId',
        'r.created_by as createdBy',
        'r.version',
        'r.flow_id as flowId',
        'r.flow_name as flowName',
        'r.created_at as createdAt',
        'r.finished_at as finishedAt',
        'r.status',
        'r.task_id as taskId',
        'r.parent_run_id as parentRunId',
        'r.trigger_type as triggerType',
      ])
      .where('r.project_id', '=', projectId);
  }

  async list(projectId: string, before?: string) {
    const db = this.database.db;
    const project = await db
      .selectFrom('projects')
      .select('id')
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!project) throw new NotFoundException('项目不存在');
    let query = this.runs(projectId);
    if (before) {
      const cursor = await db
        .selectFrom('execution_flow_runs')
        .select(['id', 'created_at'])
        .where('project_id', '=', projectId)
        .where('id', '=', before)
        .executeTakeFirst();
      if (!cursor) throw new NotFoundException('执行记录游标不存在');
      query = query.where((eb) =>
        eb.or([
          eb('r.created_at', '<', cursor.created_at),
          eb.and([eb('r.created_at', '=', cursor.created_at), eb('r.id', '<', cursor.id)]),
        ]),
      );
    }
    return (
      await query.orderBy('r.created_at', 'desc').orderBy('r.id', 'desc').limit(100).execute()
    ).map((row) => ({
      ...row,
      triggerType: row.triggerType ?? (row.parentRunId ? 'FLOW_CALL' : 'MANUAL'),
    }));
  }

  async nodeLogs(projectId: string, runId: string, nodeId: string, offset = 0) {
    const row = await this.database.db
      .selectFrom('execution_node_runs as node')
      .innerJoin('execution_flow_runs as run', 'run.id', 'node.run_id')
      .leftJoin('tasks as task', 'task.id', 'node.task_id')
      .select([
        'node.log',
        'node.status',
        'node.started_at as startedAt',
        'node.finished_at as finishedAt',
        'task.id as taskId',
        'task.status as taskStatus',
        'task.available_at as availableAt',
        'task.started_at as taskStartedAt',
      ])
      .where('run.project_id', '=', projectId)
      .where('run.id', '=', runId)
      .where('node.node_id', '=', nodeId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('执行节点不存在');
    const status =
      row.taskStatus && !isNodeTerminal(row.status)
        ? taskStatus(row.taskStatus, row.availableAt ?? 0)
        : row.status;
    const persisted = redactTaskLog(row.log);
    const summary = persisted.trim()
      ? persisted
      : row.finishedAt !== null
        ? '节点执行已结束。'
        : row.taskStartedAt !== null || row.startedAt !== null
          ? '节点已开始执行。'
          : '节点尚未开始执行。';
    const timestamps = {
      startedAt: row.taskStartedAt ?? row.startedAt,
      finishedAt: row.finishedAt,
    };
    if (row.taskId && this.tasks)
      return {
        source: 'TASK' as const,
        status,
        ...timestamps,
        summary,
        ...(await this.tasks.logs(row.taskId, offset)),
      };
    return {
      source: 'NODE' as const,
      status,
      ...timestamps,
      summary,
      content: offset === 0 ? summary : '',
      nextOffset: Math.max(offset, Buffer.byteLength(summary)),
    };
  }

  async get(projectId: string, id: string) {
    const rows = await this.runs(projectId)
      .innerJoin('execution_node_runs as n', 'n.run_id', 'r.id')
      .leftJoin('tasks as t', 'n.task_id', 't.id')
      .select([
        'r.inputs_json',
        'r.workspace_path as workspacePath',
        'n.node_id as nodeId',
        'n.node_type as type',
        'n.name',
        'n.status as nodeStatus',
        'n.log',
        'n.started_at as nodeStartedAt',
        'n.finished_at as nodeFinishedAt',
        'n.task_id as nodeTaskId',
        'n.child_run_id as childRunId',
        'n.output_json as output',
        'n.dispatch_json as dispatch',
        'n.evidence_json as evidence',
        't.status as taskStatus',
        't.payload_json as payload',
        't.available_at as availableAt',
        't.started_at as taskStartedAt',
      ])
      .where('r.id', '=', id)
      .orderBy('n.position')
      .execute();
    const row = rows[0];
    if (!row) throw new NotFoundException('执行记录不存在');
    const { definition } = await this.published(projectId, row.version);
    const flow = this.flow(definition, row.flowId);
    const { inputs, trigger, environmentSet, parameterSources, checkoutProvenance, simplified } =
      JSON.parse(row.inputs_json) as RunSnapshot;
    const deliveries = rows.flatMap(({ dispatch, type }) => {
      if (!dispatch || (type !== 'BUILD' && !isRelease({ type: type as GraphNode['type'] })))
        return [];
      const delivery = JSON.parse(dispatch) as Delivery;
      return [publicDelivery(delivery, definition)];
    });
    const taskIds = rows.flatMap(({ nodeTaskId }) => (nodeTaskId ? [nodeTaskId] : []));
    const targetRows = taskIds.length
      ? await this.database.db
          .selectFrom('task_targets')
          .select([
            'id as targetRowId',
            'task_id as taskId',
            'server_id as serverId',
            'server_name_snapshot as serverName',
            'status',
            'exit_code as exitCode',
            'error_summary as errorSummary',
            'started_at as startedAt',
            'finished_at as finishedAt',
          ])
          .where('task_id', 'in', taskIds)
          .orderBy('server_name_snapshot')
          .execute()
      : [];
    const inspectionTasks = new Set(
      rows
        .filter(({ type }) =>
          ['DEPLOY_ARTIFACT', 'ROLLBACK_ARTIFACT', 'HEALTH_CHECK'].includes(type),
        )
        .map(({ nodeTaskId }) => nodeTaskId),
    );
    const observations = await latestReleaseInspections(
      this.database.db,
      targetRows.flatMap(({ taskId, targetRowId }) =>
        inspectionTasks.has(taskId) ? [targetRowId] : [],
      ),
    );
    type TargetDetail = Omit<(typeof targetRows)[number], 'targetRowId'> & {
      inspection?: ReturnType<typeof observations.get>;
    };
    const targetsByTask = new Map<string, TargetDetail[]>();
    for (const { targetRowId, ...value } of targetRows) {
      const target: TargetDetail = {
        ...value,
        errorSummary: value.errorSummary && redactTaskLog(value.errorSummary),
        inspection: observations.get(targetRowId),
      };
      const saved = targetsByTask.get(target.taskId);
      if (saved) saved.push(target);
      else targetsByTask.set(target.taskId, [target]);
    }
    const nodes = rows.map((n) => {
      const evidence = n.evidence ? (JSON.parse(n.evidence) as NodeEvidence) : undefined;
      const task = n.payload ? (JSON.parse(n.payload) as TaskPayload) : undefined;
      return {
        nodeId: n.nodeId,
        name: n.name,
        type: n.type,
        log: n.log,
        status:
          n.taskStatus && !isNodeTerminal(n.nodeStatus)
            ? taskStatus(n.taskStatus, n.availableAt ?? 0)
            : n.nodeStatus,
        taskId: n.nodeTaskId,
        snapshotTaskId: evidence?.snapshotTaskId,
        logSource: n.nodeTaskId ? 'TASK' : 'NODE',
        childRunId: n.childRunId,
        startedAt: n.taskStartedAt ?? n.nodeStartedAt,
        finishedAt: n.nodeFinishedAt,
        output: n.output ? (JSON.parse(n.output) as object) : undefined,
        inputs: evidence?.inputs,
        environment: evidence?.environment,
        outputFields: evidence?.outputFields,
        issue: evidence?.issue,
        targets: n.nodeTaskId ? targetsByTask.get(n.nodeTaskId) : undefined,
        checkout: checkoutProvenance?.[n.nodeId],
        variableSources:
          task?.graphModule?.variableSources ??
          (n.dispatch
            ? this.nodeVariableSources(
                n.dispatch,
                n.type,
                task?.pipeline?.graph?.nodeEnvironmentSources,
              )
            : undefined),
      };
    });
    const built = await this.taskArtifacts(
      rows.flatMap((n) => (n.nodeTaskId ? [n.nodeTaskId] : [])),
    );
    const snapshots =
      simplified && this.simplifiedRuns
        ? await this.simplifiedRuns.snapshotArtifacts(this.database.db, id, true)
        : [];
    const releaseAction =
      simplified?.release && nodes.find(({ nodeId }) => nodeId === simplified.release!.nodeId);
    const releaseFact = (
      releaseAction?.output as
        { release?: { targets?: { artifactInstanceId?: string }[] } } | undefined
    )?.release;
    const releaseArtifactId =
      simplified?.release?.artifactId ??
      releaseFact?.targets?.find(({ artifactInstanceId }) => artifactInstanceId)
        ?.artifactInstanceId;
    const artifacts = [
      ...new Set([
        ...deliveries.flatMap((d) => d.artifactIds),
        ...built.map((artifact) => artifact.id),
        ...snapshots.map(({ id }) => id),
        ...(simplified?.release?.artifactId ? [simplified.release.artifactId] : []),
      ]),
    ];
    return {
      ...deliveries[0],
      id,
      projectId,
      graphId: row.graphId,
      version: row.version,
      flowId: row.flowId,
      flowName: row.flowName,
      status: row.status,
      parentRunId: row.parentRunId,
      taskId: row.taskId,
      createdAt: row.createdAt,
      startedAt: row.createdAt,
      finishedAt: row.finishedAt,
      createdBy: row.createdBy,
      triggerType: row.triggerType ?? (row.parentRunId ? 'FLOW_CALL' : 'MANUAL'),
      definition: flow,
      inputs: { ...inputs, parameters: publicParameters(flow, inputs.parameters) },
      parameterSources,
      environmentSet: environmentSet ?? null,
      trigger: trigger ?? { triggeredAt: row.createdAt },
      outputs:
        nodes.find((node) => node.nodeId === flowEnd(flow).id && node.status === 'SUCCESS')
          ?.output ?? {},
      deliveries,
      artifactIds: artifacts,
      simplified: simplified && {
        location: simplified.placement.location,
        serverId:
          simplified.placement.location === 'TARGET' ? simplified.placement.target.id : undefined,
        serverName:
          simplified.placement.location === 'TARGET' ? simplified.placement.target.name : undefined,
        sources: simplified.sources.map(({ id, directory, source }) => ({
          id,
          path: directory,
          repositoryId: source.repositoryId,
          repositoryName: source.repositoryName,
          commitSha: source.commitSha,
          ref: source.ref,
          branch: source.branch,
          tag: source.tag,
        })),
        workspaceSource: simplifiedUsesWorkspace(flow.nodes)
          ? publicWorkspaceSource(simplified)
          : undefined,
        finish: simplified.finish,
        imageTag: simplified.finish.images?.some(({ source }) => source !== 'REGISTRY')
          ? flowImageTag(id)
          : undefined,
        release: simplified.release && {
          serviceId: simplified.release.serviceId,
          serverIds: simplified.release.serverIds,
          artifactId: releaseArtifactId,
          contentPath: simplified.release.path === '.' ? undefined : simplified.release.path,
          method: simplified.release.method,
          image: simplified.release.image,
          images: simplified.release.images,
        },
        workspacePath: row.workspacePath,
        artifacts: snapshots.map((artifact) => ({
          id: artifact.id,
          name: artifact.artifact_name,
          kind: artifact.artifact_kind,
          checksum: artifact.checksum,
          digest: artifact.image_digest,
          commitSha: artifact.source_commit,
          temporary: Boolean(artifact.temporary_root_id),
          imageReference:
            artifact.artifact_type === 'DOCKER_IMAGE' ? artifact.storage_key : undefined,
          lifecycleState: artifact.lifecycle_state,
        })),
      },
      nodes,
    };
  }

  private nodeVariableSources(
    dispatch: string,
    type: string,
    actualBuildSources?: readonly GraphVariableSource[],
  ) {
    const plan = JSON.parse(dispatch) as GraphNodePlan | Delivery;
    if ('pipelineId' in plan) {
      return graphVariableSources(
        plan.environmentFile,
        (plan.configuration?.variables ?? []).map(({ sensitive, ...entry }) => ({
          ...entry,
          isSecret: sensitive,
        })),
        actualBuildSources ?? plan.buildEnvironment?.sources,
      );
    }
    if (type === 'LOAD_ENV' && plan.type === 'LOAD_ENV') return plan.variables;
    if (plan.type === 'SHELL' || plan.type === 'CHECK') return plan.variableSources;
    return undefined;
  }
}

function approvalDeadline(node: GraphNode, startedAt: number) {
  return startedAt + (node.approval?.timeoutSeconds ?? defaultApprovalSeconds) * 1000;
}
