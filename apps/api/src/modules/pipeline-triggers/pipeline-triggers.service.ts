import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import {
  normalizeScheduleTiming,
  type ScheduleTiming,
  upcomingTimes,
} from '../operation-schedules/operation-schedule-time';
import { PipelinesService } from '../pipelines/pipelines.service';
import { isGitBranchName } from '../projects/git-ref';
import { RepositoryMetadataService } from '../projects/repository-metadata.service';
import type { DeploymentSelectionDto } from '../deployment-targets/deployment-selection';
import { PipelineTriggerDto, SavePipelineTriggerDto } from './pipeline-trigger.dto';
import { commitTriggerKey, recordPipelineTrigger, type TriggerEvent } from './trigger-history';

type Rule = Selectable<Database['pipeline_triggers']>;
type Occurrence = Rule & { lease_id: string; next_at: number };
class StaleBinding extends ConflictException {}
class LeaseLost extends Error {}
const onTimeGrace = 5000;
const leaseDuration = 120_000;

function repositoryHash(row: { clone_url: string; credential_id: string | null }) {
  return createHash('sha256')
    .update(JSON.stringify([row.clone_url, row.credential_id]))
    .digest('hex');
}

function targets(row: Rule): DeploymentSelectionDto {
  return row.target_json ? (JSON.parse(row.target_json) as DeploymentSelectionDto) : {};
}

