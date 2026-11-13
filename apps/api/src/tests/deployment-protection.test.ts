import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SshExecutionError,
  SshService,
  type SshOptions,
  type SshTarget,
} from '../infrastructure/ssh/ssh.service';
import type { ProcessRunnerService } from '../infrastructure/build-runner/process-runner.service';
import { BuildCommandError, BuildsService } from '../modules/builds/builds.service';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import type { CredentialsService } from '../modules/credentials/credentials.service';
import type { RegistriesService } from '../modules/registries/registries.service';
import {
  DeploymentsService,
  type DeploymentHealth,
} from '../modules/deployments/deployments.service';
import { deploymentLock } from '../modules/deployments/deployment-lock';
import { PipelineExecutor } from '../modules/pipelines/pipeline-executor.service';
import { PipelineDefinitionDto } from '../modules/pipelines/pipeline.dto';
import type { PipelineSnapshot } from '../modules/pipelines/pipeline.types';
import type { TaskExecutionContext, TaskRecord, TaskStatus } from '../modules/tasks/tasks.types';

const target: SshTarget = {
  id: randomUUID(),
  name: 'isolated-test-host',
  host: 'example.invalid',
  port: 22,
  username: 'deploy',
  credentialId: randomUUID(),
  hostKeyFingerprint: 'a'.repeat(64),
};

function snapshot(): PipelineSnapshot {
  return {
    mode: 'DEPLOY',
    runId: randomUUID(),
    pipelineId: randomUUID(),
    pipelineVersionId: randomUUID(),
    projectId: randomUUID(),
    serviceId: randomUUID(),
    environmentId: randomUUID(),
    targetId: randomUUID(),
    commitSha: 'a'.repeat(40),
    repository: { url: 'https://example.invalid/test.git', credentialId: null },
    definition: {
      ...new PipelineDefinitionDto(),
      repositoryId: randomUUID(),
      deployPath: '/tmp/isolated-test-release',
      healthCheckCommand: 'test -f candidate-health-marker',
    },
    variables: {},
    secretVariables: {},
  };
}

function task(snapshot: PipelineSnapshot): TaskRecord {
  return {
    id: randomUUID(),
    type: 'PIPELINE',
    name: 'publication fixture',
    payload: {
      targets: [target],
      steps: [],
      strategy: 'SEQUENTIAL',
      failurePolicy: 'CONTINUE',
      maxParallel: 1,
      timeout: 30,
      pipeline: snapshot,
    },
  };
}

function fixture(
  remote: (command: string, options?: SshOptions) => Promise<number | void>,
  actualBuilds = false,
) {
  const commands: string[] = [];
  const logs: string[] = [];
  const statuses: TaskStatus[] = [];
  const targetResults: { exitCode: number | null; error?: string }[] = [];
  const deployments: { status: string; health: DeploymentHealth }[] = [];
  const steps: { key?: string; status?: TaskStatus; exitCode?: number | null; error?: string }[] =
    [];
  let deploymentsStarted = 0;
  const fakeBuilds = {
    resolveVariables: async () => ({ values: {}, secrets: [] }),
    remoteCheckout: async () => undefined,
    remoteBuild: async () => undefined,
    remoteCapture: async () => `VEYOPS_ARTIFACT:${'c'.repeat(64)}:1`,
    remote: async (_: SshTarget, command: string) => {
      commands.push(command);
      await remote(command);
    },
    retainRemoteArchive: async () => '/test-artifacts/fixture.tar.gz',
    errorKind: (error: unknown) => (error instanceof SshExecutionError ? error.kind : 'FAILED'),
  } as unknown as BuildsService;
  const ssh = {
    execute: async (_: SshTarget, command: string, options: SshOptions) => {
      commands.push(command);
      return { exitCode: (await remote(command, options)) ?? 0 };
    },
    uploadContent: async () => undefined,
  } as unknown as SshService;
  const artifactService = {
    create: async (_: PipelineSnapshot, artifact: { storageKey: string }) => ({
      ...artifact,
      id: randomUUID(),
    }),
  } as unknown as ArtifactsService;
  const deploymentService = {
    start: async () => {
      deploymentsStarted++;
      return randomUUID();
    },
    finish: async (_id: string, status: string, _artifactId: string, health: DeploymentHealth) => {
      deployments.push({ status, health });
      return true;
    },
  } as unknown as DeploymentsService;
  const builds = actualBuilds
    ? new BuildsService(
        ssh,
        {} as ProcessRunnerService,
        {} as CredentialsService,
        {} as RegistriesService,
      )
    : fakeBuilds;
  return {
    run: async (record: TaskRecord, signal = new AbortController().signal) => {
      const context: TaskExecutionContext = {
        signal,
        log: (message) => {
          logs.push(message);
        },
        startTarget: async () => randomUUID(),
        finishTarget: async (_id, status, exitCode, error) => {
          statuses.push(status);
          targetResults.push({ exitCode, error });
        },
        startStep: async (_id, _server, step) => {
          steps.push({ key: step.key });
          return String(steps.length - 1);
        },
        finishStep: async (id, status, exitCode, error) => {
          Object.assign(steps[Number(id)], { status, exitCode, error });
        },
      };
      return new PipelineExecutor(builds, ssh, artifactService, deploymentService).execute(
        record,
        context,
      );
    },
    commands,
    logs,
    statuses,
    targetResults,
    deployments,
    steps,
    get deploymentsStarted() {
      return deploymentsStarted;
    },
  };
}

