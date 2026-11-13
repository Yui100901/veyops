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
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { ServersService } from '../servers/servers.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';

export class DeploymentTargetDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description = '';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  serverIds!: string[];
  @IsOptional() @IsIn(['PARALLEL', 'SEQUENTIAL']) strategy = 'PARALLEL';
  @IsOptional() @IsInt() @Min(1) @Max(10) maxParallel = 3;
  @IsOptional() @IsIn(['CONTINUE', 'STOP']) failurePolicy = 'CONTINUE';
}
@Injectable()
export class DeploymentTargetsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly servers: ServersService,
    private readonly audit: AuditService,
  ) {}
  async list() {
    const rows = await this.database.db
      .selectFrom('deployment_targets')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    const members = await this.database.db
      .selectFrom('deployment_target_servers')
      .selectAll()
      .orderBy('sort_order')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      strategy: r.strategy,
      maxParallel: r.max_parallel,
      failurePolicy: r.failure_policy,
      serverIds: members.filter((m) => m.target_id === r.id).map((m) => m.server_id),
      createdAt: r.created_at,
    }));
  }
  async get(id: string) {
    const target = (await this.list()).find((r) => r.id === id);
    if (!target) throw new NotFoundException('部署目标不存在');
    return target;
  }
  async snapshot(id: string) {
    const target = await this.get(id);
    return { ...target, servers: await this.servers.snapshot(target.serverIds) };
  }
  async save(input: DeploymentTargetDto, userId: string, id?: string) {
    const serverIds = [...new Set(input.serverIds)];
    if (!serverIds.length) throw new BadRequestException('部署目标不能为空');
    await this.servers.snapshot(serverIds);
    if (id) await this.get(id);
    const targetId = id || randomUUID(),
      now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      const values = {
        name: input.name,
        description: input.description,
        strategy: input.strategy,
        max_parallel: input.maxParallel,
        failure_policy: input.failurePolicy,
        updated_at: now,
      };
      if (id) {
        await tx.updateTable('deployment_targets').set(values).where('id', '=', id).execute();
        await tx.deleteFrom('deployment_target_servers').where('target_id', '=', id).execute();
      } else
        await tx
          .insertInto('deployment_targets')
          .values({ id: targetId, ...values, created_at: now })
          .execute();
      await tx
        .insertInto('deployment_target_servers')
        .values(
          serverIds.map((serverId, index) => ({
            target_id: targetId,
            server_id: serverId,
            sort_order: index,
          })),
        )
        .execute();
    });
    await this.audit.record(
      userId,
      id ? 'deployment-target.update' : 'deployment-target.create',
      'deployment-target',
      targetId,
      { targetCount: serverIds.length },
    );
    return this.get(targetId);
  }
  async remove(id: string, userId: string) {
    await this.get(id);
    try {
      await this.database.db.deleteFrom('deployment_targets').where('id', '=', id).execute();
    } catch {
      throw new ConflictException('部署目标被环境配置或历史记录引用，不能删除');
    }
    await this.audit.record(userId, 'deployment-target.delete', 'deployment-target', id);
    return { success: true };
  }
}
@Controller('deployment-targets')
class DeploymentTargetsController {
  constructor(private readonly service: DeploymentTargetsService) {}
  @Get() list() {
    return this.service.list();
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.service.get(id);
  }
  @Roles('ADMIN', 'OPERATOR') @Post() create(
    @Body() dto: DeploymentTargetDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.save(dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Patch(':id') update(
    @Param('id') id: string,
    @Body() dto: DeploymentTargetDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.save(dto, req.user.id, id);
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
  controllers: [DeploymentTargetsController],
  providers: [DeploymentTargetsService],
  exports: [DeploymentTargetsService],
})
export class DeploymentTargetsModule {}
