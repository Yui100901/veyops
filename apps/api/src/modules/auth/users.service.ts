import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Selectable, Transaction } from 'kysely';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import type { Database, UsersTable } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { hashPassword } from './auth-password';
import { lockActiveSession, revokeUserSessions } from './auth-sessions';
import type { Role } from './auth.decorators';
import type { CreateUserDto, UpdateUserDto, UserStatus } from './users.dto';

const userColumns = [
  'id',
  'username',
  'role',
  'status',
  'must_change_password',
  'created_at',
  'updated_at',
] as const;
type UserRow = Pick<Selectable<UsersTable>, (typeof userColumns)[number]>;

function publicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    role: row.role as Role,
    status: row.status as UserStatus,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const users = await this.database.db
      .selectFrom('users')
      .select(userColumns)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return users.map(publicUser);
  }

  async create(input: CreateUserDto, actorId: string, token: string | undefined) {
    const passwordHash = await hashPassword(input.password);
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockAdministrator(tx, actorId, token);
      const now = Date.now();
      const user = await tx
        .insertInto('users')
        .values({
          id: randomUUID(),
          username: input.username,
          password_hash: passwordHash,
          must_change_password: 1,
          role: input.role,
          status: 'ACTIVE',
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) => conflict.column('username').doNothing())
        .returning(userColumns)
        .executeTakeFirst();
      if (!user) throw new ConflictException('用户名已存在');
      await this.audit.record(actorId, 'user.create', 'user', user.id, { role: input.role }, tx);
      return publicUser(user);
    });
  }

  async update(id: string, input: UpdateUserDto, actorId: string, token: string | undefined) {
    if (id === actorId) throw new ConflictException('不能修改当前账户的角色或状态');
    if (input.role === undefined && input.status === undefined)
      throw new BadRequestException('请提供角色或状态');
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockAdministrator(tx, actorId, token);
      const current = await tx
        .selectFrom('users')
        .select(userColumns)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!current) throw new NotFoundException('用户不存在');
      const role = input.role ?? current.role;
      const status = input.status ?? current.status;
      if (role === current.role && status === current.status) return publicUser(current);

      const now = Date.now();
      const changed = await tx
        .updateTable('users')
        .set({ role, status, updated_at: now })
        .where('id', '=', id)
        .returning(userColumns)
        .executeTakeFirstOrThrow();
      await revokeUserSessions(tx, id, now);
      await this.audit.record(
        actorId,
        'user.update',
        'user',
        id,
        { before: { role: current.role, status: current.status }, after: { role, status } },
        tx,
      );
      return publicUser(changed);
    });
  }

  async resetPassword(id: string, password: string, actorId: string, token: string | undefined) {
    if (id === actorId) throw new ConflictException('请在个人账户中修改自己的密码');
    const passwordHash = await hashPassword(password);
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockAdministrator(tx, actorId, token);
      const now = Date.now();
      const changed = await tx
        .updateTable('users')
        .set({
          password_hash: passwordHash,
          must_change_password: 1,
          password_change_recommended: 0,
          updated_at: now,
        })
        .where('id', '=', id)
        .returning(userColumns)
        .executeTakeFirst();
      if (!changed) throw new NotFoundException('用户不存在');
      await revokeUserSessions(tx, id, now);
      await this.audit.record(actorId, 'user.reset_password', 'user', id, {}, tx);
      return publicUser(changed);
    });
  }

  private async lockAdministrator(tx: Transaction<Database>, actorId: string, token?: string) {
    if (typeof token !== 'string' || token.length !== 64)
      throw new UnauthorizedException('请先登录');

    // Serialize administrative changes before locking any users to avoid cross-admin
    // deadlocks. The actor stays an active administrator throughout the transaction.
    await tx
      .insertInto('system_settings')
      .values({ key: 'auth:user-management-lock', value_json: '{}', updated_at: Date.now() })
      .onConflict((conflict) =>
        conflict.column('key').doUpdateSet((eb) => ({ updated_at: eb.ref('excluded.updated_at') })),
      )
      .execute();
    const actor = await tx
      .updateTable('users')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', actorId)
      .where('role', '=', 'ADMIN')
      .where('status', '=', 'ACTIVE')
      .where('must_change_password', '=', 0)
      .returning('id')
      .executeTakeFirst();
    if (!actor) throw new ForbiddenException('当前账户无权管理用户');
    if (!(await lockActiveSession(tx, actorId, token)))
      throw new UnauthorizedException('登录已过期，请重新登录');
  }
}
