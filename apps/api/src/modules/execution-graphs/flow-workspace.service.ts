import { ConflictException, Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import { dataDirectory, encryptionKey } from '../../core/config';
import { ProcessRunnerService } from '../../infrastructure/build-runner/process-runner.service';
import { executionVariableName } from '../../infrastructure/execution-variables';
import { SshService, type SshOptions, type SshTarget } from '../../infrastructure/ssh/ssh.service';
import { BuildCommandError, BuildsService, enterSourceDirectory } from '../builds/builds.service';
import { normalizeRelativePath, shellQuote as q } from '../pipelines/pipeline.validation';
import {
  RepositoryMetadataService,
  type GraphCheckoutSnapshot,
} from '../projects/repository-metadata.service';
import { validateWorkspaceRoot } from '../system/system-settings.service';
import type { TaskExecutionContext } from '../tasks/tasks.types';
import type { GraphAutomation } from './graph-automatic-delivery';

export type FlowWorkspacePlacement =
  { location: 'MANAGER' } | { location: 'TARGET'; target: SshTarget; root: string };

export type FlowWorkspace = {
  runId: string;
  path: string;
  placement: FlowWorkspacePlacement;
};

export type FlowCheckout = { directory: string; source: GraphCheckoutSnapshot };

type FlowCommand = {
  taskId: string;
  directory?: string;
  command: string;
  timeout: number;
  variables?: { values: Record<string, string>; secrets: string[] };
  image?: string;
  automation?: boolean | GraphAutomation;
};

const workLeaf = 'workspace';
const markerLeaf = 'owner';
const lockLeaf = 'lock';
const maxArchiveBytes = 1024 ** 3;

function runDirectoryName(runId: string) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(runId))
    throw new ConflictException('执行流工作区的运行标识无效');
  return 'veyops-flow-' + runId;
}

function ownership(runId: string, placement: FlowWorkspacePlacement) {
  return createHmac('sha256', encryptionKey())
    .update(
      JSON.stringify([
        'execution-workspace',
        runId,
        placement.location,
        placement.location === 'MANAGER' ? null : [placement.target.id, placement.root],
      ]),
    )
    .digest('hex');
}

async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

async function checkedDirectory(path: string) {
  if (!(await entry(path))?.isDirectory() || (await realpath(path)) !== path)
    throw new ConflictException('执行流工作目录不存在或包含符号链接');
  return path;
}

async function makeDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return checkedDirectory(path);
}

function verifyRemoteControl(owner: string) {
  return [
    'test -d "$control"',
    'test ! -L "$control"',
    'test "$(realpath -e -- "$control")" = "$control"',
    `test -f "$control/${markerLeaf}"`,
    `test ! -L "$control/${markerLeaf}"`,
    `test "$(cat -- "$control/${markerLeaf}")" = ${q(owner)}`,
    `test -f "$control/${lockLeaf}"`,
    `test ! -L "$control/${lockLeaf}"`,
    `test -d "$control/${workLeaf}"`,
    `test ! -L "$control/${workLeaf}"`,
  ].join('\n');
}

@Injectable()
export class FlowWorkspaceService {
  constructor(
    private readonly ssh: SshService,
    private readonly builds: BuildsService,
    private readonly repositories: RepositoryMetadataService,
    private readonly processes: ProcessRunnerService,
  ) {}