function present(row: Rule) {
  return {
    id: row.id,
    kind: row.kind,
    target: targets(row),
    environmentId: row.environment_id,
    version: row.version,
    branch: row.branch,
    timing: JSON.parse(row.timing_json) as ScheduleTiming,
    buildCurrent: Boolean(row.build_current),
    mode: row.mode,
    status: row.status,
    reason: row.reason,
    nextAt: row.next_at,
    baselineSha: row.baseline_sha,
  };
}
@Injectable()
export class PipelineTriggersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly pipelines: PipelinesService,
    private readonly metadata: RepositoryMetadataService,
    private readonly audit: AuditService,
  ) {}

  async list(pipelineId: string) {
    const rows = await this.database.db
      .selectFrom('pipeline_triggers')
      .leftJoin('environments', 'environments.id', 'pipeline_triggers.environment_id')
      .selectAll('pipeline_triggers')
      .select('environments.name as environmentName')
      .where('pipeline_id', '=', pipelineId)
      .orderBy('anchor_at', 'desc')
      .execute();
    return rows.map((row) => ({ ...present(row), environmentName: row.environmentName }));
  }

  history(pipelineId: string) {
    return this.database.db
      .selectFrom('pipeline_trigger_history')
      .selectAll()
      .where('pipeline_id', '=', pipelineId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
  }

  private async check(pipelineId: string, input: PipelineTriggerDto) {
    if (!isGitBranchName(input.branch) || input.branch.startsWith('refs/'))
      throw new BadRequestException('请输入有效的分支名称');
    const timing = normalizeScheduleTiming(input.timing);
    if (input.kind === 'POLL' && timing.type !== 'INTERVAL')
      throw new BadRequestException('分支轮询需要固定间隔');
    const now = Date.now();
    const upcoming = upcomingTimes(timing, now, now, 3);
    if (!upcoming.length) throw new BadRequestException('请输入未来的触发时间');
    const preview = await this.pipelines.preview(
      pipelineId,
      {
        ...input,
        environmentId: input.environmentId,
        version: input.version,
        commitSha: '0'.repeat(40),
        confirmed: true,
      },
      input.branch,
    );
    this.pipelines.assertAutomaticBuild(preview);
    const binding = preview.webhookConfigurationHash!;
    const repo = await this.database.db
      .selectFrom('repositories')
      .select(['clone_url', 'credential_id'])
      .where('id', '=', preview.definition.repositoryId)
      .where('project_id', '=', preview.projectId)
      .executeTakeFirstOrThrow();
    const accessHash = repositoryHash(repo);
    const target = input.targetId
      ? { targetId: input.targetId }
      : input.groupIds !== undefined || input.serverIds !== undefined
        ? preview.targetSelection
        : null;
    const configurationHash = createHash('sha256')
      .update(
        JSON.stringify([
          pipelineId,
          input.kind,
          input.environmentId,
          input.version,
          input.branch,
          binding,
          accessHash,
          timing,
          input.buildCurrent === true,
          target,
        ]),
      )
      .digest('hex');
    return { timing, upcoming, preview, binding, accessHash, configurationHash, target };
  }

  async preview(pipelineId: string, input: PipelineTriggerDto) {
    const { preview, upcoming, configurationHash } = await this.check(pipelineId, input);
    return {
      configurationHash,
      upcoming,
      mode: preview.mode,
      buildLocation: preview.definition.buildLocation,
      serverIds: preview.serverIds,
      requireApproval: preview.requireApproval,
    };
  }

  async save(pipelineId: string, input: SavePipelineTriggerDto, userId: string, ruleId?: string) {
    const { timing, preview, binding, accessHash, configurationHash, target } = await this.check(
      pipelineId,
      input,
    );
    if (configurationHash !== input.expectedConfigurationHash)
      throw new ConflictException('配置已变化，请重新预览后启用');
    const now = Date.now();
    const next = upcomingTimes(timing, now, now, 1)[0];
    if (!next) throw new BadRequestException('计划执行时间已过');
    const values = {
      pipeline_id: pipelineId,
      kind: input.kind,
      environment_id: input.environmentId,
      branch: input.branch,
      version: input.version,
      mode: preview.mode,
      owner_id: userId,
      repository_id: preview.definition.repositoryId,
      repository_hash: accessHash,
      configuration_hash: binding,
      timing_json: JSON.stringify(timing),
      target_json: target ? JSON.stringify(target) : null,
      build_current: input.buildCurrent ? 1 : 0,
      baseline_sha: null,
      status: 'ENABLED',
      reason: null,
      next_at: next,
      anchor_at: now,
      lease_id: null,
      lease_until: null,
      failures: 0,
    };
    const row = await this.database.db.transaction().execute(async (tx) => {
      await this.verifyAdmin(tx, userId);
      if (!ruleId)
        return tx
          .insertInto('pipeline_triggers')
          .values({ ...values, id: randomUUID() })
          .returningAll()
          .executeTakeFirstOrThrow();
      const row = await tx
        .updateTable('pipeline_triggers')
        .set(values)
        .where('id', '=', ruleId)
        .where('pipeline_id', '=', pipelineId)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new NotFoundException('触发规则不存在');
      return row;
    });
    await this.audit.record(userId, 'pipeline.trigger.save', 'pipeline', pipelineId, {
      ruleId: row.id,
      kind: row.kind,
      version: row.version,
    });
    return present(row);
  }

  async disable(pipelineId: string, ruleId: string, userId: string) {
    const rule = await this.database.db
      .updateTable('pipeline_triggers')
      .set({ status: 'DISABLED', reason: null, next_at: null, lease_id: null, lease_until: null })
      .where('pipeline_id', '=', pipelineId)
      .where('id', '=', ruleId)
      .returningAll()
      .executeTakeFirst();
    if (!rule) throw new NotFoundException('触发规则不存在');
    await this.audit.record(userId, 'pipeline.trigger.disable', 'pipeline', pipelineId, { ruleId });
    return present(rule);
  }

  private async verifyAdmin(tx: Transaction<Database>, id: string) {
    const row = await tx
      .updateTable('users')
      .set({ must_change_password: 0 })
      .where('id', '=', id)
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .where('must_change_password', '=', 0)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new ForbiddenException('触发规则的管理员已失效，请管理员重新确认');
  }

  private guard(tx: Transaction<Database>, rule: Occurrence) {
    return tx
      .updateTable('pipeline_triggers')
      .where('id', '=', rule.id)
      .where('lease_id', '=', rule.lease_id)
      .where('status', '=', 'ENABLED')
      .where('next_at', '=', rule.next_at);
  }

  private async finish(
    tx: Transaction<Database>,
    rule: Occurrence,
    now: number,
    event: Pick<TriggerEvent, 'status' | 'commitSha' | 'taskId' | 'reason'>,
    options: { baseline?: string; pause?: boolean; backoff?: boolean } = {},
  ) {
    const timing = JSON.parse(rule.timing_json) as ScheduleTiming;
    const failures = options.backoff ? rule.failures + 1 : 0;
    const after = Math.max(now, Date.now());
    let next = upcomingTimes(timing, rule.anchor_at, after, 1)[0] ?? null;
    if (failures && timing.type === 'INTERVAL' && next !== null) {
      const base = timing.intervalSeconds * 1000;
      const delay = Math.max(base, Math.min(3_600_000, base * 2 ** Math.min(failures, 12)));
      next = after + delay;
    }
    const row = await this.guard(tx, rule)
      .set({
        lease_id: null,
        lease_until: null,
        next_at: options.pause ? null : next,
        failures,
        status: options.pause ? 'PAUSED' : next ? 'ENABLED' : 'COMPLETED',
        reason: event.reason ?? null,
        ...(options.baseline && { baseline_sha: options.baseline }),
      })
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new LeaseLost();
    await recordPipelineTrigger(tx, {
      pipelineId: rule.pipeline_id,
      triggerId: rule.id,
      kind: rule.kind,
      mode: rule.mode,
      environmentId: rule.environment_id,
      branch: rule.branch,
      version: rule.version,
      scheduledAt: rule.next_at,
      ...event,
    });
  }

  async tick(now = Date.now()) {
    const due = await this.database.db
      .selectFrom('pipeline_triggers')
      .select(['id', 'next_at'])
      .where('status', '=', 'ENABLED')
      .where('next_at', '<=', now)
      .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', now)]))
      .orderBy('next_at')
      .limit(8)
      .execute();
    await Promise.all(
      due.map(async ({ id, next_at }) => {
        const leaseId = randomUUID();
        const row = await this.database.db
          .updateTable('pipeline_triggers')
          .set({ lease_id: leaseId, lease_until: now + leaseDuration })
          .where('id', '=', id)
          .where('status', '=', 'ENABLED')
          .where('next_at', '=', next_at)
          .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', now)]))
          .returningAll()
          .executeTakeFirst();
        if (row && next_at !== null)
          await this.evaluate({ ...row, lease_id: leaseId, next_at }, now);
      }),
    );
  }

  private async evaluate(rule: Occurrence, now: number) {
    let sha: string | undefined;
    let readingRepository = false;
    const finish = (
      event: Pick<TriggerEvent, 'status' | 'reason' | 'commitSha'>,
      options?: { baseline?: string; pause?: boolean; backoff?: boolean },
    ) => this.database.db.transaction().execute((tx) => this.finish(tx, rule, now, event, options));
    try {
      if (rule.kind === 'SCHEDULE' && now - rule.next_at > onTimeGrace) {
        await finish({ status: 'SKIPPED', reason: '错过计划时刻，已跳过漏跑时段' });
        return;
      }
      await this.database.db.transaction().execute((tx) => this.verifyAdmin(tx, rule.owner_id));
      const repository = await this.database.db
        .selectFrom('repositories')
        .select(['project_id', 'clone_url', 'credential_id'])
        .where('id', '=', rule.repository_id)
        .executeTakeFirst();
      if (!repository) throw new StaleBinding('绑定仓库已删除，请重新配置');
      if (repositoryHash(repository) !== rule.repository_hash)
        throw new StaleBinding('仓库地址或凭据已变化，请重新确认触发规则');
      readingRepository = true;
      sha = (
        await this.metadata.branchHeads(
          repository.project_id,
          rule.repository_id,
          [rule.branch],
          repository,
        )
      ).get(rule.branch);
      if (!sha) throw new BadRequestException('仓库分支不存在');
      readingRepository = false;
      const input = {
        ...targets(rule),
        version: rule.version,
        environmentId: rule.environment_id,
        commitSha: sha,
        confirmed: true,
      };
      const preview = await this.pipelines.preview(rule.pipeline_id, input, rule.branch);
      if (preview.webhookConfigurationHash !== rule.configuration_hash)
        throw new StaleBinding('绑定配置或目标已变化，请重新预览后启用');
      this.pipelines.assertAutomaticBuild(preview);
      if (
        rule.kind === 'POLL' &&
        ((!rule.baseline_sha && !rule.build_current) || rule.baseline_sha === sha)
      ) {
        await finish(
          {
            status: 'SKIPPED',
            reason: rule.baseline_sha ? '分支提交未变化' : '已建立首次轮询基线',
            commitSha: sha,
          },
          { baseline: sha },
        );
        return;
      }
      const key =
        rule.kind === 'POLL'
          ? commitTriggerKey(
              rule.pipeline_id,
              rule.version,
              rule.environment_id,
              rule.branch,
              sha,
              rule.configuration_hash,
            )
          : 'schedule:' + rule.id + ':' + rule.next_at;
      await this.pipelines.run(
        rule.pipeline_id,
        { ...input, expectedConfigurationHash: preview.configurationHash },
        rule.owner_id,
        {
          triggerType: rule.kind,
          gitRef: 'refs/heads/' + rule.branch,
          idempotencyKey: key,
          beforeInsert: async (tx) => {
            await this.verifyAdmin(tx, rule.owner_id);
            const locked = await this.guard(tx, rule)
              .set({ lease_id: rule.lease_id })
              .returning('id')
              .executeTakeFirst();
            if (!locked) throw new LeaseLost();
          },
          afterInsert: (tx, taskId, created) =>
            this.finish(
              tx,
              rule,
              now,
              { status: created ? 'QUEUED' : 'DUPLICATE', taskId, commitSha: sha },
              { baseline: rule.kind === 'POLL' ? sha : undefined },
            ),
        },
      );
    } catch (error) {
      if (error instanceof LeaseLost) return;
      const pause = error instanceof StaleBinding || error instanceof ForbiddenException;
      const reason =
        error instanceof HttpException && error.getStatus() < 500
          ? error.message
          : readingRepository
            ? '读取仓库分支失败，请检查网络及仓库凭据'
            : '本次触发未能完成，请检查有效配置';
      try {
        await finish(
          { status: 'FAILED', commitSha: sha, reason },
          { pause, backoff: !pause && rule.kind === 'POLL' },
        );
      } catch (finalError) {
        if (!(finalError instanceof LeaseLost)) throw finalError;
      }
    }
  }
}
