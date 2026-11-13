import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DatabaseService } from '../../core/database/database.service';
import { CredentialsService } from '../credentials/credentials.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { SshService } from '../../infrastructure/ssh/ssh.service';
import { summarizeProbe } from '../../infrastructure/ssh/server-probe';
import { recentDeployments } from '../deployments/deployment-history';
import type { Selectable } from 'kysely';
import type { Database } from '../../core/database/schema';

class ServerDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @Matches(/^[a-zA-Z0-9:._-]{1,253}$/) host!: string;
  @IsInt() @Min(1) @Max(65535) port = 22;
  @IsString() @Matches(/^[a-zA-Z0-9_.-]{1,64}$/) username!: string;
  @IsUUID() credentialId!: string;
  @IsString()
  @Matches(/^(?:SHA256:[A-Za-z0-9+/]{43}=?|[a-fA-F0-9]{64})$/)
  hostKeyFingerprint!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  tags?: string[];
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}
function present(row: Selectable<Database['servers']>) {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    credentialId: row.credential_id,
    hostKeyFingerprint: row.host_key_fingerprint || '',
    osType: row.os_type,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    tags: JSON.parse(row.tags_json) as string[],
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export type Server = ReturnType<typeof present>;
@Injectable()
export class ServersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: CredentialsService,
    private readonly ssh: SshService,
    private readonly audit: AuditService,
  ) {}
  async list() {
    return (
      await this.database.db
        .selectFrom('servers')
        .selectAll()
        .where('is_active', '=', 1)
        .orderBy('created_at', 'desc')
        .execute()
    ).map(present);
  }
  async get(id: string) {
    const row = await this.database.db
      .selectFrom('servers')
      .selectAll()
      .where('id', '=', id)
      .where('is_active', '=', 1)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('服务器不存在');
    return present(row);
  }
  async snapshot(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length > 100)
      throw new BadRequestException('必须明确选择 1–100 台服务器');
    return Promise.all(unique.map((id) => this.get(id)));
  }
  async detail(id: string) {
    const server = await this.get(id);
    const db = this.database.db;
    const [groups, projects, deployments, commands, probes] = await Promise.all([
      db
        .selectFrom('server_groups as groups')
        .innerJoin('server_group_members as members', 'members.group_id', 'groups.id')
        .select(['groups.id as id', 'groups.name as name'])
        .where('members.server_id', '=', id)
        .orderBy('groups.name')
        .execute(),
      db
        .selectFrom('projects as projects')
        .innerJoin('services as services', 'services.project_id', 'projects.id')
        .innerJoin('service_environment_configs as configs', 'configs.service_id', 'services.id')
        .innerJoin('deployment_target_servers as members', 'members.target_id', 'configs.target_id')
        .select(['projects.id as id', 'projects.name as name', 'projects.slug as slug'])
        .distinct()
        .where('members.server_id', '=', id)
        .where('projects.deleted_at', 'is', null)
        .orderBy('projects.name')
        .execute(),
      recentDeployments(db, { serverId: id }),
      db
        .selectFrom('task_targets as targets')
        .innerJoin('tasks as tasks', 'tasks.id', 'targets.task_id')
        .select([
          'targets.id as id',
          'targets.task_id as taskId',
          'tasks.task_type as taskType',
          'tasks.name as name',
          'targets.status as status',
          'targets.exit_code as exitCode',
          'targets.started_at as startedAt',
          'targets.finished_at as finishedAt',
        ])
        .where('targets.server_id', '=', id)
        .where('tasks.task_type', 'in', ['COMMAND', 'OPERATION_PLAN'])
        .orderBy('tasks.created_at', 'desc')
        .orderBy('tasks.id')
        .limit(20)
        .execute(),
      db
        .selectFrom('audit_logs')
        .select(['id', 'created_at', 'details_json'])
        .where('resource_type', '=', 'server')
        .where('resource_id', '=', id)
        .where('action', '=', 'server.test')
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute(),
    ]);
    return {
      ...server,
      groups,
      projects,
      recentDeployments: deployments,
      recentCommands: commands,
      probeHistory: probes.map((row) => {
        const detail = JSON.parse(row.details_json) as {
          status: string;
          checkedAt?: number;
        } & ReturnType<typeof summarizeProbe>;
        return {
          id: row.id,
          status: detail.status,
          checkedAt: detail.checkedAt ?? row.created_at,
          osType: detail.osType ?? null,
          metrics: detail.metrics,
        };
      }),
    };
  }
  async create(dto: ServerDto, userId: string) {
    await this.credentials.assertSsh(dto.credentialId);
    const now = Date.now();
    const id = randomUUID();
    await this.database.db
      .insertInto('servers')
      .values({
        id,
        name: dto.name,
        host: dto.host,
        port: dto.port,
        username: dto.username,
        credential_id: dto.credentialId,
        host_key_fingerprint: dto.hostKeyFingerprint,
        tags_json: JSON.stringify(dto.tags || []),
        description: dto.description ?? '',
        status: 'UNKNOWN',
        os_type: null,
        last_checked_at: null,
        is_active: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await this.audit.record(userId, 'server.create', 'server', id);
    return this.get(id);
  }
  async update(id: string, dto: ServerDto, userId: string) {
    const previous = await this.get(id);
    await this.credentials.assertSsh(dto.credentialId);
    const connectionChanged =
      previous.host !== dto.host ||
      previous.port !== dto.port ||
      previous.username !== dto.username ||
      previous.credentialId !== dto.credentialId ||
      previous.hostKeyFingerprint !== dto.hostKeyFingerprint;
    await this.database.db
      .updateTable('servers')
      .set({
        name: dto.name,
        host: dto.host,
        port: dto.port,
        username: dto.username,
        credential_id: dto.credentialId,
        host_key_fingerprint: dto.hostKeyFingerprint,
        tags_json: JSON.stringify(dto.tags || []),
        description: dto.description ?? previous.description,
        ...(connectionChanged ? { status: 'UNKNOWN', last_checked_at: null, os_type: null } : {}),
        updated_at: Date.now(),
      })
      .where('id', '=', id)
      .where('is_active', '=', 1)
      .execute();
    await this.audit.record(userId, 'server.update', 'server', id);
    return this.get(id);
  }
  async test(id: string, userId: string) {
    const server = await this.get(id);
    let result: Awaited<ReturnType<SshService['probe']>> | null = null;
    try {
      const probe = await this.ssh.probe(server);
      if (probe.exitCode === 0) result = probe;
    } catch {
      // Connection failures are reported as offline. Database and audit failures propagate separately.
    }
    const checkedAt = Date.now();
    const status = result ? 'ONLINE' : 'OFFLINE';
    const summary = result ? summarizeProbe(result.output) : { osType: null };
    const updated = await this.database.db
      .updateTable('servers')
      .set({ status, last_checked_at: checkedAt, ...(result ? { os_type: summary.osType } : {}) })
      .where('id', '=', id)
      .where('is_active', '=', 1)
      .where('updated_at', '=', server.updatedAt)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new ConflictException('服务器配置已变化，请重新检测');
    await this.audit.record(userId, 'server.test', 'server', id, { status, checkedAt, ...summary });
    if (!result)
      throw new BadRequestException('SSH 连接失败：请检查地址、凭据、网络及已确认的主机指纹');
    return { success: true, server: await this.get(id), result };
  }
  async remove(id: string, userId: string) {
    await this.get(id);
    await this.database.db
      .updateTable('servers')
      .set({ is_active: 0, updated_at: Date.now() })
      .where('id', '=', id)
      .execute();
    await this.audit.record(userId, 'server.delete', 'server', id);
    return { success: true };
  }
}
@Controller('servers')
class ServersController {
  constructor(private readonly service: ServersService) {}
  @Get() list() {
    return this.service.list();
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.service.detail(id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post() create(@Body() dto: ServerDto, @Req() req: AuthRequest) {
    return this.service.create(dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Patch(':id') update(
    @Param('id') id: string,
    @Body() dto: ServerDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.update(id, dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post(':id/test') test(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.test(id, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Delete(':id') remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.remove(id, req.user.id);
  }
}
@Global()
@Module({
  controllers: [ServersController],
  providers: [ServersService],
  exports: [ServersService],
})
export class ServersModule {}
