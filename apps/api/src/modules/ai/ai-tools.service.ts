import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ServersService } from '../servers/servers.service';
import { ProjectsService } from '../projects/projects.service';
import { isTerminalStatus, TasksService } from '../tasks/tasks.service';
import { CommandCenterService } from '../command-center/command-center.service';
import { ExecuteCommandDto } from '../command-center/command.dto';
import { AiPolicyService, AiPolicySnapshot } from './ai-policy.service';
import { CurrentUser } from '../auth/auth.decorators';
import { sanitizeAiText } from '../../infrastructure/ai-provider/openai-compatible.service';
import { createHash } from 'node:crypto';
import { AiDeploymentToolsService, InitializationComponent } from './ai-deployment-tools.service';
import { AiRepositoryAnalysisDto } from './ai.dto';
import { AiRepositoryAnalysisService } from './ai-repository-analysis.service';
import { AiSourceChangeService } from './ai-source-change.service';
import { setTimeout as sleep } from 'node:timers/promises';
import { aiWriteActions } from './ai.dto';
import { OperationPlansService } from '../operation-plans/operation-plans.service';
import { assertAiPipelineScope, pinAiContextField, type ResolvedAiContext } from './ai-context';
import type { PipelineDefinition } from '../pipelines/pipeline.types';
import { pipelineSourceRepositories } from '../pipelines/pipeline-node-config';
import { AiGraphActionsService, aiGraphAction } from './ai-graph-actions.service';

function aiPipelineDefinition(definition: PipelineDefinition) {
  if (!definition.nodes) return definition;
  return {
    ...definition,
    nodes: definition.nodes.map(({ variables, ...node }) => ({
      ...node,
      ...(variables && {
        variables: variables.map(({ key, credentialId }) => ({
          key,
          sensitive: Boolean(credentialId),
        })),
      }),
    })),
  };
}

function aiTaskSummary(task: Awaited<ReturnType<TasksService['get']>>) {
  const {
    id,
    type,
    name,
    status,
    projectId,
    serviceId,
    environmentId,
    createdAt,
    startedAt,
    finishedAt,
  } = task;
  return {
    id,
    type,
    name,
    status,
    projectId,
    serviceId,
    environmentId,
    createdAt,
    startedAt,
    finishedAt,
  };
}

