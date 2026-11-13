import { BadRequestException, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ServersService } from '../servers/servers.service';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from '../tasks/tasks.service';
import { CommandCenterService } from '../command-center/command-center.service';
import { ExecuteCommandDto } from '../command-center/command.dto';
import { AiPolicyService, AiPolicySnapshot } from './ai-policy.service';
import { CurrentUser } from '../auth/auth.decorators';
import { sanitizeAiText } from '../../infrastructure/ai-provider/openai-compatible.service';
import { createHash } from 'node:crypto';

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
  tool('get_task', '读取任务状态和每目标结果，不读取日志', { taskId: str }, ['taskId']),
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
  tool(
    'inspect_servers',
    '对明确的服务器运行固定只读检查：uname、uptime、df。不允许自定义命令',
    { serverIds: ids },
    ['serverIds'],
  ),
  tool(
    'execute_command',
    '申请在明确服务器执行Shell命令。写操作必须遵守权限策略并等待提案确认',
    { serverIds: ids, command: str, name: str },
    ['serverIds', 'command'],
  ),
  tool(
    'run_pipeline',
    '申请执行指定Pipeline版本、环境、部署目标和固定Commit。需要用户确认',
    {
      pipelineId: str,
      environmentId: str,
      targetId: str,
      commitSha: str,
      version: { type: 'integer', minimum: 1 },
    },
    ['pipelineId', 'environmentId', 'targetId', 'commitSha'],
  ),
];
export type PreparedAiAction = {
  action: 'execute_command' | 'inspect_servers' | 'run_pipeline';
  payload: Record<string, unknown>;
  serverIds: string[];
  projectId?: string;
  preview: Record<string, unknown>;
  bindingsHash: string;
};
export function isActionTool(name: string) {
  return ['execute_command', 'inspect_servers', 'run_pipeline'].includes(name);
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
  ) {}
  private async pipelines() {
    const { PipelinesService } = await import('../pipelines/pipelines.service.js');
    return this.moduleRef.get(PipelinesService, { strict: false });
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
  async prepare(action: string, data: Record<string, unknown>): Promise<PreparedAiAction> {
    if (action === 'execute_command' || action === 'inspect_servers') {
      if (
        !Array.isArray(data.serverIds) ||
        !data.serverIds.length ||
        data.serverIds.length > 100 ||
        data.serverIds.some((id) => typeof id !== 'string')
      )
        throw new BadRequestException('AI 必须明确选择 1–100 台服务器');
      const targets = await this.servers.snapshot(data.serverIds as string[]);
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
    if (action === 'run_pipeline') {
      const pipelineId = this.string(data, 'pipelineId');
      const input = {
        environmentId: this.string(data, 'environmentId'),
        targetId: this.string(data, 'targetId'),
        commitSha: this.string(data, 'commitSha'),
        confirmed: true,
        ...(data.version === undefined ? {} : { version: data.version }),
      };
      if (
        input.version !== undefined &&
        (!Number.isSafeInteger(input.version) || Number(input.version) < 1)
      )
        throw new BadRequestException('Pipeline 版本无效');
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
          version: preview.version,
          expectedServerIds: preview.serverIds,
          expectedConfigurationHash: preview.configurationHash,
        },
        serverIds: preview.serverIds,
        projectId: preview.projectId,
        bindingsHash: createHash('sha256')
          .update(this.bindingHash(targets) + ':' + preview.configurationHash)
          .digest('hex'),
        preview: { ...preview },
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
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      )
      .digest('hex');
  }
  async execute(prepared: PreparedAiAction, user: CurrentUser) {
    if (prepared.action === 'run_pipeline') {
      const { pipelineId, ...input } = prepared.payload;
      const pipelines = await this.pipelines();
      return pipelines.run(
        String(pipelineId),
        input as unknown as Parameters<typeof pipelines.run>[1],
        user.id,
      );
    }
    return this.commands.execute(plainToInstance(ExecuteCommandDto, prepared.payload), user.id);
  }
  async read(
    name: string,
    data: Record<string, unknown>,
    snapshot: AiPolicySnapshot,
    projectId?: string,
  ) {
    this.policy.assertRead(name, snapshot, projectId);
    switch (name) {
      case 'list_servers':
        return (await this.servers.list())
          .filter((s) => this.policy.allowedServer(s.id, snapshot))
          .map((s) => ({ id: s.id, name: s.name, host: s.host, status: s.status, tags: s.tags }));
      case 'list_projects':
        return (await this.projects.list()).filter((p) =>
          this.policy.allowedProject(p.id, snapshot),
        );
      case 'list_tasks': {
        const tasks = await this.tasks.list();
        const rows = await Promise.all(
          tasks.map(async (task) => ({ task, targets: await this.tasks.targets(task.id) })),
        );
        return rows
          .filter((r) =>
            r.targets.every((t) => t.serverId && this.policy.allowedServer(t.serverId, snapshot)),
          )
          .map((r) => r.task);
      }
      case 'get_task': {
        const id = this.string(data, 'taskId');
        const targets = await this.tasks.targets(id);
        this.policy.assertRead(
          name,
          snapshot,
          projectId,
          targets.map((t) => t.serverId || 'deleted'),
        );
        return { task: await this.tasks.get(id), targets };
      }
      case 'get_project': {
        const id = this.string(data, 'projectId');
        this.policy.assertRead(name, snapshot, id);
        return this.projects.get(id);
      }
      case 'query_pipeline': {
        const service = await this.pipelines();
        if (data.pipelineId) {
          const result = await service.get(this.string(data, 'pipelineId'));
          this.policy.assertRead(name, snapshot, result.projectId);
          return result;
        }
        return (await service.list()).filter((p) =>
          this.policy.allowedProject(p.projectId, snapshot),
        );
      }
      case 'draft_pipeline':
      case 'draft_operation_plan': {
        const definition = this.parse(this.string(data, 'definition', 65536));
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
