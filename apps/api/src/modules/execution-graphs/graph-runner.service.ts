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
import { createHash, randomUUID } from 'node:crypto';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { PipelineDefinitionDto } from '../pipelines/pipeline.dto';
import type { PipelineDefinition } from '../pipelines/pipeline.types';
import {
  deliveryExecutionProfile,
  type DeliveryExecutionProfile,
} from '../pipelines/delivery-execution-profile';
import { pendingReleaseApprovalTime } from '../deployments/release-policy';
import { lockProjectGraph, requireProject } from '../projects/project-relations';
import { runResourceReferences } from '../projects/project-resource-references';
import { unavailableReference } from '../projects/project-resource-protection';
import { RepositoryMetadataService } from '../projects/repository-metadata.service';
import { TaskHandlerRegistry } from '../tasks/task-handler.registry';
import { TasksService } from '../tasks/tasks.service';
import type { TaskPayload } from '../tasks/tasks.types';
import { redactTaskLog } from '../tasks/task-log.service';
import {
  defaultApprovalSeconds,
  type GraphDefinition,
  type GraphFlow,
  type GraphNode,
} from './execution-graph-definition';
import type { GraphInputsDto, GraphPreviewDto, GraphRunDto } from './graph-runner.controller';
import { GraphNodeTasks, type GraphNodePlan } from './graph-node-tasks';
import {
  unversionedArtifactCommit,
  unversionedArtifactRepository,
  type GraphEnvironmentRef,
  type GraphWorkspaceRef,
} from './graph-workspace';
import type { GraphBinding, GraphField } from './graph-fields';
import {
  artifactIds as boundArtifactIds,
  bindingContext,
  bindingValue,
  checkedParameters,
  declaredScope,
  flowEnd,
  flowStart,
  nodeBindings,
  outputReferences,
  outputSources,
  referenceId,
  stringValue,
  type GitRefValue,
  type Values,
} from './graph-run-bindings';
import {
  activeFlowStatuses,
  branchMatch,
  failureStatus,
  flowSelection,
  graphNodeOutput,
  graphTaskKeyPrefix,
  isDelivery,
  isNodeTerminal,
} from './graph-run-lifecycle';

type Run = Selectable<Database['execution_flow_runs']>;
type NodeRun = Selectable<Database['execution_node_runs']>;
type DeliveryPreview =
  | Awaited<ReturnType<PipelinesService['preview']>>
  | Awaited<ReturnType<PipelinesService['previewArtifactDeploy']>>;
interface Delivery {
  nodeId: string;
  flowId: string;
  pipelineId: string;
  pipelineVersion: number;
  serviceId: string;
  environmentId: string;
  commitSha: string;
  serverIds: string[];
  requireApproval: boolean;
  requireCodeReview?: boolean;
  artifactIds: string[];
  artifactFromNodeId?: string;
  artifactFromField?: string;
  artifactBinding?: GraphBinding;
  alternatives?: Delivery[];
  artifactRefs?: Values[];
  targetInputs?: GraphInputsDto;
  sourceSnapshot?: {
    id?: string;
    repositoryId?: string;
    commitSha: string;
    branch?: string;
    tag?: string;
  }[];
  pipelineHash: string;
  profile?: DeliveryExecutionProfile;
}
interface RunSnapshot {
  inputs: GraphInputsDto;
  deliveries?: Record<string, Delivery | GraphNodePlan>;
  rootId?: string;
  trigger?: Values;
  children?: Record<string, PreparedChild>;
}

interface PreparedChild {
  inputHash: string;
  inputs: GraphInputsDto;
  plans: Record<string, Delivery | GraphNodePlan>;
  children: Record<string, PreparedChild>;
  produced: Record<string, PreparedProduction[]>;
  confirmedOutputs: Values;
}

interface PreparedProduction {
  definition: PipelineDefinition;
  commitSha: string;
  serviceId?: string;
  environmentId?: string;
  kind?: GraphField['artifactType'];
  sourceSnapshot?: Delivery['sourceSnapshot'];
}

const outputKey = (nodeId: string, fieldId: string) => `${nodeId}:${fieldId}`;

const planKey = (flowId: string, nodeId: string) => `${flowId}:${nodeId}`;
function publicDelivery(delivery: Delivery) {
  const native = Boolean(delivery.profile);
  return {
    ...delivery,
    pipelineHash: undefined,
    profile: undefined,
    alternatives: undefined,
    artifactBinding: undefined,
    targetInputs: undefined,
    possibleArtifacts: delivery.alternatives?.map((candidate) => ({
      nodeId: candidate.artifactFromNodeId,
      fieldId: candidate.artifactFromField,
      commitSha: candidate.commitSha,
      artifactIds: candidate.artifactIds,
    })),
    ...(native && { pipelineId: undefined, pipelineVersion: undefined }),
  };
}
function isNativeTask(node: Pick<GraphNode, 'type'>) {
  return ['CHECKOUT', 'SHELL', 'CHECK', 'LOAD_ENV', 'REGISTER_ARTIFACT'].includes(node.type);
}

