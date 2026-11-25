import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';
import { isGitBranchName } from '../projects/git-ref';
import type { GraphFlow } from './execution-graph-definition';
import {
  graphDeliveryId,
  type GraphWebhookProtocol,
  type SourceCronMode,
} from './graph-trigger.dto';
import { flowStart } from './graph-run-bindings';

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

export async function resolveTriggerSource(
  db: Kysely<Database>,
  projectId: string,
  flow: GraphFlow,
  settings: TriggerSourceConfig,
): Promise<TriggerCheckoutScope> {
  if (settings.ref && !validBranchRef(settings.ref))
    throw new BadRequestException('请输入有效的分支完整引用，如 refs/heads/main');
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
