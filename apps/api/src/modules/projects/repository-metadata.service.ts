import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseService } from '../../core/database/database.service';
import { Roles } from '../auth/auth.decorators';
import { gitCredentialHelper } from '../builds/builds.service';
import { CredentialsService } from '../credentials/credentials.service';

const exec = promisify(execFile);
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const branchPrefix = 'refs/heads/';
const deploymentDocMaxBytes = 12 * 1024;
const gitEnvironmentKeys = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TMP',
  'TEMP',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const gitCredentialTypes = new Set(['GIT_TOKEN', 'GIT_PASSWORD', 'USERNAME_PASSWORD']);

export function isGitCredentialType(type: string): boolean {
  return gitCredentialTypes.has(type);
}

export function isDeploymentDocPath(path: string): boolean {
  return (
    path.length <= 300 && /^(?:[a-z0-9_-][a-z0-9_.-]*\/)*(?:deploy|deployment)\.md$/i.test(path)
  );
}

class RepositoryCommitsQuery {
  @IsOptional() @IsString() @MaxLength(255) branch?: string;
  @IsOptional() @IsString() @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/) limit?: string;
}

function isBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    name !== '@' &&
    !name.endsWith('.') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !/[ ~^:?*[\]\\]/.test(name) &&
    [...name].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
    name.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))
  );
}

export function httpCloneUrl(value: string): string {
  if (
    !/^https?:\/\//i.test(value) ||
    /\s|\\/.test(value) ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new BadRequestException('仓库查询需要有效的 HTTP(S) 克隆地址');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('仓库查询需要有效的 HTTP(S) 克隆地址');
  }
  if (url.username || url.password || value.includes('?') || value.includes('#'))
    throw new BadRequestException('仓库地址不能包含凭据、查询或片段');
  return url.href;
}

interface GitRepository {
  url: string;
  run(args: string[]): Promise<string>;
  runBytes(args: string[], maxBuffer?: number): Promise<Buffer>;
  redact(value: string): string;
  workspace: string;
}

