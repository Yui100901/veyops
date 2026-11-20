import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import type { ReleasePolicy } from '../pipelines/pipeline.types';
import type { PipelineSnapshot, PipelineTarget } from '../pipelines/pipeline.types';
import { ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { resolveDeliveryTargets } from '../pipelines/delivery-targets';
import {
  selectedServerIds,
  storedDeploymentSelection,
} from '../deployment-targets/deployment-selection';

export const pendingReleaseApprovalTime = Number.MAX_SAFE_INTEGER;

export function readReleasePolicy(value?: string): ReleasePolicy {
  const saved = JSON.parse(value ?? '{}') as Partial<ReleasePolicy>;
  return {
    requireApproval: saved.requireApproval ?? false,
    requireCodeReview: saved.requireCodeReview === true,
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
    .select(['target_id', 'target_selection_json', 'deploy_path'])
    .where('service_id', '=', pipeline.serviceId)
    .where('environment_id', '=', pipeline.environmentId)
    .executeTakeFirst();
  if (config?.deploy_path && config.deploy_path !== pipeline.definition.deployPath)
    throw new ConflictException('发布目录已变化，请重新预览并提交');
  const snapshotIds =
    pipeline.targetSelection && !pipeline.rollbackOfDeploymentId
      ? await selectedServerIds(db, pipeline.targetSelection)
      : undefined;
  if (
    snapshotIds &&
    pipeline.targetMemberIds &&
    JSON.stringify(pipeline.targetMemberIds) !== JSON.stringify(snapshotIds)
  )
    throw new ConflictException('发布成员已变化，请重新预览并提交');
  const configured = storedDeploymentSelection(config?.target_selection_json);
  const canonical = pipeline.graphReleaseTargets;
  const environment =
    canonical &&
    (await db
      .selectFrom('environments')
      .select('default_target_selection_json')
      .where('id', '=', pipeline.environmentId)
      .where('project_id', '=', pipeline.projectId)
      .where('archived_at', 'is', null)
      .executeTakeFirst());
  if (canonical && !environment) throw new ConflictException('发布环境已变化，请重新预览并提交');
  const target =
    canonical &&
    resolveDeliveryTargets('RELEASE', canonical.requested, {
      service: configured,
      environment: storedDeploymentSelection(environment?.default_target_selection_json),
      legacyTargetId: config?.target_id,
      parallel: canonical.defaultParallel,
    });
  if (
    target &&
    (target.source !== canonical.source ||
      target.legacyId !== pipeline.targetId ||
      !isDeepStrictEqual(target.selection, pipeline.targetSelection))
  )
    throw new ConflictException('发布目标配置已变化，请重新预览并提交');
  const legacyId = target ? target.legacyId : (config?.target_id ?? pipeline.targetId);
  const selection = target ? target.selection : configured;
  const currentIds = selection
    ? await selectedServerIds(db, selection)
    : legacyId
      ? (
          await db
            .selectFrom('deployment_target_servers')
            .select('server_id')
            .where('target_id', '=', legacyId)
            .orderBy('sort_order')
            .execute()
        ).map((row) => row.server_id)
      : (snapshotIds ??
        (pipeline.targetSelection ? await selectedServerIds(db, pipeline.targetSelection) : []));
  if (
    !currentIds.length ||
    (canonical &&
      !pipeline.rollbackOfDeploymentId &&
      !isDeepStrictEqual(currentIds, pipeline.targetMemberIds ?? targets.map((item) => item.id)))
  )
    throw new ConflictException('发布成员已变化，请重新预览并提交');
  const current = await db
    .selectFrom('servers as server')
    .innerJoin('credentials as credential', 'credential.id', 'server.credential_id')
    .where('server.id', 'in', currentIds)
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
