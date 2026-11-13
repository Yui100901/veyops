import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, relative } from 'node:path';
import { dataDirectory } from '../../core/config';
import { SshExecutionError, SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  ProcessExecutionError,
  ProcessRunnerService,
  type ProcessOptions,
} from '../../infrastructure/build-runner/process-runner.service';
import { CredentialsService } from '../credentials/credentials.service';
import { RegistriesService } from '../registries/registries.service';
import type { PipelineSnapshot, BuildOutput } from '../pipelines/pipeline.types';
import { shellQuote as q } from '../pipelines/pipeline.validation';
import type { TaskExecutionContext } from '../tasks/tasks.types';

// Usernames are metadata (also passed as the standard docker --username option), not secret values.
// Redacting a one-letter username would corrupt trusted digest/checksum output used for verification.
const credentialSecrets = (secret: Record<string, string>) =>
  Object.entries(secret)
    .filter(([key]) => key !== 'username')
    .map(([, value]) => value);

export interface GitSecret {
  response: string;
  values: string[];
}
export class BuildCommandError extends Error {
  constructor(
    public readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}
export interface BuildSession {
  snapshot: PipelineSnapshot;
  taskId: string;
  context: TaskExecutionContext;
  variables: Record<string, string>;
  secrets: string[];
  webhookDocker?: { socket: string; config: string };
}

function configuredCommands(definition: PipelineSnapshot['definition']) {
  return [
    {
      command: definition.installCommand,
      timeout: 900,
      name: '安装依赖',
      check: '请检查安装命令、依赖源的网络和访问权限，以及构建环境中的包管理器',
    },
    {
      command: definition.buildCommand,
      timeout: 900,
      name: '执行构建命令',
      check: '请检查构建命令和构建工具是否可用',
    },
    ...definition.steps.map((step, index) => ({
      command: step.command,
      timeout: step.timeout ?? 900,
      name: `执行附加构建步骤 ${index + 1}`,
      check: '请检查该步骤的命令和所需工具',
    })),
  ].filter((step) => step.command);
}

export function webhookBuildSocket() {
  const socket = process.env.WEBHOOK_BUILD_DOCKER_SOCKET;
  if (!socket || !/^\/[\w./-]+$/.test(socket) || socket.includes('..') || socket.endsWith('/'))
    return undefined;
  return socket;
}
export const gitCredentialHelper = (responsePath: string) =>
  `!f() { case "$1" in get) cat -- ${q(responsePath)} ;; store|erase) : ;; *) return 1 ;; esac; }; f`;
export const checkoutScript = (
  url: string,
  commit: string,
  workspace: string,
  credentialResponse?: string,
) => {
  const options = [
    '-c core.hooksPath=/dev/null',
    '-c credential.helper=',
    '-c http.followRedirects=false',
  ];
  if (credentialResponse)
    options.push(`-c credential.helper=${q(gitCredentialHelper(credentialResponse))}`);
  const git = `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git ${options.join(' ')}`;
  return `set -eu\ncommand -v git >/dev/null || { echo '构建环境缺少 Git CLI，请安装 Git 或选择包含 Git 的辅助镜像' >&2; exit 127; }\n${git} clone --no-checkout -- ${q(url)} ${q(workspace + '/repo')}\ncd ${q(workspace + '/repo')}\nif ! ${git} cat-file -e ${q(commit + '^{commit}')} 2>/dev/null; then ${git} fetch origin ${q(commit)}; fi\n${git} checkout --detach ${q(commit)}\ntest "$(${git} rev-parse HEAD)" = ${q(commit)}\n`;
};
export const packScript = (work: string, repoPath: string, outputPath: string, archive: string) =>
  `set -eu\n${enterRepositoryDirectory(work, repoPath)}\noutput=$(realpath -- ${q(outputPath)})\ncase "$output" in "$veyops_repo"/*) ;; *) echo '产物路径超出工作目录' >&2; exit 1;; esac\ntest -z "$(find "$output" -type l -print -quit)"\nif test -d "$output"; then tar -czf ${q(archive)} -C "$output" .; elif test -f "$output"; then tar -czf ${q(archive)} -C "$(dirname "$output")" "$(basename "$output")"; else echo '产物不存在或不是普通文件/目录' >&2; exit 1; fi\nprintf 'VEYOPS_ARTIFACT:%s:%s\\n' "$(sha256sum ${q(archive)} | cut -d' ' -f1)" "$(wc -c < ${q(archive)})"\n`;

export function enterRepositoryDirectory(work: string, repoPath: string) {
  return `cd -P ${q(work)}; veyops_repo=$PWD/repo; test ! -L "$veyops_repo"; cd -P "$veyops_repo"/${q(repoPath)}; case "$PWD" in "$veyops_repo"|"$veyops_repo"/*) ;; *) echo '构建工作目录超出仓库' >&2; exit 1 ;; esac`;
}

export function resolveRepositoryFile(path: string) {
  return `veyops_file=$(realpath -- ${q('./' + path)}); case "$veyops_file" in "$veyops_repo"/*) test -f "$veyops_file" ;; *) echo '构建配置文件超出仓库' >&2; exit 1 ;; esac`;
}

const maxArchiveBytes = 1024 * 1024 * 1024;

export function archiveMetadata(output: string) {
  const match = /^VEYOPS_ARTIFACT:([a-f0-9]{64}):([0-9]+)$/m.exec(output);
  if (!match) throw new Error('文件产物校验信息缺失');
  return { checksum: match[1], sizeBytes: Number(match[2]) };
}

function localImageTag(session: BuildSession, targetId?: string): string {
  const repository = `veyops-build/${session.snapshot.pipelineId}${targetId ? `/${targetId}` : ''}`;
  return `${repository}:${session.snapshot.commitSha}-${session.taskId}`;
}

export function registryImageTag(session: BuildSession, targetId?: string) {
  const tag = `${session.snapshot.commitSha.slice(0, 12)}-${session.taskId}${targetId ? `-${targetId}` : ''}`;
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(tag)) throw new Error('无效的发布镜像标签');
  return tag;
}

