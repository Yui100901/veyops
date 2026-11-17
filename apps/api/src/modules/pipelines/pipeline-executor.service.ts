import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { SshExecutionError, SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  BuildCommandError,
  BuildsService,
  BuildSession,
  type RunPipelineNode,
  archiveMetadata,
  enterRepositoryDirectory,
  packScript,
  pushedImageDigest,
  registryImageTag,
  resolveRepositoryFile,
} from '../builds/builds.service';
import { ArtifactsService, type DeploymentArtifact } from '../artifacts/artifacts.service';
import { DeploymentHealth, DeploymentsService } from '../deployments/deployments.service';
import { deploymentLock } from '../deployments/deployment-lock';
import type { TaskExecutionContext, TaskRecord, TaskStatus } from '../tasks/tasks.types';
import { TaskLeaseUnavailableError } from '../tasks/task-lease';
import type { BuildOutput, PipelineArtifact, PipelineSnapshot } from './pipeline.types';
import { deploymentGuard, shellQuote as q } from './pipeline.validation';
import { serializeComposeEnvironment } from './environment.serialization';
import { composeHealthCheck, httpHealthCheck, waitForReleaseHealth } from './release-health';

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
  | 'ROLLBACK'
  | 'CLEANUP';
type ReportPhase = <T>(phase: PipelinePhase, name: string, action: () => Promise<T>) => Promise<T>;

type ComposeRelease = { compose: string; docker: string; image: string; imageId?: string };
type RollbackCandidate = {
  artifactId: string;
  snapshot: PipelineSnapshot;
  releaseKey: string;
  currentReleaseKey?: string;
};
type DeploymentLease = { taskId: string; owner: string } | undefined;

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

