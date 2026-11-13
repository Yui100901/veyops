import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kysely, Migrator, PostgresDialect, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import { Pool, types } from 'pg';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { workspaceRoot } from '../config';
import type { Database } from './schema';
import { initialMigration } from './migrations';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly db: Kysely<Database>;
  readonly client = process.env.DATABASE_CLIENT || 'sqlite';
  constructor() {
    if (this.client === 'postgres') {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for postgres');
      types.setTypeParser(20, (value) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error('BIGINT exceeds safe integer range');
        return number;
      });
      this.db = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: process.env.DATABASE_URL }),
        }),
      });
    } else if (this.client === 'sqlite') {
      const path =
        process.env.DATABASE_PATH === ':memory:'
          ? ':memory:'
          : resolve(workspaceRoot, process.env.DATABASE_PATH || 'data/database/app.db');
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      const sqlite = new BetterSqlite3(path);
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('synchronous = NORMAL');
      sqlite.pragma('foreign_keys = ON');
      sqlite.pragma('busy_timeout = 5000');
      this.db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
    } else throw new Error('DATABASE_CLIENT must be sqlite or postgres');
  }
  async onModuleInit() {
    const migrator = new Migrator({
      db: this.db,
      provider: { getMigrations: async () => ({ '001_initial': initialMigration }) },
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  }
  async onModuleDestroy() {
    await this.db.destroy();
  }
}
@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
