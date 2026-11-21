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
  ParseUUIDPipe,
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
import { SshHostKeyMismatchError, SshService } from '../../infrastructure/ssh/ssh.service';
import { summarizeProbe } from '../../infrastructure/ssh/server-probe';
import { compareServerConfigurations } from './configuration-comparison';
import { recentDeployments } from '../deployments/deployment-history';
import { lockProjectGraph } from '../projects/project-relations';
import { assertProjectResourceRemovable } from '../projects/project-resource-protection';
import { targetProjectReferences } from '../projects/project-resource-references';
import type { Selectable } from 'kysely';
import type { Database } from '../../core/database/schema';
import {
  acceptHostKey,
  hostKeyAcceptanceToken,
  hostKeyFingerprint,
  normalizeSshHost,
  offerHostKey,
  sameHostKey,
} from './host-key-acceptance';

class SshEndpointDto {
  @IsString() @Matches(/^[a-zA-Z0-9:._-]{1,253}$/) host!: string;
  @IsInt() @Min(1) @Max(65535) port = 22;
}

class HostKeyProbeDto extends SshEndpointDto {
  @IsOptional() @IsUUID() serverId?: string;
}

class AcceptHostKeyDto {
  @IsString() @Matches(hostKeyAcceptanceToken) hostKeyAcceptanceToken!: string;
}

class CompareConfigurationDto {
  @IsUUID() baselineId!: string;
  @IsUUID() comparisonId!: string;
}