@Injectable()
export class RepositoryMetadataService {
  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: CredentialsService,
  ) {}

  async connection(projectId: string, repositoryId: string) {
    const { defaultBranch } = await this.branches(projectId, repositoryId);
    return { ok: true as const, defaultBranch };
  }

  branches(projectId: string, repositoryId: string) {
    return this.withRepository(projectId, repositoryId, (repository) =>
      this.listBranches(repository),
    );
  }

  async commits(projectId: string, repositoryId: string, query: RepositoryCommitsQuery) {
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new BadRequestException('提交查询数量必须在 1 到 50 之间');
    if (query.branch !== undefined && !isBranchName(query.branch))
      throw new BadRequestException('Git 分支名称无效');
    return this.withRepository(projectId, repositoryId, async (repository) => {
      const branch = query.branch ?? (await this.listBranches(repository)).defaultBranch;
      if (!branch) throw new BadRequestException('仓库没有默认分支，请指定要查询的分支');

      const bare = join(repository.workspace, 'repository.git');
      await repository.run([
        'clone',
        '--bare',
        '--single-branch',
        '--no-tags',
        '--template=',
        `--depth=${limit}`,
        '--filter=tree:0',
        `--branch=${branch}`,
        '--',
        repository.url,
        bare,
      ]);
      const output = await repository.run([
        `--git-dir=${bare}`,
        'log',
        '-z',
        `--max-count=${limit}`,
        '--format=%H%x00%s%x00%aI%x00%an',
        branchPrefix + branch,
        '--',
      ]);
      const fields = output.split('\0');
      const commits = [];
      for (let index = 0; index + 3 < fields.length; index += 4) {
        const [sha, subject, authoredAt, authorName] = fields.slice(index, index + 4);
        const timestamp = Date.parse(authoredAt);
        if (shaPattern.test(sha) && Number.isFinite(timestamp)) {
          commits.push({
            sha,
            subject: repository.redact(subject).slice(0, 500),
            authoredAt: new Date(timestamp).toISOString(),
            authorName: repository.redact(authorName).slice(0, 200),
          });
        }
      }
      return { branch, commits };
    });
  }

  async readDeploymentDoc(
    projectId: string,
    repositoryId: string,
    commitSha: string,
    path: string,
  ): Promise<{ path: string; commitSha: string; content: string }> {
    const sha = commitSha.toLowerCase();
    if (!shaPattern.test(sha)) throw new BadRequestException('部署文档查询需要完整 Git Commit SHA');
    if (!isDeploymentDocPath(path))
      throw new BadRequestException('请指定仓库内的 DEPLOY.md 或 deployment.md 相对路径');

    return this.withRepository(projectId, repositoryId, async (repository) => {
      const bare = join(repository.workspace, 'repository.git');
      const gitDir = `--git-dir=${bare}`;
      await repository.run([
        'init',
        '--bare',
        '--template=',
        `--object-format=${sha.length === 40 ? 'sha1' : 'sha256'}`,
        bare,
      ]);
      await repository.run([
        gitDir,
        'fetch',
        '--depth=1',
        `--filter=blob:limit=${deploymentDocMaxBytes + 1}`,
        '--no-tags',
        '--no-recurse-submodules',
        '--',
        repository.url,
        sha,
      ]);
      const fetched = await repository.run([
        gitDir,
        'rev-parse',
        '--verify',
        'FETCH_HEAD^{commit}',
      ]);
      if (fetched.trim() !== sha) throw new BadGatewayException('未取得指定 Git Commit');
      const entry = await repository.run([
        gitDir,
        '--literal-pathspecs',
        'ls-tree',
        '-z',
        sha,
        '--',
        path,
      ]);
      if (!entry) throw new NotFoundException('指定提交中不存在该部署文档');
      const [descriptor, filePath] = entry.split('\t');
      const [mode, type, object] = descriptor.split(' ');
      if (
        filePath !== `${path}\0` ||
        type !== 'blob' ||
        (mode !== '100644' && mode !== '100755') ||
        !shaPattern.test(object)
      )
        throw new BadRequestException('部署文档必须是仓库中的普通文件');
      const size = Number((await repository.run([gitDir, 'cat-file', '-s', object])).trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > deploymentDocMaxBytes)
        throw new BadRequestException('部署文档大小超过 12 KiB');
      const bytes = await repository.runBytes(
        [gitDir, 'cat-file', 'blob', object],
        deploymentDocMaxBytes,
      );
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new BadRequestException('部署文档必须是 UTF-8 文本');
      }
      if (
        [...content].some((char) => {
          const code = char.charCodeAt(0);
          return (
            (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)
          );
        })
      )
        throw new BadRequestException('部署文档必须是 UTF-8 文本');
      content = repository.redact(content);
      if (Buffer.byteLength(content, 'utf8') > deploymentDocMaxBytes)
        throw new BadRequestException('部署文档大小超过 12 KiB');
      return { path, commitSha: sha, content };
    });
  }

  private async listBranches(repository: GitRepository) {
    const result = await repository.run([
      'ls-remote',
      '--symref',
      '--sort=refname',
      '--',
      repository.url,
      'HEAD',
      `${branchPrefix}*`,
    ]);
    let head: string | undefined;
    const branches: { name: string; sha: string }[] = [];
    for (const line of result.split(/\r?\n/)) {
      const [value, ref] = line.split('\t');
      if (ref === 'HEAD' && value.startsWith(`ref: ${branchPrefix}`))
        head = value.slice('ref: '.length + branchPrefix.length);
      if (ref?.startsWith(branchPrefix) && shaPattern.test(value)) {
        const name = ref.slice(branchPrefix.length);
        if (isBranchName(name) && repository.redact(name) === name)
          branches.push({ name, sha: value });
      }
    }
    return {
      defaultBranch: branches.find((branch) => branch.name === head)?.name ?? null,
      branches,
    };
  }

  private async withRepository<T>(
    projectId: string,
    repositoryId: string,
    callback: (repository: GitRepository) => Promise<T>,
  ): Promise<T> {
    const repository = await this.database.db
      .selectFrom('repositories')
      .innerJoin('projects', 'projects.id', 'repositories.project_id')
      .select(['repositories.clone_url', 'repositories.credential_id'])
      .where('repositories.id', '=', repositoryId)
      .where('repositories.project_id', '=', projectId)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!repository) throw new NotFoundException('仓库不存在');
    const url = httpCloneUrl(repository.clone_url);
    const workspace = await mkdtemp(join(tmpdir(), 'veyops-git-'));
    try {
      const options = [
        '-c',
        `core.hooksPath=${join(workspace, 'hooks')}`,
        '-c',
        'protocol.allow=never',
        '-c',
        'protocol.http.allow=always',
        '-c',
        'protocol.https.allow=always',
        '-c',
        'http.followRedirects=false',
        '-c',
        'http.lowSpeedLimit=1',
        '-c',
        'http.lowSpeedTime=15',
        '-c',
        'credential.helper=',
      ];
      let secret: string | undefined;
      if (repository.credential_id) {
        const credential = await this.database.db
          .selectFrom('credentials')
          .select(['type', 'nonce'])
          .where('id', '=', repository.credential_id)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (!credential || !isGitCredentialType(credential.type))
          throw new BadRequestException('仓库凭据无效，请配置 Git Token 或用户名密码凭据');
        const value = await this.credentials.decrypt(repository.credential_id, credential.nonce);
        const username = value.username || 'oauth2';
        const password = value.token || value.password;
        if (!password || /[\r\n]/.test(username + password) || (username + password).includes('\0'))
          throw new BadRequestException('Git 凭据必须包含有效的单行 Token 或用户名密码');
        const responsePath = join(workspace, 'credential');
        await writeFile(responsePath, `username=${username}\npassword=${password}\n`, {
          mode: 0o600,
          flag: 'wx',
        });
        options.push(
          '-c',
          `credential.helper=${gitCredentialHelper(responsePath.replaceAll('\\', '/'))}`,
        );
        secret = password;
      }
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => gitEnvironmentKeys.has(name.toUpperCase())),
      );
      Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(workspace, 'global-config'),
        GIT_TERMINAL_PROMPT: '0',
        GIT_CEILING_DIRECTORIES: dirname(workspace),
        GIT_NO_LAZY_FETCH: '1',
      });
      const signal = AbortSignal.timeout(25_000);
      const runBytes = async (args: string[], maxBuffer = 1024 * 1024) => {
        try {
          const { stdout } = await exec('git', [...options, ...args], {
            cwd: workspace,
            env,
            signal,
            shell: false,
            windowsHide: true,
            encoding: 'buffer',
            maxBuffer,
          });
          return stdout;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            throw new ServiceUnavailableException('管理端未安装 Git');
          if (signal.aborted) throw new BadGatewayException('Git 仓库查询超时');
          throw new BadGatewayException(
            'Git 仓库查询失败，请检查仓库地址、访问凭据和提交是否可获取',
          );
        }
      };
      return await callback({
        url,
        workspace,
        redact: (value) => (secret ? value.replaceAll(secret, '[REDACTED]') : value),
        run: async (args) => (await runBytes(args)).toString('utf8'),
        runBytes,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}

@Roles('ADMIN', 'OPERATOR')
@Controller('projects/:projectId/repositories/:repositoryId')
export class RepositoryMetadataController {
  constructor(private readonly metadata: RepositoryMetadataService) {}

  @Get('connection')
  connection(@Param('projectId') projectId: string, @Param('repositoryId') repositoryId: string) {
    return this.metadata.connection(projectId, repositoryId);
  }

  @Get('branches')
  branches(@Param('projectId') projectId: string, @Param('repositoryId') repositoryId: string) {
    return this.metadata.branches(projectId, repositoryId);
  }

  @Get('commits')
  commits(
    @Param('projectId') projectId: string,
    @Param('repositoryId') repositoryId: string,
    @Query() query: RepositoryCommitsQuery,
  ) {
    return this.metadata.commits(projectId, repositoryId, query);
  }
}
