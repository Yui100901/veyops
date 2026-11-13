import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Selectable } from 'kysely';
import { AiActionProposalsTable } from '../../core/database/schema';
import { CurrentUser } from '../auth/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { AiRepository } from './ai.repository';
import { AiPolicyService, AiPolicySnapshot } from './ai-policy.service';
import { AiToolsService, PreparedAiAction } from './ai-tools.service';

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
  };
}
@Injectable()
export class AiProposalsService {
  constructor(
    private readonly repository: AiRepository,
    private readonly policy: AiPolicyService,
    private readonly tools: AiToolsService,
    private readonly audit: AuditService,
  ) {}
  async list(userId: string) {
    return (await this.repository.proposals(userId)).map(proposalDto);
  }
  async create(prepared: PreparedAiAction, snapshot: AiPolicySnapshot, user: CurrentUser) {
    const id = randomUUID();
    const now = Date.now();
    await this.repository.createProposal({
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
    });
    await this.audit.record(user.id, 'ai.proposal.create', 'ai_proposal', id, {
      action: prepared.action,
      targetCount: prepared.serverIds.length,
    });
    return proposalDto(await this.repository.proposal(id, user.id));
  }
  async confirm(id: string, user: CurrentUser) {
    const row = await this.repository.proposal(id, user.id);
    if (row.expires_at <= Date.now()) {
      await this.repository.expire(id);
      throw new ConflictException('操作提案已过期，请重新生成');
    }
    if (row.status !== 'PENDING') throw new ConflictException('操作提案已处理，不能重复确认');
    const stored = JSON.parse(row.payload_json) as PreparedAiAction;
    const prepared = await this.tools.prepare(stored.action, stored.payload);
    prepared.projectId ??= stored.projectId;
    if (
      prepared.bindingsHash !== stored.bindingsHash ||
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
      const task = await this.tools.execute(prepared, user);
      await this.repository.attachTask(id, task.id);
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
    return { proposal: proposalDto(await this.repository.proposal(id, user.id)) };
  }
}
