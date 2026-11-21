import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { isUUID } from 'class-validator';
import { DatabaseService } from '../../core/database/database.service';
import type { CurrentUser } from '../auth/auth.decorators';
import type { GraphDefinition, GraphFlow } from '../execution-graphs/execution-graph-definition';
import { flowStart } from '../execution-graphs/graph-run-bindings';
import { unversionedArtifactRepository } from '../execution-graphs/graph-workspace';
import type {
  GraphPlanAccessScope,
  GraphRunControl,
} from '../execution-graphs/graph-runner.service';
import {
  graphResourceReferences,
  runResourceReferences,
  type ProjectResourceType,
} from '../projects/project-resource-references';
import { sanitizeAiText } from '../../infrastructure/ai-provider/openai-compatible.service';
import type { ResolvedAiContext } from './ai-context';
import { AiPolicyService, type AiPolicySnapshot } from './ai-policy.service';

export const aiGraphAction = 'run_execution_flow';

type GraphRequest = {
  projectId: string;
  flowId: string;
  version: number;
  parameters: Record<string, unknown>;
};

function graphRequest(data: Record<string, unknown>): GraphRequest {
  const { projectId, flowId, version, parameters = {} } = data;
  if (
    typeof projectId !== 'string' ||
    !isUUID(projectId) ||
    typeof flowId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(flowId) ||
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !parameters ||
    typeof parameters !== 'object' ||
    Array.isArray(parameters) ||
    Object.keys(parameters).length > 64 ||
    JSON.stringify(parameters).length > 16_384 ||
    Object.keys(data).some((key) => !['projectId', 'flowId', 'version', 'parameters'].includes(key))
  )
    throw new BadRequestException('请选择已发布的项目、执行流和版本，并提供已声明参数');
  return {
    projectId: projectId.toLowerCase(),
    flowId,
    version,
    parameters: parameters as Record<string, unknown>,
  };
}

function reachableFlows(definition: GraphDefinition, root: GraphFlow) {
  const visited = new Set<string>();
  const queue = [root];
  for (const flow of queue) {
    visited.add(flow.id);
    for (const node of flow.nodes) {
      if (node.type !== 'FLOW_CALL' || !node.flowId || visited.has(node.flowId)) continue;
      const child = definition.flows.find(({ id }) => id === node.flowId);
      if (child && !queue.includes(child)) queue.push(child);
    }
  }
  return queue;
}

