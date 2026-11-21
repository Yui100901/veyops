import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { GraphDefinition } from './execution-graph-definition';
import { graphTriggerKinds, type GraphTriggerKind } from './graph-trigger.dto';

export interface GraphAutomation {
  kind: GraphTriggerKind;
  ruleId: string;
  revision: string;
  invokedBy?: string;
}

export function isGraphTriggerKind(value: unknown): value is GraphTriggerKind {
  return graphTriggerKinds.some((kind) => kind === value);
}

export function graphNodeRequiresIsolation(type: string): boolean {
  return (
    type === 'SHELL' || type === 'CHECK' || type === 'REGISTER_ARTIFACT' || type === 'HEALTH_CHECK'
  );
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
    for (const node of definition.flows.find((entry) => entry.id === id)?.nodes ?? []) {
      if (node.type === 'FLOW_CALL' && node.flowId) flows.add(node.flowId);
      if (graphNodeRequiresIsolation(node.type))
        throw new ForbiddenException(`节点「${node.name}」的自动执行尚未通过隔离验收`);
      if (
        node.type === 'BUILD' ||
        node.type === 'DEPLOY_ARTIFACT' ||
        node.type === 'ROLLBACK_ARTIFACT'
      ) {
        requireEnabled(kind);
        hasDelivery = true;
      }
      if (node.type === 'BUILD' && node.build?.buildLocation === 'TARGET')
        throw new ForbiddenException(`节点「${node.name}」的自动构建需要管理端隔离运行器`);
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
