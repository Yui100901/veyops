import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { InitialConfigurationService } from '../../core/initial-configuration';
import type { CurrentUser, Role } from './auth.decorators';
import { seedPlanTemplates } from '../operation-plans/plan-templates';
const scrypt = promisify(scryptCallback);
export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
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
  async setup(username: string, password: string) {
    if ((await this.status()).initialized) throw new ConflictException('系统已初始化');
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)) as Buffer;
    const now = Date.now();
    const user: CurrentUser = { id: randomUUID(), username, role: 'ADMIN' };
    try {
      await this.database.db.transaction().execute(async (tx) => {
        // The fixed settings key serializes concurrent bootstrap attempts in both dialects.
        await tx
          .insertInto('system_settings')
          .values({ key: 'bootstrap_lock', value_json: '{}', updated_at: now })
          .execute();
        if (await tx.selectFrom('users').select('id').executeTakeFirst())
          throw new ConflictException('系统已初始化');
        await tx
          .insertInto('users')
          .values({
            id: user.id,
            username,
            password_hash: `${salt}:${hash.toString('hex')}`,
            role: 'ADMIN',
            status: 'ACTIVE',
            created_at: now,
            updated_at: now,
          })
          .execute();
      });
    } catch {
      throw new ConflictException('系统已初始化或用户名不可用');
    }
    await seedPlanTemplates(this.database.db, user.id);
    await this.initialConfiguration.apply(user.id);
    await this.audit.record(user.id, 'auth.setup', 'user', user.id);
    return this.createSession(user);
  }
  async login(username: string, password: string) {
    const row = await this.database.db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', username)
      .executeTakeFirst();
    // Perform a hash even for unknown users, avoiding an easy account enumeration timing signal.
    const [salt, expected] = row?.password_hash.split(':') || ['0'.repeat(32), '0'.repeat(128)];
    const actual = (await scrypt(password, salt!, 64)) as Buffer;
    if (
      !row ||
      row.status !== 'ACTIVE' ||
      !expected ||
      !timingSafeEqual(actual, Buffer.from(expected, 'hex'))
    )
      throw new UnauthorizedException('用户名或密码错误');
    const user = { id: row.id, username: row.username, role: row.role as Role };
    await this.audit.record(user.id, 'auth.login', 'user', row.id);
    return this.createSession(user);
  }
  private async createSession(user: CurrentUser) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    await this.database.db
      .insertInto('auth_sessions')
      .values({
        id: randomUUID(),
        user_id: user.id,
        token_hash: sessionHash(token),
        expires_at: expiresAt,
        revoked_at: null,
        created_at: Date.now(),
      })
      .execute();
    return { token, user, expiresAt };
  }
  async resolve(token?: string): Promise<CurrentUser> {
    if (!token || token.length !== 64) throw new UnauthorizedException('请先登录');
    const row = await this.database.db
      .selectFrom('auth_sessions')
      .innerJoin('users', 'users.id', 'auth_sessions.user_id')
      .select(['users.id', 'users.username', 'users.role'])
      .where('token_hash', '=', sessionHash(token))
      .where('expires_at', '>', Date.now())
      .where('revoked_at', 'is', null)
      .where('users.status', '=', 'ACTIVE')
      .executeTakeFirst();
    if (!row) throw new UnauthorizedException('登录已过期，请重新登录');
    return { ...row, role: row.role as Role };
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
