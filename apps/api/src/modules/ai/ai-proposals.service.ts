import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Selectable } from 'kysely';
import { AiActionProposalsTable } from '../../core/database/schema';
import { CurrentUser } from '../auth/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { AiRepository } from './ai.repository';
import { AiPolicyService, AiPolicySnapshot } from './ai-policy.service';
import { AiToolsService, PreparedAiAction } from './ai-tools.service';
import { assertAiPipelineScope, scopeAiToolArguments } from './ai-context';
import { AiFailureGuard } from './ai-failure-guard.service';
import { aiGraphAction } from './ai-graph-actions.service';
import type { GraphPlanAccessScope } from '../execution-graphs/graph-runner.service';
import type { ResolvedAiContext } from './ai-context';

export function proposalDto(row: Selectable<AiActionProposalsTable>) {
  const stored = JSON.parse(row.payload_json) as PreparedAiAction;
  return {
    id: row.id,
    actionType: row.action_type,
    payload: stored.payload,
    preview: JSON.parse(row.preview_json) as Record<string, unknown>,
    riskLevel: row.risk_level,
    status: row.status,
    expiresAt: row.expires_at,
    taskId: row.task_id,
    createdAt: row.created_at,
    conversationId: stored.conversationId ?? null,
  };
}
@Injectable()
export class AiProposalsService {
  constructor(
    private readonly repository: AiRepository,
    private readonly policy: AiPolicyService,
    private readonly tools: AiToolsService,
    private readonly audit: AuditService,
    private readonly failureGuard?: AiFailureGuard,
  ) {}
  private scopedPreview(
    row: Selectable<AiActionProposalsTable>,
    policies: (id?: string) => AiPolicySnapshot,
    user: CurrentUser,
  ) {
    const prepared = JSON.parse(row.payload_json) as PreparedAiAction;
    const dto = proposalDto(row);
    const scope = policies(prepared.projectId);
    try {
      this.policy.assertRead(prepared.action, scope, prepared.projectId, prepared.serverIds);
      if (prepared.failureTaskId)
        this.policy.assertRead(
          'diagnose_deployment',
          scope,
          prepared.projectId,
          prepared.serverIds,
        );
      if (prepared.repositoryId) this.policy.assertRepository(prepared.repositoryId, scope);
      for (const id of prepared.sourceRepositoryIds ?? []) this.policy.assertRepository(id, scope);
      this.policy.evaluate(user, prepared, scope);
      return dto;
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
      return { ...dto, scopeRevoked: true, payload: {}, preview: {}, taskId: null };
    }
  }
  async list(user: CurrentUser) {
    const policies = await this.policy.projectSnapshots();
    return (await this.repository.proposals(user.id)).map((row) =>
      this.scopedPreview(row, policies, user),
    );
  }
  async waiting(conversationId: string, user: CurrentUser) {
    return (await this.list(user)).some(
      (proposal) => proposal.conversationId === conversationId && proposal.status === 'PENDING',
    );
  }
  async waitingForGraph(conversationId: string, user: CurrentUser) {
    const ids = (await this.repository.proposals(user.id)).flatMap((row) => {
      if (row.action_type !== aiGraphAction || row.status !== 'APPROVED') return [];
      const { graphRun } = JSON.parse(row.preview_json) as { graphRun?: { id: string } };
      const { conversationId: source } = JSON.parse(row.payload_json) as PreparedAiAction;
      return source === conversationId && graphRun ? [graphRun.id] : [];
    });
    return ids.length > 0 && this.tools.graphActions().ongoing(ids, user);
  }
  async create(prepared: PreparedAiAction, snapshot: AiPolicySnapshot, user: CurrentUser) {
    const id = randomUUID();
    const now = Date.now();
    const created = await this.repository.createProposal(
      {
        id,
        created_by: user.id,
        action_type: prepared.action,
        payload_json: JSON.stringify(prepared),
        preview_json: JSON.stringify(prepared.preview),
        risk_level: prepared.action === 'inspect_servers' ? 'LOW' : 'UNKNOWN',
        policy_snapshot_json: JSON.stringify(snapshot),
        status: 'PENDING',
        expires_at: now + 15 * 60_000,
        created_at: now,
      },
      prepared.conversationId,
    );
    if (!created) throw new ConflictException('此对话已有待审核步骤，请先确认或拒绝');
    await this.audit.record(user.id, 'ai.proposal.create', 'ai_proposal', id, {
      action: prepared.action,
      targetCount: prepared.serverIds.length,
    });
    return proposalDto(await this.repository.proposal(id, user.id));
  }
  async confirm(id: string, user: CurrentUser, automatic = false) {
    const row = await this.repository.proposal(id, user.id);
    const stored = JSON.parse(row.payload_json) as PreparedAiAction;
    if (stored.action === aiGraphAction) {
      if (automatic) throw new ForbiddenException('执行流提案必须由用户确认');
      if (row.status === 'APPROVED') {
        const proposal = this.scopedPreview(row, await this.policy.projectSnapshots(), user);
        if ('scopeRevoked' in proposal) throw new ForbiddenException('执行流提案授权已失效');
        const graphRun = proposal.preview.graphRun;
        if (!graphRun) throw new ConflictException('该提案已处理，无法读取执行流记录');
        return { proposal, graphRun, sourceChange: undefined, task: undefined };
      }
    }
    if (row.expires_at <= Date.now()) {
      await this.repository.expire(id);
      throw new ConflictException('操作提案已过期，请重新生成');
    }
    if (row.status !== 'PENDING') throw new ConflictException('操作提案已处理，不能重复确认');
    if (stored.action === 'run_pipeline')
      throw new ConflictException('请从项目执行图预览并确认交付流程');
    const repair = stored.failureTaskId
      ? { taskId: stored.failureTaskId, proposalId: id, automatic }
      : undefined;
    const repairContext = repair
      ? await this.failureGuard?.repair(repair.taskId, repair)
      : undefined;
    if (
      repair &&
      (!repairContext ||
        repairContext.actor.id !== user.id ||
        stored.action !== 'initialize_component' ||
        stored.payload.component !== repairContext.component ||
        stored.projectId !== repairContext.projectId ||
        stored.serverIds.length !== 1 ||
        stored.serverIds[0] !== repairContext.current.id)
    )
      throw new ConflictException('故障修复绑定已失效');
    const inputContext = stored.conversationId
      ? await this.repository.conversationContext(stored.conversationId)
      : undefined;
    const context = inputContext
      ? await this.repository.resolveContext(inputContext, stored.projectId, user)
      : undefined;
    const prepared = await this.tools.prepare(
      stored.action,
      scopeAiToolArguments(context, stored.action, stored.payload),
      user,
      context,
    );
    if (prepared.action === 'run_pipeline') assertAiPipelineScope(context, prepared.preview);
    prepared.projectId ??= repairContext?.projectId ?? stored.projectId;
    if (repairContext) prepared.sourceRepositoryIds = repairContext.repositoryIds;
    if (
      prepared.bindingsHash !== stored.bindingsHash ||
      prepared.projectId !== stored.projectId ||
      prepared.repositoryId !== stored.repositoryId ||
      JSON.stringify([...prepared.serverIds].sort()) !==
        JSON.stringify([...stored.serverIds].sort()) ||
      JSON.stringify([...(prepared.sourceRepositoryIds ?? [])].sort()) !==
        JSON.stringify([...(stored.sourceRepositoryIds ?? [])].sort())
    )
      throw new ConflictException('服务器配置或部署目标已改变，请重新生成提案');
    const snapshot = await this.policy.snapshot(prepared.projectId);
    this.policy.evaluate(user, prepared, snapshot);
    if (prepared.action === aiGraphAction)
      return this.confirmGraph(id, user, snapshot, stored, prepared, context);
    if (!(await this.repository.approve(id, user.id, snapshot)))
      throw new ConflictException('操作提案已处理或过期');
    try {
      // Consume first. If the process crashes here, a human must inspect rather than replay a write.
      const task = await this.tools.execute(prepared, user, repair);
      if ('sourceChange' in task) {
        await this.repository.recordProposalPreview(id, {
          ...prepared.preview,
          sourceChange: task.sourceChange,
        });
        await this.audit.record(user.id, 'ai.proposal.confirm', 'ai_proposal', id, {
          sourceChangeId: task.sourceChange.id,
        });
        if (stored.conversationId)
          await this.repository.addMessage(stored.conversationId, 'TOOL', {
            text: JSON.stringify(task.sourceChange),
            name: stored.action,
          });
        return {
          proposal: proposalDto(await this.repository.proposal(id, user.id)),
          sourceChange: task.sourceChange,
        };
      }
      await this.repository.attachTask(id, task.id);
      if (stored.conversationId)
        await this.repository.addMessage(stored.conversationId, 'TOOL', {
          text: JSON.stringify({
            status: 'TASK_CREATED',
            taskId: task.id,
            taskStatus: task.status,
          }),
          name: stored.action,
        });
      await this.audit.record(user.id, 'ai.proposal.confirm', 'ai_proposal', id, {
        taskId: task.id,
      });
      return { proposal: proposalDto(await this.repository.proposal(id, user.id)), task };
    } catch {
      await this.repository.recordProposalFailure(id);
      await this.audit.record(user.id, 'ai.proposal.execute_failed', 'ai_proposal', id);
      throw new BadRequestException(
        '提案执行未完成，确认状态已保存；请先核查任务中心，不会自动重试',
      );
    }
  }
  private async confirmGraph(
    id: string,
    user: CurrentUser,
    snapshot: AiPolicySnapshot,
    stored: PreparedAiAction,
    prepared: PreparedAiAction,
    context: ResolvedAiContext | undefined,
  ) {
    const projectId = prepared.projectId!;
    const graph = this.tools.graphActions();
    const receipt = (runId: string, status: string) => ({
      id: runId,
      projectId,
      flowId: prepared.preview.flowId,
      flowName: prepared.preview.flowName,
      version: prepared.preview.version,
      status,
    });
    let authorizedScope: GraphPlanAccessScope | undefined;
    const run = await graph.run(prepared, id, user, {
      authorizePlan: (scope) => {
        graph.authorize(user, snapshot, projectId, scope, context);
        authorizedScope = scope;
      },
      beforeInsert: async (transaction) => {
        const actor = await transaction
          .selectFrom('users')
          .select(['role', 'status', 'must_change_password'])
          .where('id', '=', user.id)
          .executeTakeFirst();
        if (
          !actor ||
          actor.status !== 'ACTIVE' ||
          actor.must_change_password ||
          actor.role !== user.role
        )
          throw new ForbiddenException('用户权限已变化，请重新登录');
        if (!authorizedScope) throw new ForbiddenException('执行流未提供完整授权范围');
        const current = await this.policy.snapshot(projectId, transaction);
        graph.authorize(user, current, projectId, authorizedScope, context);
        if (!(await this.repository.approve(id, user.id, current, transaction)))
          throw new ConflictException('操作提案已处理或过期');
      },
      afterInsert: async (transaction, runId) => {
        const graphRun = receipt(runId, 'QUEUED');
        await this.repository.recordProposalPreview(
          id,
          { ...prepared.preview, graphRun },
          transaction,
        );
        await this.audit.record(
          user.id,
          'ai.proposal.confirm',
          'ai_proposal',
          id,
          {
            graphRunId: runId,
          },
          transaction,
        );
        if (stored.conversationId)
          await this.repository.addMessage(
            stored.conversationId,
            'TOOL',
            {
              text: JSON.stringify({ status: 'GRAPH_RUN_CREATED', proposalId: id, graphRun }),
              name: aiGraphAction,
            },
            undefined,
            transaction,
          );
      },
    });
    return {
      proposal: proposalDto(await this.repository.proposal(id, user.id)),
      graphRun: receipt(run.id, run.status),
      sourceChange: undefined,
      task: undefined,
    };
  }
  async reject(id: string, user: CurrentUser) {
    await this.repository.proposal(id, user.id);
    if (!(await this.repository.reject(id, user.id))) {
      await this.repository.expire(id);
      throw new ConflictException('操作提案已处理或过期');
    }
    await this.audit.record(user.id, 'ai.proposal.reject', 'ai_proposal', id);
    return {
      proposal: this.scopedPreview(
        await this.repository.proposal(id, user.id),
        await this.policy.projectSnapshots(),
        user,
      ),
    };
  }
}