interface AutomaticRunOrigin {
  triggerType: 'CRON' | 'WEBHOOK' | 'API' | 'UPSTREAM';
  metadata?: Values;
  beforeInsert?: (tx: Transaction<Database>) => Promise<void>;
  afterInsert?: (tx: Transaction<Database>, runId: string) => Promise<void>;
}

function digest(value: unknown) {
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
  return createHash('sha256').update(encoded).digest('hex');
}

function checkRequest(previous: { request_hash: string }, hash: string) {
  if (previous.request_hash !== hash) throw new ConflictException('此提交标识已用于另一组运行参数');
}

function taskStatus(status: string, availableAt: number) {
  if (status === 'PENDING')
    return availableAt === pendingReleaseApprovalTime ? 'WAITING' : 'QUEUED';
  return status;
}

@Injectable()
export class GraphRunnerService implements OnModuleInit {
  private readonly logger = new Logger(GraphRunnerService.name);
  private cursor?: string;
  private pumping?: Promise<void>;
  constructor(
    private readonly database: DatabaseService,
    private readonly pipelines: PipelinesService,
    private readonly audit: AuditService,
    @Optional() private readonly registry?: TaskHandlerRegistry,
    @Optional() private readonly tasks?: TasksService,
    @Optional() private readonly nodeTasks?: GraphNodeTasks,
    @Optional() private readonly repositories?: RepositoryMetadataService,
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

  private async artifactReferences(projectId: string, ids: string[], field?: GraphField) {
    if (!ids.length) return [];
    const rows = await this.database.db
      .selectFrom('artifacts')
      .leftJoin('pipeline_runs as build', 'build.id', 'artifacts.pipeline_run_id')
      .select([
        'artifacts.id',
        'artifacts.artifact_type',
        'artifacts.artifact_kind',
        'artifacts.artifact_name',
        'artifacts.checksum',
        'artifacts.image_digest',
        'artifacts.server_id',
        'artifacts.service_id',
        'artifacts.source_commit',
        'build.environment_id',
      ])
      .where('artifacts.project_id', '=', projectId)
      .where('artifacts.id', 'in', ids)
      .where('artifacts.pruned_at', 'is', null)
      .where('artifacts.archive_deleted_at', 'is', null)
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => {
      const row = byId.get(id);
      const kind = row?.artifact_kind ?? row?.artifact_type;
      if (!row || (field?.artifactType && kind !== field.artifactType))
        throw new BadRequestException('选中的产物不可用、类型不匹配或不属于当前项目');
      return {
        id,
        name: row.artifact_name,
        type: kind,
        checksum: row.checksum,
        digest: row.image_digest,
        serverId: row.server_id,
        serviceId: row.service_id,
        environmentId: row.environment_id,
        commitSha: row.source_commit,
      };
    });
  }

