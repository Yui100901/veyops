import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpException,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { RepositoriesTable } from '../../core/database/schema';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv, promisify } from 'node:util';
import { DatabaseService } from '../../core/database/database.service';
import { Roles } from '../auth/auth.decorators';
import { gitCredentialHelper } from './git-credential';
import {
  environmentFilePath,
  graphEnvironmentMaxBytes,
  repositoryEnvironmentValues,
  type GraphEnvironmentFilePin,
} from '../execution-graphs/graph-environment';
import { CredentialsService } from '../credentials/credentials.service';
import { redactTaskLog } from '../tasks/task-log.service';
import { isGitBranchName as isBranchName } from './git-ref';

const exec = promisify(execFile);
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const branchPrefix = 'refs/heads/';
const deploymentDocMaxBytes = 12 * 1024;
const analysisFileMaxBytes = 6 * 1024;
const analysisTotalMaxBytes = 24 * 1024;
const analysisTreeMaxBytes = 2 * 1024 * 1024;
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
type RepositoryAccess = { clone_url: string; credential_id: string | null };
export interface GraphCheckoutSnapshot {
  repositoryId: string;
  repositoryName?: string;
  ref?: string;
  branch?: string;
  tag?: string;
  commitSha: string;
  fullClone: boolean;
  access: RepositoryAccess;
}
type BranchCacheRow = Pick<
  Selectable<RepositoriesTable>,
  'branch_cache_json' | 'branch_error' | 'branch_checked_at'
>;
type BranchSnapshot = {
  defaultBranch: string | null;
  branches: { name: string; sha: string }[];
  syncedAt: number;
};

export function branchCache(row: BranchCacheRow) {
  const snapshot: BranchSnapshot | null = row.branch_cache_json
    ? JSON.parse(row.branch_cache_json)
    : null;
  const status = row.branch_error
    ? 'ERROR'
    : !snapshot
      ? 'PENDING'
      : Date.now() - snapshot.syncedAt > 15 * 60_000
        ? 'STALE'
        : 'CURRENT';
  return {
    defaultBranch: snapshot?.defaultBranch ?? null,
    branches: snapshot?.branches ?? [],
    syncedAt: snapshot?.syncedAt ?? null,
    checkedAt: row.branch_checked_at,
    error: row.branch_error,
    status,
  };
}

export function isGitCredentialType(type: string): boolean {
  return gitCredentialTypes.has(type);
}

export function isDeploymentDocPath(path: string): boolean {
  return (
    path.length <= 300 && /^(?:[a-z0-9_-][a-z0-9_.-]*\/)*(?:deploy|deployment)\.md$/i.test(path)
  );
}

function isAnalysisPath(path: string): boolean {
  return (
    path.length <= 300 &&
    /^(?:[a-z0-9_][a-z0-9_.-]*\/)*[a-z0-9_][a-z0-9_.-]*$/i.test(path) &&
    !path
      .split('/')
      .some(
        (segment) =>
          /^(?:node_modules|vendor|dist|build|target|fixtures?|tests?)$/i.test(segment) ||
          /(?:^|[._-])(?:secrets?|credentials?|privatekeys?|keys?|certs?)(?:$|[._-])/i.test(
            segment,
          ),
      )
  );
}

type AnalysisFileKind = 'deployment' | 'description' | 'configuration' | 'source' | 'lockfile';

function analysisFileKind(path: string): AnalysisFileKind | undefined {
  if (!isAnalysisPath(path)) return;
  const name = path.split('/').at(-1)!.toLowerCase();
  if (isDeploymentDocPath(path)) return 'deployment';
  if (/^readme(?:\.(?:md|rst|txt|adoc))?$/.test(name)) return 'description';
  if (
    /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|go\.sum|poetry\.lock|uv\.lock|pipfile\.lock|composer\.lock)$/.test(
      name,
    )
  )
    return 'lockfile';
  if (
    /^(?:(?:dockerfile|containerfile)(?:\.[a-z0-9_-]+)?|(?:docker-compose|compose)(?:\.[a-z0-9_-]+)?\.ya?ml|package\.json|pnpm-workspace\.yaml|go\.mod|cargo\.toml|pyproject\.toml|requirements(?:-[a-z]+)?\.txt|pipfile|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|gemfile|composer\.json|makefile|procfile|tsconfig\.json|[a-z0-9_.-]+\.csproj)$/.test(
      name,
    )
  )
    return 'configuration';
  if (
    /^(?:main|index|app|server|application|__main__|asgi|wsgi|manage|program)\.(?:ts|tsx|js|mjs|cjs|py|go|rs|php|rb|cs)$/.test(
      name,
    ) ||
    /^[a-z0-9_]*(?:main|application|server)\.(?:java|kt)$/.test(name)
  )
    return 'source';
}

