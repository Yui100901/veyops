import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';

const execute = promisify(execFile);

async function runPostgresTool(tool: 'pg_dump' | 'pg_restore', args: string[], url?: string) {
  const path = process.env[tool === 'pg_dump' ? 'VEYOPS_PG_DUMP' : 'VEYOPS_PG_RESTORE'] || tool;
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.ENCRYPTION_KEY;
  delete env.ADMIN_PASSWORD;
  if (url) {
    const connection = new URL(url);
    const password =
      connection.searchParams.get('password') ?? decodeURIComponent(connection.password);
    if (password) env.PGPASSWORD = password;
    connection.password = '';
    connection.searchParams.delete('password');
    const ssl = connection.searchParams.get('ssl');
    const sslMode = connection.searchParams.get('sslmode');
    const nodeVerifiesCertificate = connection.searchParams.get('uselibpqcompat') !== 'true';
    if (sslMode === 'no-verify') connection.searchParams.set('sslmode', 'require');
    else if (sslMode && sslMode !== 'disable' && nodeVerifiesCertificate)
      connection.searchParams.set('sslmode', 'verify-full');
    else if (!sslMode && ssl)
      connection.searchParams.set('sslmode', ssl === '0' ? 'disable' : 'verify-full');
    if (
      connection.searchParams.get('sslmode') === 'verify-full' &&
      !connection.searchParams.has('sslrootcert')
    )
      connection.searchParams.set('sslrootcert', 'system');
    connection.searchParams.delete('ssl');
    connection.searchParams.delete('uselibpqcompat');
    // libpq URIs require percent-encoded spaces, including inside the search_path option.
    connection.search = [...connection.searchParams]
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&');
    args = ['--no-password', '--dbname', connection.toString(), ...args];
  }
  try {
    return (await execute(path, args, { env, maxBuffer: 8 * 1024 * 1024, windowsHide: true }))
      .stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    if (failure.code === 'ENOENT')
      throw new Error(`${tool} was not found; install the PostgreSQL client tools`);
    if (failure.stderr?.includes('server version mismatch'))
      throw new Error(`${tool} requires a PostgreSQL client compatible with the server version`);
    throw new Error(
      `${tool} failed; check client compatibility, database connectivity and permissions`,
    );
  }
}

async function inspectSchema(url: string) {
  let pool: Pool | undefined;
  try {
    pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, max: 1 });
    const {
      rows: [schema],
    } = await pool.query<{ name: string; migrated: boolean; occupied: boolean }>(`
      SELECT n.nspname AS name,
        EXISTS (SELECT FROM pg_class c WHERE c.relnamespace = n.oid AND c.relname = 'kysely_migration') AS migrated,
        (EXISTS (SELECT FROM pg_class c WHERE c.relnamespace = n.oid)
          OR EXISTS (SELECT FROM pg_proc p WHERE p.pronamespace = n.oid)
          OR EXISTS (SELECT FROM pg_type t WHERE t.typnamespace = n.oid)) AS occupied
      FROM pg_namespace n WHERE n.nspname = current_schema()
    `);
    return schema;
  } catch {
    throw new Error(
      'Cannot inspect PostgreSQL schema; check database connectivity and permissions',
    );
  } finally {
    await pool?.end();
  }
}

export async function backupPostgres(url: string, output: string) {
  const schema = await inspectSchema(url);
  if (!schema?.migrated) throw new Error('PostgreSQL source schema has no VeyOps migrations');
  await runPostgresTool(
    'pg_dump',
    [
      '--format=custom',
      '--strict-names',
      '--no-privileges',
      '--no-tablespaces',
      '--schema',
      `"${schema.name.replaceAll('"', '""')}"`,
      '--file',
      output,
    ],
    url,
  );
  return schema.name;
}

export async function requireEmptyPostgres(url: string, schemaName: string) {
  const schema = await inspectSchema(url);
  if (schema?.name !== schemaName || schema.occupied)
    throw new Error('Restore requires an empty PostgreSQL schema with the original schema name');
}

export async function restorePostgres(
  url: string,
  archive: string,
  stage: string,
  preserveFiles: () => void,
) {
  const contents = await runPostgresTool('pg_restore', ['--list', archive]);
  // The destination schema already exists. Restore only objects inside it.
  const list = join(stage, 'restore.list');
  await writeFile(
    list,
    contents
      .split('\n')
      .filter((entry) => !/^\d+; \d+ \d+ SCHEMA - /.test(entry))
      .join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  try {
    await runPostgresTool(
      'pg_restore',
      [
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        '--no-tablespaces',
        '--use-list',
        list,
        archive,
      ],
      url,
    );
  } catch (error) {
    const schema = await inspectSchema(url).catch(() => null);
    if (!schema || schema.occupied) {
      preserveFiles();
      throw new Error(
        'PostgreSQL restore outcome could not be verified; files retained for inspection',
      );
    }
    throw error;
  }
}
