import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AiRepository } from './ai.repository';
import { AiMode, AiPolicyDto } from './ai.dto';
import { CurrentUser } from '../auth/auth.decorators';
import { ProjectsService } from '../projects/projects.service';
import { AuditService } from '../audit/audit.service';

export interface AiScope {
  serverIds?: string[];
  projectIds?: string[];
  repositoryIds?: string[];
  approvedPipelineHashes?: string[];
  allowedActions?: string[];
  deniedActions?: string[];
  requireConfirmActions?: string[];
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
]);
@Injectable()
export class AiPolicyService {
  constructor(
    private readonly repository: AiRepository,
    private readonly projects: ProjectsService,
    private readonly audit: AuditService,
  ) {}
  async list() {
    const rows = await this.repository.policies();
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
    if (input.mode === 'FULL_CONTROL' && !input.serverIds?.length)
      throw new BadRequestException('完全控制模式必须明确指定授权服务器范围');
    await this.repository.setPolicy(input);
    await this.audit.record(user.id, 'ai.policy.update', 'ai_policy', input.projectId || 'system', {
      mode: input.mode,
    });
    return this.list();
  }
  async snapshot(projectId?: string): Promise<AiPolicySnapshot> {
    const all = await this.list();
    const project = projectId ? all.projects.find((p) => p.projectId === projectId) : undefined;
    return {
      system: all.system,
      ...(project ? { project } : {}),
      mode: project?.mode ?? all.system.mode,
    };
  }
  assertRepository(repositoryId: string, snapshot: AiPolicySnapshot) {
    if (
      this.scopes(snapshot).some(
        ({ repositoryIds }) => repositoryIds && !repositoryIds.includes(repositoryId),
      )
    )
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
    for (const scope of this.scopes(snapshot)) {
      if (scope.allowedActions && !scope.allowedActions.includes(input.action))
        throw new ForbiddenException('操作类型不在 AI 授权范围内');
    }
    if (input.repositoryId) this.assertRepository(input.repositoryId, snapshot);
    for (const id of input.sourceRepositoryIds ?? []) this.assertRepository(id, snapshot);
    const sourceWrite =
      input.action === 'publish_source_branch' || input.action === 'open_pull_request';
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