export function pushedImageDigest(output: string, tag: string) {
  const digests = output.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith(`${tag}: `)) return [];
    const match = /^digest: (sha256:[a-f0-9]{64})\s+size: [0-9]+\s*$/.exec(
      line.slice(tag.length + 2),
    );
    return match ? [match[1]] : [];
  });
  if (digests.length !== 1) throw new Error('Registry推送未返回本次标签的唯一镜像Digest');
  return digests[0]!;
}

function inspectedImageId(output: string): string {
  const id = output.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('未读取到已构建的Docker镜像ID');
  return id;
}

@Injectable()
export class BuildsService {
  constructor(
    private readonly ssh: SshService,
    private readonly runner: ProcessRunnerService,
    private readonly credentials: CredentialsService,
    private readonly registries: RegistriesService,
  ) {}
  async gitSecret(credentialId: string | null): Promise<GitSecret | undefined> {
    if (!credentialId) return undefined;
    const s = await this.credentials.decrypt(credentialId);
    if (s.privateKey)
      throw new Error('Pipeline Git checkout暂不支持SSH私钥；请改用HTTPS Token凭据');
    const username = s.username || 'oauth2',
      password = s.token || s.password;
    if (!password || /[\r\n]/.test(username + password))
      throw new Error('Git凭据须包含单行token或用户名密码');
    return {
      response: `username=${username}\npassword=${password}\n`,
      values: credentialSecrets(s),
    };
  }
  async resolveVariables(snapshot: PipelineSnapshot) {
    const values = { ...snapshot.variables };
    const secrets: string[] = [];
    for (const [name, id] of Object.entries(snapshot.secretVariables)) {
      const credential = await this.credentials.decrypt(id);
      const secret =
        credential.value ??
        credential.secret ??
        credential.password ??
        credential.apiKey ??
        credential.token;
      if (secret === undefined) throw new Error(`敏感变量${name}的凭据不含支持的值`);
      values[name] = secret;
      secrets.push(...credentialSecrets(credential));
    }
    if (Object.keys(values).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
      throw new Error('无效环境变量名');
    return { values, secrets };
  }
  async remote(
    target: SshTarget,
    command: string,
    session: BuildSession,
    timeout = 900,
    failureMessage = '远程步骤失败',
  ) {
    const result = await this.ssh.execute(target, command, {
      timeout,
      signal: session.context.signal,
      secrets: session.secrets,
      onData: (text) => session.context.log(text, target.id),
    });
    if (result.exitCode !== 0)
      throw new BuildCommandError(
        result.exitCode,
        `${failureMessage}（退出码 ${result.exitCode}）`,
      );
  }
  async remoteCapture(
    target: SshTarget,
    command: string,
    session: BuildSession,
    timeout = 900,
    failureMessage = '远程步骤失败',
  ) {
    let output = '';
    const result = await this.ssh.execute(target, command, {
      timeout,
      signal: session.context.signal,
      secrets: session.secrets,
      onData: (text, stream) => {
        if (stream !== 'stderr') output += text;
        session.context.log(text, target.id);
      },
    });
    if (result.exitCode !== 0)
      throw new BuildCommandError(
        result.exitCode,
        `${failureMessage}（退出码 ${result.exitCode}）`,
      );
    return output;
  }
  async remoteCheckout(target: SshTarget, work: string, session: BuildSession) {
    const secret = await this.gitSecret(session.snapshot.repository.credentialId);
    if (secret) session.secrets.push(...secret.values);
    await this.remote(
      target,
      `set -eu; umask 077; mkdir -p ${q(work)}; test ! -L ${q(work)}`,
      session,
      30,
    );
    const response = work + '/git-credentials';
    try {
      if (secret)
        await this.ssh.uploadContent(target, secret.response, response, {
          timeout: 30,
          signal: session.context.signal,
          mode: 0o600,
        });
      await this.remote(
        target,
        checkoutScript(
          session.snapshot.repository.url,
          session.snapshot.commitSha,
          work,
          secret ? response : undefined,
        ),
        session,
        300,
        'Git 检出失败。请检查 Git CLI、仓库地址、网络、凭据及固定提交是否仍可获取',
      );
    } finally {
      await this.ssh
        .execute(target, `rm -f -- ${q(response)}`, { timeout: 30 })
        .catch(() => undefined);
    }
  }
  async remoteBuild(target: SshTarget, work: string, session: BuildSession) {
    const d = session.snapshot.definition;
    const env = Object.entries(session.variables)
      .map(([k, v]) => `export ${k}=${q(v)}`)
      .join('\n');
    // Variables are transferred by SFTP, not embedded in command arguments or stored in task payload.
    const envFile = work + '/build.env';
    await this.ssh.uploadContent(target, env + '\n', envFile, {
      timeout: 30,
      signal: session.context.signal,
      mode: 0o600,
    });
    try {
      for (const step of configuredCommands(d)) {
        session.context.log(`${step.name}\n`, target.id);
        await this.remote(
          target,
          `set -eu; . ${q(envFile)}; ${enterRepositoryDirectory(work, d.repoPath)}; ${step.command}`,
          session,
          step.timeout,
          `${step.name}失败。${step.check}`,
        );
      }
    } finally {
      await this.ssh
        .execute(target, `rm -f -- ${q(envFile)}`, { timeout: 30 })
        .catch(() => undefined);
    }
  }
  async checkTargetDocker(target: SshTarget, session: BuildSession, needsCompose: boolean) {
    await this.remote(
      target,
      'command -v docker >/dev/null 2>&1',
      session,
      15,
      '目标主机找不到 Docker CLI。请在目标主机安装 Docker 并检查 SSH 用户的 PATH',
    );
    await this.remote(
      target,
      'docker info --format "{{.ServerVersion}}" >/dev/null',
      session,
      15,
      '目标主机 Docker 守护进程不可用。请检查 Docker 服务和 SSH 用户访问权限',
    );
    if (needsCompose)
      await this.remote(
        target,
        'docker compose version >/dev/null',
        session,
        15,
        '目标主机无法执行 docker compose。请安装或修复 Docker Compose v2 插件',
      );
  }

  async remoteBuildOnlyImage(target: SshTarget, work: string, session: BuildSession) {
    const definition = session.snapshot.definition;
    const imageReference = localImageTag(session, target.id);
    await this.remote(
      target,
      `set -eu; ${enterRepositoryDirectory(work, definition.repoPath)}; ${resolveRepositoryFile(definition.dockerfilePath)}; DOCKER_BUILDKIT=1 docker build -f "$veyops_file" -t ${q(imageReference)} .`,
      session,
      1200,
      'Docker 镜像构建失败。请检查 Dockerfile、基础镜像及依赖源的网络和权限',
    );
    const output = await this.remoteCapture(
      target,
      `docker image inspect --format '{{.Id}}' ${q(imageReference)}`,
      session,
      30,
    );
    const imageId = inspectedImageId(output);
    const archive = work + '/image.tar.gz';
    const save = `ulimit -f ${maxArchiveBytes / 1024}; docker image save ${q(imageReference)} | gzip -1 > ${q(archive)}`;
    const metadata = archiveMetadata(
      await this.remoteCapture(
        target,
        `set -eu; umask 077; test ! -e ${q(archive)}; test ! -L ${q(archive)}; bash -e -o pipefail -c ${q(save)}; printf 'VEYOPS_ARTIFACT:%s:%s\\n' "$(sha256sum ${q(archive)} | cut -d' ' -f1)" "$(wc -c < ${q(archive)})"`,
        session,
        600,
      ),
    );
    const storagePath = await this.retainRemoteArchive(
      target,
      archive,
      metadata.checksum,
      metadata.sizeBytes,
      session,
    );
    return { imageReference, imageId, archiveKey: basename(storagePath), ...metadata };
  }
  async retainRemoteArchive(
    target: SshTarget,
    remotePath: string,
    checksum: string,
    size: number,
    session: BuildSession,
  ) {
    if (!Number.isSafeInteger(size) || size < 1 || size > maxArchiveBytes)
      throw new Error('文件产物大小无效或超过1GiB限制');
    const directory = join(dataDirectory, 'artifacts');
    const archive = join(directory, `${session.taskId}-${target.id}.tar.gz`);
    const partial = archive + '.partial';
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(partial, '', { flag: 'wx', mode: 0o600 });
    try {
      await this.ssh.download(target, remotePath, partial, {
        timeout: 300,
        signal: session.context.signal,
      });
      await chmod(partial, 0o600);
      if ((await stat(partial)).size !== size || (await this.checksum(partial)) !== checksum)
        throw new Error('下载的文件产物未通过完整性校验');
      if (session.context.signal.aborted) throw new SshExecutionError('任务已取消', 'CANCELLED');
      await rename(partial, archive);
      return archive;
    } finally {
      await rm(partial, { force: true });
    }
  }
  async manager(session: BuildSession): Promise<BuildOutput> {
    const root = resolve(dataDirectory, 'builds', session.taskId);
    const workspace = join(root, 'workspace'),
      secretDir = join(root, 'secrets');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(secretDir, { recursive: true, mode: 0o700 });
    const cleanup = async () => {
      if (relative(resolve(dataDirectory, 'builds'), root).startsWith('..'))
        throw new Error('Invalid build cleanup path');
      await rm(root, { recursive: true, force: true });
    };
    const d = session.snapshot.definition;
    try {
      if (session.snapshot.triggerType === 'WEBHOOK')
        await this.configureWebhookDocker(session, root);
      else
        await this.local(
          session,
          ['info', '--format', '{{.ServerVersion}}'],
          15,
          '管理端 Docker 守护进程不可用。请检查 Docker 服务和平台进程的访问权限',
        );
      const secret = await this.gitSecret(session.snapshot.repository.credentialId);
      if (secret) session.secrets.push(...secret.values);
      // Three separate containers: checkout can read credentials; untrusted build cannot.
      if (secret)
        await writeFile(join(secretDir, 'git-credentials'), secret.response, { mode: 0o600 });
      await this.container(
        session,
        workspace,
        checkoutScript(
          session.snapshot.repository.url,
          session.snapshot.commitSha,
          '/workspace',
          secret ? '/run/veyops/git-credentials' : undefined,
        ),
        secret ? secretDir : undefined,
        undefined,
        process.env.BUILD_HELPER_IMAGE || 'node:22-bookworm',
        300,
        '管理端检出失败。请检查辅助镜像是否可拉取，以及镜像内的 Git、仓库网络、凭据和固定提交',
      );
      await rm(secretDir, { recursive: true, force: true });
      const envPath = join(root, 'build.env');
      await writeFile(
        envPath,
        Object.entries(session.variables)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
        { mode: 0o600 },
      );
      if (Object.values(session.variables).some((v) => /[\r\n]/.test(v)))
        throw new Error('管理端容器环境变量暂不支持换行值');
      for (const step of configuredCommands(d)) {
        session.context.log(`${step.name}\n`);
        await this.container(
          session,
          workspace,
          `set -eu\n${enterRepositoryDirectory('/workspace', d.repoPath)}\n${step.command}\n`,
          undefined,
          envPath,
          undefined,
          step.timeout,
          `${step.name}失败。请确认构建镜像可拉取。${step.check}`,
        );
      }
      await rm(envPath, { force: true });
      if (d.artifactType === 'FILE') {
        const archive = join(workspace, 'artifact.tar.gz');
        // Reserve the output after repository containers have finished writing the workspace.
        await writeFile(archive, '', { flag: 'wx', mode: 0o600 });
        await this.container(
          session,
          workspace,
          packScript('/workspace', d.repoPath, d.outputPath, '/workspace/artifact.tar.gz'),
          undefined,
          undefined,
          process.env.BUILD_HELPER_IMAGE || 'node:22-bookworm',
        );
        const stored = await this.retainManagerArchive(
          archive,
          `${session.taskId}.tar.gz`,
          session,
        );
        return {
          localArchive: stored.path,
          checksum: stored.checksum,
          sizeBytes: stored.sizeBytes,
          cleanup,
        };
      }
      const dockerfile = resolve(workspace, 'repo', d.repoPath, d.dockerfilePath),
        buildContext = resolve(workspace, 'repo', d.repoPath);
      const repoRoot = await realpath(join(workspace, 'repo'));
      if (repoRoot !== join(await realpath(workspace), 'repo'))
        throw new Error('拒绝将符号链接仓库用作 Docker 构建目录');
      for (const checked of [await realpath(dockerfile), await realpath(buildContext)])
        if (relative(repoRoot, checked).startsWith('..') || isAbsolute(relative(repoRoot, checked)))
          throw new Error('Docker构建路径超出仓库');
      if (session.snapshot.mode === 'BUILD_ONLY') {
        const imageReference = localImageTag(session);
        await this.local(
          session,
          ['build', '--tag', imageReference, '--file', dockerfile, buildContext],
          1200,
          'Docker 镜像构建失败。请检查 Dockerfile、基础镜像及依赖源的网络和权限',
        );
        const inspected = await this.local(
          session,
          ['image', 'inspect', '--format', '{{.Id}}', imageReference],
          30,
        );
        const imageId = inspectedImageId(inspected.stdout);
        const archive = join(root, 'image.tar.gz');
        const exported = await this.runDocker(session, ['image', 'save', imageReference], 600, {
          signal: session.context.signal,
          log: true,
          gzipOutput: { path: archive, maxBytes: maxArchiveBytes },
        });
        if (exported.exitCode !== 0)
          throw new BuildCommandError(exported.exitCode, 'Docker镜像导出失败');
        const archiveKey = `${session.taskId}.tar.gz`;
        const stored = await this.retainManagerArchive(archive, archiveKey, session);
        return {
          imageReference,
          imageId,
          archiveKey,
          checksum: stored.checksum,
          sizeBytes: stored.sizeBytes,
          cleanup,
        };
      }
      const registry = session.snapshot.registry ?? (await this.registries.get(d.registryId!));
      const repository = `${registry.registryUrl}/${d.imageRepository}`;
      const imageTag = registryImageTag(session);
      const image = `${repository}:${imageTag}`;
      const dockerConfig = join(root, 'docker-config');
      await mkdir(dockerConfig, { mode: 0o700 });
      await this.localRegistryLogin(
        registry.credentialId,
        registry.registryUrl,
        dockerConfig,
        session,
      );
      await this.local(
        session,
        ['--config', dockerConfig, 'build', '--tag', image, '--file', dockerfile, buildContext],
        1200,
        'Docker 镜像构建失败。请检查 Dockerfile、基础镜像及依赖源的网络和权限',
      );
      const pushed = await this.local(
        session,
        ['--config', dockerConfig, 'push', image],
        1200,
        '镜像推送失败。请检查 Registry 的网络、认证和仓库写入权限',
      );
      const imageDigest = pushedImageDigest(pushed.stdout, imageTag);
      const localCompose = join(workspace, 'compose.yaml');
      await this.container(
        session,
        workspace,
        `set -eu; ${enterRepositoryDirectory('/workspace', d.repoPath)}; ${resolveRepositoryFile(d.composeFilePath)}; cp -- "$veyops_file" /workspace/compose.yaml`,
        undefined,
        undefined,
        process.env.BUILD_HELPER_IMAGE || 'node:22-bookworm',
      );
      if ((await lstat(localCompose)).isSymbolicLink()) throw new Error('拒绝符号链接Compose文件');
      return {
        imageReference: `${repository}@${imageDigest}`,
        imageTag,
        imageDigest,
        localCompose,
        cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  private async retainManagerArchive(archive: string, key: string, session: BuildSession) {
    const details = await lstat(archive);
    if (!details.isFile() || !details.size || details.size > maxArchiveBytes)
      throw new Error('构建产物不是普通文件、为空或超过1GiB限制');
    const checksum = await this.checksum(archive);
    if (session.context.signal.aborted) throw new ProcessExecutionError('构建已取消', 'CANCELLED');
    const directory = join(dataDirectory, 'artifacts');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, key);
    // Both paths are platform-owned within DATA_DIR. Publish the archive by atomic rename.
    await chmod(archive, 0o600);
    await rename(archive, path);
    return { path, checksum, sizeBytes: details.size };
  }
  private async configureWebhookDocker(session: BuildSession, root: string) {
    const socket = webhookBuildSocket();
    if (!socket) throw new Error('未配置 Webhook 专用 rootless Docker Socket');
    const owner = await lstat(socket).catch(() => null);
    if (!owner?.isSocket() || process.getuid?.() !== owner.uid || owner.uid === 0)
      throw new Error('Webhook Docker Socket 必须是构建用户拥有的非 root Unix Socket');
    const config = join(root, 'docker-config');
    await mkdir(config, { mode: 0o700 });
    session.webhookDocker = { socket, config };
    const result = await this.runDocker(session, ['info', '--format', '{{json .}}'], 15, {
      signal: session.context.signal,
    });
    if (result.exitCode !== 0) throw new Error('Webhook 专用 Docker 无法连接');
    const info = JSON.parse(result.stdout) as {
      SecurityOptions?: string[];
      CgroupVersion?: string;
      CgroupDriver?: string;
      MemoryLimit?: boolean;
      CpuCfsQuota?: boolean;
      PidsLimit?: boolean;
    };
    if (
      !info.SecurityOptions?.includes('name=rootless') ||
      info.CgroupVersion !== '2' ||
      info.CgroupDriver !== 'systemd' ||
      !info.MemoryLimit ||
      !info.CpuCfsQuota ||
      !info.PidsLimit
    )
      throw new Error('Webhook 专用 Docker 必须启用 rootless、cgroup v2 和 CPU/内存/PID 限制');
  }
  private async container(
    session: BuildSession,
    workspace: string,
    script: string,
    secretDir?: string,
    envFile?: string,
    image?: string,
    timeout = 1200,
    failureMessage = '管理端容器步骤失败。请检查镜像和步骤日志',
  ) {
    const name = `veyops-${session.taskId}-${Math.random().toString(16).slice(2, 10)}`;
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--user',
      session.webhookDocker ? '0:0' : `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=128',
      '--memory=1g',
      '--cpus=2',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=256m',
      '--env',
      'HOME=/tmp',
      '--env',
      'npm_config_cache=/tmp/npm',
      '--env',
      'XDG_CACHE_HOME=/tmp/cache',
      '--mount',
      `type=bind,src=${workspace},dst=/workspace`,
      '--workdir',
      '/workspace',
    ];
    if (secretDir) args.push('--mount', `type=bind,src=${secretDir},dst=/run/veyops,readonly`);
    if (envFile) args.push('--env-file', envFile);
    args.push(image ?? session.snapshot.definition.buildImage, 'sh', '-eu', '-c', script);
    try {
      await this.local(session, args, timeout, failureMessage);
    } finally {
      await this.runDocker(session, ['rm', '-f', name], 30).catch(() => undefined);
    }
  }
  private runDocker(
    session: BuildSession,
    args: string[],
    timeout: number,
    options: {
      signal?: AbortSignal;
      log?: boolean;
      stdin?: string;
      gzipOutput?: ProcessOptions['gzipOutput'];
    } = {},
  ) {
    const isolated = session.webhookDocker;
    const command = isolated
      ? ['--host', `unix://${isolated.socket}`, '--config', isolated.config, ...args]
      : args;
    return this.runner.run('docker', command, {
      timeout,
      signal: options.signal,
      isolatedDocker: Boolean(isolated),
      secrets: session.secrets,
      stdin: options.stdin,
      gzipOutput: options.gzipOutput,
      onData: options.log ? (text) => session.context.log(text) : undefined,
    });
  }
  private async local(
    session: BuildSession,
    args: string[],
    timeout: number,
    failureMessage = '管理端 Docker 步骤失败',
    stdin?: string,
  ) {
    const result = await this.runDocker(session, args, timeout, {
      signal: session.context.signal,
      log: true,
      stdin,
    });
    if (result.exitCode !== 0)
      throw new BuildCommandError(
        result.exitCode,
        `${failureMessage}（退出码 ${result.exitCode}）`,
      );
    return result;
  }
  async localRegistryLogin(
    credentialId: string | null,
    url: string,
    config: string,
    session: BuildSession,
  ) {
    if (!credentialId) return;
    const secret = await this.credentials.decrypt(credentialId);
    if (!secret.username || !secret.password)
      throw new Error('Registry凭据须包含username/password');
    session.secrets.push(...credentialSecrets(secret));
    await this.local(
      session,
      ['--config', config, 'login', url, '--username', secret.username, '--password-stdin'],
      60,
      'Registry 登录失败。请检查地址、网络及凭据',
      secret.password + '\n',
    );
  }
  async registrySecret(id: string, session: BuildSession) {
    const registry = session.snapshot.registry ?? (await this.registries.get(id));
    const secret = registry.credentialId
      ? await this.credentials.decrypt(registry.credentialId)
      : null;
    if (secret) {
      if (!secret.username || !secret.password)
        throw new Error('Registry凭据须包含username/password');
      session.secrets.push(...credentialSecrets(secret));
    }
    return { registry, secret };
  }
  async remoteRegistryLogin(target: SshTarget, work: string, session: BuildSession) {
    const { registry, secret } = await this.registrySecret(
      session.snapshot.definition.registryId!,
      session,
    );
    const config = work + '/docker-config';
    await this.remote(target, `umask 077; mkdir -p ${q(config)}`, session, 30);
    if (secret) {
      const path = work + '/registry-password';
      await this.ssh.uploadContent(target, secret.password + '\n', path, {
        timeout: 30,
        signal: session.context.signal,
        mode: 0o600,
      });
      try {
        await this.remote(
          target,
          `docker --config ${q(config)} login ${q(registry.registryUrl)} --username ${q(secret.username)} --password-stdin < ${q(path)}`,
          session,
          60,
          'Registry 登录失败。请检查地址、网络及凭据',
        );
      } finally {
        await this.ssh
          .execute(target, `rm -f -- ${q(path)}`, { timeout: 30 })
          .catch(() => undefined);
      }
    }
    return { registry, config };
  }
  private async checksum(path: string) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }
  errorKind(error: unknown) {
    return error instanceof SshExecutionError || error instanceof ProcessExecutionError
      ? error.kind
      : 'FAILED';
  }
}
