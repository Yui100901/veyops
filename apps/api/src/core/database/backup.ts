import { constants, createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { backupPostgres, requireEmptyPostgres, restorePostgres } from './backup-postgres';

const managedDirectories = ['artifacts', 'logs', 'config'] as const;
const localKeyPath = 'config/encryption.key';
const manifestFile = 'manifest.json';
const databaseFiles = { sqlite: 'database.sqlite', postgres: 'database.dump' } as const;

export type BackupSettings = {
  dataDir: string;
  key: Buffer;
  database: { client: 'sqlite'; path: string } | { client: 'postgres'; url: string };
};

type BackupFile = { path: string; sha256: string };
export type BackupManifest = {
  version: 1;
  createdAt: string;
  database: { client: 'sqlite' } | { client: 'postgres'; schema: string };
  files: BackupFile[];
};

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function stat(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (!isMissing(error)) throw error;
    return null;
  });
}

// Resolve the real ancestor of paths that may not exist yet.
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (!isMissing(error) || path === parent) throw error;
    return join(await canonicalPath(parent), relative(parent, path));
  }
}

function contains(parent: string, path: string) {
  const location = relative(parent, path);
  return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location);
}

function copyablePath(path: string) {
  const parts = path.split('/');
  return (
    parts.every((part) => part && part !== '.' && part !== '..' && !/[\\:\0]/.test(part)) &&
    managedDirectories.some((name) => path.startsWith(`${name}/`)) &&
    path.toLowerCase() !== localKeyPath
  );
}

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function listFiles(root: string, path: string): Promise<string[]> {
  const source = join(root, path);
  const info = await stat(source);
  if (!info) return [];
  if (info.isDirectory()) {
    const entries = (await readdir(source)).sort();
    const files: string[] = [];
    for (const entry of entries) {
      const name = `${path}/${entry}`;
      if (
        name.toLowerCase() === localKeyPath ||
        (path === 'artifacts' && entry.endsWith('.partial'))
      )
        continue;
      files.push(...(await listFiles(root, name)));
    }
    return files;
  }
  if (info.isFile() && copyablePath(path)) return [path];
  throw new Error(`Backup path must be a regular file or directory: ${path}`);
}

async function regularFile(root: string, path: string) {
  const parts = path.split('/');
  let source = root;
  for (const [index, part] of parts.entries()) {
    source = join(source, part);
    const info = await stat(source);
    if (!(index === parts.length - 1 ? info?.isFile() : info?.isDirectory()))
      throw new Error(`Backup entry is missing or not a regular file: ${path}`);
  }
  return source;
}

async function copyEntry(source: string, destination: string, path: string) {
  const output = join(destination, path);
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await copyFile(await regularFile(source, path), output, constants.COPYFILE_EXCL);
  await chmod(output, 0o600);
  return digest(output);
}

function signature(manifest: BackupManifest, key: Buffer) {
  return createHmac('sha256', key)
    .update('veyops-backup-v1\0')
    .update(JSON.stringify(manifest))
    .digest();
}

export async function readBackupManifest(root: string, key: Buffer): Promise<BackupManifest> {
  const file = await regularFile(root, manifestFile);
  const { manifest, hmac } = JSON.parse(await readFile(file, 'utf8')) as {
    manifest: BackupManifest;
    hmac: string;
  };
  if (
    !manifest ||
    manifest.version !== 1 ||
    typeof hmac !== 'string' ||
    !/^[0-9a-f]{64}$/.test(hmac) ||
    !timingSafeEqual(Buffer.from(hmac, 'hex'), signature(manifest, key))
  )
    throw new Error('Backup manifest authentication failed; check the original ENCRYPTION_KEY');
  if (
    typeof manifest.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !manifest.database ||
    !['sqlite', 'postgres'].includes(manifest.database.client) ||
    (manifest.database.client === 'postgres' && typeof manifest.database.schema !== 'string') ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Invalid backup manifest');
  const databaseFile = databaseFiles[manifest.database.client];
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      (file.path !== databaseFile && !copyablePath(file.path)) ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      paths.has(file.path)
    )
      throw new Error('Invalid backup manifest entry');
    paths.add(file.path);
  }
  if (!paths.has(databaseFile)) throw new Error('Backup manifest has no database snapshot');
  return manifest;
}

export async function verifyBackup(root: string, key: Buffer) {
  const manifest = await readBackupManifest(root, key);
  for (const { path, sha256 } of manifest.files) {
    if ((await digest(await regularFile(root, path))) !== sha256)
      throw new Error(`Backup checksum failed: ${path}`);
  }
  return manifest;
}

