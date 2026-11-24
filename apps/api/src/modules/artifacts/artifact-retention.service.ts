import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { archiveKey, lockAvailableArtifacts } from './artifact-availability';
import { lockProjectGraph } from '../projects/project-guards';
import {
  archivePeers,
  ArtifactCleanupService,
  removeArtifactArchive,
} from './artifact-cleanup.service';
import {
  activeArtifactTaskStatuses,
  graphArtifactProtection,
  protectedArtifacts,
} from './artifact-cleanup-protection';

export interface ArtifactRetentionPolicy {
  maxBuilds: number;
  maxDays: number;
}

export interface ArtifactRetentionScope {
  projectId?: string;
  serviceId?: string;
  environmentId?: string;
}

const prefix = 'artifacts:retention';
const retentionLock = 'artifacts:cleanup-lock';
const defaults: Readonly<ArtifactRetentionPolicy> = { maxBuilds: 20, maxDays: 30 };
const day = 86_400_000;
export const artifactCleanupBatch = 50;

function settingsKey(scope?: ArtifactRetentionScope) {
  if (scope?.environmentId) return `${prefix}:${scope.serviceId}:${scope.environmentId}`;
  if (scope?.serviceId) return `${prefix}:service:${scope.serviceId}`;
  if (scope?.projectId) return `${prefix}:project:${scope.projectId}`;
  return prefix;
}