test('the shell acquires both locks atomically and rejects release by a different owner token', async (t) => {
  const linux = process.platform === 'linux';
  const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
  const shell = linux
    ? 'sh'
    : process.platform === 'win32' && existsSync(gitBash)
      ? gitBash
      : undefined;
  if (!shell) {
    t.skip('requires Linux sh or Git Bash');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'veyops-deployment-lock-'));
  const privateNamespace = join(directory, 'locks');
  try {
    await mkdir(privateNamespace, { mode: 0o700 });
    const definition = snapshot();
    const first = deploymentLock(definition);
    const second = deploymentLock(definition);
    const otherScope = deploymentLock({ ...definition, serviceId: randomUUID() });
    // Redirect lock writes to the fixture. Git Bash emulates Windows mode bits, so supply
    // Linux stat results while exercising the actual mkdir, ownership token, and rmdir logic.
    const shellPath = privateNamespace.replace(/\\/g, '/');
    const windowsSetup = `
      stat() { case "$*" in */var/tmp) printf '%s\\n' 0:1777 ;; *) printf '%s:700\\n' "$(id -u)" ;; esac; }
      test() { if [ "$*" = '-d /var/tmp' ]; then return 0; fi; builtin test "$@"; }
    `;
    const run = (script: string) =>
      spawnSync(
        shell,
        [
          '-c',
          (linux ? '' : windowsSetup) +
            script.replaceAll('/var/tmp/.veyops-deployment-locks', shellPath),
        ],
        { encoding: 'utf8' },
      );
    assert.equal(run(first.acquire).status, 0);
    assert.equal(run(second.acquire).status, 75);
    assert.equal(run(otherScope.acquire).status, 75);
    assert.equal(run(second.release).status, 75);
    assert.equal(run(first.release).status, 0);
    assert.equal(run(otherScope.acquire).status, 0);
    assert.equal(run(otherScope.release).status, 0);
  } finally {
    // The fixture path is a direct child of the local temporary directory.
    await rm(directory, { recursive: true, force: true });
  }
});

test('deployment lock uses stable service/environment and path identities and unique ownership', () => {
  const first = snapshot();
  const redeploy = { ...first, runId: randomUUID(), pipelineId: randomUUID() };
  const otherService = { ...first, serviceId: randomUUID() };
  const otherPath = {
    ...first,
    definition: { ...first.definition, deployPath: '/tmp/another-path' },
  };
  const left = deploymentLock(first);
  const right = deploymentLock(redeploy);
  assert.equal(left.location, right.location);
  assert.notEqual(left.release, right.release);
  assert.ok(left.acquire.includes(first.runId));
  assert.equal(left.location.split('、')[1], deploymentLock(otherService).location.split('、')[1]);
  assert.equal(left.location.split('、')[0], deploymentLock(otherPath).location.split('、')[0]);
  assert.match(left.acquire, /mkdir -m 700/);
  assert.match(left.acquire, /test ! -L \/var\/tmp\/\.veyops-deployment-locks/);
  assert.match(left.release, /cat -- .+\/owner\).*rmdir --/);
  assert.doesNotMatch(left.release, /rm -rf/);
});

