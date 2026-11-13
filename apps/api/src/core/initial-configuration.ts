import { Global, Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { DatabaseService } from './database/database.service';
import { dataDirectory, encryptionKey } from './config';
import { AiProvidersService } from '../modules/ai/ai-providers.service';
import { CreateAiProviderDto } from '../modules/ai/ai.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

/** A local encrypted, one-time setup envelope; never contains a plaintext key on disk. */
@Injectable()
export class InitialConfigurationService implements OnApplicationBootstrap {
  private readonly logger = new Logger('InitialConfiguration');
  private applying?: Promise<void>;
  constructor(
    private readonly database: DatabaseService,
    private readonly providers: AiProvidersService,
  ) {}
  async onApplicationBootstrap() {
    const admin = await this.database.db
      .selectFrom('users')
      .select('id')
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (admin) await this.apply(admin.id);
  }
  async apply(userId: string): Promise<void> {
    if (this.applying) return this.applying;
    this.applying = this.import(userId)
      .catch(() => {
        this.logger.warn('可选 AI 初始配置尚未导入；可在系统设置中配置或检查本地主密钥');
      })
      .finally(() => {
        this.applying = undefined;
      });
    return this.applying;
  }
  private async import(userId: string) {
    const admin = await this.database.db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!admin) throw new Error('Initial configuration requires an active administrator');
    const file = join(dataDirectory, 'config', 'ai-bootstrap.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const envelope = JSON.parse(raw) as {
      version: number;
      nonce: string;
      authTag: string;
      ciphertext: string;
    };
    if (
      envelope.version !== 1 ||
      typeof envelope.nonce !== 'string' ||
      typeof envelope.authTag !== 'string' ||
      typeof envelope.ciphertext !== 'string' ||
      Buffer.from(envelope.nonce, 'base64').length !== 12 ||
      Buffer.from(envelope.authTag, 'base64').length !== 16
    )
      throw new Error('Invalid configuration envelope');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(envelope.nonce, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
    const config = plainToInstance(
      CreateAiProviderDto,
      JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      ),
    );
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      typeof config.apiKey !== 'string' ||
      !config.apiKey.trim() ||
      (await validate(config, { whitelist: true, forbidNonWhitelisted: true })).length
    )
      throw new Error('Invalid initial provider configuration');
    config.baseUrl = config.baseUrl.replace(/\/+$/, '');
    const existing = (await this.providers.list()).find(
      (p) => p.name === config.name && p.baseUrl === config.baseUrl && p.model === config.model,
    );
    if (!existing) await this.providers.create(config, userId);
    await unlink(file);
    this.logger.log('已导入可选 AI 配置，API Key 已存入加密凭据中心');
  }
}
@Global()
@Module({ providers: [InitialConfigurationService], exports: [InitialConfigurationService] })
export class InitialConfigurationModule {}
