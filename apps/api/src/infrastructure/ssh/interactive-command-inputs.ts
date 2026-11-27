import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { encryptionKey } from '../../core/config';
import { DatabaseService } from '../../core/database/database.service';
import type { CurrentUser } from '../../modules/auth/auth.decorators';
import type { InteractiveCommandInputDto } from '../../modules/command-center/command.dto';
import { lockTaskLease, TaskLeaseUnavailableError } from '../../modules/tasks/task-lease';
import type { TaskPayload } from '../../modules/tasks/tasks.types';

const inputLifetime = 120_000;
const pendingLimit = 16;

@Injectable()
export class InteractiveCommandInputs {
  private readonly key = encryptionKey();

  constructor(private readonly database: DatabaseService) {}

  async send(taskId: string, input: InteractiveCommandInputDto, user: CurrentUser) {
    const line = input.input.replace(/\r\n/g, '\n');
    if (!line || /[\x00-\x08\x0b-\x1f\x7f]/.test(line))
      throw new BadRequestException('交互输入只接受文本和换行');
    if (line.split('\n').some((part) => Buffer.byteLength(part) > 4095))
      throw new BadRequestException('交互输入每行不能超过 4095 字节');
    const requested = input.targetIds == null ? undefined : [...new Set(input.targetIds)];
    if (requested && !requested.length) throw new BadRequestException('请选择接收输入的目标');
    const now = Date.now();
    return this.database.db.transaction().execute(async (tx) => {
      // Use the same parent lock as the Worker before examining target state or input order.
      const task = await tx
        .updateTable('tasks')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', taskId)
        .returning(['status', 'task_type', 'created_by', 'payload_json'])
        .executeTakeFirst();
      if (!task) throw new NotFoundException('任务不存在');
      if (user.role !== 'ADMIN' && (user.role !== 'OPERATOR' || task.created_by !== user.id))
        throw new ForbiddenException('仅任务执行者或管理员可以发送交互输入');
      if (
        task.task_type !== 'COMMAND' ||
        !(JSON.parse(task.payload_json) as TaskPayload).interactive
      )
        throw new BadRequestException('该任务不接收交互输入');
      if (task.status !== 'RUNNING') throw new ConflictException('交互任务尚未启动或已结束');
      const targets = await tx
        .selectFrom('task_targets')
        .select('id')
        .where('task_id', '=', taskId)
        .where('status', '=', 'RUNNING')
        .$if(Boolean(requested), (query) => query.where('id', 'in', requested!))
        .execute();
      if (!targets.length || (requested && targets.length !== requested.length))
        throw new ConflictException('部分目标尚未启动或已断开，请刷新目标状态');
      for (const { id } of targets) {
        await tx
          .deleteFrom('interactive_command_inputs')
          .where('task_target_id', '=', id)
          .where('created_at', '<', now - inputLifetime)
          .execute();
        const pending = await tx
          .selectFrom('interactive_command_inputs')
          .select('sequence')
          .where('task_target_id', '=', id)
          .orderBy('sequence', 'desc')
          .execute();
        if (pending.length >= pendingLimit)
          throw new ConflictException('交互输入处理较慢，请稍后再发送');
        await tx
          .insertInto('interactive_command_inputs')
          .values({
            id: randomUUID(),
            task_target_id: id,
            sequence: Math.max(now, Number(pending[0]?.sequence ?? 0) + 1),
            created_at: now,
            encrypted_input: this.encrypt(line.endsWith('\n') ? line : line + '\n', id),
          })
          .execute();
      }
      return { targetIds: targets.map(({ id }) => id) };
    });
  }

  async receive(
    taskId: string,
    targetId: string,
    owner: string,
    write: (line: string) => Promise<void>,
    signal: AbortSignal,
  ) {
    while (!signal.aborted) {
      const db = this.database.db;
      const hasInput = await db
        .selectFrom('interactive_command_inputs')
        .select('id')
        .where('task_target_id', '=', targetId)
        .executeTakeFirst();
      if (hasInput && !signal.aborted) {
        const rows = await db.transaction().execute(async (tx) => {
          if (!(await lockTaskLease(tx, taskId, owner))) throw new TaskLeaseUnavailableError();
          return tx
            .deleteFrom('interactive_command_inputs')
            .where('task_target_id', '=', targetId)
            .returning(['sequence', 'created_at', 'encrypted_input'])
            .execute();
        });
        for (const row of rows.sort((a, b) => Number(a.sequence) - Number(b.sequence))) {
          if (signal.aborted) return;
          if (Number(row.created_at) >= Date.now() - inputLifetime)
            await write(this.decrypt(row.encrypted_input, targetId));
        }
      }
      await pause(400, undefined, { signal }).catch(() => undefined);
    }
  }

  async clear(targetId: string) {
    await this.database.db
      .deleteFrom('interactive_command_inputs')
      .where('task_target_id', '=', targetId)
      .execute();
  }

  private encrypt(input: string, targetId: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(targetId));
    const encrypted = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  private decrypt(input: string, targetId: string) {
    const frame = Buffer.from(input, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, frame.subarray(0, 12));
    decipher.setAAD(Buffer.from(targetId));
    decipher.setAuthTag(frame.subarray(12, 28));
    return Buffer.concat([decipher.update(frame.subarray(28)), decipher.final()]).toString('utf8');
  }
}