function verifyComposeImage(compose: string, docker: string, image: string, imageId?: string) {
  return `expected_image=${imageId ? q(imageId) : `$(${docker} image inspect --format '{{.Id}}' ${q(image)})`}
container_ids=$(${compose} ps --all --orphans=false --quiet)
matched_image=
for container_id in $container_ids; do
  actual_image=$(${docker} container inspect --format '{{.Config.Image}} {{.Image}} {{.State.Status}}:{{.State.ExitCode}} {{index .Config.Labels "com.docker.compose.oneoff"}}' "$container_id")
  case "$actual_image" in
    *' True'|*' true') continue ;;
    ${q(image + ' ')}"$expected_image "running:*|${q(image + ' ')}"$expected_image "'exited:0 '*)
      matched_image=yes ;;
    ${q(image)}' '*)
      echo 'Compose容器未成功启动或实际镜像与本次发布产物不一致' >&2; exit 1 ;;
  esac
done
test -n "$matched_image" || { echo 'Compose没有成功启动使用本次发布产物的容器' >&2; exit 1; }`;
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
    const deployArtifact = snapshot.mode === 'DEPLOY_ARTIFACT';
    const nodes = snapshot.definition.nodes;
    const packageNode = nodes?.find((node) => node.type === 'PACKAGE');
    const deployNode = nodes?.find((node) => node.type === 'DEPLOY');
    if (
      snapshot.triggerType === 'WEBHOOK' &&
      (!buildOnly ||
        snapshot.definition.buildLocation !== 'MANAGER' ||
        Object.keys(snapshot.secretVariables).length ||
        nodes?.some((node) => node.variables?.some((variable) => variable.credentialId)))
    )
      throw new Error('Webhook只允许在隔离管理端执行无敏感环境变量的仅构建任务');
    const siblingCancellation = new AbortController();
    context = { ...context, signal: AbortSignal.any([context.signal, siblingCancellation.signal]) };
    const lease = context.leaseOwner ? { taskId: task.id, owner: context.leaseOwner } : undefined;
    if (buildOnly) context.log('构建并保留产物\n');
    else {
      await this.deployments.assertApproval(task.id, snapshot, task.payload.targets);
      if (
        snapshot.releasePolicy &&
        snapshot.releasePolicy.rollbackMode !== 'OFF' &&
        !this.hasHealthCheck(snapshot)
      )
        throw new ConflictException('启用自动回滚需要配置发布健康检查');
    }
    const deploymentInputs = new Map<string, DeploymentArtifact>();
    if (deployArtifact) {
      context.log('校验已归档的部署产物\n');
      let shared: DeploymentArtifact | undefined;
      try {
        for (const target of task.payload.targets) {
          if (context.signal.aborted) return;
          const artifact = shared ?? (await this.artifacts.forDeployment(snapshot, target.id));
          deploymentInputs.set(target.id, artifact);
          if (
            snapshot.deploymentArtifacts?.length === 1 &&
            snapshot.deploymentArtifacts[0]?.serverId === null
          )
            shared = artifact;
        }
      } catch (error) {
        if (!(error instanceof ConflictException || error instanceof NotFoundException))
          throw error;
        const summary = `产物校验失败，未开始部署：${error.message}`;
        context.log(`${summary}\n`);
        for (const target of task.payload.targets) {
          if (context.signal.aborted) return;
          const id = await context.startTarget(target.id);
          await context.finishTarget(id, 'FAILED', null, summary);
        }
        return;
      }
    }
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
    let managerStepCount = 0;
    try {
      if (!deployArtifact && snapshot.definition.buildLocation === 'MANAGER') {
        // Manager executes exactly once, before any target deploys the same immutable artifact.
        context.log('管理端隔离构建开始（Docker，无宿主机脚本执行）\n');
        const first = task.payload.targets[0];
        if (!first || context.signal.aborted) return;
        managerTarget = { serverId: first.id, targetId: await context.startTarget(first.id) };
        const managerTargetId = managerTarget.targetId;
        const legacyStep = nodes
          ? undefined
          : await context.startStep(
              managerTargetId,
              first.id,
              { key: 'MANAGER_BUILD', name: '管理端隔离构建', command: '' },
              managerStepCount++,
            );
        const runNode: RunPipelineNode = (node, run) =>
          this.trackStep(
            context,
            managerTargetId,
            first.id,
            `node:${node.id}`,
            node.name,
            managerStepCount++,
            run,
          );
        const saveManagerArtifact = async (output: BuildOutput) => {
          managerArtifact = await this.artifacts.create(snapshot, {
            storageKey: output.localArchive ?? output.imageReference!,
            archiveKey: output.archiveKey,
            archiveImageId: output.archiveImageId,
            archiveImagePlatform: output.archiveImagePlatform,
            composeYaml: output.composeYaml,
            checksum: output.checksum,
            sizeBytes: output.sizeBytes,
            imageDigest: output.imageDigest,
            imageReference: output.imageReference,
            imageTag: output.imageTag,
            imageId: output.imageId,
            storageType: output.imageId ? 'LOCAL_IMAGE' : undefined,
          });
        };
        try {
          manager = await this.builds.manager(session, runNode, saveManagerArtifact);
          if (legacyStep) await context.finishStep(legacyStep, 'SUCCESS', 0);
        } catch (error) {
          const status = this.builds.errorKind(error);
          const message = error instanceof Error ? error.message : '管理端构建失败';
          if (legacyStep)
            await context.finishStep(legacyStep, status, commandExitCode(error), message);
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
        if (!managerArtifact) await saveManagerArtifact(manager);
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
          let deploymentFinished = false;
          let lock: ReturnType<typeof deploymentLock> | undefined;
          let locked = false;
          let retainLock = false;
          let activated = false;
          let stoppedRelease: BuildSession | undefined;
          let composeRelease: ComposeRelease | undefined;
          let rollback: RollbackCandidate | undefined;
          const canRollBack = Boolean(
            snapshot.releasePolicy &&
            snapshot.releasePolicy.rollbackMode !== 'OFF' &&
            !snapshot.rollbackOfDeploymentId,
          );
          const deploymentInput = deploymentInputs.get(target.id);
          let artifact: PipelineArtifact | DeploymentArtifact | undefined =
            deploymentInput ?? managerArtifact;
          let health: DeploymentHealth = 'NOT_CHECKED';
          let status: TaskStatus = 'SUCCESS';
          let error: string | undefined;
          let targetExitCode: number | null = 0;
          const work = `/tmp/veyops-${task.id}-${target.id}`;
          let createdWork = false;
          let stepIndex = managerBuilt ? managerStepCount : 0;
          const phases = new Map<PipelinePhase, number>();
          const step = async <T>(
            phase: PipelinePhase,
            name: string,
            action: () => Promise<T>,
          ): Promise<T> => {
            const phaseCount = (phases.get(phase) ?? 0) + 1;
            phases.set(phase, phaseCount);
            return this.trackStep(
              context,
              targetId,
              target.id,
              phaseCount === 1 ? phase : `${phase}:${phaseCount}`,
              name,
              stepIndex++,
              action,
            );
          };
          const runNode: RunPipelineNode = (node, run) =>
            this.trackStep(
              context,
              targetId,
              target.id,
              `node:${node.id}`,
              node.name,
              stepIndex++,
              run,
            );
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
            let currentReleaseKey: string | undefined;
            if (snapshot.definition.artifactType === 'FILE') {
              const active = await this.deployments.activeSnapshot(snapshot, target.id);
              if (!active) stoppedRelease = session;
              else if (
                posix.normalize(active.definition.deployPath) ===
                posix.normalize(snapshot.definition.deployPath)
              ) {
                currentReleaseKey = active.releaseKey;
                if (active.definition.stopCommand) {
                  const variables = await this.builds.resolveVariables(active);
                  stoppedRelease = {
                    ...session,
                    snapshot: active,
                    variables: variables.values,
                    secrets: variables.secrets,
                  };
                } else if (!snapshot.rollbackOfDeploymentId) stoppedRelease = session;
              }
            }
            if (canRollBack) {
              rollback = await this.deployments.rollbackCandidate(snapshot, target.id);
              currentReleaseKey ??= rollback?.currentReleaseKey;
              if (!rollback) context.log('当前目标没有可用的自动回滚基线\n', target.id);
            }
            if (currentReleaseKey) {
              await step('PREPARE', '核对远端当前发布', async () => {
                const currentPath = `${snapshot.definition.deployPath}/current`;
                const link = await this.builds.remoteCapture(
                  target,
                  `readlink -- ${q(currentPath)}`,
                  session,
                  30,
                );
                if (link.trim() !== `releases/${currentReleaseKey}`)
                  throw new BuildCommandError(1, '远端当前发布与已记录版本不一致，请先核查');
              });
            }
            deploymentId = await this.deployments.start(
              { ...snapshot, releaseKey: task.id },
              target.id,
              targetId,
              lease,
              artifact?.id,
            );
          };
          const activate = async (name: string, action: () => Promise<void>) => {
            await step('DEPLOY', name, async () => {
              await this.deployments.assertApproval(task.id, snapshot, task.payload.targets);
              try {
                await action();
                activated = true;
              } catch (error) {
                if (error instanceof SshExecutionError && error.kind === 'FAILED') throw error;
                retainLock = true;
                throw new DeploymentActivationError(
                  error instanceof BuildCommandError
                    ? error.message
                    : '发布激活结果未确认，请核查当前版本和运行状态。',
                  commandExitCode(error),
                );
              }
              await this.deployments.markActivated(deploymentId!, lease);
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
            if (!deployArtifact && snapshot.definition.buildLocation === 'TARGET') {
              if (nodes) await this.builds.remoteNodes(target, work, session, runNode);
              else {
                await step('CHECKOUT', '检出固定Git Commit', () =>
                  this.builds.remoteCheckout(target, work, session),
                );
                await step('BUILD', '安装依赖与构建', () =>
                  this.builds.remoteBuild(target, work, session),
                );
              }
            }
            if (buildOnly) {
              const packageBuild = () =>
                this.packageTargetBuild(
                  target,
                  work,
                  session,
                  packageNode ? async (_phase, _name, run) => run() : step,
                );
              artifact = packageNode
                ? await runNode(packageNode, packageBuild)
                : await packageBuild();
              continue;
            }
            const release = async () => {
              if (snapshot.definition.artifactType === 'FILE') {
                const archive = work + '/artifact.tar.gz';
                let checksum = deploymentInput?.checksum ?? manager?.checksum,
                  sizeBytes = manager?.sizeBytes;
                const localArchive = deploymentInput?.localArchive ?? manager?.localArchive;
                if (localArchive) {
                  await step('TRANSFER', 'SFTP分发已归档的构建产物', () =>
                    this.ssh.upload(target, localArchive, archive, {
                      timeout: 300,
                      signal: context.signal,
                    }),
                  );
                } else if (!deployArtifact) {
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
                } else throw new Error('缺少已校验的文件产物归档');
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
                  this.activateFileRelease(target, work, session, stoppedRelease),
                );
              } else {
                if (!manager && !deployArtifact) {
                  const image = await step('IMAGE', '构建镜像、推送并固定Digest', () =>
                    this.targetImage(target, work, session),
                  );
                  artifact = await this.artifacts.create(snapshot, {
                    storageKey: image.reference,
                    imageReference: image.reference,
                    imageDigest: image.digest,
                    imageTag: image.tag,
                    ...image.archive,
                    serverId: target.id,
                  });
                }
                await beginDeployment();
                composeRelease = await step('DEPLOY', '校验Compose配置并拉取镜像', () =>
                  this.prepareComposeRelease(
                    target,
                    work,
                    artifact!.imageReference!,
                    session,
                    manager,
                    deploymentInput,
                  ),
                );
                await activate('启动Compose发布版本', () =>
                  this.activateComposeRelease(target, session, composeRelease!),
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
              if (this.hasHealthCheck(snapshot)) {
                await step('HEALTH_CHECK', '健康检查', async () => {
                  health = 'UNKNOWN';
                  try {
                    await this.checkReleaseHealth(target, work, session, composeRelease);
                    health = 'HEALTHY';
                  } catch (error) {
                    if (error instanceof BuildCommandError) health = 'FAILED';
                    throw error;
                  }
                });
              }
            };
            if (deployNode) await runNode(deployNode, release);
            else await release();
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
            const knownActivationFailure =
              caught instanceof DeploymentActivationError && caught.exitCode !== null;
            const shouldRestore =
              locked &&
              deploymentId &&
              canRollBack &&
              !context.signal.aborted &&
              (knownActivationFailure || (activated && caught instanceof BuildCommandError));
            let restored = false;
            if (shouldRestore) {
              retainLock = true;
              if (rollback) {
                try {
                  await this.finishDeployment(deploymentId!, 'FAILED', artifact?.id, health, lease);
                  deploymentFinished = true;
                  await step('ROLLBACK', '从已归档产物自动恢复发布', () =>
                    this.restoreRelease(
                      target,
                      targetId,
                      lease,
                      work,
                      session,
                      rollback!,
                      deploymentId!,
                      activated,
                    ),
                  );
                  retainLock = false;
                  restored = true;
                  status = 'FAILED';
                  error += `。已恢复到发布 ${rollback.snapshot.commitSha}`;
                } catch (rollbackError) {
                  if (rollbackError instanceof TaskLeaseUnavailableError) throw rollbackError;
                  error += `。自动回滚失败：${rollbackError instanceof Error ? rollbackError.message : '结果未知'}`;
                }
              } else error += '。没有可用的自动回滚基线';
            }
            if (retainLock) status = 'NEEDS_ATTENTION';
            if (activated && !restored)
              error += '。新版本已切换，请核查当前服务或按上一成功版本恢复。';
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
              if (deploymentId && !deploymentFinished)
                await this.finishDeployment(deploymentId, status, artifact?.id, health, lease);
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
  private async trackStep<T>(
    context: TaskExecutionContext,
    targetId: string,
    serverId: string,
    key: string,
    name: string,
    index: number,
    action: () => Promise<T>,
  ): Promise<T> {
    if (context.signal.aborted) throw new SshExecutionError('任务已取消', 'CANCELLED');
    const id = await context.startStep(targetId, serverId, { key, name, command: '' }, index);
    const marker = key.startsWith('node:') ? `[node:${id}] ` : '';
    context.log(`${marker}${name}\n`, serverId);
    try {
      const result = await action();
      await context.finishStep(id, 'SUCCESS', 0);
      return result;
    } catch (error) {
      await context.finishStep(
        id,
        this.builds.errorKind(error),
        commandExitCode(error),
        error instanceof Error ? error.message : '步骤失败',
      );
      throw error;
    }
  }

  private async packageTargetBuild(
    target: SshTarget,
    work: string,
    session: BuildSession,
    step: ReportPhase,
  ) {
    const { snapshot } = session;
    const { repoPath, outputPath, artifactType, registryId, imageRepository } = snapshot.definition;
    if (artifactType === 'FILE') {
      const archive = work + '/artifact.tar.gz';
      const output = await step('PACKAGE', '打包与校验文件产物', () =>
        this.builds.remoteCapture(target, packScript(work, repoPath, outputPath, archive), session),
      );
      const metadata = archiveMetadata(output);
      const storageKey = await step('ARTIFACT', '保存并校验构建产物', () =>
        this.builds.retainRemoteArchive(
          target,
          archive,
          metadata.checksum,
          metadata.sizeBytes,
          session,
        ),
      );
      return this.artifacts.create(snapshot, {
        storageType: 'LOCAL_FILE',
        storageKey,
        serverId: target.id,
        ...metadata,
      });
    }
    const composeYaml = await step('PACKAGE', '归档 Compose 配置', () =>
      this.builds.remoteComposeSnapshot(target, work, session),
    );
    if (snapshot.deployAfterBuild && registryId && imageRepository) {
      const image = await step('IMAGE', '构建镜像、推送并固定Digest', () =>
        this.targetImage(target, work, session),
      );
      return this.artifacts.create(snapshot, {
        storageKey: image.reference,
        imageReference: image.reference,
        imageDigest: image.digest,
        imageTag: image.tag,
        ...image.archive,
        composeYaml,
        serverId: target.id,
      });
    }
    const image = await step('IMAGE', '构建并记录本地Docker镜像', () =>
      this.builds.remoteBuildOnlyImage(target, work, session),
    );
    return this.artifacts.create(snapshot, {
      ...image,
      composeYaml,
      storageKey: image.imageReference,
      storageType: 'REMOTE_IMAGE',
      serverId: target.id,
    });
  }
  private async finishDeployment(
    id: string,
    status: TaskStatus,
    artifactId: string | undefined,
    health: DeploymentHealth,
    lease: DeploymentLease,
  ) {
    if ((await this.deployments.finish(id, status, artifactId, health, lease)) === false)
      throw new TaskLeaseUnavailableError();
  }

  private hasHealthCheck(snapshot: PipelineSnapshot) {
    const { definition, releasePolicy } = snapshot;
    return Boolean(
      definition.healthCheckCommand ||
      releasePolicy?.healthCheck.httpUrl ||
      (definition.artifactType === 'DOCKER_IMAGE' && releasePolicy?.healthCheck.compose),
    );
  }

  private async checkReleaseHealth(
    target: SshTarget,
    work: string,
    session: BuildSession,
    compose?: ComposeRelease,
  ) {
    const { definition, releasePolicy } = session.snapshot;
    const policy = releasePolicy?.healthCheck;
    const timeout = policy?.timeoutSeconds ?? 120;
    const checks: (() => Promise<unknown>)[] = [];
    if (definition.healthCheckCommand) {
      checks.push(() =>
        this.inRelease(
          target,
          work,
          definition.healthCheckCommand,
          session,
          '健康检查未通过。请检查服务状态、监听地址和健康检查命令',
          timeout,
        ),
      );
    }
    if (policy?.httpUrl) {
      const command = httpHealthCheck(policy.httpUrl, timeout);
      checks.push(() =>
        this.builds.remote(target, command, session, timeout + 5, 'HTTP 健康检查未通过'),
      );
    }
    if (policy?.compose && compose) {
      const command = composeHealthCheck(compose.compose, compose.docker);
      checks.push(() =>
        this.builds.remote(target, command, session, timeout, 'Compose 健康检查未通过'),
      );
    }
    await waitForReleaseHealth(checks, policy, session.context.signal, (message) =>
      session.context.log(message, target.id),
    );
  }

  private async restoreRelease(
    target: SshTarget,
    targetId: string,
    lease: DeploymentLease,
    work: string,
    forward: BuildSession,
    candidate: RollbackCandidate,
    failedDeploymentId: string,
    forwardActivated: boolean,
  ) {
    const previous = candidate.snapshot;
    if (
      posix.normalize(previous.definition.deployPath) !==
      posix.normalize(forward.snapshot.definition.deployPath)
    )
      throw new ConflictException('历史发布使用不同的部署路径，需要人工恢复');
    if (!this.hasHealthCheck(previous))
      throw new ConflictException('历史发布缺少可验证的健康检查，需要人工恢复');
    const releaseKey = randomUUID();
    const snapshot: PipelineSnapshot = {
      ...previous,
      runId: forward.snapshot.runId,
      mode: 'DEPLOY_ARTIFACT',
      releaseKey,
      rollbackOfDeploymentId: failedDeploymentId,
      expectedCurrentDeploymentId: undefined,
      releasePolicy: previous.releasePolicy && { ...previous.releasePolicy, rollbackMode: 'OFF' },
    };
    const id = await this.deployments.start(
      snapshot,
      target.id,
      targetId,
      lease,
      candidate.artifactId,
    );
    let health: DeploymentHealth = 'NOT_CHECKED';
    try {
      const artifact = await this.artifacts.forDeployment(snapshot, target.id);
      const resolved = await this.builds.resolveVariables(snapshot);
      const session: BuildSession = {
        snapshot,
        taskId: releaseKey,
        context: forward.context,
        variables: resolved.values,
        secrets: resolved.secrets,
      };
      const rollbackWork = `${work}/rollback`;
      await this.builds.remote(
        target,
        `set -eu; umask 077; mkdir -- ${q(rollbackWork)}`,
        session,
        30,
      );
      let compose: ComposeRelease | undefined;
      if (snapshot.definition.artifactType === 'FILE') {
        if (!artifact.localArchive || !artifact.checksum)
          throw new ConflictException('缺少已校验的回滚文件归档');
        const archive = `${rollbackWork}/artifact.tar.gz`;
        await this.ssh.upload(target, artifact.localArchive, archive, {
          timeout: 300,
          signal: session.context.signal,
        });
        await this.prepareFileRelease(target, archive, artifact.checksum, session);
        await this.activateFileRelease(
          target,
          rollbackWork,
          session,
          forwardActivated ? forward : undefined,
        );
      } else {
        if (!artifact.imageReference) throw new ConflictException('缺少已校验的回滚镜像');
        compose = await this.prepareComposeRelease(
          target,
          rollbackWork,
          artifact.imageReference,
          session,
          undefined,
          artifact,
        );
        await this.activateComposeRelease(target, session, compose);
      }
      await this.deployments.markActivated(id, lease);
      if (snapshot.definition.startCommand)
        await this.inRelease(
          target,
          rollbackWork,
          snapshot.definition.startCommand,
          session,
          '回滚启动命令失败',
        );
      health = 'UNKNOWN';
      await this.checkReleaseHealth(target, rollbackWork, session, compose);
      health = 'HEALTHY';
    } catch (error) {
      if (error instanceof TaskLeaseUnavailableError) throw error;
      if (health === 'UNKNOWN' && error instanceof BuildCommandError) health = 'FAILED';
      await this.finishDeployment(id, 'NEEDS_ATTENTION', candidate.artifactId, health, lease);
      throw error;
    }
    await this.finishDeployment(id, 'SUCCESS', candidate.artifactId, health, lease);
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
  private async activateFileRelease(
    target: SshTarget,
    work: string,
    session: BuildSession,
    stoppedRelease?: BuildSession,
  ) {
    const stopCommand = stoppedRelease?.snapshot.definition.stopCommand;
    let stop = '';
    if (stopCommand && stoppedRelease) {
      const path = session.snapshot.definition.deployPath;
      const current = q(`${path}/current`);
      const envFile = `${work}/stop.env`;
      await this.uploadReleaseEnvironment(target, envFile, stoppedRelease);
      stop = `if test -e ${current} || test -L ${current}; then
  previous=$(readlink -- ${current})
  version=\${previous#releases/}
  test "$previous" = "releases/$version"
  case "$version" in ''|*[!a-fA-F0-9-]*) exit 1 ;; esac
  test ! -L ${q(path + '/releases/')}"$version"
  test -d ${current}
  ( . ${q(envFile)}; cd ${current}; ${stopCommand}
  )
fi
`;
    }
    await this.builds.remote(
      target,
      `set -eu\n${stop}${this.switchRelease(session)}`,
      stoppedRelease && stoppedRelease !== session
        ? { ...session, secrets: [...session.secrets, ...stoppedRelease.secrets] }
        : session,
      stop ? 120 : 30,
      stop ? '文件发布停止或切换失败，请检查服务运行状态和发布链接' : undefined,
    );
  }
  private async activateComposeRelease(
    target: SshTarget,
    session: BuildSession,
    { compose, docker, image, imageId }: ComposeRelease,
  ) {
    await this.builds.remote(
      target,
      `set -eu\n${compose} up -d --no-build${imageId ? ' --pull never' : ''}\n${verifyComposeImage(compose, docker, image, imageId)}\n${this.switchRelease(session)}`,
      session,
      600,
      'Compose 发布激活失败。请检查宿主机端口占用、Compose 容器状态和当前版本链接',
    );
  }
  private async targetImage(target: SshTarget, work: string, session: BuildSession) {
    const d = session.snapshot.definition;
    const { registry, config } = await this.builds.remoteRegistryLogin(target, work, session);
    const repository = `${registry.registryUrl}/${d.imageRepository}`;
    const tag = registryImageTag(session, target.id);
    const image = `${repository}:${tag}`;
    await this.builds.remote(
      target,
      `set -eu; ${enterRepositoryDirectory(work, d.repoPath)}; ${resolveRepositoryFile(d.dockerfilePath)}; DOCKER_BUILDKIT=1 docker --config ${q(config)} build -f "$veyops_file" -t ${q(image)} .`,
      session,
      1200,
      'Docker 镜像构建失败。请检查 Dockerfile、基础镜像及依赖源的网络和权限',
    );
    const output = await this.builds.remoteCapture(
      target,
      `docker --config ${q(config)} push ${q(image)}`,
      session,
      1200,
      '镜像推送失败。请检查 Registry 的网络、认证和仓库写入权限',
    );
    const digest = pushedImageDigest(output, tag);
    const archive = session.snapshot.releasePolicy?.archivePushedImage
      ? await this.builds.archivePushedTargetImage(target, work, session, config, image)
      : undefined;
    return { reference: `${repository}@${digest}`, digest, tag, archive };
  }
  private async prepareComposeRelease(
    target: SshTarget,
    work: string,
    image: string,
    session: BuildSession,
    manager?: BuildOutput,
    artifact?: DeploymentArtifact,
  ) {
    if (!artifact?.imageId && !/^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(image))
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
    if (artifact?.composeYaml)
      await this.ssh.uploadContent(target, artifact.composeYaml, release + '/compose.yaml', {
        timeout: 60,
        signal: session.context.signal,
        mode: 0o600,
      });
    else if (artifact) throw new Error('缺少已归档的 Compose 配置');
    else if (manager?.localCompose)
      await this.ssh.upload(target, manager.localCompose, release + '/compose.yaml', {
        timeout: 60,
        signal: session.context.signal,
      });
    else
      await this.builds.remote(
        target,
        `set -eu; ${enterRepositoryDirectory(work, d.repoPath)}; ${resolveRepositoryFile(d.composeFilePath)}; cp -- "$veyops_file" ${q(release + '/compose.yaml')}`,
        session,
        30,
      );
    const config = work + '/docker-config';
    const project = `veyops-${s.serviceId.slice(0, 8)}-${s.environmentId.slice(0, 8)}`;
    const docker = `docker --config ${q(config)}`;

    const configure = async (reference: string) => {
      const env = serializeComposeEnvironment({ ...session.variables, VEYOPS_IMAGE: reference });
      await this.ssh.uploadContent(target, env, release + '/.env', {
        timeout: 30,
        signal: session.context.signal,
        mode: 0o600,
      });
      const compose = `VEYOPS_IMAGE=${q(reference)} ${docker} compose --project-name ${q(project)} --env-file ${q(release + '/.env')} -f ${q(release + '/compose.yaml')}`;
      const images = (
        await this.builds.remoteCapture(
          target,
          `${compose} config --images`,
          session,
          30,
          'Compose 配置解析失败。请检查 Compose 文件、环境变量和 Compose v2 版本',
        )
      )
        .trim()
        .split(/\s+/);
      if (!images.includes(reference))
        throw new Error('Compose必须通过 ${VEYOPS_IMAGE} 使用本次固定镜像');
      return { compose, images };
    };

    const offline = async (error: unknown): Promise<ComposeRelease> => {
      if (
        !(error instanceof BuildCommandError) ||
        !artifact?.offlineImage ||
        session.context.signal.aborted
      )
        throw error;
      const { reference, imageId, platform, readArchive } = artifact.offlineImage;
      session.context.log(`Registry 不可用，校验离线镜像归档 ${image} (${platform})\n`);
      await this.builds.remote(
        target,
        `set -eu; umask 077; mkdir -p -- ${q(config)}; test "$(${docker} version --format '{{.Server.Os}}/{{.Server.Arch}}')" = ${q(platform)}`,
        session,
        30,
        '离线归档的镜像平台与目标 Docker 主机不匹配',
      );
      const archive = await readArchive();
      const { compose, images } = await configure(reference);
      await this.loadArchivedImage(
        target,
        work,
        docker,
        { id: artifact.id, ...archive, imageReference: reference, imageId },
        session,
        platform,
      );
      await this.builds.remote(
        target,
        `${docker} image inspect -- ${[...new Set(images)].map(q).join(' ')} >/dev/null`,
        session,
        30,
        '离线 Compose 还需要目标预先缓存其余镜像',
      );
      session.context.log(`离线归档镜像已校验，使用 ${reference} (${imageId}) 激活\n`);
      return { compose, docker, image: reference, imageId };
    };

    if (d.registryId || !artifact?.imageId) {
      try {
        await this.builds.remoteRegistryLogin(target, work, session);
      } catch (error) {
        return offline(error);
      }
    } else await this.builds.remote(target, `umask 077; mkdir -- ${q(config)}`, session, 30);
    const { compose } = await configure(image);
    if (artifact?.imageId) await this.loadArchivedImage(target, work, docker, artifact, session);
    try {
      await this.builds.remote(
        target,
        `${compose} pull${artifact?.imageId ? ' --policy missing' : ''}`,
        session,
        600,
        'Compose 镜像拉取失败。请检查目标主机到 Registry 的网络、凭据和镜像是否可用',
      );
    } catch (error) {
      return offline(error);
    }
    return { compose, docker, image, imageId: artifact?.imageId };
  }
  private async loadArchivedImage(
    target: SshTarget,
    work: string,
    docker: string,
    artifact: DeploymentArtifact,
    session: BuildSession,
    platform?: string,
  ) {
    const { localArchive, checksum, imageId, imageReference } = artifact;
    if (!localArchive || !checksum || !imageId || !imageReference)
      throw new Error('缺少已校验的 Docker 镜像归档');
    const archive = work + '/image.tar.gz';
    await this.ssh.upload(target, localArchive, archive, {
      timeout: 300,
      signal: session.context.signal,
    });
    const inspect = platform ? '{{.Id}} {{.Os}}/{{.Architecture}}' : '{{.Id}}';
    await this.builds.remote(
      target,
      `set -eu
printf '%s  %s\\n' ${q(checksum)} ${q(archive)} | sha256sum -c -
${docker} image load --input ${q(archive)}
test "$(${docker} image inspect --format ${q(inspect)} ${q(imageReference)})" = ${q(platform ? `${imageId} ${platform}` : imageId)}`,
      session,
      600,
      '从归档加载镜像失败或镜像 ID 不一致',
    );
  }
  private async inRelease(
    target: SshTarget,
    work: string,
    command: string,
    session: BuildSession,
    failureMessage: string,
    timeout = 120,
  ) {
    const envFile = work + '/runtime.env';
    await this.uploadReleaseEnvironment(target, envFile, session);
    await this.builds.remote(
      target,
      `set -eu; . ${q(envFile)}; cd ${q(session.snapshot.definition.deployPath + '/current')}; ${command}`,
      session,
      timeout,
      failureMessage,
    );
  }
  private async uploadReleaseEnvironment(
    target: SshTarget,
    envFile: string,
    session: BuildSession,
  ) {
    const env = Object.entries(session.variables)
      .map(([k, v]) => `export ${k}=${q(v)}`)
      .join('\n');
    await this.ssh.uploadContent(target, env + '\n', envFile, {
      timeout: 30,
      signal: session.context.signal,
      mode: 0o600,
    });
  }
}