interface AnalysisTreeEntry {
  path: string;
  object: string;
}

function parseAnalysisTree(value: string): AnalysisTreeEntry[] {
  return value.split('\0').flatMap((entry) => {
    const match = /^100(?:644|755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\t\r\n]+)$/.exec(entry);
    return match ? [{ object: match[1], path: match[2] }] : [];
  });
}

class RepositoryCommitsQuery {
  @IsOptional() @IsString() @MaxLength(255) branch?: string;
  @IsOptional() @IsString() @Matches(/^(?:[1-9]|[1-4][0-9]|50)$/) limit?: string;
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

  private repositoryRow(projectId: string, repositoryId: string) {
    return this.database.db
      .selectFrom('repositories')
      .innerJoin('projects', 'projects.id', 'repositories.project_id')
      .selectAll('repositories')
      .where('repositories.id', '=', repositoryId)
      .where('repositories.project_id', '=', projectId)
      .where('repositories.archived_at', 'is', null)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
  }

  async cachedBranches(projectId: string, repositoryId: string) {
    const row = await this.repositoryRow(projectId, repositoryId);
    if (!row) throw new NotFoundException('仓库不存在');
    return branchCache(row);
  }

  async refreshBranches(projectId: string, repositoryId: string, timeoutMs = 25_000) {
    const row = await this.repositoryRow(projectId, repositoryId);
    if (!row) throw new NotFoundException('仓库不存在');
    const requestId = randomUUID();
    const update = this.database.db
      .updateTable('repositories')
      .where('project_id', '=', projectId)
      .where('id', '=', repositoryId);
    const claimed = await update
      .set({ branch_request_id: requestId })
      .where('updated_at', '=', row.updated_at)
      .executeTakeFirst();
    if (!claimed.numUpdatedRows) throw new ConflictException('仓库配置已变化，请刷新');
    const finish = update.where('branch_request_id', '=', requestId);
    let snapshot;
    try {
      snapshot = await this.withRepository(
        projectId,
        repositoryId,
        (repository) => this.listBranches(repository),
        row,
        timeoutMs,
      );
    } catch (error) {
      const reason =
        error instanceof HttpException ? error.message : '分支同步失败，请检查仓库配置并重试';
      await finish.set({ branch_checked_at: Date.now(), branch_error: reason }).execute();
      return this.cachedBranches(projectId, repositoryId);
    }
    const syncedAt = Date.now();
    await finish
      .set({
        default_branch: snapshot.defaultBranch ?? '',
        branch_cache_json: JSON.stringify({ ...snapshot, syncedAt }),
        branch_checked_at: syncedAt,
        branch_error: null,
      })
      .execute();
    return this.cachedBranches(projectId, repositoryId);
  }

  branchHeads(
    projectId: string,
    repositoryId: string,
    names: string[],
    expected: RepositoryAccess,
  ) {
    return this.withRepository(
      projectId,
      repositoryId,
      async (repository) => {
        const refs = new Map(names.map((name) => [`${branchPrefix}${name}`, name]));
        const lines = (
          await repository.run([
            'ls-remote',
            '--refs',
            '--heads',
            '--',
            repository.url,
            ...refs.keys(),
          ])
        )
          .trim()
          .split(/\r?\n/);
        const heads = new Map<string, string>();
        for (const line of lines) {
          const [sha, ref] = line.split('\t');
          const name = refs.get(ref);
          if (name && shaPattern.test(sha)) heads.set(name, sha);
        }
        return heads;
      },
      expected,
    );
  }

