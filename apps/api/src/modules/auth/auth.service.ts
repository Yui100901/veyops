import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { InitialConfigurationService } from '../../core/initial-configuration';
import type { Role, SessionUser } from './auth.decorators';
import { seedPlanTemplates } from '../operation-plans/plan-templates';
import { dummyPasswordHash, hashPassword, matchesPassword } from './auth-password';
import { lockActiveSession, revokeUserSessions, sessionHash } from './auth-sessions';

const adminUsername = 'root';
const bootstrapLock = 'bootstrap_lock';
const sessionLifetime = 12 * 60 * 60 * 1000;

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly initialConfiguration: InitialConfigurationService,
  ) {}
  async status() {
    return {
      initialized: !!(await this.database.db
        .selectFrom('users')
        .select('id')
        .limit(1)
        .executeTakeFirst()),
    };
  }
  async onApplicationBootstrap() {
    if ((await this.status()).initialized) return;
    const configured = process.env.ADMIN_PASSWORD;
    if (configured && (configured.length < 12 || configured.length > 256))
      throw new Error('ADMIN_PASSWORD must be 12–256 characters when initializing a new database');
    const password = configured || randomBytes(24).toString('base64url');
    const passwordHash = await hashPassword(password);
    const now = Date.now();
    const userId = randomUUID();
    const created = await this.database.db.transaction().execute(async (tx) => {
      // Acquire the same write lock before checking for users, including on an existing lock row.
      await tx
        .insertInto('system_settings')
        .values({ key: bootstrapLock, value_json: '{}', updated_at: now })
        .onConflict((conflict) => conflict.column('key').doUpdateSet({ updated_at: now }))
        .execute();
      if (await tx.selectFrom('users').select('id').limit(1).executeTakeFirst()) return false;
      await tx
        .insertInto('users')
        .values({
          id: userId,
          username: adminUsername,
          password_hash: passwordHash,
          role: 'ADMIN',
          status: 'ACTIVE',
          must_change_password: 1,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return true;
    });
    if (!created) return;
    // Write directly after the transaction commits so a later startup error cannot lose the password.
    if (!configured) console.log(`veyops generated initial password for root: ${password}`);
    await seedPlanTemplates(this.database.db, userId);
    await this.initialConfiguration.apply(userId);
    await this.audit.record(null, 'auth.bootstrap', 'user', userId);
  }
  async login(username: string, password: string) {
    const row = await this.database.db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', username)
      .executeTakeFirst();
    // Perform a hash even for unknown users, avoiding an easy account enumeration timing signal.
    const valid = await matchesPassword(password, row?.password_hash || dummyPasswordHash);
    if (!row || row.status !== 'ACTIVE' || !valid)
      throw new UnauthorizedException('用户名或密码错误');
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const expiresAt = now + sessionLifetime;
    const user = await this.database.db.transaction().execute(async (tx) => {
      // Lock the user row and recheck the verified hash before inserting the session. Password
      // rotation either wins before this write or waits and revokes the resulting session.
      const locked = await tx
        .updateTable('users')
        .set((eb) => ({ password_hash: eb.ref('password_hash') }))
        .where('id', '=', row.id)
        .where('status', '=', 'ACTIVE')
        .where('password_hash', '=', row.password_hash)
        .returning(['id', 'username', 'role', 'must_change_password'])
        .executeTakeFirst();
      if (!locked) throw new UnauthorizedException('用户名或密码错误');
      await tx
        .insertInto('auth_sessions')
        .values({
          id: randomUUID(),
          user_id: locked.id,
          token_hash: sessionHash(token),
          expires_at: expiresAt,
          revoked_at: null,
          created_at: now,
        })
        .execute();
      return this.sessionUser(locked);
    });
    await this.audit.record(user.id, 'auth.login', 'user', user.id);
    return { token, user, expiresAt };
  }
  private sessionUser(row: {
    id: string;
    username: string;
    role: string;
    must_change_password: number;
  }): SessionUser {
    return {
      id: row.id,
      username: row.username,
      role: row.role as Role,
      mustChangePassword: row.must_change_password === 1,
    };
  }
  async resolve(token?: string): Promise<SessionUser> {
    if (typeof token !== 'string' || token.length !== 64)
      throw new UnauthorizedException('请先登录');
    const row = await this.database.db
      .selectFrom('auth_sessions')
      .innerJoin('users', 'users.id', 'auth_sessions.user_id')
      .select(['users.id', 'users.username', 'users.role', 'users.must_change_password'])
      .where('token_hash', '=', sessionHash(token))
      .where('expires_at', '>', Date.now())
      .where('revoked_at', 'is', null)
      .where('users.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!row) throw new UnauthorizedException('登录已过期，请重新登录');
    return this.sessionUser(row);
  }
  async changePassword(
    userId: string,
    token: string | undefined,
    currentPassword: string,
    newPassword: string,
  ) {
    if (typeof token !== 'string' || token.length !== 64)
      throw new UnauthorizedException('请先登录');
    if (newPassword.length < 12 || newPassword.length > 256)
      throw new BadRequestException('新密码须为 12–256 个字符');
    if (newPassword === currentPassword) throw new BadRequestException('新密码不能与当前密码相同');
    const row = await this.database.db
      .selectFrom('users')
      .select(['password_hash'])
      .where('id', '=', userId)
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!(await matchesPassword(currentPassword, row?.password_hash || dummyPasswordHash)) || !row)
      throw new UnauthorizedException('当前密码错误');
    const nextHash = await hashPassword(newPassword);
    await this.database.db.transaction().execute(async (tx) => {
      const locked = await tx
        .updateTable('users')
        .set((eb) => ({ password_hash: eb.ref('password_hash') }))
        .where('id', '=', userId)
        .where('status', '=', 'ACTIVE')
        .where('password_hash', '=', row.password_hash)
        .returning('id')
        .executeTakeFirst();
      // Check the session after acquiring the user lock so concurrent role changes cannot
      // leave a password update using a session read before it was revoked.
      if (!locked || !(await lockActiveSession(tx, userId, token)))
        throw new ConflictException('会话或密码已变化，请重新登录');
      const now = Date.now();
      await tx
        .updateTable('users')
        .set({ password_hash: nextHash, must_change_password: 0, updated_at: now })
        .where('id', '=', userId)
        .execute();
      await revokeUserSessions(tx, userId, now);
      await this.audit.record(userId, 'auth.change_password', 'user', userId, {}, tx);
    });
    return { success: true };
  }
  async logout(token?: string) {
    if (!token) throw new BadRequestException('无有效会话');
    await this.database.db
      .updateTable('auth_sessions')
      .set({ revoked_at: Date.now() })
      .where('token_hash', '=', sessionHash(token))
      .execute();
    return { success: true };
  }
}
