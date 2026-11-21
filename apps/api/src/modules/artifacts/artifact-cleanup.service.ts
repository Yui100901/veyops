import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kysely, Selectable } from 'kysely';
import { dataDirectory } from '../../core/config';
import { DatabaseService } from '../../core/database/database.service';
import type {
  ArtifactCleanupItemsTable,
  ArtifactsTable,
  Database,
} from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { lockProjectGraph } from '../projects/project-relations';
import { archiveKey, lockAvailableArtifacts } from './artifact-availability';
import {
  activeArtifactTaskStatuses,
  graphArtifactProtection,
  protectedArtifacts,
} from './artifact-cleanup-protection';
import { ArtifactPhysicalService, type ArtifactPhysical } from './artifact-physical.service';

type Db = Kysely<Database>;
type ArtifactRow = Selectable<ArtifactsTable>;
type Action = ArtifactCleanupItemsTable['action'];
type CleanupResult = { status: 'DELETED' | 'RETAINED' | 'RETRY'; reason?: string };
type ArchiveIdentity = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'>;

export interface ArtifactCleanupRef {
  artifactId: string;
  instanceId?: string;
}

const leaseMs = 150_000;
const retryLimit = 5;
const maxInstances = 500;
const missing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const logicalId = (row: ArtifactRow) => row.logical_artifact_id ?? row.id;
const physicalOf = (row: ArtifactRow) =>
  row.physical_json ? (JSON.parse(row.physical_json) as ArtifactPhysical) : undefined;
const cleanupKey = (row: ArtifactRow) =>
  row.physical_key
    ? 'physical:' + row.physical_key
    : archiveKey(row)
      ? 'archive:' + archiveKey(row)
      : 'reference:' + row.id;

const sameArchive = (left: ArchiveIdentity, right: ArchiveIdentity) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

async function archiveEntry(key: string) {
  const root = join(await realpath(dataDirectory), 'artifacts');
  if ((await realpath(root)) !== root) throw new Error('Unsafe artifact directory');
  const file = join(root, key);
  const entry = await lstat(file);
  if (!entry.isFile() || (await realpath(file)) !== file) throw new Error('Unsafe artifact path');
  return { file, entry };
}

