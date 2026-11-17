import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { CredentialsService } from '../credentials/credentials.service';
import type { TaskPayload } from '../tasks/tasks.types';
import { NotificationSmtpDto, isAutomaticTrigger, notificationLevels } from './notification.types';
import type {
  NotificationLevel,
  NotificationStage,
  NotificationSummary,
} from './notification.types';

const settingsKey = 'notifications.smtp';
const maxAttempts = 3;
const leaseMs = 120_000;
const retryDelays = [5_000, 30_000];
export const levelNames: Record<NotificationLevel, string> = {
  NORMAL: '普通',
  WARNING: '告警',
  FAILURE: '失败',
};
export const stageNames: Record<NotificationStage, string> = {
  BUILD: '构建',
  DEPLOY: '部署',
  ROLLBACK: '回滚',
};
const deliveryNames: Record<string, string> = {
  SUCCESS: '成功',
  FAILED: '失败',
  PARTIAL_FAILED: '部分失败',
  TIMED_OUT: '超时',
  NEEDS_ATTENTION: '需要人工核查',
};

export function meetsMinimum(level: string, minimum: string) {
  const eventIndex = notificationLevels.findIndex((value) => value === level);
  const minimumIndex = notificationLevels.findIndex((value) => value === minimum);
  return minimumIndex !== -1 && eventIndex >= minimumIndex;
}

function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BadRequestException('平台地址必须是 HTTP 或 HTTPS URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new BadRequestException('平台地址必须为无凭据、不含查询参数和片段的 HTTP 或 HTTPS URL');
  return url.toString().replace(/\/+$/, '');
}

function deliveryFailure(error: unknown) {
  const failure = error as { responseCode?: number; command?: string; code?: string } | null;
  if (failure?.responseCode && failure.responseCode >= 400) {
    return { retryable: failure.responseCode < 500, uncertain: false };
  }
  const beforeAcceptance =
    failure?.command === 'CONN' ||
    failure?.command === 'AUTH' ||
    ['EDNS', 'ENOTFOUND', 'ECONNREFUSED'].includes(failure?.code ?? '');
  return { retryable: beforeAcceptance, uncertain: !beforeAcceptance };
}