  private async resolveParameters(projectId: string, flow: GraphFlow, input: GraphInputsDto) {
    const parameters = checkedParameters(flow, input.parameters, true);
    const inputs = { ...input, parameters };
    const scope = declaredScope(flow, inputs);
    for (const field of flowStart(flow).inputs ?? []) {
      const value = parameters[field.id];
      if (value === undefined) continue;
      if (field.type === 'ARTIFACT') {
        const refs = await this.artifactReferences(projectId, boundArtifactIds(value), field);
        parameters[field.id] = field.multiple ? refs : refs[0];
      }
      const table =
        field.type === 'REPOSITORY'
          ? 'repositories'
          : field.type === 'ENVIRONMENT'
            ? 'environments'
            : field.type === 'SERVICE'
              ? 'services'
              : undefined;
      if (table) {
        const ids = (Array.isArray(value) ? value : [value]).map(referenceId);
        if (ids.some((id) => !id)) throw new BadRequestException('项目资源引用无效');
        const rows = await this.database.db
          .selectFrom(table)
          .select('id')
          .where('project_id', '=', projectId)
          .where('archived_at', 'is', null)
          .where('id', 'in', [...new Set(ids)] as string[])
          .execute();
        if (rows.length !== new Set(ids).size)
          throw new BadRequestException(field.name + ' 不属于当前项目');
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
  ) {
    const remaining = (flowStart(flow).inputs ?? []).filter(
      (field) =>
        field.selection === 'LATEST_COMPATIBLE' && inputs.parameters?.[field.id] === undefined,
    );
    if (!remaining.length) return;
    const { serviceId, environmentId } = declaredScope(flow, inputs);
    if (!serviceId || !environmentId)
      throw new BadRequestException('获取最新产物需要选择项目服务和环境');
    for (const field of remaining) {
      const results = await this.database.db
        .selectFrom('artifacts')
        .innerJoin('pipeline_runs as build', 'build.id', 'artifacts.pipeline_run_id')
        .innerJoin('tasks', 'tasks.id', 'build.task_id')
        .select(['artifacts.id', 'artifacts.pipeline_run_id', 'artifacts.artifact_name'])
        .where('artifacts.project_id', '=', projectId)
        .where('artifacts.service_id', '=', serviceId)
        .where('build.environment_id', '=', environmentId)
        .where('tasks.status', '=', 'SUCCESS')
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
      if (!first) throw new BadRequestException(`参数「${field.name}」没有可用产物`);
      const ids = field.multiple
        ? results
            .filter(
              (row) =>
                row.pipeline_run_id === first.pipeline_run_id &&
                row.artifact_name === first.artifact_name,
            )
            .map((row) => row.id)
        : [first.id];
      const refs = await this.artifactReferences(projectId, ids, field);
      inputs.parameters![field.id] = field.multiple ? refs : refs[0];
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
  ): Promise<Delivery> {
    const scope = declaredScope(flow, inputs);
    const serviceId = referenceId(values.service) ?? scope.serviceId;
    const environmentId = referenceId(values.environment) ?? scope.environmentId;
    if (!serviceId) throw new BadRequestException(node.name + '：请选择项目服务');
    if (!environmentId) throw new BadRequestException(node.name + '：请选择运行环境');
    if (flow.serviceId && serviceId !== flow.serviceId)
      throw new BadRequestException(node.name + '：节点服务必须与执行流关联服务一致');
    if (flow.serviceId && scope.environmentId && environmentId !== scope.environmentId)
      throw new BadRequestException(node.name + '：节点环境必须与执行流所选环境一致');
    const base = {
      environmentId,
      targetId: inputs.targetId,
      serverIds: inputs.serverIds,
      groupIds: inputs.groupIds,
      strategy: inputs.strategy,
      maxParallel: inputs.maxParallel,
      failurePolicy: inputs.failurePolicy,
      ...(values.targets as GraphInputsDto | undefined),
    };
    const makeProfile = (definition: PipelineDefinition, fields: string[] = []) =>
      deliveryExecutionProfile(
        projectId,
        serviceId,
        flow.id + ':' + node.id,
        graphVersion,
        node.name,
        definition,
        fields,
      );
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
      environmentId: preview.environmentId,
      commitSha: preview.commitSha,
      serverIds: preview.serverIds,
      requireApproval: preview.requireApproval,
      requireCodeReview: 'requireCodeReview' in preview && preview.requireCodeReview === true,
      artifactIds: 'artifactIds' in preview ? preview.artifactIds : [],
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
    });
    if (node.type === 'BUILD') {
      const build = node.build ?? {};
      const { branch, commitSha: pinned, ...settings } = build;
      const source = (values.source ?? values.workspace) as
        { repositoryId?: string; commitSha?: string; branch?: string; tag?: string } | undefined;
      const repositoryId =
        referenceId(values.repository) ?? source?.repositoryId ?? settings.repositoryId;
      if (!repositoryId) throw new BadRequestException(node.name + '：构建缺少源码或仓库');
      const ref = values.version as GitRefValue | undefined;
      const sha = source?.commitSha ?? pinned ?? (ref ? undefined : inputs.commitSha);
      const fixed = sha
        ? { commitSha: sha, branch: source?.branch, tag: source?.tag }
        : await this.pinnedSource(projectId, repositoryId, ref, branch);
      const definition = Object.assign(new PipelineDefinitionDto(), settings, {
        repositoryId,
        inheritBuildLocation: !settings.buildLocation,
      });
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
      return wrap(preview, profile, {
        branch: 'branch' in fixed ? fixed.branch : undefined,
        tag: 'tag' in fixed ? fixed.tag : undefined,
      });
    }

    const fromBuild = (definition: PipelineDefinition, type?: string) =>
      makeProfile(
        Object.assign(
          new PipelineDefinitionDto(),
          {
            repositoryId: definition.repositoryId,
            artifactType:
              type === 'DOCKER_IMAGE' ? 'DOCKER_IMAGE' : type ? 'FILE' : definition.artifactType,
            registryId: definition.registryId,
            imageRepository: definition.imageRepository,
          },
          node.deploy,
        ),
        Object.keys(node.deploy ?? {}),
      );
    const binding = flow.inputBindings?.[node.id]?.artifact;
    const plans: Delivery[] = [];
    const ids = boundArtifactIds(values.artifact ?? inputs.artifactIds);
    const start = flowStart(flow);
    const inputField =
      binding?.kind === 'INPUT'
        ? start.inputs?.find((field) => field.id === binding.fieldId)
        : undefined;
    if (ids.length) {
      const refs = await this.artifactReferences(projectId, ids, inputField);
      if (refs.some((ref) => ref.serviceId !== serviceId || ref.environmentId !== environmentId))
        throw new BadRequestException(node.name + '：产物不属于当前服务及运行环境');
      const source = await this.pipelines.deliveryArtifactBuild(
        projectId,
        serviceId,
        environmentId,
        ids,
      );
      const profile = fromBuild(source.definition, refs[0]?.type);
      const preview = await this.pipelines.previewArtifactDeploy(
        profile.id,
        { ...base, artifactIds: ids },
        profile,
      );
      plans.push({ ...wrap(preview, profile), artifactRefs: refs });
    } else if (inputField?.selection === 'LATEST_COMPATIBLE') {
      const latest = await this.latestDeliveryArtifact(
        projectId,
        serviceId,
        base,
        fromBuild,
        inputField,
      );
      const wrapped = wrap(latest.preview, latest.profile);
      plans.push({
        ...wrapped,
        artifactRefs: await this.artifactReferences(projectId, wrapped.artifactIds, inputField),
      });
      inputs.parameters![inputField.id] = inputField.multiple
        ? plans[0]!.artifactRefs
        : plans[0]!.artifactRefs?.[0];
    }
    for (const source of outputSources(binding)) {
      for (const producer of production.get(outputKey(source.nodeId, source.fieldId)) ?? []) {
        if (
          (producer.serviceId && producer.serviceId !== serviceId) ||
          (producer.environmentId && producer.environmentId !== environmentId)
        )
          throw new BadRequestException(node.name + '：上游生产者和部署的服务或环境不一致');
        const profile = fromBuild(producer.definition, producer.kind);
        const plan = await this.pipelines.previewArtifactDeployPlan(
          profile.id,
          {
            ...base,
            commitSha: producer.commitSha,
          },
          profile,
        );
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
          artifactIds: [],
          artifactFromNodeId: source.nodeId,
          artifactFromField: source.fieldId,
          sourceSnapshot: producer.sourceSnapshot,
          pipelineHash: plan.configurationHash,
          targetInputs: base,
        });
      }
    }
    if (!plans.length)
      throw new BadRequestException(node.name + '：请绑定可部署的已登记产物或上游具名产物');
    return {
      ...plans[0]!,
      artifactBinding: binding,
      ...(plans.length > 1 && { alternatives: plans }),
    };
  }

  private async latestDeliveryArtifact(
    projectId: string,
    serviceId: string,
    inputs: Pick<
      GraphInputsDto,
      'targetId' | 'serverIds' | 'groupIds' | 'strategy' | 'maxParallel' | 'failurePolicy'
    > & { environmentId: string },
    makeProfile: (definition: PipelineDefinition, type?: string) => DeliveryExecutionProfile,
    field: GraphField,
  ) {
    const builds = await this.pipelines.deliveryArtifactCandidates(
      projectId,
      serviceId,
      inputs.environmentId,
    );
    for (const build of builds) {
      const snapshot = (JSON.parse(build.payload_json) as TaskPayload).pipeline;
      if (!snapshot || snapshot.mode === 'DEPLOY_ARTIFACT') continue;
      try {
        const profile = makeProfile(snapshot.definition, field.artifactType);
        const targets = await this.pipelines.previewArtifactDeployPlan(
          profile.id,
          { ...inputs, commitSha: build.commit_sha },
          profile,
        );
        const ids = await this.pipelines.deliveryArtifactIds(
          build.id,
          targets.serverIds,
          field.artifactType,
        );
        if (!ids.length || (!field.multiple && ids.length !== 1)) continue;
        await this.artifactReferences(projectId, ids, field);
        const preview = await this.pipelines.previewArtifactDeploy(
          profile.id,
          { ...inputs, artifactIds: ids },
          profile,
        );
        return { profile, preview };
      } catch (error) {
        if (!(error instanceof HttpException) || ![400, 404, 409].includes(error.getStatus()))
          throw error;
      }
    }
    throw new BadRequestException('当前服务和环境没有与所选目标兼容的最新产物');
  }

  private async prepare(
    projectId: string,
    flowId: string,
    request: GraphPreviewDto,
    trigger?: Values,
    allowRetired = false,
  ) {
    await requireProject(this.database.db, projectId);
    const { graphId, definition } = await this.published(
      projectId,
      request.version,
      this.database.db,
      !allowRetired,
    );
    const flow = this.flow(definition, flowId);
    const inputs = await this.resolveParameters(projectId, flow, request.inputs ?? {});
    if (inputs.value && redactTaskLog(inputs.value) !== inputs.value)
      throw new BadRequestException('条件值只接受普通文本，请移除凭据');
    const checkouts: {
      nodeId: string;
      flowId: string;
      repositoryId: string;
      branch?: string;
      tag?: string;
      commitSha: string;
      fullClone: boolean;
    }[] = [];
    const scripts: {
      nodeId: string;
      flowId: string;
      serverId?: string;
      serverName?: string;
      serviceId?: string;
      environmentId?: string;
    }[] = [];
    const publishedDeliveries: Delivery[] = [];
    let invocations = 0;
    const prepareFlow = async (
      current: GraphFlow,
      args: GraphInputsDto,
      inputHash = '',
    ): Promise<PreparedChild> => {
      if (++invocations > 100) throw new BadRequestException('一次运行展开的子流过多');
      const plans = new Map<string, Delivery | GraphNodePlan>();
      const production = new Map<string, PreparedProduction[]>();
      const children: Record<string, PreparedChild> = Object.create(null);
      const outputs = new Map<string, Values>();
      const state = bindingContext(projectId, current, args, outputs, trigger);
      const selection = flowSelection(current, args, state);
      const scope = declaredScope(current, args);
      for (const node of selection.ordered) {
        if (!selection.selected.has(node.id)) continue;
        const key = planKey(current.id, node.id);
        const values = nodeBindings(current, node, state, [
          'repository',
          'version',
          'source',
          'workspace',
          'service',
          'environment',
          'targets',
          'artifact',
          'path',
          'image',
          'variables',
        ]);
        if (isDelivery(node)) {
          const delivery = await this.delivery(
            projectId,
            current,
            request.version,
            node,
            args,
            values,
            production,
          );
          plans.set(key, delivery);
          publishedDeliveries.push(delivery);
          if (node.type === 'BUILD' && delivery.profile) {
            const definition = delivery.profile.definition;
            const named = node.build?.artifacts ?? [
              { name: 'artifact', type: definition.artifactType },
            ];
            const source = {
              definition,
              commitSha: delivery.commitSha,
              serviceId: delivery.serviceId,
              environmentId: delivery.environmentId,
              sourceSnapshot: delivery.sourceSnapshot,
            };
            for (const artifact of named)
              production.set(outputKey(node.id, artifact.name), [
                { ...source, kind: artifact.type },
              ]);
            if (named.length === 1)
              production.set(outputKey(node.id, 'artifacts'), [
                { ...source, kind: named[0]!.type },
              ]);
          }
        } else if (isNativeTask(node)) {
          if (!this.nodeTasks) throw new BadRequestException('执行节点服务不可用');
          const plan = await this.nodeTasks.prepare(projectId, node, {
            serviceId: referenceId(values.service) ?? scope.serviceId,
            environmentId: referenceId(values.environment) ?? scope.environmentId,
            values,
            trigger,
          });
          plans.set(key, plan);
          if (node.type === 'REGISTER_ARTIFACT') {
            const origin = (values.source ?? values.workspace) as Values | undefined;
            const repositoryId = stringValue(origin?.repositoryId) ?? unversionedArtifactRepository;
            const commitSha = stringValue(origin?.commitSha) ?? unversionedArtifactCommit;
            const definition = Object.assign(new PipelineDefinitionDto(), { repositoryId });
            const named = node.registerArtifacts?.artifacts ?? [];
            const source = {
              definition,
              commitSha,
              serviceId: referenceId(values.service) ?? scope.serviceId,
              environmentId: referenceId(values.environment) ?? scope.environmentId,
              sourceSnapshot: [{ repositoryId, commitSha }],
            };
            for (const artifact of named)
              production.set(outputKey(node.id, artifact.name), [
                { ...source, kind: artifact.type },
              ]);
            if (named.length === 1)
              production.set(outputKey(node.id, 'artifacts'), [
                { ...source, kind: named[0]!.type },
              ]);
          }
          if (plan.type === 'CHECKOUT') {
            const { repositoryId, branch, tag, commitSha, fullClone } = plan.source;
            outputs.set(node.id, { source: plan.source, workspace: plan.source });
            checkouts.push({
              nodeId: node.id,
              flowId: current.id,
              repositoryId,
              branch,
              tag,
              commitSha,
              fullClone,
            });
          } else if (plan.type === 'SHELL' || plan.type === 'CHECK') {
            if (!plan.serverId && values.workspace)
              outputs.set(node.id, { workspace: values.workspace });
            scripts.push({
              nodeId: node.id,
              flowId: current.id,
              serverId: plan.serverId,
              serverName: plan.serverName,
              serviceId: plan.serviceId,
              environmentId: plan.environmentId,
            });
          }
        } else if (node.type === 'FLOW_CALL') {
          const child = this.flow(definition, node.flowId!);
          const bound = nodeBindings(current, node, state);
          const hasDeferred = Object.entries(current.inputBindings?.[node.id] ?? {}).some(
            ([port, binding]) =>
              bound[port] === undefined &&
              (outputSources(binding).length > 0 ||
                (binding.kind === 'CONTEXT' && binding.fieldId === 'triggeredAt')),
          );
          if (!hasDeferred) {
            const childArgs = await this.resolveParameters(projectId, child, {
              ...args,
              parameters: bound,
            });
            const prepared = await prepareFlow(child, childArgs, digest(bound));
            children[node.id] = prepared;
            outputs.set(node.id, prepared.confirmedOutputs);
            for (const [fieldId, sources] of Object.entries(prepared.produced))
              production.set(outputKey(node.id, fieldId), sources);
          }
        }
      }
      const produced: Record<string, PreparedProduction[]> = Object.create(null);
      const confirmedOutputs: Values = Object.create(null);
      await this.completeArtifactParameters(projectId, current, args);
      for (const [fieldId, binding] of Object.entries(current.outputBindings ?? {})) {
        const value = bindingValue(binding, state);
        if (value !== undefined) confirmedOutputs[fieldId] = value;
        const sources = outputSources(binding).flatMap(
          (source) => production.get(outputKey(source.nodeId, source.fieldId)) ?? [],
        );
        if (sources.length) produced[fieldId] = sources;
      }
      return {
        inputHash,
        inputs: args,
        plans: Object.fromEntries(plans),
        children,
        produced,
        confirmedOutputs,
      };
    };
    const prepared = await prepareFlow(flow, inputs);
    const root = flowSelection(
      flow,
      inputs,
      bindingContext(projectId, flow, inputs, undefined, trigger),
    );
    const publicDeliveries = publishedDeliveries.map(publicDelivery);
    const configurationHash = digest([graphId, request.version, flowId, inputs, trigger, prepared]);
    const preview = {
      ...publicDeliveries[0],
      projectId,
      graphId,
      flowId,
      flowName: flow.name,
      version: request.version,
      configurationHash,
      parameters: inputs.parameters,
      nodes: root.ordered.map(({ id, name, type }) => ({
        nodeId: id,
        name,
        type,
        selected: root.selected.has(id),
      })),
      deliveries: publicDeliveries,
      checkouts,
      scripts,
    };
    return { preview, flow, inputs, plans: prepared.plans, children: prepared.children };
  }

  async preview(projectId: string, flowId: string, request: GraphPreviewDto, trigger?: Values) {
    return (await this.prepare(projectId, flowId, request, trigger)).preview;
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
    const row = await tx
      .insertInto('execution_flow_runs')
      .values(this.runValues(values))
      .onConflict((c) => c.columns(['project_id', 'created_by', 'idempotency_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (!row) return undefined;
    const snapshot = JSON.parse(values.inputs_json) as RunSnapshot;
    const { ordered, selected } = flowSelection(
      flow,
      inputs,
      bindingContext(values.project_id, flow, inputs, undefined, snapshot.trigger),
    );
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
    values: Omit<Run, 'created_at' | 'finished_at' | 'status' | 'task_id' | 'trigger_type'> &
      Pick<Partial<Run>, 'trigger_type'>,
  ) {
    return { ...values, status: 'QUEUED', created_at: Date.now() };
  }

  async run(
    projectId: string,
    flowId: string,
    request: GraphRunDto,
    userId: string,
    origin?: AutomaticRunOrigin,
  ) {
    const db = this.database.db;
    const requestHash = digest([
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
      await this.advance(old.id);
      return this.get(projectId, old.id);
    }
    const { preview, flow, plans, inputs, children } = await this.prepare(
      projectId,
      flowId,
      request,
      origin?.metadata,
    );
    if (request.expectedConfigurationHash !== preview.configurationHash)
      throw new ConflictException('版本、运行参数或实际执行配置已变化，请重新预览');
    const row = await db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await this.lockProject(tx, projectId);
      const confirmed = await this.published(projectId, request.version, tx, true);
      const references = runResourceReferences(
        confirmed.definition,
        {
          sourceId: preview.graphId,
          version: request.version,
          flowId,
          state: 'PENDING',
        },
        { inputs, deliveries: plans, children },
      );
      if (await unavailableReference(tx, projectId, references))
        throw new ConflictException('计划引用的资源已变化，请重新预览');
      await origin?.beforeInsert?.(tx);
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
            deliveries: plans,
            children,
            trigger: origin?.metadata,
          }),
        },
        flow,
        inputs,
        plans,
      );
      if (inserted) await origin?.afterInsert?.(tx, inserted.id);
      return inserted;
    });
    if (!row) {
      const stored = (await previous())!;
      checkRequest(stored, requestHash);
      // The other submitter may have committed the graph but not yet dispatched its ready nodes.
      await this.advance(stored.id);
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

  private async waitAtNode(tx: Transaction<Database>, row: NodeRun, node: GraphNode, now: number) {
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
      await this.markWaiting(tx, row, startedAt, '等待管理员审批。', { expiresAt });
    }
  }

  private async markWaiting(
    tx: Transaction<Database>,
    row: NodeRun,
    startedAt: number,
    log: string,
    output: { wakeAt: number } | { expiresAt: number },
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

  private async settle(runId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      const run = await this.lockRun(tx, runId);
      if (!run) return undefined;
      const { definition } = await this.published(run.project_id, run.version, tx);
      const flow = this.flow(definition, run.flow_id);
      const snapshot = JSON.parse(run.inputs_json) as RunSnapshot;
      const rows = await tx
        .selectFrom('execution_node_runs')
        .selectAll()
        .where('run_id', '=', run.id)
        .orderBy('position')
        .execute();
      const byId = new Map(rows.map((row) => [row.node_id, row]));
      const outputs = new Map<string, Values>(
        rows.flatMap((row) =>
          row.status === 'SUCCESS' && row.output_json
            ? [[row.node_id, JSON.parse(row.output_json) as Values]]
            : [],
        ),
      );
      const trigger = snapshot.trigger ?? { triggeredAt: run.created_at };
      const bindings = bindingContext(run.project_id, flow, snapshot.inputs, outputs, trigger);
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
      const ready: { node: NodeRun; action: GraphNode; values: Values }[] = [];
      const cancel: string[] = [];
      const now = Date.now();
      for (const node of selection.ordered) {
        const row = byId.get(node.id)!;
        if (isNodeTerminal(row.status)) continue;
        if (row.task_id) {
          const task = byTask.get(row.task_id)!;
          const status = taskStatus(task.status, task.available_at);
          if (isNodeTerminal(status)) {
            const output =
              status === 'SUCCESS' && this.nodeTasks
                ? await this.nodeTasks.output(task.id, node, tx)
                : undefined;
            await this.terminalNode(
              tx,
              row,
              status,
              task.error_summary ??
                (status === 'SUCCESS'
                  ? '节点任务已完成，详情见关联任务。'
                  : '节点任务已结束，详情见关联任务。'),
              output,
              task.started_at,
              task.finished_at ?? now,
            );
            if (output) outputs.set(node.id, output);
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
            await this.terminalNode(
              tx,
              row,
              child.status,
              child.status === 'SUCCESS' ? '子执行流已完成。' : '子执行流未成功，详情见子运行。',
              {
                childRunId: child.id,
                ...result,
              },
              child.created_at,
              child.finished_at ?? now,
            );
            if (child.status === 'SUCCESS') outputs.set(node.id, result);
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
        const parents = (selection.incoming.get(node.id) ?? []).map((edge) => byId.get(edge.from)!);
        if (parents.some((parent) => !isNodeTerminal(parent.status))) continue;
        if (parents.some((parent) => parent.status !== 'SUCCESS')) {
          await this.terminalNode(tx, row, 'SKIPPED', '上游节点未成功。');
        } else if (node.type === 'DELAY' || node.type === 'APPROVAL') {
          await this.waitAtNode(tx, row, node, now);
        } else if (isDelivery(node) || isNativeTask(node) || node.type === 'FLOW_CALL') {
          ready.push({
            node: row,
            action: node,
            values: nodeBindings(flow, node, bindings, [
              'repository',
              'version',
              'source',
              'workspace',
              'service',
              'environment',
              'targets',
              'artifact',
              'path',
              'image',
              'variables',
            ]),
          });
        } else if (node.type === 'END') {
          try {
            const result = outputReferences(flow, bindings);
            const scope = declaredScope(flow, snapshot.inputs);
            if (
              flow.serviceId &&
              (node.outputs ?? []).some((field) => field.type === 'RELEASE') &&
              !Object.entries(result).some(
                ([id, value]) =>
                  node.outputs?.find((field) => field.id === id)?.type === 'RELEASE' &&
                  value &&
                  typeof value === 'object' &&
                  'status' in value &&
                  value.status === 'SUCCESS' &&
                  'serviceId' in value &&
                  value.serviceId === flow.serviceId &&
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
          }
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
          const result =
            match === undefined
              ? undefined
              : { matched: node.type === 'CONDITION' ? match === 'TRUE' : match };
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
      return { run, flow, definition, snapshot, ready, cancel };
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
    if (pinned && pinned.inputHash !== digest(parameters))
      throw new ConflictException('子流实际参数与已确认的参数不一致');
    const prepared =
      pinned ??
      (await this.prepare(
        run.project_id,
        flow.id,
        { version: run.version, inputs: { ...snapshot.inputs, parameters } },
        snapshot.trigger,
        true,
      ));
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
        inputs: prepared.inputs,
        rootId,
        trigger: snapshot.trigger,
        deliveries: prepared.plans,
        children: prepared.children,
      };
      const { definition } = await this.published(run.project_id, run.version, tx);
      const references = runResourceReferences(
        definition,
        { sourceId: run.id, version: run.version, flowId: flow.id, state: 'PENDING' },
        childSnapshot,
      );
      if (await unavailableReference(tx, run.project_id, references))
        throw new ConflictException('子执行流所需的资源已变化');
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
        },
        flow,
        prepared.inputs,
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
    if (current.status !== 'PENDING') throw new ConflictException('节点已停止等待');
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
  ) {
    if (!this.nodeTasks || !this.tasks || !row.dispatch_json)
      throw new BadRequestException('执行节点服务不可用');
    const plan = JSON.parse(row.dispatch_json) as GraphNodePlan;
    const scope = declaredScope(flow, snapshot.inputs);
    const task = await this.nodeTasks.task(
      run.project_id,
      action,
      plan,
      graphTaskKeyPrefix + row.id,
      {
        runId: run.id,
        nodeRunId: row.id,
        serviceId: referenceId(values.service) ?? scope.serviceId,
        environmentId: referenceId(values.environment) ?? scope.environmentId,
        values,
        trigger: snapshot.trigger ?? { triggeredAt: run.created_at },
      },
    );
    await this.tasks.create(task, run.created_by, undefined, (tx, id) =>
      this.linkTask(tx, run, row, id),
    );
  }

  private async dispatch(run: Run, node: NodeRun, snapshot: RunSnapshot, bindings: Values) {
    const stored = JSON.parse(node.dispatch_json!) as Delivery;
    const artifacts =
      node.node_type === 'DEPLOY_ARTIFACT'
        ? boundArtifactIds(bindings.artifact ?? stored.artifactIds)
        : [];
    let delivery = stored;
    if (stored.alternatives) {
      const revisions = await this.artifactReferences(run.project_id, artifacts);
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
        const produced =
          option.artifactFromNodeId && option.artifactFromField
            ? boundArtifactIds(outputs.get(option.artifactFromNodeId)?.[option.artifactFromField])
            : option.artifactIds;
        return (
          produced.length &&
          digest([...produced].sort()) === digest([...artifacts].sort()) &&
          revisions.every(
            (artifact) =>
              (!artifact.commitSha || artifact.commitSha === option.commitSha) &&
              (artifact.type === 'DOCKER_IMAGE' ? 'DOCKER_IMAGE' : 'FILE') ===
                option.profile?.definition.artifactType,
          )
        );
      });
      if (!picked) throw new ConflictException('实际产物与已确认的来源不匹配');
      delivery = picked;
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
      profile: delivery.profile,
      afterInsert: (tx: Transaction<Database>, taskId: string) =>
        this.linkTask(tx, run, node, taskId, delivery.pipelineId),
    };
    if (node.node_type === 'BUILD')
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
            nodeRunId: node.id,
            workspace: bindings.workspace as GraphWorkspaceRef | undefined,
            variables: bindings.variables as GraphEnvironmentRef | undefined,
            trigger: snapshot.trigger ?? { triggeredAt: run.created_at },
          },
        },
      );
    else {
      if (delivery.artifactFromNodeId) {
        const upstream = await this.database.db
          .selectFrom('execution_node_runs')
          .select(['task_id', 'child_run_id'])
          .where('run_id', '=', run.id)
          .where('node_id', '=', delivery.artifactFromNodeId)
          .where('status', '=', 'SUCCESS')
          .executeTakeFirstOrThrow();
        const artifactIds = artifacts;
        if (!artifactIds.length) throw new BadRequestException('上游没有可部署的持久化产物');
        const prepared = await this.pipelines.previewArtifactDeploy(
          delivery.pipelineId,
          {
            ...values,
            artifactIds,
          },
          delivery.profile,
        );
        if (
          (!upstream.child_run_id && prepared.sourceBuildTaskId !== upstream.task_id) ||
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
    for (const { node, action, values } of state.ready) {
      try {
        if (node.node_type === 'FLOW_CALL') {
          const childId = await this.callChild(
            state.run,
            node,
            this.flow(state.definition, action.flowId!),
            state.snapshot,
            values,
          );
          if (childId && depth < 10) await this.advance(childId, depth + 1);
        } else if (isNativeTask(action)) {
          await this.dispatchNative(state.run, node, action, values, state.flow, state.snapshot);
        } else {
          await this.dispatch(state.run, node, state.snapshot, values);
        }
      } catch (error) {
        // A task id proves a committed dispatch even if a response or post-commit audit failed.
        const reason =
          error instanceof HttpException ? error.message : '节点无法提交，请查看任务或重新运行。';
        await this.database.db
          .updateTable('execution_node_runs')
          .set({
            status: 'FAILED',
            finished_at: Date.now(),
            log: redactTaskLog(reason),
          })
          .where('id', '=', node.id)
          .where('status', '=', 'PENDING')
          .where('task_id', 'is', null)
          .where('child_run_id', 'is', null)
          .execute();
      }
    }
    if (state.ready.length || state.cancel.length) await this.settle(runId);
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
      .select('id')
      .where('status', 'in', activeFlowStatuses);
    const rows = await (this.cursor ? query.where('id', '>', this.cursor) : query)
      .orderBy('id')
      .limit(50)
      .execute();
    this.cursor = rows.length === 50 ? rows.at(-1)!.id : undefined;
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
        .where('node_type', '=', 'APPROVAL')
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
      const approved = decision === 'APPROVE';
      await this.terminalNode(
        tx,
        row,
        approved ? 'SUCCESS' : 'FAILED',
        approved ? '管理员已批准。' : '管理员已拒绝。',
        {
          decision,
          actorId: userId,
          decidedAt: now,
          expiresAt,
        },
        row.started_at,
        now,
      );
      await this.audit.record(
        userId,
        'execution-flow.approval.decision',
        'flow-run',
        runId,
        {
          projectId,
          nodeId,
          decision,
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

  async get(projectId: string, id: string) {
    const rows = await this.runs(projectId)
      .innerJoin('execution_node_runs as n', 'n.run_id', 'r.id')
      .leftJoin('tasks as t', 'n.task_id', 't.id')
      .select([
        'r.inputs_json',
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
        't.status as taskStatus',
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
    const { inputs, trigger } = JSON.parse(row.inputs_json) as RunSnapshot;
    const deliveries = rows.flatMap(({ dispatch, type }) => {
      if (!dispatch || (type !== 'BUILD' && type !== 'DEPLOY_ARTIFACT')) return [];
      const delivery = JSON.parse(dispatch) as Delivery;
      return [publicDelivery(delivery)];
    });
    const nodes = rows.map((n) => ({
      nodeId: n.nodeId,
      name: n.name,
      type: n.type,
      log: n.log,
      status:
        n.taskStatus && !isNodeTerminal(n.nodeStatus)
          ? taskStatus(n.taskStatus, n.availableAt ?? 0)
          : n.nodeStatus,
      taskId: n.nodeTaskId,
      childRunId: n.childRunId,
      startedAt: n.taskStartedAt ?? n.nodeStartedAt,
      finishedAt: n.nodeFinishedAt,
      output: n.output ? (JSON.parse(n.output) as object) : undefined,
    }));
    const built = await this.taskArtifacts(
      rows.flatMap((n) =>
        (n.type === 'BUILD' || n.type === 'REGISTER_ARTIFACT') && n.nodeTaskId
          ? [n.nodeTaskId]
          : [],
      ),
    );
    const artifacts = [
      ...new Set([
        ...deliveries.flatMap((d) => d.artifactIds),
        ...built.map((artifact) => artifact.id),
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
      inputs,
      trigger: trigger ?? { triggeredAt: row.createdAt },
      outputs:
        nodes.find((node) => node.nodeId === flowEnd(flow).id && node.status === 'SUCCESS')
          ?.output ?? {},
      deliveries,
      artifactIds: artifacts,
      nodes,
    };
  }
}

function approvalDeadline(node: GraphNode, startedAt: number) {
  return startedAt + (node.approval?.timeoutSeconds ?? defaultApprovalSeconds) * 1000;
}
