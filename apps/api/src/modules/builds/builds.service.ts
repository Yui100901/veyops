import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, posix, resolve, relative, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { dataDirectory } from '../../core/config';
import { SshExecutionError, SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  ProcessExecutionError,
  ProcessRunnerService,
  type ProcessOptions,
} from '../../infrastructure/build-runner/process-runner.service';
import { CredentialsService } from '../credentials/credentials.service';
import { maxComposeBytes } from '../artifacts/artifacts.service';
import { RegistriesService } from '../registries/registries.service';
import type { PipelineSnapshot, PipelineNode, BuildOutput } from '../pipelines/pipeline.types';
import { relativePath, shellQuote as q } from '../pipelines/pipeline.validation';
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
export type RunPipelineNode = <T>(node: PipelineNode, run: () => Promise<T>) => Promise<T>;

const maxEnvironmentFileBytes = 64 * 1024;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const helperImage = () => process.env.BUILD_HELPER_IMAGE || 'node:22-bookworm';

function exportedVariables(values: Record<string, string>) {
  return (
    Object.entries(values)
      .map(([key, value]) => `export ${key}=${q(value)}`)
      .join('\n') + '\n'
  );
}

async function readEnvironmentFile(file: string) {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.size > maxEnvironmentFileBytes) throw new Error();
    const bytes = await readFile(file);
    if (bytes.length > maxEnvironmentFileBytes || bytes.includes(0)) throw new Error();
    return Object.fromEntries(
      Object.entries(parseEnv(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    throw new Error('无法读取环境文件，请检查文件类型、UTF-8 格式和 64 KiB 大小限制');
  }
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
function gitCommand(credentialResponse?: string) {
  const options = [
    '-c core.hooksPath=/dev/null',
    '-c credential.helper=',
    '-c http.followRedirects=false',
  ];
  if (credentialResponse)
    options.push(`-c credential.helper=${q(gitCredentialHelper(credentialResponse))}`);
  return `GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git ${options.join(' ')}`;
}
export const checkoutScript = (
  url: string,
  commitSha: string,
  workspace: string,
  credentialResponse?: string,
) => nodeCheckoutScript({ url, commitSha }, workspace, '.', credentialResponse);
export function nodeCheckoutScript(
  source: { url: string; commitSha: string },
  workspace: string,
  directory: string,
  credentialResponse?: string,
) {
  const git = gitCommand(credentialResponse);
  const destination = posix.join('repo', relativePath(directory));
  const objectFormat = source.commitSha.length === 64 ? ' --object-format=sha256' : '';
  return `set -eu
command -v git >/dev/null || { echo '构建环境缺少 Git CLI' >&2; exit 127; }
cd -P ${q(workspace)}
destination=$PWD/${q(destination)}
test ! -e "$destination"; test ! -L "$destination"
test "$(realpath -m -- "$destination")" = "$destination"
mkdir -p -- "$destination"
cd -P "$destination"
${git} init -q${objectFormat}
${git} remote add origin ${q(source.url)}
${git} fetch --no-recurse-submodules --no-tags --depth=1 origin ${q(source.commitSha)}
${git} checkout --detach FETCH_HEAD
test "$(${git} rev-parse HEAD)" = ${q(source.commitSha)}
`;
}
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

const imageArchiveInspect = '{{.Id}} {{.Os}}/{{.Architecture}}';

function inspectedArchiveImage(output: string) {
  const match = /^(sha256:[a-f0-9]{64}) ([a-z0-9]+\/[a-z0-9]+)$/.exec(output.trim());
  if (!match) throw new Error('未读取到归档镜像的内容 ID 和平台');
  return { archiveImageId: match[1]!, archiveImagePlatform: match[2]! };
}

async function readComposeSnapshot(path: string) {
  const stats = await lstat(path).catch(() => null);
  if (!stats?.isFile() || stats.size < 1 || stats.size > maxComposeBytes)
    throw new Error('Compose 配置不是可归档的普通文件，或超过 256 KiB 限制');
  const bytes = await readFile(path).catch(() => null);
  if (!bytes || bytes.length > maxComposeBytes)
    throw new Error('无法读取符合归档要求的 Compose 配置');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.trim() || text.includes('\0')) throw new Error('Compose 配置为空或不符合归档要求');
  return text;
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
    const values: Record<string, string> = Object.assign(Object.create(null), snapshot.variables);
    const secrets: string[] = [];
    for (const [name, id] of Object.entries(snapshot.secretVariables)) {
      values[name] = await this.resolveVariableCredential(name, id, secrets);
    }
    if (snapshot.projectName !== undefined) values.VEYOPS_PROJECT_NAME = snapshot.projectName;
    if (snapshot.serviceName !== undefined) values.VEYOPS_SERVICE_NAME = snapshot.serviceName;
    if (Object.keys(values).some((key) => !envName.test(key))) throw new Error('无效环境变量名');
    return { values, secrets };
  }
  private async resolveVariableCredential(name: string, id: string, secrets: string[]) {
    const credential = await this.credentials.decrypt(id);
    const value =
      credential.value ??
      credential.secret ??
      credential.password ??
      credential.apiKey ??
      credential.token;
    if (value === undefined || value.includes('\0'))
      throw new Error(`敏感变量 ${name} 的凭据不含支持的值`);
    secrets.push(...credentialSecrets(credential));
    return value;
  }

  private nodeSource(snapshot: PipelineSnapshot, node: PipelineNode) {
    const source = snapshot.nodeSources?.[node.id];
    if (!source || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commitSha))
      throw new Error('源码节点缺少固定提交');
    return source;
  }

  private async buildNodes(
    session: BuildSession,
    runNode: RunPipelineNode,
    execute: {
      checkout: (node: PipelineNode, session: BuildSession) => Promise<void>;
      environment: (
        node: PipelineNode,
        directory: string,
        session: BuildSession,
      ) => Promise<Record<string, string>>;
      command: (node: PipelineNode, directory: string, session: BuildSession) => Promise<void>;
    },
  ) {
    const definition = session.snapshot.definition;
    const scoped = {
      ...session,
      variables: Object.assign(Object.create(null), session.variables) as Record<string, string>,
      secrets: [...session.secrets],
    };
    const credentialKeys = new Set(Object.keys(session.snapshot.secretVariables));
    let checkoutComplete = false;
    for (const node of definition.nodes ?? []) {
      if (node.type === 'PACKAGE' || node.type === 'DEPLOY') break;
      const directory = relativePath(node.directory ?? definition.repoPath);
      await runNode(node, async () => {
        if (node.type === 'CHECKOUT') {
          if (checkoutComplete) throw new Error('源码节点须位于所有环境和命令节点之前');
          await execute.checkout(node, scoped);
          return;
        }
        checkoutComplete = true;
        if (node.type !== 'ENVIRONMENT') {
          await execute.command(node, directory, scoped);
          return;
        }
        if (node.envFile) {
          const values = await execute.environment(node, directory, scoped);
          scoped.secrets.push(...Object.values(values));
          for (const [key, value] of Object.entries(values)) {
            if (
              envName.test(key) &&
              !/^VEYOPS_/i.test(key) &&
              !Object.hasOwn(scoped.variables, key)
            ) {
              scoped.variables[key] = value;
            }
          }
        }
        for (const { key, value, credentialId } of node.variables ?? []) {
          if (!envName.test(key) || /^VEYOPS_/i.test(key) || credentialKeys.has(key))
            throw new Error(`环境节点不能覆盖保留变量或敏感变量 ${key}`);
          if (credentialId) {
            scoped.variables[key] = await this.resolveVariableCredential(
              key,
              credentialId,
              scoped.secrets,
            );
            credentialKeys.add(key);
          } else if (value === undefined || value.includes('\0'))
            throw new Error(`无效变量值 ${key}`);
          else scoped.variables[key] = value;
        }
      });
    }
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
  async remoteCheckout(
    target: SshTarget,
    work: string,
    session: BuildSession,
    node?: PipelineNode,
  ) {
    const source = node ? this.nodeSource(session.snapshot, node) : undefined;
    const secret = await this.gitSecret(
      source ? source.credentialId : session.snapshot.repository.credentialId,
    );
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
        source && node
          ? nodeCheckoutScript(source, work, node.directory ?? '.', secret ? response : undefined)
          : checkoutScript(
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
  async remoteNodes(
    target: SshTarget,
    work: string,
    session: BuildSession,
    runNode: RunPipelineNode,
  ) {
    await this.buildNodes(session, runNode, {
      checkout: (node, scoped) => this.remoteCheckout(target, work, scoped, node),
      environment: async (node, directory, scoped) => {
        const name = `env-node-${randomUUID()}`;
        const remoteCopy = `${work}/${name}`;
        const local = await mkdtemp(join(tmpdir(), 'veyops-build-env-'));
        const localCopy = join(local, name);
        try {
          await this.remote(
            target,
            `set -eu; umask 077; ${enterRepositoryDirectory(work, directory)}; ${resolveRepositoryFile(relativePath(node.envFile!))}; test ! -e ${q(remoteCopy)}; test ! -L ${q(remoteCopy)}; head -c ${maxEnvironmentFileBytes + 1} -- "$veyops_file" > ${q(remoteCopy)}`,
            scoped,
            30,
            '无法读取仓库内的环境文件',
          );
          await this.ssh.download(target, remoteCopy, localCopy, {
            timeout: 30,
            signal: scoped.context.signal,
          });
          return await readEnvironmentFile(localCopy);
        } finally {
          await this.ssh
            .execute(target, `rm -f -- ${q(remoteCopy)}`, { timeout: 30 })
            .catch(() => undefined);
          await rm(local, { recursive: true, force: true });
        }
      },
      command: async (node, directory, scoped) => {
        const envFile = `${work}/build-node-${randomUUID()}.env`;
        try {
          await this.ssh.uploadContent(target, exportedVariables(scoped.variables), envFile, {
            timeout: 30,
            signal: scoped.context.signal,
            mode: 0o600,
          });
          await this.remote(
            target,
            `set -eu; ${enterRepositoryDirectory(work, directory)}; . ${q(envFile)}\n${node.command ?? ''}`,
            scoped,
            node.timeout ?? 900,
            `${node.name}失败。请核对步骤日志和构建工具`,
          );
        } finally {
          await this.ssh
            .execute(target, `rm -f -- ${q(envFile)}`, { timeout: 30 })
            .catch(() => undefined);
        }
      },
    });
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
    return {
      imageReference,
      imageId,
      ...(await this.retainRemoteImageArchive(target, work, session, 'docker', imageReference)),
    };
  }

  async archivePushedTargetImage(
    target: SshTarget,
    work: string,
    session: BuildSession,
    dockerConfig: string,
    imageReference: string,
  ) {
    const docker = `docker --config ${q(dockerConfig)}`;
    const inspection = await this.remoteCapture(
      target,
      `${docker} image inspect --format ${q(imageArchiveInspect)} ${q(imageReference)}`,
      session,
      30,
    );
    return {
      ...inspectedArchiveImage(inspection),
      ...(await this.retainRemoteImageArchive(target, work, session, docker, imageReference)),
    };
  }

  private async retainRemoteImageArchive(
    target: SshTarget,
    work: string,
    session: BuildSession,
    docker: string,
    imageReference: string,
  ) {
    const archive = work + '/image.tar.gz';
    const save = `ulimit -f ${maxArchiveBytes / 1024}; ${docker} image save ${q(imageReference)} | gzip -1 > ${q(archive)}`;
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
    return { archiveKey: basename(storagePath), ...metadata };
  }
  async remoteComposeSnapshot(target: SshTarget, work: string, session: BuildSession) {
    const d = session.snapshot.definition;
    const path = work + '/compose.snapshot.yaml';
    try {
      await this.remote(
        target,
        `set -eu; ${enterRepositoryDirectory(work, d.repoPath)};
candidate=${q('./' + d.composeFilePath)}
if ! test -e "$candidate" && ! test -L "$candidate"; then exit 44; fi
${resolveRepositoryFile(d.composeFilePath)}
test -s "$veyops_file"; test "$(wc -c < "$veyops_file")" -le ${maxComposeBytes}
umask 077; test ! -e ${q(path)}; test ! -L ${q(path)}; cp -- "$veyops_file" ${q(path)}`,
        session,
        30,
        'Compose 配置归档失败。请检查文件路径、权限和大小',
      );
    } catch (error) {
      if (
        error instanceof BuildCommandError &&
        error.exitCode === 44 &&
        !session.snapshot.deployAfterBuild
      )
        return;
      throw error;
    }
    const directory = await mkdtemp(join(tmpdir(), 'veyops-compose-'));
    const local = join(directory, 'compose.yaml');
    try {
      await this.ssh.download(target, path, local, { timeout: 30, signal: session.context.signal });
      return await readComposeSnapshot(local);
    } finally {
      await rm(local, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
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
  private async managerNodes(
    session: BuildSession,
    workspace: string,
    secretDir: string,
    runNode: RunPipelineNode,
  ) {
    await this.buildNodes(session, runNode, {
      checkout: async (node, scoped) => {
        const source = this.nodeSource(session.snapshot, node);
        const secret = await this.gitSecret(source.credentialId);
        if (secret) scoped.secrets.push(...secret.values);
        try {
          if (secret) {
            await mkdir(secretDir, { recursive: true, mode: 0o700 });
            await writeFile(join(secretDir, 'git-credentials'), secret.response, { mode: 0o600 });
          }
          await this.container(
            scoped,
            workspace,
            nodeCheckoutScript(
              source,
              '/workspace',
              node.directory ?? '.',
              secret ? '/run/veyops/git-credentials' : undefined,
            ),
            secret ? secretDir : undefined,
            undefined,
            helperImage(),
            300,
            '管理端检出失败，请检查 Git、仓库网络、凭据和固定提交',
          );
        } finally {
          await rm(secretDir, { recursive: true, force: true });
        }
      },
      environment: async (node, directory) => {
        const repo = join(await realpath(workspace), 'repo');
        if (repo !== (await realpath(repo))) throw new Error('环境文件必须位于仓库内');
        const candidate = resolve(repo, directory, relativePath(node.envFile!));
        const file = await realpath(candidate).catch(() => undefined);
        const path = file && relative(repo, file);
        if (!file || !path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
          throw new Error('环境文件不可读取或位于仓库外');
        return readEnvironmentFile(file);
      },
      command: async (node, directory, scoped) => {
        try {
          await mkdir(secretDir, { recursive: true, mode: 0o700 });
          await writeFile(join(secretDir, 'build.env'), exportedVariables(scoped.variables), {
            mode: 0o600,
          });
          await this.container(
            scoped,
            workspace,
            `set -eu\n${enterRepositoryDirectory('/workspace', directory)}\n. /run/veyops/build.env\n${node.command ?? ''}\n`,
            secretDir,
            undefined,
            undefined,
            node.timeout ?? 900,
            `${node.name}失败。请核对步骤日志和构建镜像`,
          );
        } finally {
          await rm(secretDir, { recursive: true, force: true });
        }
      },
    });
  }

  async manager(
    session: BuildSession,
    runNode: RunPipelineNode = async (_node, run) => run(),
    onPackage?: (output: BuildOutput) => Promise<void>,
  ): Promise<BuildOutput> {
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
      if (session.snapshot.triggerType && session.snapshot.triggerType !== 'MANUAL')
        await this.configureWebhookDocker(session, root);
      else
        await this.local(
          session,
          ['info', '--format', '{{.ServerVersion}}'],
          15,
          '管理端 Docker 守护进程不可用。请检查 Docker 服务和平台进程的访问权限',
        );
      if (d.nodes) await this.managerNodes(session, workspace, secretDir, runNode);
      else {
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
      }
      const packageNode = d.nodes?.find((node) => node.type === 'PACKAGE');
      return packageNode
        ? await runNode(packageNode, async () => {
            const output = await this.managerPackage(session, root, workspace, cleanup);
            await onPackage?.(output);
            return output;
          })
        : await this.managerPackage(session, root, workspace, cleanup);
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  private async managerPackage(
    session: BuildSession,
    root: string,
    workspace: string,
    cleanup: () => Promise<void>,
  ): Promise<BuildOutput> {
    const d = session.snapshot.definition;
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
      const stored = await this.retainManagerArchive(archive, `${session.taskId}.tar.gz`, session);
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
    const buildOnly = session.snapshot.mode === 'BUILD_ONLY';
    let composeYaml: string | undefined;
    if (buildOnly) {
      const composePath = await realpath(resolve(buildContext, d.composeFilePath)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' && !session.snapshot.deployAfterBuild) return undefined;
          throw new Error('无法读取 Compose 配置，请确认配置文件位于仓库内');
        },
      );
      if (composePath) {
        const pathInRepo = relative(repoRoot, composePath);
        if (pathInRepo === '..' || pathInRepo.startsWith(`..${sep}`) || isAbsolute(pathInRepo))
          throw new Error('Compose 配置路径超出仓库');
        composeYaml = await readComposeSnapshot(composePath);
      }
    }
    if (buildOnly && !(session.snapshot.deployAfterBuild && d.registryId && d.imageRepository)) {
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
      return {
        imageReference,
        imageId,
        ...(await this.retainManagerImageArchive(session, root, imageReference)),
        composeYaml,
        cleanup,
      };
    }
    const registry = session.snapshot.registry ?? (await this.registries.get(d.registryId!));
    const repository = `${registry.registryUrl}/${d.imageRepository}`;
    const imageTag = registryImageTag(session);
    const image = `${repository}:${imageTag}`;
    const dockerConfig = session.webhookDocker?.config ?? join(root, 'docker-config');
    if (!session.webhookDocker) await mkdir(dockerConfig, { mode: 0o700 });
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
    const offline = session.snapshot.releasePolicy?.archivePushedImage
      ? await this.archivePushedManagerImage(session, root, dockerConfig, image)
      : undefined;
    if (buildOnly) {
      return {
        ...offline,
        imageReference: `${repository}@${imageDigest}`,
        imageTag,
        imageDigest,
        composeYaml,
        cleanup,
      };
    }
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
      ...offline,
      imageReference: `${repository}@${imageDigest}`,
      imageTag,
      imageDigest,
      localCompose,
      cleanup,
    };
  }
  private async archivePushedManagerImage(
    session: BuildSession,
    root: string,
    dockerConfig: string,
    image: string,
  ) {
    const inspection = await this.local(
      session,
      ['--config', dockerConfig, 'image', 'inspect', '--format', imageArchiveInspect, image],
      30,
    );
    return {
      ...inspectedArchiveImage(inspection.stdout),
      ...(await this.retainManagerImageArchive(session, root, image, dockerConfig)),
    };
  }

  private async retainManagerImageArchive(
    session: BuildSession,
    root: string,
    image: string,
    dockerConfig?: string,
  ) {
    const archive = join(root, 'image.tar.gz');
    const options = dockerConfig ? ['--config', dockerConfig] : [];
    const exported = await this.runDocker(session, [...options, 'image', 'save', image], 600, {
      signal: session.context.signal,
      log: true,
      gzipOutput: { path: archive, maxBytes: maxArchiveBytes },
    });
    if (exported.exitCode !== 0)
      throw new BuildCommandError(exported.exitCode, 'Docker镜像导出失败');
    const archiveKey = `${session.taskId}.tar.gz`;
    const { checksum, sizeBytes } = await this.retainManagerArchive(archive, archiveKey, session);
    return { archiveKey, checksum, sizeBytes };
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
