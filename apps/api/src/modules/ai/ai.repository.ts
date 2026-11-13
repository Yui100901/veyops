import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Insertable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import { AiActionProposalsTable, AiProvidersTable } from '../../core/database/schema';
import { AiPolicyDto } from './ai.dto';

@Injectable()
export class AiRepository {
  constructor(private readonly database: DatabaseService) {}
  providers() {
    return this.database.db.selectFrom('ai_providers').selectAll().orderBy('created_at').execute();
  }
  async provider(id: string) {
    const row = await this.database.db
      .selectFrom('ai_providers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('AI Provider 不存在');
    return row;
  }
  createProvider(row: Insertable<AiProvidersTable>) {
    return this.database.db.insertInto('ai_providers').values(row).execute();
  }
  updateProvider(id: string, row: Partial<Insertable<AiProvidersTable>>) {
    return this.database.db.updateTable('ai_providers').set(row).where('id', '=', id).execute();
  }
  deleteProvider(id: string) {
    return this.database.db.deleteFrom('ai_providers').where('id', '=', id).execute();
  }
  async policies() {
    return this.database.db.selectFrom('ai_permission_policies').selectAll().execute();
  }
  async setPolicy(input: AiPolicyDto) {
    const now = Date.now();
    const key = input.projectId ? `project:${input.projectId}` : 'system';
    const { mode, projectId, ...scope } = input;
    const values = { mode, scope_json: JSON.stringify(scope), updated_at: now };
    await this.database.db
      .insertInto('ai_permission_policies')
      .values({
        id: randomUUID(),
        scope_type: projectId ? 'PROJECT' : 'SYSTEM',
        scope_key: key,
        project_id: projectId ?? null,
        ...values,
        created_at: now,
      })
      .onConflict((c) => c.column('scope_key').doUpdateSet(values))
      .execute();
  }
  async conversation(id: string, userId: string) {
    const row = await this.database.db
      .selectFrom('ai_conversations')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('对话不存在');
    return row;
  }
  async createConversation(userId: string, title: string, projectId?: string) {
    const row = {
      id: randomUUID(),
      user_id: userId,
      title,
      project_id: projectId ?? null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await this.database.db.insertInto('ai_conversations').values(row).execute();
    return row;
  }
  conversations(userId: string) {
    return this.database.db
      .selectFrom('ai_conversations')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .limit(100)
      .execute();
  }
  async messages(id: string, userId: string) {
    await this.conversation(id, userId);
    return this.database.db
      .selectFrom('ai_messages')
      .selectAll()
      .where('conversation_id', '=', id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }
  async addMessage(conversationId: string, role: string, content: unknown, toolCall?: unknown) {
    const last = await this.database.db
      .selectFrom('ai_messages')
      .select('created_at')
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const at = Math.max(Date.now(), (last?.created_at ?? 0) + 1);
    await this.database.db
      .insertInto('ai_messages')
      .values({
        id: randomUUID(),
        conversation_id: conversationId,
        role,
        content_json: JSON.stringify(content),
        tool_call_json: toolCall ? JSON.stringify(toolCall) : null,
        created_at: at,
      })
      .execute();
    await this.database.db
      .updateTable('ai_conversations')
      .set({ updated_at: at })
      .where('id', '=', conversationId)
      .execute();
  }
  createProposal(row: Insertable<AiActionProposalsTable>) {
    return this.database.db.insertInto('ai_action_proposals').values(row).execute();
  }
  async proposal(id: string, userId: string) {
    const row = await this.database.db
      .selectFrom('ai_action_proposals')
      .selectAll()
      .where('id', '=', id)
      .where('created_by', '=', userId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('操作提案不存在');
    return row;
  }
  async proposals(userId: string) {
    await this.database.db
      .updateTable('ai_action_proposals')
      .set({ status: 'EXPIRED' })
      .where('created_by', '=', userId)
      .where('status', '=', 'PENDING')
      .where('expires_at', '<=', Date.now())
      .execute();
    return this.database.db
      .selectFrom('ai_action_proposals')
      .selectAll()
      .where('created_by', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
  }
  async approve(id: string, userId: string, snapshot: unknown) {
    return this.database.db
      .updateTable('ai_action_proposals')
      .set({
        status: 'APPROVED',
        confirmed_by: userId,
        confirmed_at: Date.now(),
        policy_snapshot_json: JSON.stringify(snapshot),
      })
      .where('id', '=', id)
      .where('created_by', '=', userId)
      .where('status', '=', 'PENDING')
      .where('expires_at', '>', Date.now())
      .returning('id')
      .executeTakeFirst();
  }
  reject(id: string, userId: string) {
    return this.database.db
      .updateTable('ai_action_proposals')
      .set({ status: 'REJECTED', confirmed_by: userId, confirmed_at: Date.now() })
      .where('id', '=', id)
      .where('created_by', '=', userId)
      .where('status', '=', 'PENDING')
      .where('expires_at', '>', Date.now())
      .returning('id')
      .executeTakeFirst();
  }
  expire(id: string) {
    return this.database.db
      .updateTable('ai_action_proposals')
      .set({ status: 'EXPIRED' })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .where('expires_at', '<=', Date.now())
      .execute();
  }
  attachTask(id: string, taskId: string) {
    return this.database.db
      .updateTable('ai_action_proposals')
      .set({ task_id: taskId })
      .where('id', '=', id)
      .where('status', '=', 'APPROVED')
      .execute();
  }
  recordProposalFailure(id: string) {
    return this.database.db
      .updateTable('ai_action_proposals')
      .set({
        preview_json: JSON.stringify({
          executionError: '执行未完成，提案已消费；请到任务中心核查，禁止自动重试',
        }),
      })
      .where('id', '=', id)
      .execute();
  }
}
