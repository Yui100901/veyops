import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { lstat, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory } from '../../core/config';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { archiveKey, lockAvailableArtifacts } from './artifact-availability';

export interface ArtifactRetentionPolicy {
  maxBuilds: number;
  maxDays: number;
}

export interface ArtifactRetentionScope {
  serviceId: string;
  environmentId: string;
}

const prefix = 'artifacts:retention';
const retentionLock = 'artifacts:cleanup-lock';
const defaults: Readonly<ArtifactRetentionPolicy> = { maxBuilds: 20, maxDays: 30 };
const day = 86_400_000;
export const artifactCleanupBatch = 50;
const activeTaskStatuses = ['PENDING', 'RUNNING', 'CANCEL_REQUESTED', 'NEEDS_ATTENTION'];

function settingsKey(scope?: ArtifactRetentionScope) {
  return scope ? `${prefix}:${scope.serviceId}:${scope.environmentId}` : prefix;
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function removeArchive(dataDir: string, key: string) {
  const root = join(await realpath(dataDir), 'artifacts');
  if ((await realpath(root)) !== root) throw new Error('Unsafe artifact directory');
  const file = join(root, key);
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || (await realpath(file)) !== file) throw new Error('Unsafe artifact path');
    await unlink(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function reserveCleanup(tx: Transaction<Database>) {
  await tx
    .insertInto('system_settings')
    .values({ key: retentionLock, value_json: '{}', updated_at: Date.now() })
    .onConflict((conflict) =>
      conflict
        .column('key')
        .doUpdateSet((eb) => ({ value_json: eb.ref('system_settings.value_json') })),
    )
    .execute();
}

async function retentionPolicies(db: Kysely<Database>) {
  const rows = await db
    .selectFrom('system_settings')
    .select(['key', 'value_json'])
    .where((eb) => eb.or([eb('key', '=', prefix), eb('key', 'like', `${prefix}:%`)]))
    .execute();
  return new Map(
    rows.map((row) => [row.key, JSON.parse(row.value_json) as ArtifactRetentionPolicy]),
  );
}

async function protectedArtifacts(db: Kysely<Database>) {
  const [deployments, configs, tasks] = await Promise.all([
    db
      .selectFrom('deployment_records')
      .select([
        'id',
        'artifact_id',
        'pipeline_run_id',
        'service_id',
        'environment_id',
        'server_id',
        'status',
        'health_status',
        'previous_deployment_id',
      ])
      .where('status', 'in', ['SUCCESS', 'RUNNING', 'NEEDS_ATTENTION'])
      .orderBy('started_at', (order) => order.desc().nullsLast())
      .orderBy('id', 'desc')
      .execute(),
    db.selectFrom('service_environment_configs').select('release_policy_json').execute(),
    db
      .selectFrom('tasks')
      .select('payload_json')
      .where('task_type', '=', 'PIPELINE')
      .where('status', 'in', activeTaskStatuses)
      .execute(),
  ]);
  const protectedIds = new Set<string>();
  const previousIds = new Set<string>();
  const current = new Set<string>();
  const healthy = new Set<string>();
  const pinnedDeploymentIds = new Set<string>();
  for (const config of configs) {
    const policy = JSON.parse(config.release_policy_json ?? '{}') as {
      pinnedDeploymentId?: string;
    };
    if (policy.pinnedDeploymentId) pinnedDeploymentIds.add(policy.pinnedDeploymentId);
  }
  const pinnedRuns = new Set(
    deployments
      .filter((deployment) => pinnedDeploymentIds.has(deployment.id))
      .map((deployment) => deployment.pipeline_run_id),
  );
  for (const d of deployments) {
    const scope = `${d.service_id}:${d.environment_id}:${d.server_id ?? ''}`;
    if (d.status === 'SUCCESS') {
      if ((!current.has(scope) || pinnedRuns.has(d.pipeline_run_id)) && d.artifact_id)
        protectedIds.add(d.artifact_id);
      current.add(scope);
      if (d.health_status === 'HEALTHY' && !healthy.has(scope) && d.artifact_id) {
        protectedIds.add(d.artifact_id);
        healthy.add(scope);
      }
    } else {
      if (d.artifact_id) protectedIds.add(d.artifact_id);
      if (d.previous_deployment_id) previousIds.add(d.previous_deployment_id);
    }
  }
  for (const d of deployments)
    if (previousIds.has(d.id) && d.artifact_id) protectedIds.add(d.artifact_id);
  for (const task of tasks) {
    const payload = JSON.parse(task.payload_json) as {
      pipeline?: { deploymentArtifacts?: { id: string }[] };
    };
    for (const artifact of payload.pipeline?.deploymentArtifacts ?? [])
      protectedIds.add(artifact.id);
  }
  return protectedIds;
}

interface CleanupMember {
  id: string;
  createdAt: number;
  sizeBytes: number | null;
  canPrune: boolean;
  digest: string | null;
}

interface CleanupGroup {
  key: string;
  members: CleanupMember[];
}

async function archiveGroups(db: Kysely<Database>, now: number) {
  const [policies, protectedIds, artifacts] = await Promise.all([
    retentionPolicies(db),
    protectedArtifacts(db),
    db
      .selectFrom('artifacts')
      .leftJoin('pipeline_runs', 'pipeline_runs.id', 'artifacts.pipeline_run_id')
      .leftJoin('tasks', 'tasks.id', 'pipeline_runs.task_id')
      .select([
        'artifacts.id',
        'artifacts.service_id',
        'artifacts.pipeline_run_id',
        'artifacts.storage_type',
        'artifacts.storage_key',
        'artifacts.archive_key',
        'artifacts.registry_id',
        'artifacts.image_digest',
        'artifacts.pinned_at',
        'artifacts.size_bytes',
        'artifacts.created_at',
        'pipeline_runs.environment_id',
        'tasks.status as taskStatus',
      ])
      .where('artifacts.pruned_at', 'is', null)
      .orderBy('artifacts.created_at', 'desc')
      .orderBy('artifacts.id', 'desc')
      .execute(),
  ]);
  const defaultPolicy = policies.get(settingsKey()) ?? defaults;
  const runs = new Map<string, Map<string, number>>();
  const groups = new Map<string, CleanupGroup>();
  const digestMembers = new Map<string, string[]>();
  // A digest can be named by multiple tags. A protected archive for the same digest wins.
  const digestOf = (a: (typeof artifacts)[number]) =>
    a.image_digest ? `${a.registry_id ?? ''}:${a.image_digest}` : null;
  const protectedDigests = new Set(
    artifacts.filter((a) => a.pinned_at !== null || protectedIds.has(a.id)).map(digestOf),
  );
  for (const a of artifacts) {
    const digest = digestOf(a);
    if (digest) {
      const ids = digestMembers.get(digest) ?? [];
      ids.push(a.id);
      digestMembers.set(digest, ids);
    }
    const scope =
      a.environment_id && settingsKey({ serviceId: a.service_id, environmentId: a.environment_id });
    const policy = (scope && policies.get(scope)) || defaultPolicy;
    let overCount = false;
    if (
      scope &&
      a.pipeline_run_id &&
      (a.taskStatus === 'SUCCESS' || a.taskStatus === 'PARTIAL_FAILED')
    ) {
      const ranks = runs.get(scope) ?? new Map<string, number>();
      if (!ranks.has(a.pipeline_run_id)) ranks.set(a.pipeline_run_id, ranks.size + 1);
      runs.set(scope, ranks);
      overCount = (ranks.get(a.pipeline_run_id) ?? 0) > policy.maxBuilds;
    }
    const key = archiveKey(a);
    if (!key) continue;
    const group = groups.get(key) ?? { key, members: [] };
    groups.set(key, group);
    group.members.push({
      id: a.id,
      createdAt: a.created_at,
      sizeBytes: a.size_bytes,
      digest,
      canPrune: Boolean(
        scope &&
        a.taskStatus &&
        !activeTaskStatuses.includes(a.taskStatus) &&
        a.pinned_at === null &&
        !protectedIds.has(a.id) &&
        (!digest || !protectedDigests.has(digest)) &&
        (overCount || a.created_at < now - policy.maxDays * day),
      ),
    });
  }
  return { groups, digestMembers };
}

@Injectable()
export class ArtifactRetentionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private async checkScope(db: Kysely<Database>, scope?: ArtifactRetentionScope) {
    if (!scope) return;
    const match = await db
      .selectFrom('services')
      .innerJoin('environments', 'environments.project_id', 'services.project_id')
      .select('services.id')
      .where('services.id', '=', scope.serviceId)
      .where('environments.id', '=', scope.environmentId)
      .executeTakeFirst();
    if (!match) throw new NotFoundException('服务环境不存在');
  }

  async settings(scope?: ArtifactRetentionScope) {
    await this.checkScope(this.database.db, scope);
    const policies = await retentionPolicies(this.database.db);
    const own = policies.get(settingsKey(scope));
    return {
      ...(own ?? policies.get(settingsKey()) ?? defaults),
      inherited: Boolean(scope && !own),
    };
  }

  async configure(
    policy: ArtifactRetentionPolicy | null,
    userId: string,
    scope?: ArtifactRetentionScope,
  ) {
    if (!policy && !scope) throw new BadRequestException('全局产物保留策略需要配置限制');
    await this.database.db.transaction().execute(async (tx) => {
      await reserveCleanup(tx);
      await this.checkScope(tx, scope);
      const key = settingsKey(scope);
      if (policy) {
        const value = { key, value_json: JSON.stringify(policy), updated_at: Date.now() };
        await tx
          .insertInto('system_settings')
          .values(value)
          .onConflict((conflict) => conflict.column('key').doUpdateSet(value))
          .execute();
      } else await tx.deleteFrom('system_settings').where('key', '=', key).execute();
      await this.audit.record(
        userId,
        'artifact.retention.configure',
        'artifact-retention',
        key,
        { policy, scope },
        tx,
      );
    });
    return this.settings(scope);
  }

  async pin(id: string, pinned: boolean, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      await lockAvailableArtifacts(tx, [id]);
      const pinnedAt = pinned ? Date.now() : null;
      await tx.updateTable('artifacts').set({ pinned_at: pinnedAt }).where('id', '=', id).execute();
      await this.audit.record(
        userId,
        pinned ? 'artifact.pin' : 'artifact.unpin',
        'artifact',
        id,
        {},
        tx,
      );
      return { id, pinnedAt };
    });
  }

  async preview(now = Date.now()) {
    const groups = [...(await archiveGroups(this.database.db, now)).groups.values()].filter(
      ({ members }) => members.every((member) => member.canPrune),
    );
    return {
      total: groups.length,
      candidates: groups
        .slice(-artifactCleanupBatch)
        .reverse()
        .map(({ members }) => ({
          artifactIds: members.map(({ id }) => id),
          createdAt: members[0]!.createdAt,
          sizeBytes: members[0]!.sizeBytes,
        })),
    };
  }

  async pruneExpired() {
    await this.deleteRetiredArchives();
    const preview = await this.preview();
    if (preview.total)
      await this.prune(
        preview.candidates.map((candidate) => candidate.artifactIds[0]!),
        null,
      );
  }

  private async deleteRetiredArchives(ids?: string[], now = Date.now()) {
    if (ids && !ids.length)
      return { pruned: [], failed: [] } as { pruned: string[]; failed: string[] };
    const db = this.database.db;
    let query = db
      .selectFrom('artifacts')
      .select(['id', 'storage_type', 'storage_key', 'archive_key'])
      .where('pruned_at', 'is not', null)
      .where('archive_deleted_at', 'is', null);
    if (ids) query = query.where('id', 'in', ids);
    else query = query.orderBy('pruned_at', 'asc').limit(artifactCleanupBatch);
    const rows = await query.execute();
    if (!rows.length) return { pruned: [], failed: [] } as { pruned: string[]; failed: string[] };

    const groups = new Map<string | null, string[]>();
    for (const row of rows) {
      const key = archiveKey(row);
      const members = groups.get(key) ?? [];
      members.push(row.id);
      groups.set(key, members);
    }
    const pruned: string[] = [];
    const failed: string[] = [];
    for (const [key, members] of groups) {
      try {
        if (!key) throw new Error('Invalid artifact archive key');
        await removeArchive(dataDirectory, key);
        await db
          .updateTable('artifacts')
          .set({ archive_deleted_at: now })
          .where('id', 'in', members)
          .execute();
        pruned.push(...members);
      } catch {
        failed.push(...members);
      }
    }
    return { pruned, failed };
  }

  async prune(ids: string[], userId: string | null, now = Date.now()) {
    const retired = await this.database.db.transaction().execute(async (tx) => {
      await reserveCleanup(tx);
      const requested = new Set(ids);
      const plan = await archiveGroups(tx, now);
      const groups = [...plan.groups.values()].filter(({ members }) =>
        members.some(({ id }) => requested.has(id)),
      );
      const lockIds = groups.flatMap(({ members }) =>
        members.flatMap(({ id, digest }) =>
          digest ? (plan.digestMembers.get(digest) ?? [id]) : [id],
        ),
      );
      await lockAvailableArtifacts(tx, lockIds);
      // Re-read protections after acquiring the same artifact locks used during enqueue and pinning.
      const confirmed = (await archiveGroups(tx, now)).groups;
      const marked: string[] = [];
      for (const group of groups) {
        const locked = new Set(group.members.map(({ id }) => id));
        const current = confirmed.get(group.key);
        if (!current || current.members.some(({ id, canPrune }) => !canPrune || !locked.has(id)))
          continue;
        const removedIds = current.members.map(({ id }) => id);
        await tx
          .updateTable('artifacts')
          .set({ pruned_at: now })
          .where('id', 'in', removedIds)
          .execute();
        marked.push(...removedIds);
      }
      if (userId || marked.length)
        await this.audit.record(
          userId,
          'artifact.retention.prune',
          'artifact-retention',
          null,
          { artifactIds: marked },
          tx,
        );
      return marked;
    });
    // Mark unavailable before touching disk so pending deletions survive crashes and can be retried.
    const result = await this.deleteRetiredArchives(retired, now);
    return { ...result, skipped: ids.filter((id) => !retired.includes(id)) };
  }
}
