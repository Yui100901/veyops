import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { CredentialsService } from '../credentials/credentials.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { SavePipelineWebhookDto } from './pipeline-hooks.dto';

export function pipelineWebhookEndpoint(id: string) {
  return `/api/v1/webhooks/gitea/${id}`;
}

function present(row: Selectable<Database['pipeline_webhooks']>) {
  return {
    pipelineId: row.pipeline_id,
    environmentId: row.environment_id,
    targetId: row.target_id,
    branch: row.branch,
    secretCredentialId: row.secret_credential_id,
    enabled: row.enabled === 1,
    version: row.pipeline_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endpoint: pipelineWebhookEndpoint(row.pipeline_id),
  };
}

export function canonicalRepositoryUrl(input: string) {
  const url = new URL(input);
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pathname
  )
    throw new Error('Invalid repository URL');
  return `${url.origin}${pathname}`;
}

function validateBranch(branch: string) {
  // Match a complete Git branch name, without accepting globs or a refs/heads/ prefix.
  if (
    !branch ||
    branch.length > 255 ||
    branch === '@' ||
    branch.startsWith('-') ||
    branch.startsWith('refs/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[\s~^:?*[\\\x00-\x1F\x7F]/.test(branch) ||
    branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))
  )
    throw new BadRequestException('请填写有效的 Git 分支名称，例如 main 或 release/next');
}

type PushPayload = {
  ref?: unknown;
  after?: unknown;
  deleted?: unknown;
  repository?: { clone_url?: unknown };
};
type HookRow = Selectable<Database['pipeline_webhooks']>;
type IgnoredReason =
  'UNCONFIGURED' | 'DISABLED' | 'EVENT_IGNORED' | 'BRANCH_IGNORED' | 'BRANCH_DELETED';
const ignored = (reason: IgnoredReason) => ({ accepted: false as const, reason });
class HookDisabledError extends Error {}

