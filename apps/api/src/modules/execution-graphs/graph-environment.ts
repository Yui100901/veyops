import { BadRequestException } from '@nestjs/common';
import { posix } from 'node:path';
import { parseEnv } from 'node:util';
import { executionVariableName } from '../../infrastructure/execution-variables';
import { relativePath } from '../pipelines/pipeline.validation';

export const graphEnvironmentMaxBytes = 64 * 1024;

export interface GraphEnvironmentSource {
  repositoryId?: string;
  commitSha?: string;
  branch?: string;
  tag?: string;
}

export interface GraphEnvironmentFilePin extends GraphEnvironmentSource {
  repositoryId: string;
  commitSha: string;
  path: string;
}

export type GraphEnvironmentFileSource = 'NODE' | 'ENVIRONMENT' | 'CONVENTION';

export interface GraphVariableSource {
  key: string;
  source: 'FILE' | 'PROJECT' | 'ENVIRONMENT' | 'SERVICE_ENVIRONMENT' | 'NODE' | 'SYSTEM';
  isSecret: boolean;
}

export type GraphEnvironmentPlan = {
  source: GraphEnvironmentFileSource;
  required: boolean;
  variables: GraphVariableSource[];
} & (
  | ({ status: 'PINNED' } & GraphEnvironmentFilePin)
  | ({ status: 'SKIPPED'; path?: string } & GraphEnvironmentSource)
);

export function environmentFilePath(value: string) {
  const normalized = posix.normalize(relativePath(value));
  if (
    normalized === '.' ||
    normalized.endsWith('/') ||
    normalized.split('/').some((segment) => segment.toLowerCase() === '.git')
  )
    throw new BadRequestException('环境文件必须是仓库内的相对文件路径');
  return normalized;
}

export function repositoryEnvironmentValues(bytes: Buffer) {
  try {
    if (bytes.length > graphEnvironmentMaxBytes || bytes.includes(0)) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return Object.fromEntries(
      Object.entries(parseEnv(text)).filter(
        (entry): entry is [string, string] =>
          executionVariableName.test(entry[0]) &&
          !/^VEYOPS_/i.test(entry[0]) &&
          typeof entry[1] === 'string',
      ),
    );
  } catch {
    throw new BadRequestException('无法读取环境文件，请检查文件类型、UTF-8 格式和 64 KiB 大小限制');
  }
}

export function publicEnvironmentFile(plan?: GraphEnvironmentPlan) {
  if (!plan) return undefined;
  return {
    status: plan.status,
    source: plan.source,
    required: plan.required,
    repositoryId: plan.repositoryId,
    commitSha: plan.commitSha,
    branch: plan.branch,
    tag: plan.tag,
    path: plan.path,
  };
}

export function graphVariableSources(
  file: GraphEnvironmentPlan | undefined,
  configured: readonly GraphVariableSource[],
  node: readonly GraphVariableSource[] = [],
) {
  const sources = new Map<string, GraphVariableSource>();
  for (const item of [...(file?.variables ?? []), ...configured, ...node]) {
    if (/^VEYOPS_/i.test(item.key) && item.source !== 'SYSTEM') continue;
    sources.set(item.key, item);
  }
  return [...sources.values()].sort((left, right) => left.key.localeCompare(right.key, 'en'));
}
