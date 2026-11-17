import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { ReleasePolicy } from '../pipelines/pipeline.types';
import type { PipelineSnapshot, PipelineTarget } from '../pipelines/pipeline.types';
import { ConflictException } from '@nestjs/common';

export const pendingReleaseApprovalTime = Number.MAX_SAFE_INTEGER;

export function readReleasePolicy(value?: string): ReleasePolicy {
  const saved = JSON.parse(value ?? '{}') as Partial<ReleasePolicy>;
  return {
    requireApproval: saved.requireApproval ?? false,
    archivePushedImage: saved.archivePushedImage ?? false,
    rollbackMode: saved.rollbackMode ?? 'OFF',
    ...(saved.pinnedDeploymentId && { pinnedDeploymentId: saved.pinnedDeploymentId }),
    healthCheck: saved.healthCheck ?? { attempts: 1, intervalSeconds: 0, timeoutSeconds: 120 },
  };
}

export async function serviceReleasePolicy(
  db: Kysely<Database>,
  serviceId: string,
  environmentId: string,
) {
  const row = await db
    .selectFrom('service_environment_configs')
    .select(['release_policy_json', 'deploy_path'])
    .where('service_id', '=', serviceId)
    .where('environment_id', '=', environmentId)
    .executeTakeFirst();
  return { policy: readReleasePolicy(row?.release_policy_json), deployPath: row?.deploy_path };
}

export async function assertCurrentTargets(
  db: Kysely<Database>,
  pipeline: PipelineSnapshot,
  targets: PipelineTarget[],
) {
  const config = await db
    .selectFrom('service_environment_configs')
    .select(['target_id', 'deploy_path'])
    .where('service_id', '=', pipeline.serviceId)
    .where('environment_id', '=', pipeline.environmentId)
    .executeTakeFirst();
  if (config?.deploy_path && config.deploy_path !== pipeline.definition.deployPath)
    throw new ConflictException('发布目录已变化，请重新预览并提交');
  const current = await db
    .selectFrom('deployment_target_servers as member')
    .innerJoin('servers as server', 'server.id', 'member.server_id')
    .innerJoin('credentials as credential', 'credential.id', 'server.credential_id')
    .where('member.target_id', '=', config?.target_id ?? pipeline.targetId)
    .where('server.is_active', '=', 1)
    .where('credential.status', '=', 'ACTIVE')
    .select([
      'server.id',
      'server.host',
      'server.port',
      'server.username',
      'server.host_key_fingerprint',
      'server.credential_id',
    ])
    .execute();
  if (
    targets.some(
      (target) =>
        !current.some(
          (server) =>
            server.id === target.id &&
            server.host === target.host &&
            server.port === target.port &&
            server.username === target.username &&
            server.credential_id === target.credentialId &&
            server.host_key_fingerprint === target.hostKeyFingerprint,
        ),
    )
  )
    throw new ConflictException('发布目标或 SSH 配置已变化，请重新预览并提交');
}
