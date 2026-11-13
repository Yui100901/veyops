import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { sql } from 'kysely';
import { dataDirectory } from '../core/config';
import { DatabaseService } from '../core/database/database.service';
import { AuditService } from '../modules/audit/audit.service';
import { TasksService } from '../modules/tasks/tasks.service';
import { TaskLogService } from '../modules/tasks/task-log.service';
import { TaskHandlerRegistry } from '../modules/tasks/task-handler.registry';
import { TaskWorkerService } from '../modules/tasks/task-worker.service';
import { PipelinesService } from '../modules/pipelines/pipelines.service';
import { PipelineExecutor } from '../modules/pipelines/pipeline-executor.service';
import {
  BuildsService,
  checkoutScript,
  gitCredentialHelper,
} from '../modules/builds/builds.service';
import { serializeComposeEnvironment } from '../modules/pipelines/environment.serialization';
import { CredentialsService } from '../modules/credentials/credentials.service';
import { ServersService } from '../modules/servers/servers.service';
import { RegistriesService } from '../modules/registries/registries.service';
import { ServiceConfigsService } from '../modules/service-configs/service-configs.service';
import {
  ProcessExecutionError,
  ProcessRunnerService,
} from '../infrastructure/build-runner/process-runner.service';
import { SshService, SshTarget } from '../infrastructure/ssh/ssh.service';
import { ArtifactsService } from '../modules/artifacts/artifacts.service';
import { DeploymentsService } from '../modules/deployments/deployments.service';
import { PipelineDefinitionDto } from '../modules/pipelines/pipeline.dto';
import type { PipelineArtifact, PipelineSnapshot } from '../modules/pipelines/pipeline.types';
import type { TaskExecutionContext, TaskRecord, TaskStatus } from '../modules/tasks/tasks.types';
import {
  deploymentGuard,
  safeDeployPath,
  validateGitUrl,
} from '../modules/pipelines/pipeline.validation';

const digest = 'sha256:' + 'a'.repeat(64);
const image = 'registry.example.com/team/web@' + digest;
const target = (id: string): SshTarget => ({
  id,
  name: id,
  host: '127.0.0.1',
  port: 22,
  username: 'ops',
  credentialId: null,
  hostKeyFingerprint: 'a'.repeat(64),
});
const definition = () =>
  Object.assign(new PipelineDefinitionDto(), {
    repositoryId: randomUUID(),
    deployPath: '/tmp/veyops-test-release',
    buildCommand: 'mkdir -p dist; echo hello > dist/index.html',
  });