function openSqlite(path: string) {
  const database = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  try {
    if (!database.prepare("SELECT name FROM sqlite_master WHERE name = 'kysely_migration'").get())
      throw new Error('SQLite source has no VeyOps migrations');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function verifySqlite(path: string) {
  const database = openSqlite(path);
  try {
    if (
      database.pragma('quick_check', { simple: true }) !== 'ok' ||
      (database.pragma('foreign_key_check') as unknown[]).length
    )
      throw new Error('SQLite backup failed its integrity check');
  } finally {
    database.close();
  }
}

export async function createBackup(settings: BackupSettings, output: string) {
  const root = await canonicalPath(resolve(settings.dataDir));
  const destination = await canonicalPath(resolve(output));
  if (
    contains(destination, root) ||
    managedDirectories.some((dir) => contains(join(root, dir), destination))
  )
    throw new Error('Backup must be outside the managed logs, artifacts and configuration');
  if (await stat(resolve(output))) throw new Error('Backup directory already exists');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(destination), '.veyops-backup-'));
  try {
    const database = settings.database;
    const databaseFile = databaseFiles[database.client];
    const snapshot = join(stage, databaseFile);
    let savedDatabase: BackupManifest['database'];
    if (database.client === 'sqlite') {
      const sqlite = openSqlite(database.path);
      try {
        await sqlite.backup(snapshot);
      } finally {
        sqlite.close();
      }
      verifySqlite(snapshot);
      savedDatabase = { client: 'sqlite' };
    } else {
      savedDatabase = { client: 'postgres', schema: await backupPostgres(database.url, snapshot) };
    }
    await chmod(snapshot, 0o600);
    const files: BackupFile[] = [{ path: databaseFile, sha256: await digest(snapshot) }];
    for (const directory of managedDirectories) {
      for (const path of await listFiles(root, directory)) {
        files.push({ path, sha256: await copyEntry(root, stage, path) });
      }
    }
    const manifest: BackupManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      database: savedDatabase,
      files,
    };
    const hmac = signature(manifest, settings.key).toString('hex');
    await writeFile(join(stage, manifestFile), JSON.stringify({ manifest, hmac }, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    await mkdir(destination, { mode: 0o700 });
    try {
      // Publish the manifest last, so only a complete directory is restorable.
      for (const name of new Set(files.map(({ path }) => path.split('/')[0])))
        await rename(join(stage, name), join(destination, name));
      await rename(join(stage, manifestFile), join(destination, manifestFile));
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return manifest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function requireEmptyData(root: string) {
  for (const directory of managedDirectories) {
    const path = join(root, directory);
    const info = await stat(path);
    if (info && !info.isDirectory())
      throw new Error(`Restore requires an empty ${directory} directory`);
    const entries = info ? await readdir(path) : [];
    if (entries.some((entry) => `${directory}/${entry}`.toLowerCase() !== localKeyPath))
      throw new Error(`Restore requires an empty ${directory} directory`);
  }
}

export async function restoreBackup(settings: BackupSettings, input: string) {
  const source = await realpath(resolve(input));
  const root = await canonicalPath(resolve(settings.dataDir));
  if (contains(source, root)) throw new Error('Restore data directory must be outside the backup');
  const manifest = await readBackupManifest(source, settings.key);
  const database = settings.database;
  if (database.client !== manifest.database.client)
    throw new Error('Backup database type differs from the destination');
  const sqlitePath = database.client === 'sqlite' ? resolve(database.path) : null;
  if (sqlitePath) {
    if (contains(source, await canonicalPath(sqlitePath)))
      throw new Error('SQLite destination must be outside the backup');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (await stat(sqlitePath + suffix))
        throw new Error('Restore requires an unused SQLite database path');
    }
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stage = join(root, '.veyops-restore');
  try {
    await mkdir(stage, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        'A restore is running or was interrupted; inspect the destination before removing .veyops-restore',
      );
    throw error;
  }
  const files = manifest.files.filter((file) => copyablePath(file.path));
  const installed: string[] = [];
  const directories = new Set<string>();
  let keepFiles = false;
  try {
    await requireEmptyData(root);
    if (database.client === 'postgres' && manifest.database.client === 'postgres')
      await requireEmptyPostgres(database.url, manifest.database.schema);
    for (const { path, sha256 } of manifest.files) {
      if ((await copyEntry(source, stage, path)) !== sha256)
        throw new Error(`Backup checksum failed: ${path}`);
    }
    const snapshot = join(stage, databaseFiles[database.client]);
    if (sqlitePath) verifySqlite(snapshot);
    for (const { path } of files) {
      const output = join(root, path);
      const created = await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      if (created) {
        for (
          let directory = dirname(output);
          contains(created, directory);
          directory = dirname(directory)
        )
          directories.add(directory);
      }
      await link(join(stage, path), output);
      installed.push(output);
    }
    if (sqlitePath) {
      await mkdir(dirname(sqlitePath), { recursive: true, mode: 0o700 });
      const sqliteStage = await mkdtemp(join(dirname(sqlitePath), '.veyops-sqlite-'));
      try {
        const pending = join(sqliteStage, 'app.db');
        await copyFile(snapshot, pending, constants.COPYFILE_EXCL);
        await link(pending, sqlitePath);
        keepFiles = true;
      } finally {
        await rm(sqliteStage, { recursive: true, force: true });
      }
    } else if (database.client === 'postgres' && manifest.database.client === 'postgres') {
      await restorePostgres(database.url, snapshot, stage, () => {
        keepFiles = true;
      });
    }
    keepFiles = true;
    return manifest;
  } finally {
    if (!keepFiles) {
      for (const file of installed) await rm(file);
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
        // rmdir refuses to remove files created by another process in the meantime.
        await rmdir(directory);
      }
    }
    await rm(stage, { recursive: true, force: true });
  }
}
