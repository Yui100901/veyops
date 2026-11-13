import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dataDirectory, workspaceRoot } from '../config';
import { createBackup, restoreBackup, type BackupSettings } from './backup';

async function readMasterKey() {
  const value =
    process.env.ENCRYPTION_KEY ||
    (process.env.NODE_ENV !== 'production'
      ? (
          await readFile(join(dataDirectory, 'config', 'encryption.key'), 'utf8').catch(() => '')
        ).trim()
      : '');
  if (!/^[\da-f]{64}$/i.test(value))
    throw new Error(
      'Set the original 64-character ENCRYPTION_KEY before running backups or restores',
    );
  return Buffer.from(value, 'hex');
}

async function main() {
  const [action, directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || (action !== 'create' && action !== 'restore'))
    throw new Error('Usage: backup-cli.js create|restore <backup-directory>');

  const client = process.env.DATABASE_CLIENT || 'sqlite';
  let database: BackupSettings['database'];
  if (client === 'sqlite') {
    const path = process.env.DATABASE_PATH || 'data/database/app.db';
    if (path === ':memory:')
      throw new Error('An in-memory SQLite database cannot be backed up offline');
    database = { client, path: resolve(workspaceRoot, path) };
  } else if (client === 'postgres' && process.env.DATABASE_URL) {
    database = { client, url: process.env.DATABASE_URL };
  } else {
    throw new Error('Set DATABASE_CLIENT to sqlite or configure postgres with DATABASE_URL');
  }
  const settings = { database, dataDir: dataDirectory, key: await readMasterKey() };
  const manifest = await (action === 'create' ? createBackup : restoreBackup)(settings, directory);
  console.log(
    `Backup ${action === 'create' ? 'created' : 'restored'} (${client}, ${manifest.files.length} files)`,
  );
}

void main().catch((error: unknown) => {
  const problem = error as { message?: string; code?: string };
  // Driver and subprocess errors may include credentials or connection strings.
  console.error(
    problem.code
      ? 'Backup command failed; check paths, permissions and database configuration'
      : problem.message || 'Backup command failed',
  );
  process.exitCode = 1;
});
