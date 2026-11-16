import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseService } from '../../core/database/database.service';
import { sanitizeAiText } from '../../infrastructure/ai-provider/openai-compatible.service';
import { AuditService } from '../audit/audit.service';
import { gitCredentialHelper } from '../builds/builds.service';
import { CredentialsService } from '../credentials/credentials.service';
import { httpCloneUrl } from '../projects/repository-metadata.service';

export type AiSourceStage = 'BRANCH' | 'PULL_REQUEST';

type SourceFile = { path: string; content: string };
type SourceRequest = {
  projectId: string;
  repositoryId: string;
  baseBranch: string;
  baseCommit: string;
  title: string;
};
type PreparedSource = {
  projectId: string;
  repositoryId: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  bindingsHash: string;
};
type BranchReceipt = {
  projectId: string;
  repositoryId: string;
  baseBranch: string;
  baseCommit: string;
  branch: string;
  commitSha: string;
  files: string[];
  repositoryHash: string;
};
type Repository = {
  url: string;
  api: string;
  pullPath: string;
  html: string;
  provider: 'GITHUB' | 'GITEA';
  credentialId: string;
  nonce: string;
  hash: string;
};

const exec = promisify(execFile);
const identifier = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const commitPattern = /^[a-f0-9]{40}$/;
const branchReceiptPattern = /^veyops-ai\/(.+)$/;
const sourceSuffix = /\.(?:cjs|cs|go|java|js|jsx|kt|mjs|php|py|rb|rs|ts|tsx)$/i;
const sourceRoots = new Set(['app', 'client', 'lib', 'server', 'src']);
const excludedSegments =
  /^(?:secrets?|credentials?|private|config|scripts?|workflows?|hooks?|node_modules|vendor|dist|build|migrations?)$/i;
const excludedNames =
  /(?:^|[._-])(?:secrets?|credentials?|password|private|tokens?|config|settings|hooks?|workflow)(?:[._-]|$)/i;
const gitEnvironment = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);

function safeText(value: unknown, limit: number, label: string, multiline = false): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > limit ||
    (multiline ? /[^\P{Cc}\t\r\n]/u : /\p{Cc}/u).test(value) ||
    /[\u202a-\u202e\u2066-\u2069]/.test(value) ||
    sanitizeAiText(value) !== value
  )
    throw new BadRequestException(`AI 源码变更的${label}无效或包含敏感内容`);
  return value;
}

function validBranch(value: string) {
  return (
    /^[a-z0-9_-][a-z0-9._/-]{0,125}$/i.test(value) &&
    !value.includes('..') &&
    !value.toLowerCase().startsWith('veyops-ai/') &&
    value
      .split('/')
      .every(
        (part) => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock'),
      )
  );
}

function isAllowedPath(path: string) {
  if (
    path.length > 180 ||
    path.split('/').some((part) => !/^[a-z0-9_][a-z0-9_.-]*$/i.test(part) || part.endsWith('.')) ||
    path.split('/').some((part) => excludedSegments.test(part))
  )
    return false;
  const parts = path.split('/');
  const filename = parts.at(-1)!;
  if (excludedNames.test(filename)) return false;
  if (/^(?:readme|deploy|deployment)\.md$/i.test(path)) return true;
  if (parts[0] === 'docs') return parts.length > 1 && /\.md$/i.test(path);
  const sourcePart = parts[0] === 'apps' || parts[0] === 'packages' ? 2 : 0;
  return (
    parts.length > sourcePart + 1 && sourceRoots.has(parts[sourcePart]) && sourceSuffix.test(path)
  );
}

function requestFrom(input: Record<string, unknown>): SourceRequest {
  const { projectId, repositoryId, baseBranch, baseCommit } = input;
  if (
    typeof projectId !== 'string' ||
    !identifier.test(projectId) ||
    typeof repositoryId !== 'string' ||
    !identifier.test(repositoryId) ||
    typeof baseBranch !== 'string' ||
    !validBranch(baseBranch) ||
    typeof baseCommit !== 'string' ||
    !commitPattern.test(baseCommit)
  )
    throw new BadRequestException('AI 源码变更需要已登记仓库、基线分支和完整提交 SHA');
  const title = safeText(input.title, 120, '标题');
  if (title.includes('@') || title.startsWith('-'))
    throw new BadRequestException('AI 源码变更标题无效');
  return { projectId, repositoryId, baseBranch, baseCommit, title };
}

