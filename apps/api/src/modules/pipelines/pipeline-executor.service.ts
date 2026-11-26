import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { redactText } from '../../infrastructure/ssh/secret-redactor';
import { SshExecutionError, SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  BuildCommandError,
  BuildsService,
  BuildSession,
  type RunPipelineNode,
  archiveMetadata,
  namedArtifactSession,
  enterRepositoryDirectory,
  packScript,
  pushedImageDigest,
  registryImageTag,
  resolveRepositoryFile,
} from '../builds/builds.service';
import { ArtifactsService, type DeploymentArtifact } from '../artifacts/artifacts.service';
import {
  ArtifactOutputMissing,
  ArtifactPhysicalService,
} from '../artifacts/artifact-physical.service';
import { artifactIdentity } from '../artifacts/artifact-identities';
import { RepositoryMetadataService } from '../projects/repository-metadata.service';
import { DeploymentHealth, DeploymentsService } from '../deployments/deployments.service';
import { releaseScopeForTarget } from '../deployments/deployment-scope';
import { deploymentLock } from '../deployments/deployment-lock';
import type { TaskExecutionContext, TaskRecord, TaskStatus } from '../tasks/tasks.types';
import { TaskLeaseUnavailableError } from '../tasks/task-lease';
import { redactTaskLog } from '../tasks/task-log.service';
import type {
  BuildOutput,
  NamedArtifactDefinition,
  PipelineArtifact,
  PipelineSnapshot,
} from './pipeline.types';
import { isStandaloneGraphBuild } from './pipeline.types';
import {
  deploymentGuard,
  isProjectReleasePath,
  relativePath,
  shellQuote as q,
  shellWorkspacePath as remotePath,
} from './pipeline.validation';
import { serializeComposeEnvironment } from './environment.serialization';
import { createTargetWorkspace, targetWorkspacePath } from './target-workspace';
import { composeHealthCheck, httpHealthCheck, waitForReleaseHealth } from './release-health';
import type {
  ComposeReleaseEvidence,
  ComposeTemplateReference,
} from '../service-configs/compose-template-reference';
import { composeChecksum } from '../service-configs/compose-template-reference';
import { graphComposeProject } from './graph-release-context';
import { assertGraphCompose } from './graph-compose';
import {
  graphProbeResult,
  unknownGraphHealth,
  type GraphProbeResult,
} from './graph-release-health';

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

