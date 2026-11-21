import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { AiContextDto, AiContextKind } from './ai.dto';

type ContextField = Exclude<keyof AiContextDto, 'kind'>;
const contextFields: Record<AiContextKind, ContextField[]> = {
  REPOSITORY: ['repositoryId', 'commitSha', 'serviceId'],
  SERVICE: ['serviceId'],
  PIPELINE: ['pipelineId'],
  TASK: ['taskId'],
  OPERATION_PLAN: ['operationPlanId', 'version'],
};

export interface ResolvedAiContext {
  input: AiContextDto;
  projectId?: string;
  serviceId?: string;
  repositoryId?: string;
  sourceRepositoryIds?: string[];
  serverIds?: string[];
}

export function normalizeAiContext(input: AiContextDto): AiContextDto {
  const fields = contextFields[input.kind];
  if (
    !fields ||
    Object.entries(input).some(
      ([key, value]) => key !== 'kind' && value != null && !fields.includes(key as ContextField),
    ) ||
    (input.kind !== 'OPERATION_PLAN' && !input[fields[0]]) ||
    (input.version != null &&
      (!input.operationPlanId || !Number.isSafeInteger(input.version) || input.version < 1))
  )
    throw new BadRequestException('AI 页面上下文参数无效');
  return {
    kind: input.kind,
    ...Object.fromEntries(
      fields.flatMap((key) => {
        const value = input[key];
        return value ? [[key, typeof value === 'string' ? value.toLowerCase() : value]] : [];
      }),
    ),
  };
}

const contextualTools: Record<AiContextKind, string[]> = {
  REPOSITORY: [
    'list_projects',
    'get_project',
    'analyze_repository_deployment',
    'draft_source_change',
    'draft_pipeline',
  ],
  SERVICE: [
    'list_projects',
    'get_project',
    'list_execution_flows',
    'run_execution_flow',
    'query_pipeline',
    'analyze_repository_deployment',
    'draft_pipeline',
    'run_pipeline',
  ],
  PIPELINE: [
    'list_projects',
    'get_project',
    'query_pipeline',
    'analyze_repository_deployment',
    'draft_pipeline',
    'run_pipeline',
  ],
  TASK: ['get_task', 'diagnose_deployment'],
  OPERATION_PLAN: ['get_operation_plan', 'draft_operation_plan'],
};

export function aiContextAllows(kind: AiContextKind, tool: string) {
  return contextualTools[kind].includes(tool);
}

export function pinAiContextField(
  values: Record<string, unknown>,
  field: string,
  expected?: string,
) {
  if (!expected) return;
  const value = values[field];
  if (value !== undefined && (typeof value !== 'string' || value.toLowerCase() !== expected))
    throw new ForbiddenException('AI 操作与当前页面的资源不一致');
  values[field] = expected;
}

export function scopeAiToolArguments(
  context: ResolvedAiContext | undefined,
  name: string,
  args: Record<string, unknown>,
) {
  if (!context) return args;
  const { input } = context;
  if (!aiContextAllows(input.kind, name)) throw new ForbiddenException('AI 操作超出当前页面的范围');
  const scoped = { ...args };
  if (name === 'get_project' || name === 'list_execution_flows' || name === 'run_execution_flow')
    pinAiContextField(scoped, 'projectId', context.projectId);
  if (name === 'get_task' || name === 'diagnose_deployment')
    pinAiContextField(scoped, 'taskId', input.taskId);
  if (name === 'query_pipeline' || name === 'run_pipeline')
    pinAiContextField(scoped, 'pipelineId', input.pipelineId);
  if (name === 'get_operation_plan')
    pinAiContextField(scoped, 'operationPlanId', input.operationPlanId);
  if (name === 'analyze_repository_deployment' || name === 'draft_source_change') {
    pinAiContextField(scoped, 'projectId', context.projectId);
    pinAiContextField(scoped, 'repositoryId', context.repositoryId);
    if (name === 'analyze_repository_deployment')
      pinAiContextField(scoped, 'serviceId', context.serviceId);
    pinAiContextField(
      scoped,
      name === 'draft_source_change' ? 'baseCommit' : 'commitSha',
      input.commitSha,
    );
  }
  return scoped;
}

export function assertAiPipelineScope(
  context: ResolvedAiContext | undefined,
  pipeline: { projectId?: unknown; serviceId?: unknown },
) {
  if (
    (context?.projectId && pipeline.projectId !== context.projectId) ||
    (context?.serviceId && pipeline.serviceId !== context.serviceId)
  )
    throw new ForbiddenException('流水线不属于当前页面的项目或服务');
}