function filesFrom(input: unknown): SourceFile[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8)
    throw new BadRequestException('AI 源码变更必须指定 1–8 个已有文件');
  const files = input.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new BadRequestException('AI 源码变更文件无效');
    const { path, content } = item as Record<string, unknown>;
    if (typeof path !== 'string' || !isAllowedPath(path))
      throw new BadRequestException('AI 源码变更只允许修改已有源文件和部署文档');
    return { path, content: safeText(content, 24 * 1024, '文件正文', true) };
  });
  if (
    new Set(files.map(({ path }) => path.toLowerCase())).size !== files.length ||
    files.reduce((total, { content }) => total + Buffer.byteLength(content), 0) > 48 * 1024
  )
    throw new BadRequestException('AI 源码变更包含重复路径或超出总大小限制');
  return files;
}

function transport(provider: string, cloneUrl: string) {
  const url = new URL(httpCloneUrl(cloneUrl));
  const parts = url.pathname.split('/').slice(1);
  const repo = parts.pop()?.replace(/\.git$/i, '');
  const owner = parts.pop();
  const pathPart = (value: string | undefined): value is string =>
    !!value && /^[a-z0-9_-][a-z0-9_.-]*$/i.test(value);
  if (!pathPart(owner) || !pathPart(repo) || parts.some((part) => !pathPart(part)))
    throw new BadRequestException('AI 仓库写入需要标准的仓库克隆地址');
  const path = `${owner}/${repo}`;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (provider === 'GITHUB' && url.origin === 'https://github.com' && parts.length === 0)
    return {
      provider: 'GITHUB' as const,
      url: url.href,
      api: `https://api.github.com/repos/${path}`,
      html: `${url.origin}/${path}`,
      pullPath: 'pull',
    };
  if (provider === 'GITEA' && (url.protocol === 'https:' || loopback)) {
    const root = url.origin + (parts.length ? '/' + parts.join('/') : '');
    return {
      provider: 'GITEA' as const,
      url: url.href,
      api: `${root}/api/v1/repos/${path}`,
      html: `${root}/${path}`,
      pullPath: 'pulls',
    };
  }
  throw new BadRequestException('AI 仓库写入仅支持 GitHub.com、HTTPS Gitea 或本机 Gitea');
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function withGit<T>(
  repository: Repository,
  token: string,
  username: string,
  callback: (run: (args: string[]) => Promise<string>, work: string) => Promise<T>,
) {
  const work = await mkdtemp(join(tmpdir(), 'veyops-ai-source-'));
  try {
    const credentialPath = join(work, 'credential');
    await writeFile(credentialPath, `username=${username}\npassword=${token}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => gitEnvironment.has(key.toUpperCase())),
    );
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(work, 'global'),
      GIT_CEILING_DIRECTORIES: dirname(work),
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_AUTHOR_NAME: 'VeyOps AI',
      GIT_AUTHOR_EMAIL: 'veyops-ai@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'VeyOps AI',
      GIT_COMMITTER_EMAIL: 'veyops-ai@users.noreply.github.com',
    });
    const options = [
      '-c',
      `core.hooksPath=${join(work, 'hooks')}`,
      '-c',
      'protocol.allow=never',
      '-c',
      `protocol.${new URL(repository.url).protocol.slice(0, -1)}.allow=always`,
      '-c',
      'http.followRedirects=false',
      '-c',
      'http.lowSpeedLimit=1',
      '-c',
      'http.lowSpeedTime=10',
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=${gitCredentialHelper(credentialPath.replaceAll('\\', '/'))}`,
    ];
    const signal = AbortSignal.timeout(45_000);
    const run = async (args: string[]) => {
      try {
        return (
          await exec('git', [...options, ...args], {
            cwd: work,
            env,
            signal,
            shell: false,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
          })
        ).stdout;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new ServiceUnavailableException('管理端未安装 Git');
        if (signal.aborted) throw new BadGatewayException('Git 仓库操作超时');
        throw new BadGatewayException('Git 仓库操作失败，请核查仓库状态与凭据权限');
      }
    };
    return await callback(run, work);
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

@Injectable()
export class AiSourceChangeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
  ) {}

  suggest(input: Record<string, unknown>) {
    const source = requestFrom(input);
    const notes = safeText(input.description, 3000, '建议', true);
    return {
      ...source,
      notes,
      ...(input.files === undefined ? {} : { files: filesFrom(input.files) }),
      draftOnly: true,
    };
  }

  async prepare(
    input: Record<string, unknown>,
    stage: AiSourceStage,
    userId?: string,
  ): Promise<PreparedSource> {
    const source = requestFrom(input);
    const { projectId, repositoryId } = source;
    const repository = await this.repository(projectId, repositoryId);
    const payload: Record<string, unknown> = { ...source };
    const preview: Record<string, unknown> = { ...source, stage, repository: repository.html };
    if (stage === 'BRANCH') {
      const files = filesFrom(input.files);
      payload.files = files;
      preview.files = files.map(({ path }) => path);
    } else {
      const receipt = await this.branchReceipt(input);
      this.checkReceipt(receipt, source, repository);
      if (userId && receipt.owner !== userId)
        throw new ForbiddenException('只能为本人创建的 AI 分支提交 PR');
      Object.assign(payload, { branch: receipt.branch, commitSha: receipt.commitSha });
      Object.assign(preview, {
        branch: receipt.branch,
        commitSha: receipt.commitSha,
        files: receipt.files,
      });
    }
    const { token } = await this.gitToken(repository);
    const exposed = [
      ...Object.values(payload).filter((value): value is string => typeof value === 'string'),
      ...(stage === 'BRANCH'
        ? (payload.files as SourceFile[]).flatMap(({ path, content }) => [path, content])
        : []),
    ];
    if (exposed.some((value) => value.includes(token)))
      throw new BadRequestException('AI 源码变更包含仓库凭据');
    return {
      projectId,
      repositoryId,
      payload,
      preview,
      bindingsHash: hash([stage, repository.hash, payload]),
    };
  }

  async execute(
    stage: AiSourceStage,
    payload: Record<string, unknown>,
    expectedBindingsHash: string,
    userId: string,
  ) {
    const prepared = await this.prepare(payload, stage, userId);
    if (prepared.bindingsHash !== expectedBindingsHash)
      throw new ConflictException('仓库绑定或源码变更已修改');
    const source = requestFrom(prepared.payload);
    const repository = await this.repository(source.projectId, source.repositoryId);
    if (hash([stage, repository.hash, prepared.payload]) !== expectedBindingsHash)
      throw new ConflictException('仓库绑定或源码变更已修改');
    const { token, username } = await this.gitToken(repository);
    if (stage === 'BRANCH')
      return this.pushBranch(
        source,
        filesFrom(prepared.payload.files),
        repository,
        token,
        username,
        userId,
      );

    const receipt = await this.branchReceipt(prepared.payload);
    this.checkReceipt(receipt, source, repository);
    if (receipt.owner !== userId) throw new ForbiddenException('只能为本人创建的 AI 分支提交 PR');
    return this.openPullRequest(source, receipt, repository, token, username, userId);
  }

  private async gitToken(repository: Repository) {
    const credential = await this.credentials.decrypt(repository.credentialId, repository.nonce);
    const token = credential.token;
    const username =
      credential.username || (repository.provider === 'GITHUB' ? 'x-access-token' : '');
    if (!username || !token || /[^\x21-\x7e]/.test(token + username) || token.length < 8)
      throw new BadRequestException('AI 仓库写入需要有效的单行 Git Token，Gitea 还需要用户名');
    return { token, username };
  }

  private async repository(projectId: string, repositoryId: string): Promise<Repository> {
    const row = await this.database.db
      .selectFrom('repositories')
      .innerJoin('projects', 'projects.id', 'repositories.project_id')
      .innerJoin('credentials', 'credentials.id', 'repositories.credential_id')
      .select([
        'repositories.provider',
        'repositories.clone_url',
        'credentials.id',
        'credentials.nonce',
      ])
      .where('repositories.id', '=', repositoryId)
      .where('repositories.project_id', '=', projectId)
      .where('projects.deleted_at', 'is', null)
      .where('credentials.status', '=', 'ACTIVE')
      .where('credentials.type', '=', 'GIT_TOKEN')
      .executeTakeFirst();
    if (!row) throw new NotFoundException('仓库不存在或没有绑定可用的 Git Token');
    const location = transport(row.provider, row.clone_url);
    return {
      ...location,
      credentialId: row.id,
      nonce: row.nonce,
      hash: hash([projectId, repositoryId, row.provider, row.clone_url, row.id, row.nonce]),
    };
  }

  private async branchReceipt(input: Record<string, unknown>) {
    const match = typeof input.branch === 'string' ? branchReceiptPattern.exec(input.branch) : null;
    if (
      !match ||
      !identifier.test(match[1]) ||
      typeof input.commitSha !== 'string' ||
      !commitPattern.test(input.commitSha)
    )
      throw new BadRequestException('提交 PR 需要本平台创建的独立 AI 分支和完整提交 SHA');
    const id = match[1];
    const row = await this.database.db
      .selectFrom('audit_logs')
      .select(['user_id', 'details_json'])
      .where('resource_type', '=', 'ai_source_branch')
      .where('resource_id', '=', id)
      .where('action', '=', 'ai.source.branch')
      .executeTakeFirst();
    if (!row) throw new NotFoundException('AI 分支记录不存在');
    const receipt = JSON.parse(row.details_json) as BranchReceipt;
    if (receipt.branch !== input.branch || receipt.commitSha !== input.commitSha)
      throw new ConflictException('AI 分支内容与提交记录不一致');
    return { ...receipt, id, owner: row.user_id };
  }

  private checkReceipt(receipt: BranchReceipt, source: SourceRequest, repository: Repository) {
    if (
      receipt.projectId !== source.projectId ||
      receipt.repositoryId !== source.repositoryId ||
      receipt.baseBranch !== source.baseBranch ||
      receipt.baseCommit !== source.baseCommit ||
      receipt.repositoryHash !== repository.hash
    )
      throw new ConflictException('AI 分支不属于当前仓库、基线或绑定凭据');
  }

  private async checkRemoteRef(
    run: (args: string[]) => Promise<string>,
    url: string,
    branch: string,
    sha: string,
  ) {
    const output = await run(['ls-remote', '--refs', '--', url, `refs/heads/${branch}`]);
    if (output.trim() !== `${sha}\trefs/heads/${branch}`)
      throw new ConflictException('远端分支提交已变化，须重新核对源码变更');
  }

  private async pushBranch(
    source: SourceRequest,
    files: SourceFile[],
    repository: Repository,
    token: string,
    username: string,
    userId: string,
  ) {
    const id = randomUUID();
    const branch = `veyops-ai/${id}`;
    const commitSha = await withGit(repository, token, username, async (run, work) => {
      const bare = join(work, 'source.git');
      await run(['init', '--bare', '--template=', '-q', bare]);
      const gitDir = `--git-dir=${bare}`;
      const git = (args: string[]) => run([gitDir, ...args]);
      await git([
        'fetch',
        '--depth=1',
        '--no-tags',
        '--no-recurse-submodules',
        '--',
        repository.url,
        `refs/heads/${source.baseBranch}`,
      ]);
      if (
        (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim() !== source.baseCommit
      )
        throw new ConflictException('远端基线提交已变化，须重新核对源码变更');
      await git(['read-tree', source.baseCommit]);
      for (const [index, { path, content }] of files.entries()) {
        const entry = await git([
          '--literal-pathspecs',
          'ls-tree',
          '-z',
          source.baseCommit,
          '--',
          path,
        ]);
        if (!/^100644 blob [a-f0-9]{40}\t/.test(entry) || entry.split('\t')[1] !== path + '\0')
          throw new BadRequestException('AI 源码变更必须指向已有的普通非可执行文件');
        const file = join(work, `file-${index}`);
        await writeFile(file, content, { flag: 'wx', mode: 0o600 });
        const object = (await git(['hash-object', '-w', '--no-filters', '--', file])).trim();
        await git(['update-index', '--cacheinfo', `100644,${object},${path}`]);
      }
      const tree = (await git(['write-tree'])).trim();
      if (tree === (await git(['rev-parse', `${source.baseCommit}^{tree}`])).trim())
        throw new BadRequestException('AI 源码变更与基线内容相同');
      const commit = (
        await git([
          '-c',
          'commit.gpgSign=false',
          'commit-tree',
          tree,
          '-p',
          source.baseCommit,
          '-m',
          source.title,
        ])
      ).trim();
      if (!commitPattern.test(commit)) throw new BadGatewayException('未能确认 AI 分支的提交');
      await this.checkRemoteRef(run, repository.url, source.baseBranch, source.baseCommit);
      const ref = `refs/heads/${branch}`;
      try {
        await git([
          'push',
          '--no-verify',
          `--force-with-lease=${ref}:`,
          '--',
          repository.url,
          `${commit}:${ref}`,
        ]);
      } catch {
        throw new BadGatewayException(`AI 分支提交结果未确认，请核查分支 ${branch}`);
      }
      return commit;
    });
    const { projectId, repositoryId, baseBranch, baseCommit } = source;
    const paths = files.map(({ path }) => path);
    await this.audit.record(userId, 'ai.source.branch', 'ai_source_branch', id, {
      projectId,
      repositoryId,
      baseBranch,
      baseCommit,
      branch,
      commitSha,
      files: paths,
      repositoryHash: repository.hash,
    });
    return {
      id,
      kind: 'SOURCE_BRANCH' as const,
      projectId,
      repositoryId,
      baseBranch,
      baseCommit,
      branch,
      commitSha,
      files: paths,
    };
  }

  private async openPullRequest(
    source: SourceRequest,
    receipt: BranchReceipt & { id: string },
    repository: Repository,
    token: string,
    username: string,
    userId: string,
  ) {
    const existing = await this.database.db
      .selectFrom('audit_logs')
      .select('details_json')
      .where('resource_type', '=', 'ai_source_branch')
      .where('resource_id', '=', receipt.id)
      .where('action', '=', 'ai.source.pull_request')
      .executeTakeFirst();
    if (existing)
      return JSON.parse(existing.details_json) as {
        id: string;
        kind: 'PULL_REQUEST';
        number: number;
        url: string;
      };

    await withGit(repository, token, username, async (git) => {
      await this.checkRemoteRef(git, repository.url, source.baseBranch, source.baseCommit);
      await this.checkRemoteRef(git, repository.url, receipt.branch, receipt.commitSha);
    });
    // Claim the one external PR submission before sending it. An uncertain response needs manual inspection.
    const claim = await this.database.db
      .insertInto('audit_logs')
      .values({
        id: receipt.id,
        actor_type: 'USER',
        user_id: userId,
        action: 'ai.source.pull_request_requested',
        resource_type: 'ai_source_branch',
        resource_id: receipt.id,
        details_json: JSON.stringify({ branch: receipt.branch, commitSha: receipt.commitSha }),
        created_at: Date.now(),
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!claim)
      throw new ConflictException(`该分支已提交过 PR 创建请求，请先核查远端分支 ${receipt.branch}`);
    const body = [
      'VeyOps AI prepared this change for human review.',
      '',
      `Base commit: ${source.baseCommit}`,
      '',
      ...receipt.files.map((path) => '- `' + path + '`'),
    ].join('\n');
    const response = await fetch(repository.api + '/pulls', {
      method: 'POST',
      headers: {
        accept:
          repository.provider === 'GITHUB' ? 'application/vnd.github+json' : 'application/json',
        authorization: `${repository.provider === 'GITHUB' ? 'Bearer' : 'token'} ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        head: receipt.branch,
        base: source.baseBranch,
        title: source.title,
        body,
        ...(repository.provider === 'GITHUB' ? { draft: true, maintainer_can_modify: false } : {}),
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }).catch(() => {
      throw new BadGatewayException(`PR 创建结果未确认，请核查分支 ${receipt.branch}`);
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new BadGatewayException(`PR 创建失败，请核查分支 ${receipt.branch} 和凭据权限`);
    }
    let raw = '';
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of response.body) {
      raw += decoder.decode(chunk, { stream: true });
      if (raw.length > 128 * 1024) throw new BadGatewayException('PR 创建响应过大，请核查远端');
    }
    raw += decoder.decode();
    let number: unknown;
    try {
      number = (JSON.parse(raw) as { number?: unknown }).number;
    } catch {
      throw new BadGatewayException('PR 创建响应无效，请核查远端');
    }
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)
      throw new BadGatewayException('PR 创建响应无效，请核查远端');
    const result = {
      id: receipt.id,
      kind: 'PULL_REQUEST' as const,
      number,
      url: `${repository.html}/${repository.pullPath}/${number}`,
    };
    await this.audit.record(
      userId,
      'ai.source.pull_request',
      'ai_source_branch',
      receipt.id,
      result,
    );
    return result;
  }
}
