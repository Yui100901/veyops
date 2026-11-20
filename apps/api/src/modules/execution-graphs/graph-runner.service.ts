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
import { requireProject } from '../projects/project-relations';
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
  activeFlowStatuses,
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
  artifactIds: string[];
  artifactFromNodeId?: string;
  sourceSnapshot?: { id?: string; repositoryId?: string; commitSha: string; branch?: string }[];
  pipelineHash: string;
  profile?: DeliveryExecutionProfile;
}
interface RunSnapshot {
  inputs: GraphInputsDto;
  deliveries?: Record<string, Delivery | GraphNodePlan>;
  rootId?: string;
}

const planKey = (flowId: string, nodeId: string) => `${flowId}:${nodeId}`;
function publicDelivery(delivery: Delivery) {
  const native = Boolean(delivery.profile);
  return {
    ...delivery,
    pipelineHash: undefined,
    profile: undefined,
    ...(native && { pipelineId: undefined, pipelineVersion: undefined }),
  };
}
function isNativeTask(node: Pick<GraphNode, 'type'>) {
  return node.type === 'CHECKOUT' || node.type === 'SHELL';
}

interface AutomaticRunOrigin {
  triggerType: 'CRON' | 'WEBHOOK' | 'API' | 'UPSTREAM';
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
  ) {}

  onModuleInit() {
    this.registry?.registerGraphPump((taskId) => (taskId ? this.taskChanged(taskId) : this.tick()));
  }

  private async published(projectId: string, version: number, db = this.database.db) {
    const row = await db
      .selectFrom('execution_graph_versions as version')
      .innerJoin('execution_graphs as graph', 'graph.id', 'version.graph_id')
      .select(['graph.id as graphId', 'version.definition_json'])
      .where('graph.project_id', '=', projectId)
      .where('version.version', '=', version)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('项目执行图发布版本不存在');
    return { graphId: row.graphId, definition: JSON.parse(row.definition_json) as GraphDefinition };
  }

  private flow(definition: GraphDefinition, id: string) {
    const flow = definition.flows.find((f) => f.id === id);
    if (!flow) throw new NotFoundException('此版本中没有该执行流');
    return flow;
  }

  private async delivery(
    projectId: string,
    flowId: string,
    graphVersion: number,
    start: GraphNode,
    node: GraphNode,
    inputs: GraphInputsDto,
    upstream?: Delivery,
  ): Promise<Delivery> {
    if (!inputs.environmentId) throw new BadRequestException('请选择运行环境');
    const {
      environmentId,
      targetId,
      serverIds,
      groupIds,
      strategy,
      maxParallel,
      failurePolicy,
      commitSha,
      artifactIds,
    } = inputs;
    const base = {
      environmentId,
      targetId,
      serverIds,
      groupIds,
      strategy,
      maxParallel,
      failurePolicy,
    };
    const preset = start.delivery;
    let profile: DeliveryExecutionProfile | undefined;
    let preview: DeliveryPreview;
    let sourceBranch: string | undefined;

    const makeProfile = (definition: PipelineDefinition, fields: string[] = []) =>
      deliveryExecutionProfile(
        projectId,
        preset!.serviceId!,
        flowId,
        graphVersion,
        start.name,
        definition,
        [...fields, ...Object.keys(preset?.deploy ?? {})],
      );
    const fromBuild = (definition: PipelineDefinition) =>
      makeProfile(
        Object.assign(
          new PipelineDefinitionDto(),
          {
            repositoryId: definition.repositoryId,
            artifactType: definition.artifactType,
            registryId: definition.registryId,
            imageRepository: definition.imageRepository,
          },
          preset?.deploy,
        ),
      );

    if (preset && !node.pipelineId) {
      if (!preset.serviceId) throw new BadRequestException('请选择该流程交付的项目服务');
      if (node.type === 'BUILD') {
        const { branch, commitSha: pinned, ...build } = preset.build!;
        const definition = Object.assign(new PipelineDefinitionDto(), build, preset.deploy, {
          inheritBuildLocation: !build.buildLocation,
        });
        profile = makeProfile(definition, Object.keys(build));
        const references =
          !pinned && !commitSha
            ? await this.pipelines.resolveDeliveryBranch(projectId, definition.repositoryId, branch)
            : undefined;
        sourceBranch = references?.branch;
        preview = await this.pipelines.preview(
          profile.id,
          {
            ...base,
            commitSha: pinned ?? commitSha ?? references?.commitSha,
            mode: 'BUILD_ONLY',
            confirmed: true,
          },
          undefined,
          profile,
        );
      } else if (preset.kind === 'BUILD_DEPLOY') {
        if (!upstream?.profile)
          throw new BadRequestException('当前执行路径中的部署节点缺少上游构建');
        profile = upstream.profile;
        const plan = await this.pipelines.previewArtifactDeployPlan(
          profile.id,
          {
            ...base,
            commitSha: upstream.commitSha,
          },
          profile,
        );
        return {
          nodeId: node.id,
          flowId,
          pipelineId: profile.id,
          pipelineVersion: plan.version,
          profile,
          serviceId: plan.serviceId,
          environmentId: plan.environmentId,
          commitSha: plan.commitSha,
          serverIds: plan.serverIds,
          requireApproval: plan.requireApproval,
          artifactIds: [],
          artifactFromNodeId: upstream.nodeId,
          sourceSnapshot: upstream.sourceSnapshot,
          pipelineHash: plan.configurationHash,
        };
      } else if (artifactIds?.length) {
        const source = await this.pipelines.deliveryArtifactBuild(
          projectId,
          preset.serviceId,
          environmentId,
          artifactIds,
        );
        profile = fromBuild(source.definition);
        preview = await this.pipelines.previewArtifactDeploy(
          profile.id,
          { ...base, artifactIds },
          profile,
        );
      } else {
        const latest = await this.latestDeliveryArtifact(
          projectId,
          preset.serviceId,
          base,
          fromBuild,
        );
        profile = latest.profile;
        preview = latest.preview;
      }
    } else {
      const pipelineId = node.pipelineId!;
      const pipeline = await this.pipelines.get(pipelineId);
      if (pipeline.projectId !== projectId) throw new BadRequestException('交付配置不属于当前项目');
      const previous = { ...base, version: node.pipelineVersion };
      if (upstream && !artifactIds?.length) {
        const plan = await this.pipelines.previewArtifactDeployPlan(pipelineId, {
          ...previous,
          commitSha: upstream.commitSha,
        });
        return {
          nodeId: node.id,
          flowId,
          pipelineId,
          pipelineVersion: plan.version,
          serviceId: plan.serviceId,
          environmentId: plan.environmentId,
          commitSha: plan.commitSha,
          serverIds: plan.serverIds,
          requireApproval: plan.requireApproval,
          artifactIds: [],
          artifactFromNodeId: upstream.nodeId,
          sourceSnapshot: upstream.sourceSnapshot,
          pipelineHash: plan.configurationHash,
        };
      }
      if (node.type === 'BUILD') {
        preview = await this.pipelines.preview(pipelineId, {
          ...previous,
          commitSha,
          mode: 'BUILD_ONLY',
          confirmed: true,
        });
      } else {
        if (!artifactIds?.length)
          throw new BadRequestException('请选择历史构建产物，或连接上游构建节点');
        preview = await this.pipelines.previewArtifactDeploy(pipelineId, {
          ...previous,
          artifactIds,
        });
      }
    }
    return {
      nodeId: node.id,
      flowId,
      pipelineId: preview.pipelineId,
      pipelineVersion: preview.version,
      profile,
      serviceId: preview.serviceId,
      environmentId: preview.environmentId,
      commitSha: preview.commitSha,
      serverIds: preview.serverIds,
      requireApproval: preview.requireApproval,
      artifactIds: 'artifactIds' in preview ? preview.artifactIds : [],
      sourceSnapshot: preview.nodeSources ?? [
        {
          repositoryId: preview.definition.repositoryId,
          commitSha: preview.commitSha,
          ...(sourceBranch && { branch: sourceBranch }),
        },
      ],
      pipelineHash: preview.configurationHash,
    };
  }

  private async latestDeliveryArtifact(
    projectId: string,
    serviceId: string,
    inputs: Pick<
      GraphInputsDto,
      'targetId' | 'serverIds' | 'groupIds' | 'strategy' | 'maxParallel' | 'failurePolicy'
    > & { environmentId: string },
    makeProfile: (definition: PipelineDefinition) => DeliveryExecutionProfile,
  ) {
    const builds = await this.pipelines.deliveryArtifactCandidates(
      projectId,
      serviceId,
      inputs.environmentId,
    );
    let configurationError: HttpException | undefined;
    for (const build of builds) {
      const snapshot = (JSON.parse(build.payload_json) as TaskPayload).pipeline;
      if (!snapshot || snapshot.mode === 'DEPLOY_ARTIFACT') continue;
      const profile = makeProfile(snapshot.definition);
      try {
        const targets = await this.pipelines.previewArtifactDeployPlan(
          profile.id,
          {
            ...inputs,
            commitSha: build.commit_sha,
          },
          profile,
        );
        const artifactIds = await this.pipelines.deliveryArtifactIds(build.id, targets.serverIds);
        if (!artifactIds.length) continue;
        const preview = await this.pipelines.previewArtifactDeploy(
          profile.id,
          { ...inputs, artifactIds },
          profile,
        );
        return { profile, preview };
      } catch (error) {
        if (!(error instanceof HttpException) || ![400, 404, 409].includes(error.getStatus()))
          throw error;
        configurationError ??= error;
      }
    }
    throw new BadRequestException(
      configurationError
        ? '当前服务没有可用于部署的产物：' + configurationError.message
        : '当前服务和环境没有可部署的构建产物，请先运行构建流',
    );
  }

  private async prepare(projectId: string, flowId: string, request: GraphPreviewDto) {
    await requireProject(this.database.db, projectId);
    const { graphId, definition } = await this.published(projectId, request.version);
    const flow = this.flow(definition, flowId);
    const inputs = request.inputs ?? {};
    if (inputs.value && redactTaskLog(inputs.value) !== inputs.value)
      throw new BadRequestException('条件值只接受普通文本，请移除凭据');
    const root = flowSelection(flow, inputs);
    const actionNodes = new Map<
      string,
      { flowId: string; start: GraphNode; node: GraphNode; upstreamNodeId?: string }
    >();
    const seen = new Set<string>();
    const nativeNodes = new Map<string, { flowId: string; node: GraphNode }>();
    const gather = (current: GraphFlow) => {
      if (seen.has(current.id)) return;
      seen.add(current.id);
      const selection = flowSelection(current, inputs);
      const start = selection.ordered.find((node) => node.type === 'START')!;
      const predecessors = new Map<string, Set<string>>();
      for (const node of selection.ordered) {
        if (!selection.selected.has(node.id)) continue;
        const ancestors = new Set(
          (selection.incoming.get(node.id) ?? []).flatMap((edge) => [
            edge.from,
            ...(predecessors.get(edge.from) ?? []),
          ]),
        );
        predecessors.set(node.id, ancestors);
        if (isDelivery(node)) {
          const useUpstream = node.pipelineId
            ? !inputs.artifactIds?.length
            : start.delivery?.kind === 'BUILD_DEPLOY';
          const builds =
            node.type === 'DEPLOY_ARTIFACT' && useUpstream
              ? current.nodes.filter(
                  (source) =>
                    source.type === 'BUILD' &&
                    source.pipelineId === node.pipelineId &&
                    ancestors.has(source.id),
                )
              : [];
          if (builds.length > 1)
            throw new BadRequestException('部署节点包含多个上游构建，请调整连线');
          actionNodes.set(planKey(current.id, node.id), {
            flowId: current.id,
            start,
            node,
            upstreamNodeId: builds[0]?.id,
          });
        }
        if (isNativeTask(node))
          nativeNodes.set(planKey(current.id, node.id), { flowId: current.id, node });
        if (node.type === 'FLOW_CALL') gather(this.flow(definition, node.flowId!));
      }
    };
    gather(flow);
    const nativePlans = new Map<string, GraphNodePlan>();
    const checkouts = [];
    const scripts = [];
    for (const [key, { flowId, node }] of nativeNodes) {
      if (!this.nodeTasks) throw new BadRequestException('执行节点服务不可用');
      const plan = await this.nodeTasks.prepare(projectId, node);
      nativePlans.set(key, plan);
      if (plan.type === 'CHECKOUT') {
        const { repositoryId, branch, commitSha, fullClone } = plan.source;
        checkouts.push({ nodeId: node.id, flowId, repositoryId, branch, commitSha, fullClone });
      } else {
        scripts.push({
          nodeId: node.id,
          flowId,
          serverId: plan.serverId,
          serverName: plan.serverName,
        });
      }
    }
    const approved = new Map<string, Delivery>();
    for (const { flowId: origin, start, node, upstreamNodeId } of actionNodes.values())
      approved.set(
        planKey(origin, node.id),
        await this.delivery(
          projectId,
          origin,
          request.version,
          start,
          node,
          inputs,
          upstreamNodeId ? approved.get(planKey(origin, upstreamNodeId)) : undefined,
        ),
      );
    const deliveries = [...approved.values()];
    const publicDeliveries = deliveries.map(publicDelivery);
    const plans = Object.fromEntries<Delivery | GraphNodePlan>([...approved, ...nativePlans]);
    const configurationHash = digest([
      graphId,
      request.version,
      flowId,
      inputs,
      deliveries,
      [...nativePlans],
    ]);
    const preview = {
      ...publicDeliveries[0],
      projectId,
      graphId,
      flowId,
      flowName: flow.name,
      version: request.version,
      configurationHash,
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
    return { preview, flow, inputs, plans };
  }

  async preview(projectId: string, flowId: string, request: GraphPreviewDto) {
    return (await this.prepare(projectId, flowId, request)).preview;
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
    const { ordered, selected } = flowSelection(flow, inputs);
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
    const { preview, flow, plans, inputs } = await this.prepare(projectId, flowId, request);
    if (request.expectedConfigurationHash !== preview.configurationHash)
      throw new ConflictException('版本、运行参数或实际执行配置已变化，请重新预览');
    const row = await db.transaction().execute(async (tx) => {
      await this.lockProject(tx, projectId);
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
          inputs_json: JSON.stringify({ inputs, deliveries: plans }),
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
      const { ordered, incoming, matches } = flowSelection(flow, snapshot.inputs);
      const rows = await tx
        .selectFrom('execution_node_runs')
        .selectAll()
        .where('run_id', '=', run.id)
        .orderBy('position')
        .execute();
      const byId = new Map(rows.map((row) => [row.node_id, row]));
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
      const ready: { node: NodeRun; action: GraphNode }[] = [];
      const cancel: string[] = [];
      const now = Date.now();
      for (const node of ordered) {
        const row = byId.get(node.id)!;
        if (isNodeTerminal(row.status)) continue;
        if (row.task_id) {
          const task = byTask.get(row.task_id)!;
          const status = taskStatus(task.status, task.available_at);
          if (isNodeTerminal(status)) {
            let output: Record<string, unknown> | undefined;
            if (node.type === 'CHECKOUT' && status === 'SUCCESS') {
              const source = (JSON.parse(task.payload_json) as TaskPayload).sourceCheckout!.source;
              output = {
                repositoryId: source.repositoryId,
                branch: source.branch,
                commitSha: source.commitSha,
                fullClone: source.fullClone,
              };
            }
            if (node.type === 'BUILD' && status === 'SUCCESS')
              output = {
                artifactIds: (await this.taskArtifacts([task.id], tx)).map(
                  (artifact) => artifact.id,
                ),
              };
            if (node.type === 'DEPLOY_ARTIFACT') {
              const payload = JSON.parse(task.payload_json) as TaskPayload;
              output = {
                artifactIds: (payload.pipeline?.deploymentArtifacts ?? []).map(({ id }) => id),
              };
            }
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
            const outputs = await tx
              .selectFrom('execution_node_runs')
              .select(['node_id', 'output_json'])
              .where('run_id', '=', child.id)
              .where('output_json', 'is not', null)
              .orderBy('position')
              .execute();
            await this.terminalNode(
              tx,
              row,
              child.status,
              child.status === 'SUCCESS' ? '子执行流已完成。' : '子执行流未成功，详情见子运行。',
              {
                childRunId: child.id,
                outputs: Object.fromEntries(
                  outputs.map((item) => [item.node_id, JSON.parse(item.output_json!)]),
                ),
              },
              child.created_at,
              child.finished_at ?? now,
            );
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
        const parents = (incoming.get(node.id) ?? []).map((edge) => byId.get(edge.from)!);
        if (parents.some((parent) => !isNodeTerminal(parent.status))) continue;
        if (parents.some((parent) => parent.status !== 'SUCCESS')) {
          await this.terminalNode(tx, row, 'SKIPPED', '上游节点未成功。');
        } else if (node.type === 'DELAY' || node.type === 'APPROVAL') {
          await this.waitAtNode(tx, row, node, now);
        } else if (isDelivery(node) || isNativeTask(node) || node.type === 'FLOW_CALL') {
          ready.push({ node: row, action: node });
        } else {
          const match = matches.get(node.id);
          await this.terminalNode(
            tx,
            row,
            'SUCCESS',
            graphNodeOutput(node, match),
            match === undefined
              ? undefined
              : { matched: node.type === 'CONDITION' ? match === 'TRUE' : match },
            now,
          );
        }
      }
      const statuses = rows.map(({ status }) => status);
      const finished = statuses.every(isNodeTerminal);
      const status = finished
        ? (failureStatus(statuses) ?? (run.status === 'CANCEL_REQUESTED' ? 'CANCELLED' : 'SUCCESS'))
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
      return { run, definition, snapshot, ready, cancel };
    });
  }

  private async callChild(run: Run, node: NodeRun, flow: GraphFlow, snapshot: RunSnapshot) {
    return this.database.db.transaction().execute(async (tx) => {
      const parent = await this.lockRun(tx, run.id);
      if (!parent || parent.status === 'CANCEL_REQUESTED') return undefined;
      const existing = await tx
        .selectFrom('execution_node_runs')
        .select('child_run_id')
        .where('id', '=', node.id)
        .executeTakeFirstOrThrow();
      if (existing.child_run_id) return existing.child_run_id;
      const rootId = snapshot.rootId ?? run.id;
      const root =
        snapshot.deliveries ??
        (
          JSON.parse(
            (
              await tx
                .selectFrom('execution_flow_runs')
                .select('inputs_json')
                .where('id', '=', rootId)
                .executeTakeFirstOrThrow()
            ).inputs_json,
          ) as RunSnapshot
        ).deliveries ??
        {};
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
          configuration_hash: run.configuration_hash,
          inputs_json: JSON.stringify({ inputs: snapshot.inputs, rootId }),
        },
        flow,
        snapshot.inputs,
        root,
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

  private async dispatchNative(run: Run, row: NodeRun, action: GraphNode) {
    if (!this.nodeTasks || !this.tasks || !row.dispatch_json)
      throw new BadRequestException('执行节点服务不可用');
    const plan = JSON.parse(row.dispatch_json) as GraphNodePlan;
    const task = await this.nodeTasks.task(
      run.project_id,
      action,
      plan,
      graphTaskKeyPrefix + row.id,
    );
    await this.tasks.create(task, run.created_by, undefined, (tx, id) =>
      this.linkTask(tx, run, row, id),
    );
  }

  private async dispatch(run: Run, node: NodeRun, inputs: GraphInputsDto) {
    const delivery = JSON.parse(node.dispatch_json!) as Delivery;
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
          ...(delivery.profile &&
            delivery.sourceSnapshot?.[0]?.branch && {
              gitRef: 'refs/heads/' + delivery.sourceSnapshot[0].branch,
            }),
        },
      );
    else {
      if (delivery.artifactFromNodeId) {
        const upstream = await this.database.db
          .selectFrom('execution_node_runs')
          .select('task_id')
          .where('run_id', '=', run.id)
          .where('node_id', '=', delivery.artifactFromNodeId)
          .where('status', '=', 'SUCCESS')
          .executeTakeFirstOrThrow();
        const artifactIds = (
          await this.taskArtifacts(upstream.task_id ? [upstream.task_id] : [])
        ).map(({ id }) => id);
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
          prepared.sourceBuildTaskId !== upstream.task_id ||
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
    for (const { node, action } of state.ready) {
      try {
        if (node.node_type === 'FLOW_CALL') {
          const childId = await this.callChild(
            state.run,
            node,
            this.flow(state.definition, action.flowId!),
            state.snapshot,
          );
          if (childId && depth < 10) await this.advance(childId, depth + 1);
        } else if (isNativeTask(action)) {
          await this.dispatchNative(state.run, node, action);
        } else {
          await this.dispatch(state.run, node, state.snapshot.inputs);
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
    const { inputs } = JSON.parse(row.inputs_json) as RunSnapshot;
    const deliveries = rows.flatMap(({ dispatch, type }) => {
      if (!dispatch || type === 'CHECKOUT' || type === 'SHELL') return [];
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
      rows.flatMap((n) => (n.type === 'BUILD' && n.nodeTaskId ? [n.nodeTaskId] : [])),
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
      deliveries,
      artifactIds: artifacts,
      nodes,
    };
  }
}

function approvalDeadline(node: GraphNode, startedAt: number) {
  return startedAt + (node.approval?.timeoutSeconds ?? defaultApprovalSeconds) * 1000;
}