@Injectable()
export class NotificationMailService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationMailService.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
  ) {}

  start() {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => this.startPoll(), 5_000);
    this.timer.unref();
    this.startPoll();
  }

  private startPoll() {
    this.active ??= this.tick()
      .catch(() => this.logger.warn('通知邮件队列本轮处理失败'))
      .finally(() => {
        this.active = undefined;
      });
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.active;
  }

  async config(): Promise<NotificationSmtpDto | null> {
    const row = await this.database.db
      .selectFrom('system_settings')
      .select('value_json')
      .where('key', '=', settingsKey)
      .executeTakeFirst();
    return row ? (JSON.parse(row.value_json) as NotificationSmtpDto) : null;
  }

  async configure(input: NotificationSmtpDto, userId: string) {
    const value = {
      host: input.host,
      port: input.port,
      security: input.security,
      fromEmail: input.fromEmail,
      credentialId: input.credentialId ?? null,
      baseUrl: normalizeBaseUrl(input.baseUrl),
    };
    if (value.security === 'NONE' && value.credentialId)
      throw new BadRequestException('SMTP 用户名密码认证须使用 TLS 或 STARTTLS');
    await this.auth(value.credentialId);
    await this.database.db.transaction().execute(async (tx) => {
      const record = { value_json: JSON.stringify(value), updated_at: Date.now() };
      await tx
        .insertInto('system_settings')
        .values({ key: settingsKey, ...record })
        .onConflict((conflict) => conflict.column('key').doUpdateSet(record))
        .execute();
      await this.audit.record(
        userId,
        'notification.smtp.configure',
        'system-settings',
        null,
        {},
        tx,
      );
    });
    return value;
  }

  async verifySmtp() {
    const configuration = await this.requireConfig();
    const transport = await this.transport(configuration);
    try {
      await transport.verify();
    } catch {
      throw new ServiceUnavailableException('SMTP 连通性或认证验证失败');
    } finally {
      transport.close();
    }
    return { success: true };
  }

  async sendVerification(email: string, code: string) {
    const config = await this.requireConfig();
    try {
      await this.send(config, email, 'VeyOps 邮箱验证', `您的验证码为 ${code}，10 分钟内有效。`);
    } catch {
      throw new ServiceUnavailableException('验证邮件投递失败，请稍后重试');
    }
  }

  private async requireConfig() {
    const config = await this.config();
    if (!config) throw new ServiceUnavailableException('管理员尚未配置 SMTP');
    return config;
  }

  private async auth(id: string | null) {
    if (!id) return undefined;
    const credential = await this.database.db
      .selectFrom('credentials')
      .select(['type', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (
      !credential ||
      credential.status !== 'ACTIVE' ||
      !['USERNAME_PASSWORD', 'CUSTOM_SECRET'].includes(credential.type)
    )
      throw new BadRequestException('请选择可用的 SMTP 用户名密码凭据');
    const { username, password } = await this.credentials.decrypt(id);
    if (!username || !password) throw new BadRequestException('SMTP 凭据必须包含用户名及密码');
    return { user: username, pass: password };
  }

  private async transport(config: NotificationSmtpDto) {
    if (config.security === 'NONE' && config.credentialId)
      throw new BadRequestException('SMTP 用户名密码认证须使用 TLS 或 STARTTLS');
    return createTransport({
      host: config.host,
      port: config.port,
      secure: config.security === 'TLS',
      requireTLS: config.security === 'STARTTLS',
      ignoreTLS: config.security === 'NONE',
      auth: await this.auth(config.credentialId),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  private async send(
    config: NotificationSmtpDto,
    email: string,
    subject: string,
    text: string,
    messageId?: string,
  ) {
    const transport = await this.transport(config);
    try {
      await transport.sendMail({
        from: { name: 'VeyOps', address: config.fromEmail },
        to: { name: '', address: email },
        subject,
        text,
        messageId,
      });
    } finally {
      transport.close();
    }
  }

  async tick() {
    const db = this.database.db;
    await db
      .updateTable('notification_mail')
      .set({
        status: 'NEEDS_ATTENTION',
        error: 'Worker 中断，投递结果尚未确认',
        lease_id: null,
        lease_expires_at: null,
      })
      .where('status', '=', 'SENDING')
      .where('lease_expires_at', '<=', Date.now())
      .execute();
    for (let index = 0; index < 10 && !this.stopping; index++) {
      const now = Date.now();
      const candidate = await db
        .selectFrom('notification_mail')
        .select('id')
        .where('status', '=', 'PENDING')
        .where('available_at', '<=', now)
        .orderBy('available_at')
        .orderBy('id')
        .executeTakeFirst();
      if (!candidate) break;
      const lease = randomUUID();
      const job = await db
        .updateTable('notification_mail')
        .set((eb) => ({
          status: 'SENDING',
          attempts: eb('attempts', '+', 1),
          lease_id: lease,
          lease_expires_at: now + leaseMs,
        }))
        .where('id', '=', candidate.id)
        .where('status', '=', 'PENDING')
        .where('available_at', '<=', now)
        .returningAll()
        .executeTakeFirst();
      if (job) await this.deliver(job.id, job.notification_id, lease, job.attempts);
    }
  }

  private async deliver(id: string, notificationId: string, lease: string, attempts: number) {
    const db = this.database.db;
    const row = await db
      .selectFrom('user_notifications as n')
      .innerJoin('notification_events as e', 'e.id', 'n.event_id')
      .innerJoin('notification_preferences as p', 'p.user_id', 'n.user_id')
      .innerJoin('users as u', 'u.id', 'n.user_id')
      .innerJoin('tasks as task', 'task.id', 'e.task_id')
      .innerJoin('projects as project', 'project.id', 'e.project_id')
      .leftJoin('services as service', 'service.id', 'e.service_id')
      .leftJoin('environments as environment', 'environment.id', 'e.environment_id')
      .select([
        'e.status',
        'e.level',
        'e.stage',
        'e.task_id',
        'e.project_id',
        'e.summary_json',
        'p.email',
        'p.minimum_level',
        'n.user_id',
        'task.payload_json',
        'project.name as projectName',
        'service.name as serviceName',
        'environment.name as environmentName',
      ])
      .where('n.id', '=', notificationId)
      .where('u.status', '=', 'ACTIVE')
      .where('u.role', 'in', ['ADMIN', 'OPERATOR', 'VIEWER'])
      .where('project.deleted_at', 'is', null)
      .where('p.email_enabled', '=', 1)
      .where('p.verified_at', 'is not', null)
      .whereRef('p.verified_at', '<=', 'n.created_at')
      .executeTakeFirst();
    const complete = (status: string, error: string | null, availableAt = Date.now()) =>
      db
        .updateTable('notification_mail')
        .set({
          status,
          error,
          available_at: availableAt,
          sent_at: status === 'SENT' ? Date.now() : null,
          lease_id: null,
          lease_expires_at: null,
        })
        .where('id', '=', id)
        .where('lease_id', '=', lease)
        .execute();
    if (!row?.email || !meetsMinimum(row.level, row.minimum_level)) {
      await complete('SKIPPED', '收件人权限或邮件设置已变化');
      return;
    }
    const payload = JSON.parse(row.payload_json) as TaskPayload;
    if (isAutomaticTrigger(payload.pipeline?.triggerType)) {
      const subscription = await db
        .selectFrom('notification_subscriptions')
        .select('stage')
        .where('user_id', '=', row.user_id)
        .where('project_id', '=', row.project_id)
        .where('stage', '=', row.stage)
        .executeTakeFirst();
      if (!subscription) {
        await complete('SKIPPED', '收件人已取消订阅该阶段');
        return;
      }
    }
    const config = await this.config();
    if (!config) {
      await complete('FAILED', 'SMTP 尚未配置');
      return;
    }
    const stage = stageNames[row.stage as NotificationStage];
    const level = levelNames[row.level as NotificationLevel];
    const subject = `[VeyOps] ${level} · ${stage}${deliveryNames[row.status] ?? ''}`;
    const summary = JSON.parse(row.summary_json) as NotificationSummary;
    const result = [
      subject,
      [row.projectName, row.serviceName, row.environmentName].filter(Boolean).join(' / '),
      `成功 ${summary.success}，失败 ${summary.failed}，跳过 ${summary.skipped}，待核查 ${summary.needsAttention}`,
      ...(summary.deploymentSkipped ? ['本次未开始部署'] : []),
      ...(summary.releases.length ? [`恢复版本 ${summary.releases.join('、')}`] : []),
      `登录查看任务 ${config.baseUrl}/#/tasks/${encodeURIComponent(row.task_id)}`,
    ].join('\n');
    try {
      await this.send(config, row.email, subject, result, `<${id}@veyops.local>`);
    } catch (error) {
      if (error instanceof BadRequestException) {
        await complete('FAILED', 'SMTP 凭据不可用');
        return;
      }
      const failure = deliveryFailure(error);
      const delay = retryDelays[attempts - 1];
      if (failure.retryable && attempts < maxAttempts && delay !== undefined) {
        await complete('PENDING', 'SMTP 投递失败，等待重试', Date.now() + delay);
        return;
      }
      await complete(
        failure.uncertain ? 'NEEDS_ATTENTION' : 'FAILED',
        failure.uncertain ? 'SMTP 投递结果尚未确认' : 'SMTP 投递失败',
      );
      return;
    }
    await complete('SENT', null);
  }
}
