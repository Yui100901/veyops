import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { dataDirectory, encryptionKey, workspaceRoot } from '../../core/config';
import {
  createBackup,
  readBackupManifest,
  verifyBackup,
  type BackupManifest,
  type BackupSettings,
} from '../../core/database/backup';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';

const backupId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

function info(id: string, manifest: BackupManifest) {
  return {
    id,
    createdAt: manifest.createdAt,
    databaseClient: manifest.database.client,
    fileCount: manifest.files.length,
  };
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function stat(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (!missing(error)) throw error;
    return null;
  });
}

function archive(source: string, target: string, files: string[]) {
  return new Promise<void>((complete, fail) => {
    const { PATH, SystemRoot, WINDIR, LANG, LC_ALL } = process.env;
    const child = spawn(
      'tar',
      ['-czf', target, '-C', source, '--no-recursion', '--null', '-T', '-'],
      {
        env: { PATH, SystemRoot, WINDIR, LANG, LC_ALL },
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      },
    );
    child.once('error', (error: NodeJS.ErrnoException) => {
      fail(
        new ServiceUnavailableException(
          missing(error) ? '缺少 tar 命令，安装后可下载备份归档' : '无法启动备份打包工具',
        ),
      );
    });
    child.stdin.on('error', () => child.kill());
    child.once('close', (code) => {
      if (code === 0) complete();
      else fail(new ServiceUnavailableException('无法打包备份，请检查磁盘空间和文件权限'));
    });
    child.stdin.end(files.join('\0') + '\0');
  });
}

@Injectable()
export class BackupService {
  private readonly key = encryptionKey();
  private creating = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private settings(): BackupSettings {
    const { client } = this.database;
    if (client === 'postgres' && process.env.DATABASE_URL)
      return {
        database: { client, url: process.env.DATABASE_URL },
        dataDir: dataDirectory,
        key: this.key,
      };
    const sqlitePath = process.env.DATABASE_PATH || 'data/database/app.db';
    if (client === 'sqlite' && sqlitePath !== ':memory:')
      return {
        database: { client, path: resolve(workspaceRoot, sqlitePath) },
        dataDir: dataDirectory,
        key: this.key,
      };
    throw new ServiceUnavailableException('当前数据库配置无法创建持久化备份');
  }

  private async root(create = false) {
    if (create) await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const dataRoot = await realpath(dataDirectory).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return null;
    });
    if (!dataRoot) return null;
    const root = join(dataRoot, 'backups');
    const web = await realpath(resolve(workspaceRoot, 'apps/web/dist')).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return null;
    });
    if (web) {
      const location = relative(web, root);
      if (location !== '..' && !location.startsWith('..' + sep) && !isAbsolute(location))
        throw new ServiceUnavailableException('备份目录必须位于静态资源目录之外');
    }
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await stat(root);
    if (!directory) return null;
    if (!directory.isDirectory() || (await realpath(root)) !== root)
      throw new ServiceUnavailableException('备份目录必须是本地独立目录');
    return root;
  }

  private async directory(id: string) {
    if (!backupId.test(id)) throw new NotFoundException('找不到备份');
    const root = await this.root();
    if (!root) throw new NotFoundException('找不到备份');
    const path = join(root, id);
    if (!(await stat(path))?.isDirectory() || (await realpath(path)) !== path)
      throw new NotFoundException('找不到备份');
    return { root, path };
  }

  async list() {
    const root = await this.root();
    if (!root) return [];
    const backups: ReturnType<typeof info>[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !backupId.test(entry.name)) continue;
      const path = join(root, entry.name);
      if ((await realpath(path).catch(() => null)) !== path) continue;
      const manifest = await readBackupManifest(path, this.key).catch(() => null);
      if (manifest) backups.push(info(entry.name, manifest));
    }
    return backups.sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id),
    );
  }

  async create(actor: string) {
    if (this.creating) throw new ConflictException('正在创建备份，请稍后重试');
    this.creating = true;
    try {
      const settings = this.settings();
      const root = await this.root(true);
      if (!root) throw new ServiceUnavailableException('备份目录不可用');
      const id = randomUUID();
      const path = join(root, id);
      let manifest: BackupManifest;
      try {
        manifest = await createBackup(settings, path);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('pg_dump was not found'))
          throw new ServiceUnavailableException('缺少 pg_dump，请安装兼容的 PostgreSQL 客户端');
        throw new ServiceUnavailableException('创建备份失败，请检查数据库连接、磁盘空间和文件权限');
      }
      try {
        await this.audit.record(actor, 'backup.create', 'backup', id, {
          databaseClient: manifest.database.client,
          fileCount: manifest.files.length,
        });
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      return info(id, manifest);
    } finally {
      this.creating = false;
    }
  }

  private async verifyDirectory(path: string) {
    try {
      return await verifyBackup(path, this.key);
    } catch {
      throw new ConflictException('备份校验失败，请检查文件完整性和实例主密钥');
    }
  }

  async verify(id: string, actor: string) {
    const { path } = await this.directory(id);
    const manifest = await this.verifyDirectory(path);
    await this.audit.record(actor, 'backup.verify', 'backup', id);
    return info(id, manifest);
  }

  async download(id: string, actor: string) {
    const { root, path } = await this.directory(id);
    const manifest = await this.verifyDirectory(path);
    const temporary = await mkdtemp(join(root, '.veyops-download-'));
    const clean = () => rm(temporary, { force: true, recursive: true });
    try {
      const output = join(temporary, 'backup.tar.gz');
      await archive(path, output, ['manifest.json', ...manifest.files.map(({ path }) => path)]);
      await chmod(output, 0o600);
      await this.audit.record(actor, 'backup.download', 'backup', id);
      const file = await open(output, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const size = (await file.stat()).size;
        const stream = file.createReadStream();
        stream.once('close', () => void clean().catch(() => undefined));
        return new StreamableFile(stream, {
          type: 'application/gzip',
          disposition: `attachment; filename="veyops-backup-${id}.tar.gz"`,
          length: size,
        }).setErrorLogger(() => undefined);
      } catch (error) {
        await file.close();
        throw error;
      }
    } catch (error) {
      await clean();
      throw error;
    }
  }
}
