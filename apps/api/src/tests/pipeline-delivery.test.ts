import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

let testDirectory: Promise<string> | undefined;
after(async () => {
  if (testDirectory) await rm(await testDirectory, { recursive: true, force: true });
});

async function checkDelivery(databaseUrl?: string) {
  const directory = await (testDirectory ??= mkdtemp(join(tmpdir(), 'veyops-pipeline-delivery-')));
  const initialPassword = 'fixture-delivery-initial';
  const password = 'fixture-delivery-changed';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.DATABASE_CLIENT = databaseUrl ? 'postgres' : 'sqlite';
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_PASSWORD = initialPassword;
  process.env.AI_PIPELINE_ANALYSIS = 'false';

  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
  const { ProcessRunnerService } =
    await import('../infrastructure/build-runner/process-runner.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');

  const archive = Buffer.from('fixture file artifact\n');
  const checksum = createHash('sha256').update(archive).digest('hex');
  const compose = 'services:\n  web:\n    image: ${VEYOPS_IMAGE}\n';
  const imageDigest = `sha256:${'1'.repeat(64)}`;
  const imageId = `sha256:${'2'.repeat(64)}`;
  const successfulCommit = 'a'.repeat(40);
  const failingCommit = 'b'.repeat(40);
  const managerCheckouts: string[] = [];
  const remoteCommands: { serverId: string; command: string }[] = [];
  const transferredArchives: string[] = [];
  let failedBuildServer: string | undefined;
  let registryPullFails = false;
  let archivePlatformMismatch = false;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ProcessRunnerService)
    .useValue({
      run: async (_command: string, args: string[], options: { gzipOutput?: { path: string } }) => {
        const script = args.at(-1) ?? '';
        if (script.includes('clone --no-checkout') || script.includes("printf 'VEYOPS_ARTIFACT")) {
          const mount = args.find((arg) => arg.endsWith(',dst=/workspace'))!;
          const workspace = mount.slice('type=bind,src='.length, -',dst=/workspace'.length);
          if (script.includes('clone --no-checkout')) {
            managerCheckouts.push(script);
            if (script.includes(failingCommit)) return { exitCode: 77, stdout: '', stderr: '' };
            await mkdir(join(workspace, 'repo'));
            await writeFile(join(workspace, 'repo', 'Dockerfile'), 'FROM scratch\n');
            await writeFile(join(workspace, 'repo', 'compose.yaml'), compose);
          } else {
            await writeFile(join(workspace, 'artifact.tar.gz'), archive);
          }
        }
        if (args.includes('push'))
          return {
            exitCode: 0,
            stdout: `${script.split(':').at(-1)}: digest: ${imageDigest} size: 321\n`,
            stderr: '',
          };
        if (args.includes('image') && args.includes('inspect'))
          return {
            exitCode: 0,
            stdout: args.some((arg) => arg.includes('{{.Architecture}}'))
              ? `${imageId} linux/amd64`
              : imageId,
            stderr: '',
          };
        if (options.gzipOutput) await writeFile(options.gzipOutput.path, archive);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    })
    .overrideProvider(SshService)
    .useValue({
      execute: async (
        target: { id: string },
        command: string,
        options?: { onData?: (chunk: string) => void },
      ) => {
        remoteCommands.push({ serverId: target.id, command });
        if (command.includes('BUILD_FIXTURE') && target.id === failedBuildServer)
          return { exitCode: 77 };
        if (command.includes("printf 'VEYOPS_ARTIFACT"))
          options?.onData?.(`VEYOPS_ARTIFACT:${checksum}:${archive.length}\n`);
        if (command.includes(' push ')) {
          const tag = /:([^:']+)'$/.exec(command)?.[1];
          options?.onData?.(`${tag}: digest: ${imageDigest} size: 321\n`);
        }
        if (command.includes('config --images'))
          options?.onData?.(`${/^VEYOPS_IMAGE='([^']+)'/.exec(command)?.[1]}\n`);
        if (command.includes('image inspect --format')) {
          const platform = command.includes('{{.Architecture}}') ? ' linux/amd64' : '';
          options?.onData?.(`${imageId}${platform}\n`);
        }
        if (registryPullFails && command.includes(' pull') && command.includes(imageDigest))
          return { exitCode: 1 };
        if (archivePlatformMismatch && command.includes('{{.Server.Os}}/{{.Server.Arch}}'))
          return { exitCode: 1 };
        return { exitCode: 0 };
      },
      upload: async (target: { id: string }, source: string) => {
        assert.deepEqual(await readFile(source), archive);
        transferredArchives.push(target.id);
      },
      uploadContent: async (_target: unknown, contents: string, destination: string) => {
        if (destination.endsWith('/compose.yaml')) assert.equal(contents, compose);
      },
      download: async (_target: unknown, source: string, destination: string) => {
        await writeFile(destination, source.endsWith('/compose.snapshot.yaml') ? compose : archive);
      },
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const post = (path: string, body: object) => api.post(`/api/v1${path}`).send(body);
    const create = async (path: string, body: object) =>
      (await post(path, body).expect(201)).body.data;
    await create('/auth/login', { username: 'root', password: initialPassword });
    await post('/auth/change-password', {
      currentPassword: initialPassword,
      newPassword: password,
    }).expect(200);
    await create('/auth/login', { username: 'root', password });
    const credential = await create('/credentials', {
      name: 'fixture ssh',
      type: 'SSH_PASSWORD',
      secret: { password: 'ssh-fixture-password' },
    });
    const serverIds: string[] = [];
    for (const name of ['first', 'second']) {
      const server = await create('/servers', {
        name,
        host: `host-${name}.test`,
        username: 'ops',
        credentialId: credential.id,
        hostKeyFingerprint: 'f'.repeat(64),
      });
      serverIds.push(server.id);
    }
    const target = await create('/deployment-targets', { name: 'target', serverIds });
    const project = await create('/projects', { name: 'Project', slug: 'pipeline-delivery' });
    const repo = await create(`/projects/${project.id}/repositories`, {
      name: 'Repo',
      cloneUrl: 'https://repo.example.test/team/app.git',
    });
    const service = await create(`/projects/${project.id}/services`, { name: 'Web', slug: 'web' });
    const environment = await create(`/projects/${project.id}/environments`, {
      name: 'Testing',
      slug: 'testing',
      environmentType: 'TESTING',
    });
    const definition = {
      repositoryId: repo.id,
      artifactType: 'FILE',
      buildCommand: 'echo BUILD_FIXTURE',
      outputPath: 'dist',
      deployPath: '/opt/pipeline-delivery',
      healthCheckCommand: 'test -f index.html',
    };
    const managerPipeline = await create('/pipelines', {
      name: 'Manager delivery',
      projectId: project.id,
      serviceId: service.id,
      definition: { ...definition, buildLocation: 'MANAGER' },
    });
    const targetPipeline = await create('/pipelines', {
      name: 'Target delivery',
      projectId: project.id,
      serviceId: service.id,
      definition: { ...definition, buildLocation: 'TARGET' },
    });

    const worker = app.get(TaskWorkerService);
    const db = app.get(DatabaseService).db;
    const base = { environmentId: environment.id, targetId: target.id, confirmed: true };
    const managerPath = `/pipelines/${managerPipeline.id}`;
    const getTask = async (id: string) =>
      (await api.get(`/api/v1/tasks/${id}`).expect(200)).body.data;
    const runTask = async (id: string) => {
      await worker.tick();
      for (let attempt = 0; attempt < 200; attempt++) {
        const task = await getTask(id);
        if (!['PENDING', 'RUNNING', 'CANCEL_REQUESTED'].includes(task.status)) return task;
        await delay(10);
        if (task.status === 'PENDING') await worker.tick();
      }
      assert.fail(`Task ${id} did not finish`);
    };
    const deployments = () => db.selectFrom('deployment_records').selectAll().execute();
    const activations = () => remoteCommands.filter(({ command }) => command.includes('mv -Tf'));

    const response = await create(`${managerPath}/run`, { ...base, commitSha: successfulCommit });
    assert.equal(response.deliveryStage, 'BUILD');
    assert.equal(response.executionMode, 'DEPLOY');
    assert.equal(response.status, 'PENDING');
    const build = await runTask(response.id);
    assert.equal(build.status, 'SUCCESS');
    assert.ok(build.deploymentTaskId);
    assert.equal(managerCheckouts.length, 1);
    assert.equal(remoteCommands.length, 0);
    assert.equal((await deployments()).length, 0);

    const stored = await db
      .selectFrom('artifacts')
      .selectAll()
      .where('pipeline_run_id', '=', build.pipelineRunId)
      .executeTakeFirstOrThrow();
    assert.equal(stored.source_commit, successfulCommit);
    assert.equal(stored.checksum, checksum);
    assert.deepEqual(await readFile(stored.storage_key), archive);
    const release = await runTask(build.deploymentTaskId);
    assert.equal(release.status, 'SUCCESS');
    assert.equal(release.deliveryStage, 'DEPLOY');
    assert.equal(release.sourceBuildTaskId, build.id);
    assert.equal(managerCheckouts.length, 1);
    assert.deepEqual([...transferredArchives].sort(), [...serverIds].sort());
    assert.equal(activations().length, 2);
    assert.ok(
      (await deployments()).every(
        ({ artifact_id, status }) => artifact_id === stored.id && status === 'SUCCESS',
      ),
    );

    const failed = await create(`${managerPath}/run`, { ...base, commitSha: failingCommit });
    const failure = await runTask(failed.id);
    assert.equal(failure.status, 'FAILED');
    assert.equal(failure.deploymentTaskId ?? null, null);
    assert.ok(failure.deploymentSkippedReason);
    assert.equal(activations().length, 2);
    assert.equal((await deployments()).length, 2);

    const archiveInput = {
      environmentId: environment.id,
      targetId: target.id,
      artifactIds: [stored.id],
    };
    await post(`${managerPath}/artifact-deploy`, { ...archiveInput, confirmed: true }).expect(400);
    const preview = await create(`${managerPath}/artifact-deploy/preview`, archiveInput);
    assert.equal(preview.commitSha, successfulCommit);
    await post(`${managerPath}/artifact-deploy`, {
      ...archiveInput,
      confirmed: true,
      expectedConfigurationHash: '0'.repeat(64),
    }).expect(409);
    const confirmed = {
      ...archiveInput,
      version: preview.version,
      confirmed: true,
      expectedConfigurationHash: preview.configurationHash,
      expectedServerIds: preview.serverIds,
    };
    const reuse = await create(`${managerPath}/artifact-deploy`, confirmed);
    assert.equal((await runTask(reuse.id)).status, 'SUCCESS');
    assert.equal(activations().length, 4);
    assert.equal(managerCheckouts.length, 2);
    assert.ok(remoteCommands.every(({ command }) => !command.includes('checkout --detach')));

    const corrupt = await create(`${managerPath}/artifact-deploy`, confirmed);
    await writeFile(stored.storage_key, Buffer.alloc(archive.length, 1));
    assert.equal((await runTask(corrupt.id)).status, 'FAILED');
    assert.equal(activations().length, 4);

    const targetPath = `/pipelines/${targetPipeline.id}`;
    failedBuildServer = serverIds[1];
    const strict = await create(`${targetPath}/run`, { ...base, commitSha: successfulCommit });
    const strictBuild = await runTask(strict.id);
    assert.equal(strictBuild.status, 'PARTIAL_FAILED');
    assert.equal(strictBuild.deploymentTaskId ?? null, null);
    assert.ok(strictBuild.deploymentSkippedReason);
    assert.equal(activations().length, 4);

    const partial = await create(`${targetPath}/run`, {
      ...base,
      commitSha: successfulCommit,
      allowPartialDeploy: true,
    });
    const partialBuild = await runTask(partial.id);
    assert.equal(partialBuild.status, 'PARTIAL_FAILED');
    assert.ok(partialBuild.deploymentTaskId);
    const partialRelease = await runTask(partialBuild.deploymentTaskId);
    assert.equal(partialRelease.status, 'SUCCESS');
    assert.equal(activations().length, 5);
    assert.equal(activations().at(-1)?.serverId, serverIds[0]);
    assert.equal(
      remoteCommands.filter(({ command }) => command.includes('checkout --detach')).length,
      4,
    );

    const registry = await create('/registries', {
      name: 'Fixture registry',
      registryUrl: 'registry.example.test',
    });
    for (const buildLocation of ['MANAGER', 'TARGET']) {
      failedBuildServer = undefined;
      const dockerPipeline = await create('/pipelines', {
        name: `Docker ${buildLocation}`,
        projectId: project.id,
        serviceId: service.id,
        definition: {
          ...definition,
          buildLocation,
          artifactType: 'DOCKER_IMAGE',
          deployPath: `/opt/pipeline-delivery-${buildLocation.toLowerCase()}`,
          registryId: registry.id,
          imageRepository: 'example/web',
        },
      });
      const path = `/pipelines/${dockerPipeline.id}`;
      const activationsBeforeBuild: number = activations().length;
      const run = await create(`${path}/run`, { ...base, commitSha: successfulCommit });
      const compiled = await runTask(run.id);
      assert.equal(compiled.status, 'SUCCESS', `${buildLocation}: ${compiled.errorSummary}`);
      assert.ok(compiled.deploymentTaskId, `${buildLocation}: ${compiled.deploymentSkippedReason}`);
      assert.equal(activations().length, activationsBeforeBuild);
      const images = await db
        .selectFrom('artifacts')
        .selectAll()
        .where('pipeline_run_id', '=', compiled.pipelineRunId)
        .execute();
      assert.equal(images.length, buildLocation === 'MANAGER' ? 1 : 2);
      assert.ok(
        images.every(
          (row) =>
            row.storage_type === 'REGISTRY_IMAGE' &&
            row.storage_key === `registry.example.test/example/web@${imageDigest}` &&
            row.archive_key === null &&
            row.compose_yaml === compose,
        ),
      );
      const before: number = remoteCommands.length;
      const localBefore: number = managerCheckouts.length;
      const deployed = await runTask(compiled.deploymentTaskId);
      assert.equal(deployed.status, 'SUCCESS', `${buildLocation}: ${deployed.errorSummary}`);
      assert.equal(managerCheckouts.length, localBefore);
      const releaseCommands: string[] = remoteCommands.slice(before).map(({ command }) => command);
      assert.ok(
        releaseCommands.every(
          (command) => !/checkout --detach| docker .*(?: build | push )/.test(command),
        ),
      );
      assert.equal(
        releaseCommands.filter((command) => command.includes('up -d --no-build')).length,
        2,
      );

      const offline = await create(`${path}/run`, {
        ...base,
        commitSha: successfulCommit,
        mode: 'BUILD_ONLY',
      });
      const archived = await runTask(offline.id);
      assert.equal(
        archived.status,
        'SUCCESS',
        `${buildLocation} offline: ${archived.errorSummary}`,
      );
      assert.equal(archived.deploymentTaskId, null);
      const archiveRows = await db
        .selectFrom('artifacts')
        .selectAll()
        .where('pipeline_run_id', '=', archived.pipelineRunId)
        .execute();
      assert.equal(archiveRows.length, buildLocation === 'MANAGER' ? 1 : 2);
      assert.ok(
        archiveRows.every(
          (row) =>
            row.archive_key &&
            row.checksum === checksum &&
            row.image_digest === imageId &&
            row.compose_yaml === compose,
        ),
      );
      const offlineInput = { ...archiveInput, artifactIds: archiveRows.map((row) => row.id) };
      const offlinePreview = await create(`${path}/artifact-deploy/preview`, offlineInput);
      const restore = await create(`${path}/artifact-deploy`, {
        ...offlineInput,
        confirmed: true,
        expectedConfigurationHash: offlinePreview.configurationHash,
      });
      const restoreStart: number = remoteCommands.length;
      assert.equal((await runTask(restore.id)).status, 'SUCCESS');
      const restoreCommands: string[] = remoteCommands
        .slice(restoreStart)
        .map(({ command }) => command);
      assert.equal(restoreCommands.filter((cmd) => cmd.includes('image load')).length, 2);
      assert.equal(
        restoreCommands.filter((cmd) => cmd.includes('up -d --no-build --pull never')).length,
        2,
      );
      assert.ok(restoreCommands.every((cmd) => !cmd.includes('checkout --detach')));

      const archiveEnv = await create(`/projects/${project.id}/environments`, {
        name: `${buildLocation} Registry archive`,
        slug: `archive-${buildLocation.toLowerCase()}`,
        environmentType: 'TESTING',
      });
      await api
        .put(`/api/v1/services/${service.id}/environments/${archiveEnv.id}/config`)
        .send({
          targetId: target.id,
          artifactType: 'DOCKER_IMAGE',
          deployMethod: 'DOCKER_COMPOSE',
          buildLocation,
          deployPath: `/opt/pipeline-delivery-${buildLocation.toLowerCase()}-archive`,
          releasePolicy: { archivePushedImage: true },
        })
        .expect(200);
      const registryRun = await create(`${path}/run`, {
        ...base,
        environmentId: archiveEnv.id,
        commitSha: successfulCommit,
      });
      const archivedPush = await runTask(registryRun.id);
      assert.equal(
        archivedPush.status,
        'SUCCESS',
        `${buildLocation} archive push: ${archivedPush.errorSummary}`,
      );
      const backups = await db
        .selectFrom('artifacts')
        .selectAll()
        .where('pipeline_run_id', '=', archivedPush.pipelineRunId)
        .execute();
      assert.equal(backups.length, buildLocation === 'MANAGER' ? 1 : 2);
      for (const artifact of backups) {
        assert.equal(artifact.image_digest, imageDigest);
        assert.equal(artifact.archive_image_id, imageId);
        assert.equal(artifact.archive_image_platform, 'linux/amd64');
        assert.equal(artifact.checksum, checksum);
        assert.deepEqual(
          await readFile(join(directory, 'artifacts', artifact.archive_key!)),
          archive,
        );
      }
      registryPullFails = true;
      const fallbackStart = remoteCommands.length;
      assert.equal((await runTask(archivedPush.deploymentTaskId)).status, 'SUCCESS');
      const fallbackCommands = remoteCommands.slice(fallbackStart).map(({ command }) => command);
      assert.equal(
        fallbackCommands.filter((cmd) => cmd.includes(imageDigest) && cmd.includes(' pull')).length,
        2,
      );
      assert.equal(
        fallbackCommands.filter((cmd) => cmd.includes('image load') && cmd.includes(imageId))
          .length,
        2,
      );
      assert.equal(
        fallbackCommands.filter((cmd) => cmd.includes('up -d --no-build --pull never')).length,
        2,
      );
      assert.ok(fallbackCommands.every((cmd) => !cmd.includes('checkout --detach')));

      const fallbackInput = {
        ...archiveInput,
        environmentId: archiveEnv.id,
        artifactIds: backups.map(({ id }) => id),
      };
      const fallbackPreview = await create(`${path}/artifact-deploy/preview`, fallbackInput);
      const incompatible = await create(`${path}/artifact-deploy`, {
        ...fallbackInput,
        confirmed: true,
        expectedConfigurationHash: fallbackPreview.configurationHash,
      });
      archivePlatformMismatch = true;
      const beforeMismatch = remoteCommands.length;
      assert.equal((await runTask(incompatible.id)).status, 'FAILED');
      assert.ok(
        remoteCommands
          .slice(beforeMismatch)
          .every(
            ({ command }) =>
              !command.includes('image load') && !command.includes('up -d --no-build'),
          ),
      );
      archivePlatformMismatch = false;
      registryPullFails = false;
    }

    await api
      .put(`/api/v1/services/${service.id}/environments/${environment.id}/config`)
      .send({
        targetId: target.id,
        artifactType: 'FILE',
        deployMethod: 'FILE',
        buildLocation: 'MANAGER',
        deployPath: definition.deployPath,
        releasePolicy: { requireApproval: true },
      })
      .expect(200);
    const runProtected = async () => {
      const started = await create(`${managerPath}/run`, { ...base, commitSha: successfulCommit });
      const built = await runTask(started.id);
      assert.ok(built.deploymentTaskId);
      const pending = await getTask(built.deploymentTaskId);
      assert.equal(pending.approvalStatus, 'PENDING');
      const activationCount = activations().length;
      await worker.tick();
      assert.equal(activations().length, activationCount);
      const approvals = (await api.get('/api/v1/deployments/approvals').expect(200)).body.data;
      assert.ok(approvals.some((entry: { id: string }) => entry.id === pending.id));
      const approved = await create(`/deployments/approvals/${pending.id}/approve`, {});
      assert.equal(approved.approvalStatus, 'APPROVED');
      await post(`/deployments/approvals/${pending.id}/approve`, {}).expect(409);
      return runTask(pending.id);
    };
    const rollbackSource = await runProtected();
    assert.equal(rollbackSource.status, 'SUCCESS');
    const nextVersion = await runProtected();
    assert.equal(nextVersion.status, 'SUCCESS');
    const history = await db
      .selectFrom('deployment_records')
      .selectAll()
      .where('pipeline_run_id', '=', rollbackSource.pipelineRunId)
      .where('server_id', '=', serverIds[0]!)
      .executeTakeFirstOrThrow();
    const rollbackPath = `/deployments/${history.id}/rollback`;
    const rollbackPreview = await create(`${rollbackPath}/preview`, {});
    assert.equal(rollbackPreview.artifactId, history.artifact_id);
    assert.equal(rollbackPreview.checksum, checksum);
    assert.equal(rollbackPreview.requireApproval, true);
    await post(rollbackPath, { confirmationHash: '1'.repeat(64) }).expect(409);
    const rollback = await create(rollbackPath, {
      confirmationHash: rollbackPreview.confirmationHash,
    });
    assert.equal(rollback.approvalStatus, 'PENDING');
    await create(`/deployments/approvals/${rollback.id}/approve`, {});
    const restored = await runTask(rollback.id);
    assert.equal(restored.status, 'SUCCESS');
    const restoredRecord = await db
      .selectFrom('deployment_records')
      .selectAll()
      .where('pipeline_run_id', '=', restored.pipelineRunId)
      .executeTakeFirstOrThrow();
    assert.equal(restoredRecord.artifact_id, history.artifact_id);
    assert.equal(restoredRecord.rollback_of_deployment_id, history.id);
    assert.equal(restoredRecord.health_status, 'HEALTHY');
  } finally {
    await app.close();
  }
}

test('SQLite delivery runs from verified artifacts and requires a separate release task', () =>
  checkDelivery());
test(
  'PostgreSQL delivery runs from verified artifacts and requires a separate release task',
  {
    skip: !process.env.VEYOPS_TEST_POSTGRES_URL,
  },
  async () => {
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, checkDelivery);
  },
);
