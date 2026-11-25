import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';
import { isGitBranchName } from '../projects/git-ref';
import { resolveGraphRepositorySelector } from '../projects/graph-repository-selectors';
import {
  orderedFlowNodes,
  type GraphDefinition,
  type GraphFlow,
} from './execution-graph-definition';
import { flowCandidateCatalog } from './graph-binding-validation';
import type { GraphBinding } from './graph-fields';
import {
  graphDeliveryId,
  type GraphParameterMapping,
  type GraphWebhookProtocol,
  type SourceCronMode,
} from './graph-trigger.dto';
import { flowStart, nodeInputBinding } from './graph-run-bindings';

export type TriggerSourceConfig = {
  cronMode?: SourceCronMode;
  buildOnFirstObservation?: boolean;
  webhookProtocol?: GraphWebhookProtocol;
  generatedCredential?: boolean;
  repositoryId?: string;
  sourceId?: string;
  ref?: string;
};

export type TriggerCheckoutScope = {
  repositoryId: string;
  ref: string;
  nodeId: string;
  sourceId?: string;
};

export type SourceScope = {
  project_id: string;
  flow_id: string;
  repository_id: string;
  ref: string;
};

export type SourceObservation = Selectable<Database['execution_graph_source_observations']>;

export const branchPrefix = 'refs/heads/';
export const sourceWebhook = (protocol?: GraphWebhookProtocol) =>
  protocol === 'GITEA' || protocol === 'BEARER';
export const validBranchRef = (ref: string) =>
  ref.startsWith(branchPrefix) && isGitBranchName(ref.slice(branchPrefix.length));
export const validCommit = (sha: string) =>
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha) && !/^0+$/.test(sha);

function staticBinding(
  flow: GraphFlow,
  binding: GraphBinding | undefined,
  parameters?: Record<string, GraphParameterMapping>,
): unknown {
  if (binding?.kind === 'VALUE') return binding.value;
  if (binding?.kind === 'INPUT') {
    const mapping =
      parameters && Object.hasOwn(parameters, binding.fieldId)
        ? parameters[binding.fieldId]
        : undefined;
    if (mapping?.source === 'VALUE') return mapping.value;
    if (mapping?.source === 'EVENT' && (mapping.field === 'ref' || mapping.field === 'commit'))
      return { byEvent: true };
    if (mapping) return { unresolved: true };
    return flowStart(flow).inputs?.find(({ id }) => id === binding.fieldId)?.defaultValue;
  }
  if (binding?.kind === 'AS_GIT_REF') {
    const value = staticBinding(flow, binding.source, parameters);
    return typeof value === 'string' ? { kind: binding.refKind, value } : value;
  }
  if (binding?.kind === 'FIRST_AVAILABLE') {
    for (const source of binding.sources) {
      const value = staticBinding(flow, source, parameters);
      if (value !== undefined) return value;
    }
  }
  return binding !== undefined ? { unresolved: true } : undefined;
}

