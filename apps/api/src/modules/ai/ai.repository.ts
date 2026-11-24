import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Insertable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import { AiActionProposalsTable, AiProvidersTable } from '../../core/database/schema';
import type { CurrentUser } from '../auth/auth.decorators';
import type { ResolvedAiContext } from './ai-context';
import type { PipelineDefinition } from '../pipelines/pipeline.types';
import { pipelineSourceRepositories } from '../pipelines/pipeline-node-config';
import type { TaskPayload } from '../tasks/tasks.types';
import type { AiContextDto, AiPolicyDto, AiRoutesDto } from './ai.dto';
import { lockProjectGraph } from '../projects/project-guards';

const contextRole = 'PAGE_CONTEXT';

@Injectable()
export class AiRepository {
  constructor(private readonly database: DatabaseService) {}
  providers() {
    return this.database.db
      .selectFrom('ai_providers')
      .leftJoin('credentials', 'credentials.id', 'ai_providers.credential_id')
      .selectAll('ai_providers')
      .select('credentials.status as credential_status')
      .orderBy('ai_providers.created_at')
      .orderBy('ai_providers.id')
      .execute();
  }
  async routes(): Promise<AiRoutesDto> {
    const row = await this.database.db
      .selectFrom('system_settings')
      .select('value_json')
      .where('key', '=', 'ai:model-routes')
      .executeTakeFirst();
    return row ? JSON.parse(row.value_json) : {};
  }
  async saveRoutes(routes: AiRoutesDto) {
    const values = { value_json: JSON.stringify(routes), updated_at: Date.now() };
    await this.database.db
      .insertInto('system_settings')
      .values({ key: 'ai:model-routes', ...values })
      .onConflict((c) => c.column('key').doUpdateSet(values))
      .execute();
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
  async policies(db = this.database.db) {
    return db.selectFrom('ai_permission_policies').selectAll().execute();
  }
  async setPolicy(input: AiPolicyDto) {
    const now = Date.now();
    const key = input.projectId ? `project:${input.projectId}` : 'system';
    const { mode, projectId, ...scope } = input;
    const values = { mode, scope_json: JSON.stringify(scope), updated_at: now };
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const current = await tx
        .insertInto('ai_permission_policies')
        .values({
          id: randomUUID(),
          scope_type: projectId ? 'PROJECT' : 'SYSTEM',
          scope_key: key,
          project_id: projectId ?? null,
          ...values,
          created_at: now,
        })
        .onConflict((c) =>
          c.column('scope_key').doUpdateSet((eb) => ({
            scope_json: eb.ref('ai_permission_policies.scope_json'),
          })),
        )
        .returning('scope_json')
        .executeTakeFirstOrThrow();
      // Older policy editors omit actionRules. Only an explicit array replaces these restrictions.
      const prior = JSON.parse(current.scope_json) as AiPolicyDto;
      await tx
        .updateTable('ai_permission_policies')
        .set({
          ...values,
          scope_json: JSON.stringify({
            ...scope,
            actionRules: scope.actionRules ?? prior.actionRules,
          }),
        })
        .where('scope_key', '=', key)
        .execute();
    });
  }
  deleteProjectPolicy(projectId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      return tx
        .deleteFrom('ai_permission_policies')
        .where('scope_type', '=', 'PROJECT')
        .where('project_id', '=', projectId)
        .execute();
    });
  }

  async resolveContext(
    input: AiContextDto,
    requestedProjectId: string | undefined,
    user: CurrentUser,
  ) {
    const db = this.database.db;
    const result: ResolvedAiContext = { input };
    switch (input.kind) {
      case 'REPOSITORY': {
        const repository = await db
          .selectFrom('repositories')
          .select('project_id')
          .where('id', '=', input.repositoryId!)
          .executeTakeFirst();
        if (!repository) throw new NotFoundException('AI 上下文仓库不存在');
        result.projectId = repository.project_id;
        result.repositoryId = input.repositoryId;
        result.serviceId = input.serviceId;
        break;
      }
      case 'SERVICE':
        result.serviceId = input.serviceId;
        break;
      case 'PIPELINE': {
        const pipeline = await db
          .selectFrom('pipelines')
          .innerJoin('pipeline_versions', (join) =>
            join
              .onRef('pipeline_versions.pipeline_id', '=', 'pipelines.id')
              .onRef('pipeline_versions.version', '=', 'pipelines.current_version'),
          )
          .select([
            'pipelines.project_id',
            'pipelines.service_id',
            'pipeline_versions.definition_json',
          ])
          .where('pipelines.id', '=', input.pipelineId!)
          .executeTakeFirst();
        if (!pipeline) throw new NotFoundException('AI 上下文流水线不存在');
        result.projectId = pipeline.project_id;
        result.serviceId = pipeline.service_id;
        const definition = JSON.parse(pipeline.definition_json) as PipelineDefinition;
        result.repositoryId = definition.repositoryId;
        result.sourceRepositoryIds = pipelineSourceRepositories(definition);
        break;
      }
      case 'TASK': {
        const task = await db
          .selectFrom('tasks')
          .select(['project_id', 'service_id', 'created_by', 'payload_json'])
          .where('id', '=', input.taskId!)
          .executeTakeFirst();
        if (!task) throw new NotFoundException('AI 上下文任务不存在');
        if (!task.project_id && task.created_by !== user.id && user.role !== 'ADMIN')
          throw new ForbiddenException('无权读取该运维任务的 AI 上下文');
        result.projectId = task.project_id ?? undefined;
        result.serviceId = task.service_id ?? undefined;
        const pipeline = (JSON.parse(task.payload_json) as TaskPayload).pipeline;
        if (pipeline?.definition)
          result.sourceRepositoryIds = pipelineSourceRepositories(pipeline.definition);
        result.serverIds = (
          await db
            .selectFrom('task_targets')
            .select('server_id')
            .where('task_id', '=', input.taskId!)
            .execute()
        ).map(({ server_id }) => server_id ?? 'deleted');
        break;
      }
      case 'OPERATION_PLAN':
        if (input.operationPlanId) {
          const plan = await db
            .selectFrom('operation_plans')
            .select('id')
            .where('id', '=', input.operationPlanId)
            .executeTakeFirst();
          if (!plan) throw new NotFoundException('AI 上下文运维方案不存在');
        }
        result.projectId = requestedProjectId;
        break;
    }
    if (result.serviceId) {
      const service = await db
        .selectFrom('services')
        .select('project_id')
        .where('id', '=', result.serviceId)
        .executeTakeFirst();
      if (!service) throw new NotFoundException('AI 上下文服务不存在');
      if (result.projectId && result.projectId !== service.project_id)
        throw new ForbiddenException('AI 上下文服务与项目不一致');
      result.projectId = service.project_id;
    }
    if (requestedProjectId && requestedProjectId !== result.projectId)
      throw new ForbiddenException('AI 上下文与当前项目不一致');
    if (result.projectId) {
      const project = await db
        .selectFrom('projects')
        .select('id')
        .where('id', '=', result.projectId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!project) throw new NotFoundException('AI 上下文项目不存在');
    }
    return result;
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
  async createConversation(
    userId: string,
    title: string,
    projectId?: string,
    context?: AiContextDto,
  ) {
    const row = {
      id: randomUUID(),
      user_id: userId,
      title,
      project_id: projectId ?? null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await this.database.db.transaction().execute(async (tx) => {
      await tx.insertInto('ai_conversations').values(row).execute();
      if (context)
        await tx
          .insertInto('ai_messages')
          .values({
            id: randomUUID(),
            conversation_id: row.id,
            role: contextRole,
            content_json: JSON.stringify(context),
            created_at: row.created_at,
          })
          .execute();
    });
    return row;
  }
  conversations(userId: string) {
    return this.database.db
      .selectFrom('ai_conversations as conversation')
      .leftJoin('ai_messages as context', (join) =>
        join
          .onRef('context.conversation_id', '=', 'conversation.id')
          .on('context.role', '=', contextRole),
      )
      .selectAll('conversation')
      .select('context.content_json as context_json')
      .where('conversation.user_id', '=', userId)
      .orderBy('conversation.updated_at', 'desc')
      .limit(100)
      .execute();
  }
  async conversationContext(id: string): Promise<AiContextDto | undefined> {
    const row = await this.database.db
      .selectFrom('ai_messages')
      .select('content_json')
      .where('conversation_id', '=', id)
      .where('role', '=', contextRole)
      .executeTakeFirst();
    return row ? (JSON.parse(row.content_json) as AiContextDto) : undefined;
  }
  async messages(id: string, userId: string) {
    await this.conversation(id, userId);
    return this.database.db
      .selectFrom('ai_messages')
      .selectAll()
      .where('conversation_id', '=', id)
      .where('role', '!=', contextRole)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }
  async addMessage(
    conversationId: string,
    role: string,
    content: unknown,
    toolCall?: unknown,
    db = this.database.db,
  ) {
    const last = await db
      .selectFrom('ai_messages')
      .select('created_at')
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const at = Math.max(Date.now(), (last?.created_at ?? 0) + 1);
    await db
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
    await db
      .updateTable('ai_conversations')
      .set({ updated_at: at })
      .where('id', '=', conversationId)
      .execute();
  }
  async createProposal(row: Insertable<AiActionProposalsTable>, conversationId?: string) {
    return this.database.db.transaction().execute(async (tx) => {
      if (conversationId) {
        await tx
          .updateTable('ai_conversations')
          .set((eb) => ({ updated_at: eb.ref('updated_at') }))
          .where('id', '=', conversationId)
          .where('user_id', '=', row.created_by)
          .executeTakeFirst();
        const pending = await tx
          .selectFrom('ai_action_proposals')
          .select('payload_json')
          .where('created_by', '=', row.created_by)
          .where('status', '=', 'PENDING')
          .where('expires_at', '>', Date.now())
          .execute();
        if (
          pending.some(
            ({ payload_json }) => JSON.parse(payload_json).conversationId === conversationId,
          )
        )
          return false;
      }
      await tx.insertInto('ai_action_proposals').values(row).execute();
      return true;
    });
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
  async approve(id: string, userId: string, snapshot: unknown, db = this.database.db) {
    return db
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
  recordProposalPreview(id: string, preview: Record<string, unknown>, db = this.database.db) {
    return db
      .updateTable('ai_action_proposals')
      .set({ preview_json: JSON.stringify(preview) })
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
