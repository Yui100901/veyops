import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';

export class DeploymentSelectionDto {
  @IsOptional() @IsUUID() targetId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  serverIds?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  groupIds?: string[];
  @IsOptional() @IsIn(['PARALLEL', 'SEQUENTIAL']) strategy?: 'PARALLEL' | 'SEQUENTIAL';
  @IsOptional() @IsInt() @Min(1) @Max(10) maxParallel?: number;
  @IsOptional() @IsIn(['CONTINUE', 'STOP']) failurePolicy?: 'CONTINUE' | 'STOP';
}

export interface DeploymentSelection {
  serverIds: string[];
  groupIds: string[];
  strategy: 'PARALLEL' | 'SEQUENTIAL';
  maxParallel: number;
  failurePolicy: 'CONTINUE' | 'STOP';
}

export function directDeploymentSelection(
  input: DeploymentSelectionDto,
  defaultParallel: number,
): DeploymentSelection | undefined {
  if (input.serverIds === undefined && input.groupIds === undefined) return undefined;
  if (input.targetId) throw new BadRequestException('请选择服务器或服务器分组，不能同时指定旧目标');
  const serverIds = [...new Set(input.serverIds)];
  const groupIds = [...new Set(input.groupIds)];
  if (!serverIds.length && !groupIds.length)
    throw new BadRequestException('请选择服务器或服务器分组');
  return {
    serverIds,
    groupIds,
    strategy: input.strategy ?? 'PARALLEL',
    maxParallel: input.maxParallel ?? defaultParallel,
    failurePolicy: input.failurePolicy ?? 'CONTINUE',
  };
}

export function storedDeploymentSelection(value?: string | null): DeploymentSelection | undefined {
  return value ? (JSON.parse(value) as DeploymentSelection) : undefined;
}

export async function selectedServerIds(
  db: Kysely<Database>,
  selection: Pick<DeploymentSelection, 'serverIds' | 'groupIds'>,
) {
  const ids = [...selection.serverIds];
  if (selection.groupIds.length) {
    const rows = await db
      .selectFrom('server_groups as group')
      .leftJoin('server_group_members as member', 'member.group_id', 'group.id')
      .leftJoin('servers as server', (join) =>
        join.onRef('server.id', '=', 'member.server_id').on('server.is_active', '=', 1),
      )
      .where('group.id', 'in', selection.groupIds)
      .select(['group.id as groupId', 'server.id as serverId'])
      .orderBy('member.sort_order')
      .orderBy('member.created_at')
      .orderBy('member.server_id')
      .execute();
    for (const groupId of selection.groupIds) {
      const members = rows.flatMap((row) =>
        row.groupId === groupId && row.serverId ? [row.serverId] : [],
      );
      if (!members.length) throw new BadRequestException('所选分组不存在或没有可用服务器');
      ids.push(...members);
    }
  }
  const unique = [...new Set(ids)];
  if (!unique.length || unique.length > 100)
    throw new BadRequestException('必须明确选择 1–100 台服务器');
  const active = await db
    .selectFrom('servers')
    .select('id')
    .where('id', 'in', unique)
    .where('is_active', '=', 1)
    .execute();
  if (active.length !== unique.length)
    throw new BadRequestException('部分所选服务器不存在或已停用');
  return unique;
}

export async function confirmDeploymentMembers(
  tx: Transaction<Database>,
  selection: DeploymentSelection,
  expected: string[],
) {
  for (const groupId of [...selection.groupIds].sort()) {
    const group = await tx
      .updateTable('server_groups')
      .set((eb) => ({ id: eb.ref('id') }))
      .where('id', '=', groupId)
      .returning('id')
      .executeTakeFirst();
    if (!group) throw new ConflictException('服务器分组已变化，请重新预览');
  }
  const current = await selectedServerIds(tx, selection);
  if (JSON.stringify(current) !== JSON.stringify(expected))
    throw new ConflictException('执行成员已变化，请重新预览');
}
