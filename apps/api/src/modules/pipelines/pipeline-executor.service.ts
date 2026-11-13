import { Injectable } from '@nestjs/common';
import { SshExecutionError, SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  BuildCommandError,
  BuildsService,
  BuildSession,
  archiveMetadata,
  packScript,
} from '../builds/builds.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { DeploymentHealth, DeploymentsService } from '../deployments/deployments.service';
import { deploymentLock } from '../deployments/deployment-lock';
import type { TaskExecutionContext, TaskRecord, TaskStatus } from '../tasks/tasks.types';
import { TaskLeaseUnavailableError } from '../tasks/task-lease';
import type { BuildOutput, PipelineArtifact } from './pipeline.types';
import { deploymentGuard, shellQuote as q } from './pipeline.validation';
import { serializeComposeEnvironment } from './environment.serialization';

type PipelinePhase =
  | 'PREPARE'
  | 'CHECKOUT'
  | 'BUILD'
  | 'MANAGER_BUILD'
  | 'PACKAGE'
  | 'ARTIFACT'
  | 'IMAGE'
  | 'TRANSFER'
  | 'DEPLOY'
  | 'START'
  | 'HEALTH_CHECK'
  | 'CLEANUP';

class DeploymentActivationError extends SshExecutionError {
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message, 'NEEDS_ATTENTION');
  }
}

function commandExitCode(error: unknown) {
  return error instanceof BuildCommandError || error instanceof DeploymentActivationError
    ? error.exitCode
    : null;
}

