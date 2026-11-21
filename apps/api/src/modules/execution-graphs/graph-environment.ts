import { BadRequestException, ConflictException } from '@nestjs/common';
import { posix } from 'node:path';
import { parseEnv } from 'node:util';
import {
  executionVariableName,
  type ExecutionVariables,
} from '../../infrastructure/execution-variables';
import type { FrozenEnvironmentSet } from '../projects/environment-sets.service';
import { relativePath } from '../pipelines/pipeline.validation';
import { safeGraphEnvironmentKey } from './graph-fields';

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

export type GraphEnvironmentFileSource = 'NODE';

export interface GraphVariableSource {
  key: string;
  source:
    | 'FILE'
    | 'PROJECT'
    | 'ENVIRONMENT_SET'
    | 'ENVIRONMENT'
    | 'SERVICE_ENVIRONMENT'
    | 'NODE'
    | 'SYSTEM';
  isSecret: boolean;
  overriddenSources?: GraphVariableSource['source'][];
}

export function environmentSetSummary(set?: FrozenEnvironmentSet) {
  return set ? { id: set.id, name: set.name, revision: set.revision } : null;
}

export interface GraphVariableSnapshot extends ExecutionVariables {
  variableSources: GraphVariableSource[];
}

export function mergeEnvironmentSet(
  project: GraphVariableSnapshot,
  set?: FrozenEnvironmentSet,
): GraphVariableSnapshot {
  if (!set) return project;
  const variables: Record<string, string> = Object.assign(Object.create(null), project.variables);
  const secretVariables: Record<string, string> = Object.assign(
    Object.create(null),
    project.secretVariables,
  );
  const secretCredentialNonces: Record<string, string> = Object.assign(
    Object.create(null),
    project.secretCredentialNonces,
  );
  const entries = new Map(project.variableSources.map((entry) => [entry.key, entry]));
  for (const key of [...Object.keys(set.variables), ...Object.keys(set.secretVariables)]) {
    const isSecret = Object.hasOwn(set.secretVariables, key);
    delete variables[key];
    delete secretVariables[key];
    delete secretCredentialNonces[key];
    if (isSecret) {
      secretVariables[key] = set.secretVariables[key]!;
      const nonce = set.secretCredentialNonces[key];
      if (nonce) secretCredentialNonces[key] = nonce;
    } else {
      variables[key] = set.variables[key]!;
    }
    const previous = entries.get(key);
    entries.set(key, {
      key,
      source: 'ENVIRONMENT_SET',
      isSecret,
      ...(previous && { overriddenSources: [previous.source] }),
    });
  }
  return {
    variables,
    secretVariables,
    secretCredentialNonces,
    variableSources: [...entries.values()],
  };
}

export function mergeGraphNodeEnvironment(
  inherited: ExecutionVariables,
  node: ExecutionVariables,
): ExecutionVariables {
  const variables: Record<string, string> = Object.assign(Object.create(null), inherited.variables);
  const secretVariables: Record<string, string> = Object.assign(
    Object.create(null),
    inherited.secretVariables,
  );
  const secretCredentialNonces: Record<string, string> = Object.assign(
    Object.create(null),
    inherited.secretCredentialNonces,
  );

  for (const [key, value] of Object.entries(node.variables)) {
    if (!safeGraphEnvironmentKey(key) || value.includes('\0') || value.length > 65_536)
      throw new BadRequestException('构建节点环境变量名称或普通值无效');
    variables[key] = value;
    delete secretVariables[key];
    delete secretCredentialNonces[key];
  }
  for (const [key, credentialId] of Object.entries(node.secretVariables)) {
    if (!safeGraphEnvironmentKey(key) || !credentialId || Object.hasOwn(node.variables, key))
      throw new BadRequestException('构建节点敏感变量名称或凭据引用无效');
    const nonce = node.secretCredentialNonces?.[key];
    if (!nonce) throw new ConflictException('构建节点敏感变量缺少已确认的凭据版本');
    delete variables[key];
    secretVariables[key] = credentialId;
    secretCredentialNonces[key] = nonce;
  }
  return { variables, secretVariables, secretCredentialNonces };
}

export type GraphEnvironmentPlan = {
  source: GraphEnvironmentFileSource;
  required: boolean;
  mappingKey?: string;
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
    mappingKey: plan.mappingKey,
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
    const previous = sources.get(item.key);
    sources.set(
      item.key,
      previous
        ? {
            ...item,
            overriddenSources: [
              ...(previous.overriddenSources ?? []),
              previous.source,
              ...(item.overriddenSources ?? []),
            ],
          }
        : item,
    );
  }
  return [...sources.values()].sort((left, right) => left.key.localeCompare(right.key, 'en'));
}