async function simplifiedTriggerSource(
  db: Kysely<Database>,
  projectId: string,
  flow: GraphFlow,
  settings: TriggerSourceConfig,
): Promise<TriggerCheckoutScope> {
  const node = flow.nodes.find(
    ({ type, operation }) => type === 'CHECKOUT' || operation === 'CHECKOUT',
  );
  const sources = flowStart(flow).start?.sources ?? [];
  if (!node || (!settings.sourceId && sources.length > 1))
    throw new BadRequestException('请选择唯一的开始节点源码项作为触发来源');
  const source = settings.sourceId
    ? sources.find(({ id }) => id === settings.sourceId)
    : sources[0];
  if (
    !source?.repositoryId ||
    (settings.repositoryId && settings.repositoryId !== source.repositoryId)
  )
    throw new BadRequestException('选定的开始节点源码项或其项目仓库已不可用');
  const row = await db
    .selectFrom('repositories')
    .select('default_branch')
    .where('id', '=', source.repositoryId)
    .where('project_id', '=', projectId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  const branch = source.ref
    ? source.ref.kind === 'BRANCH'
      ? source.ref.value
      : undefined
    : row?.default_branch;
  const ref = branch ? branchPrefix + branch : undefined;
  if (!row || !ref || !validBranchRef(ref) || (settings.ref && settings.ref !== ref))
    throw new BadRequestException('开始节点源码项需配置匹配的分支，使用默认分支时仓库需先同步');
  return { repositoryId: source.repositoryId, ref, nodeId: node.id, sourceId: source.id };
}

export async function resolveTriggerSource(
  db: Kysely<Database>,
  projectId: string,
  flowId: string,
  settings: TriggerSourceConfig & { parameterMappings?: Record<string, GraphParameterMapping> },
  definition: GraphDefinition,
): Promise<TriggerCheckoutScope> {
  const flow = definition.flows.find(({ id }) => id === flowId);
  if (!flow) throw new BadRequestException('已发布的图没有当前开始节点');
  if (settings.ref && !validBranchRef(settings.ref))
    throw new BadRequestException('请输入有效的分支完整引用，如 refs/heads/main');
  if (flow.model === 'FLOW_V2') return simplifiedTriggerSource(db, projectId, flow, settings);
  if (settings.sourceId) throw new BadRequestException('当前执行流不支持开始源码项');
  const inferred =
    !flow.compiled && flowStart(flow).contract === 'PRESET'
      ? flowCandidateCatalog(flow, definition.flows, orderedFlowNodes(flow)).nodes
      : undefined;
  const checkouts = [];
  for (const node of flow.nodes.filter(
    ({ type, operation }) => type === 'CHECKOUT' || operation === 'CHECKOUT',
  )) {
    const checkoutBinding = (fieldId: string) =>
      inferred
        ? inferred[node.id]?.automaticInputBindings[fieldId]
        : nodeInputBinding(flow, node, fieldId);
    const input = checkoutBinding('repository');
    const repository = staticBinding(flow, input, settings.parameterMappings);
    const mapping = input?.kind === 'INPUT' && settings.parameterMappings?.[input.fieldId];
    const eventRepository = mapping && mapping.source === 'EVENT' && mapping.field === 'repository';
    const selector =
      typeof repository === 'string'
        ? repository
        : eventRepository
          ? settings.repositoryId
          : undefined;
    if (!selector) continue;
    const repositoryId = await resolveGraphRepositorySelector(db, projectId, selector);
    if (settings.repositoryId && settings.repositoryId !== repositoryId) continue;
    const row = await db
      .selectFrom('repositories')
      .select('default_branch')
      .where('id', '=', repositoryId)
      .where('project_id', '=', projectId)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (!row) continue;
    const selected = staticBinding(flow, checkoutBinding('version'), settings.parameterMappings);
    const version =
      selected && typeof selected === 'object'
        ? (selected as { kind?: string; value?: string; byEvent?: boolean })
        : undefined;
    const ref =
      version?.kind === 'BRANCH' && typeof version.value === 'string'
        ? branchPrefix + version.value
        : version?.byEvent
          ? settings.ref || (row.default_branch ? branchPrefix + row.default_branch : undefined)
          : selected === undefined && row.default_branch
            ? branchPrefix + row.default_branch
            : undefined;
    if (ref && validBranchRef(ref) && (!settings.ref || settings.ref === ref))
      checkouts.push({ repositoryId, ref, nodeId: node.id });
  }
  if (checkouts.length !== 1)
    throw new BadRequestException(
      checkouts.length
        ? '多个检出节点匹配该仓库和分支，请为触发规则选择唯一来源'
        : '请为来源触发规则选择已有检出节点使用的仓库和分支，仓库默认分支需要先同步',
    );
  return checkouts[0]!;
}

export interface WebhookRequest {
  raw?: Buffer;
  body: unknown;
  authorization?: string;
  timestamp?: string;
  eventId?: string;
  signature?: string;
  giteaEvent?: string;
  giteaDelivery?: string;
  giteaSignature?: string;
}

interface WebhookDelivery {
  eventId: string;
  ref?: string;
  commitSha?: string;
  repositoryId?: string;
  inputValue?: string;
  repositoryUrl?: string;
  repositoryName?: string;
  unsupported?: boolean;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bodyText(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

function unauthorized(): never {
  throw new UnauthorizedException('Webhook 认证失败');
}

function checkDigest(expected: Buffer, supplied: string | undefined) {
  if (
    !supplied ||
    !/^[0-9a-f]{64}$/i.test(supplied) ||
    !timingSafeEqual(expected, Buffer.from(supplied, 'hex'))
  )
    unauthorized();
}

export function decodeTriggerWebhook(
  input: WebhookRequest,
  protocol: GraphWebhookProtocol,
  secret: string,
): WebhookDelivery {
  const raw = input.raw;
  if (!raw || raw.length > (protocol === 'SIGNED' ? 8192 : 1024 * 1024)) unauthorized();
  const body = objectOf(input.body);
  if (protocol === 'SIGNED') {
    const { timestamp, eventId, signature } = input;
    if (
      !timestamp ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000 ||
      !eventId ||
      !graphDeliveryId.test(eventId) ||
      !signature ||
      !/^sha256=/i.test(signature)
    )
      unauthorized();
    checkDigest(
      createHmac('sha256', secret)
        .update(timestamp + '.' + eventId + '.')
        .update(raw)
        .digest(),
      signature.slice(7),
    );
    const repositoryId = bodyText(body.repositoryId);
    const inputValue = bodyText(body.inputValue);
    const ref = bodyText(body.ref);
    const commitSha = bodyText(body.commitSha)?.toLowerCase();
    if (
      (commitSha && !validCommit(commitSha)) ||
      (inputValue && inputValue.length > 500) ||
      (repositoryId && !/^[0-9a-f-]{36}$/i.test(repositoryId)) ||
      (ref && !/^refs\/(?:heads|tags)\/[^\s\x00]{1,256}$/.test(ref))
    )
      throw new BadRequestException('Webhook 事件数据无效');
    return { eventId, inputValue, repositoryId, ref, commitSha };
  }
  if (protocol === 'GITEA')
    checkDigest(createHmac('sha256', secret).update(raw).digest(), input.giteaSignature);
  else {
    const token = /^Bearer ([^\s]+)$/i.exec(input.authorization ?? '')?.[1];
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!token || !timingSafeEqual(digest(secret), digest(token))) unauthorized();
  }
  const eventId = protocol === 'GITEA' ? input.giteaDelivery : bodyText(body.eventId);
  if (!eventId || !graphDeliveryId.test(eventId))
    throw new BadRequestException('Webhook 投递标识缺失或无效');
  const ref = bodyText(body.ref);
  const commitSha = bodyText(protocol === 'GITEA' ? body.after : body.commitSha)?.toLowerCase();
  if (
    protocol === 'BEARER' &&
    (!ref || !validBranchRef(ref) || !commitSha || !validCommit(commitSha))
  )
    throw new BadRequestException('Webhook 需要有效的分支 ref 和完整的 commitSha');
  const repository = objectOf(body.repository);
  return {
    eventId,
    ref: ref && validBranchRef(ref) ? ref : undefined,
    commitSha: commitSha && validCommit(commitSha) ? commitSha : undefined,
    repositoryUrl: bodyText(repository.clone_url) ?? bodyText(repository.html_url),
    repositoryName: bodyText(repository.full_name),
    unsupported: protocol === 'GITEA' && input.giteaEvent !== 'push',
  };
}

function repositoryIdentity(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    const path = decodeURIComponent(url.pathname)
      .replace(/\/+$/, '')
      .replace(/\.git$/, '');
    return { origin: url.origin, path, name: path.split('/').slice(-2).join('/') };
  } catch {
    return undefined;
  }
}

export function matchesGiteaRepository(cloneUrl: string, url?: string, fullName?: string) {
  if (!url || !fullName) return false;
  const registered = repositoryIdentity(cloneUrl);
  const upstream = repositoryIdentity(url);
  return (
    !!registered &&
    !!upstream &&
    registered.origin === upstream.origin &&
    registered.path === upstream.path &&
    registered.name === fullName
  );
}

export function sourceObservation(db: Kysely<Database>, key: SourceScope) {
  return db
    .selectFrom('execution_graph_source_observations')
    .selectAll()
    .where('project_id', '=', key.project_id)
    .where('flow_id', '=', key.flow_id)
    .where('repository_id', '=', key.repository_id)
    .where('ref', '=', key.ref)
    .executeTakeFirst();
}

export function updateObservation(tx: Transaction<Database>, key: SourceScope) {
  return tx
    .updateTable('execution_graph_source_observations')
    .where('project_id', '=', key.project_id)
    .where('flow_id', '=', key.flow_id)
    .where('repository_id', '=', key.repository_id)
    .where('ref', '=', key.ref);
}

export class SourceObservationChanged extends ConflictException {
  constructor() {
    super('另一个来源已更新该分支，请重新读取仓库');
  }
}

export async function compareSourceObservation(
  tx: Transaction<Database>,
  key: SourceScope,
  prior: SourceObservation | undefined,
  sha: string,
  checkedAt: number,
) {
  const changed = !prior || prior.commit_sha !== sha;
  const sequence = (prior?.sequence ?? 0) + (changed ? 1 : 0);
  const row = prior
    ? await updateObservation(tx, key)
        .set({
          commit_sha: sha,
          sequence,
          event_id: changed ? null : prior.event_id,
          last_checked_at: checkedAt,
        })
        .where('sequence', '=', prior.sequence)
        .where('commit_sha', '=', prior.commit_sha)
        .where('event_id', prior.event_id === null ? 'is' : '=', prior.event_id)
        .returningAll()
        .executeTakeFirst()
    : await tx
        .insertInto('execution_graph_source_observations')
        .values({ ...key, commit_sha: sha, sequence, last_checked_at: checkedAt })
        .onConflict((conflict) =>
          conflict.columns(['project_id', 'flow_id', 'repository_id', 'ref']).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
  if (!row) throw new SourceObservationChanged();
  return { changed, row };
}