test('a conflicting publisher cannot activate until the first publisher finishes health checking', async () => {
  let locked = false;
  let enteredHealth!: () => void;
  let finishHealth!: () => void;
  const inHealth = new Promise<void>((resolve) => {
    enteredHealth = resolve;
  });
  const healthResult = new Promise<void>((resolve) => {
    finishHealth = resolve;
  });
  const environment = fixture(async (command) => {
    if (command.includes('Reject alias paths')) {
      if (locked) throw new BuildCommandError(75, 'busy');
      locked = true;
    } else if (command.includes('rmdir --') && command.includes('cat --')) locked = false;
    if (command.includes('candidate-health-marker')) {
      enteredHealth();
      await healthResult;
    }
  });
  const release = snapshot();
  const first = environment.run(task(release));
  try {
    await inHealth;
    await environment.run(task({ ...release, runId: randomUUID() }));
    assert.deepEqual(environment.statuses, ['FAILED']);
    assert.equal(environment.deploymentsStarted, 1);
    assert.equal(environment.commands.filter((command) => command.includes('mv -Tf')).length, 1);
    assert.equal(locked, true);
    assert.ok(environment.logs.some((line) => line.includes('已有发布锁')));
  } finally {
    finishHealth();
    await first;
  }
  assert.equal(locked, false);
  assert.deepEqual(environment.deployments, [{ status: 'SUCCESS', health: 'HEALTHY' }]);
  assert.deepEqual(environment.statuses, ['FAILED', 'SUCCESS']);
});

test('known health failure records the failed release and unlocks without automatically rolling back', async () => {
  const environment = fixture(async (command) => {
    if (command.includes('candidate-health-marker')) throw new BuildCommandError(1, 'check failed');
  });
  await environment.run(task(snapshot()));
  assert.deepEqual(environment.deployments, [{ status: 'FAILED', health: 'FAILED' }]);
  assert.deepEqual(environment.statuses, ['FAILED']);
  assert.equal(environment.commands.filter((command) => command.includes('mv -Tf')).length, 1);
  assert.equal(environment.commands.filter((command) => command.includes('rmdir --')).length, 2);
  assert.ok(
    environment.steps.some((step) => step.key === 'HEALTH_CHECK' && step.status === 'FAILED'),
  );
});

test('an interrupted health check records an unknown health result and keeps the lock', async () => {
  const environment = fixture(async (command) => {
    if (command.includes('candidate-health-marker'))
      throw new SshExecutionError('timed out', 'TIMED_OUT');
  });
  await environment.run(task(snapshot()));
  assert.deepEqual(environment.deployments, [{ status: 'NEEDS_ATTENTION', health: 'UNKNOWN' }]);
  assert.equal(environment.commands.filter((command) => command.includes('rmdir --')).length, 1);
});

test('an unconfirmed activation keeps ownership and temporary files for investigation', async () => {
  const environment = fixture(async (command) => {
    if (command.includes('mv -Tf')) throw new SshExecutionError('disconnected', 'NEEDS_ATTENTION');
  });
  await environment.run(task(snapshot()));
  assert.deepEqual(environment.deployments, [{ status: 'NEEDS_ATTENTION', health: 'NOT_CHECKED' }]);
  assert.deepEqual(environment.statuses, ['NEEDS_ATTENTION']);
  assert.equal(environment.commands.filter((command) => command.includes('rmdir --')).length, 1);
  assert.equal(
    environment.commands.some((command) => command.startsWith('rm -rf')),
    false,
  );
  assert.ok(environment.logs.some((line) => line.includes('发布锁可能仍在')));
});

test('a failed Compose activation retains its exit code and lock with a port conflict check', async () => {
  const config = snapshot();
  const image = 'registry.example.invalid/test@sha256:' + 'd'.repeat(64);
  config.definition.artifactType = 'DOCKER_IMAGE';
  config.definition.imageRepository = 'test';
  config.registry = {
    registryUrl: 'registry.example.invalid',
    credentialId: null,
  };
  const environment = fixture(async (command, options) => {
    if (command.includes('image inspect')) options?.onData?.(JSON.stringify([image]), 'stdout');
    if (command.includes('config --images')) options?.onData?.(image, 'stdout');
    if (command.includes('up -d --no-build')) {
      options?.onData?.('Bind for 127.0.0.1:18765 failed: port is already allocated', 'stderr');
      return 1;
    }
  }, true);
  await environment.run(task(config));
  assert.deepEqual(environment.statuses, ['NEEDS_ATTENTION']);
  assert.deepEqual(environment.deployments, [{ status: 'NEEDS_ATTENTION', health: 'NOT_CHECKED' }]);
  assert.equal(environment.targetResults[0].exitCode, 1);
  assert.match(environment.targetResults[0].error!, /Compose 发布激活失败.*端口占用.*退出码 1/);
  assert.ok(
    environment.steps.some(
      (step) =>
        step.key?.startsWith('DEPLOY') && step.status === 'NEEDS_ATTENTION' && step.exitCode === 1,
    ),
  );
  assert.equal(environment.commands.filter((command) => command.includes('rmdir --')).length, 1);
  assert.ok(environment.logs.some((line) => line.includes('port is already allocated')));
});

