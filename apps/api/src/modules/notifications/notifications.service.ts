import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Transaction } from 'kysely';
import { encryptionKey } from '../../core/config';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import type { TaskPayload } from '../tasks/tasks.types';
import { meetsMinimum, NotificationMailService } from './notification-mail.service';
import { isAutomaticTrigger } from './notification.types';
import type {
  NotificationLevel,
  NotificationPreferencesDto,
  NotificationStage,
  NotificationSubscriptionDto,
  NotificationSummary,
  NotificationsQuery,
} from './notification.types';

const eligibleRoles = ['ADMIN', 'OPERATOR', 'VIEWER'];
const resultStatuses = ['SUCCESS', 'PARTIAL_FAILED', 'FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'];
const verificationTtl = 10 * 60 * 1000;
const verificationInterval = 60 * 1000;
const maxVerificationAttempts = 5;

function summarize(
  statuses: string[],
  deploymentSkipped: boolean,
  releases: string[] = [],
): NotificationSummary {
  const summary: NotificationSummary = {
    success: 0,
    failed: 0,
    skipped: 0,
    needsAttention: 0,
    deploymentSkipped,
    releases,
  };
  for (const status of statuses) {
    if (status === 'SUCCESS') summary.success++;
    else if (status === 'NEEDS_ATTENTION' || status === 'RUNNING') summary.needsAttention++;
    else if (status === 'FAILED' || status === 'PARTIAL_FAILED' || status === 'TIMED_OUT')
      summary.failed++;
    else summary.skipped++;
  }
  return summary;
}

function severity(stage: NotificationStage, status: string): NotificationLevel {
  if (status === 'SUCCESS') return stage === 'ROLLBACK' ? 'WARNING' : 'NORMAL';
  return status === 'PARTIAL_FAILED' && stage !== 'ROLLBACK' ? 'WARNING' : 'FAILURE';
}

function aggregateRollback(summary: NotificationSummary) {
  if (summary.needsAttention) return 'NEEDS_ATTENTION';
  if (summary.failed && summary.success) return 'PARTIAL_FAILED';
  return summary.success ? 'SUCCESS' : 'FAILED';
}

interface StageEvent {
  stage: NotificationStage;
  status: string;
  summary: NotificationSummary;
}

