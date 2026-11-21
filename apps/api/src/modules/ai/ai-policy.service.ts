import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AiRepository } from './ai.repository';
import { AiActionRuleDto, AiMode, AiPolicyDto } from './ai.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { ProjectsService } from '../projects/projects.service';
import { AuditService } from '../audit/audit.service';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';

export interface AiScope {
  serverIds?: string[];
  projectIds?: string[];
  repositoryIds?: string[];
  approvedPipelineHashes?: string[];
  allowedActions?: string[];
  deniedActions?: string[];
  requireConfirmActions?: string[];
  actionRules?: AiActionRuleDto[];
}
export interface AiPolicy extends AiScope {
  mode: AiMode;
  projectId?: string;
}
export interface AiPolicySnapshot {
  system: AiPolicy;
  project?: AiPolicy;
  mode: AiMode;
}
export interface AiActionScope {
  action: string;
  serverIds: string[];
  projectId?: string;
  repositoryId?: string;
  sourceRepositoryIds?: string[];
  aiApprovalHash?: string;
}
const validActions = new Set([
  'execute_command',
  'run_pipeline',
  'run_execution_flow',
  'list_execution_flows',
  'inspect_servers',
  'initialize_component',
  'diagnose_deployment',
  'publish_source_branch',
  'open_pull_request',
  'draft_source_change',
  'list_servers',
  'list_projects',
  'list_tasks',
  'get_task',
  'get_project',
  'query_pipeline',
  'draft_pipeline',
  'analyze_repository_deployment',
  'draft_operation_plan',
  'get_operation_plan',
]);
@Injectable()
export class AiPolicyService {
  constructor(
    private readonly repository: AiRepository,
    private readonly projects: ProjectsService,
    private readonly audit: AuditService,
  ) {}
  async list(db?: Kysely<Database>) {
    const rows = await this.repository.policies(db);
    const policies = rows.map((r) => ({
      ...(JSON.parse(r.scope_json) as AiScope),
      mode: r.mode as AiMode,
      ...(r.project_id ? { projectId: r.project_id } : {}),
    }));
    return {
      system: policies.find((r) => !r.projectId) ?? { mode: 'CONFIRM' as AiMode },
      projects: policies.filter((r) => r.projectId),
    };
  }
  async update(input: AiPolicyDto, user: CurrentUser) {
    if (user.role !== 'ADMIN') throw new ForbiddenException('仅管理员可修改 AI 策略');
    for (const values of [input.allowedActions, input.deniedActions, input.requireConfirmActions]) {
      if (values?.some((a) => !validActions.has(a)))
        throw new BadRequestException('AI 策略包含未注册的操作类型');
    }
    if (input.projectId) await this.projects.get(input.projectId);
    if (
      input.actionRules?.some(
        (rule) =>
          (rule.action === 'publish_source_branch' || rule.action === 'open_pull_request') &&
          (rule.serverId || rule.minimumTargets),
      )
    )
      throw new BadRequestException('仓库写入规则仅支持按角色限制');
    if (input.mode === 'FULL_CONTROL' && !input.serverIds?.length)
      throw new BadRequestException('完全控制模式必须明确指定授权服务器范围');
    await this.repository.setPolicy(input);
    await this.audit.record(user.id, 'ai.policy.update', 'ai_policy', input.projectId || 'system', {
      mode: input.mode,
    });
    return this.list();
  }
  async resetProject(projectId: string, user: CurrentUser) {
    if (user.role !== 'ADMIN') throw new ForbiddenException('仅管理员可修改 AI 策略');
    await this.projects.get(projectId);
    await this.repository.deleteProjectPolicy(projectId);
    await this.audit.record(user.id, 'ai.policy.inherit', 'ai_policy', projectId);
    return this.list();
  }
  async snapshot(projectId?: string, db?: Kysely<Database>): Promise<AiPolicySnapshot> {
    return (await this.projectSnapshots(db))(projectId);
  }
  async projectSnapshots(db?: Kysely<Database>) {
    const all = await this.list(db);
    const byId = new Map(all.projects.map((policy) => [policy.projectId, policy]));
    return (projectId?: string): AiPolicySnapshot => {
      const project = projectId ? byId.get(projectId) : undefined;
      return {
        system: all.system,
        ...(project && { project }),
        mode: project?.mode ?? all.system.mode,
      };
    };
  }
  allowedRepository(repositoryId: string, snapshot: AiPolicySnapshot) {
    return this.scopes(snapshot).every(
      ({ repositoryIds }) => !repositoryIds || repositoryIds.includes(repositoryId),
    );
  }
  assertRepository(repositoryId: string, snapshot: AiPolicySnapshot) {
    if (!this.allowedRepository(repositoryId, snapshot))
      throw new ForbiddenException('仓库不在 AI 授权范围内');
  }
  scopes(snapshot: AiPolicySnapshot): AiPolicy[] {
    return [snapshot.system, ...(snapshot.project ? [snapshot.project] : [])];
  }
  assertRead(
    action: string,
    snapshot: AiPolicySnapshot,
    projectId?: string,
    serverIds: string[] = [],
  ) {
    for (const scope of this.scopes(snapshot)) {
      if (scope.deniedActions?.includes(action))
        throw new ForbiddenException('操作被 AI 全局或项目策略禁止');
      if (projectId && scope.projectIds && !scope.projectIds.includes(projectId))
        throw new ForbiddenException('项目不在 AI 授权范围内');
      if (scope.serverIds && serverIds.some((id) => !scope.serverIds!.includes(id)))
        throw new ForbiddenException('批量目标包含未授权服务器，已拒绝整个操作');
    }
  }
  evaluate(
    user: CurrentUser,
    input: AiActionScope,
    snapshot: AiPolicySnapshot,
  ): 'ALLOW' | 'REQUIRE_CONFIRM' {
    if (!['ADMIN', 'OPERATOR'].includes(user.role))
      throw new ForbiddenException('当前用户角色不能执行服务器操作');
    this.assertRead(input.action, snapshot, input.projectId, input.serverIds);
    if (snapshot.mode === 'READ_ONLY')
      throw new ForbiddenException('AI 只读模式禁止执行命令或部署');
    const targetCount = new Set(input.serverIds).size;
    const rules = this.scopes(snapshot)
      .flatMap((scope) => scope.actionRules ?? [])
      .filter(
        (rule) =>
          rule.action === input.action &&
          (!rule.role || rule.role === user.role) &&
          (!rule.serverId || input.serverIds.includes(rule.serverId)) &&
          (!rule.minimumTargets || targetCount >= rule.minimumTargets),
      );
    if (rules.some((rule) => rule.effect === 'DENY'))
      throw new ForbiddenException('该操作命中 AI 条件禁止规则');
    for (const scope of this.scopes(snapshot)) {
      if (scope.allowedActions && !scope.allowedActions.includes(input.action))
        throw new ForbiddenException('操作类型不在 AI 授权范围内');
    }
    if (input.repositoryId) this.assertRepository(input.repositoryId, snapshot);
    for (const id of input.sourceRepositoryIds ?? []) this.assertRepository(id, snapshot);
    const sourceWrite =
      input.action === 'publish_source_branch' || input.action === 'open_pull_request';
    if (input.action === 'run_execution_flow') {
      if (!input.projectId) throw new BadRequestException('执行流必须明确指定项目');
      return 'REQUIRE_CONFIRM';
    }
    if (sourceWrite && (!input.projectId || !input.repositoryId))
      throw new BadRequestException('AI 源代码写操作必须明确指定项目和仓库');
    if (!sourceWrite && !input.serverIds.length)
      throw new BadRequestException('AI 执行必须明确指定目标服务器');
    if (
      !sourceWrite &&
      snapshot.mode === 'FULL_CONTROL' &&
      !this.scopes(snapshot).some((s) => s.serverIds?.length)
    )
      throw new ForbiddenException('完全控制模式缺少明确的服务器授权范围');
    if (
      snapshot.mode === 'CONFIRM' ||
      rules.some((rule) => rule.effect === 'CONFIRM') ||
      this.scopes(snapshot).some((s) => s.requireConfirmActions?.includes(input.action))
    )
      return 'REQUIRE_CONFIRM';
    if (sourceWrite)
      return this.scopes(snapshot).some((scope) =>
        scope.repositoryIds?.includes(input.repositoryId!),
      )
        ? 'ALLOW'
        : 'REQUIRE_CONFIRM';
    if (input.action === 'initialize_component' || input.action === 'inspect_servers')
      return 'ALLOW';
    if (input.action === 'run_pipeline' && input.aiApprovalHash) {
      const definitions = this.scopes(snapshot).flatMap((scope) =>
        scope.approvedPipelineHashes ? [scope.approvedPipelineHashes] : [],
      );
      if (
        definitions.length &&
        definitions.every((hashes) => hashes.includes(input.aiApprovalHash!))
      )
        return 'ALLOW';
    }
    return 'REQUIRE_CONFIRM';
  }
  allowedServer(id: string, snapshot: AiPolicySnapshot) {
    return this.scopes(snapshot).every((s) => !s.serverIds || s.serverIds.includes(id));
  }
  allowedProject(id: string, snapshot: AiPolicySnapshot) {
    return this.scopes(snapshot).every((s) => !s.projectIds || s.projectIds.includes(id));
  }
}