test('Git helper handles actual fill/approve/reject operations without exposing credentials in argv or mutating its file', async (t) => {
  const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (gitAvailable.error) {
    t.skip('Git executable unavailable');
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), 'veyops-git-helper-'));
  const responsePath = join(directory, "credential 'response.txt");
  const response = 'username=fixture-user\npassword=fixture-token-for-validation\n';
  try {
    await writeFile(responsePath, response, { mode: 0o600 });
    const helper = gitCredentialHelper(responsePath.replace(/\\/g, '/'));
    const options = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'credential.helper=',
      '-c',
      `credential.helper=${helper}`,
      'credential',
    ];
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    };
    const filled = spawnSync('git', [...options, 'fill'], {
      env,
      input: 'protocol=https\nhost=example.invalid\n\n',
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(filled.status, 0, filled.stderr);
    assert.equal(filled.stderr, '');
    assert.ok(filled.stdout.includes('password=fixture-token-for-validation'));
    for (const operation of ['approve', 'reject']) {
      const result = spawnSync('git', [...options, operation], {
        env,
        input: `protocol=https\nhost=example.invalid\n${response}\n`,
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
    assert.equal(await readFile(responsePath, 'utf8'), response);
    const script = checkoutScript(
      'https://example.invalid/repo.git',
      'b'.repeat(40),
      '/tmp/veyops-test',
      '/tmp/git-credentials',
    );
    assert.ok(script.includes('-c credential.helper= -c credential.helper='));
    assert.equal(script.includes('fixture-token-for-validation'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Compose env serialization keeps dollar references, comments, quotes and backslashes literal', () => {
  const file = serializeComposeEnvironment({
    PLAIN: 'simple',
    COMPLEX: '  $TOKEN ${OTHER} # comment "double" \'single\' C:\\path\\  ',
    EMPTY: '',
    TAB: 'a\tb',
  });
  assert.equal(
    file,
    'PLAIN="simple"\nCOMPLEX="  $$TOKEN $${OTHER} # comment \\"double\\" \'single\' C:\\\\path\\\\  "\nEMPTY=""\nTAB="a\\tb"\n',
  );
  assert.throws(() => serializeComposeEnvironment({ 'BAD=KEY': 'x' }));
  assert.throws(() => serializeComposeEnvironment({ TOKEN: 'x\nINJECT=1' }));
  assert.throws(() => serializeComposeEnvironment({ TOKEN: 'nul\0value' }));
});

test('expired Pipeline leases reconcile running deployment history without changing successful or active releases', async () => {
  process.env.DATABASE_PATH = ':memory:';
  process.env.DATABASE_CLIENT = 'sqlite';
  const database = new DatabaseService();
  await database.onModuleInit();
  try {
    const now = Date.now();
    const ids = {
      user: randomUUID(),
      project: randomUUID(),
      service: randomUUID(),
      environment: randomUUID(),
      target: randomUUID(),
      server: randomUUID(),
      pipeline: randomUUID(),
      version: randomUUID(),
    };
    await database.db
      .insertInto('users')
      .values({
        id: ids.user,
        username: ids.user,
        password_hash: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('projects')
      .values({
        id: ids.project,
        name: 'recovery',
        slug: 'recovery',
        created_by: ids.user,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('services')
      .values({
        id: ids.service,
        project_id: ids.project,
        name: 'web',
        slug: 'web',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('environments')
      .values({
        id: ids.environment,
        project_id: ids.project,
        name: 'test',
        slug: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('deployment_targets')
      .values({ id: ids.target, name: 'target', created_at: now, updated_at: now })
      .execute();
    await database.db
      .insertInto('servers')
      .values({
        id: ids.server,
        name: 'server',
        host: '127.0.0.1',
        username: 'ops',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('pipelines')
      .values({
        id: ids.pipeline,
        project_id: ids.project,
        service_id: ids.service,
        name: 'release',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('pipeline_versions')
      .values({
        id: ids.version,
        pipeline_id: ids.pipeline,
        version: 1,
        definition_json: '{}',
        created_by: ids.user,
        created_at: now,
      })
      .execute();
    const logs = new TaskLogService();
    const tasks = new TasksService(database, logs);
    const makeTask = async (status: 'SUCCESS' | 'RUNNING', leaseExpiresAt: number | null) => {
      const runId = randomUUID();
      const task = await tasks.create(
        {
          type: 'PIPELINE',
          name: 'release',
          scope: {
            projectId: ids.project,
            serviceId: ids.service,
            environmentId: ids.environment,
            targetId: ids.target,
          },
          pipelineRun: {
            id: runId,
            pipelineId: ids.pipeline,
            pipelineVersionId: ids.version,
            gitRef: 'b'.repeat(40),
            commitSha: 'b'.repeat(40),
            buildLocation: 'TARGET',
            artifactType: 'FILE',
          },
          payload: {
            targets: [target(ids.server)],
            steps: [],
            strategy: 'SEQUENTIAL',
            maxParallel: 1,
            failurePolicy: 'CONTINUE',
            timeout: 30,
          },
        },
        ids.user,
      );
      await database.db
        .updateTable('tasks')
        .set({
          status,
          lease_owner: status === 'RUNNING' ? 'test-worker' : null,
          lease_expires_at: leaseExpiresAt,
        })
        .where('id', '=', task.id)
        .execute();
      const taskTarget = await database.db
        .selectFrom('task_targets')
        .select('id')
        .where('task_id', '=', task.id)
        .executeTakeFirstOrThrow();
      await database.db
        .updateTable('task_targets')
        .set({ status })
        .where('id', '=', taskTarget.id)
        .execute();
      const deploymentId = randomUUID();
      await database.db
        .insertInto('deployment_records')
        .values({
          id: deploymentId,
          pipeline_run_id: runId,
          task_target_id: taskTarget.id,
          service_id: ids.service,
          environment_id: ids.environment,
          server_id: ids.server,
          status,
          started_at: now - 1000,
          finished_at: status === 'SUCCESS' ? now - 500 : null,
        })
        .execute();
      return { task, deploymentId };
    };
    const previous = await makeTask('SUCCESS', null);
    const interrupted = await makeTask('RUNNING', now - 1000);
    const active = await makeTask('RUNNING', now + 60_000);
    const worker = new TaskWorkerService(database, tasks, new TaskHandlerRegistry(), logs);
    await worker.recoverExpired();
    const deployments = await database.db.selectFrom('deployment_records').selectAll().execute();
    const recovered = deployments.find((row) => row.id === interrupted.deploymentId)!;
    assert.equal(recovered.status, 'NEEDS_ATTENTION');
    assert.ok(recovered.finished_at! >= now);
    assert.equal((await tasks.get(interrupted.task.id)).status, 'NEEDS_ATTENTION');
    const historical = deployments.find((row) => row.id === previous.deploymentId)!;
    assert.equal(historical.status, 'SUCCESS');
    assert.equal(historical.finished_at, now - 500);
    const ongoing = deployments.find((row) => row.id === active.deploymentId)!;
    assert.equal(ongoing.status, 'RUNNING');
    assert.equal(ongoing.finished_at, null);
    const atomic = await makeTask('RUNNING', now - 1000);
    await sql`create trigger fail_deployment_recovery before update on deployment_records
      when new.status = 'NEEDS_ATTENTION'
      begin select raise(abort, 'simulated deployment write failure'); end`.execute(database.db);
    await assert.rejects(() => worker.recoverExpired(), /simulated deployment write failure/);
    assert.equal((await tasks.get(atomic.task.id)).status, 'RUNNING');
    const atomicTarget = await database.db
      .selectFrom('task_targets')
      .select('status')
      .where('task_id', '=', atomic.task.id)
      .executeTakeFirstOrThrow();
    assert.equal(atomicTarget.status, 'RUNNING');
    await sql`drop trigger fail_deployment_recovery`.execute(database.db);
    await worker.recoverExpired();
    assert.equal((await tasks.get(atomic.task.id)).status, 'NEEDS_ATTENTION');
  } finally {
    await database.onModuleDestroy();
  }
});

test('Pipeline versions and commits are fixed atomically with task and run records', async () => {
  process.env.DATABASE_PATH = ':memory:';
  process.env.DATABASE_CLIENT = 'sqlite';
  const database = new DatabaseService();
  await database.onModuleInit();
  try {
    const now = Date.now(),
      user = randomUUID(),
      project = randomUUID(),
      service = randomUUID(),
      environment = randomUUID(),
      repository = randomUUID(),
      deploymentTarget = randomUUID(),
      server = randomUUID();
    const d = definition();
    d.repositoryId = repository;
    await database.db
      .insertInto('users')
      .values({ id: user, username: user, password_hash: 'test', created_at: now, updated_at: now })
      .execute();
    await database.db
      .insertInto('projects')
      .values({
        id: project,
        name: 'test',
        slug: 'test',
        created_by: user,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('services')
      .values({
        id: service,
        project_id: project,
        name: 'test',
        slug: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('environments')
      .values({
        id: environment,
        project_id: project,
        name: 'test',
        slug: 'test',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('repositories')
      .values({
        id: repository,
        project_id: project,
        name: 'main',
        clone_url: 'https://example.com/app.git',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('deployment_targets')
      .values({ id: deploymentTarget, name: 'target', created_at: now, updated_at: now })
      .execute();
    await database.db
      .insertInto('servers')
      .values({
        id: server,
        name: 'server',
        host: '127.0.0.1',
        username: 'ops',
        created_at: now,
        updated_at: now,
      })
      .execute();
    await database.db
      .insertInto('deployment_target_servers')
      .values({ target_id: deploymentTarget, server_id: server })
      .execute();
    const tasks = new TasksService(database, new TaskLogService());
    const servers = {
      snapshot: async (ids: string[]) => ids.map((id) => ({ ...target(id), credentialId: user })),
    } as unknown as ServersService;
    const envSnapshot = { config: null, variables: { NODE_ENV: 'test' }, secretVariables: {} };
    const configs = { readSnapshot: async () => envSnapshot } as unknown as ServiceConfigsService;
    const pipelines = new PipelinesService(
      database,
      tasks,
      servers,
      new TaskHandlerRegistry(),
      {} as PipelineExecutor,
      new AuditService(database),
      configs,
      {} as RegistriesService,
    );
    const created = await pipelines.create(
      { name: 'release', projectId: project, serviceId: service, definition: d, enabled: true },
      user,
    );
    // Snapshot FK stores the server credential reference, so use no credential on the actual row and stub snapshot reference must be valid.
    await database.db
      .insertInto('credentials')
      .values({
        id: user,
        name: 'test',
        type: 'SSH_PASSWORD',
        ciphertext: 'encrypted',
        nonce: 'nonce',
        auth_tag: 'tag',
        created_by: user,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const input = {
      environmentId: environment,
      targetId: deploymentTarget,
      commitSha: 'b'.repeat(40),
      confirmed: true,
    };
    await assert.rejects(() => pipelines.run(created.id, { ...input, commitSha: 'main' }, user));
    await assert.rejects(() => pipelines.run(created.id, { ...input, confirmed: false }, user));
    await assert.rejects(() =>
      pipelines.run(created.id, { ...input, expectedServerIds: [randomUUID()] }, user),
    );
    const preview = await pipelines.preview(created.id, input);
    envSnapshot.variables.NODE_ENV = 'production';
    await assert.rejects(() =>
      pipelines.run(
        created.id,
        { ...input, expectedConfigurationHash: preview.configurationHash },
        user,
      ),
    );
    envSnapshot.variables.NODE_ENV = 'test';
    const task = await pipelines.run(created.id, input, user);
    const row = await tasks.row(task.id);
    const snapshot = JSON.parse(row.payload_json).pipeline as PipelineSnapshot;
    assert.equal(snapshot.commitSha, input.commitSha);
    assert.equal(snapshot.variables.NODE_ENV, 'test');
    await pipelines.update(
      created.id,
      { name: 'changed', enabled: true, definition: { ...d, buildCommand: 'echo changed' } },
      user,
    );
    assert.equal((await pipelines.get(created.id)).currentVersion, 2);
    assert.equal(
      JSON.parse((await tasks.row(task.id)).payload_json).pipeline.definition.buildCommand,
      d.buildCommand,
    );
    const run = await database.db
      .selectFrom('pipeline_runs')
      .selectAll()
      .where('task_id', '=', task.id)
      .executeTakeFirstOrThrow();
    assert.equal(run.pipeline_version_id, snapshot.pipelineVersionId);
    assert.equal(run.commit_sha, input.commitSha);
    assert.equal(row.project_id, project);
    assert.equal((await pipelines.versions(created.id)).length, 2);
  } finally {
    await database.onModuleDestroy();
  }
});

for (const location of ['TARGET', 'MANAGER'] as const)
  for (const artifactType of ['FILE', 'DOCKER_IMAGE'] as const) {
    test(`Pipeline ${location} ${artifactType} builds and deploys with isolated manager or fixed remote commit`, async () => {
      const calls: { command: string; args?: string[]; stdin?: string }[] = [];
      let managers = 0;
      const uploads: { path: string; content?: string }[] = [];
      const ssh = {
        execute: async (
          _target: SshTarget,
          command: string,
          options: { onData?: (s: string) => void },
        ) => {
          calls.push({ command });
          if (command.includes("printf 'VEYOPS_ARTIFACT"))
            options.onData?.('VEYOPS_ARTIFACT:' + 'c'.repeat(64) + ':12\n');
          else if (command.includes('image inspect'))
            options.onData?.(JSON.stringify([image]) + '\n');
          else if (command.includes('config --images')) options.onData?.(image + '\n');
          return { exitCode: 0 };
        },
        uploadContent: async (_t: SshTarget, content: string, path: string) => {
          uploads.push({ path, content });
        },
        upload: async (_t: SshTarget, _local: string, path: string) => {
          uploads.push({ path });
        },
      } as unknown as SshService;
      const runner = {
        run: async (command: string, args: string[], opts: { stdin?: string }) => {
          calls.push({ command, args, stdin: opts.stdin });
          if (args[0] === 'run') {
            const mount = args.find((a) => a.endsWith(',dst=/workspace'))!;
            const workspace = mount.slice('type=bind,src='.length, -',dst=/workspace'.length);
            const script = args.at(-1)!;
            if (script.includes('clone --no-checkout')) {
              managers++;
              await mkdir(join(workspace, 'repo'), { recursive: true });
              await writeFile(join(workspace, 'repo', 'Dockerfile'), 'FROM scratch');
              await writeFile(join(workspace, 'repo', 'compose.yaml'), 'services: {}');
            }
            if (script.includes("printf 'VEYOPS_ARTIFACT"))
              await writeFile(join(workspace, 'artifact.tar.gz'), 'test archive');
            if (script.includes('/workspace/compose.yaml'))
              await writeFile(join(workspace, 'compose.yaml'), 'services: {}');
          }
          return {
            exitCode: 0,
            stdout: args.includes('inspect') ? JSON.stringify([image]) : '',
            stderr: '',
          };
        },
      } as unknown as ProcessRunnerService;
      const credentials = {
        decrypt: async () => ({ username: 'user', password: 'private-token-for-git' }),
      } as unknown as CredentialsService;
      const registries = {
        get: async () => ({
          registryUrl: 'registry.example.com',
          credentialId: 'registry-credential',
        }),
      } as unknown as RegistriesService;
      const builds = new BuildsService(ssh, runner, credentials, registries);
      const records: PipelineArtifact[] = [];
      const artifacts = {
        create: async (_s: PipelineSnapshot, a: Omit<PipelineArtifact, 'id'>) => {
          const artifact = { ...a, id: randomUUID() };
          records.push(artifact);
          return artifact;
        },
      } as unknown as ArtifactsService;
      const deploymentStates: string[] = [];
      const deployments = {
        start: async () => randomUUID(),
        finish: async (_id: string, status: string) => {
          deploymentStates.push(status);
        },
      } as unknown as DeploymentsService;
      const d = {
        ...definition(),
        buildLocation: location,
        artifactType,
        registryId: randomUUID(),
        imageRepository: 'team/web',
      };
      const s: PipelineSnapshot = {
        runId: randomUUID(),
        pipelineId: randomUUID(),
        pipelineVersionId: randomUUID(),
        projectId: randomUUID(),
        serviceId: randomUUID(),
        environmentId: randomUUID(),
        targetId: randomUUID(),
        commitSha: 'b'.repeat(40),
        repository: { url: 'https://example.com/app.git', credentialId: 'git-credential' },
        definition: d,
        variables: { NODE_ENV: 'production' },
        secretVariables: {},
      };
      const task: TaskRecord = {
        id: randomUUID(),
        name: 'test',
        type: 'PIPELINE',
        payload: {
          targets: [target(randomUUID()), target(randomUUID())],
          steps: [],
          strategy: 'PARALLEL',
          maxParallel: 2,
          failurePolicy: 'CONTINUE',
          timeout: 900,
          pipeline: s,
        },
      };
      const states: TaskStatus[] = [];
      const controller = new AbortController();
      const context: TaskExecutionContext = {
        signal: controller.signal,
        log: () => undefined,
        startTarget: async () => randomUUID(),
        finishTarget: async (_id, status) => {
          states.push(status);
        },
        startStep: async () => randomUUID(),
        finishStep: async () => undefined,
      };
      await new PipelineExecutor(builds, ssh, artifacts, deployments).execute(task, context);
      assert.deepEqual(states, ['SUCCESS', 'SUCCESS']);
      assert.deepEqual(deploymentStates, ['SUCCESS', 'SUCCESS']);
      assert.equal(records.length, location === 'MANAGER' ? 1 : 2);
      const actualCommands = calls.map((c) => c.command).join('\n');
      assert.equal(actualCommands.includes('private-token-for-git'), false);
      assert.ok(calls.some((c) => c.command.includes('mv -Tf')));
      if (location === 'MANAGER') {
        assert.equal(managers, 1);
        assert.ok(
          calls
            .filter((c) => c.command === 'docker' && c.args?.[0] === 'run')
            .every(
              (c) =>
                c.args?.includes('--cap-drop=ALL') &&
                c.args.includes('--memory=1g') &&
                !c.args.join(' ').includes('docker.sock'),
            ),
        );
        assert.ok(
          uploads.some(
            (u) => u.path.includes('artifact.tar.gz') || u.path.includes('compose.yaml'),
          ),
        );
      } else assert.equal(calls.filter((c) => c.command.includes('checkout --detach')).length, 2);
      if (artifactType === 'DOCKER_IMAGE')
        assert.ok(records.every((a) => a.imageDigest === digest));
      if (location === 'MANAGER' && artifactType === 'FILE')
        await rm(join(dataDirectory, 'artifacts', task.id + '.tar.gz'), { force: true });
    });
  }

test('known manager build errors finish targets without falsely claiming uncertain remote writes', async () => {
  const states: TaskStatus[] = [];
  const builds = {
    resolveVariables: async () => ({ values: {}, secrets: [] }),
    manager: async () => {
      throw new ProcessExecutionError('No Docker', 'TIMED_OUT');
    },
    errorKind: (e: ProcessExecutionError) => e.kind,
  } as unknown as BuildsService;
  const task = {
    id: randomUUID(),
    payload: {
      pipeline: { definition: { buildLocation: 'MANAGER' } },
      targets: [target('one'), target('two')],
    },
  } as unknown as TaskRecord;
  const context: TaskExecutionContext = {
    signal: new AbortController().signal,
    log: () => undefined,
    startTarget: async (id: string) => id,
    finishTarget: async (_id: string, status: TaskStatus) => {
      states.push(status);
    },
    startStep: async () => randomUUID(),
    finishStep: async () => undefined,
  };
  await new PipelineExecutor(
    builds,
    {} as SshService,
    {} as ArtifactsService,
    {} as DeploymentsService,
  ).execute(task, context);
  assert.deepEqual(states, ['TIMED_OUT', 'TIMED_OUT']);
});

test('deployment guards reject unsafe directories and credential-bearing Git URLs', () => {
  assert.throws(() => safeDeployPath('/'));
  assert.throws(() => safeDeployPath('/opt/app/../other'));
  assert.throws(() => validateGitUrl('https://user:secret@example.com/repo.git'));
  assert.throws(() => validateGitUrl('git@example.com:repo.git'));
  const guard = deploymentGuard('/tmp/veyops-test', 'project:service:environment');
  assert.ok(guard.includes('.veyops-managed'));
  assert.ok(guard.includes('test -z'));
  assert.ok(guard.includes('realpath -m'));
});