test('a dependency install failure stops before build and deployment and keeps stage and exit code', async () => {
  const config = snapshot();
  config.definition.installCommand = 'fixture-install-dependencies';
  config.definition.buildCommand = 'fixture-build';
  const environment = fixture(async (command, options) => {
    if (command.includes('fixture-install-dependencies')) {
      options?.onData?.('curl: (22) The requested URL returned error: 404', 'stderr');
      return 22;
    }
  }, true);
  await environment.run(task(config));
  assert.deepEqual(environment.statuses, ['FAILED']);
  assert.equal(environment.deploymentsStarted, 0);
  assert.equal(environment.targetResults[0].exitCode, 22);
  assert.match(environment.targetResults[0].error!, /安装依赖失败.*依赖源.*退出码 22/);
  assert.ok(environment.logs.some((line) => line.includes('returned error: 404')));
  assert.ok(!environment.commands.some((command) => command.includes('fixture-build')));
});

test('a missing build tool preserves its exit code without using stderr to choose task status', async () => {
  const config = snapshot();
  config.definition.buildCommand = 'go build ./...';
  const environment = fixture(async (command, options) => {
    if (command.includes('go build')) {
      options?.onData?.('sh: go: not found', 'stderr');
      return 127;
    }
  }, true);
  await environment.run(task(config));
  assert.deepEqual(environment.statuses, ['FAILED']);
  assert.equal(environment.deploymentsStarted, 0);
  assert.equal(environment.targetResults[0].exitCode, 127);
  assert.match(environment.targetResults[0].error!, /执行构建命令失败.*构建工具.*退出码 127/);
  assert.ok(environment.logs.some((line) => line.includes('go: not found')));
});

test('Docker and Compose checks report missing platform tools before deployment starts', async () => {
  const config = snapshot();
  config.definition.artifactType = 'DOCKER_IMAGE';
  const unavailable = [
    { command: 'command -v docker', message: /找不到 Docker CLI.*PATH/ },
    { command: 'docker compose version', message: /无法执行 docker compose.*Compose v2/ },
  ];
  for (const tool of unavailable) {
    const environment = fixture(
      async (command) => (command.startsWith(tool.command) ? 1 : undefined),
      true,
    );
    await environment.run(task(config));
    assert.deepEqual(environment.statuses, ['FAILED']);
    assert.equal(environment.deploymentsStarted, 0);
    assert.match(environment.targetResults[0].error!, tool.message);
    assert.ok(!environment.commands.some((command) => command.includes('checkout --detach')));
  }
});

test('pre-activation failure releases ownership and leaves the previous release active', async () => {
  const environment = fixture(async (command) => {
    if (command.includes('sha256sum -c')) throw new BuildCommandError(1, 'bad checksum');
  });
  await environment.run(task(snapshot()));
  assert.deepEqual(environment.deployments, [{ status: 'FAILED', health: 'NOT_CHECKED' }]);
  assert.equal(
    environment.commands.some((command) => command.includes('mv -Tf')),
    false,
  );
  assert.equal(environment.commands.filter((command) => command.includes('rmdir --')).length, 2);
});

test('only-build skips the publication lock, activation and deployment record', async () => {
  const environment = fixture(async () => undefined);
  await environment.run(task({ ...snapshot(), mode: 'BUILD_ONLY' }));
  assert.equal(
    environment.commands.some((command) => command.includes('.veyops-deployment-locks')),
    false,
  );
  assert.equal(
    environment.commands.some((command) => command.includes('mv -Tf')),
    false,
  );
  assert.equal(environment.deploymentsStarted, 0);
  assert.deepEqual(environment.statuses, ['SUCCESS']);
});

test('the Worker rejects stale webhook tasks using targets or secrets before opening SSH', async () => {
  const environment = fixture(async () => undefined);
  const automatic = { ...snapshot(), mode: 'BUILD_ONLY' as const, triggerType: 'WEBHOOK' as const };
  await assert.rejects(() => environment.run(task(automatic)), /隔离管理端/);
  await assert.rejects(
    () =>
      environment.run(
        task({
          ...automatic,
          definition: { ...automatic.definition, buildLocation: 'MANAGER' },
          secretVariables: { TOKEN: randomUUID() },
        }),
      ),
    /敏感环境变量/,
  );
  assert.deepEqual(environment.commands, []);
  assert.equal(environment.deploymentsStarted, 0);
});