  async planGraphCheckout(
    projectId: string,
    input: {
      repositoryId: string;
      mode: 'BRANCH' | 'TAG' | 'COMMIT';
      branch?: string;
      tag?: string;
      commitSha?: string;
      fullClone?: boolean;
    },
  ): Promise<GraphCheckoutSnapshot> {
    const row = await this.repositoryRow(projectId, input.repositoryId);
    if (!row) throw new NotFoundException('仓库不存在');
    const access = { clone_url: row.clone_url, credential_id: row.credential_id };
    let branch: string | undefined;
    let tag: string | undefined;
    let commitSha = input.commitSha?.toLowerCase();
    if (input.mode === 'BRANCH') {
      const remote = await this.withRepository(
        projectId,
        input.repositoryId,
        (git) => this.listBranches(git),
        access,
      );
      branch = input.branch ?? remote.defaultBranch ?? undefined;
      commitSha = remote.branches.find((item) => item.name === branch)?.sha;
    }
    if (input.mode === 'TAG') {
      tag = input.tag;
      if (!tag || !isBranchName(tag)) throw new BadRequestException('请选择有效的 Git 标签');
      const ref = 'refs/tags/' + tag;
      commitSha = await this.withRepository(
        projectId,
        input.repositoryId,
        async (git) => {
          if (git.redact(tag!) !== tag) throw new BadRequestException('请选择有效的 Git 标签');
          const data = await git.run(['ls-remote', '--', git.url, ref, ref + '^{}']);
          const refs = new Map(
            data
              .split(/\r?\n/)
              .map((line) => line.split('\t') as [string, string])
              .map(([sha, name]) => [name, sha]),
          );
          const sha = refs.get(ref + '^{}') ?? refs.get(ref);
          if (!sha || !shaPattern.test(sha)) throw new BadRequestException('所选 Git 标签不存在');
          return sha;
        },
        access,
      );
    }
    if (!commitSha || !shaPattern.test(commitSha))
      throw new BadRequestException('请选择存在的仓库分支、标签或完整 Git 提交 SHA');
    if (input.mode === 'COMMIT')
      await this.withRepository(
        projectId,
        input.repositoryId,
        (git) => this.fetchPinnedCommit(git, commitSha!),
        access,
      );
    return {
      repositoryId: input.repositoryId,
      repositoryName: row.name,
      ref: branch ? 'refs/heads/' + branch : tag ? 'refs/tags/' + tag : commitSha,
      branch,
      tag,
      commitSha,
      fullClone: input.fullClone === true,
      access,
    };
  }

  checkoutGraphSource(
    projectId: string,
    snapshot: GraphCheckoutSnapshot,
    signal?: AbortSignal,
    destination?: string,
  ) {
    return this.withRepository(
      projectId,
      snapshot.repositoryId,
      async (git) => {
        const worktree = join(git.workspace, 'src');
        await git.run([
          'init',
          '--template=',
          ...(snapshot.commitSha.length === 64 ? ['--object-format=sha256'] : []),
          '--',
          worktree,
        ]);
        const repo = ['-C', worktree];
        await git.run([
          ...repo,
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          ...(snapshot.fullClone ? [] : ['--depth=1']),
          '--',
          git.url,
          snapshot.commitSha,
        ]);
        await git.run([...repo, 'checkout', '--detach', 'FETCH_HEAD']);
        const actual = (await git.run([...repo, 'rev-parse', 'HEAD'])).trim();
        if (actual !== snapshot.commitSha) throw new ConflictException('实际检出提交与预览不一致');
        const subject = redactTaskLog(
          git.redact((await git.run([...repo, 'show', '-s', '--format=%s', 'HEAD', '--'])).trim()),
        ).slice(0, 500);
        if (destination)
          await cp(worktree, destination, {
            recursive: true,
            verbatimSymlinks: true,
            force: false,
            errorOnExist: true,
          });
        return {
          commitSha: actual,
          subject,
          shallow:
            (await git.run([...repo, 'rev-parse', '--is-shallow-repository'])).trim() === 'true',
        };
      },
      snapshot.access,
      180_000,
      signal,
    );
  }