@Injectable()
export class PipelineHooksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly pipelines: PipelinesService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
  ) {}

  private row(id: string) {
    return this.database.db
      .selectFrom('pipeline_webhooks')
      .selectAll()
      .where('pipeline_id', '=', id)
      .executeTakeFirst();
  }

  async get(id: string) {
    await this.pipelines.get(id);
    const row = await this.row(id);
    return row ? present(row) : null;
  }

  private async activeAdmin(userId: string) {
    const admin = await this.database.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .where('must_change_password', '=', 0)
      .executeTakeFirst();
    if (!admin) throw new ForbiddenException('Webhook 的配置管理员已失效，请由管理员重新保存配置');
  }

  private async secret(id: string) {
    const credential = await this.database.db
      .selectFrom('credentials')
      .select('nonce')
      .where('id', '=', id)
      .where('type', '=', 'CUSTOM_SECRET')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!credential) throw new BadRequestException('请选择启用的自定义密钥凭据');
    const stored = await this.credentials.decrypt(id, credential.nonce);
    const value = stored.value || stored.secret;
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') < 32)
      throw new BadRequestException('Webhook 密钥至少需要 32 字节');
    return { value, nonce: credential.nonce };
  }

  private async verifyDelivery(tx: Transaction<Database>, hook: HookRow, nonce: string) {
    // A no-op update takes a write lock on both SQLite and PostgreSQL. A disable, rebind or
    // credential rotation either wins before this transaction or waits until submission commits.
    const current = await tx
      .updateTable('pipeline_webhooks')
      .set({ enabled: 1 })
      .where('pipeline_id', '=', hook.pipeline_id)
      .where('enabled', '=', 1)
      .where('updated_at', '=', hook.updated_at)
      .where('created_by', '=', hook.created_by)
      .where('branch', '=', hook.branch)
      .where('repository_key', '=', hook.repository_key)
      .where('pipeline_version', '=', hook.pipeline_version)
      .where('configuration_hash', '=', hook.configuration_hash)
      .where('environment_id', '=', hook.environment_id)
      .where('target_id', '=', hook.target_id)
      .where('secret_credential_id', '=', hook.secret_credential_id)
      .returning('pipeline_id')
      .executeTakeFirst();
    if (!current) {
      const latest = await tx
        .selectFrom('pipeline_webhooks')
        .select('enabled')
        .where('pipeline_id', '=', hook.pipeline_id)
        .executeTakeFirst();
      if (!latest || latest.enabled !== 1) throw new HookDisabledError();
      throw new ForbiddenException('Webhook 配置已修改，请重新发送推送事件');
    }
    const credential = await tx
      .updateTable('credentials')
      .set({ nonce })
      .where('id', '=', hook.secret_credential_id)
      .where('nonce', '=', nonce)
      .where('status', '=', 'ACTIVE')
      .returning('id')
      .executeTakeFirst();
    if (!credential) throw new UnauthorizedException('Gitea Webhook 签名无效');
    const admin = await tx
      .updateTable('users')
      .set({ must_change_password: 0 })
      .where('id', '=', hook.created_by)
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .where('must_change_password', '=', 0)
      .returning('id')
      .executeTakeFirst();
    if (!admin) throw new ForbiddenException('Webhook 的配置管理员已失效，请由管理员重新保存配置');
  }

  private async repositoryKey(projectId: string, repositoryId: string) {
    const repo = await this.database.db
      .selectFrom('repositories')
      .select('clone_url')
      .where('id', '=', repositoryId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    try {
      if (!repo) throw new Error('Missing repository');
      return canonicalRepositoryUrl(repo.clone_url);
    } catch {
      throw new BadRequestException('Pipeline 仓库必须配置有效的 HTTP(S) 克隆地址');
    }
  }

  async save(id: string, input: SavePipelineWebhookDto, userId: string) {
    await this.activeAdmin(userId);
    const existing = await this.row(id);
    const now = Date.now();
    if (!input.enabled && existing) {
      // Make it possible to stop automatic runs even when a credential or Pipeline is disabled.
      await this.database.db
        .updateTable('pipeline_webhooks')
        .set({ enabled: 0, updated_at: now })
        .where('pipeline_id', '=', id)
        .execute();
    } else {
      validateBranch(input.branch);
      await this.secret(input.secretCredentialId);
      const preview = await this.pipelines.preview(id, {
        environmentId: input.environmentId,
        targetId: input.targetId,
        commitSha: '0'.repeat(40), // Preview only validates configuration; the delivery supplies a real commit.
        confirmed: true,
        mode: 'BUILD_ONLY',
      });
      if (input.enabled) this.pipelines.assertAutomaticBuild(preview);
      const values = {
        environment_id: input.environmentId,
        target_id: input.targetId,
        secret_credential_id: input.secretCredentialId,
        branch: input.branch,
        enabled: input.enabled ? 1 : 0,
        pipeline_version: preview.version,
        configuration_hash: preview.configurationHash,
        repository_key: await this.repositoryKey(
          preview.projectId,
          preview.definition.repositoryId,
        ),
        created_by: userId,
        updated_at: now,
      };
      await this.database.db
        .insertInto('pipeline_webhooks')
        .values({ pipeline_id: id, ...values, created_at: now })
        .onConflict((conflict) => conflict.column('pipeline_id').doUpdateSet(values))
        .execute();
    }
    await this.audit.record(userId, 'pipeline.webhook.save', 'pipeline', id, {
      enabled: input.enabled,
    });
    return present((await this.row(id))!);
  }

  async deliver(
    id: string,
    event: string | undefined,
    signature: string | undefined,
    body: Buffer | undefined,
  ) {
    const hook = await this.row(id);
    if (!hook) return ignored('UNCONFIGURED');
    if (hook.enabled !== 1) return ignored('DISABLED');
    if (!body || !signature || !/^[a-fA-F0-9]{64}$/.test(signature))
      throw new UnauthorizedException('Gitea Webhook 签名无效');
    const secret = await this.secret(hook.secret_credential_id).catch(() => null);
    if (!secret) throw new UnauthorizedException('Gitea Webhook 签名无效');
    const expected = createHmac('sha256', secret.value).update(body).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex')))
      throw new UnauthorizedException('Gitea Webhook 签名无效');
    if (event !== 'push') return ignored('EVENT_IGNORED');

    let payload: PushPayload;
    try {
      payload = JSON.parse(body.toString('utf8')) as PushPayload;
    } catch {
      throw new BadRequestException('Gitea Push 正文必须是 JSON');
    }
    if (!payload || typeof payload.ref !== 'string')
      throw new BadRequestException('Gitea Push 缺少 Git ref');
    if (payload.ref !== `refs/heads/${hook.branch}`) return ignored('BRANCH_IGNORED');
    if (
      payload.deleted === true ||
      (typeof payload.after === 'string' && /^(?:0{40}|0{64})$/.test(payload.after))
    )
      return ignored('BRANCH_DELETED');
    if (
      typeof payload.after !== 'string' ||
      !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(payload.after)
    )
      throw new BadRequestException('Gitea Push 缺少完整 Commit SHA');
    let deliveredRepository: string;
    try {
      if (typeof payload.repository?.clone_url !== 'string') throw new Error('Missing clone URL');
      deliveredRepository = canonicalRepositoryUrl(payload.repository.clone_url);
    } catch {
      throw new BadRequestException('Gitea Push 缺少有效的仓库克隆地址');
    }
    if (deliveredRepository !== hook.repository_key)
      throw new ForbiddenException('Gitea Push 仓库不匹配');
    await this.activeAdmin(hook.created_by);
    const input = {
      environmentId: hook.environment_id,
      targetId: hook.target_id,
      commitSha: payload.after.toLowerCase(),
      confirmed: true,
      mode: 'BUILD_ONLY' as const,
      version: hook.pipeline_version,
    };
    const preview = await this.pipelines.preview(id, input);
    if (
      (await this.repositoryKey(preview.projectId, preview.definition.repositoryId)) !==
      hook.repository_key
    )
      throw new ForbiddenException('Pipeline 仓库已修改，请重新保存 Webhook 配置');
    if (preview.configurationHash !== hook.configuration_hash)
      throw new ConflictException('Pipeline 的有效构建配置已改变，请重新保存 Webhook 配置');
    const idempotencyKey = `gitea:${createHash('sha256')
      .update(JSON.stringify([id, payload.ref, input.commitSha]))
      .digest('hex')}`;
    const task = await this.pipelines
      .run(
        id,
        {
          ...input,
          version: preview.version,
          expectedServerIds: preview.serverIds,
          expectedConfigurationHash: preview.configurationHash,
        },
        hook.created_by,
        {
          triggerType: 'WEBHOOK',
          idempotencyKey,
          gitRef: payload.ref,
          beforeInsert: (tx) => this.verifyDelivery(tx, hook, secret.nonce),
        },
      )
      .catch((error: unknown) => {
        if (error instanceof HookDisabledError) return null;
        throw error;
      });
    if (!task) return ignored('DISABLED');
    return {
      accepted: true as const,
      taskId: task.id,
      commitSha: input.commitSha,
      mode: input.mode,
    };
  }
}
