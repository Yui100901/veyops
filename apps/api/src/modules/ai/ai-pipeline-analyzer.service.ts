import { Injectable } from '@nestjs/common';
import {
  OpenAiCompatibleService,
  sanitizeAiText,
} from '../../infrastructure/ai-provider/openai-compatible.service';
import { AiProvidersService } from './ai-providers.service';

const phases = [
  'PREPARE',
  'CHECKOUT',
  'ENVIRONMENT',
  'INSTALL',
  'BUILD',
  'TEST',
  'SHELL',
  'MANAGER_BUILD',
  'PACKAGE',
  'ARTIFACT',
  'IMAGE',
  'TRANSFER',
  'DEPLOY',
  'START',
  'HEALTH_CHECK',
  'CLEANUP',
  'UNKNOWN',
] as const;
type Phase = (typeof phases)[number];
const allowedPhases = new Set<string>(phases);
const failedStatuses = new Set(['FAILED', 'PARTIAL_FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION']);
const terminalStatuses = new Set(['SUCCESS', 'CANCELLED', ...failedStatuses]);
const maximumSteps = 32;
const maximumSeconds = 15;

export interface AiPipelineAnalysisInput {
  status: string;
  mode?: 'BUILD_ONLY' | 'DEPLOY';
  targetCounts: { total: number; succeeded: number; failed: number };
  steps: Array<{ phase: string; status: string; exitCode?: number | null }>;
}

export interface AiPipelineAnalysis {
  summary: string;
  failedPhase: Phase | null;
  nextActions: string[];
}

function boundedInteger(value: number, maximum: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.trunc(value), maximum)) : 0;
}

function safePhase(phase: string): Phase {
  const base =
    typeof phase === 'string' ? /^([A-Z_]{1,24})(?::[1-9]\d{0,3})?$/.exec(phase)?.[1] : undefined;
  return base && allowedPhases.has(base) ? (base as Phase) : 'UNKNOWN';
}

function analysisMetadata(input: AiPipelineAnalysisInput) {
  const total = boundedInteger(input.targetCounts.total, 1000);
  const succeeded = boundedInteger(input.targetCounts.succeeded, total);
  const failed = boundedInteger(input.targetCounts.failed, total - succeeded);
  // Explicitly select fixed fields. In particular, never forward a task, error, or step object.
  const steps = input.steps.slice(0, 5000).map(({ phase, status, exitCode }) => ({
    phase: safePhase(phase),
    status: terminalStatuses.has(status) ? status : 'UNKNOWN',
    exitCode:
      typeof exitCode === 'number' &&
      Number.isSafeInteger(exitCode) &&
      exitCode >= 0 &&
      exitCode <= 255
        ? exitCode
        : null,
  }));
  const failedSteps = steps.filter((step) => failedStatuses.has(step.status));
  const others = steps.filter((step) => !failedStatuses.has(step.status));
  return {
    status: input.status,
    mode: input.mode === 'DEPLOY' ? 'DEPLOY' : 'BUILD_ONLY',
    targetCounts: { total, succeeded, failed },
    steps: [...failedSteps, ...others].slice(0, maximumSteps),
    omittedSteps: Math.max(0, input.steps.length - maximumSteps),
  };
}

function boundedText(value: unknown, key: string, limit: number) {
  if (typeof value !== 'string') return '';
  return sanitizeAiText(value, [key]).replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function parseAnalysis(
  content: string,
  metadata: ReturnType<typeof analysisMetadata>,
  key: string,
): AiPipelineAnalysis | null {
  const body = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
  const result: unknown = JSON.parse(body);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const { summary, failedPhase, nextActions } = result as Record<string, unknown>;
  const safeSummary = boundedText(summary, key, 600);
  if (
    !safeSummary ||
    !Array.isArray(nextActions) ||
    nextActions.some((action) => typeof action !== 'string')
  )
    return null;
  if (
    failedPhase !== null &&
    (typeof failedPhase !== 'string' ||
      failedPhase === 'UNKNOWN' ||
      !failedStatuses.has(metadata.status) ||
      !metadata.steps.some((step) => step.phase === failedPhase && failedStatuses.has(step.status)))
  )
    return null;
  return {
    summary: safeSummary,
    failedPhase: failedPhase as Phase | null,
    nextActions: nextActions
      .slice(0, 4)
      .map((action) => boundedText(action, key, 180))
      .filter(Boolean),
  };
}

const systemPrompt = [
  '你是构建任务摘要助手。仅根据收到的结果、目标计数、阶段状态与退出码，使用中文概括结果。',
  '这些字段由系统生成。没有源码、日志、目标详情或配置，未知原因应明确标为未知。',
  '建议只读诊断方向，不要生成命令、调用工具或要求提供凭据。',
  '只返回 JSON 对象，包含 summary 字符串、failedPhase 字段与 nextActions 字符串数组，建议最多四项。',
  'failedPhase 使用 steps 中实际失败的阶段键，若没有明确阶段则为 null。',
].join('\n');

@Injectable()
export class AiPipelineAnalyzer {
  constructor(
    private readonly providers: AiProvidersService,
    private readonly wire: OpenAiCompatibleService,
  ) {}

  isEnabled() {
    return process.env.AI_PIPELINE_ANALYSIS === 'true';
  }

  async analyze(input: AiPipelineAnalysisInput, signal?: AbortSignal) {
    return this.isEnabled() ? this.request(input, signal) : null;
  }

  async analyzeFailure(input: AiPipelineAnalysisInput, codes: string[], signal?: AbortSignal) {
    const allowed = [
      'MISSING_TOOL',
      'MISSING_LIBRARY',
      'IMAGE_PULL',
      'DOWNLOAD',
      'PACKAGE_BUSY',
      'PORT_OCCUPIED',
      'TIMEOUT',
      'STATE_UNCERTAIN',
    ];
    return this.request(input, signal, [
      ...new Set(codes.filter((code) => allowed.includes(code))),
    ]);
  }

  private async request(
    input: AiPipelineAnalysisInput,
    signal?: AbortSignal,
    findings?: string[],
  ): Promise<AiPipelineAnalysis | null> {
    if (signal?.aborted || !terminalStatuses.has(input.status)) return null;
    try {
      const metadata = analysisMetadata(input);
      const connection = await this.providers.resolve(undefined, 'diagnosis');
      if (signal?.aborted) return null;
      const response = await this.wire.complete(
        { ...connection, timeoutSeconds: Math.min(connection.timeoutSeconds, maximumSeconds) },
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify({ ...metadata, ...(findings && { findings }) }) },
        ],
        [],
        { signal, maxTokens: 800, maxResponseBytes: 32 * 1024 },
      );
      if (signal?.aborted || response.tool_calls?.length || !response.content) return null;
      return parseAnalysis(response.content, metadata, connection.apiKey);
    } catch {
      // Model/credential/transport failures must be independent of the completed build.
      return null;
    }
  }
}
