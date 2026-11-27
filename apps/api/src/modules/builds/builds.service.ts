import { ConflictException, Injectable, Optional } from '@nestjs/common';
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
import { ArtifactPhysicalService } from '../artifacts/artifact-physical.service';
import { artifactIdentity } from '../artifacts/artifact-identities';
import { graphUnscopedArtifactService } from '../pipelines/delivery-execution-profile';
import { RegistriesService } from '../registries/registries.service';
import { gitCredentialHelper } from '../projects/git-credential';
import {
  RepositoryMetadataService,
  type GraphCheckoutSnapshot,
} from '../projects/repository-metadata.service';
import type {
  PipelineSnapshot,
  PipelineNode,
  BuildOutput,
  NamedArtifactDefinition,
} from '../pipelines/pipeline.types';
import {
  normalizeRelativePath,
  relativePath,
  shellQuote as q,
} from '../pipelines/pipeline.validation';
import type { TaskExecutionContext } from '../tasks/tasks.types';
import {
  copyGraphDependencies,
  copyGraphRepository,
  graphTriggerVariables,
  graphWorkspaceEntry,
  openGraphWorkspace,
  type GraphWorkspaceRef,
} from '../execution-graphs/graph-workspace';
import {
  credentialSecrets,
  executionVariableName as envName,
  resolveExecutionVariables,
  resolveVariableCredential,
} from '../../infrastructure/execution-variables';

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
type DockerSession = Pick<BuildSession, 'taskId' | 'context' | 'secrets' | 'webhookDocker'>;
type ContainerSession = DockerSession & { snapshot: { definition: { buildImage: string } } };
export type RunPipelineNode = <T>(node: PipelineNode, run: () => Promise<T>) => Promise<T>;

export function namedArtifactSession(
  session: BuildSession,
  artifact: NamedArtifactDefinition,
): BuildSession {
  const definition = session.snapshot.definition;
  if (
    session.snapshot.graph &&
    artifact.collection !== 'WORK_DIRECTORY' &&
    artifact.type !== 'DOCKER_IMAGE' &&
    !artifact.path?.trim()
  )
    throw new Error(`请填写「${artifact.name}」的构建工作目录相对路径`);
  return {
    ...session,
    taskId: session.snapshot.graph
      ? artifactIdentity(session.snapshot, artifact.name).instanceId
      : randomUUID(),
    snapshot: {
      ...session.snapshot,
      definition: {
        ...definition,
        artifactType: artifact.type === 'DOCKER_IMAGE' ? 'DOCKER_IMAGE' : 'FILE',
        outputPath: artifact.path ?? definition.outputPath,
        dockerfilePath:
          artifact.type === 'DOCKER_IMAGE'
            ? (artifact.path ?? definition.dockerfilePath)
            : definition.dockerfilePath,
        composeFilePath: artifact.composeFilePath ?? definition.composeFilePath,
      },
    },
  };
}

const maxEnvironmentFileBytes = 64 * 1024;
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

