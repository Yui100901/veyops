import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database, RegistriesTable } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { CredentialsService } from '../credentials/credentials.service';
import { checkRegistryConnection, registryAddress } from './registry-connection';
import { lockProjectGraph } from '../projects/project-guards';
import { assertProjectResourceRemovable } from '../projects/project-resource-protection';

class RegistryDto {
  @IsString() @Length(1, 120) name!: string;
  @IsString() @Length(1, 259) registryUrl!: string;
  @IsOptional() @IsUUID() credentialId?: string | null;
}

class UpdateRegistryDto {
  @ValidateIf((_, value) => value !== undefined) @IsString() @Length(1, 120) name?: string;
  @ValidateIf((_, value) => value !== undefined) @IsString() @Length(1, 259) registryUrl?: string;
  @IsOptional() @IsUUID() credentialId?: string | null;
}

function present(registry: Selectable<RegistriesTable>) {
  return {
    id: registry.id,
    name: registry.name,
    registryUrl: registry.registry_url,
    credentialId: registry.credential_id,
    createdAt: registry.created_at,
  };
}

export async function lockRegistry(tx: Transaction<Database>, id: string) {
  // Pipeline versions store Registry references in JSON, so their writers take the same row lock.
  const registry = await tx
    .updateTable('registries')
    .set((eb) => ({ name: eb.ref('name') }))
    .where('id', '=', id)
    .returning('id')
    .executeTakeFirst();
  if (!registry) throw new NotFoundException('Registry不存在');
}

@Injectable()
export class RegistriesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly credentials: CredentialsService,
  ) {}
  async list() {
    return (
      await this.database.db
        .selectFrom('registries')
        .selectAll()
        .orderBy('created_at', 'desc')
        .execute()
    ).map(present);
  }
  async get(id: string) {
    const row = await this.database.db
      .selectFrom('registries')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Registry不存在');
    return present(row);
  }
  private async assertCredential(id: string) {
    const credential = await this.database.db
      .selectFrom('credentials')
      .select(['type', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (
      !credential ||
      credential.status !== 'ACTIVE' ||
      !['DOCKER_REGISTRY', 'USERNAME_PASSWORD'].includes(credential.type)
    )
      throw new BadRequestException('请选择启用的 Registry 用户名密码凭据');
  }
  private name(value: string) {
    const name = value.trim();
    if (!name) throw new BadRequestException('请输入镜像仓库名称');
    return name;
  }
  async create(dto: RegistryDto, userId: string) {
    const registryUrl = registryAddress(dto.registryUrl);
    if (dto.credentialId) await this.assertCredential(dto.credentialId);
    const id = randomUUID();
    await this.database.db
      .insertInto('registries')
      .values({
        id,
        name: this.name(dto.name),
        registry_url: registryUrl,
        credential_id: dto.credentialId ?? null,
        created_at: Date.now(),
      })
      .execute();
    await this.audit.record(userId, 'registry.create', 'registry', id);
    return this.get(id);
  }
  async update(id: string, dto: UpdateRegistryDto, userId: string) {
    const registry = await this.get(id);
    const address = dto.registryUrl === undefined ? undefined : registryAddress(dto.registryUrl);
    if (
      address &&
      address !== registry.registryUrl &&
      registry.credentialId &&
      dto.credentialId === undefined
    )
      throw new BadRequestException('变更地址时请重新选择凭据，或改为匿名访问');
    if (dto.credentialId) await this.assertCredential(dto.credentialId);
    const name = dto.name === undefined ? undefined : this.name(dto.name);
    if (name === undefined && address === undefined && dto.credentialId === undefined)
      return registry;
    const updated = await this.database.db
      .updateTable('registries')
      .set({
        name,
        registry_url: address,
        credential_id: dto.credentialId,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new NotFoundException('Registry不存在');
    await this.audit.record(userId, 'registry.update', 'registry', id);
    return present(updated);
  }
  async remove(id: string, userId: string) {
    const referenced = () =>
      new ConflictException('镜像仓库被 Pipeline 版本或镜像产物引用，不能删除');
    try {
      await this.database.db.transaction().execute(async (tx) => {
        await lockProjectGraph(tx);
        await lockRegistry(tx, id);
        await assertProjectResourceRemovable(tx, { resourceType: 'REGISTRY', resourceId: id });
        const artifact = await tx
          .selectFrom('artifacts')
          .select('id')
          .where('registry_id', '=', id)
          .executeTakeFirst();
        if (artifact) throw referenced();
        const versions = await tx
          .selectFrom('pipeline_versions')
          .select('definition_json')
          .execute();
        if (versions.some(({ definition_json }) => JSON.parse(definition_json)?.registryId === id))
          throw referenced();
        await tx.deleteFrom('registries').where('id', '=', id).execute();
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        ['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_TRIGGER', '23503'].includes(
          String(error.code),
        )
      )
        throw referenced();
      throw error;
    }
    await this.audit.record(userId, 'registry.delete', 'registry', id);
    return { success: true };
  }
  async test(id: string, userId: string) {
    const registry = await this.get(id);
    let login: { username: string; password: string } | undefined;
    if (registry.credentialId) {
      await this.assertCredential(registry.credentialId);
      try {
        const { username, password } = await this.credentials.decrypt(registry.credentialId);
        if (
          !username ||
          username.includes(':') ||
          !password ||
          username.length + password.length > 4096
        )
          throw new Error();
        login = { username, password };
      } catch {
        throw new BadRequestException(
          '无法读取 Registry 凭据，请检查凭据是否包含有效的用户名和密码',
        );
      }
    }
    const result = await checkRegistryConnection(registryAddress(registry.registryUrl), login);
    await this.audit.record(userId, 'registry.test', 'registry', id, {
      success: result.success,
      authenticated: result.authenticated,
    });
    return result;
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
  @Patch(':id') @Roles('ADMIN') update(
    @Param('id') id: string,
    @Body() dto: UpdateRegistryDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.update(id, dto, req.user.id);
  }
  @Delete(':id') @Roles('ADMIN') remove(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.service.remove(id, req.user.id);
  }
  @Post(':id/test') @HttpCode(200) @Roles('ADMIN') test(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.test(id, req.user.id);
  }
}