function policyFor(policies: Map<string, ArtifactRetentionPolicy>, scope?: ArtifactRetentionScope) {
  return (
    policies.get(settingsKey(scope)) ??
    (scope?.environmentId
      ? policies.get(settingsKey({ serviceId: scope.serviceId }))
      : undefined) ??
    (scope?.projectId ? policies.get(settingsKey({ projectId: scope.projectId })) : undefined) ??
    policies.get(prefix) ??
    defaults
  );
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
        'artifacts.project_id',
        'artifacts.graph_run_id',
        'artifacts.logical_artifact_id',
        'artifacts.service_id',
        'artifacts.pipeline_run_id',
        'artifacts.storage_type',
        'artifacts.storage_key',
        'artifacts.archive_key',
        'artifacts.registry_id',
        'artifacts.image_digest',
        'artifacts.pinned_at',
        'artifacts.pruned_at',
        'artifacts.size_bytes',
        'artifacts.created_at',
        'pipeline_runs.environment_id',
        'tasks.status as taskStatus',
      ])
      .where((eb) =>
        eb.or([
          eb('artifacts.pruned_at', 'is', null),
          eb('artifacts.storage_type', '=', 'REGISTRY_IMAGE'),
        ]),
      )
      .where('artifacts.physical_json', 'is', null)
      .where('artifacts.temporary_root_id', 'is', null)
      .where('artifacts.lifecycle_state', '=', 'ACTIVE')
      .orderBy('artifacts.created_at', 'desc')
      .orderBy('artifacts.id', 'desc')
      .execute(),
  ]);
  if (artifacts.length) {
    const graph = await graphArtifactProtection(
      db,
      artifacts.map(({ project_id }) => project_id),
      artifacts.flatMap(({ graph_run_id }) => (graph_run_id ? [graph_run_id] : [])),
      [],
    );
    for (const row of artifacts)
      if (
        graph.references.has(row.id) ||
        graph.references.has(row.logical_artifact_id ?? row.id) ||
        (row.graph_run_id && graph.activeProduction.has(row.graph_run_id))
      )
        protectedIds.add(row.id);
  }
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
    const policy = policyFor(policies, {
      projectId: a.project_id,
      serviceId: a.service_id,
      environmentId: a.environment_id ?? undefined,
    });
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
    const key = a.pruned_at === null ? archiveKey(a) : null;
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
        !activeArtifactTaskStatuses.includes(a.taskStatus) &&
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
  private nextTemporaryScanAt = 0;
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly cleanup?: ArtifactCleanupService,
  ) {}

  private async checkScope(db: Kysely<Database>, scope?: ArtifactRetentionScope) {
    if (!scope) return;
    const service = scope.serviceId
      ? await db
          .selectFrom('services')
          .select('project_id')
          .where('id', '=', scope.serviceId)
          .executeTakeFirst()
      : undefined;
    if (
      scope.serviceId &&
      (!service || (scope.projectId && service.project_id !== scope.projectId))
    )
      throw new NotFoundException('项目服务不存在');
    const projectId = service?.project_id ?? scope.projectId;
    const project = projectId
      ? await db
          .selectFrom('projects')
          .select('id')
          .where('id', '=', projectId)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()
      : undefined;
    if (!project) throw new NotFoundException('项目不存在');
    if (scope.environmentId) {
      const match = await db
        .selectFrom('environments')
        .select('id')
        .where('project_id', '=', project.id)
        .where('id', '=', scope.environmentId)
        .executeTakeFirst();
      if (!match) throw new NotFoundException('服务环境不存在');
    }
    return { ...scope, projectId: project.id };
  }

  async settings(scope?: ArtifactRetentionScope) {
    const resolved = await this.checkScope(this.database.db, scope);
    const policies = await retentionPolicies(this.database.db);
    const own = policies.get(settingsKey(resolved));
    return {
      ...policyFor(policies, resolved),
      inherited: Boolean(resolved && !own),
    };
  }

  async configure(
    policy: ArtifactRetentionPolicy | null,
    userId: string,
    scope?: ArtifactRetentionScope,
  ) {
    if (!policy && !scope) throw new BadRequestException('全局产物保留策略需要配置限制');
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await reserveCleanup(tx);
      const resolved = await this.checkScope(tx, scope);
      const key = settingsKey(resolved);
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
      await lockProjectGraph(tx);
      const rows = await tx
        .selectFrom('artifacts')
        .select(['id', 'temporary_root_id'])
        .where((eb) => eb.or([eb('id', '=', id), eb('logical_artifact_id', '=', id)]))
        .where('lifecycle_state', '!=', 'DELETED')
        .orderBy('id')
        .execute();
      if (!rows.length) throw new NotFoundException('产物不存在或已清理');
      if (rows.some(({ temporary_root_id }) => temporary_root_id !== null))
        throw new ConflictException('运行临时产物随本次运行保留，不能单独固定');
      const ids = rows.map((row) => row.id);
      await lockAvailableArtifacts(tx, ids);
      const pinnedAt = pinned ? Date.now() : null;
      await tx
        .updateTable('artifacts')
        .set({ pinned_at: pinnedAt })
        .where('id', 'in', ids)
        .execute();
      await this.audit.record(
        userId,
        pinned ? 'artifact.pin' : 'artifact.unpin',
        'artifact',
        id,
        { instanceIds: ids },
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
    if (preview.total && this.cleanup) {
      const refs = preview.candidates
        .flatMap(({ artifactIds }) =>
          artifactIds.map((artifactId) => ({ artifactId, instanceId: artifactId })),
        )
        .slice(0, 500);
      const plan = await this.cleanup.preview(refs);
      if (plan.eligibleCount)
        await this.cleanup.confirm(refs, plan.planDigest, 'archives:' + plan.planDigest, null);
    } else if (preview.total) {
      await this.prune(
        preview.candidates.map((candidate) => candidate.artifactIds[0]!),
        null,
      );
    }
    await this.queuePhysicalRetention(true);
  }

  async tickCleanup(signal: AbortSignal) {
    if (signal.aborted) return;
    const now = Date.now();
    if (now >= this.nextTemporaryScanAt) {
      this.nextTemporaryScanAt = now + 60_000;
      await this.queuePhysicalRetention(false, now);
    }
    await this.cleanup?.tick(signal);
  }

  private async queuePhysicalRetention(includesPersistent: boolean, now = Date.now()) {
    if (!this.cleanup) return;
    const db = this.database.db;
    const rows = await db
      .selectFrom('artifacts as artifact')
      .leftJoin('execution_flow_runs as root', 'root.id', 'artifact.temporary_root_id')
      .leftJoin('pipeline_runs as build', 'build.id', 'artifact.pipeline_run_id')
      .leftJoin('tasks as task', 'task.id', 'build.task_id')
      .select([
        'artifact.id',
        'artifact.logical_artifact_id',
        'artifact.project_id',
        'artifact.service_id',
        'artifact.pipeline_run_id',
        'artifact.created_at',
        'artifact.temporary_root_id',
        'artifact.pinned_at',
        'task.status as taskStatus',
      ])
      .where('artifact.lifecycle_state', '=', 'ACTIVE')
      .where((eb) =>
        eb.or([
          eb.and([
            eb('artifact.temporary_root_id', 'is not', null),
            eb('root.status', 'in', [
              'SUCCESS',
              'FAILED',
              'PARTIAL_FAILED',
              'TIMED_OUT',
              'CANCELLED',
            ]),
          ]),
          ...(includesPersistent
            ? [
                eb.and([
                  eb('artifact.temporary_root_id', 'is', null),
                  eb('artifact.physical_json', 'is not', null),
                ]),
              ]
            : []),
        ]),
      )
      .orderBy('artifact.created_at', 'desc')
      .orderBy('artifact.id', 'desc')
      .execute();
    if (!rows.length) return;
    const policies = await retentionPolicies(db);
    const ranks = new Map<string, Map<string, number>>();
    const candidates = rows.filter((row) => {
      if (row.temporary_root_id) return true;
      const scope = { projectId: row.project_id, serviceId: row.service_id };
      const policy = policyFor(policies, scope);
      const key = settingsKey(scope);
      const perScope = ranks.get(key) ?? new Map<string, number>();
      ranks.set(key, perScope);
      let rank = 0;
      if (row.pipeline_run_id && ['SUCCESS', 'PARTIAL_FAILED'].includes(row.taskStatus ?? '')) {
        if (!perScope.has(row.pipeline_run_id))
          perScope.set(row.pipeline_run_id, perScope.size + 1);
        rank = perScope.get(row.pipeline_run_id)!;
      }
      return (
        row.pinned_at === null &&
        (rank > policy.maxBuilds || row.created_at < now - policy.maxDays * day)
      );
    });
    for (let offset = candidates.length; offset > 0; offset -= artifactCleanupBatch) {
      const batch = candidates.slice(Math.max(0, offset - artifactCleanupBatch), offset);
      const refs = batch.map((row) => ({
        artifactId: row.logical_artifact_id ?? row.id,
        instanceId: row.id,
      }));
      const plan = await this.cleanup.preview(refs);
      if (!plan.eligibleCount) continue;
      await this.cleanup.confirm(refs, plan.planDigest, 'retention:' + plan.planDigest, null);
      break;
    }
  }

  private async deleteRetiredArchives(ids?: string[], now = Date.now()) {
    if (ids && !ids.length)
      return { pruned: [], failed: [] } as { pruned: string[]; failed: string[] };
    const db = this.database.db;
    let query = db
      .selectFrom('artifacts')
      .select(['id', 'storage_type', 'storage_key', 'archive_key'])
      .where('pruned_at', 'is not', null)
      .where('archive_deleted_at', 'is', null)
      .where('physical_json', 'is', null)
      .where('lifecycle_state', '=', 'ACTIVE');
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
        const removed = await db.transaction().execute(async (tx) => {
          await lockProjectGraph(tx);
          const live = (await archivePeers(tx, key)).some(
            (row) => row.pruned_at === null || row.lifecycle_state === 'CLEANING',
          );
          if (live) return false;
          await removeArtifactArchive(key);
          await tx
            .updateTable('artifacts')
            .set({ archive_deleted_at: now })
            .where('id', 'in', members)
            .execute();
          return true;
        });
        if (removed) pruned.push(...members);
        else failed.push(...members);
      } catch {
        failed.push(...members);
      }
    }
    return { pruned, failed };
  }

  async prune(ids: string[], userId: string | null, now = Date.now()) {
    const retired = await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
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
