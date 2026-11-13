import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, relative } from 'node:path';
import { dataDirectory } from '../../core/config';
import { SshExecutionError, SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  ProcessExecutionError,
  ProcessRunnerService,
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
}
export const gitCredentialHelper = (responsePath: string) =>
  `!f() { case "$1" in get) cat -- ${q(responsePath)} ;; store|erase) : ;; *) return 1 ;; esac; }; f`;
export const checkoutScript = (
  url: string,
  commit: string,
  workspace: string,
  credentialResponse?: string,
) => {
  const options = ['-c core.hooksPath=/dev/null', '-c credential.helper='];
  if (credentialResponse)
    options.push(`-c credential.helper=${q(gitCredentialHelper(credentialResponse))}`);
  const git = `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git ${options.join(' ')}`;
  return `set -eu\n${git} clone --no-checkout -- ${q(url)} ${q(workspace + '/repo')}\ncd ${q(workspace + '/repo')}\nif ! ${git} cat-file -e ${q(commit + '^{commit}')} 2>/dev/null; then ${git} fetch origin ${q(commit)}; fi\n${git} checkout --detach ${q(commit)}\ntest "$(${git} rev-parse HEAD)" = ${q(commit)}\n`;
};
export const packScript = (work: string, repoPath: string, outputPath: string, archive: string) =>
  `set -eu\ncd ${q(work + '/repo/' + repoPath)}\noutput=$(realpath -- ${q(outputPath)})\ncase "$output" in ${q(work + '/repo/')}*) ;; *) echo '产物路径超出工作目录' >&2; exit 1;; esac\ntest -z "$(find "$output" -type l -print -quit)"\nif test -d "$output"; then tar -czf ${q(archive)} -C "$output" .; elif test -f "$output"; then tar -czf ${q(archive)} -C "$(dirname "$output")" "$(basename "$output")"; else echo '产物不存在或不是普通文件/目录' >&2; exit 1; fi\nprintf 'VEYOPS_ARTIFACT:%s:%s\\n' "$(sha256sum ${q(archive)} | cut -d' ' -f1)" "$(wc -c < ${q(archive)})"\n`;

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
  async remote(target: SshTarget, command: string, session: BuildSession, timeout = 900) {
    const result = await this.ssh.execute(target, command, {
      timeout,
      signal: session.context.signal,
      secrets: session.secrets,
      onData: (text) => session.context.log(text, target.id),
    });
    if (result.exitCode !== 0)
      throw new BuildCommandError(result.exitCode, `远程步骤退出码 ${result.exitCode}`);
  }
  async remoteCapture(target: SshTarget, command: string, session: BuildSession, timeout = 900) {
    let output = '';
    const result = await this.ssh.execute(target, command, {
      timeout,
      signal: session.context.signal,
      secrets: session.secrets,
      onData: (text) => {
        output += text;
        session.context.log(text, target.id);
      },
    });
    if (result.exitCode !== 0)
      throw new BuildCommandError(result.exitCode, `远程步骤退出码 ${result.exitCode}`);
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
      const commands = [
        { command: d.installCommand, timeout: 900 },
        { command: d.buildCommand, timeout: 900 },
        ...d.steps.map((step) => ({ command: step.command, timeout: step.timeout ?? 900 })),
      ].filter((step) => step.command);
      for (const step of commands)
        await this.remote(
          target,
          `set -eu; . ${q(envFile)}; cd ${q(work + '/repo/' + d.repoPath)}; ${step.command}`,
          session,
          step.timeout,
        );
    } finally {
      await this.ssh
        .execute(target, `rm -f -- ${q(envFile)}`, { timeout: 30 })
        .catch(() => undefined);
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
    const secret = await this.gitSecret(session.snapshot.repository.credentialId);
    if (secret) session.secrets.push(...secret.values);
    const d = session.snapshot.definition;
    try {
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
      const commands = [
        { command: d.installCommand, timeout: 900 },
        { command: d.buildCommand, timeout: 900 },
        ...d.steps.map((step) => ({ command: step.command, timeout: step.timeout ?? 900 })),
      ].filter((step) => step.command);
      for (const step of commands)
        await this.container(
          session,
          workspace,
          `set -eu\ncd ${q('/workspace/repo/' + d.repoPath)}\n${step.command}\n`,
          undefined,
          envPath,
          undefined,
          step.timeout,
        );
      await rm(envPath, { force: true });
      if (d.artifactType === 'FILE') {
        await this.container(
          session,
          workspace,
          packScript('/workspace', d.repoPath, d.outputPath, '/workspace/artifact.tar.gz'),
          undefined,
          undefined,
          process.env.BUILD_HELPER_IMAGE || 'node:22-bookworm',
        );
        const archive = join(workspace, 'artifact.tar.gz');
        if ((await lstat(archive)).isSymbolicLink()) throw new Error('拒绝读取符号链接产物');
        const sizeBytes = (await stat(archive)).size;
        if (sizeBytes > 1024 * 1024 * 1024) throw new Error('文件产物超过1GiB限制');
        const checksum = await this.checksum(archive);
        const destination = join(dataDirectory, 'artifacts', session.taskId + '.tar.gz');
        await mkdir(join(dataDirectory, 'artifacts'), { recursive: true });
        // Never execute or unpack the repository on the manager host.
        await copyFile(archive, destination);
        return { localArchive: destination, checksum, sizeBytes, cleanup };
      }
      const registry = await this.registries.get(d.registryId!);
      const image = `${registry.registryUrl}/${d.imageRepository}:${session.snapshot.commitSha}`;
      const dockerConfig = join(root, 'docker-config');
      await mkdir(dockerConfig, { mode: 0o700 });
      await this.localRegistryLogin(
        registry.credentialId,
        registry.registryUrl,
        dockerConfig,
        session,
      );
      const dockerfile = resolve(workspace, 'repo', d.repoPath, d.dockerfilePath),
        buildContext = resolve(workspace, 'repo', d.repoPath);
      const repoRoot = await realpath(join(workspace, 'repo'));
      for (const checked of [await realpath(dockerfile), await realpath(buildContext)])
        if (relative(repoRoot, checked).startsWith('..') || isAbsolute(relative(repoRoot, checked)))
          throw new Error('Docker构建路径超出仓库');
      await this.local(
        session,
        ['--config', dockerConfig, 'build', '--tag', image, '--file', dockerfile, buildContext],
        1200,
      );
      await this.local(session, ['--config', dockerConfig, 'push', image], 1200);
      const inspected = await this.local(
        session,
        ['--config', dockerConfig, 'image', 'inspect', '--format', '{{json .RepoDigests}}', image],
        30,
      );
      const refs = JSON.parse(inspected.stdout.trim()) as string[];
      const reference = refs.find((r) =>
        r.startsWith(`${registry.registryUrl}/${d.imageRepository}@sha256:`),
      );
      if (!reference) throw new Error('Registry推送后未获得不可变镜像Digest');
      const localCompose = join(workspace, 'compose.yaml');
      await this.container(
        session,
        workspace,
        `set -eu; cp -- ${q('/workspace/repo/' + d.repoPath + '/' + d.composeFilePath)} /workspace/compose.yaml`,
        undefined,
        undefined,
        process.env.BUILD_HELPER_IMAGE || 'node:22-bookworm',
      );
      if ((await lstat(localCompose)).isSymbolicLink()) throw new Error('拒绝符号链接Compose文件');
      return {
        imageReference: reference,
        imageDigest: reference.split('@')[1],
        localCompose,
        cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  private async container(
    session: BuildSession,
    workspace: string,
    script: string,
    secretDir?: string,
    envFile?: string,
    image?: string,
    timeout = 1200,
  ) {
    const name = `veyops-${session.taskId}-${Math.random().toString(16).slice(2, 10)}`;
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--user',
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
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
      await this.local(session, args, timeout);
    } finally {
      await this.runner.run('docker', ['rm', '-f', name], { timeout: 30 }).catch(() => undefined);
    }
  }
  async local(session: BuildSession, args: string[], timeout: number, stdin?: string) {
    const result = await this.runner.run('docker', args, {
      timeout,
      signal: session.context.signal,
      secrets: session.secrets,
      stdin,
      onData: (text) => session.context.log(text),
    });
    if (result.exitCode !== 0)
      throw new BuildCommandError(result.exitCode, `Docker步骤退出码 ${result.exitCode}`);
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
      secret.password + '\n',
    );
  }
  async registrySecret(id: string, session: BuildSession) {
    const registry = await this.registries.get(id);
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