  environmentFiles(projectId: string, repositoryId: string, commitSha?: string) {
    const sha = typeof commitSha === 'string' ? commitSha.toLowerCase() : undefined;
    if (!sha || !shaPattern.test(sha)) throw new BadRequestException('请选择完整 Git Commit SHA');
    return this.withRepository(projectId, repositoryId, async (repository) => {
      const gitDir = await this.fetchPinnedCommit(repository, sha);
      const tree = await repository.runBytes(
        [gitDir, 'ls-tree', '-r', '-z', sha],
        analysisTreeMaxBytes,
      );
      const candidates = parseAnalysisTree(tree.toString('utf8'))
        .filter(
          ({ path }) =>
            path.length <= 300 &&
            /^(?:[A-Za-z0-9_.-]+\/)*\.env(?:\.[A-Za-z0-9_-]+)*$/.test(path) &&
            repository.redact(path) === path,
        )
        .slice(0, 20);
      const files: { path: string; keys: string[] }[] = [];
      for (const { path, object } of candidates) {
        try {
          const content = await this.readAnalysisBlob(
            repository,
            gitDir,
            object,
            deploymentDocMaxBytes,
          );
          const keys = Object.keys(parseEnv(content))
            .filter(
              (key) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && repository.redact(key) === key,
            )
            .slice(0, 100);
          files.push({ path, keys });
        } catch (error) {
          if (!(error instanceof BadRequestException)) throw error;
        }
      }
      return { files };
    });
  }

  inspectGraphEnvironmentFile(
    projectId: string,
    source: Pick<GraphEnvironmentFilePin, 'repositoryId' | 'commitSha'>,
    paths: readonly string[],
  ) {
    return this.findGraphEnvironmentFile(projectId, source, paths).then((entry) =>
      entry ? { path: entry.path, keys: Object.keys(entry.values) } : undefined,
    );
  }

  async readGraphEnvironmentFile(projectId: string, pin: GraphEnvironmentFilePin) {
    const entry = await this.findGraphEnvironmentFile(projectId, pin, [pin.path]);
    if (!entry) throw new ConflictException('已确认的仓库环境文件无法取得，请重新预览');
    return entry.values;
  }

