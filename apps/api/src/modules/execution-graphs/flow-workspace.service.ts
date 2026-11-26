import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { dataDirectory } from '../../core/config';
import { ProcessRunnerService } from '../../infrastructure/build-runner/process-runner.service';
import { executionVariableName } from '../../infrastructure/execution-variables';
import { SshService, type SshOptions, type SshTarget } from '../../infrastructure/ssh/ssh.service';
import { artifactPathDigest, linuxArtifactDigest } from '../artifacts/artifact-physical-paths';
import { BuildCommandError, BuildsService, enterSourceDirectory } from '../builds/builds.service';
import { normalizeRelativePath, shellQuote as q } from '../pipelines/pipeline.validation';
import {
  RepositoryMetadataService,
  type GraphCheckoutSnapshot,
} from '../projects/repository-metadata.service';
import { validateWorkspaceRoot } from '../system/system-settings.service';
import type { TaskExecutionContext } from '../tasks/tasks.types';
import {
  localWorkspaceControl,
  managerWorkspaceDirectory,
  remoteWorkspaceControl,
  runControlsDirectory as controlsLeaf,
  validWorkspaceNames,
  workspaceOwner,
  workspaceOwnerFile as markerLeaf,
  workspaceIdentityFile as identityLeaf,
  workspaceLockFile as lockLeaf,
  type FlowWorkspace,
  type FlowWorkspacePlacement,
} from './flow-workspace-paths';
import type { GraphAutomation } from './graph-automatic-delivery';

export type { FlowWorkspace, FlowWorkspacePlacement } from './flow-workspace-paths';

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

const restoredLeaf = 'historical-input';
const pendingLeaf = 'historical-input.pending';

type RestoreArchive = {
  checksum: string;
  sizeBytes: number;
  treeChecksum: string;
  treeSize: number;
};

