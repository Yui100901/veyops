import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { ServersService } from './servers.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { lockProjectGraph } from '../projects/project-relations';
import {
  assertProjectResourceRemovable,
  unavailableReference,
} from '../projects/project-resource-protection';
class GroupDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true }) serverIds!: string[];
}
@Controller('server-groups')
class ServerGroupsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly servers: ServersService,
    private readonly audit: AuditService,
  ) {}
  @Get() async list() {
    const groups = await this.database.db.selectFrom('server_groups').selectAll().execute();
    const members = await this.database.db
      .selectFrom('server_group_members')
      .innerJoin('servers', 'servers.id', 'server_group_members.server_id')
      .select(['group_id', 'server_id'])
      .where('servers.is_active', '=', 1)
      .orderBy('server_group_members.sort_order')
      .orderBy('server_group_members.created_at')
      .orderBy('server_group_members.server_id')
      .execute();
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      serverIds: members.filter((m) => m.group_id === g.id).map((m) => m.server_id),
    }));
  }
  @Roles('ADMIN', 'OPERATOR') @Post() create(@Body() dto: GroupDto, @Req() req: AuthRequest) {
    return this.save(dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Patch(':id') update(
    @Param('id') id: string,
    @Body() dto: GroupDto,
    @Req() req: AuthRequest,
  ) {
    return this.save(dto, req.user.id, id);
  }
  private async save(dto: GroupDto, userId: string, groupId?: string) {
    if (dto.serverIds.length) await this.servers.snapshot(dto.serverIds);
    const id = groupId ?? randomUUID();
    const now = Date.now();
    const values = { name: dto.name, description: dto.description ?? '' };
    const serverIds = [...new Set(dto.serverIds)];
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
      if (groupId) {
        const updated = await tx
          .updateTable('server_groups')
          .set(values)
          .where('id', '=', id)
          .returning('id')
          .executeTakeFirst();
        if (!updated) throw new NotFoundException('分组不存在');
        await tx.deleteFrom('server_group_members').where('group_id', '=', id).execute();
      } else {
        await tx
          .insertInto('server_groups')
          .values({ id, ...values, created_at: now })
          .execute();
      }
      if (serverIds.length)
        await tx
          .insertInto('server_group_members')
          .values(
            serverIds.map((serverId, index) => ({
              group_id: id,
              server_id: serverId,
              created_at: now,
              sort_order: index,
            })),
          )
          .execute();
    });
    await this.audit.record(
      userId,
      groupId ? 'server-group.update' : 'server-group.create',
      'server-group',
      id,
    );
    return { id, ...values, serverIds };
  }
  @Roles('ADMIN', 'OPERATOR') @Delete(':id') async remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      const group = await tx
        .selectFrom('server_groups')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!group) throw new NotFoundException('分组不存在');
      await assertProjectResourceRemovable(tx, { resourceType: 'SERVER_GROUP', resourceId: id });
      await tx.deleteFrom('server_groups').where('id', '=', id).execute();
      await this.audit.record(
        req.user.id,
        'server-group.delete',
        'server-group',
        id,
        undefined,
        tx,
      );
    });
    return { success: true };
  }
}
@Module({ controllers: [ServerGroupsController] })
export class ServerGroupsModule {}
