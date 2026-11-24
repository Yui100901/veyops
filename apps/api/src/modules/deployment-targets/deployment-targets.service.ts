import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
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
  ValidateIf,
} from 'class-validator';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { ServersService } from '../servers/servers.service';
import { AuditService } from '../audit/audit.service';
import { SystemSettingsService } from '../system/system-settings.service';
import { lockProjectGraph } from '../projects/project-guards';
import {
  assertProjectResourceRemovable,
  ResourceReferenceConflict,
  unavailableReference,
} from '../projects/project-resource-protection';

export class DeploymentTargetDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description = '';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  serverIds!: string[];
  @IsOptional() @IsIn(['PARALLEL', 'SEQUENTIAL']) strategy = 'PARALLEL';
  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10)
  maxParallel?: number;
  @IsOptional() @IsIn(['CONTINUE', 'STOP']) failurePolicy = 'CONTINUE';
}
@Injectable()
export class DeploymentTargetsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly servers: ServersService,
    private readonly audit: AuditService,
    private readonly settings: SystemSettingsService,
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
    const maxParallel =
      input.maxParallel ?? (id ? undefined : (await this.settings.get()).defaultMaxParallelTargets);
    const targetId = id || randomUUID(),
      now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      if (
        await unavailableReference(
          tx,
          '',
          serverIds.map((resourceId) => ({ resourceType: 'SERVER', resourceId })),
        )
      )
        throw new BadRequestException('部分服务器已停用或不存在');
      const values = {
        name: input.name,
        description: input.description,
        strategy: input.strategy,
        max_parallel: maxParallel,
        failure_policy: input.failurePolicy,
        updated_at: now,
      };
      if (id) {
        const updated = await tx
          .updateTable('deployment_targets')
          .set(values)
          .where('id', '=', id)
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw new NotFoundException('部署目标不存在');
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
      await this.database.db.transaction().execute(async (tx) => {
        await lockProjectGraph(tx);
        await assertProjectResourceRemovable(tx, { resourceType: 'LEGACY_TARGET', resourceId: id });
        const removed = await tx
          .deleteFrom('deployment_targets')
          .where('id', '=', id)
          .returning('id')
          .executeTakeFirst();
        if (!removed) throw new NotFoundException('部署目标不存在');
      });
    } catch (error) {
      if (error instanceof ResourceReferenceConflict || error instanceof NotFoundException)
        throw error;
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
}
@Global()
@Module({
  controllers: [DeploymentTargetsController],
  providers: [DeploymentTargetsService],
  exports: [DeploymentTargetsService],
})
export class DeploymentTargetsModule {}
