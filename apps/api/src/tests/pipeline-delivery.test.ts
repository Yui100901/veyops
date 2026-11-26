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
import type { ProcessOptions } from '../infrastructure/build-runner/process-runner.service';

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
  const buildHelperImage = 'fixture-shell:bookworm';
  process.env.DATA_DIR = directory;
  process.env.DATABASE_PATH = join(directory, 'test.db');
  process.env.DATABASE_CLIENT = databaseUrl ? 'postgres' : 'sqlite';
  if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WORKER_ENABLED = 'false';
  process.env.ADMIN_PASSWORD = initialPassword;
  process.env.AI_PIPELINE_ANALYSIS = 'false';
  process.env.BUILD_HELPER_IMAGE = buildHelperImage;

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
  const { expandGraphTemplate } =
    await import('../modules/execution-graphs/graph-flow-templates.js');
  const { RepositoryMetadataService } =
    await import('../modules/projects/repository-metadata.service.js');

  const archive = Buffer.from('fixture file artifact\n');
  const checksum = createHash('sha256').update(archive).digest('hex');
  const compose = 'services:\n  web:\n    image: ${VEYOPS_IMAGE}\n';
  const managedV1 = compose + '# Service environment revision 1\n';
  const managedV2 = compose + '# Service environment revision 2\n';
  const repositoryComposePath = 'deploy/compose.yaml';
  const repositoryCompose = compose + '# Pinned repository Compose file\n';
  const composeUploads: string[] = [];
  const imageDigest = `sha256:${'1'.repeat(64)}`;
  const imageId = `sha256:${'2'.repeat(64)}`;
  const successfulCommit = 'a'.repeat(40);
  const failingCommit = 'b'.repeat(40);
  const managerCheckouts: string[] = [];
  const remoteCommands: { serverId: string; command: string }[] = [];
  const releaseLinks = new Map<string, string>();
  const transferredArchives: string[] = [];
  const flowArchives: string[] = [];
  let captureFlowUpload = false;
  let failedBuildServer: string | undefined;
  let registryPullFails = false;
  let failNextHealthCheck = false;
  let failReleaseLockOnServer: string | undefined;
  let archivePlatformMismatch = false;
  let auxiliaryCommit = 'c'.repeat(40);
  const processRunner = new ProcessRunnerService();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, LegacyDeliveryFixtureModule],
  })
    .overrideProvider(ProcessRunnerService)
    .useValue({
      run: async (command: string, args: string[], options: ProcessOptions) => {
        if (command === 'tar') return processRunner.run(command, args, options);
        const script = args.at(-1) ?? '';
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
            if (script.includes('missing-shell-output'))
              return { exitCode: 44, stdout: '', stderr: '' };
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
        if (args.includes('info') && args.includes('{{.ID}}'))
          return { exitCode: 0, stdout: 'fixture-manager-engine', stderr: '' };
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
        options?: { onData?: (chunk: string, stream?: 'stdout' | 'stderr') => void },
      ) => {
        remoteCommands.push({ serverId: target.id, command });
        if (
          target.id === failReleaseLockOnServer &&
          command.includes('mkdir -m 700 -- /var/tmp/.veyops-deployment-locks')
        )
          return { exitCode: 76 };
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
        if (command.includes('measured=$(artifact_digest') && command.includes('workspace=')) {
          const instance = /instance=[^a-f0-9]*([a-f0-9-]{36})/.exec(command)?.[1];
          assert.ok(instance);
          options?.onData?.(
            `/home/fixture/.veyops/artifacts/${instance}/payload\n${checksum}:${archive.length}\n`,
            'stdout',
          );
        }
        if (command.includes(' push ')) {
          const tag = /:([^:']+)'$/.exec(command)?.[1];
          options?.onData?.(`${tag}: digest: ${imageDigest} size: 321\n`);
        }
        if (command.includes('config --images'))
          options?.onData?.(`${/^VEYOPS_IMAGE='([^']+)'/.exec(command)?.[1]}\n`);
        if (command.includes('{{.ID}}'))
          options?.onData?.(`fixture-engine-${target.id}\n`, 'stdout');
        if (
          command.includes('image inspect --format') ||
          (command.includes('image') && command.includes('inspect') && command.includes('{{.Id}}'))
        ) {
          const platform = command.includes('{{.Architecture}}') ? ' linux/amd64' : '';
          options?.onData?.(`${imageId}${platform}\n`, 'stdout');
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
        if (captureFlowUpload) {
          const result = await processRunner.run('tar', ['-xOzf', source, './index.html'], {
            timeout: 10,
          });
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(result.stdout, 'verified release');
          flowArchives.push(target.id);
        } else {
          assert.deepEqual(await readFile(source), archive);
          transferredArchives.push(target.id);
        }
      },
      uploadContent: async (_target: unknown, contents: string, destination: string) => {
        if (destination.endsWith('/compose.yaml')) composeUploads.push(contents);
      },
      download: async (_target: unknown, source: string, destination: string) => {
        await writeFile(
          destination,
          /\/compose-[0-9a-f-]+\.snapshot\.yaml$/.test(source) ? compose : archive,
        );
      },
    })
    .overrideProvider(RepositoryMetadataService)
    .useValue({
      inspectGraphEnvironmentFile: async () => undefined,
      readGraphComposeFile: async (
        _projectId: string,
        _repositoryId: string,
        commitSha: string,
        path: string,
      ) => {
        assert.equal(commitSha, successfulCommit);
        assert.equal(path, repositoryComposePath);
        return repositoryCompose;
      },
      planGraphCheckout: async (
        _projectId: string,
        source: { repositoryId: string; commitSha?: string; branch?: string },
      ) => ({
        ...source,
        commitSha: source.commitSha ?? successfulCommit,
        access: { clone_url: 'https://repo.example.test/team/app.git', credential_id: null },
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
    const graphEnv = await create('/projects/' + project.id + '/environments', {
      name: 'Graph release',
      slug: 'graph-release',
      environmentType: 'TESTING',
    });
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

    const revision2 = await create(managedPath, managed(managedV2, 1));
    assert.equal(revision2.version, 2);

    const defaults = expandGraphTemplate('MINIMAL_CI_CD', 'DIRECTORY', 'FLOW_V2');
    const [start, checkoutNode, buildNode, deployNode, end] = defaults.canvas.nodes;
    const buildFlow = {
      ...start!,
      start: {
        sources: [
          {
            id: 'app',
            repositoryId: repo.id,
            ref: { kind: 'COMMIT' as const, value: successfulCommit },
            allowRefOverride: true,
          },
        ],
        execution: { location: 'MANAGER' as const },
        release: {
          serviceId: service.id,
          targets: { serverIds: [serverIds[0]!] },
          contentPath: 'app/dist',
        },
      },
    };
    const approve = {
      id: 'confirm',
      type: 'APPROVAL' as const,
      name: 'Approve the frozen payload',
    };
    const buildAction = {
      ...buildNode!,
      build: { buildCommand: 'BUILD_FLOW_FIXTURE', repoPath: 'app' },
    };
    const flowNodes = [buildFlow, checkoutNode!, buildAction, approve, deployNode!, end!];
    const current = (await api.get('/api/v1' + graphPath).expect(200)).body.data;
    const edited = (
      await api
        .put('/api/v1' + graphPath + '/draft')
        .send({
          expectedRevision: current.revision,
          definition: {
            canvas: {
              ...defaults.canvas,
              nodes: flowNodes,
              endpoints: [defaults.canvas.endpoints[0]!],
              edges: flowNodes
                .slice(1)
                .map(({ id: to }, index) => ({ from: flowNodes[index]!.id, to })),
            },
          },
        })
        .expect(200)
    ).body.data;
    const { publishedVersion: graphVersion } = await create(graphPath + '/publish', {
      expectedRevision: edited.revision,
    });
    const fixtureBuilds = app.get(BuildsService);
    fixtureBuilds.managerFlowCommand = async (_options, workspace, command, subdirectory) => {
      assert.equal(command, 'BUILD_FLOW_FIXTURE');
      assert.equal(subdirectory, 'app');
      assert.equal(
        await readFile(join(workspace, subdirectory, 'origin.txt'), 'utf8'),
        successfulCommit,
      );
      await mkdir(join(workspace, subdirectory, 'dist'));
      await writeFile(join(workspace, subdirectory, 'dist', 'index.html'), 'verified release');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const flow = graphPath + '/flows/' + defaults.startId;
    const submit = async (inputs: object = {}) => {
      const args = { version: graphVersion, inputs };
      const plan = await create(flow + '/preview', args);
      return create(flow + '/run', {
        ...args,
        expectedConfigurationHash: plan.configurationHash,
        idempotencyKey: randomUUID(),
      });
    };
    const wait = async (id: string, states: string[], approvalNodeId?: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        await worker.tick();
        const current = (await api.get('/api/v1' + graphPath + '/runs/' + id).expect(200)).body
          .data;
        const approvalReady =
          !approvalNodeId ||
          current.status !== 'WAITING' ||
          current.nodes.some(
            (node: { nodeId: string; output?: { scopeHash?: string } }) =>
              node.nodeId === approvalNodeId && node.output?.scopeHash,
          );
        if (states.includes(current.status) && approvalReady) return current;
        await delay(15);
      }
      assert.fail('Graph run did not reach ' + states.join('/'));
    };
    const initialActivations = activations().length;
    captureFlowUpload = true;
    const flowRun = await submit();
    const pending = await wait(flowRun.id, ['WAITING', 'FAILED'], approve.id);
    if (pending.status !== 'WAITING') {
      const node = pending.nodes.find(({ nodeId }: { nodeId: string }) => nodeId === approve.id);
      const failedTask = node?.taskId && (await getTask(node.taskId));
      assert.fail(JSON.stringify({ nodes: pending.nodes, task: failedTask?.errorSummary }));
    }
    assert.equal(activations().length, initialActivations);
    assert.equal(flowArchives.length, 0);
    const gate = pending.nodes.find(({ nodeId }: { nodeId: string }) => nodeId === approve.id);
    const decision = graphPath + '/runs/' + pending.id + '/nodes/' + approve.id + '/decision';
    assert.ok(gate.output.scopeHash);
    assert.equal(gate.output.scope.artifactIds.length, 1);
    await post(decision, { decision: 'APPROVE', expectedScopeHash: '0'.repeat(64) }).expect(409);
    assert.equal(activations().length, initialActivations);
    await create(decision, {
      decision: 'APPROVE',
      expectedScopeHash: gate.output.scopeHash,
    });
    const completed = await wait(flowRun.id, ['SUCCESS', 'FAILED']);
    assert.equal(completed.status, 'SUCCESS', JSON.stringify(completed.nodes));
    assert.deepEqual(flowArchives, [serverIds[0]]);
    assert.equal(activations().length, initialActivations + 1);
    assert.deepEqual(completed.artifactIds, gate.output.scope.artifactIds);
    const failedRun = await submit({
      parameters: { 'git:app': { kind: 'COMMIT', value: failingCommit } },
    });
    const failedCheckout = await wait(failedRun.id, ['SUCCESS', 'FAILED']);
    assert.equal(failedCheckout.status, 'FAILED');
    assert.equal(activations().length, initialActivations + 1);
    assert.deepEqual(failedCheckout.artifactIds, []);
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