@Injectable()
export class PipelineExecutor {
  constructor(
    private readonly builds: BuildsService,
    private readonly ssh: SshService,
    private readonly artifacts: ArtifactsService,
    private readonly deployments: DeploymentsService,
  ) {}
  async execute(task: TaskRecord, context: TaskExecutionContext) {
    const snapshot = task.payload.pipeline;
    if (!snapshot) throw new Error('缺少固定Pipeline快照');
    const buildOnly = snapshot.mode === 'BUILD_ONLY';
    if (
      snapshot.triggerType === 'WEBHOOK' &&
      (!buildOnly ||
        snapshot.definition.buildLocation !== 'MANAGER' ||
        Object.keys(snapshot.secretVariables).length)
    )
      throw new Error('Webhook只允许在隔离管理端执行无敏感环境变量的仅构建任务');
    const siblingCancellation = new AbortController();
    context = { ...context, signal: AbortSignal.any([context.signal, siblingCancellation.signal]) };
    const lease = context.leaseOwner ? { taskId: task.id, owner: context.leaseOwner } : undefined;
    if (buildOnly) context.log('仅构建并保留产物\n');
    const resolved = await this.builds.resolveVariables(snapshot);
    const session: BuildSession = {
      snapshot,
      taskId: task.id,
      context,
      variables: resolved.values,
      secrets: resolved.secrets,
    };
    let manager: BuildOutput | undefined;
    let managerArtifact: PipelineArtifact | undefined;
    let managerTarget: { serverId: string; targetId: string } | undefined;
    try {
      if (snapshot.definition.buildLocation === 'MANAGER') {
        // Manager executes exactly once, before any target deploys the same immutable artifact.
        context.log('管理端隔离构建开始（Docker，无宿主机脚本执行）\n');
        const first = task.payload.targets[0];
        if (!first || context.signal.aborted) return;
        managerTarget = { serverId: first.id, targetId: await context.startTarget(first.id) };
        const managerStep = await context.startStep(
          managerTarget.targetId,
          first.id,
          {
            key: 'MANAGER_BUILD',
            name: '管理端隔离构建',
            command: '',
          },
          0,
        );
        try {
          manager = await this.builds.manager(session);
          await context.finishStep(managerStep, 'SUCCESS', 0);
        } catch (error) {
          const status = this.builds.errorKind(error);
          const message = error instanceof Error ? error.message : '管理端构建失败';
          await context.finishStep(managerStep, status, commandExitCode(error), message);
          for (const target of task.payload.targets) {
            if (context.signal.aborted && target.id !== first.id) break;
            const id =
              target.id === first.id
                ? managerTarget.targetId
                : await context.startTarget(target.id);
            await context.finishTarget(id, status, commandExitCode(error), message);
          }
          context.log(`管理端构建未完成，未开始任何部署：${message}\n`);
          return;
        }
        managerArtifact = await this.artifacts.create(snapshot, {
          storageKey: manager.localArchive ?? manager.imageReference!,
          archiveKey: manager.archiveKey,
          checksum: manager.checksum,
          sizeBytes: manager.sizeBytes,
          imageDigest: manager.imageDigest,
          imageReference: manager.imageReference,
          imageId: manager.imageId,
          storageType: manager.imageId ? 'LOCAL_IMAGE' : undefined,
        });
        if (context.signal.aborted) {
          await context.finishTarget(managerTarget.targetId, 'CANCELLED', null);
          return;
        }
      }
      let position = 0,
        failed = false;
      const runner = async () => {
        while (!context.signal.aborted && !(failed && task.payload.failurePolicy === 'STOP')) {
          const target = task.payload.targets[position++];
          if (!target) return;
          const managerBuilt = managerTarget?.serverId === target.id;
          const targetId =
            managerBuilt && managerTarget
              ? managerTarget.targetId
              : await context.startTarget(target.id);
          let deploymentId: string | undefined;
          let lock: ReturnType<typeof deploymentLock> | undefined;
          let locked = false;
          let retainLock = false;
          let activated = false;
          let artifact = managerArtifact;
          let health: DeploymentHealth = 'NOT_CHECKED';
          let status: TaskStatus = 'SUCCESS';
          let error: string | undefined;
          let targetExitCode: number | null = 0;
          const work = `/tmp/veyops-${task.id}-${target.id}`;
          let createdWork = false;
          let stepIndex = managerBuilt ? 1 : 0;
          const phases = new Map<PipelinePhase, number>();
          const step = async <T>(
            phase: PipelinePhase,
            name: string,
            action: () => Promise<T>,
          ): Promise<T> => {
            if (context.signal.aborted) throw new SshExecutionError('任务已取消', 'CANCELLED');
            const phaseCount = (phases.get(phase) ?? 0) + 1;
            phases.set(phase, phaseCount);
            const id = await context.startStep(
              targetId,
              target.id,
              { key: phaseCount === 1 ? phase : `${phase}:${phaseCount}`, name, command: '' },
              stepIndex++,
            );
            context.log(`${name}\n`, target.id);
            try {
              const result = await action();
              await context.finishStep(id, 'SUCCESS', 0);
              return result;
            } catch (caught) {
              const kind = this.builds.errorKind(caught);
              await context.finishStep(
                id,
                kind,
                commandExitCode(caught),
                caught instanceof Error ? caught.message : '步骤失败',
              );
              throw caught;
            }
          };
          const beginDeployment = async () => {
            lock = deploymentLock(snapshot);
            await step('PREPARE', '获取目标主机发布锁', async () => {
              try {
                await this.builds.remote(target, lock!.acquire, session, 30);
                locked = true;
                context.log(`发布锁已获取：${lock!.location}\n`, target.id);
              } catch (error) {
                if (error instanceof BuildCommandError && error.exitCode === 75)
                  throw new BuildCommandError(
                    75,
                    `同一主机服务环境或部署路径已有发布锁，待当前发布结束后重试。锁路径：${lock!.location}`,
                  );
                if (error instanceof BuildCommandError && error.exitCode === 76)
                  throw new BuildCommandError(
                    76,
                    '发布锁目录或部署路径校验失败，请检查远端目录归属和权限',
                  );
                if (error instanceof SshExecutionError && error.kind === 'FAILED') throw error;
                retainLock = true;
                throw new SshExecutionError(
                  `未确认目标主机发布锁是否已获取，请核查锁路径：${lock!.location}`,
                  'NEEDS_ATTENTION',
                );
              }
            });
            deploymentId = await this.deployments.start(snapshot, target.id, targetId, lease);
          };
          const activate = async (name: string, action: () => Promise<void>) => {
            await step('DEPLOY', name, async () => {
              try {
                await action();
                activated = true;
              } catch (error) {
                if (error instanceof SshExecutionError && error.kind === 'FAILED') throw error;
                retainLock = true;
                throw new DeploymentActivationError(
                  error instanceof BuildCommandError
                    ? `${error.message}。激活可能已部分执行，请核查当前版本和运行状态。`
                    : '发布激活结果未确认，请核查当前版本和运行状态。',
                  commandExitCode(error),
                );
              }
            });
          };
          try {
            // A manager-only build produces a single artifact without opening target SSH connections.
            if (buildOnly && managerArtifact) continue;
            if (snapshot.definition.artifactType === 'DOCKER_IMAGE')
              await step('PREPARE', '检查目标主机 Docker 环境', () =>
                this.builds.checkTargetDocker(target, session, !buildOnly),
              );
            await step('PREPARE', '准备专用工作目录', () =>
              this.builds.remote(
                target,
                `set -eu; umask 077; test ! -e ${q(work)}; test ! -L ${q(work)}; mkdir -- ${q(work)}`,
                session,
                30,
              ),
            );
            createdWork = true;
            if (snapshot.definition.buildLocation === 'TARGET') {
              await step('CHECKOUT', '检出固定Git Commit', () =>
                this.builds.remoteCheckout(target, work, session),
              );
              await step('BUILD', '安装依赖与构建', () =>
                this.builds.remoteBuild(target, work, session),
              );
            }
            if (snapshot.definition.artifactType === 'FILE') {
              const archive = work + '/artifact.tar.gz';
              let checksum = manager?.checksum,
                sizeBytes = manager?.sizeBytes;
              if (manager?.localArchive) {
                const localArchive = manager.localArchive;
                await step('TRANSFER', 'SFTP分发管理端产物', () =>
                  this.ssh.upload(target, localArchive, archive, {
                    timeout: 300,
                    signal: context.signal,
                  }),
                );
              } else {
                const output = await step('PACKAGE', '打包与校验文件产物', () =>
                  this.builds.remoteCapture(
                    target,
                    packScript(
                      work,
                      snapshot.definition.repoPath,
                      snapshot.definition.outputPath,
                      archive,
                    ),
                    session,
                  ),
                );
                ({ checksum, sizeBytes } = archiveMetadata(output));
              }
              if (buildOnly) {
                const storageKey = await step('ARTIFACT', '保存并校验构建产物', () =>
                  this.builds.retainRemoteArchive(target, archive, checksum!, sizeBytes!, session),
                );
                artifact = await this.artifacts.create(snapshot, {
                  storageType: 'LOCAL_FILE',
                  storageKey,
                  serverId: target.id,
                  checksum,
                  sizeBytes,
                });
                continue;
              }
              const persistent =
                snapshot.definition.deployPath + '/.artifacts/' + task.id + '.tar.gz';
              await beginDeployment();
              await step('DEPLOY', '校验归档与准备候选版本', () =>
                this.prepareFileRelease(target, archive, checksum!, session),
              );
              if (!artifact)
                artifact = await this.artifacts.create(snapshot, {
                  storageKey: persistent,
                  serverId: target.id,
                  checksum,
                  sizeBytes,
                });
              await activate('原子切换文件发布版本', () =>
                this.activateFileRelease(target, session),
              );
            } else {
              if (buildOnly) {
                const image = await step('IMAGE', '构建并记录本地Docker镜像', () =>
                  this.builds.remoteBuildOnlyImage(target, work, session),
                );
                artifact = await this.artifacts.create(snapshot, {
                  ...image,
                  storageKey: image.imageReference,
                  storageType: 'REMOTE_IMAGE',
                  serverId: target.id,
                });
                continue;
              }
              if (!manager) {
                // The local commit tag and the live release share this host, so serialize both.
                await beginDeployment();
                const image = await step('IMAGE', '构建镜像、推送并固定Digest', () =>
                  this.targetImage(target, work, session),
                );
                artifact = await this.artifacts.create(snapshot, {
                  storageKey: image.reference,
                  imageReference: image.reference,
                  imageDigest: image.digest,
                  serverId: target.id,
                });
              }
              if (manager) await beginDeployment();
              const compose = await step('DEPLOY', '校验Compose配置并拉取镜像', () =>
                this.prepareComposeRelease(
                  target,
                  work,
                  artifact!.imageReference!,
                  session,
                  manager,
                ),
              );
              await activate('启动Compose发布版本', () =>
                this.builds.remote(
                  target,
                  `set -eu; ${compose} up -d --no-build; ${this.switchRelease(session)}`,
                  session,
                  600,
                  'Compose 发布激活失败。请检查宿主机端口占用、Compose 容器状态和当前版本链接',
                ),
              );
            }
            if (snapshot.definition.startCommand)
              await step('START', '启动/更新服务', () =>
                this.inRelease(
                  target,
                  work,
                  snapshot.definition.startCommand,
                  session,
                  '启动命令失败。请检查服务进程、配置、宿主机端口占用和运行日志',
                ),
              );
            if (snapshot.definition.healthCheckCommand) {
              await step('HEALTH_CHECK', '健康检查', async () => {
                health = 'UNKNOWN';
                try {
                  await this.inRelease(
                    target,
                    work,
                    snapshot.definition.healthCheckCommand,
                    session,
                    '健康检查未通过。请检查服务状态、监听地址和健康检查命令',
                  );
                  health = 'HEALTHY';
                } catch (error) {
                  if (error instanceof BuildCommandError) health = 'FAILED';
                  throw error;
                }
              });
            }
          } catch (caught) {
            status = this.builds.errorKind(caught);
            targetExitCode = commandExitCode(caught);
            error = caught instanceof Error ? caught.message : 'Pipeline执行失败';
            if (
              locked &&
              !(caught instanceof BuildCommandError) &&
              (activated || (caught instanceof SshExecutionError && caught.kind !== 'FAILED'))
            )
              retainLock = true;
            if (retainLock) status = 'NEEDS_ATTENTION';
            if (activated) error += '。新版本已切换，请核查当前服务或按上一成功版本恢复。';
            if (retainLock)
              error += `发布锁可能仍在，确认远端操作已停止后再处理：${lock!.location}`;
            failed = true;
            context.log(`${status}: ${error}\n`, target.id);
            if (caught instanceof TaskLeaseUnavailableError) throw caught;
          } finally {
            // Only the platform-generated /tmp directory is cleaned, never a configured deploy path.
            if (createdWork && !retainLock)
              await this.ssh
                .execute(target, `rm -rf -- ${q(work)}`, { timeout: 30 })
                .catch(() => context.log('临时目录清理失败，需人工检查\n', target.id));
            if (retainLock) context.log(`已保留临时工作目录供核查：${work}\n`, target.id);
            try {
              if (deploymentId) {
                const finished = await this.deployments.finish(
                  deploymentId,
                  status,
                  artifact?.id,
                  health,
                  lease,
                );
                if (finished === false) throw new TaskLeaseUnavailableError();
              }
            } catch (error) {
              if (activated) {
                retainLock = true;
                context.log(
                  `发布状态写入失败，请核查当前版本和发布锁：${lock!.location}\n`,
                  target.id,
                );
              }
              throw error;
            } finally {
              if (locked && !retainLock) {
                try {
                  const result = await this.ssh.execute(target, lock!.release, { timeout: 30 });
                  if (result.exitCode !== 0) throw new Error('发布锁释放命令失败');
                } catch {
                  status = 'NEEDS_ATTENTION';
                  failed = true;
                  const lockError = `发布结果已记录，发布锁释放未确认：${lock!.location}`;
                  error = error ? `${error}。${lockError}` : lockError;
                  context.log(`${lockError}\n`, target.id);
                }
              }
            }
            await context.finishTarget(targetId, status, targetExitCode, error);
          }
        }
      };
      const count =
        task.payload.strategy === 'SEQUENTIAL'
          ? 1
          : Math.min(task.payload.maxParallel, task.payload.targets.length);
      const settled = await Promise.allSettled(
        Array.from({ length: count }, async () => {
          try {
            await runner();
          } catch (error) {
            siblingCancellation.abort();
            throw error;
          }
        }),
      );
      const failure = settled.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally {
      try {
        await manager?.cleanup();
      } catch {
        context.log('管理端临时构建目录清理失败，请检查本地磁盘\n');
      }
    }
  }
  private async prepareFileRelease(
    target: SshTarget,
    archive: string,
    checksum: string,
    session: BuildSession,
  ) {
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('无效产物SHA256');
    const s = session.snapshot,
      d = s.definition,
      p = d.deployPath,
      release = p + '/releases/' + session.taskId;
    const owner = `${s.projectId}:${s.serviceId}:${s.environmentId}`;
    await this.builds.remote(
      target,
      `set -eu\n${deploymentGuard(p, owner)}\nprintf '%s  %s\\n' ${q(checksum)} ${q(archive)} | sha256sum -c -\ntest ! -e ${q(release)} && test ! -L ${q(release)}\nmkdir ${q(release)}\ntar -xzf ${q(archive)} -C ${q(release)} --no-same-owner\ncp -- ${q(archive)} ${q(p + '/.artifacts/' + session.taskId + '.tar.gz')}\n`,
      session,
      300,
    );
  }
  private switchRelease(session: BuildSession) {
    const path = session.snapshot.definition.deployPath;
    const next = `${path}/.current-${session.taskId}`;
    return `ln -s ${q('releases/' + session.taskId)} ${q(next)}; mv -Tf -- ${q(next)} ${q(path + '/current')}`;
  }
  private async activateFileRelease(target: SshTarget, session: BuildSession) {
    await this.builds.remote(target, `set -eu; ${this.switchRelease(session)}`, session, 30);
  }
  private async targetImage(target: SshTarget, work: string, session: BuildSession) {
    const d = session.snapshot.definition;
    const { registry, config } = await this.builds.remoteRegistryLogin(target, work, session);
    const image = `${registry.registryUrl}/${d.imageRepository}:${session.snapshot.commitSha}`;
    const cwd = work + '/repo/' + d.repoPath;
    await this.builds.remote(
      target,
      `set -eu; cd ${q(cwd)}; DOCKER_BUILDKIT=1 docker --config ${q(config)} build -f ${q(d.dockerfilePath)} -t ${q(image)} .`,
      session,
      1200,
      'Docker 镜像构建失败。请检查 Dockerfile、基础镜像及依赖源的网络和权限',
    );
    await this.builds.remote(
      target,
      `docker --config ${q(config)} push ${q(image)}`,
      session,
      1200,
      '镜像推送失败。请检查 Registry 的网络、认证和仓库写入权限',
    );
    const output = await this.builds.remoteCapture(
      target,
      `docker --config ${q(config)} image inspect --format '{{json .RepoDigests}}' ${q(image)}`,
      session,
      30,
    );
    const refs = JSON.parse(output.trim()) as string[];
    const reference = refs.find((r) =>
      r.startsWith(`${registry.registryUrl}/${d.imageRepository}@sha256:`),
    );
    if (!reference || !/@sha256:[a-f0-9]{64}$/.test(reference))
      throw new Error('未获取Registry不可变镜像Digest');
    return { reference, digest: reference.split('@')[1]! };
  }
  private async prepareComposeRelease(
    target: SshTarget,
    work: string,
    image: string,
    session: BuildSession,
    manager?: BuildOutput,
  ) {
    if (!/^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error('Docker部署必须使用不可变Digest');
    const s = session.snapshot,
      d = s.definition,
      p = d.deployPath,
      release = p + '/releases/' + session.taskId;
    await this.builds.remote(
      target,
      `set -eu; ${deploymentGuard(p, `${s.projectId}:${s.serviceId}:${s.environmentId}`)}; test ! -e ${q(release)} && test ! -L ${q(release)}; mkdir ${q(release)}`,
      session,
      30,
    );
    if (manager?.localCompose)
      await this.ssh.upload(target, manager.localCompose, release + '/compose.yaml', {
        timeout: 60,
        signal: session.context.signal,
      });
    else
      await this.builds.remote(
        target,
        `cp -- ${q(work + '/repo/' + d.repoPath + '/' + d.composeFilePath)} ${q(release + '/compose.yaml')}`,
        session,
        30,
      );
    const env = serializeComposeEnvironment({ ...session.variables, VEYOPS_IMAGE: image });
    await this.ssh.uploadContent(target, env, release + '/.env', {
      timeout: 30,
      signal: session.context.signal,
      mode: 0o600,
    });
    const { config } = await this.builds.remoteRegistryLogin(target, work, session);
    const project = `veyops-${s.serviceId.slice(0, 8)}-${s.environmentId.slice(0, 8)}`;
    const compose = `docker --config ${q(config)} compose --project-name ${q(project)} --env-file ${q(release + '/.env')} -f ${q(release + '/compose.yaml')}`;
    const images = await this.builds.remoteCapture(
      target,
      `${compose} config --images`,
      session,
      30,
      'Compose 配置解析失败。请检查 Compose 文件、环境变量和 Compose v2 版本',
    );
    if (!images.split(/\s+/).includes(image))
      throw new Error('Compose必须通过 ${VEYOPS_IMAGE} 使用本次固定Digest');
    await this.builds.remote(
      target,
      `${compose} pull`,
      session,
      600,
      'Compose 镜像拉取失败。请检查目标主机到 Registry 的网络、凭据和镜像是否可用',
    );
    return compose;
  }
  private async inRelease(
    target: SshTarget,
    work: string,
    command: string,
    session: BuildSession,
    failureMessage: string,
  ) {
    const envFile = work + '/runtime.env';
    const env = Object.entries(session.variables)
      .map(([k, v]) => `export ${k}=${q(v)}`)
      .join('\n');
    await this.ssh.uploadContent(target, env + '\n', envFile, {
      timeout: 30,
      signal: session.context.signal,
      mode: 0o600,
    });
    await this.builds.remote(
      target,
      `set -eu; . ${q(envFile)}; cd ${q(session.snapshot.definition.deployPath + '/current')}; ${command}`,
      session,
      120,
      failureMessage,
    );
  }
}