async function verifiedArchiveIdentity(key: string, row: ArtifactRow, signal: AbortSignal) {
  try {
    const { file, entry } = await archiveEntry(key);
    if (!row.checksum || !/^[a-f0-9]{64}$/.test(row.checksum) || row.size_bytes !== entry.size)
      throw new ConflictException('归档大小或校验信息与登记记录不符');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const hash = createHash('sha256');
      if (!sameArchive(entry, await handle.stat())) throw new ConflictException('归档位置已被替换');
      for await (const chunk of handle.createReadStream({ autoClose: false, signal }))
        hash.update(chunk);
      if (!sameArchive(entry, await handle.stat()) || hash.digest('hex') !== row.checksum)
        throw new ConflictException('归档内容或身份已变化');
    } finally {
      await handle.close();
    }
    return entry;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function removeArtifactArchive(key: string, identity?: ArchiveIdentity | null) {
  try {
    const { file, entry } = await archiveEntry(key);
    if (identity === null || (identity && !sameArchive(entry, identity)))
      throw new ConflictException('归档在清理前已被替换');
    await unlink(file);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function visibleInstance(row: ArtifactRow) {
  const physical = physicalOf(row);
  return {
    artifactId: logicalId(row),
    instanceId: row.id,
    location: physical?.location ?? (archiveKey(row) ? 'BUILDER_PATH' : row.storage_type),
    path: physical?.path,
    serverId: row.server_id,
    ownership: physical?.owner ?? (archiveKey(row) ? 'MANAGED' : 'EXTERNAL'),
  };
}

export async function archivePeers(db: Db, key: string) {
  const candidates = await db
    .selectFrom('artifacts')
    .selectAll()
    .where('lifecycle_state', '!=', 'DELETED')
    .where('archive_deleted_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb('archive_key', '=', key),
        eb('storage_key', '=', key),
        eb('storage_key', 'like', '%/' + key),
        eb('storage_key', 'like', '%\\' + key),
      ]),
    )
    .execute();
  return candidates.filter((row) => archiveKey(row) === key);
}

@Injectable()
export class ArtifactCleanupService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly physical: ArtifactPhysicalService,
  ) {}

  private async resolve(db: Db, refs: readonly ArtifactCleanupRef[]) {
    const ids = [
      ...new Set(
        refs.flatMap(({ artifactId, instanceId }) =>
          instanceId ? [artifactId, instanceId] : [artifactId],
        ),
      ),
    ];
    if (!ids.length) throw new BadRequestException('至少需要选择一个产物');
    const rows = await db
      .selectFrom('artifacts')
      .selectAll()
      .where((eb) => eb.or([eb('id', 'in', ids), eb('logical_artifact_id', 'in', ids)]))
      .orderBy('id')
      .limit(maxInstances + 1)
      .execute();
    const selected = new Map<string, ArtifactRow>();
    for (const ref of refs) {
      const matches = rows.filter(
        (row) =>
          (row.id === ref.artifactId || row.logical_artifact_id === ref.artifactId) &&
          (!ref.instanceId || row.id === ref.instanceId),
      );
      if (!matches.length) throw new NotFoundException('未找到所选产物或实例');
      for (const row of matches) selected.set(row.id, row);
    }
    if (rows.length > maxInstances) throw new BadRequestException('请分批清理所选产物实例');
    return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private async plan(db: Db, refs: readonly ArtifactCleanupRef[]) {
    const rows = await this.resolve(db, refs);
    const keys = [...new Set(rows.flatMap((row) => (row.physical_key ? [row.physical_key] : [])))];
    const [deployments, graph, peers, builds] = await Promise.all([
      protectedArtifacts(db),
      graphArtifactProtection(
        db,
        rows.map(({ project_id }) => project_id),
        rows.flatMap(({ graph_run_id }) => (graph_run_id ? [graph_run_id] : [])),
        rows.flatMap(({ temporary_root_id }) => (temporary_root_id ? [temporary_root_id] : [])),
      ),
      keys.length
        ? db
            .selectFrom('artifacts')
            .selectAll()
            .where('physical_key', 'in', keys)
            .where('lifecycle_state', '!=', 'DELETED')
            .execute()
        : [],
      db
        .selectFrom('pipeline_runs as build')
        .innerJoin('tasks as task', 'task.id', 'build.task_id')
        .select('build.id')
        .where('task.status', 'in', activeArtifactTaskStatuses)
        .where(
          'build.id',
          'in',
          rows.flatMap(({ pipeline_run_id }) => (pipeline_run_id ? [pipeline_run_id] : [''])),
        )
        .execute(),
    ]);
    const activeBuilds = new Set(builds.map(({ id }) => id));
    const groupedPeers = new Map<string, ArtifactRow[]>();
    for (const row of peers) {
      const key = cleanupKey(row);
      const group = groupedPeers.get(key) ?? [];
      group.push(row);
      groupedPeers.set(key, group);
    }
    for (const key of new Set(
      rows.flatMap((row) => (!row.physical_key && archiveKey(row) ? [archiveKey(row)!] : [])),
    ))
      groupedPeers.set('archive:' + key, await archivePeers(db, key));

    const candidates = rows.map((row) => {
      let reason: string | undefined;
      if (
        row.lifecycle_state !== 'ACTIVE' ||
        (row.pruned_at !== null && row.storage_type !== 'REGISTRY_IMAGE')
      )
        reason = '实例已清理或正在处理';
      else if (row.pinned_at !== null) reason = '实例已固定保留';
      else if (
        (groupedPeers.get(cleanupKey(row)) ?? []).some(
          ({ lifecycle_state }) => lifecycle_state === 'CLEANING',
        )
      )
        reason = '共享实物正在清理';
      else if (deployments.has(row.id)) reason = '活动部署、回滚基线或执行任务引用了实例';
      else if (graph.references.has(row.id) || graph.references.has(logicalId(row)))
        reason = '已发布的图或在途运行引用了产物';
      else if (row.temporary_root_id && graph.activeTemporaryRoots.has(row.temporary_root_id))
        reason = '临时产物的根运行或子流仍在进行';
      else if (
        (row.graph_run_id && graph.activeProduction.has(row.graph_run_id)) ||
        (row.pipeline_run_id && activeBuilds.has(row.pipeline_run_id))
      )
        reason = '生产任务或所属执行流仍在进行';
      else if (row.physical_json && !row.physical_key) reason = '缺少可核对的实物身份';
      return { row, reason, eligible: !reason };
    });
    const eligible = new Set(candidates.filter((entry) => entry.eligible).map(({ row }) => row.id));
    const entries = candidates.map(({ row, eligible: allowed, reason }) => {
      const key = cleanupKey(row);
      const shared = (groupedPeers.get(key) ?? []).some((peer) => !eligible.has(peer.id));
      const canRemove =
        physicalOf(row)?.owner === 'MANAGED' || (!row.physical_json && Boolean(archiveKey(row)));
      const action: Action = canRemove && !shared ? 'REMOVE' : 'DETACH';
      return {
        row,
        key,
        action,
        eligible: allowed,
        reason:
          reason ??
          (shared ? '共享实物将保留' : action === 'DETACH' ? '只解除外部引用' : undefined),
      };
    });
    return {
      entries,
      eligibleCount: eligible.size,
      planDigest: digest(
        entries.map(({ row, key, action, eligible, reason }) => ({
          id: row.id,
          key,
          action,
          eligible,
          reason,
          physical: row.physical_json,
          checksum: row.checksum,
          archive: archiveKey(row),
        })),
      ),
    };
  }

  async preview(refs: readonly ArtifactCleanupRef[]) {
    const plan = await this.plan(this.database.db, refs);
    return {
      planDigest: plan.planDigest,
      eligibleCount: plan.eligibleCount,
      instances: plan.entries.map(({ row, action, eligible, reason }) => ({
        ...visibleInstance(row),
        action,
        eligible,
        reason,
        status: row.lifecycle_state,
      })),
    };
  }

  async confirm(
    refs: readonly ArtifactCleanupRef[],
    planDigest: string,
    idempotencyKey: string,
    userId: string | null,
  ) {
    const requestKey = digest([userId, idempotencyKey]);
    const canonicalRefs = [
      ...new Set(
        refs.map(({ artifactId, instanceId }) => JSON.stringify([artifactId, instanceId ?? null])),
      ),
    ].sort();
    const requestHash = digest([planDigest, canonicalRefs]);
    const id = await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const previous = await tx
        .selectFrom('artifact_cleanup_jobs')
        .select(['id', 'request_hash'])
        .where('request_key', '=', requestKey)
        .executeTakeFirst();
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new ConflictException('清理幂等键已用于不同的计划');
        return previous.id;
      }
      const plan = await this.plan(tx, refs);
      if (plan.planDigest !== planDigest)
        throw new ConflictException('清理候选或保护状态已变化，请重新预览');
      if (!plan.eligibleCount) throw new ConflictException('所选产物均受保护或已清理');
      const ids = plan.entries.filter(({ eligible }) => eligible).map(({ row }) => row.id);
      await lockAvailableArtifacts(tx, ids);
      const confirmed = await this.plan(tx, refs);
      if (confirmed.planDigest !== planDigest)
        throw new ConflictException('清理候选或保护状态已变化，请重新预览');
      const now = Date.now();
      const id = randomUUID();
      await tx
        .insertInto('artifact_cleanup_jobs')
        .values({
          id,
          request_key: requestKey,
          request_hash: requestHash,
          requested_by: userId,
          authorized_by: userId,
          created_at: now,
        })
        .execute();
      await tx
        .updateTable('artifacts')
        .set({ lifecycle_state: 'CLEANING' })
        .where('id', 'in', ids)
        .execute();
      await tx
        .insertInto('artifact_cleanup_items')
        .values(
          confirmed.entries.map((entry) => ({
            job_id: id,
            instance_id: entry.row.id,
            artifact_id: logicalId(entry.row),
            group_key: entry.key,
            action: entry.action,
            status: entry.eligible ? 'PENDING' : 'RETAINED',
            attempts: 0,
            cycle_attempts: 0,
            reason: entry.reason ?? null,
            available_at: entry.eligible ? now : null,
            lease_id: null,
            lease_until: null,
            updated_at: now,
          })),
        )
        .execute();
      await this.audit.record(
        userId,
        'artifact.cleanup.queue',
        'artifact-cleanup',
        id,
        { instanceIds: ids },
        tx,
      );
      return id;
    });
    return this.get(id);
  }

  async get(id: string) {
    const db = this.database.db;
    const job = await db
      .selectFrom('artifact_cleanup_jobs')
      .select(['id', 'created_at', 'requested_by'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!job) throw new NotFoundException('清理任务不存在');
    const results = await db
      .selectFrom('artifact_cleanup_items as item')
      .innerJoin('artifacts', 'artifacts.id', 'item.instance_id')
      .selectAll('artifacts')
      .select([
        'item.status as itemStatus',
        'item.action',
        'item.attempts',
        'item.reason',
        'item.available_at as retryAt',
      ])
      .where('item.job_id', '=', id)
      .orderBy('item.instance_id')
      .execute();
    const statuses = new Set(results.map((row) => row.itemStatus));
    const status = statuses.has('RUNNING')
      ? 'RUNNING'
      : statuses.has('PENDING')
        ? 'PENDING'
        : statuses.has('RETRY')
          ? 'RETRY'
          : 'COMPLETE';
    return {
      id,
      status,
      createdAt: job.created_at,
      requestedBy: job.requested_by,
      instances: results.map((row) => ({
        ...visibleInstance(row),
        status: row.itemStatus,
        action: row.action,
        attempts: row.attempts,
        reason: row.reason,
        retryAt: row.retryAt,
      })),
    };
  }

  async retry(id: string, userId: string) {
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const job = await tx
        .selectFrom('artifact_cleanup_jobs')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!job) throw new NotFoundException('清理任务不存在');
      const now = Date.now();
      const items = await tx
        .updateTable('artifact_cleanup_items')
        .set({ status: 'PENDING', cycle_attempts: 0, available_at: now, updated_at: now })
        .where('job_id', '=', id)
        .where('status', '=', 'RETRY')
        .returning('instance_id')
        .execute();
      if (items.length) {
        await tx
          .updateTable('artifact_cleanup_jobs')
          .set({ authorized_by: userId })
          .where('id', '=', id)
          .execute();
        await this.audit.record(
          userId,
          'artifact.cleanup.retry',
          'artifact-cleanup',
          id,
          {
            instanceIds: items.map(({ instance_id }) => instance_id),
          },
          tx,
        );
      }
    });
    return this.get(id);
  }

  private async claim() {
    return this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const now = Date.now();
      const item = await tx
        .selectFrom('artifact_cleanup_items')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([eb('status', 'in', ['PENDING', 'RETRY']), eb('available_at', '<=', now)]),
            eb.and([eb('status', '=', 'RUNNING'), eb('lease_until', '<=', now)]),
          ]),
        )
        .orderBy('updated_at')
        .orderBy('instance_id')
        .limit(1)
        .executeTakeFirst();
      if (!item) return undefined;
      const lease = randomUUID();
      const group = await tx
        .updateTable('artifact_cleanup_items')
        .set((eb) => ({
          status: 'RUNNING',
          attempts: eb('attempts', '+', 1),
          cycle_attempts: eb('cycle_attempts', '+', 1),
          available_at: null,
          lease_id: lease,
          lease_until: now + leaseMs,
          updated_at: now,
        }))
        .where('job_id', '=', item.job_id)
        .where('group_key', '=', item.group_key)
        .where((eb) =>
          eb.or([
            eb('status', 'in', ['PENDING', 'RETRY']),
            eb.and([eb('status', '=', 'RUNNING'), eb('lease_until', '<=', now)]),
          ]),
        )
        .returningAll()
        .execute();
      if (!group.length) return undefined;
      const artifacts = await tx
        .selectFrom('artifacts')
        .selectAll()
        .where(
          'id',
          'in',
          group.map(({ instance_id }) => instance_id),
        )
        .orderBy('id')
        .execute();
      const job = await tx
        .selectFrom('artifact_cleanup_jobs')
        .select('authorized_by')
        .where('id', '=', item.job_id)
        .executeTakeFirstOrThrow();
      return { jobId: item.job_id, lease, group, artifacts, userId: job.authorized_by };
    });
  }

  async tick(signal: AbortSignal) {
    if (signal.aborted) return;
    const work = await this.claim();
    if (!work) return;
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    const db = this.database.db;
    let heartbeat: Promise<void> | undefined;
    const timer = setInterval(() => {
      heartbeat ??= db
        .updateTable('artifact_cleanup_items')
        .set({ lease_until: Date.now() + leaseMs })
        .where('lease_id', '=', work.lease)
        .where('status', '=', 'RUNNING')
        .executeTakeFirst()
        .then(({ numUpdatedRows }) => {
          if (Number(numUpdatedRows) !== work.group.length) controller.abort();
        })
        .catch(() => controller.abort())
        .finally(() => {
          heartbeat = undefined;
        });
    }, 15_000);
    timer.unref();
    let result: CleanupResult;
    const archives = new Map<string, ArchiveIdentity | null>();
    try {
      const selectedIds = new Set(work.artifacts.map(({ id }) => id));
      for (const row of work.artifacts) {
        const key = archiveKey(row);
        if (!key || archives.has(key)) continue;
        const shared = (await archivePeers(db, key)).some((entry) => !selectedIds.has(entry.id));
        if (!shared) archives.set(key, await verifiedArchiveIdentity(key, row, active));
      }
      result = await this.remove(work, active);
    } catch (error) {
      result = {
        status: 'RETRY',
        reason: error instanceof ConflictException ? error.message : '无法完成实物核对或清理',
      };
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
    if (active.aborted) result = { status: 'RETRY', reason: '清理中断，下次执行时重新核对实物' };
    await this.finish(work, result, archives);
  }

  private async remove(
    work: NonNullable<Awaited<ReturnType<ArtifactCleanupService['claim']>>>,
    signal: AbortSignal,
  ): Promise<CleanupResult> {
    const db = this.database.db;
    if (work.artifacts.some(({ lifecycle_state }) => lifecycle_state !== 'CLEANING'))
      return { status: 'RETAINED', reason: '实例已退出清理状态' };
    if (work.userId) {
      const admin = await db
        .selectFrom('users')
        .select('id')
        .where('id', '=', work.userId)
        .where('role', '=', 'ADMIN')
        .where('status', '=', 'ACTIVE')
        .where('must_change_password', '=', 0)
        .executeTakeFirst();
      if (!admin) return { status: 'RETAINED', reason: '申请人已失去清理权限' };
    }
    const removing = work.artifacts.find((row) =>
      work.group.some((item) => item.instance_id === row.id && item.action === 'REMOVE'),
    );
    if (!removing) return { status: 'DELETED', reason: '已解除共享或外部引用，实物保留' };
    const physical = physicalOf(removing);
    if (!physical) return { status: 'DELETED' };
    if (signal.aborted) return { status: 'RETRY', reason: '清理已中断' };
    return this.physical.remove(physical, undefined, signal);
  }

  private async finish(
    work: NonNullable<Awaited<ReturnType<ArtifactCleanupService['claim']>>>,
    result: CleanupResult,
    archives: ReadonlyMap<string, ArchiveIdentity | null>,
  ) {
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const leased = await tx
        .selectFrom('artifact_cleanup_items')
        .select('instance_id')
        .where('lease_id', '=', work.lease)
        .where('status', '=', 'RUNNING')
        .execute();
      if (leased.length !== work.group.length) return;
      const ids = new Set(leased.map(({ instance_id }) => instance_id));
      const now = Date.now();
      if (result.status === 'DELETED') {
        // Archive deletion uses the same graph lock. SSH and Docker calls happen before this transaction.
        for (const [key, identity] of archives) {
          const peers = await archivePeers(tx, key);
          if (peers.some((row) => !ids.has(row.id))) continue;
          try {
            await removeArtifactArchive(key, identity);
            await tx
              .updateTable('artifacts')
              .set({ archive_deleted_at: now })
              .where(
                'id',
                'in',
                peers.map(({ id }) => id),
              )
              .execute();
          } catch {
            result = { status: 'RETRY', reason: '无法清理管理端归档' };
            break;
          }
        }
      }
      if (result.status !== 'RETRY')
        await tx
          .updateTable('artifacts')
          .set(
            result.status === 'DELETED'
              ? { lifecycle_state: 'DELETED', pruned_at: now }
              : { lifecycle_state: 'ACTIVE' },
          )
          .where('id', 'in', [...ids])
          .where('lifecycle_state', '=', 'CLEANING')
          .execute();
      const attempts = Math.max(...work.group.map(({ cycle_attempts }) => cycle_attempts));
      await tx
        .updateTable('artifact_cleanup_items')
        .set({
          status: result.status,
          reason: result.reason ?? null,
          lease_id: null,
          lease_until: null,
          available_at:
            result.status === 'RETRY' && attempts < retryLimit
              ? now + 15_000 * 2 ** (attempts - 1)
              : null,
          updated_at: now,
        })
        .where('lease_id', '=', work.lease)
        .execute();
      await this.audit.record(
        work.userId,
        'artifact.cleanup.result',
        'artifact-cleanup',
        work.jobId,
        {
          instanceIds: [...ids],
          status: result.status,
          reason: result.reason ?? null,
        },
        tx,
      );
    });
  }
}