  /** The caller serializes this run's tasks and records the first verified path. */
  async open(
    runId: string,
    placement: FlowWorkspacePlacement,
    signal?: AbortSignal,
    priorPath?: string,
  ): Promise<FlowWorkspace> {
    signal?.throwIfAborted();
    const name = runDirectoryName(runId);
    const owner = ownership(runId, placement);
    if (placement.location === 'MANAGER') {
      const path = await this.localWorkspace(name, owner, priorPath);
      return { runId, placement, path };
    }
    const configured = validateWorkspaceRoot(placement.root);
    const root = configured.startsWith('~/')
      ? `root=$(cd -P -- "${'${HOME:?}'}" && pwd -P)/${q(configured.slice(2))}`
      : `root=${q(configured)}`;
    let stdout = '';
    const result = await this.ssh.execute(
      placement.target,
      [
        'set -eu',
        'umask 077',
        root,
        'test "$(realpath -m -- "$root")" = "$root"',
        ...(priorPath ? [] : ['mkdir -p -- "$root"']),
        'test "$(cd -P -- "$root" && pwd -P)" = "$root"',
        `control="$root"/${q(name)}`,
        ...(priorPath
          ? [`test "$control/${workLeaf}" = ${q(priorPath)}`]
          : [
              'if test ! -e "$control" && test ! -L "$control"; then',
              '  next=$(mktemp -d -- "$root/.veyops-flow-XXXXXXXX")',
              '  trap \'rm -rf -- "$next"\' EXIT',
              `  mkdir -- "$next/${workLeaf}"`,
              `  printf '%s\\n' ${q(owner)} > "$next/${markerLeaf}"`,
              `  : > "$next/${lockLeaf}"`,
              '  mv -T -n -- "$next" "$control"',
              'fi',
            ]),
        verifyRemoteControl(owner),
        `printf 'VEYOPS_FLOW_WORKSPACE=%s/${workLeaf}\\n' "$control"`,
      ].join('\n'),
      {
        timeout: 30,
        signal,
        onData: (text, stream) => {
          if (stream === 'stdout') stdout += text;
        },
      },
    );
    const receipt = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith('VEYOPS_FLOW_WORKSPACE='));
    const path = receipt.length === 1 ? receipt[0]!.slice('VEYOPS_FLOW_WORKSPACE='.length) : '';
    const receivedAtRoot = configured.startsWith('~/')
      ? path.endsWith('/' + configured.slice(2) + '/' + name + '/' + workLeaf)
      : path === configured + '/' + name + '/' + workLeaf;
    if (
      result.exitCode !== 0 ||
      !path.startsWith('/') ||
      !receivedAtRoot ||
      (priorPath !== undefined && path !== priorPath)
    )
      throw new ConflictException('目标服务器未确认本次执行流的工作目录');
    validateWorkspaceRoot(path, 4096);
    return { runId, placement, path };
  }

  private async localWorkspace(name: string, owner: string, priorPath?: string) {
    if (!priorPath) await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const base = join(await realpath(dataDirectory), 'flow-workspaces');
    const control = join(
      priorPath ? await checkedDirectory(base) : await makeDirectory(base),
      name,
    );
    const workspace = join(control, workLeaf);
    if (priorPath !== undefined && priorPath !== workspace)
      throw new ConflictException('执行流的管理端工作目录已变化');
    if (!priorPath && !(await entry(control))) {
      const next = await mkdtemp(join(base, 'new-'));
      try {
        await mkdir(join(next, workLeaf), { mode: 0o700 });
        await writeFile(join(next, markerLeaf), owner + '\n', { mode: 0o600 });
        try {
          await rename(next, control);
        } catch (error) {
          if (!(await entry(control))) throw error;
        }
      } finally {
        await rm(next, { recursive: true, force: true });
      }
    }
    await checkedDirectory(control);
    const marker = join(control, markerLeaf);
    if (!(await entry(marker))?.isFile() || (await readFile(marker, 'utf8')) !== owner + '\n')
      throw new ConflictException('执行流工作目录的归属无法确认');
    return checkedDirectory(workspace);
  }

  async checkout(
    workspace: FlowWorkspace,
    projectId: string,
    checkouts: FlowCheckout[],
    context: TaskExecutionContext,
    fullClone?: boolean,
  ) {
    const workspaceState = await this.open(
      workspace.runId,
      workspace.placement,
      context.signal,
      workspace.path,
    );
    const directories = checkouts.map(({ directory }) => normalizeRelativePath(directory));
    if (
      directories.includes('.') ||
      directories.some((directory, index) =>
        directories.some(
          (other, candidate) =>
            index !== candidate && (other === directory || directory.startsWith(other + '/')),
        ),
      )
    )
      throw new ConflictException('源码检出目录不可重名或相互包含');
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const stagingBase = await realpath(dataDirectory);
    const checkedOut = [];
    for (const [index, { source }] of checkouts.entries()) {
      const directory = directories[index]!;
      // The same verified Git transport is used for both placements. Target
      // actions reuse the checkout installed once on their confirmed host.
      const staging = await mkdtemp(join(stagingBase, 'flow-checkout-'));
      try {
        const tree = join(staging, 'source');
        const receipt = await this.repositories.checkoutGraphSource(
          projectId,
          { ...source, fullClone: fullClone ?? source.fullClone },
          context.signal,
          tree,
        );
        context.signal.throwIfAborted();
        if (workspaceState.placement.location === 'MANAGER') {
          const segments = directory.split('/');
          const leaf = segments.pop()!;
          let parent = workspaceState.path;
          for (const segment of segments) parent = await makeDirectory(join(parent, segment));
          const destination = join(parent, leaf);
          if (await entry(destination))
            throw new ConflictException('源码检出目录已存在，不能覆盖先前工作区');
          await rename(tree, destination);
        } else {
          await this.transferCheckout(
            workspaceState,
            workspaceState.placement.target,
            staging,
            directory,
            context,
          );
        }
        context.log(
          `检出 ${directory} · ${receipt.commitSha}\n`,
          workspaceState.placement.location === 'TARGET'
            ? workspaceState.placement.target.id
            : undefined,
        );
        checkedOut.push({
          ...receipt,
          repositoryId: source.repositoryId,
          directory,
          ref: source.ref,
        });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    return checkedOut;
  }

  private async transferCheckout(
    workspace: FlowWorkspace,
    target: SshTarget,
    staging: string,
    directory: string,
    context: TaskExecutionContext,
  ) {
    const archive = join(staging, 'source.tar.gz');
    const packed = await this.processes.run('tar', ['-czf', archive, '-C', staging, 'source'], {
      timeout: 300,
      signal: context.signal,
    });
    const size = (await lstat(archive)).size;
    if (packed.exitCode !== 0 || size === 0 || size > maxArchiveBytes)
      throw new ConflictException('源码检出打包失败或超过 1 GiB');
    const control = posix.dirname(workspace.path);
    const remote = control + '/checkout-' + randomUUID();
    const payload = remote + '/source.tar.gz';
    const destination = posix.join(workspace.path, directory);
    const parent = posix.dirname(destination);
    const options: SshOptions = {
      timeout: 300,
      signal: context.signal,
      onData: (text) => context.log(text, target.id),
    };
    await this.requireRemote(workspace, target, `umask 077; mkdir -- ${q(remote)}`, options);
    try {
      await this.ssh.upload(target, archive, payload, options);
      await this.requireRemote(
        workspace,
        target,
        [
          `test "$(realpath -m -- ${q(destination)})" = ${q(destination)}`,
          `test ! -e ${q(destination)}`,
          `test ! -L ${q(destination)}`,
          `mkdir -p -- ${q(parent)}`,
          `test "$(realpath -e -- ${q(parent)})" = ${q(parent)}`,
          `tar -xzf ${q(payload)} --no-same-owner --no-same-permissions -C ${q(remote)}`,
          `test -d ${q(remote + '/source')}`,
          `test ! -L ${q(remote + '/source')}`,
          `mv -T -- ${q(remote + '/source')} ${q(destination)}`,
        ].join('\n'),
        options,
      );
    } finally {
      await this.requireRemote(workspace, target, `rm -rf -- ${q(remote)}`, { timeout: 30 }).catch(
        () => undefined,
      );
    }
  }

  async command(workspace: FlowWorkspace, options: FlowCommand, context: TaskExecutionContext) {
    await this.open(workspace.runId, workspace.placement, context.signal, workspace.path);
    const directory = normalizeRelativePath(options.directory || '.');
    if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 7200)
      throw new ConflictException('执行流命令的超时无效');
    const values = {
      ...options.variables?.values,
      VEYOPS_RUN_ID: workspace.runId,
      VEYOPS_WORKSPACE: workspace.placement.location === 'MANAGER' ? '/workspace' : workspace.path,
    };
    if (
      Object.entries(values).some(
        ([key, value]) =>
          !executionVariableName.test(key) || typeof value !== 'string' || value.includes('\0'),
      )
    )
      throw new ConflictException('执行流环境变量不符合格式要求');
    const secrets = options.variables?.secrets ?? [];
    if (workspace.placement.location === 'MANAGER') {
      const result = await this.builds.managerFlowCommand(
        { taskId: options.taskId, context, secrets },
        workspace.path,
        options.command,
        directory,
        values,
        options.timeout,
        Boolean(options.automation),
        options.image,
      );
      if (result.exitCode !== 0)
        throw new BuildCommandError(result.exitCode, `管理端动作失败（退出码 ${result.exitCode}）`);
      return { exitCode: result.exitCode, directory };
    }
    const target = workspace.placement.target;
    const result = await this.requireRemote(
      workspace,
      target,
      enterSourceDirectory(workspace.path, directory) + '\n' + options.command,
      {
        timeout: options.timeout,
        signal: context.signal,
        variables: { variables: values, secretVariables: {} },
        secrets,
        onData: (text) => context.log(text, target.id),
      },
    );
    return { exitCode: result.exitCode, directory };
  }

  private async requireRemote(
    workspace: FlowWorkspace,
    target: SshTarget,
    command: string,
    options: SshOptions,
  ) {
    const result = await this.ssh.execute(
      target,
      [
        'set -eu',
        `control=${q(posix.dirname(workspace.path))}`,
        verifyRemoteControl(ownership(workspace.runId, workspace.placement)),
        `exec flock -n "$control/${lockLeaf}" /bin/sh -eu -c ${q(command)}`,
      ].join('\n'),
      options,
    );
    if (result.exitCode !== 0)
      throw new BuildCommandError(result.exitCode, `目标端动作失败（退出码 ${result.exitCode}）`);
    return result;
  }

  async cleanup(workspace: FlowWorkspace, signal?: AbortSignal) {
    await this.open(workspace.runId, workspace.placement, signal, workspace.path);
    if (workspace.placement.location === 'MANAGER') {
      const control = dirname(workspace.path);
      if (basename(control) !== runDirectoryName(workspace.runId))
        throw new ConflictException('拒绝清理未经确认的执行流工作目录');
      await rm(control, { recursive: true, force: true });
    } else {
      await this.requireRemote(
        workspace,
        workspace.placement.target,
        `rm -rf -- ${q(posix.dirname(workspace.path))}`,
        { timeout: 60, signal },
      );
    }
  }
}
