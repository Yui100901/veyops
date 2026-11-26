import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const statuses = ['ALL', 'ACTIVE', 'SUCCESS', 'FAILED'] as const;

export class TaskCenterQuery {
  @IsOptional() @IsIn(statuses) status?: (typeof statuses)[number];
  @IsOptional() @IsString() @MaxLength(160) q?: string;
  @IsOptional() @IsString() @MaxLength(256) before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export type TaskCenterCursor = {
  createdAt: number;
  id: string;
  kind: 0 | 1;
};

export function taskCenterCursor(encoded: string): TaskCenterCursor {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(encoded)) throw new Error();
    const { createdAt, id, kind } = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<TaskCenterCursor>;
    if (
      !Number.isSafeInteger(createdAt) ||
      typeof id !== 'string' ||
      !id.length ||
      id.length > 128 ||
      (kind !== 0 && kind !== 1)
    )
      throw new Error();
    return { createdAt: createdAt!, id, kind };
  } catch {
    throw new BadRequestException('任务列表分页位置无效');
  }
}

export function encodeTaskCenterCursor({ createdAt, id, kind }: TaskCenterCursor) {
  return Buffer.from(JSON.stringify({ createdAt, id, kind })).toString('base64url');
}