  private findGraphEnvironmentFile(
    projectId: string,
    source: Pick<GraphEnvironmentFilePin, 'repositoryId' | 'commitSha'>,
    paths: readonly string[],
  ) {
    const { repositoryId, commitSha } = source;
    if (!shaPattern.test(commitSha)) throw new BadRequestException('环境文件需要固定 Git 提交');
    const candidates = [...new Set(paths.map(environmentFilePath))];
    return this.withRepository(projectId, repositoryId, async (repository) => {
      const gitDir = await this.fetchPinnedCommit(repository, commitSha, graphEnvironmentMaxBytes);
      const readTree = async (tree: string, names: string[]) => {
        const records = await repository.runBytes(
          [gitDir, '--literal-pathspecs', 'ls-tree', '-t', '-z', tree, '--', ...names],
          analysisTreeMaxBytes,
        );
        return new Map(
          records
            .toString('utf8')
            .split('\0')
            .filter(Boolean)
            .map((line) => {
              const tab = line.indexOf('\t');
              const [mode, type, object] = line.slice(0, tab).split(' ');
              return [line.slice(tab + 1), { mode, type, object }] as const;
            }),
        );
      };
      const entries = await readTree(commitSha, candidates);
      for (const path of candidates) {
        const entry = entries.get(path);
        if (!entry) {
          // ls-tree with a descendant pathspec omits a parent whose object is a blob or submodule.
          // Check that parent at its own tree level so a symlink is rejected even for optional files.
          const segments = path.split('/');
          let parent = commitSha;
          for (const [index, segment] of segments.slice(0, -1).entries()) {
            const directory = segments.slice(0, index + 1).join('/');
            const next = entries.get(directory) ?? (await readTree(parent, [segment])).get(segment);
            if (!next) break;
            if (next.type !== 'tree' || !next.object || !shaPattern.test(next.object))
              throw new BadRequestException('环境文件不能通过符号链接或非仓库目录访问');
            parent = next.object;
          }
          continue;
        }
        if (
          (entry.mode !== '100644' && entry.mode !== '100755') ||
          entry.type !== 'blob' ||
          !entry.object ||
          !shaPattern.test(entry.object)
        )
          throw new BadRequestException('环境文件必须是指定提交中的普通文件');
        const size = Number(
          (await repository.run([gitDir, 'cat-file', '-s', entry.object])).trim(),
        );
        if (!Number.isSafeInteger(size) || size < 0 || size > graphEnvironmentMaxBytes)
          throw new BadRequestException('环境文件超过 64 KiB 大小限制');
        const bytes = await repository.runBytes(
          [gitDir, 'cat-file', 'blob', entry.object],
          graphEnvironmentMaxBytes,
        );
        return { path, values: repositoryEnvironmentValues(bytes) };
      }
    });
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
      const gitDir = await this.fetchPinnedCommit(repository, sha);
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
      const content = await this.readAnalysisBlob(
        repository,
        gitDir,
        object,
        deploymentDocMaxBytes,
      );
      return { path, commitSha: sha, content };
    });
  }

  async readAnalysisContext(
    projectId: string,
    repositoryId: string,
    options: { commitSha?: string; branch?: string; docPath?: string; repoPath?: string } = {},
  ) {
    const docPath = options.docPath;
    const repoPath = options.repoPath ?? '.';
    const explicitSha = options.commitSha?.toLowerCase();
    if (options.branch !== undefined && !isBranchName(options.branch))
      throw new BadRequestException('仓库分析的 Git 分支名称无效');
    if (explicitSha !== undefined && !shaPattern.test(explicitSha))
      throw new BadRequestException('仓库分析需要完整 Git Commit SHA');
    if (docPath !== undefined && (!isDeploymentDocPath(docPath) || !isAnalysisPath(docPath)))
      throw new BadRequestException('请指定仓库内的 DEPLOY.md 或 deployment.md 相对路径');
    if (repoPath !== '.' && !isAnalysisPath(repoPath))
      throw new BadRequestException('请指定有效的仓库相对子目录');

    return this.withRepository(projectId, repositoryId, async (repository) => {
      let commitSha = explicitSha;
      let branch = options.branch;
      if (commitSha === undefined) {
        const { defaultBranch, branches } = await this.listBranches(repository);
        branch ??= defaultBranch ?? undefined;
        commitSha = branches.find((entry) => entry.name === branch)?.sha;
        if (!commitSha)
          throw new BadRequestException(
            '所选分支不存在或仓库没有默认分支，请指定有效分支或完整提交',
          );
      }
      const gitDir = await this.fetchPinnedCommit(repository, commitSha);
      const scope = repoPath === '.' ? [] : [repoPath, ...(docPath ? [docPath] : [])];
      const tree = await repository.runBytes(
        [gitDir, '--literal-pathspecs', 'ls-tree', '-r', '-z', commitSha, '--', ...scope],
        analysisTreeMaxBytes,
      );
      const entries = parseAnalysisTree(tree.toString('utf8'));
      if (repoPath !== '.' && !entries.some(({ path }) => path.startsWith(repoPath + '/')))
        throw new NotFoundException('指定提交中不存在该仓库子目录或目录中没有普通文件');
      if (docPath && !entries.some((entry) => entry.path === docPath))
        throw new NotFoundException('指定提交中不存在该部署文档或文档不是普通文件');

      const preferred = docPath?.split('/').slice(0, -1).join('/');
      // Prefer evidence alongside the selected deployment document before other services.
      const rank = (path: string) =>
        (preferred && !path.startsWith(preferred + '/') ? 20 : 0) + path.split('/').length;
      const candidates = entries
        .flatMap((entry) => {
          const kind = analysisFileKind(entry.path);
          return kind && repository.redact(entry.path) === entry.path ? [{ ...entry, kind }] : [];
        })
        .sort(
          (left, right) =>
            rank(left.path) - rank(right.path) || left.path.localeCompare(right.path, 'en'),
        );
      const files: {
        path: string;
        kind: Exclude<AnalysisFileKind, 'lockfile'>;
        content: string;
      }[] = [];
      let remaining = analysisTotalMaxBytes;
      const quotas = { deployment: 2, description: 2, configuration: 5, source: 4 } as const;
      const selected = [
        ...candidates.filter((entry) => entry.path === docPath),
        ...Object.entries(quotas).flatMap(([kind, limit]) =>
          candidates
            .filter((entry) => entry.kind === kind && entry.path !== docPath)
            .slice(0, limit),
        ),
      ];
      for (const entry of selected) {
        if (!remaining) break;
        if (entry.kind === 'lockfile') continue;
        const maxBytes = entry.kind === 'deployment' ? deploymentDocMaxBytes : analysisFileMaxBytes;
        try {
          const content = await this.readAnalysisBlob(
            repository,
            gitDir,
            entry.object,
            Math.min(remaining, maxBytes),
          );
          files.push({ path: entry.path, kind: entry.kind, content });
          remaining -= Buffer.byteLength(content, 'utf8');
        } catch (error) {
          if (
            entry.path === docPath ||
            !(error instanceof BadRequestException || error instanceof BadGatewayException)
          )
            throw error;
        }
      }
      const lockfiles = candidates
        .filter((entry) => entry.kind === 'lockfile')
        .slice(0, 16)
        .map((entry) => entry.path);
      if (!files.length)
        throw new BadRequestException('未找到可分析的仓库文本，请选择包含部署文档或构建配置的目录');
      return { commitSha, branch, repoPath, files, lockfiles };
    });
  }

  private async fetchPinnedCommit(
    repository: GitRepository,
    sha: string,
    maxBlobBytes = deploymentDocMaxBytes,
  ) {
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
      `--filter=blob:limit=${maxBlobBytes + 1}`,
      '--no-tags',
      '--no-recurse-submodules',
      '--',
      repository.url,
      sha,
    ]);
    const fetched = await repository.run([gitDir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    if (fetched.trim() !== sha) throw new BadGatewayException('未取得指定 Git Commit');
    return gitDir;
  }

  private async readAnalysisBlob(
    repository: GitRepository,
    gitDir: string,
    object: string,
    maxBytes: number,
  ) {
    const size = Number((await repository.run([gitDir, 'cat-file', '-s', object])).trim());
    const oversized = () => new BadRequestException('仓库文本超过读取大小限制');
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw oversized();
    const bytes = await repository.runBytes([gitDir, 'cat-file', 'blob', object], maxBytes);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new BadRequestException('仓库文件必须是 UTF-8 文本');
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(content))
      throw new BadRequestException('仓库文件必须是 UTF-8 文本');
    const redacted = repository.redact(content);
    if (Buffer.byteLength(redacted, 'utf8') > maxBytes) throw oversized();
    return redacted;
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
    expected?: RepositoryAccess,
    timeoutMs = 25_000,
    cancellation?: AbortSignal,
  ): Promise<T> {
    const repository = await this.database.db
      .selectFrom('repositories')
      .innerJoin('projects', 'projects.id', 'repositories.project_id')
      .select(['repositories.clone_url', 'repositories.credential_id'])
      .where('repositories.id', '=', repositoryId)
      .where('repositories.project_id', '=', projectId)
      .where('repositories.archived_at', 'is', null)
      .where('projects.deleted_at', 'is', null)
      .executeTakeFirst();
    if (!repository) throw new NotFoundException('仓库不存在');
    if (
      expected &&
      (expected.clone_url !== repository.clone_url ||
        expected.credential_id !== repository.credential_id)
    )
      throw new ConflictException('源码节点的仓库配置已变化，请重新预览');
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
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = cancellation ? AbortSignal.any([timeout, cancellation]) : timeout;
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

  @Get('branch-cache')
  cachedBranches(
    @Param('projectId') projectId: string,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.metadata.cachedBranches(projectId, repositoryId);
  }

  @Post('branch-cache/refresh')
  refreshBranches(
    @Param('projectId') projectId: string,
    @Param('repositoryId') repositoryId: string,
  ) {
    return this.metadata.refreshBranches(projectId, repositoryId);
  }

  @Get('commits')
  commits(
    @Param('projectId') projectId: string,
    @Param('repositoryId') repositoryId: string,
    @Query() query: RepositoryCommitsQuery,
  ) {
    return this.metadata.commits(projectId, repositoryId, query);
  }

  @Get('environment-files')
  environmentFiles(
    @Param('projectId') projectId: string,
    @Param('repositoryId') repositoryId: string,
    @Query('commitSha') commitSha?: string,
  ) {
    return this.metadata.environmentFiles(projectId, repositoryId, commitSha);
  }
}
