import { Global, Injectable, Module, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import {
  Kysely,
  Migrator,
  PostgresDialect,
  SqliteDialect,
  sql,
  type MigrationProvider,
} from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import { Pool, types, type CustomTypesConfig } from 'pg';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { workspaceRoot } from '../config';
import type { Database } from './schema';
import { migrationProvider } from './migrations';

const postgresTypes: CustomTypesConfig = {
  getTypeParser(oid, format) {
    if (oid !== types.builtins.INT8 || format === 'binary') return types.getTypeParser(oid, format);
    return (value: string) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error('BIGINT exceeds safe integer range');
      return number;
    };
  },
};

export async function migrateSqlite(db: Kysely<Database>, provider: MigrationProvider) {
  // Lock before Kysely creates its bookkeeping tables or reads the migration history.
  await db.connection().execute(async (connection) => {
    await sql`begin immediate`.execute(connection);
    try {
      const { error } = await new Migrator({ db: connection, provider }).migrateToLatest();
      if (error) throw error;
      await sql`commit`.execute(connection);
    } catch (error) {
      await sql`rollback`.execute(connection);
      throw error;
    }
  });
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  readonly db: Kysely<Database>;
  readonly client = process.env.DATABASE_CLIENT || 'sqlite';
  constructor() {
    if (this.client === 'postgres') {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required for postgres');
      this.db = new Kysely<Database>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: process.env.DATABASE_URL, types: postgresTypes }),
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
    if (this.client === 'sqlite') return migrateSqlite(this.db, migrationProvider);
    const { rows } = await sql<{ name: string | null }>`select current_schema() as name`.execute(
      this.db,
    );
    const migrationTableSchema = rows[0]?.name;
    if (!migrationTableSchema) throw new Error('PostgreSQL search_path has no available schema');
    const migrator = new Migrator({
      db: this.db,
      migrationTableSchema,
      provider: migrationProvider,
    });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  }
  async onApplicationShutdown() {
    await this.db.destroy();
  }
}
@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