@Injectable()
export class NotificationsService implements OnApplicationBootstrap {
  constructor(
    private readonly database: DatabaseService,
    private readonly mail: NotificationMailService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.WORKER_ENABLED !== 'false') this.start();
  }

  start() {
    this.mail.start();
  }

  private async stageEvents(
    tx: Transaction<Database>,
    taskId: string,
    status: string,
    payload: TaskPayload,
    result: { deploymentTaskId?: string },
  ): Promise<StageEvent[]> {
    const targets = await tx
      .selectFrom('task_targets')
      .select('status')
      .where('task_id', '=', taskId)
      .execute();
    const statuses = targets.map((row) => row.status);
    if (payload.pipeline?.mode === 'BUILD_ONLY') {
      return [
        {
          stage: 'BUILD',
          status,
          summary: summarize(
            statuses,
            Boolean(payload.pipeline.deployAfterBuild && !result.deploymentTaskId),
          ),
        },
      ];
    }
    const rollbacks = await tx
      .selectFrom('deployment_records as d')
      .innerJoin('task_targets as t', 't.id', 'd.task_target_id')
      .where('t.task_id', '=', taskId)
      .where('d.rollback_of_deployment_id', 'is not', null)
      .select(['d.status', 'd.release_version'])
      .execute();
    const releases = [
      ...new Set(
        rollbacks.flatMap(({ status: releaseStatus, release_version }) =>
          releaseStatus === 'SUCCESS' && /^[a-f0-9]{40,64}$/i.test(release_version ?? '')
            ? [release_version!]
            : [],
        ),
      ),
    ].sort();
    if (payload.pipeline?.rollbackOfDeploymentId)
      return [{ stage: 'ROLLBACK', status, summary: summarize(statuses, false, releases) }];
    const events: StageEvent[] = [{ stage: 'DEPLOY', status, summary: summarize(statuses, false) }];
    if (rollbacks.length) {
      const summary = summarize(
        rollbacks.map((row) => row.status),
        false,
        releases,
      );
      events.push({ stage: 'ROLLBACK', status: aggregateRollback(summary), summary });
    }
    return events;
  }

  async recordTaskCompletion(tx: Transaction<Database>, taskId: string, now: number) {
    const task = await tx
      .selectFrom('tasks')
      .innerJoin('projects', 'projects.id', 'tasks.project_id')
      .where('tasks.id', '=', taskId)
      .where('tasks.task_type', '=', 'PIPELINE')
      .where('tasks.status', 'in', resultStatuses)
      .where('projects.deleted_at', 'is', null)
      .select([
        'tasks.project_id',
        'tasks.service_id',
        'tasks.environment_id',
        'tasks.created_by',
        'tasks.status',
        'tasks.payload_json',
        'tasks.result_json',
      ])
      .executeTakeFirst();
    if (!task?.project_id) return;
    const payload = JSON.parse(task.payload_json) as TaskPayload;
    if (!payload.pipeline) return;
    const automated = isAutomaticTrigger(payload.pipeline.triggerType);
    const result = JSON.parse(task.result_json ?? '{}') as { deploymentTaskId?: string };
    for (const event of await this.stageEvents(tx, taskId, task.status, payload, result)) {
      const level = severity(event.stage, event.status);
      const stored = await tx
        .insertInto('notification_events')
        .values({
          id: randomUUID(),
          task_id: taskId,
          project_id: task.project_id,
          service_id: task.service_id,
          environment_id: task.environment_id,
          stage: event.stage,
          status: event.status,
          level,
          summary_json: JSON.stringify(event.summary),
          created_at: now,
        })
        .onConflict((conflict) => conflict.columns(['task_id', 'stage']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!stored) continue;
      let query = tx
        .selectFrom('users as u')
        .leftJoin('notification_preferences as p', 'p.user_id', 'u.id')
        .where('u.status', '=', 'ACTIVE')
        .where('u.role', 'in', eligibleRoles)
        .select(['u.id', 'p.email', 'p.verified_at', 'p.email_enabled', 'p.minimum_level']);
      if (automated) {
        query = query
          .innerJoin('notification_subscriptions as s', 's.user_id', 'u.id')
          .where('s.project_id', '=', task.project_id)
          .where('s.stage', '=', event.stage);
      } else {
        query = query.where('u.id', '=', task.created_by);
      }
      const recipients = await query.execute();
      // Avoid SQLite's bind-parameter limit on large subscriber lists.
      for (let offset = 0; offset < recipients.length; offset += 100) {
        const batch = recipients.slice(offset, offset + 100).map((user) => ({
          user,
          notification: {
            id: randomUUID(),
            event_id: stored.id,
            user_id: user.id,
            created_at: now,
          },
        }));
        await tx
          .insertInto('user_notifications')
          .values(batch.map(({ notification }) => notification))
          .execute();
        const jobs = batch.flatMap(({ user, notification }) =>
          user.email &&
          user.verified_at !== null &&
          user.email_enabled === 1 &&
          user.minimum_level &&
          meetsMinimum(level, user.minimum_level)
            ? [
                {
                  id: randomUUID(),
                  notification_id: notification.id,
                  status: 'PENDING',
                  available_at: now,
                },
              ]
            : [],
        );
        if (jobs.length) await tx.insertInto('notification_mail').values(jobs).execute();
      }
    }
  }

  private inbox(userId: string) {
    return this.database.db
      .selectFrom('user_notifications as n')
      .innerJoin('notification_events as e', 'e.id', 'n.event_id')
      .innerJoin('projects as p', 'p.id', 'e.project_id')
      .where('n.user_id', '=', userId)
      .where('p.deleted_at', 'is', null);
  }

  async unreadCount(userId: string) {
    const { count } = await this.inbox(userId)
      .select((eb) => eb.fn.countAll<number | string>().as('count'))
      .where('n.read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return { unreadCount: Number(count) };
  }

  async list(userId: string, filters: NotificationsQuery) {
    const { unreadCount } = await this.unreadCount(userId);
    let query = this.inbox(userId)
      .leftJoin('services as s', 's.id', 'e.service_id')
      .leftJoin('environments as env', 'env.id', 'e.environment_id')
      .leftJoin('notification_mail as mail', 'mail.notification_id', 'n.id')
      .select([
        'n.id',
        'n.read_at as readAt',
        'n.created_at as createdAt',
        'e.task_id as taskId',
        'e.project_id as projectId',
        'p.name as projectName',
        'e.service_id as serviceId',
        's.name as serviceName',
        'e.environment_id as environmentId',
        'env.name as environmentName',
        'e.status',
        'e.stage',
        'e.level',
        'e.summary_json',
        'mail.status as mailStatus',
      ]);
    if (filters.projectId) query = query.where('e.project_id', '=', filters.projectId);
    if (filters.level) query = query.where('e.level', '=', filters.level);
    if (filters.unread !== undefined)
      query = query.where('n.read_at', filters.unread === 'true' ? 'is' : 'is not', null);
    const rows = await query
      .orderBy('n.created_at', 'desc')
      .orderBy('n.id', 'desc')
      .limit(200)
      .execute();
    return {
      unreadCount,
      items: rows.map(({ summary_json, ...row }) => ({
        ...row,
        summary: JSON.parse(summary_json) as NotificationSummary,
      })),
    };
  }

  async markRead(userId: string, id?: string) {
    const visible = this.inbox(userId).select('n.id');
    if (id && !(await visible.where('n.id', '=', id).executeTakeFirst()))
      throw new NotFoundException('通知不存在');
    let update = this.database.db
      .updateTable('user_notifications')
      .set({ read_at: Date.now() })
      .where('read_at', 'is', null)
      .where('id', 'in', visible);
    if (id) update = update.where('id', '=', id);
    await update.execute();
    return { success: true };
  }

  private async lockPreferences(tx: Transaction<Database>, userId: string) {
    await tx
      .insertInto('notification_preferences')
      .values({ user_id: userId })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    return tx
      .updateTable('notification_preferences')
      .set((eb) => ({ user_id: eb.ref('user_id') }))
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async preferences(userId: string) {
    const row = await this.database.db
      .selectFrom('notification_preferences')
      .select(['email', 'email_enabled', 'minimum_level', 'verified_at'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return {
      email: row?.email ?? null,
      emailEnabled: row?.email_enabled === 1,
      minimumLevel: row?.minimum_level ?? 'FAILURE',
      verifiedAt: row?.verified_at ?? null,
    };
  }

  async savePreferences(userId: string, input: NotificationPreferencesDto) {
    const email = input.email?.trim().toLowerCase() ?? null;
    await this.database.db.transaction().execute(async (tx) => {
      const current = await this.lockPreferences(tx, userId);
      if (input.emailEnabled && !email)
        throw new BadRequestException('启用邮件通知须先设置收件邮箱');
      const changed = email !== current.email;
      await tx
        .updateTable('notification_preferences')
        .set({
          email,
          email_enabled: input.emailEnabled ? 1 : 0,
          minimum_level: input.minimumLevel,
          ...(changed && {
            verified_at: null,
            verification_hash: null,
            verification_expires_at: null,
            verification_attempts: 0,
          }),
        })
        .where('user_id', '=', userId)
        .execute();
    });
    return this.preferences(userId);
  }

  async subscriptions(userId: string) {
    const subscriptions = await this.database.db
      .selectFrom('notification_subscriptions as s')
      .innerJoin('projects as p', 'p.id', 's.project_id')
      .select(['s.project_id as projectId', 's.stage'])
      .where('s.user_id', '=', userId)
      .where('p.deleted_at', 'is', null)
      .orderBy('s.project_id')
      .orderBy('s.stage')
      .execute();
    return { subscriptions };
  }

  async saveSubscriptions(userId: string, subscriptions: NotificationSubscriptionDto[]) {
    const unique = [
      ...new Map(subscriptions.map((item) => [`${item.projectId}:${item.stage}`, item])).values(),
    ];
    await this.database.db.transaction().execute(async (tx) => {
      await this.lockPreferences(tx, userId);
      if (unique.length) {
        const ids = [...new Set(unique.map((item) => item.projectId))];
        const projects = await tx
          .selectFrom('projects')
          .select('id')
          .where('id', 'in', ids)
          .where('deleted_at', 'is', null)
          .execute();
        if (projects.length !== ids.length) throw new BadRequestException('订阅含不可访问项目');
      }
      await tx.deleteFrom('notification_subscriptions').where('user_id', '=', userId).execute();
      for (let offset = 0; offset < unique.length; offset += 100) {
        await tx
          .insertInto('notification_subscriptions')
          .values(
            unique
              .slice(offset, offset + 100)
              .map((item) => ({ user_id: userId, project_id: item.projectId, stage: item.stage })),
          )
          .execute();
      }
    });
    return this.subscriptions(userId);
  }

  private verificationHash(userId: string, email: string, code: string) {
    return createHmac('sha256', encryptionKey())
      .update(JSON.stringify(['notification-email-v1', userId, email, code]))
      .digest('hex');
  }

  async requestVerification(userId: string) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    const { email, hash } = await this.database.db.transaction().execute(async (tx) => {
      const current = await this.lockPreferences(tx, userId);
      if (!current.email) throw new BadRequestException('请先设置收件邮箱');
      if (current.verified_at !== null) throw new BadRequestException('该邮箱已验证');
      if (
        current.verification_requested_at !== null &&
        current.verification_requested_at > now - verificationInterval
      )
        throw new HttpException('请稍后再次发送验证码', HttpStatus.TOO_MANY_REQUESTS);
      const hash = this.verificationHash(userId, current.email, code);
      await tx
        .updateTable('notification_preferences')
        .set({
          verification_hash: hash,
          verification_requested_at: now,
          verification_expires_at: now + verificationTtl,
          verification_attempts: 0,
        })
        .where('user_id', '=', userId)
        .execute();
      return { email: current.email, hash };
    });
    try {
      await this.mail.sendVerification(email, code);
    } catch (error) {
      await this.database.db
        .updateTable('notification_preferences')
        .set({ verification_hash: null, verification_expires_at: null })
        .where('user_id', '=', userId)
        .where('verification_hash', '=', hash)
        .execute();
      throw error;
    }
    return { success: true };
  }

  async confirmVerification(userId: string, code: string) {
    const verified = await this.database.db.transaction().execute(async (tx) => {
      const current = await this.lockPreferences(tx, userId);
      const now = Date.now();
      if (
        !current.email ||
        !current.verification_hash ||
        current.verification_expires_at === null ||
        current.verification_expires_at <= now ||
        current.verification_attempts >= maxVerificationAttempts
      )
        return false;
      const expected = Buffer.from(current.verification_hash, 'hex');
      const actual = Buffer.from(this.verificationHash(userId, current.email, code), 'hex');
      const match = expected.length === actual.length && timingSafeEqual(expected, actual);
      await tx
        .updateTable('notification_preferences')
        .set(
          match
            ? {
                verified_at: now,
                verification_hash: null,
                verification_expires_at: null,
                verification_attempts: 0,
              }
            : { verification_attempts: current.verification_attempts + 1 },
        )
        .where('user_id', '=', userId)
        .execute();
      return match;
    });
    if (!verified) throw new BadRequestException('验证码无效或已过期');
    return this.preferences(userId);
  }
}
