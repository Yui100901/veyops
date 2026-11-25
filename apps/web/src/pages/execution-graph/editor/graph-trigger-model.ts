import type { GraphIssueLocation } from '../../../api';
import { graphCanvasNodeModel } from '../execution-graph-definition';
import type { GraphDocument, GraphField } from '../execution-graph-definition';
import { simplifiedModel } from '../simplified-flow';
import type { SimplifiedSource } from '../simplified-flow';

export const triggerChoices = {
  RUN: '定时构建',
  POLL: '仓库有更新时构建',
  WEBHOOK: 'Git 推送 Webhook',
  UPSTREAM: '上游执行流完成后运行',
  API: '认证 API',
} as const;

export const eventFields = {
  repository: '仓库',
  commit: '实际提交 SHA',
  ref: 'Git 引用',
  eventId: '事件 ID',
  scheduledAt: '计划触发时间',
  upstreamRunId: '上游运行 ID',
  upstreamStatus: '上游状态',
} as const;

export type TriggerChoice = keyof typeof triggerChoices;
export type EventField = keyof typeof eventFields;
export type ParameterMapping =
  | { source: 'EVENT'; field: EventField }
  | { source: 'VALUE'; value: unknown }
  | { source: 'UPSTREAM_OUTPUT'; fieldId: string };

export interface TriggerConfig {
  name: string;
  kind: 'CRON' | 'WEBHOOK' | 'API' | 'UPSTREAM';
  flowId: string;
  enabled: boolean;
  version?: number | null;
  parameterMappings?: Record<string, ParameterMapping>;
  sourceId?: string | null;
  repositoryId?: string | null;
  ref?: string | null;
  refPrefix?: string | null;
  cron?: string | null;
  timeZone?: string | null;
  cronMode?: 'RUN' | 'POLL';
  buildOnFirstObservation?: boolean;
  webhookProtocol?: 'GITEA' | 'BEARER' | 'SIGNED';
  credentialId?: string | null;
  inputValue?: string | null;
  upstreamFlowId?: string | null;
  upstreamStatus?: 'SUCCESS' | 'FAILED' | 'ANY' | null;
}

export interface TriggerRule extends TriggerConfig {
  id: string;
  nextAt: number | null;
  receivePath?: string;
  testReceivePath?: string;
  secret?: string;
  resolvedRepositoryId?: string;
  resolvedRef?: string;
  observation?: { commitSha?: string | null; lastCheckedAt?: number; error?: string | null } | null;
}

export interface TriggerEvent {
  id: string;
  eventId: string;
  status: string;
  source?: string;
  runId?: string | null;
  runStatus?: string | null;
  error?: string | null;
  createdAt: number;
  finishedAt?: number | null;
  version?: number | null;
  ruleRevision?: string;
  repositoryId?: string | null;
  ref?: string | null;
  commitSha?: string | null;
  previousCommitSha?: string | null;
  scheduledAt?: number | null;
  upstreamRunId?: string | null;
  upstreamStatus?: string | null;
  metadata?: {
    eventSource?: string;
    repositoryId?: string;
    ref?: string;
    commitSha?: string;
    previousCommitSha?: string;
    scheduledAt?: number;
    checkedAt?: number;
    upstreamRunId?: string;
    upstreamStatus?: string;
  };
}

export interface TriggerPreflight {
  eligible: boolean;
  version: number | null;
  nextTimes: number[];
  timeZone?: string;
  issue?: TriggerPreflightIssue;
  checkout?: { repositoryId: string; ref: string; nodeId: string };
}

export interface TriggerPreflightIssue extends GraphIssueLocation {
  message: string;
  flowId?: string;
  nodeId?: string;
  fieldId?: string;
}

export interface TriggerFlow {
  id: string;
  name: string;
  inputs: GraphField[];
  outputs: GraphField[];
  sources?: SimplifiedSource[];
  useUpstreamArtifact?: boolean;
}

export function triggerChoice(rule: TriggerConfig): TriggerChoice {
  return rule.kind === 'CRON' ? (rule.cronMode ?? 'RUN') : rule.kind;
}

export function triggerFlows(definition: GraphDocument['draft']): TriggerFlow[] {
  const { canvas } = definition;
  if (!canvas)
    return definition.flows.map(({ id, name, model, nodes }) => {
      const start = nodes.find(({ type }) => type === 'START');
      return {
        id,
        name,
        inputs: start?.inputs ?? [],
        outputs: nodes.find(({ type }) => type === 'END')?.outputs ?? [],
        ...(model === simplifiedModel && {
          sources: start?.start?.sources ?? [],
          useUpstreamArtifact: start?.start?.release?.useUpstreamArtifact,
        }),
      };
    });
  const nodes = new Map(canvas.nodes.map((node) => [node.id, node]));
  const ends = new Map(canvas.endpoints.map(({ startId, endId }) => [startId, endId]));
  return canvas.nodes.flatMap((start) => {
    if (start.type !== 'START') return [];
    const endId = ends.get(start.id);
    return [
      {
        id: start.id,
        name: start.name,
        inputs: start.inputs ?? [],
        outputs: (endId ? nodes.get(endId)?.outputs : undefined) ?? [],
        ...(graphCanvasNodeModel(canvas, start) === simplifiedModel && {
          sources: start.start?.sources ?? [],
          useUpstreamArtifact: start.start?.release?.useUpstreamArtifact,
        }),
      },
    ];
  });
}

export function triggerDate(value: number, timeZone?: string) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: timeZone || undefined,
    }).format(value);
  } catch {
    return String(value);
  }
}

export function triggerRequest(config: TriggerConfig, enabled: boolean, version?: number | null) {
  const choice = triggerChoice(config);
  const hasSource = choice === 'POLL' || choice === 'WEBHOOK' || choice === 'API';
  return {
    name: config.name.trim(),
    kind: config.kind,
    flowId: config.flowId,
    enabled,
    ...(version && { version }),
    parameterMappings: config.parameterMappings ?? {},
    ...(config.inputValue && { inputValue: config.inputValue }),
    ...(config.kind === 'CRON' && {
      cronMode: choice,
      cron: config.cron?.trim(),
      timeZone: config.timeZone?.trim() || undefined,
      ...(choice === 'POLL' && {
        buildOnFirstObservation: Boolean(config.buildOnFirstObservation),
      }),
    }),
    ...(hasSource && {
      ...(config.sourceId && choice !== 'API'
        ? { sourceId: config.sourceId }
        : {
            repositoryId: config.repositoryId || undefined,
            ref: config.ref?.trim() || undefined,
            refPrefix: config.refPrefix?.trim() || undefined,
          }),
    }),
    ...(config.kind === 'WEBHOOK' && {
      webhookProtocol: config.webhookProtocol ?? 'SIGNED',
      credentialId:
        config.webhookProtocol === 'SIGNED' ? config.credentialId || undefined : undefined,
    }),
    ...(config.kind === 'UPSTREAM' && {
      upstreamFlowId: config.upstreamFlowId || undefined,
      upstreamStatus: config.upstreamStatus ?? 'SUCCESS',
    }),
  };
}

export function triggerSourceName(
  project: { repositories: { id: string; name: string }[] },
  id?: string | null,
) {
  return (
    id && (project.repositories.find(({ id: repositoryId }) => repositoryId === id)?.name ?? id)
  );
}
