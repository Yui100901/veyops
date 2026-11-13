import { Injectable } from '@nestjs/common';
import { SshExecutionError, SshService, SshTarget } from '../../infrastructure/ssh/ssh.service';
import {
  BuildCommandError,
  BuildsService,
  BuildSession,
  packScript,
} from '../builds/builds.service';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { DeploymentsService } from '../deployments/deployments.service';
import type { TaskExecutionContext, TaskRecord, TaskStatus } from '../tasks/tasks.types';
import type { BuildOutput, PipelineArtifact } from './pipeline.types';
import { deploymentGuard, shellQuote as q } from './pipeline.validation';
import { serializeComposeEnvironment } from './environment.serialization';

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
    try {
      if (snapshot.definition.buildLocation === 'MANAGER') {
        // Manager executes exactly once, before any target deploys the same immutable artifact.
        context.log('管理端隔离构建开始（Docker，无宿主机脚本执行）\n');
        try {
          manager = await this.builds.manager(session);
        } catch (error) {
          const status = this.builds.errorKind(error);
          const message = error instanceof Error ? error.message : '管理端构建失败';
          for (const target of task.payload.targets) {
            const id = await context.startTarget(target.id);
            await context.finishTarget(id, status, null, message);
          }
          context.log(`管理端构建未完成，未开始任何部署：${message}\n`);
          return;
        }
        managerArtifact = await this.artifacts.create(snapshot, {
          storageKey: manager.localArchive ?? manager.imageReference!,
          checksum: manager.checksum,
          sizeBytes: manager.sizeBytes,
          imageDigest: manager.imageDigest,
          imageReference: manager.imageReference,
        });
      }
      let position = 0,
        failed = false;
      const runner = async () => {
        while (!context.signal.aborted && !(failed && task.payload.failurePolicy === 'STOP')) {
          const target = task.payload.targets[position++];
          if (!target) return;
          const targetId = await context.startTarget(target.id);
          const deploymentId = await this.deployments.start(snapshot, target.id, targetId);
          let artifact = managerArtifact;
          let health = 'NOT_CHECKED';
          let status: TaskStatus = 'SUCCESS';
          let error: string | undefined;
          let targetExitCode: number | null = 0;
          const work = `/tmp/veyops-${task.id}-${target.id}`;
          let createdWork = false;
          let stepIndex = 0;
          const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
            if (context.signal.aborted) throw new SshExecutionError('任务已取消', 'CANCELLED');
            const id = await context.startStep(
              targetId,
              target.id,
              { name, command: '' },
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
                caught instanceof BuildCommandError ? caught.exitCode : null,
                caught instanceof Error ? caught.message : '步骤失败',
              );
              throw caught;
            }
          };
          try {
            await step('准备专用工作目录', () =>
              this.builds.remote(
                target,
                `set -eu; umask 077; test ! -e ${q(work)}; test ! -L ${q(work)}; mkdir -- ${q(work)}`,
                session,
                30,
              ),
            );
            createdWork = true;
            if (snapshot.definition.buildLocation === 'TARGET') {
              await step('检出固定Git Commit', () =>
                this.builds.remoteCheckout(target, work, session),
              );
              await step('安装依赖与构建', () => this.builds.remoteBuild(target, work, session));
            }
            if (snapshot.definition.artifactType === 'FILE') {
              const archive = work + '/artifact.tar.gz';
              let checksum = manager?.checksum,
                sizeBytes = manager?.sizeBytes;
              if (manager?.localArchive) {
                const localArchive = manager.localArchive;
                await step('SFTP分发管理端产物', () =>
                  this.ssh.upload(target, localArchive, archive, {
                    timeout: 300,
                    signal: context.signal,
                  }),
                );
              } else {
                const output = await step('打包与校验文件产物', () =>
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
                const match = [...output.matchAll(/VEYOPS_ARTIFACT:([a-f0-9]{64}):(\d+)/g)].at(-1);
                if (!match) throw new Error('文件产物校验信息缺失');
                checksum = match[1];
                sizeBytes = Number(match[2]);
              }
              const persistent =
                snapshot.definition.deployPath + '/.artifacts/' + task.id + '.tar.gz';
              await step('发布文件与原子切换current', () =>
                this.fileDeploy(target, work, archive, checksum!, session),
              );
              if (!artifact)
                artifact = await this.artifacts.create(snapshot, {
                  storageKey: persistent,
                  serverId: target.id,
                  checksum,
                  sizeBytes,
                });
            } else {
              if (!manager) {
                const image = await step('构建镜像、推送并固定Digest', () =>
                  this.targetImage(target, work, session),
                );
                artifact = await this.artifacts.create(snapshot, {
                  storageKey: image.reference,
                  imageReference: image.reference,
                  imageDigest: image.digest,
                  serverId: target.id,
                });
              }
              await step('Docker Compose部署', () =>
                this.composeDeploy(target, work, artifact!.imageReference!, session, manager),
              );
            }
            if (snapshot.definition.startCommand)
              await step('启动/更新服务', () =>
                this.inRelease(target, work, snapshot.definition.startCommand, session),
              );
            if (snapshot.definition.healthCheckCommand) {
              health = 'FAILED';
              await step('健康检查', () =>
                this.inRelease(target, work, snapshot.definition.healthCheckCommand, session),
              );
              health = 'HEALTHY';
            }
          } catch (caught) {
            status = this.builds.errorKind(caught);
            targetExitCode = caught instanceof BuildCommandError ? caught.exitCode : null;
            error = caught instanceof Error ? caught.message : '部署失败';
            failed = true;
            context.log(`${status}: ${error}\n`, target.id);
          } finally {
            // Only the platform-generated /tmp directory is cleaned, never a configured deploy path.
            if (createdWork)
              await this.ssh
                .execute(target, `rm -rf -- ${q(work)}`, { timeout: 30 })
                .catch(() => context.log('临时目录清理失败，需人工检查\n', target.id));
            await this.deployments.finish(deploymentId, status, artifact?.id, health);
            await context.finishTarget(targetId, status, targetExitCode, error);
          }
        }
      };
      const count =
        task.payload.strategy === 'SEQUENTIAL'
          ? 1
          : Math.min(task.payload.maxParallel, task.payload.targets.length);
      await Promise.all(Array.from({ length: count }, runner));
    } finally {
      try {
        await manager?.cleanup();
      } catch {
        context.log('管理端临时构建目录清理失败，请检查本地磁盘\n');
      }
    }
  }
  private async fileDeploy(
    target: SshTarget,
    work: string,
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
      `set -eu\n${deploymentGuard(p, owner)}\nprintf '%s  %s\\n' ${q(checksum)} ${q(archive)} | sha256sum -c -\ntest ! -e ${q(release)}\nmkdir ${q(release)}\ntar -xzf ${q(archive)} -C ${q(release)} --no-same-owner\ncp -- ${q(archive)} ${q(p + '/.artifacts/' + session.taskId + '.tar.gz')}\nln -s ${q('releases/' + session.taskId)} ${q(p + '/.current-' + session.taskId)}\nmv -Tf -- ${q(p + '/.current-' + session.taskId)} ${q(p + '/current')}\n`,
      session,
      300,
    );
  }
  private async targetImage(target: SshTarget, work: string, session: BuildSession) {
    const d = session.snapshot.definition;
    const { registry, config } = await this.builds.remoteRegistryLogin(target, work, session);
    const image = `${registry.registryUrl}/${d.imageRepository}:${session.snapshot.commitSha}`;
    const cwd = work + '/repo/' + d.repoPath;
    await this.builds.remote(
      target,
      `set -eu; cd ${q(cwd)}; DOCKER_BUILDKIT=1 docker --config ${q(config)} build -f ${q(d.dockerfilePath)} -t ${q(image)} .; docker --config ${q(config)} push ${q(image)}`,
      session,
      1200,
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
  private async composeDeploy(
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
      `set -eu; ${deploymentGuard(p, `${s.projectId}:${s.serviceId}:${s.environmentId}`)}; test ! -e ${q(release)}; mkdir ${q(release)}`,
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
    );
    if (!images.split(/\s+/).includes(image))
      throw new Error('Compose必须通过 ${VEYOPS_IMAGE} 使用本次固定Digest');
    await this.builds.remote(
      target,
      `set -eu; ${compose} pull; ${compose} up -d --no-build; ln -s ${q('releases/' + session.taskId)} ${q(p + '/.current-' + session.taskId)}; mv -Tf -- ${q(p + '/.current-' + session.taskId)} ${q(p + '/current')}`,
      session,
      600,
    );
  }
  private async inRelease(target: SshTarget, work: string, command: string, session: BuildSession) {
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
    );
  }
}
