import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { PipelineSnapshot } from '../modules/pipelines/pipeline.types';

let testDirectory: Promise<string> | undefined;
const deliveryDirectory = () =>
  (testDirectory ??= mkdtemp(join(tmpdir(), 'veyops-pipeline-delivery-')));
after(async () => {
  if (testDirectory) await rm(await testDirectory, { recursive: true, force: true });
});

async function checkDelivery(databaseUrl?: string) {
  const directory = await deliveryDirectory();
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

  const { LegacyDeliveryFixtureModule } =
    await import('./helpers/legacy-delivery-fixture.module.js');
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../bootstrap.js');
  const { DatabaseService } = await import('../core/database/database.service.js');
  const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
  const { ProcessRunnerService } =
    await import('../infrastructure/build-runner/process-runner.service.js');
  const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
  const { DeploymentsService } = await import('../modules/deployments/deployments.service.js');
  const { PipelineTriggersService } =
    await import('../modules/pipeline-triggers/pipeline-triggers.service.js');
  const { BuildsService } = await import('../modules/builds/builds.service.js');
  const { ArtifactsService } = await import('../modules/artifacts/artifacts.service.js');
  const { GraphTriggersService } =
    await import('../modules/execution-graphs/graph-triggers.service.js');
  const { RepositoryMetadataService } =
    await import('../modules/projects/repository-metadata.service.js');

  const archive = Buffer.from('fixture file artifact\n');
  const checksum = createHash('sha256').update(archive).digest('hex');
  const compose = 'services:\n  web:\n    image: ${VEYOPS_IMAGE}\n';
  const managedV1 = compose + '# Service environment revision 1\n';
  const managedV2 = compose + '# Service environment revision 2\n';
  const composeUploads: string[] = [];
  const imageDigest = `sha256:${'1'.repeat(64)}`;
  const imageId = `sha256:${'2'.repeat(64)}`;
  const successfulCommit = 'a'.repeat(40);
  const failingCommit = 'b'.repeat(40);
  const managerCheckouts: string[] = [];
  const remoteCommands: { serverId: string; command: string }[] = [];
  const releaseLinks = new Map<string, string>();
  const transferredArchives: string[] = [];
  let failedBuildServer: string | undefined;
  let registryPullFails = false;
  let failNextHealthCheck = false;
  let archivePlatformMismatch = false;
  let auxiliaryCommit = 'c'.repeat(40);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, LegacyDeliveryFixtureModule],
  })
    .overrideProvider(ProcessRunnerService)
    .useValue({
      run: async (_command: string, args: string[], options: { gzipOutput?: { path: string } }) => {
        const script = args.at(-1) ?? '';
        if (script.includes('GRAPH_SHELL_FIXTURE')) {
          const path = args.find((arg) => arg.endsWith(',dst=/workspace'))!;
          const workspace = path.slice('type=bind,src='.length, -',dst=/workspace'.length);
          const destination = join(workspace, 'repo', 'custom-dist');
          await mkdir(destination, { recursive: true });
          await writeFile(join(destination, 'index.html'), '<h1>Shell output</h1>');
          return {
            exitCode: 0,
            stdout: 'VEYOPS_OUTPUT={"result":"generated"}\nVEYOPS_EXIT_CODE=0\n',
            stderr: '',
          };
        }
        if (script.includes('GRAPH_DEPENDENCY_FIXTURE')) {
          const mount = args.find((argument) => argument.endsWith(',dst=/workspace'))!;
          const workspace = mount.slice('type=bind,src='.length, -',dst=/workspace'.length);
          assert.equal(
            await readFile(join(workspace, 'repo', 'origin.txt'), 'utf8'),
            successfulCommit,
          );
          assert.equal(
            await readFile(join(workspace, 'dependencies', 'schema', 'origin.txt'), 'utf8'),
            auxiliaryCommit,
          );
        }
        const checkout = script.includes('fetch --no-recurse-submodules --no-tags --depth=1');
        if (checkout || script.includes("printf 'VEYOPS_ARTIFACT")) {
          const mount = args.find((arg) => arg.endsWith(',dst=/workspace'))!;
          const workspace = mount.slice('type=bind,src='.length, -',dst=/workspace'.length);
          if (checkout) {
            managerCheckouts.push(script);
            if (script.includes(failingCommit)) return { exitCode: 77, stdout: '', stderr: '' };
            await mkdir(join(workspace, 'repo'), { recursive: true });
            await writeFile(join(workspace, 'repo', 'Dockerfile'), 'FROM scratch\n');
            await writeFile(join(workspace, 'repo', 'compose.yaml'), compose);
          } else {
            const filename =
              /'\/workspace\/(artifact(?:-[0-9a-f-]+)?\.tar\.gz)'/.exec(script)?.[1] ??
              'artifact.tar.gz';
            await writeFile(join(workspace, filename), archive);
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
        if (command.includes('VEYOPS_WORKSPACE=')) {
          const leaf = /mkdir -- '(veyops-[\w-]+)'/.exec(command)?.[1];
          assert.ok(leaf);
          options?.onData?.(`VEYOPS_WORKSPACE=/home/fixture/.veyops/workspace/${leaf}\n`);
        }
        if (failNextHealthCheck && command.includes('AUTO_HEALTH_CHECK')) {
          failNextHealthCheck = false;
          return { exitCode: 1 };
        }
        const switched = /ln -s '([^']+)' '[^']+'; mv -Tf -- '[^']+' '([^']+)'/.exec(command);
        if (switched) releaseLinks.set(`${target.id}:${switched[2]}`, switched[1]!);
        const reading = /^readlink -- '([^']+)'$/.exec(command);
        if (reading) {
          const link = releaseLinks.get(`${target.id}:${reading[1]}`);
          if (link) options?.onData?.(`${link}\n`);
          return { exitCode: link ? 0 : 1 };
        }
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
        if (command.includes("printf 'VEYOPS_COMPOSE_IMAGE_ID="))
          options?.onData?.(`VEYOPS_COMPOSE_IMAGE_ID=${imageId}\n`);
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
        if (destination.endsWith('/compose.yaml')) composeUploads.push(contents);
      },
      download: async (_target: unknown, source: string, destination: string) => {
        await writeFile(destination, source.endsWith('/compose.snapshot.yaml') ? compose : archive);
      },
    })
    .overrideProvider(RepositoryMetadataService)
    .useValue({
      inspectGraphEnvironmentFile: async () => undefined,
      planGraphCheckout: async (
        _projectId: string,
        source: { repositoryId: string; commitSha?: string; branch?: string },
      ) => ({
        ...source,
        commitSha: source.commitSha ?? successfulCommit,
      }),
      checkoutGraphSource: async (
        _projectId: string,
        source: { commitSha: string },
        _signal: AbortSignal,
        destination: string,
      ) => {
        if (source.commitSha === failingCommit) throw new Error('Fixture checkout error');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'Dockerfile'), 'FROM scratch\n');
        await writeFile(join(destination, 'compose.yaml'), compose);
        await writeFile(join(destination, 'origin.txt'), source.commitSha);
        return {
          commitSha: source.commitSha,
          subject: 'Fixture ' + source.commitSha.slice(0, 8),
          shallow: true,
        };
      },
      refreshBranches: async () => ({
        defaultBranch: 'main',
        branches: [{ name: 'main', sha: successfulCommit }],
        status: 'CURRENT',
      }),
      branchHeads: async (_projectId: string, _repositoryId: string, branches: string[]) =>
        new Map(
          branches.flatMap((branch) => {
            if (branch === 'release/service') return [[branch, successfulCommit]];
            if (branch === 'release/shared') return [[branch, auxiliaryCommit]];
            return [];
          }),
        ),
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
    rawBody: true,
  });
  configureApp(app);
  try {
    await app.init();
    const api = request.agent(app.getHttpServer());
    const post = (path: string, body: object) => api.post(`/api/v1${path}`).send(body);
    const create = async (path: string, body: object) => {
      const response = await post(path, body);
      assert.equal(response.status, 201, path + ' ' + JSON.stringify(response.body));
      return response.body.data;
    };
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
    const otherProject = await create('/projects', {
      name: 'Second delivery project',
      slug: 'delivery-other',
    });
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
    assert.ok(managerCheckouts[0].includes(`--depth=1 origin '${successfulCommit}'`));
    const buildPayload = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', build.id)
      .executeTakeFirstOrThrow();
    const legacySnapshot = JSON.parse(buildPayload.payload_json).pipeline;
    assert.equal(legacySnapshot.projectName, project.name);
    assert.equal(legacySnapshot.serviceName, service.name);
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
    const settingsPath = `/api/v1/projects/${project.id}/execution-settings`;
    const buildOnly = { ...base, mode: 'BUILD_ONLY', commitSha: successfulCommit };
    const originalPreview = await create(`${targetPath}/preview`, buildOnly);
    assert.equal(originalPreview.targetWorkspaceRoot, '~/.veyops/workspace');
    await api.patch(settingsPath).send({ targetWorkspaceRoot: '/srv/ci builds' }).expect(200);
    await api
      .post(`/api/v1${targetPath}/run`)
      .send({
        ...buildOnly,
        expectedConfigurationHash: originalPreview.configurationHash,
      })
      .expect(409);
    const updatedPreview = await create(`${targetPath}/preview`, buildOnly);
    assert.equal(updatedPreview.targetWorkspaceRoot, '/srv/ci builds');
    await api.patch(settingsPath).send({ targetWorkspaceRoot: null }).expect(200);
    failedBuildServer = serverIds[1];
    const strict = await create(`${targetPath}/run`, { ...base, commitSha: successfulCommit });
    const strictBuild = await runTask(strict.id);
    assert.equal(strictBuild.status, 'PARTIAL_FAILED');
    assert.equal(
      remoteCommands.filter(({ command }) =>
        command.includes(`--depth=1 origin '${successfulCommit}'`),
      ).length,
      2,
    );
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
      const fallbackStart: number = remoteCommands.length;
      assert.equal((await runTask(archivedPush.deploymentTaskId)).status, 'SUCCESS');
      const fallbackCommands: string[] = remoteCommands
        .slice(fallbackStart)
        .map(({ command }) => command);
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

    const saveApprovalPolicy = (requireApproval: boolean) =>
      api
        .put(`/api/v1/services/${service.id}/environments/${environment.id}/config`)
        .send({
          targetId: target.id,
          artifactType: 'FILE',
          deployMethod: 'FILE',
          buildLocation: 'MANAGER',
          deployPath: definition.deployPath,
          releasePolicy: { requireApproval },
        })
        .expect(200);
    await saveApprovalPolicy(true);
    const runProtected = async (disableAfterSubmit = false) => {
      const started = await create(`${managerPath}/run`, { ...base, commitSha: successfulCommit });
      if (disableAfterSubmit) await saveApprovalPolicy(false);
      const built = await runTask(started.id);
      assert.ok(built.deploymentTaskId);
      const pending = await getTask(built.deploymentTaskId);
      assert.equal(pending.approvalStatus, 'PENDING');
      const activationCount = activations().length;
      await worker.tick();
      assert.equal(activations().length, activationCount);
      const approvals = (await api.get('/api/v1/deployments/approvals').expect(200)).body.data;
      assert.ok(approvals.some((entry: { id: string }) => entry.id === pending.id));
      const approvalQuery = {
        projectId: project.id,
        serviceId: service.id,
        environmentId: environment.id,
        commit: 'AAA',
        recordId: pending.id,
      };
      const pendingList = (
        await api.get('/api/v1/deployments/approvals').query(approvalQuery).expect(200)
      ).body.data;
      assert.deepEqual(
        pendingList.map((row: { id: string }) => row.id),
        [pending.id],
      );
      assert.deepEqual(
        (
          await api
            .get('/api/v1/deployments/approvals')
            .query({ ...approvalQuery, projectId: otherProject.id })
            .expect(200)
        ).body.data,
        [],
      );
      const approved = await create(`/deployments/approvals/${pending.id}/approve`, {});
      assert.equal(approved.approvalStatus, 'APPROVED');
      await post(`/deployments/approvals/${pending.id}/approve`, {}).expect(409);
      return runTask(pending.id);
    };
    const rollbackSource = await runProtected(true);
    assert.equal(rollbackSource.status, 'SUCCESS');
    await saveApprovalPolicy(true);
    const nextVersion = await runProtected();
    assert.equal(nextVersion.status, 'SUCCESS');
    const history = await db
      .selectFrom('deployment_records')
      .selectAll()
      .where('pipeline_run_id', '=', rollbackSource.pipelineRunId)
      .where('server_id', '=', serverIds[0]!)
      .executeTakeFirstOrThrow();
    const selectedPolicy = (
      await api
        .put(`/api/v1/services/${service.id}/environments/${environment.id}/config`)
        .send({
          targetId: target.id,
          artifactType: 'FILE',
          deployMethod: 'FILE',
          buildLocation: 'MANAGER',
          deployPath: definition.deployPath,
          releasePolicy: {
            requireApproval: true,
            rollbackMode: 'PINNED',
            pinnedDeploymentId: history.id,
          },
        })
        .expect(200)
    ).body.data.releasePolicy;
    const baselineSnapshot = app.get(DeploymentsService).rollbackSnapshot(history);
    assert.ok(baselineSnapshot);
    for (const id of serverIds) {
      const fixed = await app
        .get(DeploymentsService)
        .rollbackCandidate({ ...baselineSnapshot.snapshot, releasePolicy: selectedPolicy }, id);
      assert.ok(fixed);
      assert.equal(fixed.snapshot.runId, rollbackSource.pipelineRunId);
      assert.notEqual(fixed.currentReleaseKey, fixed.releaseKey);
    }
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

    const group = await create('/server-groups', {
      name: 'Direct release group',
      serverIds: [serverIds[1]],
    });
    const directConfig = {
      serverIds: [serverIds[0]],
      groupIds: [group.id],
      strategy: 'SEQUENTIAL',
      maxParallel: 1,
      failurePolicy: 'STOP',
      artifactType: 'FILE',
      deployMethod: 'FILE',
      buildLocation: 'MANAGER',
      deployPath: definition.deployPath,
      releasePolicy: { requireApproval: false },
    };
    const saved = (
      await api
        .put(`/api/v1/services/${service.id}/environments/${environment.id}/config`)
        .send(directConfig)
        .expect(200)
    ).body.data;
    assert.equal(saved.targetId, null);
    assert.deepEqual(saved.targetSelection.groupIds, [group.id]);
    const direct = { environmentId: environment.id, commitSha: successfulCommit, confirmed: true };
    const initialPreview = await create(`${managerPath}/preview`, direct);
    assert.deepEqual(initialPreview.serverIds, serverIds);
    await post(`${managerPath}/run`, direct).expect(409);
    await api
      .patch(`/api/v1/server-groups/${group.id}`)
      .send({ name: group.name, serverIds: [serverIds[0]] })
      .expect(200);
    await post(`${managerPath}/run`, {
      ...direct,
      expectedConfigurationHash: initialPreview.configurationHash,
    }).expect(409);
    const currentPreview = await create(`${managerPath}/preview`, direct);
    assert.deepEqual(currentPreview.serverIds, [serverIds[0]]);
    const directTask = await create(`${managerPath}/run`, {
      ...direct,
      expectedConfigurationHash: currentPreview.configurationHash,
    });
    await api
      .patch(`/api/v1/server-groups/${group.id}`)
      .send({ name: group.name, serverIds: [serverIds[1]] })
      .expect(200);
    const directBuild = await runTask(directTask.id);
    assert.equal(directBuild.status, 'SUCCESS');
    assert.ok(directBuild.deploymentTaskId);
    const directRelease = await runTask(directBuild.deploymentTaskId);
    assert.equal(directRelease.status, 'SUCCESS');
    const directRecords = await db
      .selectFrom('deployment_records')
      .select('server_id')
      .where('pipeline_run_id', '=', directRelease.pipelineRunId)
      .execute();
    assert.deepEqual(directRecords, [{ server_id: serverIds[0] }]);
    const archived = await api
      .get(`/api/v1/artifacts?pipelineRunId=${directBuild.pipelineRunId}`)
      .expect(200);
    assert.deepEqual(archived.body.data[0].targetSelection, {
      serverIds: [serverIds[0]],
      groupIds: [],
      strategy: directConfig.strategy,
      maxParallel: directConfig.maxParallel,
      failurePolicy: directConfig.failurePolicy,
    });
    const run = await db
      .selectFrom('pipeline_runs')
      .select(['target_id', 'target_selection_json'])
      .where('id', '=', directRelease.pipelineRunId)
      .executeTakeFirstOrThrow();
    assert.equal(run.target_id, null);
    assert.deepEqual(JSON.parse(run.target_selection_json!).serverIds, [serverIds[0]]);
    assert.equal((await db.selectFrom('deployment_targets').select('id').execute()).length, 1);
    const server = (await api.get(`/api/v1/servers/${serverIds[0]}`).expect(200)).body.data;
    assert.ok(server.projects.some((item: { id: string }) => item.id === project.id));

    const sharedRepo = await create(`/projects/${project.id}/repositories`, {
      name: 'Shared',
      cloneUrl: 'https://repo.example.test/team/shared.git',
    });
    const nodeEnvironment = await create(`/projects/${project.id}/environments`, {
      name: 'Node checks',
      slug: 'node-checks',
      environmentType: 'TESTING',
    });
    const customCredential = await create('/credentials', {
      name: 'Node value',
      type: 'CUSTOM_SECRET',
      secret: { value: 'node-private-fixture' },
    });
    const nodes = [
      {
        id: 'source',
        name: 'Source',
        type: 'CHECKOUT',
        environmentBranches: { [nodeEnvironment.id]: 'release/service' },
      },
      {
        id: 'shared',
        name: 'Shared source',
        type: 'CHECKOUT',
        repositoryId: sharedRepo.id,
        branch: 'release/shared',
        directory: 'modules/shared',
      },
      {
        id: 'environment',
        name: 'Environment',
        type: 'ENVIRONMENT',
        variables: [
          { key: 'NODE_FLAG', value: 'checked' },
          { key: 'TEST_TOKEN', credentialId: customCredential.id },
        ],
      },
      { id: 'build', name: 'Build', type: 'BUILD', command: 'echo BUILD_NODE_FIXTURE' },
      { id: 'test', name: 'Test', type: 'TEST', command: 'test "$NODE_FLAG" = checked' },
      { id: 'archive', name: 'Archive', type: 'PACKAGE' },
      { id: 'publish', name: 'Publish', type: 'DEPLOY' },
    ];
    const composedInput = {
      name: 'Composed delivery',
      projectId: project.id,
      serviceId: service.id,
      definition: {
        ...definition,
        deployPath: '/opt/pipeline-composed',
        buildLocation: 'MANAGER',
        nodes,
      },
    };
    await post('/pipelines', {
      ...composedInput,
      definition: { ...composedInput.definition, nodes: [nodes[0], nodes[3], ...nodes.slice(1)] },
    }).expect(400);
    const composed = await create('/pipelines', composedInput);
    await api.delete(`/api/v1/projects/${project.id}/repositories/${sharedRepo.id}`).expect(409);
    await api.delete(`/api/v1/credentials/${customCredential.id}`).expect(409);
    const composedPath = `/pipelines/${composed.id}`;
    const selection = {
      environmentId: nodeEnvironment.id,
      serverIds: [serverIds[0]],
      confirmed: true,
    };
    const previewNodes = await create(`${composedPath}/preview`, selection);
    assert.equal(previewNodes.commitSha, successfulCommit);
    assert.deepEqual(previewNodes.nodeSources, [
      {
        id: 'source',
        repositoryId: repo.id,
        branch: 'release/service',
        commitSha: successfulCommit,
      },
      {
        id: 'shared',
        repositoryId: sharedRepo.id,
        branch: 'release/shared',
        commitSha: auxiliaryCommit,
      },
    ]);
    auxiliaryCommit = 'd'.repeat(40);
    await post(`${composedPath}/run`, {
      ...selection,
      expectedConfigurationHash: previewNodes.configurationHash,
    }).expect(409);
    auxiliaryCommit = 'c'.repeat(40);

    const assertSteps = async (id: string, expected: string[]) => {
      const steps = (await api.get(`/api/v1/tasks/${id}/steps`).expect(200)).body.data as {
        key: string;
        status: string;
      }[];
      const tracked = steps.filter(({ key }) => key.startsWith('node:'));
      assert.deepEqual(
        tracked.map(({ key }) => key.slice(5)),
        expected,
      );
      assert.ok(tracked.every(({ status }) => status === 'SUCCESS'));
    };
    for (const buildLocation of ['MANAGER', 'TARGET']) {
      const pipeline =
        buildLocation === 'MANAGER'
          ? composed
          : await create('/pipelines', {
              ...composedInput,
              definition: { ...composedInput.definition, buildLocation },
            });
      const path = `/pipelines/${pipeline.id}`;
      const preview = await create(`${path}/preview`, selection);
      const managerOffset = managerCheckouts.length;
      const targetOffset = remoteCommands.length;
      const queued = await create(`${path}/run`, {
        ...selection,
        expectedConfigurationHash: preview.configurationHash,
      });
      const completed = await runTask(queued.id);
      assert.equal(completed.status, 'SUCCESS');
      const checkoutCommands =
        buildLocation === 'MANAGER'
          ? managerCheckouts.slice(managerOffset)
          : remoteCommands.slice(targetOffset).map(({ command }) => command);
      for (const sha of [successfulCommit, auxiliaryCommit])
        assert.ok(
          checkoutCommands.some((command) => command.includes(`--depth=1 origin '${sha}'`)),
        );
      assert.equal(completed.pipelineGraph.buildLocation, buildLocation);
      assert.deepEqual(
        completed.pipelineGraph.nodes,
        nodes.map(({ id, name, type }) => ({ id, name, type })),
      );
      await assertSteps(
        completed.id,
        nodes.slice(0, -1).map(({ id }) => id),
      );
      assert.ok(completed.deploymentTaskId);
      const released = await runTask(completed.deploymentTaskId);
      assert.equal(released.status, 'SUCCESS');
      await assertSteps(released.id, ['publish']);
    }
    await api
      .patch(`/api/v1${composedPath}`)
      .send({
        name: composedInput.name,
        definition: { ...composedInput.definition, nodes: nodes.slice(0, -1) },
      })
      .expect(200);
    const buildOnlyPreview = await create(`${composedPath}/preview`, selection);
    assert.equal(buildOnlyPreview.mode, 'BUILD_ONLY');
    await post(`${composedPath}/preview`, { ...selection, mode: 'DEPLOY' }).expect(400);

    // The same commit can legitimately belong to several projects. Each list must apply
    // its project, service and environment predicates before returning any matching records.
    const otherRepo = await create(`/projects/${otherProject.id}/repositories`, {
      name: 'Repo',
      cloneUrl: 'https://repo.example.test/team/other.git',
    });
    const otherService = await create(`/projects/${otherProject.id}/services`, {
      name: 'Web',
      slug: 'web',
    });
    const otherEnv = await create(`/projects/${otherProject.id}/environments`, {
      name: 'Test',
      slug: 'test',
      environmentType: 'TESTING',
    });
    const otherPipeline = await create('/pipelines', {
      name: 'Second pipeline',
      projectId: otherProject.id,
      serviceId: otherService.id,
      definition: {
        ...definition,
        repositoryId: otherRepo.id,
        buildLocation: 'MANAGER',
        deployPath: '/opt/second-project',
      },
    });
    const otherBuild = await runTask(
      (
        await create(`/pipelines/${otherPipeline.id}/run`, {
          ...base,
          environmentId: otherEnv.id,
          commitSha: successfulCommit,
        })
      ).id,
    );
    assert.equal(otherBuild.status, 'SUCCESS');
    assert.equal((await runTask(otherBuild.deploymentTaskId)).status, 'SUCCESS');
    const scope = { serviceId: otherService.id, environmentId: otherEnv.id, commit: 'AAA' };
    const list = async (path: string, query: object) =>
      (
        await api
          .get('/api/v1' + path)
          .query(query)
          .expect(200)
      ).body.data;
    for (const [path, expected] of [
      ['/artifacts', 1],
      ['/deployments', 2],
    ] as const) {
      const rows = await list(path, { projectId: otherProject.id, ...scope });
      assert.equal(rows.length, expected);
      assert.ok(
        rows.every(
          (row: { projectId: string; sourceCommit: string }) =>
            row.projectId === otherProject.id && row.sourceCommit === successfulCommit,
        ),
      );
      for (const override of [
        { projectId: project.id },
        { serviceId: service.id },
        { environmentId: environment.id },
        { commit: 'f' },
      ]) {
        assert.deepEqual(
          await list(path, { projectId: otherProject.id, ...scope, ...override }),
          [],
        );
      }
      const [historical] = await list(path, { recordId: rows[0].id });
      assert.equal(historical.projectId, otherProject.id);
      assert.equal(
        (await list(path, { projectId: otherProject.id, taskId: historical.taskId })).length,
        expected,
      );
      assert.deepEqual(await list(path, { projectId: project.id, taskId: historical.taskId }), []);
      assert.deepEqual(await list(path, { recordId: historical.id, projectId: project.id }), []);
      assert.ok((await getTask(historical.taskId)).pipelineRunId);
    }
    assert.deepEqual(
      (await list('/pipelines', { projectId: otherProject.id, serviceId: otherService.id })).map(
        (item: { id: string }) => item.id,
      ),
      [otherPipeline.id],
    );
    assert.deepEqual(
      await list('/pipelines', { projectId: project.id, serviceId: otherService.id }),
      [],
    );
    await api.get('/api/v1/artifacts').query({ commit: '%' }).expect(400);
    const archivedService = await create(`/projects/${otherProject.id}/services`, {
      name: 'Archived service',
      slug: 'archived-service',
    });
    const archivedEnvironment = await create(`/projects/${otherProject.id}/environments`, {
      name: 'Archived environment',
      slug: 'archived-environment',
      environmentType: 'TESTING',
    });
    await api
      .delete(`/api/v1/projects/${otherProject.id}/services/${archivedService.id}`)
      .expect(200);
    await api
      .delete(`/api/v1/projects/${otherProject.id}/environments/${archivedEnvironment.id}`)
      .expect(200);
    const activeContext = (
      await api.get(`/api/v1/projects/${otherProject.id}/delivery-context`).expect(200)
    ).body.data;
    assert.deepEqual(activeContext.archivedServices, [
      { id: archivedService.id, name: archivedService.name },
    ]);
    assert.deepEqual(activeContext.archivedEnvironments, [
      { id: archivedEnvironment.id, name: archivedEnvironment.name },
    ]);
    assert.deepEqual(
      activeContext.services.map((row: { id: string }) => row.id),
      [otherService.id],
    );
    assert.deepEqual(
      activeContext.environments.map((row: { id: string }) => row.id),
      [otherEnv.id],
    );
    await api.delete('/api/v1/projects/' + otherProject.id).expect(200);
    await api.get('/api/v1/projects/' + otherProject.id).expect(404);
    const historicalContext = (
      await api.get(`/api/v1/projects/${otherProject.id}/delivery-context`).expect(200)
    ).body.data;
    assert.equal(historicalContext.archived, true);
    assert.equal(historicalContext.services[0].id, otherService.id);
    assert.equal((await list('/artifacts', { projectId: otherProject.id, ...scope })).length, 1);

    // Exercise all trigger entry points through the real queue, artifact and release services.
    // Docker and SSH commands use the same fixtures as the manual delivery tests above.
    process.env.WEBHOOK_BUILD_DOCKER_SOCKET = '/run/user/1000/fixture-docker.sock';
    const isolation = mock.method(
      app.get(BuildsService) as unknown as {
        configureWebhookDocker: () => Promise<void>;
      },
      'configureWebhookDocker',
      async () => {},
    );
    try {
      const runner = app.get(PipelineTriggersService);
      const autoEnv = await create(`/projects/${project.id}/environments`, {
        name: 'Automatic deployment',
        slug: 'automatic',
        environmentType: 'TESTING',
      });
      const autoPipeline = await create('/pipelines', {
        name: 'Auto',
        projectId: project.id,
        serviceId: service.id,
        definition: {
          ...definition,
          buildLocation: 'MANAGER',
          defaultMode: 'BUILD_ONLY',
          healthCheckCommand: 'echo AUTO_HEALTH_CHECK',
          deployPath: '/opt/automatic-delivery',
        },
      });
      const path = '/pipelines/' + autoPipeline.id;
      const key = 'fixture-integration-push-signature-key';
      const hookSecret = await create('/credentials', {
        name: 'Push',
        type: 'CUSTOM_SECRET',
        secret: { value: key },
      });
      const branch = 'release/shared';
      const settings = {
        environmentId: autoEnv.id,
        branch,
        secretCredentialId: hookSecret.id,
        enabled: true,
        followMode: true,
      };
      const sendPush = async (sha: string) => {
        const body = JSON.stringify({
          ref: 'refs/heads/' + branch,
          after: sha,
          repository: { clone_url: 'https://repo.example.test/team/app.git' },
        });
        return (
          await api
            .post('/api/v1/webhooks/gitea/' + autoPipeline.id)
            .set('Content-Type', 'application/json')
            .set('X-Gitea-Event', 'push')
            .set('X-Gitea-Signature', createHmac('sha256', key).update(body).digest('hex'))
            .send(body)
            .expect(200)
        ).body.data;
      };
      let commitNumber = 0;
      const setMode = (mode: string | null) =>
        api
          .put(`/api/v1/services/${service.id}/environments/${autoEnv.id}/config`)
          .send({
            targetId: target.id,
            buildLocation: 'MANAGER',
            executionMode: mode,
            artifactType: 'FILE',
            deployMethod: 'FILE',
            releasePolicy: { requireApproval: true, rollbackMode: 'PREVIOUS_HEALTHY' },
          })
          .expect(200);
      for (const mode of ['BUILD_ONLY', 'DEPLOY']) {
        await setMode(mode === 'DEPLOY' ? 'DEPLOY' : null);
        const preview = await create(path + '/webhook/preview', settings);
        assert.equal(preview.mode, mode);
        await api
          .put('/api/v1' + path + '/webhook')
          .send({ ...settings, expectedBindingHash: preview.bindingHash })
          .expect(200);
        for (const kind of ['POLL', 'WEBHOOK', 'SCHEDULE']) {
          auxiliaryCommit = (++commitNumber).toString(16).padStart(40, '0');
          let taskId: string;
          if (kind === 'WEBHOOK') {
            taskId = (await sendPush(auxiliaryCommit)).taskId;
            assert.equal((await sendPush(auxiliaryCommit)).taskId, taskId);
          } else {
            const config = {
              kind,
              environmentId: autoEnv.id,
              version: 1,
              branch,
              buildCurrent: true,
              timing:
                kind === 'POLL'
                  ? { type: 'INTERVAL', intervalSeconds: 3600 }
                  : { type: 'ONCE', runAt: Date.now() + 3600_000 },
            };
            const rulePreview = await create(path + '/triggers/preview', config);
            assert.equal(rulePreview.mode, mode);
            const rule = await create(path + '/triggers', {
              ...config,
              expectedConfigurationHash: rulePreview.configurationHash,
            });
            await runner.tick(rule.nextAt);
            const submitted = await db
              .selectFrom('pipeline_trigger_history')
              .selectAll()
              .where('trigger_id', '=', rule.id)
              .where('status', '=', 'QUEUED')
              .executeTakeFirstOrThrow();
            assert.equal(submitted.commit_sha, auxiliaryCommit);
            taskId = submitted.task_id!;
            if (kind === 'POLL') {
              assert.equal((await sendPush(auxiliaryCommit)).taskId, taskId);
              await create(path + '/triggers/' + rule.id + '/disable', {});
            }
          }
          const build = await runTask(taskId);
          assert.equal(build.status, 'SUCCESS', build.errorSummary);
          assert.equal(build.triggerType, kind);
          const artifact = await db
            .selectFrom('artifacts')
            .select('source_commit')
            .where('pipeline_run_id', '=', build.pipelineRunId)
            .executeTakeFirstOrThrow();
          assert.equal(artifact.source_commit, auxiliaryCommit);
          if (mode === 'BUILD_ONLY') assert.equal(build.deploymentTaskId, null);
          else {
            const release = await getTask(build.deploymentTaskId);
            assert.equal(release.triggerType, kind);
            assert.equal(release.approvalStatus, 'PENDING');
            await create('/deployments/approvals/' + release.id + '/approve', {});
            assert.equal((await runTask(release.id)).status, 'SUCCESS');
          }
        }
      }
      const beforeFailure = new Map(releaseLinks);
      const buildFailure = await runTask((await sendPush(failingCommit)).taskId);
      assert.equal(buildFailure.status, 'FAILED');
      assert.equal(buildFailure.deploymentTaskId, null);
      assert.deepEqual(releaseLinks, beforeFailure);
      const badRelease = await runTask((await sendPush('e'.repeat(40))).taskId);
      await create('/deployments/approvals/' + badRelease.deploymentTaskId + '/approve', {});
      failNextHealthCheck = true;
      assert.equal((await runTask(badRelease.deploymentTaskId)).status, 'PARTIAL_FAILED');
      const restored = await db
        .selectFrom('deployment_records')
        .select(['health_status', 'rollback_of_deployment_id'])
        .where('environment_id', '=', autoEnv.id)
        .where('rollback_of_deployment_id', 'is not', null)
        .execute();
      assert.ok(restored.some((record) => record.health_status === 'HEALTHY'));
    } finally {
      isolation.mock.restore();
    }

    const graphPath = '/projects/' + project.id + '/execution-graph';
    const dependencyRepo = await create('/projects/' + project.id + '/repositories', {
      name: 'Graph schema',
      cloneUrl: 'https://repo.example.test/team/schema.git',
    });
    await api
      .put('/api/v1/services/' + service.id + '/repositories')
      .send({
        repositories: [{ repositoryId: repo.id, repoPath: '.', isPrimary: true }],
      })
      .expect(200);
    const graph = (await api.get('/api/v1' + graphPath).expect(200)).body.data;
    const graphEnv = await create('/projects/' + project.id + '/environments', {
      name: 'Graph release',
      slug: 'graph-release',
      environmentType: 'TESTING',
    });
    const scoped = [
      { id: 'environment', name: '环境', type: 'ENVIRONMENT', defaultValue: graphEnv.id },
      { id: 'service', name: '服务', type: 'SERVICE', defaultValue: service.id },
    ];
    const version = {
      id: 'version',
      name: '源码版本',
      type: 'GIT_REF',
      defaultValue: { kind: 'COMMIT', value: successfulCommit },
    };
    const targets = {
      id: 'targets',
      name: '服务器',
      type: 'TARGETS',
      defaultValue: { serverIds: [serverIds[0]] },
    };
    const historical = {
      id: 'image',
      name: '历史镜像',
      type: 'ARTIFACT',
      artifactType: 'DOCKER_IMAGE',
      multiple: true,
    };
    const from = (nodeId: string, fieldId: string) => ({ kind: 'OUTPUT', nodeId, fieldId });
    const input = (fieldId: string) => ({ kind: 'INPUT', fieldId });
    const outputs = [
      {
        id: 'jar',
        name: 'JAR 产物',
        type: 'ARTIFACT',
        artifactType: 'FILE',
        multiple: true,
        source: 'CURRENT_RUN',
      },
      {
        id: 'image',
        name: 'Docker 镜像',
        type: 'ARTIFACT',
        artifactType: 'DOCKER_IMAGE',
        multiple: true,
        source: 'CURRENT_RUN',
      },
    ];
    const typedNodes = [
      {
        id: 'custom',
        type: 'START',
        name: 'Shell 构建',
        inputs: [
          ...scoped,
          {
            id: 'outputDir',
            name: '产物目录',
            referenceName: 'ARTIFACT_DIR',
            type: 'PATH',
            defaultValue: 'custom-dist',
          },
        ],
      },
      {
        id: 'script',
        type: 'SHELL',
        name: '生成文件',
        shell: {
          location: 'MANAGER',
          command: 'echo GRAPH_SHELL_FIXTURE',
          params: [{ id: 'OUT_DIR', name: '输出目录', type: 'PATH' }],
        },
        outputs: [{ id: 'result', name: '结果', type: 'TEXT' }],
      },
      {
        id: 'register',
        type: 'FUNCTION',
        operation: 'REGISTER_ARTIFACT',
        name: '登记 Shell 产物',
        inputs: [
          {
            id: 'path',
            name: '产物目录',
            referenceName: 'ARTIFACT_DIR',
            type: 'PATH',
            defaultValue: './dist',
          },
        ],
        registerArtifacts: { artifacts: [{ name: 'static', type: 'DIRECTORY', path: 'unused' }] },
      },
      {
        id: 'custom-end',
        type: 'END',
        name: '返回目录',
        outputs: [
          {
            id: 'directory',
            name: '静态站点',
            type: 'ARTIFACT',
            multiple: true,
            artifactType: 'DIRECTORY',
            source: 'CURRENT_RUN',
          },
        ],
      },
      { id: 'build', type: 'START', name: '仅构建', inputs: [...scoped, version] },
      { id: 'composed', type: 'START', name: '构建并部署', inputs: [...scoped, version, targets] },
      {
        id: 'release',
        type: 'START',
        name: '发布历史镜像',
        inputs: [...scoped, targets, historical],
      },
      {
        id: 'latest',
        type: 'START',
        name: '发布最新镜像',
        inputs: [...scoped, targets, { ...historical, selection: 'LATEST_COMPATIBLE' }],
      },
      {
        id: 'git-actual',
        type: 'CHECKOUT',
        name: '实际服务源码',
        checkout: { repositoryId: sharedRepo.id, mode: 'COMMIT', commitSha: successfulCommit },
      },
      {
        id: 'git-schema',
        type: 'CHECKOUT',
        name: '实际构建依赖',
        checkout: { repositoryId: dependencyRepo.id, mode: 'COMMIT', commitSha: auxiliaryCommit },
      },
      {
        id: 'git-unused',
        type: 'CHECKOUT',
        name: '未绑定的源码',
        checkout: { repositoryId: repo.id, mode: 'COMMIT', commitSha: successfulCommit },
      },
      {
        id: 'build-node',
        type: 'BUILD',
        name: '构建归档',
        build: {
          buildLocation: 'MANAGER',
          dependencies: ['schema'],
          buildCommand: 'echo GRAPH_DEPENDENCY_FIXTURE',
          artifacts: [
            { name: 'jar', type: 'FILE', path: 'app.jar' },
            { name: 'image', type: 'DOCKER_IMAGE', path: 'Dockerfile' },
          ],
        },
      },
      {
        id: 'deploy-node',
        type: 'DEPLOY_ARTIFACT',
        name: '部署共享节点',
        deploy: { deployPath: '/opt/graph-native', healthCheckCommand: 'test -f compose.yaml' },
      },
      { id: 'build-end', type: 'END', name: '返回 JAR 和镜像', outputs },
      {
        id: 'release-end',
        type: 'END',
        name: '返回发布',
        outputs: [{ id: 'release', name: '发布结果', type: 'RELEASE' }],
      },
    ];
    const edges = [
      ['custom', 'script'],
      ['script', 'register'],
      ['register', 'custom-end'],
      ['build', 'git-actual'],
      ['composed', 'git-actual'],
      ['git-actual', 'git-schema'],
      ['git-schema', 'git-unused'],
      ['git-unused', 'build-node'],
      ['build-node', 'build-end'],
      ['build-node', 'deploy-node'],
      ['release', 'deploy-node'],
      ['latest', 'deploy-node'],
      ['deploy-node', 'release-end'],
    ].map(([from, to]) => ({ from, to }));
    const buildBindings = {
      'git-actual': { version: input('version') },
      'build-node': {
        workspace: from('git-actual', 'workspace'),
        dependency_schema: from('git-schema', 'workspace'),
      },
    };
    const releaseEndpoint = (startId: string, artifact: object) => ({
      startId,
      endId: 'release-end',
      serviceId: service.id,
      inputBindings: {
        ...(startId === 'composed' && buildBindings),
        'deploy-node': { artifact },
      },
      outputBindings: { release: from('deploy-node', 'release') },
    });
    const definitionWithDelivery = {
      flows: [],
      canvas: {
        nodes: typedNodes,
        edges,
        templates: [],
        endpoints: [
          {
            startId: 'custom',
            endId: 'custom-end',
            inputBindings: {
              script: { OUT_DIR: input('outputDir') },
              register: { workspace: from('script', 'workspace') },
            },
            outputBindings: { directory: from('register', 'static') },
          },
          {
            startId: 'build',
            endId: 'build-end',
            inputBindings: buildBindings,
            outputBindings: { jar: from('build-node', 'jar'), image: from('build-node', 'image') },
          },
          releaseEndpoint('composed', from('build-node', 'image')),
          releaseEndpoint('release', input('image')),
          releaseEndpoint('latest', input('image')),
        ],
      },
    };
    const edited = (
      await api
        .put('/api/v1' + graphPath + '/draft')
        .send({ expectedRevision: graph.revision, definition: definitionWithDelivery })
        .expect(200)
    ).body.data;
    const published = await create(graphPath + '/publish', { expectedRevision: edited.revision });
    const waitGraph = async (id: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const detail = (await api.get('/api/v1' + graphPath + '/runs/' + id).expect(200)).body.data;
        if (
          !['QUEUED', 'RUNNING', 'WAITING', 'PENDING', 'CANCEL_REQUESTED'].includes(detail.status)
        )
          return detail;
        await worker.tick();
        await delay(15);
      }
      assert.fail('Graph run did not finish: ' + id);
    };
    const args = (parameters: object = {}) => ({
      version: published.publishedVersion,
      inputs: { parameters },
    });
    const submit = async (entry: string, inputs: object = {}) => {
      const path = graphPath + '/flows/' + entry;
      const request = args(inputs);
      const reviewed = await create(path + '/preview', request);
      const confirmed = {
        ...request,
        idempotencyKey: randomUUID(),
        expectedConfigurationHash: reviewed.configurationHash,
      };
      const run = await create(path + '/run', confirmed);
      assert.equal((await create(path + '/run', confirmed)).id, run.id);
      return { reviewed, detail: await waitGraph(run.id) };
    };
    const custom = await submit('custom');
    assert.equal(custom.detail.status, 'SUCCESS', JSON.stringify(custom.detail.nodes));
    assert.equal(custom.detail.outputs.directory[0].type, 'DIRECTORY');
    const inspected = custom.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'register',
    );
    assert.equal(
      inspected.inputs.find(({ fieldId }: { fieldId: string }) => fieldId === 'path').value,
      'custom-dist',
    );
    const scriptResult = custom.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'script',
    );
    assert.equal(scriptResult.output.result, 'generated');
    const beforePublish = remoteCommands.length;
    const onlyBuild = await submit('build');
    assert.deepEqual(onlyBuild.reviewed.deliveries[0].serverIds, []);
    assert.equal(onlyBuild.detail.status, 'SUCCESS', JSON.stringify(onlyBuild.detail.nodes));
    assert.deepEqual(
      onlyBuild.reviewed.deliveries[0].sourceSnapshot.map(
        (source: { repositoryId: string }) => source.repositoryId,
      ),
      [sharedRepo.id, dependencyRepo.id],
    );
    assert.equal(remoteCommands.length, beforePublish, 'Standalone manager build never opens SSH');
    const artifactRows = await db
      .selectFrom('artifacts')
      .selectAll()
      .where('graph_run_id', '=', onlyBuild.detail.id)
      .orderBy('artifact_name')
      .execute();
    assert.deepEqual(
      artifactRows.map((row) => [row.artifact_name, row.artifact_kind, row.source_commit]),
      [
        ['image', 'DOCKER_IMAGE', successfulCommit],
        ['jar', 'FILE', successfulCommit],
      ],
    );
    assert(artifactRows.every((row) => row.graph_node_run_id && row.checksum === checksum));
    const savedImage = artifactRows[0]!.id;
    const [produced] = await list('/artifacts', {
      projectId: project.id,
      serviceId: service.id,
      environmentId: graphEnv.id,
      recordId: savedImage,
    });
    assert.equal(produced.name, 'image');
    assert.equal(produced.graphRunId, onlyBuild.detail.id);
    assert.equal(produced.graphNodeName, '构建归档');
    assert.equal(produced.graphVersion, published.publishedVersion);
    assert.equal(produced.imageOrigin, 'BUILD');
    assert.deepEqual(produced.composeTemplate, {
      source: 'ARCHIVE',
      path: 'compose.yaml',
      checksum: createHash('sha256').update(compose).digest('hex'),
    });
    assert.deepEqual(
      produced.sources.map(
        (source: { repositoryId: string; commitSha: string; subject: string }) => [
          source.repositoryId,
          source.commitSha,
          source.subject,
        ],
      ),
      [
        [sharedRepo.id, successfulCommit, 'Fixture ' + successfulCommit.slice(0, 8)],
        [dependencyRepo.id, auxiliaryCommit, 'Fixture ' + auxiliaryCommit.slice(0, 8)],
      ],
    );
    assert.ok(
      produced.sources.every(
        (source: { workspace?: { runId: string } }) =>
          source.workspace?.runId === onlyBuild.detail.id,
      ),
    );
    assert.equal(
      (
        await list('/artifacts', {
          projectId: project.id,
          recordId: savedImage,
          repositoryId: dependencyRepo.id,
          commit: auxiliaryCommit.slice(0, 12),
        })
      ).length,
      1,
    );
    assert.equal(
      (
        await list('/artifacts', {
          projectId: project.id,
          recordId: savedImage,
          repositoryId: dependencyRepo.id,
          commit: successfulCommit,
        })
      ).length,
      0,
    );
    assert.equal(
      (
        await list('/artifacts', {
          projectId: project.id,
          recordId: savedImage,
          repositoryId: repo.id,
          commit: successfulCommit,
        })
      ).length,
      0,
    );
    const buildEnd = onlyBuild.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'build-end',
    );
    assert.deepEqual(
      buildEnd.output.jar.map((value: { id: string }) => value.id),
      [artifactRows[1]!.id],
    );
    assert.deepEqual(
      buildEnd.output.image.map((value: { id: string }) => value.id),
      [savedImage],
    );
    const historicalRelease = await submit('release', { image: [savedImage] });
    assert.equal(
      historicalRelease.detail.status,
      'SUCCESS',
      JSON.stringify(historicalRelease.detail.nodes),
    );
    assert.deepEqual(historicalRelease.reviewed.deliveries[0].artifactIds, [savedImage]);
    assert.deepEqual(
      historicalRelease.reviewed.deliveries[0].artifactRefs[0].composeTemplate,
      produced.composeTemplate,
    );
    const combined = await submit('composed');
    assert.equal(combined.detail.status, 'SUCCESS', JSON.stringify(combined.detail.nodes));
    const releaseNode = combined.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'release-end',
    );
    assert.equal(releaseNode.output.release.status, 'SUCCESS');
    assert.notEqual(releaseNode.output.release.deployments[0].artifactId, savedImage);
    const deploymentTask = combined.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'deploy-node',
    ).taskId;
    const [released] = await list('/deployments', {
      projectId: project.id,
      taskId: deploymentTask,
    });
    assert.equal(released.artifactId, releaseNode.output.release.deployments[0].artifactId);
    assert.equal(released.graphRunId, combined.detail.id);
    assert.equal(released.graphNodeName, '部署共享节点');
    assert.equal(released.graphVersion, published.publishedVersion);
    assert.equal(released.serverHost, 'host-first.test');
    assert.deepEqual(released.composeRelease, {
      template: produced.composeTemplate,
      imageReference: (await list('/artifacts', { recordId: released.artifactId }))[0].storageKey,
      imageId,
    });
    const implicitLatest = await submit('latest');
    assert.equal(
      implicitLatest.detail.status,
      'SUCCESS',
      JSON.stringify(implicitLatest.detail.nodes),
    );
    assert.deepEqual(implicitLatest.reviewed.deliveries[0].artifactIds, [
      releaseNode.output.release.deployments[0].artifactId,
    ]);
    const graphConfigPath = `/api/v1/services/${service.id}/environments/${graphEnv.id}/config`;
    await api
      .put(graphConfigPath)
      .send({ ...directConfig, releasePolicy: { requireCodeReview: true } })
      .expect(200);
    const historicalInput = args({ image: [savedImage] });
    const reviewPreview = graphPath + '/flows/release/preview';
    await post(reviewPreview, historicalInput).expect(409);
    await api
      .put(
        '/api/v1/projects/' +
          project.id +
          '/services/' +
          service.id +
          '/environments/' +
          graphEnv.id +
          '/source-reviews/' +
          successfulCommit,
      )
      .send({ decision: 'APPROVED', repositoryId: sharedRepo.id })
      .expect(200);
    await post(reviewPreview, historicalInput).expect(409);
    await api
      .put(
        '/api/v1/projects/' +
          project.id +
          '/services/' +
          service.id +
          '/environments/' +
          graphEnv.id +
          '/source-reviews/' +
          auxiliaryCommit,
      )
      .send({ decision: 'APPROVED', repositoryId: dependencyRepo.id })
      .expect(200);
    assert.equal(
      (await create(reviewPreview, historicalInput)).deliveries[0].requireCodeReview,
      true,
    );

    const previousAutomaticKinds = process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
    const previousBuildSocket = process.env.WEBHOOK_BUILD_DOCKER_SOCKET;
    process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS = 'API,WEBHOOK,CRON,UPSTREAM';
    process.env.WEBHOOK_BUILD_DOCKER_SOCKET = '/run/user/1000/fixture-docker.sock';
    try {
      await api
        .put(graphConfigPath)
        .send({
          ...directConfig,
          releasePolicy: { requireCodeReview: true, requireApproval: true },
        })
        .expect(200);
      const triggerPath = graphPath + '/triggers';
      const triggers = app.get(GraphTriggersService);
      const releaseRule = {
        name: 'Automatic archive release',
        enabled: true,
        version: published.publishedVersion,
        flowId: 'release',
        parameterMappings: { image: { source: 'VALUE', value: [savedImage] } },
      };
      const events = (ruleId: string) => list(triggerPath + '/' + ruleId + '/events', {});
      const invoke = (ruleId: string, eventId: string) =>
        post(triggerPath + '/' + ruleId + '/invoke', {
          eventId,
          repositoryId: repo.id,
          commitSha: failingCommit,
        }).expect(202);
      const releaseTaskFor = async (
        ruleId: string,
        kind: string,
        approval: 'PENDING' | null = 'PENDING',
      ) => {
        const rows = await events(ruleId);
        assert.equal(rows.length, 1, JSON.stringify(rows));
        const [event] = rows;
        assert.equal(event.status, 'QUEUED', JSON.stringify(event));
        const run = (await api.get('/api/v1' + graphPath + '/runs/' + event.runId).expect(200)).body
          .data;
        assert.equal(run.triggerType, kind);
        if (kind === 'API' || kind === 'WEBHOOK')
          assert.equal(run.trigger.commitSha, failingCommit);
        const node = run.nodes.find((item: { nodeId: string }) => item.nodeId === 'deploy-node');
        assert.ok(node.taskId, JSON.stringify(node));
        const task = await getTask(node.taskId);
        assert.equal(task.triggerType, kind);
        assert.equal(task.approvalStatus, approval);
        const row = await db
          .selectFrom('tasks')
          .select('payload_json')
          .where('id', '=', task.id)
          .executeTakeFirstOrThrow();
        const payload = JSON.parse(row.payload_json) as {
          pipeline: PipelineSnapshot;
          targets: { id: string }[];
        };
        assert.equal(payload.pipeline.graphAutomation?.ruleId, ruleId);
        assert.equal(payload.pipeline.commitSha, successfulCommit);
        assert.deepEqual(
          payload.pipeline.deploymentArtifacts?.map(({ id }) => id),
          [savedImage],
        );
        assert.deepEqual(
          payload.targets.map(({ id }) => id),
          [serverIds[0]],
        );
        return task.id as string;
      };
      const previousRemoteCommands = remoteCommands.length;
      const autoBuild = await create(triggerPath, {
        ...releaseRule,
        kind: 'API',
        flowId: 'build',
        parameterMappings: {},
      });
      const builder = mock.method(
        app.get(BuildsService) as unknown as { configureWebhookDocker: () => Promise<void> },
        'configureWebhookDocker',
        async () => {},
      );
      try {
        await invoke(autoBuild.id, 'native-api-build');
        await triggers.tick();
        const [buildEvent] = await events(autoBuild.id);
        assert.equal(buildEvent.status, 'QUEUED', JSON.stringify(buildEvent));
        const run = await waitGraph(buildEvent.runId);
        assert.equal(run.status, 'SUCCESS', JSON.stringify(run.nodes));
        assert.equal(run.trigger.commitSha, failingCommit);
        const node = run.nodes.find((item: { nodeId: string }) => item.nodeId === 'build-node');
        const task = await getTask(node.taskId);
        assert.equal(task.triggerType, 'API');
        assert.equal(task.deploymentTaskId, null);
        assert.equal(builder.mock.callCount(), 1);
        assert.ok(
          run.deliveries[0].sourceSnapshot.some(
            (source: { repositoryId: string; commitSha: string }) =>
              source.repositoryId === sharedRepo.id && source.commitSha === successfulCommit,
          ),
        );
      } finally {
        builder.mock.restore();
      }
      assert.equal(remoteCommands.length, previousRemoteCommands);

      const hookKey = randomBytes(32).toString('hex');
      const hookCredential = await create('/credentials', {
        name: 'Native archive release signature',
        type: 'CUSTOM_SECRET',
        secret: { value: hookKey },
      });
      const nativeApi = await create(triggerPath, { ...releaseRule, kind: 'API' });
      const nativeHook = await create(triggerPath, {
        ...releaseRule,
        kind: 'WEBHOOK',
        credentialId: hookCredential.id,
        repositoryId: repo.id,
        refPrefix: 'refs/heads/release/',
      });
      const nativeCron = await create(triggerPath, {
        ...releaseRule,
        kind: 'CRON',
        cron: '15 9 * * *',
        timeZone: 'Asia/Shanghai',
      });
      const nativeUpstream = await create(triggerPath, {
        ...releaseRule,
        kind: 'UPSTREAM',
        upstreamFlowId: 'build',
        upstreamStatus: 'SUCCESS',
      });
      const firstApiEvent = await invoke(nativeApi.id, 'native-api-archive');
      assert.equal(
        (await invoke(nativeApi.id, 'native-api-archive')).body.data.id,
        firstApiEvent.body.data.id,
      );
      const body = JSON.stringify({
        repositoryId: repo.id,
        ref: 'refs/heads/release/fixture',
        commitSha: failingCommit,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const deliveryId = 'native-hook-archive';
      const signature =
        'sha256=' +
        createHmac('sha256', hookKey)
          .update(timestamp + '.' + deliveryId + '.' + body)
          .digest('hex');
      const sendHook = () =>
        request(app.getHttpServer())
          .post('/api/v1/graph-webhooks/' + nativeHook.id)
          .set('X-Veyops-Timestamp', timestamp)
          .set('X-Veyops-Delivery', deliveryId)
          .set('X-Veyops-Signature', signature)
          .type('json')
          .send(body)
          .expect(202);
      assert.equal((await sendHook()).body.data.id, (await sendHook()).body.data.id);
      assert.equal((await submit('build')).detail.status, 'SUCCESS');
      await triggers.tick(nativeCron.nextAt);
      await triggers.tick(nativeCron.nextAt);
      assert.equal(remoteCommands.length, previousRemoteCommands);

      for (const [rule, kind] of [
        [nativeApi, 'API'],
        [nativeHook, 'WEBHOOK'],
        [nativeCron, 'CRON'],
        [nativeUpstream, 'UPSTREAM'],
      ] as const) {
        const taskId = await releaseTaskFor(rule.id, kind);
        const activated = activations().length;
        await create('/deployments/approvals/' + taskId + '/approve', {});
        const release = await runTask(taskId);
        assert.equal(release.status, 'SUCCESS', release.errorSummary);
        assert.equal(activations().length, activated + 1);
        assert.equal(activations().at(-1)?.serverId, serverIds[0]);
      }

      const revokedRule = await create(triggerPath, { ...releaseRule, kind: 'API' });
      await invoke(revokedRule.id, 'native-api-revoked-rule');
      await triggers.tick();
      const revokedTaskId = await releaseTaskFor(revokedRule.id, 'API');
      await create('/deployments/approvals/' + revokedTaskId + '/approve', {});
      await api
        .patch('/api/v1' + triggerPath + '/' + revokedRule.id)
        .send({ ...releaseRule, kind: 'API', enabled: false })
        .expect(200);
      const afterRuleDisabled = remoteCommands.length;
      const revoked = await runTask(revokedTaskId);
      assert.equal(remoteCommands.length, afterRuleDisabled);
      assert.equal(revoked.status, 'FAILED', revoked.errorSummary);
      assert.match(revoked.errorSummary, /触发器已停用/);

      const ruleOwner = await create('/users', {
        username: 'graph-release-admin',
        role: 'ADMIN',
        password: initialPassword,
      });
      const ownerApi = request.agent(app.getHttpServer());
      await ownerApi
        .post('/api/v1/auth/login')
        .send({ username: ruleOwner.username, password: initialPassword })
        .expect(201);
      await ownerApi
        .post('/api/v1/auth/change-password')
        .send({ currentPassword: initialPassword, newPassword: password })
        .expect(200);
      await ownerApi
        .post('/api/v1/auth/login')
        .send({ username: ruleOwner.username, password })
        .expect(201);
      const ownerRule = (
        await ownerApi
          .post('/api/v1' + triggerPath)
          .send({ ...releaseRule, kind: 'API' })
          .expect(201)
      ).body.data;
      await invoke(ownerRule.id, 'native-api-revoked-owner');
      await triggers.tick();
      const ownerTaskId = await releaseTaskFor(ownerRule.id, 'API');
      await create('/deployments/approvals/' + ownerTaskId + '/approve', {});
      await api
        .patch('/api/v1/users/' + ruleOwner.id)
        .send({ role: 'VIEWER' })
        .expect(200);
      const afterRoleChanged = remoteCommands.length;
      const ownerRevoked = await runTask(ownerTaskId);
      assert.equal(remoteCommands.length, afterRoleChanged);
      assert.equal(ownerRevoked.status, 'FAILED', ownerRevoked.errorSummary);
      assert.match(ownerRevoked.errorSummary, /配置管理员已失效/);

      await api
        .put(graphConfigPath)
        .send({
          ...directConfig,
          releasePolicy: { requireCodeReview: true, requireApproval: false },
        })
        .expect(200);
      const direct = await create(triggerPath, { ...releaseRule, kind: 'API' });
      await invoke(direct.id, 'native-api-direct-release');
      await triggers.tick();
      const directTaskId = await releaseTaskFor(direct.id, 'API', null);
      const activated = activations().length;
      const directRelease = await runTask(directTaskId);
      assert.equal(directRelease.status, 'SUCCESS', directRelease.errorSummary);
      assert.equal(activations().length, activated + 1);
    } finally {
      if (previousAutomaticKinds === undefined) delete process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
      else process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS = previousAutomaticKinds;
      if (previousBuildSocket === undefined) delete process.env.WEBHOOK_BUILD_DOCKER_SOCKET;
      else process.env.WEBHOOK_BUILD_DOCKER_SOCKET = previousBuildSocket;
    }

    const graphFailure = await submit('build', {
      version: { kind: 'COMMIT', value: failingCommit },
    });
    assert.equal(graphFailure.detail.status, 'FAILED');
    assert.equal(graphFailure.detail.nodes.at(-1).status, 'SKIPPED');
    const buildTask = onlyBuild.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'build-node',
    );
    const { payload_json: payload } = await db
      .selectFrom('tasks')
      .select('payload_json')
      .where('id', '=', buildTask.taskId)
      .executeTakeFirstOrThrow();
    const snapshot = (JSON.parse(payload) as { pipeline: PipelineSnapshot }).pipeline;
    const imported = await app.get(ArtifactsService).create(
      {
        ...snapshot,
        definition: {
          ...snapshot.definition,
          artifacts: [
            {
              name: 'imported',
              type: 'DOCKER_IMAGE',
              imageReference: 'fixture/test@' + imageDigest,
            },
          ],
        },
      },
      {
        name: 'imported',
        kind: 'DOCKER_IMAGE',
        storageType: 'LOCAL_IMAGE',
        imageReference: 'fixture/test:local',
        imageId,
        storageKey: produced.storageKey,
      },
    );
    const [importedRecord] = await list('/artifacts', {
      projectId: project.id,
      recordId: imported.id,
    });
    assert.deepEqual(
      importedRecord.sources,
      [],
      'an imported image cannot inherit the build checkout provenance',
    );
    assert.ok(composeUploads.length > 0 && composeUploads.every((value) => value === compose));
    const managedPath = `/services/${service.id}/environments/${graphEnv.id}/compose-templates`;
    const managed = (content: string, expectedVersion = 0) => ({
      source: 'SERVICE_ENVIRONMENT',
      expectedVersion,
      content,
    });
    await post(managedPath, managed('services: { app: { image: mutable:latest } }')).expect(400);
    await post(managedPath, managed(managedV1 + '---\nservices: {}\n')).expect(400);
    const revision = await create(managedPath, managed(managedV1));
    assert.equal(revision.version, 1);
    assert.equal(revision.checksum, createHash('sha256').update(managedV1).digest('hex'));
    await post(managedPath, managed(managedV2)).expect(409);
    const managedHistory = await api.get('/api/v1' + managedPath).expect(200);
    assert.equal(managedHistory.body.data.versions[0].content, undefined);
    const savedTemplate = await api.get(`/api/v1${managedPath}/${revision.id}`).expect(200);
    assert.equal(savedTemplate.body.data.content, managedV1);
    assert.equal(savedTemplate.headers['cache-control'], 'no-store');

    // The image remains deployable without a Compose file when a template is managed by the service environment.
    await db
      .updateTable('artifacts')
      .set({ compose_yaml: null, compose_checksum: null })
      .where('id', '=', savedImage)
      .execute();
    const firstManaged = await submit('release', { image: [savedImage] });
    assert.equal(firstManaged.detail.status, 'SUCCESS', JSON.stringify(firstManaged.detail.nodes));
    assert.equal(composeUploads.at(-1), managedV1);
    const managedDeployTask = firstManaged.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'deploy-node',
    ).taskId;
    const [managedRecord] = await list('/deployments', { taskId: managedDeployTask });
    assert.deepEqual(managedRecord.composeRelease, {
      template: {
        id: revision.id,
        source: 'SERVICE_ENVIRONMENT',
        path: 'compose.yaml',
        version: 1,
        checksum: revision.checksum,
      },
      imageReference: produced.storageKey,
      imageId,
    });

    const oldPlan = await create(reviewPreview, historicalInput);
    const revision2 = await create(managedPath, managed(managedV2, 1));
    assert.equal(revision2.version, 2);
    await post(graphPath + '/flows/release/run', {
      ...historicalInput,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: oldPlan.configurationHash,
    }).expect(409);
    const secondManaged = await submit('release', { image: [savedImage] });
    assert.equal(
      secondManaged.detail.status,
      'SUCCESS',
      JSON.stringify(secondManaged.detail.nodes),
    );
    assert.equal(composeUploads.at(-1), managedV2);

    const archiveRevision = await create(managedPath, { source: 'ARCHIVE', expectedVersion: 2 });
    assert.equal(archiveRevision.version, 3);
    await post(reviewPreview, historicalInput).expect(409);
    const managedRollbackPath = `/deployments/${managedRecord.id}/rollback`;
    const managedRollbackPlan = await create(managedRollbackPath + '/preview', {});
    assert.deepEqual(managedRollbackPlan.composeTemplate, managedRecord.composeRelease.template);
    assert.deepEqual(managedRollbackPlan.previousCompose, managedRecord.composeRelease);
    const managedRollback = await create(managedRollbackPath, {
      confirmationHash: managedRollbackPlan.confirmationHash,
    });
    assert.equal((await runTask(managedRollback.id)).status, 'SUCCESS');
    assert.equal(composeUploads.at(-1), managedV1);
    const [managedRolledBack] = await list('/deployments', { taskId: managedRollback.id });
    assert.deepEqual(managedRolledBack.composeRelease, managedRecord.composeRelease);
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
    process.env.DATA_DIR = await deliveryDirectory();
    const { withIsolatedPostgres } = await import('./helpers/isolated-postgres.js');
    await withIsolatedPostgres(process.env.VEYOPS_TEST_POSTGRES_URL!, checkDelivery);
  },
);
