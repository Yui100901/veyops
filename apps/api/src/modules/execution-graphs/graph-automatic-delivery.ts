import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { SshTarget } from '../../infrastructure/ssh/ssh.service';
import type { GraphDefinition } from './execution-graph-definition';
import { graphTriggerKinds, type GraphTriggerKind } from './graph-trigger.dto';
import type { GraphCheckoutEvent } from '../projects/repository-metadata.service';
import { simplifiedWorkspaceInput } from './simplified-flow-definition';

export interface GraphAutomation {
  kind: GraphTriggerKind;
  ruleId: string;
  revision: string;
  invokedBy?: string;
}

export function isGraphTriggerKind(value: unknown): value is GraphTriggerKind {
  return graphTriggerKinds.some((kind) => kind === value);
}

export function graphCheckoutEvent(
  trigger?: Record<string, unknown>,
  nodeId?: string,
): GraphCheckoutEvent | undefined {
  if (
    !trigger ||
    !(
      ['POLL', 'GITEA', 'BEARER'].includes(String(trigger.eventSource)) ||
      (trigger.eventSource === 'SIGNED' && typeof trigger.sourceId === 'string')
    ) ||
    (nodeId && trigger.checkoutNodeId && trigger.checkoutNodeId !== nodeId) ||
    typeof trigger.repositoryId !== 'string' ||
    typeof trigger.ref !== 'string' ||
    !trigger.ref.startsWith('refs/heads/') ||
    typeof trigger.commitSha !== 'string' ||
    !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(trigger.commitSha)
  )
    return undefined;
  return {
    repositoryId: trigger.repositoryId,
    ref: trigger.ref,
    commitSha: trigger.commitSha.toLowerCase(),
  };
}

export function graphNodeRequiresIsolation(type: string): boolean {
  return (
    type === 'SHELL' || type === 'CHECK' || type === 'REGISTER_ARTIFACT' || type === 'HEALTH_CHECK'
  );
}

export async function assertAutomaticTargets(
  db: Kysely<Database>,
  targets: readonly (string | SshTarget)[],
) {
  if (!targets.length) throw new ForbiddenException('自动执行需要已授权的服务器');
  const ids = targets.map((target) => (typeof target === 'string' ? target : target.id));
  const rows = await db
    .selectFrom('servers as server')
    .leftJoin('credentials as credential', 'credential.id', 'server.credential_id')
    .select([
      'server.id',
      'server.name',
      'server.host',
      'server.port',
      'server.username',
      'server.host_key_fingerprint',
      'server.credential_id',
      'server.is_active',
      'server.automatic_execution_credential_nonce',
      'credential.nonce',
      'credential.status',
      'credential.type',
    ])
    .where('server.id', 'in', ids)
    .execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const target of targets) {
    const row = byId.get(typeof target === 'string' ? target : target.id);
    if (
      !row ||
      row.is_active !== 1 ||
      !row.host_key_fingerprint ||
      !row.automatic_execution_credential_nonce ||
      row.automatic_execution_credential_nonce !== row.nonce ||
      row.status !== 'ACTIVE' ||
      !['SSH_PASSWORD', 'SSH_KEY'].includes(row.type ?? '')
    )
      throw new ForbiddenException(
        `服务器「${row?.name ?? (typeof target === 'string' ? target : target.name)}」缺少有效的自动执行授权，请管理员复核 SSH 身份后授权`,
      );
    if (
      typeof target !== 'string' &&
      (row.host !== target.host ||
        row.port !== target.port ||
        row.username !== target.username ||
        row.host_key_fingerprint !== target.hostKeyFingerprint ||
        row.credential_id !== target.credentialId ||
        (target.credentialNonce && row.nonce !== target.credentialNonce))
    )
      throw new ConflictException(`服务器「${row.name}」的 SSH 身份与已确认计划不一致`);
  }
}

function requireEnabled(kind: GraphTriggerKind) {
  const enabled = process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS?.split(',').map((item) => item.trim());
  if (!enabled?.includes(kind)) throw new ForbiddenException(`自动交付入口 ${kind} 尚未放行`);
}

export function assertAutomaticGraphFlow(
  definition: GraphDefinition,
  flowId: string,
  kind: GraphTriggerKind,
) {
  const flows = new Set([flowId]);
  let hasDelivery = false;
  for (const id of flows) {
    const flow = definition.flows.find((entry) => entry.id === id);
    if (flow && simplifiedWorkspaceInput(flow)?.required)
      throw new ConflictException('此执行流需要手动选择历史目录，无法启用自动触发');
    for (const node of flow?.nodes ?? []) {
      if (node.type === 'FLOW_CALL' && node.flowId) flows.add(node.flowId);
      if (
        graphNodeRequiresIsolation(node.type) ||
        node.type === 'BUILD' ||
        node.type === 'DEPLOY_ARTIFACT' ||
        node.type === 'ROLLBACK_ARTIFACT'
      ) {
        requireEnabled(kind);
        hasDelivery = true;
      }
    }
  }
  return hasDelivery;
}

export async function assertGraphAutomation(
  db: Kysely<Database>,
  projectId: string,
  ownerId: string,
  origin: GraphAutomation,
  externalWrite = true,
) {
  if (externalWrite) requireEnabled(origin.kind);
  const rule = await db
    .selectFrom('execution_graph_triggers as rule')
    .innerJoin('users as owner', 'owner.id', 'rule.created_by')
    .innerJoin('projects as project', 'project.id', 'rule.project_id')
    .select('rule.config_json')
    .where('rule.id', '=', origin.ruleId)
    .where('rule.project_id', '=', projectId)
    .where('rule.kind', '=', origin.kind)
    .where('rule.created_by', '=', ownerId)
    .where('rule.enabled', '=', 1)
    .where('project.deleted_at', 'is', null)
    .where('owner.status', '=', 'ACTIVE')
    .where('owner.role', '=', 'ADMIN')
    .where('owner.must_change_password', '=', 0)
    .executeTakeFirst();
  const settings =
    rule &&
    (JSON.parse(rule.config_json) as {
      revision?: string;
      credentialId?: string;
      credentialNonce?: string;
    });
  if (!settings || settings.revision !== origin.revision)
    throw new ConflictException('自动交付触发器已停用、已修改或配置管理员已失效');
  if (origin.kind === 'API' && (origin.invokedBy || externalWrite)) {
    if (!origin.invokedBy) throw new ForbiddenException('自动交付缺少已认证的 API 调用者');
    const invoker = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', origin.invokedBy)
      .where('status', '=', 'ACTIVE')
      .where('role', 'in', ['ADMIN', 'OPERATOR'])
      .where('must_change_password', '=', 0)
      .executeTakeFirst();
    if (!invoker) throw new ForbiddenException('触发 API 的调用者权限已失效');
  }
  if (origin.kind === 'WEBHOOK') {
    const credential =
      settings.credentialId &&
      settings.credentialNonce &&
      (await db
        .selectFrom('credentials')
        .select('id')
        .where('id', '=', settings.credentialId)
        .where('nonce', '=', settings.credentialNonce)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirst());
    if (!credential) throw new ForbiddenException('Webhook 签名凭据已失效');
  }
}
