import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Patch,
  Body,
  Req,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { DatabaseService } from '../../core/database/database.service';
import { encryptionKey } from '../../core/config';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { AuditService } from '../audit/audit.service';

const credentialTypes = [
  'SSH_PASSWORD',
  'SSH_KEY',
  'GIT_TOKEN',
  'GIT_PASSWORD',
  'API_KEY',
  'API_SECRET',
  'DOCKER_REGISTRY',
  'USERNAME_PASSWORD',
  'CUSTOM_SECRET',
];
class CredentialDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsIn(credentialTypes) type!: string;
  @IsObject() secret!: Record<string, string>;
  @IsOptional() @IsObject() metadata?: Record<string, string>;
}
class UpdateCredentialDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @IsOptional() @IsObject() secret?: Record<string, string>;
  @IsOptional() @IsIn(['ACTIVE', 'DISABLED']) status?: string;
}

@Injectable()
export class CredentialsService {
  private readonly key = encryptionKey();
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}
  private encrypt(secret: Record<string, string>) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secret), 'utf8'),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      auth_tag: cipher.getAuthTag().toString('base64'),
      key_version: 'v1',
    };
  }
  private validateSecret(type: string, secret: Record<string, string>) {
    const keys = Object.keys(secret);
    if (
      !keys.length ||
      keys.length > 10 ||
      Object.values(secret).some((v) => typeof v !== 'string' || v.length > 100_000)
    )
      throw new BadRequestException('凭据内容无效');
    const required = (
      {
        SSH_PASSWORD: 'password',
        SSH_KEY: 'privateKey',
        GIT_TOKEN: 'token',
        API_KEY: 'apiKey',
      } as Record<string, string>
    )[type];
    if (required && !secret[required]) throw new BadRequestException(`凭据缺少 ${required}`);
  }
  async list() {
    const rows = await this.database.db
      .selectFrom('credentials')
      .select(['id', 'name', 'type', 'status', 'created_at', 'updated_at'])
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
  async create(dto: CredentialDto, userId: string) {
    this.validateSecret(dto.type, dto.secret);
    if (
      dto.metadata &&
      (Object.values(dto.metadata).some((v) => typeof v !== 'string') ||
        Object.keys(dto.metadata).some((k) => /password|secret|token|key/i.test(k)))
    )
      throw new BadRequestException('元数据不能保存敏感值');
    const id = randomUUID();
    const now = Date.now();
    // Metadata is deliberately restricted to a description to prevent accidental secret disclosure.
    const metadata = { description: dto.metadata?.description || '' };
    await this.database.db
      .insertInto('credentials')
      .values({
        id,
        name: dto.name,
        type: dto.type,
        ...this.encrypt(dto.secret),
        metadata_json: JSON.stringify(metadata),
        status: 'ACTIVE',
        created_by: userId,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await this.audit.record(userId, 'credential.create', 'credential', id);
    return (await this.list()).find((c) => c.id === id)!;
  }
  async decrypt(id: string): Promise<Record<string, string>> {
    const row = await this.database.db
      .selectFrom('credentials')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || row.status !== 'ACTIVE') throw new BadRequestException('凭据不存在或已禁用');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    ) as Record<string, string>;
  }
  async assertSsh(id: string) {
    const row = await this.database.db
      .selectFrom('credentials')
      .select(['type', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row || row.status !== 'ACTIVE' || !['SSH_PASSWORD', 'SSH_KEY'].includes(row.type))
      throw new BadRequestException('请选择启用的 SSH 凭据');
  }
  async update(id: string, dto: UpdateCredentialDto, userId: string) {
    const row = await this.database.db
      .selectFrom('credentials')
      .select(['id', 'type'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('凭据不存在');
    if (dto.secret) this.validateSecret(row.type, dto.secret);
    await this.database.db
      .updateTable('credentials')
      .set({
        name: dto.name,
        status: dto.status,
        ...(dto.secret ? this.encrypt(dto.secret) : {}),
        updated_at: Date.now(),
      })
      .where('id', '=', id)
      .execute();
    await this.audit.record(userId, 'credential.update', 'credential', id);
    return (await this.list()).find((c) => c.id === id)!;
  }
  async remove(id: string, userId: string) {
    const row = await this.database.db
      .selectFrom('credentials')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('凭据不存在');
    try {
      await this.database.db.deleteFrom('credentials').where('id', '=', id).execute();
    } catch {
      throw new ConflictException('凭据正在被资源或历史任务引用，不能删除；可以禁用');
    }
    await this.audit.record(userId, 'credential.delete', 'credential', id);
    return { success: true };
  }
}
@Controller('credentials')
class CredentialsController {
  constructor(private readonly service: CredentialsService) {}
  @Get() list() {
    return this.service.list();
  }
  @Roles('ADMIN') @Post() create(@Body() dto: CredentialDto, @Req() req: AuthRequest) {
    return this.service.create(dto, req.user.id);
  }
  @Roles('ADMIN') @Patch(':id') update(
    @Param('id') id: string,
    @Body() dto: UpdateCredentialDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.update(id, dto, req.user.id);
  }
  @Roles('ADMIN') @Delete(':id') remove(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.service.remove(id, req.user.id);
  }
}
@Global()
@Module({
  controllers: [CredentialsController],
  providers: [CredentialsService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
