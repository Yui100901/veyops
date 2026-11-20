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
    if (row.expires_at <= Date.now()) {
      await this.repository.expire(id);
      throw new ConflictException('操作提案已过期，请重新生成');
    }
    if (row.status !== 'PENDING') throw new ConflictException('操作提案已处理，不能重复确认');
    const stored = JSON.parse(row.payload_json) as PreparedAiAction;
    if (stored.action === 'run_pipeline')
      throw new ConflictException('请从项目执行图预览并确认交付流程');
    const repair = stored.failureTaskId
      ? { taskId: stored.failureTaskId, proposalId: id, automatic }
      : undefined;
    if (repair) {
      const context = await this.failureGuard?.repair(repair.taskId, repair);
      if (
        !context ||
        context.actor.id !== user.id ||
        stored.action !== 'initialize_component' ||
        stored.payload.component !== context.component ||
        stored.projectId !== context.projectId ||
        stored.serverIds.length !== 1 ||
        stored.serverIds[0] !== context.current.id
      )
        throw new ConflictException('故障修复绑定已失效');
    }
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
    );
    if (prepared.action === 'run_pipeline') assertAiPipelineScope(context, prepared.preview);
    prepared.projectId ??= stored.projectId;
    if (
      prepared.bindingsHash !== stored.bindingsHash ||
      prepared.projectId !== stored.projectId ||
      prepared.repositoryId !== stored.repositoryId ||
      JSON.stringify([...prepared.serverIds].sort()) !==
        JSON.stringify([...stored.serverIds].sort())
    )
      throw new ConflictException('服务器配置或部署目标已改变，请重新生成提案');
    const snapshot = await this.policy.snapshot(prepared.projectId);
    this.policy.evaluate(user, prepared, snapshot);
    if (!(await this.repository.approve(id, user.id, snapshot)))
      throw new ConflictException('操作提案已处理或过期');
    try {
      // Consume first. If the process crashes here, a human must inspect rather than replay a write.
      const task = await this.tools.execute(prepared, user, repair);
      if ('sourceChange' in task) {
        await this.repository.recordSourceChange(id, {
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