export { gitCredentialHelper } from '../projects/git-credential';
function gitCommand(credentialResponse?: string, restricted = false) {
  const options = [
    '-c core.hooksPath=/dev/null',
    '-c credential.helper=',
    '-c http.followRedirects=false',
  ];
  if (restricted) {
    options.push(
      '-c protocol.allow=never',
      '-c protocol.http.allow=always',
      '-c protocol.https.allow=always',
      '-c http.lowSpeedLimit=1',
      '-c http.lowSpeedTime=15',
    );
  }
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
  source: { url: string; commitSha: string; fullClone?: boolean },
  workspace: string,
  directory: string,
  credentialResponse?: string,
  reportCheckout = false,
) {
  const git = gitCommand(credentialResponse, reportCheckout);
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
${git} fetch --no-recurse-submodules --no-tags${source.fullClone ? '' : ' --depth=1'} origin ${q(source.commitSha)}
${git} checkout --detach FETCH_HEAD
test "$(${git} rev-parse HEAD)" = ${q(source.commitSha)}
${reportCheckout ? `printf 'VEYOPS_FLOW_GIT=%s:%s\\n' ${q(source.commitSha)} "$(${git} rev-parse --is-shallow-repository)"` : ''}
`;
}
export const packScript = (
  work: string,
  repoPath: string,
  outputPath: string,
  archive: string,
  type?: 'FILE' | 'DIRECTORY',
) =>
  `set -eu\n${enterRepositoryDirectory(work, repoPath)}\nrequested=${q('./' + relativePath(outputPath))}\nif ! test -e "$requested" && ! test -L "$requested"; then exit 44; fi\ntest ! -L "$requested"\noutput=$(realpath -- "$requested")\ncase "$output" in "$veyops_repo"/*) ;; *) echo '产物路径超出工作目录' >&2; exit 1;; esac\n${type === 'FILE' ? 'test -f "$output"' : type === 'DIRECTORY' ? 'test -d "$output"' : ':'}\ntest -z "$(find "$output" ! -type f ! -type d -print -quit)"\nif test -d "$output"; then tar -czf ${q(archive)} -C "$output" .; elif test -f "$output"; then tar -czf ${q(archive)} -C "$(dirname "$output")" "$(basename "$output")"; else echo '产物不是普通文件/目录' >&2; exit 1; fi\nprintf 'VEYOPS_ARTIFACT:%s:%s\\n' "$(sha256sum ${q(archive)} | cut -d' ' -f1)" "$(wc -c < ${q(archive)})"\n`;

export function enterRepositoryDirectory(work: string, repoPath: string) {
  const directory = posix.normalize(relativePath(repoPath || '.')).replace(/\/$/, '');
  return [
    `cd -P -- ${q(work)} || exit 45`,
    'veyops_repo=$PWD/repo',
    `veyops_directory="$veyops_repo"${directory === '.' ? '' : '/' + q(directory)}`,
    'if ! cd -P -- "$veyops_directory" || ! test "$PWD" = "$veyops_directory"; then',
    '  echo "工作目录不存在、不可访问或包含符号链接" >&2; exit 45',
    'fi',
  ].join('\n');
}

export function enterSourceDirectory(root: string, directory: string) {
  const normalized = posix.normalize(relativePath(directory || '.')).replace(/\/$/, '');
  const source = q(root);
  return [
    `cd -P -- ${source} && test "$PWD" = ${source} || exit 45`,
    `if ! cd -P -- ${q('./' + normalized)} || ! test "$PWD" = ${q(posix.join(root, normalized))}; then`,
    '  echo "工作目录不存在、不可访问或包含符号链接" >&2; exit 45',
    'fi',
  ].join('\n');
}

export function resolveRepositoryFile(path: string) {
  return `veyops_file=$(realpath -- ${q('./' + path)}); case "$veyops_file" in "$veyops_repo"/*) test -f "$veyops_file" ;; *) echo '构建配置文件超出仓库' >&2; exit 1 ;; esac`;
}

const maxArchiveBytes = 1024 * 1024 * 1024;

export function checkedImageReference(ref: string) {
  if (!/^[a-z0-9][a-zA-Z0-9._:/-]{0,350}(?:@sha256:[0-9a-f]{64})?$/.test(ref))
    throw new Error('无效的镜像来源地址');
  return ref;
}

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
  static async automaticManagerSocket(probe = true) {
    const socket = webhookBuildSocket();
    if (!socket) throw new ConflictException('请先配置自动执行专用 rootless Docker Socket');
    const owner = await lstat(socket).catch(() => null);
    if (!owner?.isSocket() || process.getuid?.() !== owner.uid || owner.uid === 0)
      throw new ConflictException('自动执行 Docker Socket 必须是构建用户拥有的非 root Unix Socket');
    if (probe) {
      const result = await new ProcessRunnerService()
        .run('docker', ['--host', `unix://${socket}`, 'info', '--format', '{{json .}}'], {
          timeout: 10,
          isolatedDocker: true,
        })
        .catch(() => undefined);
      if (result?.exitCode !== 0) throw new ConflictException('自动执行专用 Docker 无法连接');
      BuildsService.assertAutomaticDockerInfo(result.stdout);
    }
    return socket;
  }

  private static assertAutomaticDockerInfo(stdout: string) {
    let info:
      | {
          SecurityOptions?: string[];
          CgroupVersion?: string;
          CgroupDriver?: string;
          MemoryLimit?: boolean;
          CpuCfsQuota?: boolean;
          PidsLimit?: boolean;
        }
      | undefined;
    try {
      info = JSON.parse(stdout) ?? undefined;
    } catch {
      throw new ConflictException('无法读取自动执行专用 Docker 的隔离能力');
    }
    if (
      !Array.isArray(info?.SecurityOptions) ||
      !info.SecurityOptions.includes('name=rootless') ||
      info.CgroupVersion !== '2' ||
      info.CgroupDriver !== 'systemd' ||
      !info.MemoryLimit ||
      !info.CpuCfsQuota ||
      !info.PidsLimit
    )
      throw new ConflictException(
        '自动执行专用 Docker 必须启用 rootless、cgroup v2 和 CPU/内存/PID 限制',
      );
  }
  constructor(
    private readonly ssh: SshService,
    private readonly runner: ProcessRunnerService,
    private readonly credentials: CredentialsService,
    private readonly registries: RegistriesService,
    @Optional() private readonly repositories?: RepositoryMetadataService,
    @Optional() private readonly physical?: ArtifactPhysicalService,
  ) {}
  async gitSecret(credentialId: string | null): Promise<GitSecret | undefined> {
    if (!credentialId) return undefined;
    const s = await this.credentials.decrypt(credentialId);
    if (s.privateKey)
      throw new Error('Pipeline Git checkout暂不支持SSH私钥；请改用HTTPS Token凭据');
    const username = s.username || 'oauth2',
      password = s.token || s.password;
    if (!password || /[\r\n\0]/.test(username + password))
      throw new Error('Git凭据须包含单行token或用户名密码');
    return {
      response: `username=${username}\npassword=${password}\n`,
      values: credentialSecrets(s),
    };
  }

  async prepareFlowTargetCheckout(
    projectId: string,
    source: GraphCheckoutSnapshot,
    staging: string,
  ) {
    if (!this.repositories) throw new ConflictException('仓库读取服务不可用');
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commitSha))
      throw new ConflictException('确认的源码提交无效');
    const repository = await this.repositories.requireRepositoryAccess(
      projectId,
      source.repositoryId,
      source.access,
    );
    const secret = await this.gitSecret(repository.credential_id);
    const credential = secret ? { ...secret, path: staging + '/git-credentials' } : undefined;
    return {
      command: nodeCheckoutScript(
        { url: repository.url, commitSha: source.commitSha, fullClone: source.fullClone },
        staging,
        '.',
        credential?.path,
        true,
      ),
      credential,
    };
  }
  async resolveVariables(snapshot: PipelineSnapshot) {
    const { values, secrets } = await resolveExecutionVariables(this.credentials, snapshot);
    values.VEYOPS_PROJECT_ID = snapshot.projectId;
    if (snapshot.serviceId !== graphUnscopedArtifactService(snapshot.projectId).id)
      values.VEYOPS_SERVICE_ID = snapshot.serviceId;
    if (snapshot.projectName !== undefined) values.VEYOPS_PROJECT_NAME = snapshot.projectName;
    if (snapshot.serviceName !== undefined) values.VEYOPS_SERVICE_NAME = snapshot.serviceName;
    if (snapshot.graphReleaseEnvironmentFile) {
      if (!this.repositories) throw new ConflictException('仓库环境文件读取服务不可用');
      const loaded = await this.repositories.readGraphEnvironmentFile(
        snapshot.projectId,
        snapshot.graphReleaseEnvironmentFile,
      );
      for (const [name, value] of Object.entries(loaded)) {
        if (/^VEYOPS_/i.test(name)) continue;
        secrets.push(value);
        if (!Object.hasOwn(values, name)) values[name] = value;
      }
    }
    if (snapshot.graph) {
      const { variables, trigger } = snapshot.graph;
      let loaded: Record<string, string> | undefined;
      if (variables?.environmentFile?.status === 'PINNED') {
        if (!this.repositories) throw new Error('仓库环境文件读取服务不可用');
        loaded = await this.repositories.readGraphEnvironmentFile(
          snapshot.projectId,
          variables.environmentFile,
        );
      } else if (!variables?.environmentFile && variables?.workspace && variables.envFile) {
        const file = await graphWorkspaceEntry(
          variables.workspace,
          relativePath(variables.envFile),
        );
        loaded = await readEnvironmentFile(file);
      }
      if (loaded) {
        for (const [name, value] of Object.entries(loaded)) {
          if (/^VEYOPS_/i.test(name)) continue;
          secrets.push(value);
          if (!Object.hasOwn(values, name)) values[name] = value;
        }
      }
      Object.assign(values, graphTriggerVariables(trigger), {
        VEYOPS_GIT_COMMIT_SHA: snapshot.commitSha,
      });
    }
    return { values, secrets };
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
            scoped.variables[key] = await resolveVariableCredential(
              this.credentials,
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
    const result = await this.ssh.execute(target, command, {
      timeout,
      signal: session.context.signal,
      secrets: session.secrets,
      captureStdout: true,
      onData: (text) => session.context.log(text, target.id),
    });
    if (result.exitCode !== 0)
      throw new BuildCommandError(
        result.exitCode,
        `${failureMessage}（退出码 ${result.exitCode}）`,
      );
    if (result.stdout === undefined) throw new Error('未收到 SSH 校验输出');
    return result.stdout;
  }
  async remoteCheckout(
    target: SshTarget,
    work: string,
    session: BuildSession,
    node?: PipelineNode,
  ) {
    if (session.snapshot.graph?.workspace) {
      const { workspace, dependencies } = session.snapshot.graph;
      return this.transferGraphWorkspace(target, work, session, workspace, dependencies);
    }
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

  async transferGraphWorkspace(
    target: SshTarget,
    work: string,
    session: BuildSession,
    workspace: GraphWorkspaceRef,
    dependencies?: Record<string, GraphWorkspaceRef>,
  ) {
    const directory = await openGraphWorkspace(workspace);
    const temporary = await mkdtemp(join(tmpdir(), 'veyops-workspace-'));
    try {
      const archive = join(temporary, 'checkout.tar.gz');
      if (dependencies) {
        await copyGraphRepository(workspace, join(temporary, 'repo'));
        await copyGraphDependencies(dependencies, join(temporary, 'dependencies'));
      }
      const packaged = await this.runner.run(
        'tar',
        [
          '-czf',
          archive,
          '-C',
          dependencies ? temporary : directory,
          'repo',
          ...(dependencies ? ['dependencies'] : []),
        ],
        { timeout: 300, signal: session.context.signal },
      );
      const details = await lstat(archive).catch(() => undefined);
      if (packaged.exitCode !== 0 || !details?.isFile() || details.size > maxArchiveBytes)
        throw new Error('工作区打包失败或超过 1GiB');
      const remoteArchive = work + '/checkout.tar.gz';
      await this.ssh.upload(target, archive, remoteArchive, {
        timeout: 300,
        signal: session.context.signal,
      });
      await this.remote(
        target,
        `set -eu; tar -xzf ${q(remoteArchive)} --no-same-owner --no-same-permissions -C ${q(work)}; rm -- ${q(remoteArchive)}`,
        session,
        300,
        '目标无法解包绑定工作区',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
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
    const env = Object.entries({
      ...session.variables,
      ...(session.snapshot.graph?.dependencies && {
        VEYOPS_GRAPH_DEPENDENCY_ROOT: work + '/dependencies',
      }),
    })
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

  async remoteBuildOnlyImage(
    target: SshTarget,
    work: string,
    session: BuildSession,
    declaration?: NamedArtifactDefinition,
  ) {
    const definition = session.snapshot.definition;
    const imageReference = localImageTag(session, target.id);
    const source = declaration?.imageReference && checkedImageReference(declaration.imageReference);
    await this.remote(
      target,
      source
        ? `set -eu; ${source.includes('@sha256:') ? `docker image inspect ${q(source)} >/dev/null 2>&1 || docker pull ${q(source)};` : ''} docker image tag ${q(source)} ${q(imageReference)}`
        : `set -eu; ${enterRepositoryDirectory(work, definition.repoPath)}; ${declaration?.required === false ? `if ! test -e ${q('./' + definition.dockerfilePath)} && ! test -L ${q('./' + definition.dockerfilePath)}; then exit 44; fi;` : ''} ${resolveRepositoryFile(definition.dockerfilePath)}; DOCKER_BUILDKIT=1 docker build -f "$veyops_file" -t ${q(imageReference)} .`,
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
    if (session.snapshot.graph && this.physical) {
      return {
        imageReference,
        imageId,
        physical: await this.physical.describeImage({
          target,
          reference: imageReference,
          owner: source ? 'EXTERNAL' : 'MANAGED',
          signal: session.context.signal,
        }),
      };
    }
    return {
      imageReference,
      imageId,
      ...(await this.retainRemoteImageArchive(
        target,
        work,
        session,
        'docker',
        imageReference,
        Boolean(declaration),
      )),
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
    named = false,
  ) {
    const archive = work + (named ? `/image-${session.taskId}.tar.gz` : '/image.tar.gz');
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
  async remoteComposeSnapshot(
    target: SshTarget,
    work: string,
    session: BuildSession,
    source?: { root: string; directory: string; path: string },
  ) {
    const d = session.snapshot.definition;
    const root = source?.root ?? work + '/repo';
    const directory = relativePath(source?.directory ?? d.repoPath);
    const file = relativePath(source?.path ?? d.composeFilePath);
    const path = work + '/compose-' + randomUUID() + '.snapshot.yaml';
    const localDirectory = await mkdtemp(join(tmpdir(), 'veyops-compose-'));
    const local = join(localDirectory, 'compose.yaml');
    try {
      await this.remote(
        target,
        `set -eu
${enterSourceDirectory(root, directory)}
candidate=${q('./' + file)}
if ! test -e "$candidate" && ! test -L "$candidate"; then exit 44; fi
veyops_file=$(realpath -- "$candidate") || exit 45
case "$veyops_file" in ${q(root)}/*) ;; *) exit 45 ;; esac
test -f "$veyops_file" && test -r "$veyops_file" || exit 46
test -s "$veyops_file" && test "$(wc -c < "$veyops_file")" -le ${maxComposeBytes} || exit 47
test "$(cd -P -- ${q(work)} && pwd -P)" = ${q(work)} || exit 45
umask 077; set -C; cat -- "$veyops_file" > ${q(path)}
test -s ${q(path)} && test "$(wc -c < ${q(path)})" -le ${maxComposeBytes} || exit 47`,
        session,
        30,
        'Compose 配置归档失败。请检查文件路径、权限和大小',
      );
      await this.ssh.download(target, path, local, { timeout: 30, signal: session.context.signal });
      return await readComposeSnapshot(local);
    } catch (error) {
      if (error instanceof BuildCommandError) {
        if (
          error.exitCode === 44 &&
          !source &&
          (!session.snapshot.deployAfterBuild || session.snapshot.managedCompose)
        )
          return;
        const reasons: Record<number, string> = {
          44: '找不到 Compose 文件',
          45: '工作目录或 Compose 文件路径无效，或超出工作区',
          46: 'Compose 文件不是可读取的普通文件',
          47: 'Compose 文件为空或超过 256 KiB',
        };
        if (reasons[error.exitCode])
          throw new BuildCommandError(error.exitCode, reasons[error.exitCode]!);
      }
      throw error;
    } finally {
      await rm(localDirectory, { recursive: true, force: true });
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
    const boundWorkspace = session.snapshot.graph?.workspace;
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
      if (boundWorkspace) await copyGraphRepository(boundWorkspace, join(workspace, 'repo'));
      const dependencies = session.snapshot.graph?.dependencies;
      if (dependencies) await copyGraphDependencies(dependencies, join(workspace, 'dependencies'));
      if (d.nodes) await this.managerNodes(session, workspace, secretDir, runNode);
      else {
        if (!boundWorkspace) {
          const secret = await this.gitSecret(session.snapshot.repository.credentialId);
          if (secret) session.secrets.push(...secret.values);
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
            helperImage(),
            300,
            '管理端检出失败。请检查辅助镜像、Git、仓库网络、凭据和固定提交',
          );
        }
        await rm(secretDir, { recursive: true, force: true });
        const graphEnvironment = Boolean(session.snapshot.graph);
        if (graphEnvironment) await mkdir(secretDir, { recursive: true, mode: 0o700 });
        const envPath = join(graphEnvironment ? secretDir : root, 'build.env');
        await writeFile(
          envPath,
          graphEnvironment
            ? exportedVariables({
                ...session.variables,
                ...(dependencies && { VEYOPS_GRAPH_DEPENDENCY_ROOT: '/workspace/dependencies' }),
              })
            : Object.entries(session.variables)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n'),
          { mode: 0o600 },
        );
        if (
          !graphEnvironment &&
          Object.values(session.variables).some((value) => /[\r\n]/.test(value))
        )
          throw new Error('管理端容器环境变量暂不支持换行值');
        for (const step of configuredCommands(d)) {
          session.context.log(`${step.name}\n`);
          await this.container(
            session,
            workspace,
            `set -eu\n${enterRepositoryDirectory('/workspace', d.repoPath)}\n${graphEnvironment ? '. /run/veyops/build.env\n' : ''}${step.command}\n`,
            graphEnvironment ? secretDir : undefined,
            graphEnvironment ? undefined : envPath,
            undefined,
            step.timeout,
            `${step.name}失败。请确认构建镜像可拉取。${step.check}`,
          );
        }
        await rm(envPath, { force: true });
      }
      const packageNode = d.nodes?.find((node) => node.type === 'PACKAGE');
      const packageOutputs = () =>
        d.artifacts
          ? this.managerNamedArtifacts(session, root, workspace, cleanup)
          : this.managerPackage(session, root, workspace, cleanup);
      return packageNode
        ? await runNode(packageNode, async () => {
            const output = await packageOutputs();
            await onPackage?.(output);
            return output;
          })
        : await packageOutputs();
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async registerManagerArtifacts(session: BuildSession, workspace: GraphWorkspaceRef) {
    const root = resolve(dataDirectory, 'builds', session.taskId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const cleanup = () => rm(root, { recursive: true, force: true });
    try {
      if (session.snapshot.graphAutomation) await this.configureWebhookDocker(session, root);
      return await this.managerNamedArtifacts(
        session,
        root,
        await openGraphWorkspace(workspace),
        cleanup,
      );
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async managerGraphShell(
    session: BuildSession,
    workspace: string,
    command: string,
    directory: string,
    timeout: number,
    onData: NonNullable<ProcessOptions['onData']>,
    artifactArchive?: string,
  ) {
    const builds = join(dataDirectory, 'builds');
    await mkdir(builds, { recursive: true, mode: 0o700 });
    const secrets = await mkdtemp(join(builds, 'graph-shell-'));
    try {
      if (artifactArchive) {
        const input = join(secrets, 'artifact');
        await mkdir(input, { mode: 0o700 });
        const result = await this.runner.run('tar', ['-xf', artifactArchive, '-C', input], {
          timeout: 180,
          signal: session.context.signal,
        });
        if (result.exitCode !== 0) throw new ConflictException('无法解包已选脚本产物');
      }
      if (session.snapshot.graphAutomation) await this.configureWebhookDocker(session, secrets);
      await writeFile(join(secrets, 'shell.env'), exportedVariables(session.variables), {
        mode: 0o600,
      });
      return await this.container(
        session,
        workspace,
        `${enterRepositoryDirectory('/workspace', relativePath(directory))}; . /run/veyops/shell.env\n${command}`,
        secrets,
        undefined,
        helperImage(),
        timeout,
        undefined,
        onData,
      );
    } finally {
      await rm(secrets, { recursive: true, force: true });
    }
  }

  async managerFlowCommand(
    session: DockerSession,
    workspace: string,
    command: string,
    directory: string,
    variables: Record<string, string>,
    timeout: number,
    automation: boolean,
    image = helperImage(),
  ) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(image))
      throw new ConflictException('无效构建容器镜像');
    const builds = join(dataDirectory, 'builds');
    await mkdir(builds, { recursive: true, mode: 0o700 });
    const secrets = await mkdtemp(join(builds, 'flow-command-'));
    try {
      const container = { ...session, snapshot: { definition: { buildImage: image } } };
      if (automation) await this.configureWebhookDocker(container, secrets);
      await writeFile(join(secrets, 'shell.env'), exportedVariables(variables), { mode: 0o600 });
      return await this.container(
        container,
        workspace,
        `${enterSourceDirectory('/workspace', directory)}\n. /run/veyops/shell.env\n${command}`,
        secrets,
        undefined,
        undefined,
        timeout,
        undefined,
        (text) => session.context.log(text),
      );
    } finally {
      await rm(secrets, { recursive: true, force: true });
    }
  }

  async archiveFlowImage(
    session: BuildSession,
    imageId: string,
    reference: string,
    instanceId: string,
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
      throw new ConflictException('执行流镜像缺少有效的 Image ID');
    const builds = join(dataDirectory, 'builds');
    await mkdir(builds, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(builds, 'flow-image-'));
    const capture = { ...session, taskId: instanceId };
    try {
      if (capture.snapshot.graphAutomation) await this.configureWebhookDocker(capture, root);
      const archive = await this.retainManagerImageArchive(
        capture,
        root,
        reference,
        undefined,
        async (path) => this.verifyFlowImageArchive(path, imageId, session.context.signal),
      );
      return { imageReference: reference, ...archive };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  private async verifyFlowImageArchive(path: string, imageId: string, signal: AbortSignal) {
    const options = { timeout: 90, signal };
    const manifest = await this.runner.run('tar', ['-xOzf', path, 'manifest.json'], options);
    const entries: unknown = manifest.exitCode === 0 ? JSON.parse(manifest.stdout) : undefined;
    const config = Array.isArray(entries) && entries.length === 1 ? entries[0]?.Config : undefined;
    const hash = imageId.slice('sha256:'.length);
    if (config !== `${hash}.json` && config !== `blobs/sha256/${hash}`)
      throw new ConflictException('归档里的镜像 ID 与已确认内容不一致');
    const content = await this.runner.run('tar', ['-xOzf', path, config], options);
    if (
      content.exitCode !== 0 ||
      createHash('sha256').update(content.stdout).digest('hex') !== hash
    )
      throw new ConflictException('归档里的镜像配置未通过摘要核对');
  }

  async buildFlowImage(
    session: DockerSession,
    workspace: string,
    directory: string,
    dockerfile: string,
    reference: string,
    timeout: number,
    automation: boolean,
  ) {
    const base = await realpath(workspace);
    const context = await realpath(resolve(base, directory));
    const path = await realpath(resolve(context, dockerfile));
    const inside = (root: string, candidate: string) => {
      const child = relative(root, candidate);
      return child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
    };
    if (!inside(base, context) || !inside(context, path) || !(await lstat(path)).isFile())
      throw new ConflictException('Dockerfile 或构建目录超出本次工作区');
    const builds = join(dataDirectory, 'builds');
    await mkdir(builds, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(builds, 'flow-docker-'));
    try {
      if (automation) await this.configureWebhookDocker(session, root);
      await this.local(session, ['build', '--tag', reference, '--file', path, context], timeout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  async flowComposeSnapshot(
    session: BuildSession,
    workspace: string,
    path: string,
    target?: SshTarget,
  ) {
    path = normalizeRelativePath(path);
    if (target)
      return this.remoteComposeSnapshot(target, workspace, session, {
        root: workspace,
        directory: '.',
        path,
      });
    const base = await realpath(workspace);
    const candidate = await realpath(resolve(base, path));
    const child = relative(base, candidate);
    if (!child || child === '..' || child.startsWith('..' + sep) || isAbsolute(child))
      throw new ConflictException('Compose 文件超出本次工作区');
    return readComposeSnapshot(candidate);
  }

  private async managerNamedArtifacts(
    session: BuildSession,
    root: string,
    workspace: string,
    cleanup: () => Promise<void>,
  ): Promise<BuildOutput> {
    const artifacts: NonNullable<BuildOutput['artifacts']> = [];
    for (const declaration of session.snapshot.definition.artifacts ?? []) {
      const scoped = namedArtifactSession(session, declaration);
      try {
        artifacts.push({
          declaration,
          output: await this.managerPackage(scoped, root, workspace, cleanup, declaration),
        });
      } catch (error) {
        if (
          declaration.required !== false ||
          !(error instanceof BuildCommandError) ||
          error.exitCode !== 44
        )
          throw error;
        session.context.log(`可选产物 ${declaration.name} 不存在，已略过\n`);
      }
    }
    return { ...artifacts[0]?.output, artifacts, cleanup };
  }

  private async managerPackage(
    session: BuildSession,
    root: string,
    workspace: string,
    cleanup: () => Promise<void>,
    declaration?: NamedArtifactDefinition,
  ): Promise<BuildOutput> {
    const d = session.snapshot.definition;
    if (d.artifactType === 'FILE') {
      const archiveName = declaration ? `artifact-${session.taskId}.tar.gz` : 'artifact.tar.gz';
      const archive = join(workspace, archiveName);
      if (declaration?.collection === 'WORK_DIRECTORY') {
        if (!this.physical) throw new ConflictException('构建工作目录产物适配器不可用');
        const physical = await this.physical.collectBuilderPath({
          workspace: resolve(workspace, 'repo'),
          workingDirectory: d.repoPath,
          relativePath: '.',
          kind: 'DIRECTORY',
          collection: declaration.collection,
          excludePaths: declaration.excludePaths,
          instanceId: artifactIdentity(session.snapshot, declaration.name).instanceId,
          signal: session.context.signal,
        });
        await writeFile(archive, '', { flag: 'wx', mode: 0o600 });
        try {
          await this.physical.stageBuilderArchive(physical, archive, '.', session.context.signal);
          const stored = await this.retainManagerArchive(
            archive,
            `${session.taskId}.tar.gz`,
            session,
          );
          return {
            localArchive: stored.path,
            checksum: stored.checksum,
            sizeBytes: stored.sizeBytes,
            physical,
            cleanup,
          };
        } finally {
          await rm(archive, { force: true });
        }
      }
      // Reserve the output after repository containers have finished writing the workspace.
      await writeFile(archive, '', { flag: 'wx', mode: 0o600 });
      let stored;
      try {
        await this.container(
          session,
          workspace,
          packScript(
            '/workspace',
            d.repoPath,
            d.outputPath,
            '/workspace/' + archiveName,
            declaration?.type === 'DOCKER_IMAGE' ? undefined : declaration?.type,
          ),
          undefined,
          undefined,
          helperImage(),
        );
        stored = await this.retainManagerArchive(archive, `${session.taskId}.tar.gz`, session);
      } finally {
        if (declaration) await rm(archive, { force: true });
      }
      return {
        localArchive: stored.path,
        checksum: stored.checksum,
        sizeBytes: stored.sizeBytes,
        physical:
          session.snapshot.graph && this.physical
            ? await this.physical.collectBuilderPath({
                workspace: resolve(workspace, 'repo'),
                workingDirectory: d.repoPath,
                relativePath: d.outputPath,
                kind:
                  declaration?.type === 'FILE' || declaration?.type === 'DIRECTORY'
                    ? declaration.type
                    : (
                          await lstat(resolve(workspace, 'repo', d.repoPath, d.outputPath))
                        ).isDirectory()
                      ? 'DIRECTORY'
                      : 'FILE',
                instanceId: artifactIdentity(session.snapshot, declaration?.name).instanceId,
                signal: session.context.signal,
              })
            : undefined,
        cleanup,
      };
    }
    const dockerfile = resolve(workspace, 'repo', d.repoPath, d.dockerfilePath),
      buildContext = resolve(workspace, 'repo', d.repoPath);
    const repoRoot = await realpath(join(workspace, 'repo'));
    if (repoRoot !== join(await realpath(workspace), 'repo'))
      throw new Error('拒绝将符号链接仓库用作 Docker 构建目录');
    for (const checked of [
      declaration?.imageReference
        ? await realpath(buildContext)
        : await realpath(dockerfile).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT' && declaration?.required === false)
              throw new BuildCommandError(44, '可选产物的 Dockerfile 不存在');
            throw error;
          }),
      await realpath(buildContext),
    ])
      if (relative(repoRoot, checked).startsWith('..') || isAbsolute(relative(repoRoot, checked)))
        throw new Error('Docker构建路径超出仓库');
    const buildOnly = session.snapshot.mode === 'BUILD_ONLY';
    let composeYaml: string | undefined;
    if (buildOnly) {
      const composePath = await realpath(resolve(buildContext, d.composeFilePath)).catch(
        (error: NodeJS.ErrnoException) => {
          if (
            error.code === 'ENOENT' &&
            (!session.snapshot.deployAfterBuild || session.snapshot.managedCompose)
          )
            return undefined;
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
    if (
      buildOnly &&
      !(
        (session.snapshot.deployAfterBuild || session.snapshot.graph) &&
        d.registryId &&
        d.imageRepository
      )
    ) {
      const imageReference = localImageTag(session);
      if (declaration?.imageReference) {
        const source = checkedImageReference(declaration.imageReference);
        if (
          source.includes('@sha256:') &&
          (
            await this.runDocker(session, ['image', 'inspect', source], 30, {
              signal: session.context.signal,
            })
          ).exitCode !== 0
        )
          await this.local(session, ['pull', source], 600, '无法拉取固定 Digest 的镜像');
        await this.local(
          session,
          ['image', 'tag', source, imageReference],
          30,
          '本地镜像不存在或无法登记',
        );
      } else {
        await this.local(
          session,
          ['build', '--tag', imageReference, '--file', dockerfile, buildContext],
          1200,
          'Docker 镜像构建失败。请检查 Dockerfile、基础镜像及依赖源的网络和权限',
        );
      }
      const inspected = await this.local(
        session,
        ['image', 'inspect', '--format', '{{.Id}}', imageReference],
        30,
      );
      const imageId = inspectedImageId(inspected.stdout);
      return {
        imageReference,
        imageId,
        physical:
          session.snapshot.graph && this.physical
            ? await this.physical.describeImage({
                reference: imageReference,
                owner: declaration?.imageReference ? 'EXTERNAL' : 'MANAGED',
                builderId: session.webhookDocker ? 'manager-webhook' : 'manager',
                signal: session.context.signal,
              })
            : undefined,
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
        physical:
          session.snapshot.graph && d.registryId
            ? {
                kind: 'DOCKER_IMAGE',
                location: 'REGISTRY',
                owner: 'EXTERNAL',
                registryId: d.registryId,
                imageReference: `${repository}@${imageDigest}`,
                digest: imageDigest,
              }
            : undefined,
        imageTag,
        imageDigest,
        composeYaml,
        cleanup,
      };
    }
    const localCompose = join(workspace, 'compose.yaml');
    if (session.snapshot.managedCompose)
      return {
        ...offline,
        imageReference: `${repository}@${imageDigest}`,
        imageTag,
        imageDigest,
        cleanup,
      };
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
    verifyBeforePublish?: (path: string) => Promise<void>,
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
    await verifyBeforePublish?.(archive);
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
  private async configureWebhookDocker(session: DockerSession, root: string) {
    const socket = await BuildsService.automaticManagerSocket(false);
    const config = join(root, 'docker-config');
    await mkdir(config, { mode: 0o700 });
    session.webhookDocker = { socket, config };
    const result = await this.runDocker(session, ['info', '--format', '{{json .}}'], 15, {
      signal: session.context.signal,
    });
    if (result.exitCode !== 0) throw new ConflictException('自动执行专用 Docker 无法连接');
    BuildsService.assertAutomaticDockerInfo(result.stdout);
  }
  private async container(
    session: ContainerSession,
    workspace: string,
    script: string,
    secretDir?: string,
    envFile?: string,
    image?: string,
    timeout = 1200,
    failureMessage = '管理端容器步骤失败。请检查镜像和步骤日志',
    scriptOutput?: ProcessOptions['onData'],
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
      if (scriptOutput)
        return await this.runDocker(session, args, timeout, {
          signal: session.context.signal,
          onData: scriptOutput,
        });
      return await this.local(session, args, timeout, failureMessage);
    } finally {
      await this.runDocker(session, ['rm', '-f', name], 30).catch(() => undefined);
    }
  }
  private runDocker(
    session: DockerSession,
    args: string[],
    timeout: number,
    options: {
      signal?: AbortSignal;
      log?: boolean;
      onData?: ProcessOptions['onData'];
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
      onData: options.onData ?? (options.log ? (text) => session.context.log(text) : undefined),
    });
  }
  private async local(
    session: DockerSession,
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
