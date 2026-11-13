import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
class RegistryDto {
  @IsString() @Length(1, 120) name!: string;
  @IsString() @Matches(/^[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d{1,5})?$/) registryUrl!: string;
  @IsOptional() @IsUUID() credentialId?: string;
}
@Injectable()
export class RegistriesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}
  async list() {
    return (
      await this.database.db
        .selectFrom('registries')
        .selectAll()
        .orderBy('created_at', 'desc')
        .execute()
    ).map((r) => ({
      id: r.id,
      name: r.name,
      registryUrl: r.registry_url,
      credentialId: r.credential_id,
      createdAt: r.created_at,
    }));
  }
  async get(id: string) {
    const row = (await this.list()).find((r) => r.id === id);
    if (!row) throw new NotFoundException('Registry不存在');
    return row;
  }
  async create(dto: RegistryDto, userId: string) {
    if (dto.credentialId) {
      const c = await this.database.db
        .selectFrom('credentials')
        .select(['type', 'status'])
        .where('id', '=', dto.credentialId)
        .executeTakeFirst();
      if (!c || c.status !== 'ACTIVE' || !['DOCKER_REGISTRY', 'USERNAME_PASSWORD'].includes(c.type))
        throw new BadRequestException('请选择启用的Registry用户名密码凭据');
    }
    const id = randomUUID();
    await this.database.db
      .insertInto('registries')
      .values({
        id,
        name: dto.name,
        registry_url: dto.registryUrl,
        credential_id: dto.credentialId ?? null,
        created_at: Date.now(),
      })
      .execute();
    await this.audit.record(userId, 'registry.create', 'registry', id);
    return this.get(id);
  }
}
@Controller('registries')
export class RegistriesController {
  constructor(private readonly service: RegistriesService) {}
  @Get() list() {
    return this.service.list();
  }
  @Post() @Roles('ADMIN') create(@Body() dto: RegistryDto, @Req() req: AuthRequest) {
    return this.service.create(dto, req.user.id);
  }
}