@Injectable()
export class AiGraphActionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly policy: AiPolicyService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private async runner() {
    const { GraphRunnerService } = await import('../execution-graphs/graph-runner.service.js');
    return this.moduleRef.get(GraphRunnerService, { strict: false });
  }

  private published(projectId: string, version?: number) {
    return this.database.db
      .selectFrom('execution_graph_versions as version')
      .innerJoin('execution_graphs as graph', 'graph.id', 'version.graph_id')
      .innerJoin('projects as project', 'project.id', 'graph.project_id')
      .select(['graph.id as graphId', 'version.version', 'version.definition_json'])
      .where('graph.project_id', '=', projectId)
      .where('project.deleted_at', 'is', null)
      .where('version.retired_at', 'is', null)
      .$if(version !== undefined, (query) => query.where('version.version', '=', version!))
      .orderBy('version.version', 'desc')
      .executeTakeFirst();
  }

  async list(projectId: string, context?: ResolvedAiContext) {
    if (!isUUID(projectId)) throw new BadRequestException('请选择已登记项目');
    const scope = await this.policy.snapshot(projectId);
    this.policy.assertRead('list_execution_flows', scope, projectId);
    const published = await this.published(projectId);
    if (!published) return { projectId, version: null, flows: [] };
    const definition = JSON.parse(published.definition_json) as GraphDefinition;
    return {
      projectId,
      version: published.version,
      flows: definition.flows
        .filter(
          (flow) => !context?.serviceId || !flow.serviceId || flow.serviceId === context.serviceId,
        )
        .map((flow) => ({
          id: flow.id,
          name: sanitizeAiText(flow.name),
          kinds: [...new Set(flow.nodes.map(({ type }) => type))],
          parameters: (flowStart(flow).inputs ?? [])
            .filter((field) => field.type !== 'CREDENTIAL')
            .map((field) => ({
              id: field.id,
              name: sanitizeAiText(field.name),
              type: field.type,
              required:
                field.required !== false && field.defaultValue === undefined && !field.selection,
              multiple: Boolean(field.multiple),
            })),
        })),
    };
  }

  authorize(
    user: CurrentUser,
    snapshot: AiPolicySnapshot,
    projectId: string,
    scope: GraphPlanAccessScope,
    context?: ResolvedAiContext,
  ) {
    if (scope.unbounded)
      throw new ForbiddenException('该执行流含无法预先限定的节点，请在执行图中直接确认');
    if (
      context?.serviceId &&
      (!scope.serviceIds.includes(context.serviceId) ||
        scope.serviceIds.some((id) => id !== context.serviceId))
    )
      throw new ForbiddenException('执行流涉及当前服务页面之外的服务');
    this.policy.evaluate(
      user,
      {
        action: aiGraphAction,
        projectId,
        serverIds: scope.serverIds,
        sourceRepositoryIds: scope.repositoryIds,
      },
      snapshot,
    );
  }

  /** Check all statically reachable references before a preview may access Git or a host. */
  private async checkAuthoredScope(
    request: GraphRequest,
    snapshot: AiPolicySnapshot,
    definition: GraphDefinition,
    root: GraphFlow,
    graphId: string,
  ) {
    if (
      !this.policy
        .scopes(snapshot)
        .some(({ serverIds, repositoryIds }) => serverIds || repositoryIds)
    )
      return;
    const state = 'RUNNABLE' as const;
    const flows = reachableFlows(definition, root);
    const authored = [
      ...graphResourceReferences({ ...definition, flows }, { sourceId: graphId, state }),
      ...runResourceReferences(
        definition,
        { sourceId: graphId, state, flowId: root.id, version: request.version },
        { inputs: { parameters: request.parameters } },
      ),
    ];
    const ids = (type: ProjectResourceType) => [
      ...new Set(authored.filter((ref) => ref.resourceType === type).map((ref) => ref.resourceId)),
    ];
    const servers = new Set(ids('SERVER'));
    const repositories = new Set(ids('REPOSITORY'));
    const groups = ids('SERVER_GROUP');
    const targets = ids('LEGACY_TARGET');
    const artifacts = ids('ARTIFACT');
    for (const { nodes } of flows) {
      for (const node of nodes) {
        const compose = node.deploy?.composeSource;
        if (compose?.kind === 'REPOSITORY_FILE' && compose.repositoryId)
          repositories.add(compose.repositoryId);
      }
    }
    const db = this.database.db;
    const latest = flows.some((flow) =>
      (flowStart(flow).inputs ?? []).some(
        ({ id, selection, defaultValue }) =>
          selection === 'LATEST_COMPATIBLE' &&
          (flow.id !== root.id ||
            (request.parameters[id] === undefined && defaultValue === undefined)),
      ),
    );
    const [members, knownArtifacts, legacyMembers] = await Promise.all([
      groups.length
        ? db
            .selectFrom('server_group_members')
            .select('server_id')
            .where('group_id', 'in', groups)
            .execute()
        : [],
      artifacts.length || latest
        ? db
            .selectFrom('artifacts as artifact')
            .leftJoin('artifact_sources as source', 'source.artifact_id', 'artifact.id')
            .select(['artifact.server_id', 'artifact.storage_type', 'source.repository_id'])
            .where('artifact.project_id', '=', request.projectId)
            .where('artifact.lifecycle_state', '=', 'ACTIVE')
            .where('artifact.temporary_root_id', 'is', null)
            .$if(!latest, (query) =>
              query.where((eb) =>
                eb.or([
                  eb('artifact.id', 'in', artifacts),
                  eb('artifact.logical_artifact_id', 'in', artifacts),
                ]),
              ),
            )
            .limit(201)
            .execute()
        : [],
      targets.length
        ? db
            .selectFrom('deployment_target_servers')
            .select('server_id')
            .where('target_id', 'in', targets)
            .execute()
        : [],
    ]);
    if (knownArtifacts.length > 200)
      throw new BadRequestException('候选产物范围过大，请明确选择产物后再生成 AI 提案');
    for (const { server_id } of [...members, ...legacyMembers]) servers.add(server_id);
    for (const row of knownArtifacts) {
      if (row.server_id && row.storage_type !== 'REGISTRY_IMAGE') servers.add(row.server_id);
      if (row.repository_id) repositories.add(row.repository_id);
    }
    this.policy.assertRead(aiGraphAction, snapshot, request.projectId, [...servers]);
    for (const id of repositories)
      if (id !== unversionedArtifactRepository) this.policy.assertRepository(id, snapshot);
  }

  async prepare(data: Record<string, unknown>, user: CurrentUser, context?: ResolvedAiContext) {
    const request = graphRequest(data);
    const snapshot = await this.policy.snapshot(request.projectId);
    this.policy.evaluate(
      user,
      { action: aiGraphAction, projectId: request.projectId, serverIds: [] },
      snapshot,
    );
    const published = await this.published(request.projectId, request.version);
    if (!published) throw new NotFoundException('找不到可运行的执行图版本');
    const definition = JSON.parse(published.definition_json) as GraphDefinition;
    const root = definition.flows.find(({ id }) => id === request.flowId);
    if (!root) throw new NotFoundException('指定版本中不存在该执行流');
    if (context?.serviceId && root.serviceId && root.serviceId !== context.serviceId)
      throw new ForbiddenException('执行流涉及当前服务页面之外的服务');
    const fields = flowStart(root).inputs ?? [];
    if (
      Object.keys(request.parameters).some(
        (id) => !fields.some((field) => field.id === id && field.type !== 'CREDENTIAL'),
      )
    )
      throw new BadRequestException('AI 提案只能提交已声明的非凭据参数');
    if (sanitizeAiText(JSON.stringify(request.parameters)) !== JSON.stringify(request.parameters))
      throw new BadRequestException('执行流参数包含疑似敏感值');
    await this.checkAuthoredScope(request, snapshot, definition, root, published.graphId);
    const runner = await this.runner();
    let access: GraphPlanAccessScope | undefined;
    const preview = await runner.preview(
      request.projectId,
      request.flowId,
      {
        version: request.version,
        inputs: { parameters: request.parameters },
      },
      {
        authorizePlan: (scope) => {
          this.authorize(user, snapshot, request.projectId, scope, context);
          access = scope;
        },
      },
    );
    if (!access) throw new ForbiddenException('执行流未提供完整授权范围');
    const { projectId, flowId, flowName, version, configurationHash } = preview;
    return {
      action: aiGraphAction,
      projectId,
      serverIds: access.serverIds,
      sourceRepositoryIds: access.repositoryIds,
      bindingsHash: configurationHash,
      payload: request,
      // Expose identities and scope, never scripts, variables, or resolved credential references.
      preview: {
        projectId,
        flowId,
        flowName: sanitizeAiText(flowName),
        version,
        serviceIds: access.serviceIds,
        serverIds: access.serverIds,
        repositoryIds: access.repositoryIds,
        nodes: preview.nodes
          .filter(({ selected }) => selected)
          .map(({ nodeId, name, type }) => ({ nodeId, name: sanitizeAiText(name), type })),
        deliveries: preview.deliveries.map(
          ({
            nodeId,
            flowId,
            serviceId,
            serverIds,
            commitSha,
            artifactIds,
            method,
            requireApproval,
            requireCodeReview,
          }) => ({
            nodeId,
            flowId,
            serviceId,
            serverIds,
            commitSha,
            artifactIds,
            method,
            requireApproval,
            requireCodeReview,
          }),
        ),
      },
    } as const;
  }

  async run(
    prepared: { payload: Record<string, unknown>; bindingsHash: string },
    proposalId: string,
    user: CurrentUser,
    control: GraphRunControl,
  ) {
    const { projectId, flowId, version, parameters } = graphRequest(prepared.payload);
    return (await this.runner()).run(
      projectId,
      flowId,
      {
        version,
        inputs: { parameters },
        expectedConfigurationHash: prepared.bindingsHash,
        idempotencyKey: `ai-${proposalId}`,
      },
      user.id,
      undefined,
      control,
    );
  }

  async ongoing(ids: string[], user: CurrentUser) {
    if (!ids.length) return false;
    return Boolean(
      await this.database.db
        .selectFrom('execution_flow_runs')
        .select('id')
        .where('id', 'in', ids)
        .where('created_by', '=', user.id)
        .where('finished_at', 'is', null)
        .executeTakeFirst(),
    );
  }
}
