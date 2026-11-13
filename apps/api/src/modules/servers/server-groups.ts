import {
  Body,
  Controller,
  Delete,
  Get,
  Module,
  NotFoundException,
  Param,
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
    const members = await this.database.db.selectFrom('server_group_members').selectAll().execute();
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      serverIds: members.filter((m) => m.group_id === g.id).map((m) => m.server_id),
    }));
  }
  @Roles('ADMIN', 'OPERATOR') @Post() async create(@Body() dto: GroupDto, @Req() req: AuthRequest) {
    if (dto.serverIds.length) await this.servers.snapshot(dto.serverIds);
    const id = randomUUID();
    const now = Date.now();
    await this.database.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('server_groups')
        .values({ id, name: dto.name, description: dto.description || '', created_at: now })
        .execute();
      for (const serverId of new Set(dto.serverIds))
        await tx
          .insertInto('server_group_members')
          .values({ group_id: id, server_id: serverId, created_at: now })
          .execute();
    });
    await this.audit.record(req.user.id, 'server-group.create', 'server-group', id);
    return (await this.list()).find((g) => g.id === id);
  }
  @Roles('ADMIN', 'OPERATOR') @Delete(':id') async remove(
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    if (
      !(await this.database.db
        .selectFrom('server_groups')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst())
    )
      throw new NotFoundException('分组不存在');
    await this.database.db.deleteFrom('server_groups').where('id', '=', id).execute();
    await this.audit.record(req.user.id, 'server-group.delete', 'server-group', id);
    return { success: true };
  }
}
@Module({ controllers: [ServerGroupsController] })
export class ServerGroupsModule {}
