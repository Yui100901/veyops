import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { DatabaseService } from '../../core/database/database.service';

export const postgresTestUrl = process.env.VEYOPS_TEST_POSTGRES_URL;

async function isolate(testUrl: string) {
  const schema = `veyops_test_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(testUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const admin = new Pool({ connectionString: testUrl, connectionTimeoutMillis: 5000, max: 1 });
  try {
    await admin.query(`create schema "${schema}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  return {
    connectionString: url.toString(),
    schema,
    async cleanup() {
      try {
        await admin.query(`drop schema "${schema}" cascade`);
      } finally {
        await admin.end();
      }
    },
  };
}

export async function withIsolatedPostgres(
  testUrl: string,
  work: (connectionString: string, schema: string) => Promise<void>,
): Promise<void> {
  const isolated = await isolate(testUrl);
  try {
    await work(isolated.connectionString, isolated.schema);
  } finally {
    await isolated.cleanup();
  }
}

export async function createPostgresTestDatabase(t: TestContext) {
  if (!postgresTestUrl) throw new Error('VEYOPS_TEST_POSTGRES_URL is required');
  const isolated = await isolate(postgresTestUrl);
  let database: DatabaseService;
  try {
    database = createPostgresService(isolated.connectionString);
  } catch (error) {
    await isolated.cleanup();
    throw error;
  }
  t.after(async () => {
    try {
      await database.onApplicationShutdown();
    } finally {
      await isolated.cleanup();
    }
  });
  await database.onModuleInit();
  return database;
}

export function createPostgresService(connectionString: string): DatabaseService {
  const previousClient = process.env.DATABASE_CLIENT;
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_CLIENT = 'postgres';
  process.env.DATABASE_URL = connectionString;
  try {
    return new DatabaseService();
  } finally {
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT;
    else process.env.DATABASE_CLIENT = previousClient;
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
}