const str = { type: 'string' };
const ids = { type: 'array', items: str, minItems: 1, maxItems: 100 };
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}
export const aiToolDefinitions = [
  tool('list_servers', '列出授权范围内服务器的非敏感信息，不返回凭据', {}),
  tool('list_projects', '列出授权范围内项目', {}),
  tool('list_tasks', '列出授权范围内最近任务', {}),
  tool(
    'get_task',
    '读取任务状态和每目标结果，可短暂等待本轮任务完成',
    {
      taskId: str,
      waitSeconds: { type: 'integer', minimum: 1, maximum: 10 },
    },
    ['taskId'],
  ),
  tool('get_project', '读取项目的仓库、服务和环境元数据', { projectId: str }, ['projectId']),
  tool('query_pipeline', '读取一个Pipeline配置或列出Pipeline', { pipelineId: str }),
  tool(
    'draft_pipeline',
    '生成Pipeline配置草稿，不写入或执行。definition是完整创建请求JSON字符串：{name,projectId,serviceId,definition:{repositoryId,buildLocation,artifactType,repoPath,installCommand,buildCommand,outputPath,deployPath,...}}。UUID必须先查询，未知值不猜测',
    { definition: str },
    ['definition'],
  ),
  tool(
    'draft_operation_plan',
    '生成运维方案草稿，不写入或执行。definition是包含name和steps的JSON对象字符串',
    { definition: str },
    ['definition'],
  ),
  tool('get_operation_plan', '读取当前页面已选运维方案的版本、节点和分支', {
    operationPlanId: str,
  }),
  tool(
    'inspect_servers',
    '只读检查明确目标的系统、磁盘、构建工具和版本、Docker/Compose 及包管理活动',
    { serverIds: ids },
    ['serverIds'],
  ),
  tool(
    'diagnose_deployment',
    '读取授权任务的失败阶段、退出码和固定故障分类，不读取原始日志',
    { taskId: str },
    ['taskId'],
  ),
  tool(
    'analyze_repository_deployment',
    '按已登记仓库和固定提交的构建配置、源文件和文档生成只读 Pipeline 草稿；省略提交使用仓库默认分支',
    {
      projectId: str,
      repositoryId: str,
      commitSha: str,
      serviceId: str,
      environmentId: str,
      repoPath: str,
      docPath: str,
    },
    ['repositoryId'],
  ),
  tool(
    'initialize_component',
    '用审核过的内置 v1 方案初始化缺少的组件。先巡检；支持 Debian/Ubuntu 上的 Docker、Compose v2、Node.js、Nginx',
    {
      serverIds: { ...ids, maxItems: 10 },
      component: { type: 'string', enum: ['docker', 'compose', 'node', 'nginx'] },
    },
    ['serverIds', 'component'],
  ),
  tool(
    'execute_command',
    '申请在明确服务器执行Shell命令。写操作必须遵守权限策略并等待提案确认',
    { serverIds: ids, command: str, name: str },
    ['serverIds', 'command'],
  ),
  tool(
    'run_pipeline',
    '运行已保存 Pipeline 的固定版本、环境和 Commit，默认使用服务环境配置的服务器或分组。完全控制仅对管理员已授权的组合免确认',
    {
      pipelineId: str,
      environmentId: str,
      targetId: str,
      commitSha: str,
      version: { type: 'integer', minimum: 1 },
      mode: { type: 'string', enum: ['BUILD_ONLY', 'DEPLOY'] },
    },
    ['pipelineId', 'environmentId', 'commitSha'],
  ),
  tool(
    'list_execution_flows',
    '列出指定项目最新已发布的执行流、版本和可填写的参数',
    { projectId: str },
    ['projectId'],
  ),
  tool(
    aiGraphAction,
    '为已发布的执行流生成预览和待人工确认的提案，沿用图中已配置的节点与发布门禁',
    {
      projectId: str,
      flowId: str,
      version: { type: 'integer', minimum: 1 },
      parameters: { type: 'object' },
    },
    ['projectId', 'flowId', 'version'],
  ),
  tool(
    'draft_source_change',
    '给出源代码修改建议，供用户审阅；不写入仓库',
    {
      projectId: str,
      repositoryId: str,
      title: str,
      description: str,
      baseCommit: str,
      baseBranch: str,
    },
    ['projectId', 'repositoryId', 'title', 'description', 'baseCommit', 'baseBranch'],
  ),
  tool(
    'publish_source_branch',
    '基于已登记仓库的固定基线和限定文件变更推送独立评审分支',
    {
      projectId: str,
      repositoryId: str,
      baseBranch: str,
      baseCommit: str,
      title: str,
      files: {
        type: 'array',
        minItems: 1,
        maxItems: 8,
        items: {
          type: 'object',
          properties: { path: str, content: str },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    ['projectId', 'repositoryId', 'baseBranch', 'baseCommit', 'title', 'files'],
  ),
  tool(
    'open_pull_request',
    '从本用户已提交的 VeyOps 评审分支创建待人工审查的 PR',
    {
      projectId: str,
      repositoryId: str,
      baseBranch: str,
      baseCommit: str,
      branch: str,
      commitSha: str,
      title: str,
      description: str,
    },
    ['projectId', 'repositoryId', 'baseBranch', 'baseCommit', 'branch', 'commitSha', 'title'],
  ),
];
export type PreparedAiAction = {
  failureTaskId?: string;
  action:
    | 'execute_command'
    | 'inspect_servers'
    | 'run_pipeline'
    | typeof aiGraphAction
    | 'initialize_component'
    | 'publish_source_branch'
    | 'open_pull_request';
  payload: Record<string, unknown>;
  serverIds: string[];
  projectId?: string;
  repositoryId?: string;
  sourceRepositoryIds?: string[];
  aiApprovalHash?: string;
  conversationId?: string;
  preview: Record<string, unknown>;
  bindingsHash: string;
};
export function isActionTool(name: string) {
  return aiWriteActions.some((action) => action === name);
}
@Injectable()
export class AiToolsService {
  constructor(
    private readonly servers: ServersService,
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
    private readonly commands: CommandCenterService,
    private readonly policy: AiPolicyService,
    private readonly moduleRef: ModuleRef,
    private readonly deploymentTools: AiDeploymentToolsService,
    private readonly repositoryAnalysis: AiRepositoryAnalysisService,
    private readonly sourceChange: AiSourceChangeService,
  ) {}
  private async pipelines() {
    const { PipelinesService } = await import('../pipelines/pipelines.service.js');
    return this.moduleRef.get(PipelinesService, { strict: false });
  }
  graphActions() {
    return this.moduleRef.get(AiGraphActionsService, { strict: false });
  }
  parse(argumentsJson: string): Record<string, unknown> {
    if (argumentsJson.length > 65536) throw new BadRequestException('AI 工具参数过大');
    let data: unknown;
    try {
      data = JSON.parse(argumentsJson);
    } catch {
      throw new BadRequestException('AI 工具参数不是合法 JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new BadRequestException('AI 工具参数必须为对象');
    return data as Record<string, unknown>;
  }
  private string(data: Record<string, unknown>, key: string, max = 128): string {
    const value = data[key];
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new BadRequestException(`AI 工具参数 ${key} 无效`);
    return value;
  }
  private serverIds(data: Record<string, unknown>, max: number) {
    if (
      !Array.isArray(data.serverIds) ||
      !data.serverIds.length ||
      data.serverIds.length > max ||
      data.serverIds.some((id) => typeof id !== 'string')
    )
      throw new BadRequestException(`AI 必须明确选择 1–${max} 台服务器`);
    return [...new Set(data.serverIds as string[])];
  }
  async prepare(
    action: string,
    data: Record<string, unknown>,
    user?: CurrentUser,
    context?: ResolvedAiContext,
  ): Promise<PreparedAiAction> {
    if (action === aiGraphAction) {
      if (!user) throw new ForbiddenException('请先登录');
      return this.graphActions().prepare(data, user, context);
    }
    if (action === 'execute_command' || action === 'inspect_servers') {
      const targets = await this.servers.snapshot(this.serverIds(data, 100));
      const command =
        action === 'inspect_servers'
          ? 'uname -srm; uptime; df -h /'
          : this.string(data, 'command', 65536);
      const name =
        action === 'inspect_servers'
          ? 'AI 只读服务器巡检'
          : typeof data.name === 'string'
            ? sanitizeAiText(data.name.slice(0, 120))
            : 'AI 命令';
      // Do not persist a secret pasted into a model-generated command as an actionable proposal.
      if (sanitizeAiText(command) !== command)
        throw new BadRequestException('AI 命令包含疑似明文凭据，请改用安全凭据引用');
      const input = plainToInstance(ExecuteCommandDto, {
        serverIds: targets.map((s) => s.id),
        command,
        name,
        confirmed: true,
        strategy: 'PARALLEL',
        maxParallel: 3,
        failurePolicy: 'CONTINUE',
        timeout: 300,
      });
      if ((await validate(input, { whitelist: true, forbidNonWhitelisted: true })).length)
        throw new BadRequestException('AI 命令参数无效');
      return {
        action,
        payload: { ...input },
        serverIds: targets.map((s) => s.id),
        bindingsHash: this.bindingHash(targets),
        preview: {
          command,
          targets: targets.map((s) => ({ id: s.id, name: s.name, host: s.host })),
          targetCount: targets.length,
        },
      };
    }
    if (action === 'initialize_component') {
      const serverIds = this.serverIds(data, 10);
      const plan = await this.deploymentTools.initialization(data.component, serverIds);
      const targets = await this.servers.snapshot(serverIds);
      return {
        action,
        payload: { component: data.component, serverIds, targetHash: plan.targetHash },
        serverIds,
        bindingsHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
        preview: {
          component: data.component,
          planId: plan.planId,
          version: plan.version,
          summary: plan.summary,
          steps: plan.steps,
          targets: targets.map(({ id, name, host }) => ({ id, name, host })),
        },
      };
    }
    if (action === 'publish_source_branch' || action === 'open_pull_request') {
      const prepared = await this.sourceChange.prepare(
        data,
        action === 'publish_source_branch' ? 'BRANCH' : 'PULL_REQUEST',
        user?.id,
      );
      return { action, ...prepared, serverIds: [] };
    }
    if (action === 'run_pipeline') {
      const pipelineId = this.string(data, 'pipelineId');
      const input = {
        environmentId: this.string(data, 'environmentId'),
        ...(data.targetId === undefined ? {} : { targetId: this.string(data, 'targetId') }),
        commitSha: this.string(data, 'commitSha'),
        confirmed: true,
        ...(data.mode === undefined ? {} : { mode: data.mode }),
        ...(data.version === undefined ? {} : { version: data.version }),
      };
      if (
        input.version !== undefined &&
        (!Number.isSafeInteger(input.version) || Number(input.version) < 1)
      )
        throw new BadRequestException('Pipeline 版本无效');
      if (input.mode !== undefined && input.mode !== 'BUILD_ONLY' && input.mode !== 'DEPLOY')
        throw new BadRequestException('Pipeline 执行模式无效');
      const pipelines = await this.pipelines();
      const preview = await pipelines.preview(
        pipelineId,
        input as Parameters<typeof pipelines.preview>[1],
      );
      const targets = await this.servers.snapshot(preview.serverIds);
      return {
        action,
        payload: {
          pipelineId,
          ...input,
          mode: preview.mode,
          version: preview.version,
          expectedServerIds: preview.serverIds,
          expectedConfigurationHash: preview.configurationHash,
        },
        serverIds: preview.serverIds,
        projectId: preview.projectId,
        repositoryId: preview.definition.repositoryId,
        sourceRepositoryIds: preview.nodeSources?.map(({ repositoryId }) => repositoryId),
        aiApprovalHash: preview.aiApprovalHash,
        bindingsHash: createHash('sha256')
          .update(this.bindingHash(targets) + ':' + preview.aiApprovalHash)
          .digest('hex'),
        preview: { ...preview, definition: aiPipelineDefinition(preview.definition) },
      };
    }
    throw new BadRequestException('AI 工具未注册');
  }
  private bindingHash(
    targets: {
      id: string;
      host: string;
      port: number;
      username: string;
      credentialId: string | null;
      hostKeyFingerprint: string | null;
      credentialNonce?: string;
    }[],
  ) {
    return createHash('sha256')
      .update(
        JSON.stringify(
          targets
            .map((s) => ({
              id: s.id,
              host: s.host,
              port: s.port,
              username: s.username,
              credentialId: s.credentialId,
              fingerprint: s.hostKeyFingerprint,
              credentialNonce: s.credentialNonce,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      )
      .digest('hex');
  }
  async execute(
    prepared: PreparedAiAction,
    user: CurrentUser,
    repair?: import('../tasks/tasks.types').AiRepairOrigin,
  ) {
    if (prepared.action === 'initialize_component')
      return this.deploymentTools.initialize(
        prepared.payload.component as InitializationComponent,
        String(prepared.payload.targetHash),
        prepared.serverIds,
        user.id,
        repair,
      );
    if (prepared.action === 'publish_source_branch' || prepared.action === 'open_pull_request') {
      const sourceChange = await this.sourceChange.execute(
        prepared.action === 'publish_source_branch' ? 'BRANCH' : 'PULL_REQUEST',
        prepared.payload,
        prepared.bindingsHash,
        user.id,
      );
      return { sourceChange };
    }
    if (prepared.action === 'run_pipeline' || prepared.action === aiGraphAction)
      throw new BadRequestException('仅可通过已发布执行流提案的人工确认启动交付');
    return this.commands.execute(plainToInstance(ExecuteCommandDto, prepared.payload), user.id);
  }
  async continuation(taskIds: string[], projectId: string | undefined, user: CurrentUser) {
    if (!taskIds.length) return [];
    const policies = await this.policy.projectSnapshots();
    const results = await Promise.all(
      taskIds.map(async (id) => {
        const task = await this.tasks.get(id);
        if (
          (projectId && task.projectId && projectId !== task.projectId) ||
          (!task.projectId && task.createdBy !== user.id && user.role !== 'ADMIN')
        )
          throw new ForbiddenException('对话中的任务不在当前授权范围');
        const scope = task.projectId ?? projectId;
        const targets = await this.tasks.targets(id);
        this.policy.assertRead(
          'get_task',
          policies(scope),
          scope,
          targets.map((target) => target.serverId ?? 'deleted'),
        );
        return { taskId: id, status: task.status };
      }),
    );
    return results;
  }
  private canReadProject(action: string, projectId: string, policy: AiPolicySnapshot) {
    return (
      this.policy.allowedProject(projectId, policy) &&
      this.policy.scopes(policy).every((scope) => !scope.deniedActions?.includes(action))
    );
  }
  async read(
    name: string,
    data: Record<string, unknown>,
    snapshot: AiPolicySnapshot,
    projectId?: string,
    user?: CurrentUser,
    context?: ResolvedAiContext,
  ) {
    this.policy.assertRead(name, snapshot, projectId);
    switch (name) {
      case 'list_execution_flows': {
        const id = this.string(data, 'projectId');
        if (projectId && id !== projectId) throw new ForbiddenException('项目与当前对话项目不一致');
        return this.graphActions().list(id, context);
      }
      case 'list_servers':
        return (await this.servers.list())
          .filter((s) => this.policy.allowedServer(s.id, snapshot))
          .map((s) => ({ id: s.id, name: s.name, host: s.host, status: s.status, tags: s.tags }));
      case 'list_projects': {
        const policies = projectId ? () => snapshot : await this.policy.projectSnapshots();
        return (await this.projects.list()).filter(
          (p) =>
            (!projectId || p.id === projectId) && this.canReadProject(name, p.id, policies(p.id)),
        );
      }
      case 'list_tasks': {
        const policies = projectId ? () => snapshot : await this.policy.projectSnapshots();
        const tasks = (await this.tasks.list()).filter((task) =>
          task.projectId
            ? (!projectId || projectId === task.projectId) &&
              this.canReadProject(name, task.projectId, policies(task.projectId))
            : !projectId && (user?.role === 'ADMIN' || task.createdBy === user?.id),
        );
        const rows = await Promise.all(
          tasks.map(async (task) => ({ task, targets: await this.tasks.targets(task.id) })),
        );
        return rows
          .filter((r) =>
            r.targets.every(
              (t) =>
                t.serverId &&
                this.policy.allowedServer(t.serverId, policies(r.task.projectId ?? undefined)),
            ),
          )
          .map((r) => aiTaskSummary(r.task));
      }
      case 'get_task':
      case 'diagnose_deployment': {
        const id = this.string(data, 'taskId');
        let task = await this.tasks.get(id);
        if (
          (projectId && task.projectId && projectId !== task.projectId) ||
          (!task.projectId && task.createdBy !== user?.id && (projectId || user?.role !== 'ADMIN'))
        )
          throw new ForbiddenException('任务不属于当前对话项目');
        let targets = await this.tasks.targets(id);
        this.policy.assertRead(
          name,
          task.projectId && task.projectId !== projectId
            ? await this.policy.snapshot(task.projectId)
            : snapshot,
          task.projectId ?? projectId,
          targets.map((t) => t.serverId || 'deleted'),
        );
        if (name === 'diagnose_deployment') return this.deploymentTools.diagnose(id, task.status);
        if (data.waitSeconds !== undefined) {
          const seconds = Number(data.waitSeconds);
          if (!Number.isInteger(seconds) || seconds < 1 || seconds > 10)
            throw new BadRequestException('等待时长必须在 1–10 秒之间');
          const until = Date.now() + seconds * 1000;
          while (!isTerminalStatus(task.status) && Date.now() < until) {
            await sleep(500);
            task = await this.tasks.get(id);
          }
          targets = await this.tasks.targets(id);
        }
        return {
          task: aiTaskSummary(task),
          targets: targets.map(({ serverId, status, exitCode, startedAt, finishedAt }) => ({
            serverId,
            status,
            exitCode,
            startedAt,
            finishedAt,
          })),
        };
      }
      case 'inspect_servers': {
        const serverIds = this.serverIds(data, 10);
        this.policy.assertRead(name, snapshot, projectId, serverIds);
        return this.deploymentTools.inspect(await this.servers.snapshot(serverIds));
      }
      case 'get_project': {
        const id = this.string(data, 'projectId');
        if (projectId && id !== projectId) throw new ForbiddenException('项目与当前对话项目不一致');
        const actual = projectId ? snapshot : await this.policy.snapshot(id);
        this.policy.assertRead(name, actual, id);
        const project = await this.projects.get(id);
        return {
          ...project,
          repositories: project.repositories
            .filter(
              (r) =>
                (!context?.repositoryId || r.id === context.repositoryId) &&
                this.policy.allowedRepository(r.id, actual),
            )
            .map(({ id, name, provider, defaultBranch, description }) => ({
              id,
              name,
              provider,
              defaultBranch,
              description,
            })),
          services: project.services.filter(
            (s) => !context?.serviceId || s.id === context.serviceId,
          ),
        };
      }
      case 'query_pipeline': {
        const service = await this.pipelines();
        if (data.pipelineId) {
          const result = await service.get(this.string(data, 'pipelineId'));
          if (projectId && result.projectId !== projectId)
            throw new ForbiddenException('Pipeline 不属于当前对话项目');
          assertAiPipelineScope(context, result);
          const actual = projectId ? snapshot : await this.policy.snapshot(result.projectId);
          this.policy.assertRead(name, actual, result.projectId);
          for (const id of pipelineSourceRepositories(result.definition))
            this.policy.assertRepository(id, actual);
          return { ...result, definition: aiPipelineDefinition(result.definition) };
        }
        const policies = projectId ? () => snapshot : await this.policy.projectSnapshots();
        return (await service.list(projectId, context?.serviceId))
          .filter(
            (p) =>
              (!projectId || p.projectId === projectId) &&
              (!context?.serviceId || p.serviceId === context.serviceId) &&
              this.canReadProject(name, p.projectId, policies(p.projectId)) &&
              pipelineSourceRepositories(p.definition).every((id) =>
                this.policy.allowedRepository(id, policies(p.projectId)),
              ),
          )
          .map((pipeline) => ({
            ...pipeline,
            definition: aiPipelineDefinition(pipeline.definition),
          }));
      }
      case 'analyze_repository_deployment': {
        if (!user || user.role === 'VIEWER')
          throw new ForbiddenException('当前角色无权发起仓库内容分析');
        const requested = projectId ?? this.string(data, 'projectId');
        if (data.projectId !== undefined && data.projectId !== requested)
          throw new ForbiddenException('仓库项目与当前对话项目不一致');
        const input = plainToInstance(AiRepositoryAnalysisDto, { ...data, projectId: requested });
        if ((await validate(input, { whitelist: true, forbidNonWhitelisted: true })).length)
          throw new BadRequestException('仓库分析参数无效');
        return this.repositoryAnalysis.analyze(input, user.id);
      }
      case 'draft_source_change': {
        const requested = this.string(data, 'projectId');
        if (projectId && requested !== projectId)
          throw new ForbiddenException('仓库不属于当前对话项目');
        const actual = projectId ? snapshot : await this.policy.snapshot(requested);
        this.policy.assertRead(name, actual, requested);
        this.policy.assertRepository(this.string(data, 'repositoryId'), actual);
        return this.sourceChange.suggest(data);
      }
      case 'get_operation_plan': {
        if (context?.input.kind !== 'OPERATION_PLAN' || !context.input.operationPlanId)
          throw new ForbiddenException('请先在页面选择需要读取的运维方案');
        const plans = this.moduleRef.get(OperationPlansService, { strict: false });
        const versions = await plans.versions(context.input.operationPlanId);
        const plan =
          context.input.version == null
            ? versions[0]
            : versions.find(({ version }) => version === context.input.version);
        if (!plan) throw new BadRequestException('运维方案版本不存在');
        return {
          name: plan.name,
          version: plan.version,
          category: plan.category,
          steps: plan.steps.map(({ name, timeout }) => ({ name, timeout })),
          chain: {
            nodes: plan.chain.nodes.map(({ id, type, name, timeout, fact }) => ({
              id,
              type,
              name,
              timeout,
              fact,
            })),
            edges: plan.chain.edges,
          },
        };
      }
      case 'draft_pipeline':
      case 'draft_operation_plan': {
        const definition = this.parse(this.string(data, 'definition', 65536));
        if (name === 'draft_pipeline' && (context || projectId)) {
          pinAiContextField(definition, 'projectId', projectId);
          pinAiContextField(definition, 'serviceId', context?.serviceId);
          const config = definition.definition;
          if (!config || typeof config !== 'object' || Array.isArray(config))
            throw new BadRequestException('流水线草稿缺少构建配置');
          const settings = config as Record<string, unknown>;
          pinAiContextField(settings, 'repositoryId', context?.repositoryId);
          const repositoryId = this.string(settings, 'repositoryId');
          const serviceId = this.string(definition, 'serviceId');
          const project = await this.projects.get(this.string(definition, 'projectId'));
          if (
            !project.services.some(({ id }) => id === serviceId) ||
            !project.repositories.some(({ id }) => id === repositoryId)
          )
            throw new ForbiddenException('流水线草稿的服务或仓库不属于当前项目');
          this.policy.assertRepository(repositoryId, snapshot);
          if (Array.isArray(settings.nodes)) {
            for (const node of settings.nodes) {
              if (!node || typeof node !== 'object' || !('repositoryId' in node)) continue;
              const sourceId = this.string(node, 'repositoryId');
              if (!project.repositories.some(({ id }) => id === sourceId))
                throw new ForbiddenException('源码节点的仓库不属于当前项目');
              this.policy.assertRepository(sourceId, snapshot);
            }
          }
        }
        return {
          type: name === 'draft_pipeline' ? 'PIPELINE' : 'OPERATION_PLAN',
          definition,
          draftOnly: true,
        };
      }
      default:
        throw new BadRequestException('AI 工具未注册');
    }
  }
}