function ownership(runId: string, placement: FlowWorkspacePlacement) {
  return workspaceOwner(
    runId,
    placement.projectSlug,
    placement.location === 'TARGET' ? { id: placement.target.id, root: placement.root } : undefined,
  );
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

function remoteControlChecks(owner: string) {
  return [
    'test -d "$control"',
    'test ! -L "$control"',
    'test "$(realpath -e -- "$control")" = "$control"',
    `test -f "$control/${markerLeaf}"`,
    `test ! -L "$control/${markerLeaf}"`,
    `test "$(cat -- "$control/${markerLeaf}")" = ${q(owner)}`,
    `test -f "$control/${lockLeaf}"`,
    `test ! -L "$control/${lockLeaf}"`,
  ].join('\n');
}

function remoteWorkspaceChecks() {
  return [
    'test -d "$workspace"',
    'test ! -L "$workspace"',
    'test "$(realpath -e -- "$workspace")" = "$workspace"',
    `test -f "$control/${identityLeaf}"`,
    `test ! -L "$control/${identityLeaf}"`,
    `test "$(cat -- "$control/${identityLeaf}")" = "$(stat -c '%d:%i' -- "$workspace")"`,
  ].join('\n');
}

@Injectable()
export class FlowWorkspaceService {
  private readonly localOpen = new Map<string, Promise<string>>();

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
    if (!validWorkspaceNames(runId, placement.projectSlug))
      throw new ConflictException('执行流工作区的项目或运行标识无效');
    const owner = ownership(runId, placement);
    if (placement.location === 'MANAGER') {
      const pending = this.localOpen.get(owner);
      const work = pending ?? this.localWorkspace(runId, placement.projectSlug, owner, priorPath);
      if (!pending) this.localOpen.set(owner, work);
      let path: string;
      try {
        path = await work;
      } finally {
        if (this.localOpen.get(owner) === work) this.localOpen.delete(owner);
      }
      if (priorPath !== undefined && priorPath !== path)
        throw new ConflictException('执行流的管理端工作目录已变化');
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
        `project="$root"/${q(placement.projectSlug)}`,
        `controls="$project"/${controlsLeaf}`,
        `control="$controls"/${q(runId)}`,
        `workspace="$project"/${q(runId)}`,
        ...(priorPath
          ? [`test "$workspace" = ${q(priorPath)}`]
          : [
              'test "$(realpath -m -- "$controls")" = "$controls"',
              'mkdir -p -- "$controls"',
              'if test ! -e "$control" && test ! -L "$control"; then',
              '  next=$(mktemp -d -- "$controls/.new-XXXXXXXX")',
              '  trap \'rm -rf -- "$next"\' EXIT',
              `  printf '%s\\n' ${q(owner)} > "$next/${markerLeaf}"`,
              `  : > "$next/${lockLeaf}"`,
              '  mv -T -n -- "$next" "$control"',
              'fi',
            ]),
        remoteControlChecks(owner),
        `exec 9<"$control/${lockLeaf}"`,
        priorPath ? 'flock -s 9' : 'flock -x 9',
        ...(priorPath
          ? []
          : [
              `if test ! -e "$control/${identityLeaf}" && test ! -L "$control/${identityLeaf}"; then`,
              '  mkdir -- "$workspace"',
              `  stat -c '%d:%i' -- "$workspace" > "$control/${identityLeaf}"`,
              'fi',
            ]),
        remoteWorkspaceChecks(),
        'printf \'VEYOPS_FLOW_WORKSPACE=%s\\n\' "$workspace"',
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
    const suffix = '/' + placement.projectSlug + '/' + runId;
    const receivedAtRoot = configured.startsWith('~/')
      ? path.endsWith('/' + configured.slice(2) + suffix)
      : path === configured + suffix;
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

  private async localWorkspace(
    runId: string,
    projectSlug: string,
    owner: string,
    priorPath?: string,
  ) {
    if (!priorPath) await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    const base = join(await realpath(dataDirectory), managerWorkspaceDirectory);
    const prepare = priorPath ? checkedDirectory : makeDirectory;
    const project = await prepare(join(await prepare(base), projectSlug));
    const controls = await prepare(join(project, controlsLeaf));
    const control = join(controls, runId);
    const workspace = join(project, runId);
    if (priorPath !== undefined && priorPath !== workspace)
      throw new ConflictException('执行流的管理端工作目录已变化');
    if (!priorPath && !(await entry(control))) {
      const next = await mkdtemp(join(controls, '.new-'));
      try {
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
    const identity = join(control, identityLeaf);
    if (!priorPath && !(await entry(identity))) {
      await mkdir(workspace, { mode: 0o700 });
      const details = await lstat(workspace, { bigint: true });
      await writeFile(identity, `${details.dev}:${details.ino}\n`, { mode: 0o600, flag: 'wx' });
    }
    const details = await lstat(workspace, { bigint: true });
    if (
      !(await entry(identity))?.isFile() ||
      (await readFile(identity, 'utf8')) !== `${details.dev}:${details.ino}\n`
    )
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
      if (workspaceState.placement.location === 'TARGET') {
        const receipt = await this.targetCheckout(
          workspaceState,
          workspaceState.placement.target,
          projectId,
          { ...source, fullClone: fullClone ?? source.fullClone },
          directory,
          context,
        );
        context.log(
          `目标端检出 ${directory} · ${receipt.commitSha}\n`,
          workspaceState.placement.target.id,
        );
        checkedOut.push({
          ...receipt,
          repositoryId: source.repositoryId,
          directory,
          ref: source.ref,
        });
        continue;
      }
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
        const segments = directory.split('/');
        const leaf = segments.pop()!;
        let parent = workspaceState.path;
        for (const segment of segments) parent = await makeDirectory(join(parent, segment));
        const destination = join(parent, leaf);
        if (await entry(destination))
          throw new ConflictException('源码检出目录已存在，不能覆盖先前工作区');
        await rename(tree, destination);
        context.log(`检出 ${directory} · ${receipt.commitSha}\n`);
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

  private async targetCheckout(
    workspace: FlowWorkspace,
    target: SshTarget,
    projectId: string,
    source: GraphCheckoutSnapshot,
    directory: string,
    context: TaskExecutionContext,
  ) {
    const control = remoteWorkspaceControl(workspace.path, workspace.runId);
    const remote = control + '/checkout-' + randomUUID();
    const { command, credential } = await this.builds.prepareFlowTargetCheckout(
      projectId,
      source,
      remote,
    );
    const destination = posix.join(workspace.path, directory);
    const parent = posix.dirname(destination);
    let stdout = '';
    const options: SshOptions = {
      timeout: 300,
      signal: context.signal,
      secrets: credential?.values,
      onData: (text, stream) => {
        if (stream === 'stdout') stdout = (stdout + text).slice(-16_000);
        else context.log(text, target.id);
      },
    };
    await this.requireRemote(workspace, target, `umask 077; mkdir -- ${q(remote)}`, options);
    try {
      if (credential)
        await this.ssh.uploadContent(target, credential.response, credential.path, {
          timeout: 30,
          signal: context.signal,
          mode: 0o600,
        });
      await this.requireRemote(
        workspace,
        target,
        [
          `test "$(realpath -m -- ${q(destination)})" = ${q(destination)}`,
          `test ! -e ${q(destination)}`,
          `test ! -L ${q(destination)}`,
          `mkdir -p -- ${q(parent)}`,
          `test "$(realpath -e -- ${q(parent)})" = ${q(parent)}`,
          command,
          `test -d ${q(remote + '/repo')}`,
          `test ! -L ${q(remote + '/repo')}`,
          `mv -T -- ${q(remote + '/repo')} ${q(destination)}`,
        ].join('\n'),
        options,
      );
      const match = /^VEYOPS_FLOW_GIT=([a-f0-9]{40}|[a-f0-9]{64}):(true|false)\s*$/m.exec(stdout);
      if (match?.[1] !== source.commitSha)
        throw new ConflictException('目标端实际检出提交与已确认版本不一致');
      return { commitSha: match[1], shallow: match[2] === 'true', subject: '' };
    } finally {
      await this.requireRemote(workspace, target, `rm -rf -- ${q(remote)}`, { timeout: 30 }).catch(
        () => undefined,
      );
    }
  }

  async restore(
    workspace: FlowWorkspace,
    fingerprint: string,
    context: TaskExecutionContext,
    stage: (archive: string) => Promise<RestoreArchive>,
  ) {
    const { placement, path, runId } = workspace;
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new ConflictException('历史目录确认信息无效');
    const control =
      placement.location === 'TARGET'
        ? remoteWorkspaceControl(path, runId)
        : localWorkspaceControl(path, runId);
    if (placement.location === 'MANAGER') {
      if (await this.localRestoreReceipt(control, fingerprint)) return;
    } else {
      let probe = '';
      await this.requireRemote(
        workspace,
        placement.target,
        [this.remoteRestoreReceipt(control, fingerprint), 'printf "%s\n" "$restored"'].join('\n'),
        {
          timeout: 30,
          signal: context.signal,
          onData: (output, stream) => {
            if (stream === 'stdout') probe += output;
          },
        },
        true,
      );
      if (probe.trim() === 'yes') return;
      if (probe.trim() !== 'no') throw new ConflictException('无法确认本次历史目录还原状态');
    }
    const staging = await mkdtemp(join(await realpath(dataDirectory), '.flow-restore-'));
    try {
      const archive = join(staging, 'workspace.tar.gz');
      const receipt = await stage(archive);
      if (placement.location === 'MANAGER')
        await this.restoreLocal(workspace, control, archive, fingerprint, receipt, context.signal);
      else
        await this.restoreRemote(
          workspace,
          placement.target,
          control,
          archive,
          fingerprint,
          receipt,
          context.signal,
        );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async localRestoreReceipt(control: string, fingerprint: string) {
    const marker = join(control, restoredLeaf);
    const receipt = await entry(marker);
    if (!receipt) return false;
    if (!receipt.isFile() || (await readFile(marker, 'utf8')) !== fingerprint + '\n')
      throw new ConflictException('历史目录还原回执发生变化');
    return true;
  }

  private async restoreLocal(
    workspace: FlowWorkspace,
    control: string,
    archive: string,
    fingerprint: string,
    receipt: RestoreArchive,
    signal: AbortSignal,
  ) {
    const { path, runId, placement } = workspace;
    const digest = await artifactPathDigest(archive, 'FILE', signal);
    if (digest.sha256 !== receipt.checksum || digest.sizeBytes !== receipt.sizeBytes)
      throw new ConflictException('历史目录归档校验失败');
    await this.open(runId, placement, signal, path);
    if (await this.localRestoreReceipt(control, fingerprint)) return;
    const pending = join(control, pendingLeaf);
    const contents = await readdir(path);
    const intent = await entry(pending);
    if (intent) {
      if (!intent.isFile() || (await readFile(pending, 'utf8')) !== fingerprint + '\n')
        throw new ConflictException('历史目录还原回执发生变化');
      for (const child of contents) await rm(join(path, child), { recursive: true, force: true });
    } else {
      if (contents.length) throw new ConflictException('本次还原的工作区不是空目录');
      await writeFile(pending, fingerprint + '\n', { flag: 'wx', mode: 0o600 });
    }
    const unpacked = await this.processes.run(
      'tar',
      ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', path],
      { timeout: 300, signal },
    );
    if (unpacked.exitCode !== 0) throw new ConflictException('无法解开历史目录归档');
    const tree = await artifactPathDigest(path, 'DIRECTORY', signal);
    if (tree.sha256 !== receipt.treeChecksum || tree.sizeBytes !== receipt.treeSize)
      throw new ConflictException('还原后的历史目录与登记摘要不一致');
    await rename(pending, join(control, restoredLeaf));
  }

  private remoteRestoreReceipt(control: string, fingerprint: string) {
    return [
      `done_file=${q(control + '/' + restoredLeaf)}`,
      `pending=${q(control + '/' + pendingLeaf)}`,
      `expected=${q(fingerprint)}`,
      'restored=no',
      'if test -e "$done_file" || test -L "$done_file"; then',
      '  test -f "$done_file" && test ! -L "$done_file" || exit 1',
      '  test "$(cat -- "$done_file")" = "$expected" || exit 1',
      '  restored=yes',
      'fi',
    ].join('\n');
  }

  private async restoreRemote(
    workspace: FlowWorkspace,
    target: SshTarget,
    control: string,
    archive: string,
    fingerprint: string,
    receipt: RestoreArchive,
    signal: AbortSignal,
  ) {
    const staging = control + '/restore-' + randomUUID();
    const input = staging + '/workspace.tar.gz';
    await this.requireRemote(workspace, target, `umask 077; mkdir -- ${q(staging)}`, {
      timeout: 30,
      signal,
    });
    try {
      await this.ssh.upload(target, archive, input, { timeout: 300, signal });
      const command = [
        'set -euo pipefail',
        'umask 077',
        `cd -- ${q(workspace.path)}`,
        this.remoteRestoreReceipt(control, fingerprint),
        'if [[ "$restored" == yes ]]; then exit 0; fi',
        linuxArtifactDigest,
        `[[ "$(artifact_digest FILE ${q(input)})" == ${q(receipt.checksum + ':' + receipt.sizeBytes)} ]]`,
        'if [[ -e "$pending" || -L "$pending" ]]; then',
        '  [[ -f "$pending" && ! -L "$pending" && "$(cat -- "$pending")" == "$expected" ]]',
        '  find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        'else',
        '  [[ -z "$(find . -mindepth 1 -maxdepth 1 -print -quit)" ]]',
        '  ( set -C; printf "%s\n" "$expected" > "$pending" )',
        'fi',
        `tar -xzf ${q(input)} --no-same-owner --no-same-permissions`,
        `[[ "$(artifact_digest DIRECTORY .)" == ${q(receipt.treeChecksum + ':' + receipt.treeSize)} ]]`,
        'mv -T -- "$pending" "$done_file"',
      ].join('\n');
      await this.requireRemote(workspace, target, `bash -c ${q(command)}`, {
        timeout: 300,
        signal,
      });
    } finally {
      await this.requireRemote(workspace, target, `rm -f -- ${q(input)}; rmdir -- ${q(staging)}`, {
        timeout: 30,
      }).catch(() => undefined);
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
      true,
    );
    return { exitCode: result.exitCode, directory };
  }

  private async requireRemote(
    workspace: FlowWorkspace,
    target: SshTarget,
    command: string,
    options: SshOptions,
    shared = false,
  ) {
    const result = await this.ssh.execute(
      target,
      [
        'set -eu',
        `workspace=${q(workspace.path)}`,
        `control=${q(remoteWorkspaceControl(workspace.path, workspace.runId))}`,
        remoteControlChecks(ownership(workspace.runId, workspace.placement)),
        `exec 9<"$control/${lockLeaf}"`,
        shared ? 'flock -sn 9' : 'flock -n 9',
        remoteWorkspaceChecks(),
        `( exec 9<&-; exec /bin/sh -eu -c ${q(command)} )`,
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
      if (basename(workspace.path) !== workspace.runId)
        throw new ConflictException('拒绝清理未经确认的执行流工作目录');
      await rm(workspace.path, { recursive: true, force: true });
      const control = localWorkspaceControl(workspace.path, workspace.runId);
      await rm(control, { recursive: true, force: true });
    } else {
      await this.requireRemote(
        workspace,
        workspace.placement.target,
        `rm -rf -- ${q(workspace.path)} ${q(remoteWorkspaceControl(workspace.path, workspace.runId))}`,
        { timeout: 60, signal },
      );
    }
  }
}