class ServerDto extends SshEndpointDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() @Matches(/^[a-zA-Z0-9_.-]{1,64}$/) username!: string;
  @IsUUID() credentialId!: string;
  @IsOptional() @IsString() @Matches(hostKeyFingerprint) hostKeyFingerprint?: string;
  @IsOptional() @IsString() @Matches(hostKeyAcceptanceToken) hostKeyAcceptanceToken?: string;
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
    active: row.is_active === 1,
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
  async get(id: string, includeInactive = false) {
    const row = await this.database.db
      .selectFrom('servers')
      .selectAll()
      .where('id', '=', id)
      .$if(!includeInactive, (query) => query.where('is_active', '=', 1))
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
  async compareConfiguration(dto: CompareConfigurationDto, userId: string) {
    const baselineId = dto.baselineId.toLowerCase();
    const comparisonId = dto.comparisonId.toLowerCase();
    if (baselineId === comparisonId) throw new BadRequestException('请选择两台不同的服务器');
    const [baseline, comparison] = await Promise.all([
      this.get(baselineId),
      this.get(comparisonId),
    ]);
    const result = await compareServerConfigurations(this.ssh, baseline, comparison);
    await this.audit.record(userId, 'server.configuration.compare', 'server', baselineId, {
      comparisonId,
      baselineStatus: result.baseline.status,
      comparisonStatus: result.comparison.status,
    });
    return result;
  }
  async detail(id: string) {
    const server = await this.get(id, true);
    const db = this.database.db;
    const [groups, projects, deployments, commands, probes] = await Promise.all([
      db
        .selectFrom('server_groups as groups')
        .innerJoin('server_group_members as members', 'members.group_id', 'groups.id')
        .select(['groups.id as id', 'groups.name as name'])
        .where('members.server_id', '=', id)
        .orderBy('groups.name')
        .execute(),
      targetProjectReferences(db, 'SERVER', id),
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
  async projectReferences(id: string) {
    await this.get(id, true);
    return targetProjectReferences(this.database.db, 'SERVER', id);
  }
  async create(dto: ServerDto, userId: string) {
    if (Boolean(dto.hostKeyFingerprint) === Boolean(dto.hostKeyAcceptanceToken))
      throw new BadRequestException('请探测并确认 SSH 主机指纹，或提供一个已独立核对的指纹');
    const host = normalizeSshHost(dto.host);
    await this.credentials.assertSsh(dto.credentialId);
    const now = Date.now();
    const id = randomUUID();
    await this.database.db.transaction().execute(async (tx) => {
      const fingerprint = dto.hostKeyAcceptanceToken
        ? await acceptHostKey(tx, dto.hostKeyAcceptanceToken, { host, port: dto.port, userId })
        : dto.hostKeyFingerprint!;
      await tx
        .insertInto('servers')
        .values({
          id,
          name: dto.name,
          host,
          port: dto.port,
          username: dto.username,
          credential_id: dto.credentialId,
          host_key_fingerprint: fingerprint,
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
      await this.audit.record(
        userId,
        'server.create',
        'server',
        id,
        { host, port: dto.port, fingerprint },
        tx,
      );
    });
    return this.get(id);
  }

  async probeHostKey(dto: HostKeyProbeDto, userId: string) {
    const host = normalizeSshHost(dto.host);
    const previous = dto.serverId ? await this.get(dto.serverId) : undefined;
    let observed: Awaited<ReturnType<SshService['inspectHostKey']>>;
    try {
      observed = await this.ssh.inspectHostKey({ host, port: dto.port });
    } catch {
      throw new BadRequestException('未能读取 SSH 主机指纹，请检查连接地址、端口和网络');
    }
    const offer = await offerHostKey(
      this.database.db,
      { host, port: dto.port, userId, fingerprint: observed.fingerprint },
      previous,
    );
    return {
      host,
      port: dto.port,
      ...observed,
      ...offer,
      ...(previous && {
        ...(previous.hostKeyFingerprint && { previousFingerprint: previous.hostKeyFingerprint }),
        ...(host === normalizeSshHost(previous.host) &&
          dto.port === previous.port && {
            matchesPrevious: sameHostKey(observed.fingerprint, previous.hostKeyFingerprint),
          }),
      }),
    };
  }

  async update(id: string, dto: ServerDto, userId: string) {
    const previous = await this.get(id);
    const host = normalizeSshHost(dto.host);
    const endpointChanged = normalizeSshHost(previous.host) !== host || previous.port !== dto.port;
    if (endpointChanged && (!dto.hostKeyAcceptanceToken || dto.hostKeyFingerprint))
      throw new BadRequestException('已更改 SSH 地址或端口，请重新探测并确认主机指纹');
    if (
      !endpointChanged &&
      (dto.hostKeyAcceptanceToken ||
        (dto.hostKeyFingerprint &&
          !sameHostKey(dto.hostKeyFingerprint, previous.hostKeyFingerprint)))
    )
      throw new BadRequestException('请使用主机指纹的独立确认操作');
    await this.credentials.assertSsh(dto.credentialId);
    const connectionChanged =
      endpointChanged ||
      previous.username !== dto.username ||
      previous.credentialId !== dto.credentialId;
    await this.database.db.transaction().execute(async (tx) => {
      const fingerprint = dto.hostKeyAcceptanceToken
        ? await acceptHostKey(
            tx,
            dto.hostKeyAcceptanceToken,
            { host, port: dto.port, userId },
            previous,
          )
        : undefined;
      const saved = await tx
        .updateTable('servers')
        .set({
          name: dto.name,
          host: endpointChanged ? host : previous.host,
          port: dto.port,
          username: dto.username,
          credential_id: dto.credentialId,
          ...(fingerprint && { host_key_fingerprint: fingerprint }),
          tags_json: JSON.stringify(dto.tags || []),
          description: dto.description ?? previous.description,
          ...(connectionChanged ? { status: 'UNKNOWN', last_checked_at: null, os_type: null } : {}),
          updated_at: Math.max(Date.now(), previous.updatedAt + 1),
        })
        .where('id', '=', id)
        .where('is_active', '=', 1)
        .where('updated_at', '=', previous.updatedAt)
        .returning('id')
        .executeTakeFirst();
      if (!saved) throw new ConflictException('服务器配置已变化，请刷新后重试');
      const detail = fingerprint
        ? {
            previous: {
              host: previous.host,
              port: previous.port,
              fingerprint: previous.hostKeyFingerprint || null,
            },
            accepted: { host, port: dto.port, fingerprint },
          }
        : {};
      await this.audit.record(userId, 'server.update', 'server', id, detail, tx);
    });
    return this.get(id);
  }

  async confirmHostKey(id: string, dto: AcceptHostKeyDto, userId: string) {
    const previous = await this.get(id);
    const host = normalizeSshHost(previous.host);
    await this.database.db.transaction().execute(async (tx) => {
      const accepted = await acceptHostKey(
        tx,
        dto.hostKeyAcceptanceToken,
        { host, port: previous.port, userId },
        previous,
      );
      if (sameHostKey(accepted, previous.hostKeyFingerprint)) return;
      const saved = await tx
        .updateTable('servers')
        .set({
          host_key_fingerprint: accepted,
          status: 'UNKNOWN',
          last_checked_at: null,
          os_type: null,
          updated_at: Math.max(Date.now(), previous.updatedAt + 1),
        })
        .where('id', '=', id)
        .where('is_active', '=', 1)
        .where('updated_at', '=', previous.updatedAt)
        .returning('id')
        .executeTakeFirst();
      if (!saved) throw new ConflictException('服务器配置已变化，请重新探测并确认');
      await this.audit.record(
        userId,
        'server.host_key.accept',
        'server',
        id,
        {
          host,
          port: previous.port,
          previousFingerprint: previous.hostKeyFingerprint || null,
          fingerprint: accepted,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async test(id: string, userId: string) {
    const server = await this.get(id);
    let result: Awaited<ReturnType<SshService['probe']>> | null = null;
    let hostKeyMismatch: SshHostKeyMismatchError | undefined;
    try {
      const probe = await this.ssh.probe(server);
      if (probe.exitCode === 0) result = probe;
    } catch (error) {
      if (error instanceof SshHostKeyMismatchError) hostKeyMismatch = error;
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
    await this.audit.record(userId, 'server.test', 'server', id, {
      status,
      checkedAt,
      ...summary,
      ...(hostKeyMismatch && { reason: 'HOST_KEY_MISMATCH' }),
    });
    if (hostKeyMismatch)
      throw new ConflictException(
        `${hostKeyMismatch.message}，核实后请选择「核对 SSH 指纹」并重新确认`,
      );
    if (!result)
      throw new BadRequestException('SSH 连接失败：请检查地址、凭据、网络及已确认的主机指纹');
    return { success: true, server: await this.get(id), result };
  }
  async remove(id: string, userId: string) {
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const server = await tx
        .selectFrom('servers')
        .select('id')
        .where('id', '=', id)
        .where('is_active', '=', 1)
        .executeTakeFirst();
      if (!server) throw new NotFoundException('服务器不存在');
      await assertProjectResourceRemovable(tx, { resourceType: 'SERVER', resourceId: id });
      await tx
        .updateTable('servers')
        .set({ is_active: 0, updated_at: Date.now() })
        .where('id', '=', id)
        .execute();
      await this.audit.record(userId, 'server.delete', 'server', id, undefined, tx);
    });
    return { success: true };
  }
}
@Controller('servers')
class ServersController {
  @Roles('ADMIN', 'OPERATOR') @Post('configuration/compare') compare(
    @Body() dto: CompareConfigurationDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.compareConfiguration(dto, req.user.id);
  }
  constructor(private readonly service: ServersService) {}
  @Get() list() {
    return this.service.list();
  }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
  @Get(':id/project-references') projectReferences(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.projectReferences(id);
  }
  @Roles('ADMIN') @Post() create(@Body() dto: ServerDto, @Req() req: AuthRequest) {
    return this.service.create(dto, req.user.id);
  }
  @Roles('ADMIN') @Post('host-key/probe') probeHostKey(
    @Body() dto: HostKeyProbeDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.probeHostKey(dto, req.user.id);
  }
  @Roles('ADMIN') @Post(':id/host-key/accept') confirmHostKey(
    @Param('id') id: string,
    @Body() dto: AcceptHostKeyDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.confirmHostKey(id, dto, req.user.id);
  }
  @Roles('ADMIN') @Patch(':id') update(
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
  @Roles('ADMIN') @Delete(':id') remove(
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