type ComposeRelease = {
  compose: string;
  docker: string;
  image: string;
  imageId?: string;
  template?: ComposeTemplateReference;
  composeProject?: string;
  dockerEngineId?: string;
};
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
    @Optional() private readonly physical?: ArtifactPhysicalService,
    @Optional() private readonly metadata?: RepositoryMetadataService,
  ) {}
  async checkGraphRelease(
    projectId: string,
    serverId: string,
    deploymentId: string,
    command: string,
    timeoutSeconds: number,
    context: TaskExecutionContext,
    taskId: string,
  ): Promise<GraphProbeResult> {
    let result = unknownGraphHealth('健康状态尚未核对');
    let locked = false;
    let checkedIdentity = false;
    let lock: ReturnType<typeof deploymentLock> | undefined;
    let target: SshTarget | undefined;
    try {
      await this.deployments.assertGraphHealthRequester(taskId, projectId, serverId);
      const release = await this.deployments.graphHealthRelease(projectId, serverId, deploymentId);
      target = release.target;
      lock = deploymentLock(release.snapshot);
      const acquire = await this.ssh.execute(target, lock.acquire, {
        timeout: 30,
        signal: context.signal,
      });
      if (acquire.signal || acquire.exitCode !== 0) return unknownGraphHealth('无法取得目标发布锁');
      locked = true;
      const { snapshot } = await this.deployments.graphHealthRelease(
        projectId,
        serverId,
        deploymentId,
      );
      const path = snapshot.definition.deployPath;
      const expectedLink = `releases/${snapshot.releaseKey}`;
      const activePath = `${path}/${expectedLink}`;
      const guard = await this.ssh.execute(
        target,
        `test "$(readlink -- ${remotePath(path + '/current')})" = ${q(expectedLink)} && test "$(realpath -e -- ${remotePath(activePath)})" = ${remotePath(activePath)} && test -d ${remotePath(activePath)}`,
        { timeout: 30, signal: context.signal },
      );
      if (guard.signal || guard.exitCode !== 0) {
        result = unknownGraphHealth('目标上的活动版本与发布记录不一致');
      } else {
        const { values, secrets } = await this.builds.resolveVariables(snapshot);
        await this.deployments.assertGraphHealthRequester(taskId, projectId, serverId);
        checkedIdentity = true;
        const check = await this.ssh.execute(
          target,
          `cd -- ${remotePath(activePath)} || exit 90\n${command}`,
          {
            timeout: timeoutSeconds,
            signal: context.signal,
            secrets,
            variables: { variables: values, secretVariables: {} },
            onData: (text) => context.log(redactTaskLog(text), serverId),
          },
        );
        result = graphProbeResult(check);
      }
    } catch (error) {
      result = unknownGraphHealth(
        error instanceof SshExecutionError && error.kind === 'TIMED_OUT'
          ? '健康检查超时'
          : '无法完成健康检查，请核对目标日志',
      );
      context.log(
        `健康状态无法确认：${redactTaskLog(error instanceof Error ? error.message : '检查失败')}\n`,
        serverId,
      );
    } finally {
      // Record the observation before letting a later release or probe take the lock.
      if (checkedIdentity) {
        try {
          await this.deployments.recordGraphHealth(
            deploymentId,
            result.health === 'UNHEALTHY' ? 'FAILED' : result.health,
          );
        } catch {
          result = unknownGraphHealth('健康检查结果未能保存', result.probeExitCode);
        }
      }
      if (locked && target && lock) {
        try {
          // Release ownership even when the parent health task was canceled.
          const released = await this.ssh.execute(target, lock.release, { timeout: 30 });
          if (released.signal || released.exitCode !== 0)
            result = unknownGraphHealth('发布锁释放结果不明确', result.probeExitCode);
        } catch {
          result = unknownGraphHealth('发布锁释放结果不明确', result.probeExitCode);
        }
      }
    }
    return result;
  }

  async execute(task: TaskRecord, context: TaskExecutionContext) {
    const snapshot = task.payload.pipeline;
    if (!snapshot) throw new Error('缺少固定Pipeline快照');
    const buildOnly = snapshot.mode === 'BUILD_ONLY';
    const deployArtifact = snapshot.mode === 'DEPLOY_ARTIFACT';
    const trackedPreparation =
      deployArtifact && Boolean(snapshot.graphDeployment || snapshot.rollbackOfDeploymentId);
    const nodes = snapshot.definition.nodes;
    const packageNode = nodes?.find((node) => node.type === 'PACKAGE');
    const deployNode = nodes?.find((node) => node.type === 'DEPLOY');
    if (snapshot.triggerType && snapshot.triggerType !== 'MANUAL') {
      if (!snapshot.graphAutomation && snapshot.definition.buildLocation !== 'MANAGER')
        throw new Error('自动任务必须使用隔离管理端构建环境');
      if (
        Object.keys(snapshot.secretVariables).length ||
        nodes?.some((node) => node.variables?.some((v) => v.credentialId))
      )
        throw new Error('自动任务不能使用敏感环境变量');
      if (
        !buildOnly &&
        !(deployArtifact && snapshot.sourceBuildTaskId && snapshot.deploymentArtifacts?.length)
      )
        throw new Error('自动发布必须引用已归档产物和来源构建任务');
    }
    if (buildOnly && (snapshot.graphAutomation || snapshot.graph?.trigger?.kind))
      await this.deployments.assertAutomaticDelivery(task.id, snapshot, task.payload.targets);
    if (buildOnly) await this.deployments.assertGraphBuildGate(task.id, snapshot);
    const siblingCancellation = new AbortController();
    context = { ...context, signal: AbortSignal.any([context.signal, siblingCancellation.signal]) };
    const lease = context.leaseOwner ? { taskId: task.id, owner: context.leaseOwner } : undefined;
    if (buildOnly) context.log('构建并保留产物\n');
    else {
      try {
        await this.deployments.assertApproval(task.id, snapshot, task.payload.targets);
        if (
          snapshot.releasePolicy &&
          snapshot.releasePolicy.rollbackMode !== 'OFF' &&
          !this.hasHealthCheck(snapshot)
        )
          throw new ConflictException('启用自动回滚需要配置发布健康检查');
      } catch (error) {
        if (
          !(snapshot.graphAutomation || trackedPreparation) ||
          !(error instanceof HttpException) ||
          error.getStatus() >= 500
        )
          throw error;
        const prefix = snapshot.graphAutomation ? '自动发布复核失败' : '发布复核失败';
        await this.failReleasePreflight(task, context, `${prefix}：${error.message}`);
        return;
      }
    }
    const deploymentInputs = new Map<string, DeploymentArtifact>();
    const preparingTargets = new Map<string, string>();
    if (deployArtifact) {
      context.log('校验已归档的部署产物\n');
      let shared: DeploymentArtifact | undefined;
      try {
        for (const target of task.payload.targets) {
          if (context.signal.aborted) return;
          if (trackedPreparation && !shared)
            preparingTargets.set(target.id, await context.startTarget(target.id));
          const artifact =
            shared ?? (await this.artifacts.forDeployment(snapshot, target.id, target));
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
        await this.failReleasePreflight(
          task,
          context,
          `产物校验失败，未开始部署：${error.message}`,
          trackedPreparation ? preparingTargets : undefined,
        );
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
        const saveManagerArtifact = async (output: BuildOutput) => {
          for (const entry of output.artifacts ?? [{ output, declaration: undefined }]) {
            const artifact = await this.artifacts.create(snapshot, {
              storageKey: entry.output.localArchive ?? entry.output.imageReference!,
              archiveKey: entry.output.archiveKey,
              archiveImageId: entry.output.archiveImageId,
              archiveImagePlatform: entry.output.archiveImagePlatform,
              composeYaml: entry.output.composeYaml,
              checksum: entry.output.checksum,
              sizeBytes: entry.output.sizeBytes,
              imageDigest: entry.output.imageDigest,
              imageReference: entry.output.imageReference,
              imageTag: entry.output.imageTag,
              imageId: entry.output.imageId,
              storageType: entry.output.imageId ? 'LOCAL_IMAGE' : undefined,
              name: entry.declaration?.name,
              kind: entry.declaration?.type,
              persist: entry.declaration?.persist,
              physical: entry.output.physical,
            });
            managerArtifact ??= artifact;
          }
        };
        const first = task.payload.targets.at(0);
        if (context.signal.aborted) return;
        if (!first) {
          if (!isStandaloneGraphBuild(snapshot)) throw new Error('管理端构建快照缺少目标');
          manager = await this.builds.manager(session, undefined, saveManagerArtifact);
          if (!managerArtifact) await saveManagerArtifact(manager);
          return;
        }
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
      const sessionForTarget = (serverId: string): BuildSession => {
        const scoped = releaseScopeForTarget(snapshot, serverId);
        return scoped === snapshot ? session : { ...session, snapshot: scoped };
      };
      let position = 0,
        failed = false;
      const runner = async () => {
        while (!context.signal.aborted && !(failed && task.payload.failurePolicy === 'STOP')) {
          const target = task.payload.targets[position++];
          if (!target) return;
          const session = sessionForTarget(target.id);
          const { snapshot } = session;
          const managerBuilt = managerTarget?.serverId === target.id;
          const preparedTargetId = preparingTargets.get(target.id);
          preparingTargets.delete(target.id);
          const targetId =
            managerBuilt && managerTarget
              ? managerTarget.targetId
              : (preparedTargetId ?? (await context.startTarget(target.id)));
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
          const workName = `veyops-${task.id}-${target.id}`;
          let work = `/tmp/${workName}`;
          let createdWork = false;
          let activeDockerEngineId: string | undefined;
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
            const active =
              snapshot.graphDeployment || snapshot.definition.artifactType === 'FILE'
                ? await this.deployments.activeSnapshot(snapshot, target.id)
                : undefined;
            if (snapshot.graphDeployment && active) {
              if (
                active.definition.artifactType !== snapshot.definition.artifactType ||
                (snapshot.graphDeployment.method === 'COMPOSE' && !active.graphDeployment)
              )
                throw new ConflictException(
                  '部署路径已由其他部署方式或 Compose 项目使用，请先核查',
                );
              currentReleaseKey = active.releaseKey;
              activeDockerEngineId = active.composeRelease?.dockerEngineId;
            }
            if (snapshot.definition.artifactType === 'FILE') {
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
                  `readlink -- ${remotePath(currentPath)}`,
                  session,
                  30,
                );
                if (link.trim() !== `releases/${currentReleaseKey}`)
                  throw new BuildCommandError(1, '远端当前发布与已记录版本不一致，请先核查');
              });
            } else if (snapshot.graphDeployment) {
              const current = remotePath(`${snapshot.definition.deployPath}/current`);
              await step('PREPARE', '确认部署位置没有其他当前版本', () =>
                this.builds.remote(
                  target,
                  `test ! -e ${current} && test ! -L ${current}`,
                  session,
                  30,
                  '远端已有未登记的当前版本，请核查部署位置',
                ),
              );
            }
            deploymentId = await this.deployments.start(
              {
                ...snapshot,
                releaseKey: task.id,
                ...(snapshot.graphRollback && {
                  rollbackOfDeploymentId: snapshot.graphRollback[target.id],
                  expectedCurrentDeploymentId: snapshot.graphRollback[target.id],
                }),
              },
              target.id,
              targetId,
              lease,
              artifact?.id,
            );
          };
          const activate = async (
            name: string,
            action: () => Promise<void | ComposeReleaseEvidence>,
          ) => {
            await step('DEPLOY', name, async () => {
              await this.deployments.assertApproval(task.id, snapshot, task.payload.targets);
              let evidence: void | ComposeReleaseEvidence;
              try {
                evidence = await action();
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
              await this.deployments.markActivated(deploymentId!, lease, evidence ?? undefined);
            });
          };
          try {
            // A manager-only build produces a single artifact without opening target SSH connections.
            if (buildOnly && manager) continue;
            if (
              snapshot.definition.artifactType === 'DOCKER_IMAGE' ||
              (!deployArtifact &&
                snapshot.definition.artifacts?.some((output) => output.type === 'DOCKER_IMAGE'))
            )
              await step('PREPARE', '检查目标主机 Docker 环境', () =>
                this.builds.checkTargetDocker(target, session, !buildOnly),
              );
            await step('PREPARE', '准备专用工作目录', async () => {
              if (
                !deployArtifact &&
                snapshot.definition.buildLocation === 'TARGET' &&
                snapshot.targetWorkspaceRoot
              ) {
                const output = await this.builds.remoteCapture(
                  target,
                  createTargetWorkspace(snapshot.targetWorkspaceRoot, workName),
                  session,
                  30,
                  '创建目标端构建工作目录失败，请检查配置路径和 SSH 用户权限',
                );
                work = targetWorkspacePath(output, workName);
                return;
              }
              await this.builds.remote(
                target,
                `set -eu; umask 077; test ! -e ${q(work)}; test ! -L ${q(work)}; mkdir -- ${q(work)}`,
                session,
                30,
              );
            });
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
              const packageBuild = async () => {
                const report = packageNode
                  ? async <T>(_phase: string, _name: string, run: () => Promise<T>) => run()
                  : step;
                if (!snapshot.definition.artifacts)
                  return this.packageTargetBuild(target, work, session, report);
                let first: PipelineArtifact | undefined;
                for (const declaration of snapshot.definition.artifacts) {
                  try {
                    const output = await this.packageTargetBuild(
                      target,
                      work,
                      namedArtifactSession(session, declaration),
                      report,
                      declaration,
                    );
                    first ??= output;
                  } catch (error) {
                    if (
                      declaration.required !== false ||
                      !(
                        error instanceof ArtifactOutputMissing ||
                        (error instanceof BuildCommandError && error.exitCode === 44)
                      )
                    )
                      throw error;
                    context.log(`可选产物 ${declaration.name} 不存在，已略过\n`, target.id);
                  }
                }
                return first;
              };
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
                if (
                  deploymentInput?.physical?.location === 'SERVER_PATH' ||
                  (deploymentInput?.physical?.location === 'BUILDER_PATH' &&
                    snapshot.graphDeployment?.artifactPath)
                ) {
                  ({ checksum, sizeBytes } = await step('TRANSFER', '校验并准备所选文件产物', () =>
                    this.transferGraphFileArtifact(
                      deploymentInput,
                      target,
                      archive,
                      snapshot.graphDeployment?.artifactPath,
                      context.signal,
                    ),
                  ));
                } else if (localArchive) {
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
                    activeDockerEngineId,
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
            error =
              caught instanceof Error
                ? redactTaskLog(redactText(caught.message, session.secrets))
                : 'Pipeline执行失败';
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
                  const reason =
                    rollbackError instanceof Error
                      ? redactTaskLog(redactText(rollbackError.message, session.secrets))
                      : '结果未知';
                  error += `。自动回滚失败：${reason}`;
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
                .execute(
                  target,
                  `test ! -L ${q(work)} && test "$(cd -P -- ${q(work)} && pwd -P)" = ${q(work)} && rm -rf -- ${q(work)}`,
                  { timeout: 30 },
                )
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
      if (!context.signal.aborted) {
        for (const id of preparingTargets.values())
          await context.finishTarget(id, 'CANCELLED', null, '因失败停止策略未开始部署');
      }
    } finally {
      try {
        await manager?.cleanup();
      } catch {
        context.log('管理端临时构建目录清理失败，请检查本地磁盘\n');
      }
    }
  }

  private async failReleasePreflight(
    task: TaskRecord,
    context: TaskExecutionContext,
    reason: string,
    preparingTargets?: ReadonlyMap<string, string>,
  ) {
    const summary = redactTaskLog(reason);
    context.log(`${summary}\n`);
    for (const target of task.payload.targets) {
      if (context.signal.aborted) return;
      const id = preparingTargets
        ? preparingTargets.get(target.id)
        : await context.startTarget(target.id);
      if (id) await context.finishTarget(id, 'FAILED', null, summary);
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
    declaration?: NamedArtifactDefinition,
  ) {
    const { snapshot } = session;
    const { repoPath, outputPath, artifactType, registryId, imageRepository } = snapshot.definition;
    if (artifactType === 'FILE') {
      if (snapshot.graph && this.physical) {
        let kind =
          declaration?.type === 'FILE' || declaration?.type === 'DIRECTORY'
            ? declaration.type
            : undefined;
        if (!kind) {
          const kindFromWorkspace = await this.builds.remoteCapture(
            target,
            `set -eu; ${enterRepositoryDirectory(work, repoPath)}; path=${q(relativePath(outputPath))}; if test -f "$path"; then printf FILE; elif test -d "$path"; then printf DIRECTORY; else exit 44; fi`,
            session,
          );
          kind = kindFromWorkspace.trim() === 'FILE' ? 'FILE' : 'DIRECTORY';
        }
        const physical = await step('ARTIFACT', '在构建服务器保存并校验产物', () =>
          this.physical!.collectServerPath({
            target,
            workspace: posix.join(work, 'repo'),
            workingDirectory: repoPath,
            relativePath: outputPath,
            collection: declaration?.collection,
            excludePaths: declaration?.excludePaths,
            kind,
            instanceId: artifactIdentity(snapshot, declaration?.name, target.id).instanceId,
            signal: session.context.signal,
          }),
        );
        return this.artifacts.create(snapshot, {
          storageType: 'REMOTE_FILE',
          storageKey: physical.path!,
          serverId: target.id,
          kind,
          name: declaration?.name,
          persist: declaration?.persist,
          physical,
          checksum: physical.sha256,
          sizeBytes: physical.sizeBytes,
        });
      }
      const archive =
        work + (declaration ? `/artifact-${session.taskId}.tar.gz` : '/artifact.tar.gz');
      const output = await step('PACKAGE', '打包与校验文件产物', () =>
        this.builds.remoteCapture(
          target,
          packScript(
            work,
            repoPath,
            outputPath,
            archive,
            declaration?.type === 'DOCKER_IMAGE' ? undefined : declaration?.type,
          ),
          session,
        ),
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
        name: declaration?.name,
        kind: declaration?.type,
        ...metadata,
      });
    }
    const composeYaml = await step('PACKAGE', '归档 Compose 配置', () =>
      this.builds.remoteComposeSnapshot(target, work, session),
    );
    if ((snapshot.deployAfterBuild || snapshot.graph) && registryId && imageRepository) {
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
        name: declaration?.name,
        kind: declaration?.type,
        persist: declaration?.persist,
        physical: snapshot.graph
          ? {
              kind: 'DOCKER_IMAGE',
              location: 'REGISTRY',
              owner: 'EXTERNAL',
              imageReference: image.reference,
              digest: image.digest,
              registryId,
            }
          : undefined,
      });
    }
    const image = await step('IMAGE', '构建并记录本地Docker镜像', () =>
      this.builds.remoteBuildOnlyImage(target, work, session, declaration),
    );
    return this.artifacts.create(snapshot, {
      ...image,
      composeYaml,
      storageKey: image.imageReference,
      storageType: 'REMOTE_IMAGE',
      serverId: target.id,
      name: declaration?.name,
      kind: declaration?.type,
      persist: declaration?.persist,
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
    const originalArtifact = previous.deploymentArtifacts?.find(
      ({ id }) => id === candidate.artifactId,
    );
    if (!originalArtifact) throw new ConflictException('历史发布缺少所选产物的固定引用');
    const releaseKey = randomUUID();
    const snapshot: PipelineSnapshot = {
      ...previous,
      runId: forward.snapshot.runId,
      mode: 'DEPLOY_ARTIFACT',
      deploymentArtifacts: [originalArtifact],
      releaseKey,
      rollbackOfDeploymentId: failedDeploymentId,
      expectedCurrentDeploymentId: undefined,
      releasePolicy: previous.releasePolicy && { ...previous.releasePolicy, rollbackMode: 'OFF' },
    };
    await this.deployments.assertSourceReview(snapshot);
    const id = await this.deployments.start(
      snapshot,
      target.id,
      targetId,
      lease,
      candidate.artifactId,
    );
    let health: DeploymentHealth = 'NOT_CHECKED';
    try {
      const artifact = await this.artifacts.forDeployment(snapshot, target.id, target);
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
      let composeEvidence: ComposeReleaseEvidence | undefined;
      if (snapshot.definition.artifactType === 'FILE') {
        const archive = `${rollbackWork}/artifact.tar.gz`;
        let checksum = artifact.checksum;
        if (
          artifact.physical?.location === 'SERVER_PATH' ||
          (artifact.physical?.location === 'BUILDER_PATH' && snapshot.graphDeployment?.artifactPath)
        ) {
          ({ checksum } = await this.transferGraphFileArtifact(
            artifact,
            target,
            archive,
            snapshot.graphDeployment?.artifactPath,
            session.context.signal,
          ));
        } else {
          if (!artifact.localArchive || !checksum)
            throw new ConflictException('缺少已校验的回滚文件归档');
          await this.ssh.upload(target, artifact.localArchive, archive, {
            timeout: 300,
            signal: session.context.signal,
          });
        }
        await this.prepareFileRelease(target, archive, checksum, session);
        await this.deployments.assertSourceReview(snapshot);
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
        await this.deployments.assertSourceReview(snapshot);
        composeEvidence = await this.activateComposeRelease(target, session, compose);
      }
      await this.deployments.markActivated(id, lease, composeEvidence);
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
    const archiveLegacyBuild = isProjectReleasePath(p)
      ? ''
      : `cp -- ${q(archive)} ${remotePath(p + '/.artifacts/' + session.taskId + '.tar.gz')}\n`;
    await this.builds.remote(
      target,
      `set -eu\n${deploymentGuard(p, owner)}\nprintf '%s  %s\\n' ${q(checksum)} ${q(archive)} | sha256sum -c -\ntest ! -e ${remotePath(release)} && test ! -L ${remotePath(release)}\nmkdir ${remotePath(release)}\ntar -xzf ${q(archive)} -C ${remotePath(release)} --no-same-owner\n${archiveLegacyBuild}`,
      session,
      300,
    );
  }
  private switchRelease(session: BuildSession) {
    const path = session.snapshot.definition.deployPath;
    const next = `${path}/.current-${session.taskId}`;
    return `ln -s ${q('releases/' + session.taskId)} ${remotePath(next)}; mv -Tf -- ${remotePath(next)} ${remotePath(path + '/current')}`;
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
      const current = remotePath(`${path}/current`);
      const envFile = `${work}/stop.env`;
      await this.uploadReleaseEnvironment(target, envFile, stoppedRelease);
      stop = `if test -e ${current} || test -L ${current}; then
  previous=$(readlink -- ${current})
  version=\${previous#releases/}
  test "$previous" = "releases/$version"
  case "$version" in ''|*[!a-fA-F0-9-]*) exit 1 ;; esac
  test ! -L ${remotePath(path + '/releases/')}"$version"
  test -d ${current}
  ( cd ${current}; . ${q(envFile)}; ${stopCommand}
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
    { compose, docker, image, imageId, template, composeProject, dockerEngineId }: ComposeRelease,
  ) {
    const engineGuard = dockerEngineId
      ? `test "$(${docker} info --format '{{.ID}}')" = ${q(dockerEngineId)}\n`
      : '';
    const action = `set -eu\n${engineGuard}${compose} up -d --no-build${imageId ? ' --pull never' : ''}\n${verifyComposeImage(compose, docker, image, imageId)}\n${this.switchRelease(session)}`;
    const failure = 'Compose 发布激活失败。请检查宿主机端口占用、Compose 容器状态和当前版本链接';
    if (!template) {
      await this.builds.remote(target, action, session, 600, failure);
      return;
    }
    const output = await this.builds.remoteCapture(
      target,
      `${action}\nprintf 'VEYOPS_COMPOSE_IMAGE_ID=%s\\n' "$expected_image"`,
      session,
      600,
      failure,
    );
    const verified = /^VEYOPS_COMPOSE_IMAGE_ID=(sha256:[a-f0-9]{64})\s*$/m.exec(output)?.[1];
    if (!verified) throw new Error('Compose 激活未返回已验证的镜像 ID');
    return { template, imageReference: image, imageId: verified, composeProject, dockerEngineId };
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
    activeDockerEngineId?: string,
  ) {
    if (!artifact?.imageId && !/^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(image))
      throw new Error('Docker部署必须使用不可变Digest');
    const s = session.snapshot,
      d = s.definition,
      p = d.deployPath,
      release = p + '/releases/' + session.taskId;
    const managed = s.managedCompose ? await this.artifacts.managedCompose(s) : undefined;
    const template = s.graphDeployment?.template ?? s.managedCompose ?? artifact?.composeTemplate;
    let composeYaml = managed ?? artifact?.composeYaml;
    if (template?.source === 'REPOSITORY_FILE') {
      if (!this.metadata) throw new ConflictException('无法加载已确认的仓库 Compose 模板');
      composeYaml = await this.metadata.readGraphComposeFile(
        s.projectId,
        template.repositoryId,
        template.commitSha,
        template.path,
      );
      if (composeChecksum(composeYaml) !== template.checksum)
        throw new ConflictException('仓库 Compose 模板已与计划不一致');
    }
    if (s.graphDeployment) {
      if (!composeYaml) throw new ConflictException('缺少已确认的 Compose 模板');
      assertGraphCompose(composeYaml);
    }
    await this.builds.remote(
      target,
      `set -eu; ${deploymentGuard(p, `${s.projectId}:${s.serviceId}:${s.environmentId}`)}; test ! -e ${remotePath(release)} && test ! -L ${remotePath(release)}; mkdir ${remotePath(release)}`,
      session,
      30,
    );
    // SFTP takes literal paths. Stage uploads in the absolute task directory.
    const uploadContent = async (name: string, content: string, timeout: number) => {
      const destination = release + '/' + name;
      const upload = destination.startsWith('~/') ? work + '/' + name : destination;
      await this.ssh.uploadContent(target, content, upload, {
        timeout,
        signal: session.context.signal,
        mode: 0o600,
      });
      if (upload !== destination)
        await this.builds.remote(
          target,
          `mv -Tf -- ${q(upload)} ${remotePath(destination)}`,
          session,
          30,
        );
    };
    if (composeYaml) await uploadContent('compose.yaml', composeYaml, 60);
    else if (artifact) throw new Error('缺少已归档的 Compose 配置');
    else if (manager?.localCompose)
      await this.ssh.upload(target, manager.localCompose, release + '/compose.yaml', {
        timeout: 60,
        signal: session.context.signal,
      });
    else
      await this.builds.remote(
        target,
        `set -eu; ${enterRepositoryDirectory(work, d.repoPath)}; ${resolveRepositoryFile(d.composeFilePath)}; cp -- "$veyops_file" ${remotePath(release + '/compose.yaml')}`,
        session,
        30,
      );
    const config = work + '/docker-config';
    const composeProject = s.graphDeployment?.composeProject;
    if (s.graphDeployment && composeProject !== graphComposeProject(s))
      throw new ConflictException('Compose 项目名与已确认发布位置不一致');
    const project =
      composeProject ?? `veyops-${s.serviceId.slice(0, 8)}-${s.environmentId.slice(0, 8)}`;
    const docker = `docker --config ${q(config)}`;
    let dockerEngineId: string | undefined;
    if (s.graphDeployment) {
      dockerEngineId = (
        await this.builds.remoteCapture(target, `${docker} info --format '{{.ID}}'`, session, 30)
      ).trim();
      const physicalEngine =
        artifact?.physical?.location === 'DOCKER_ENGINE' && artifact.physical.serverId === target.id
          ? artifact.physical.engineId
          : undefined;
      if (
        !/^[A-Za-z0-9:_-]{1,180}$/.test(dockerEngineId) ||
        (activeDockerEngineId && dockerEngineId !== activeDockerEngineId) ||
        (physicalEngine && dockerEngineId !== physicalEngine)
      )
        throw new ConflictException('Docker 引擎与当前发布或已确认镜像的引擎不一致');
    }

    const configure = async (reference: string) => {
      const env = serializeComposeEnvironment({ ...session.variables, VEYOPS_IMAGE: reference });
      await uploadContent('.env', env, 30);
      const compose = `VEYOPS_IMAGE=${q(reference)} ${docker} compose --project-name ${q(project)} --env-file ${remotePath(release + '/.env')} -f ${remotePath(release + '/compose.yaml')}`;
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
      return {
        compose,
        docker,
        image: reference,
        imageId,
        template,
        composeProject,
        dockerEngineId,
      };
    };

    if (d.registryId || !artifact?.imageId) {
      try {
        await this.builds.remoteRegistryLogin(target, work, session);
      } catch (error) {
        return offline(error);
      }
    } else await this.builds.remote(target, `umask 077; mkdir -- ${q(config)}`, session, 30);
    const { compose } = await configure(image);
    if (
      artifact?.imageId &&
      artifact.physical?.location === 'DOCKER_ENGINE' &&
      artifact.physical.serverId === target.id
    ) {
      const physical = artifact.physical;
      const verified = await this.physical?.verify(physical, target, session.context.signal);
      if (verified?.status !== 'AVAILABLE')
        throw new ConflictException(verified?.reason ?? '目标端登记镜像无法验证');
      await this.builds.remote(
        target,
        `test "$(${docker} image inspect --format '{{.Id}}' -- ${q(image)})" = ${q(artifact.imageId)}`,
        session,
        30,
        '登记镜像的引用已变化，请重新选择产物',
      );
    } else if (artifact?.imageId)
      await this.loadArchivedImage(target, work, docker, artifact, session);
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
    return {
      compose,
      docker,
      image,
      imageId: artifact?.imageId,
      template,
      composeProject,
      dockerEngineId,
    };
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
  private async transferGraphFileArtifact(
    artifact: DeploymentArtifact,
    target: SshTarget,
    archive: string,
    path: string | undefined,
    signal: AbortSignal,
  ) {
    if (!artifact.physical || !this.physical) throw new ConflictException('文件产物适配器不可用');
    if (artifact.physical.location === 'SERVER_PATH' && artifact.physical.serverId === target.id)
      return this.physical.stageServerArchive(artifact.physical, target, archive, signal, path);
    if (artifact.workspaceArchive && (!path || path === '.')) {
      const { localArchive, checksum, sizeBytes } = artifact.workspaceArchive;
      await this.ssh.upload(target, localArchive, archive, { timeout: 300, signal });
      return { checksum, sizeBytes };
    }
    const directory = await mkdtemp(join(tmpdir(), 'veyops-artifact-'));
    try {
      const local = join(directory, 'artifact.tar.gz');
      const receipt = artifact.workspaceArchive
        ? await this.physical.stageArchivedWorkspace(
            artifact.physical,
            artifact.workspaceArchive,
            local,
            path!,
            signal,
          )
        : await this.physical.stageLocalPathArchive(artifact.physical, local, path, signal);
      await this.ssh.upload(target, local, archive, { timeout: 300, signal });
      return receipt;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      `set -eu; cd ${remotePath(session.snapshot.definition.deployPath + '/current')}; . ${q(envFile)}; ${command}`,
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
