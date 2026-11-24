import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  const { ArtifactsService } = await import('../modules/artifacts/artifacts.service.js');
  const { GraphTriggersService } =
    await import('../modules/execution-graphs/graph-triggers.service.js');
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
  let repositoryComposeRead = repositoryCompose;
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
  let strictGraphProbeExitCode = 0;
  let archivePlatformMismatch = false;
  let auxiliaryCommit = 'c'.repeat(40);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, LegacyDeliveryFixtureModule],
  })
    .overrideProvider(ProcessRunnerService)
    .useValue({
      run: async (_command: string, args: string[], options: { gzipOutput?: { path: string } }) => {
        const script = args.at(-1) ?? '';
        if (script.includes('GRAPH_TEMPLATE_CI_FAIL'))
          return {
            exitCode: 23,
            stdout: 'fixture check failed\n',
            stderr: '',
          };
        assert.ok(!script.includes('GRAPH_TEMPLATE_BUILD_BLOCKED'));
        if (script.includes('GRAPH_SHELL_FIXTURE')) {
          const secretsMount = args.find((arg) => arg.endsWith(',dst=/run/veyops,readonly'));
          assert.ok(secretsMount);
          const secrets = secretsMount.slice(
            'type=bind,src='.length,
            -',dst=/run/veyops,readonly'.length,
          );
          assert.equal(dirname(secrets), join(directory, 'builds'));
          assert.equal(args.at(-5), buildHelperImage);
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
          await writeFile(join(workspace, 'repo', 'app.jar'), archive);
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
        if (command.includes('VEYOPS_WORKSPACE=')) {
          const leaf = /mkdir -- '(veyops-[\w-]+)'/.exec(command)?.[1];
          assert.ok(leaf);
          options?.onData?.(`VEYOPS_WORKSPACE=/home/fixture/.veyops/workspace/${leaf}\n`);
        }
        if (failNextHealthCheck && command.includes('AUTO_HEALTH_CHECK')) {
          failNextHealthCheck = false;
          return { exitCode: 1 };
        }
        if (command.includes('GRAPH_TEMPLATE_HEALTH_CHECK'))
          return { exitCode: strictGraphProbeExitCode };
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
        assert.deepEqual(await readFile(source), archive);
        transferredArchives.push(target.id);
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
        return repositoryComposeRead;
      },
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
    const scoped = [{ id: 'service', name: '服务', type: 'SERVICE', defaultValue: service.id }];
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
    };
    const from = (nodeId: string, fieldId: string) => ({ kind: 'OUTPUT', nodeId, fieldId });
    const input = (fieldId: string) => ({ kind: 'INPUT', fieldId });
    const outputs = [
      {
        id: 'jar',
        name: 'JAR 产物',
        type: 'ARTIFACT',
        artifactType: 'FILE',
        source: 'CURRENT_RUN',
      },
      {
        id: 'image',
        name: 'Docker 镜像',
        type: 'ARTIFACT',
        artifactType: 'DOCKER_IMAGE',
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
          artifacts: [
            { id: 'static', name: '站点目录', type: 'DIRECTORY', pathInput: 'OUT_DIR' },
            {
              id: 'html',
              name: '临时首页',
              type: 'FILE',
              path: 'custom-dist/index.html',
              persist: false,
            },
            { name: 'optional', type: 'FILE', path: 'missing-shell-output', required: false },
          ],
        },
        outputs: [{ id: 'result', name: '结果', type: 'TEXT' }],
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
        id: 'guarded',
        type: 'START',
        name: '审核后发布历史镜像',
        inputs: [...scoped, targets, historical],
      },
      { id: 'review-image', type: 'SOURCE_REVIEW', name: '审核实际镜像来源' },
      {
        id: 'approve-image',
        type: 'APPROVAL',
        name: '批准具体发布范围',
        approval: { releaseNodeId: 'deploy-node' },
      },
      {
        id: 'latest',
        type: 'START',
        name: '发布最新镜像',
        inputs: [...scoped, targets, { ...historical, selection: 'LATEST_COMPATIBLE' }],
      },
      {
        id: 'repository-template',
        type: 'START',
        name: '使用仓库 Compose 模板发布',
        inputs: [...scoped, targets, historical],
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
      { id: 'auto-target-start', type: 'START', name: '目标端定时构建', inputs: [targets] },
      {
        id: 'auto-target-check',
        type: 'CHECK',
        name: '目标端检查',
        shell: { location: 'TARGET', command: 'echo GRAPH_AUTOMATIC_TARGET_CHECK' },
      },
      {
        id: 'auto-target-build',
        type: 'BUILD',
        name: '目标端构建文件',
        build: {
          repositoryId: repo.id,
          branch: 'main',
          buildLocation: 'TARGET',
          buildCommand: 'echo GRAPH_AUTOMATIC_TARGET_BUILD',
          artifacts: [{ name: 'jar', type: 'FILE', path: 'app.jar' }],
        },
      },
      { id: 'auto-target-end', type: 'END', name: '目标端构建结束' },
      {
        id: 'deploy-node',
        type: 'DEPLOY_ARTIFACT',
        name: '部署共享节点',
        deploy: {
          method: 'COMPOSE',
          deployPath: '/opt/graph-native',
          healthCheckCommand: 'test -f compose.yaml',
        },
      },
      {
        id: 'deploy-repository',
        type: 'DEPLOY_ARTIFACT',
        name: '使用固定版本 Compose 模板部署',
        deploy: {
          method: 'COMPOSE',
          deployPath: '/opt/graph-repository-template',
          healthCheckCommand: 'test -f compose.yaml',
          composeSource: {
            kind: 'REPOSITORY_FILE',
            repositoryId: sharedRepo.id,
            commitSha: successfulCommit,
            path: repositoryComposePath,
          },
        },
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
      ['script', 'custom-end'],
      ['build', 'git-actual'],
      ['composed', 'git-actual'],
      ['git-actual', 'git-schema'],
      ['git-schema', 'git-unused'],
      ['git-unused', 'build-node'],
      ['auto-target-start', 'auto-target-check'],
      ['auto-target-check', 'auto-target-build'],
      ['auto-target-build', 'auto-target-end'],
      ['build-node', 'build-end'],
      ['build-node', 'deploy-node'],
      ['release', 'deploy-node'],
      ['guarded', 'review-image'],
      ['review-image', 'approve-image'],
      ['approve-image', 'deploy-node'],
      ['latest', 'deploy-node'],
      ['deploy-node', 'release-end'],
      ['repository-template', 'deploy-repository'],
      ['deploy-repository', 'release-end'],
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
        ...(startId === 'guarded' && { 'review-image': { artifact } }),
        'deploy-node': {
          artifact,
          ...(startId === 'guarded' && { review: from('review-image', 'review') }),
        },
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
            },
            outputBindings: { directory: from('script', 'static') },
          },
          {
            startId: 'build',
            endId: 'build-end',
            inputBindings: buildBindings,
            outputBindings: { jar: from('build-node', 'jar'), image: from('build-node', 'image') },
          },
          {
            startId: 'auto-target-start',
            endId: 'auto-target-end',
            serviceId: service.id,
            inputBindings: {
              'auto-target-check': { targets: input('targets') },
              'auto-target-build': { targets: input('targets') },
            },
          },
          releaseEndpoint('composed', from('build-node', 'image')),
          releaseEndpoint('release', input('image')),
          releaseEndpoint('guarded', input('image')),
          releaseEndpoint('latest', input('image')),
          {
            startId: 'repository-template',
            endId: 'release-end',
            serviceId: service.id,
            inputBindings: { 'deploy-repository': { artifact: input('image') } },
            outputBindings: { release: from('deploy-repository', 'release') },
          },
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
    const scriptTaskId = custom.detail.nodes.find(
      ({ nodeId }: { nodeId: string }) => nodeId === 'script',
    ).taskId;
    const scriptLog =
      scriptTaskId &&
      (await api.get('/api/v1/tasks/' + scriptTaskId + '/logs').expect(200)).body.data.content;
    assert.equal(custom.detail.status, 'SUCCESS', scriptLog ?? JSON.stringify(custom.detail.nodes));
    assert.equal(custom.detail.outputs.directory.type, 'DIRECTORY');
    assert.equal(custom.detail.outputs.directory.instances.length, 1);
    const scriptResult = custom.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'script',
    );
    assert.equal(
      scriptResult.inputs.find(({ fieldId }: { fieldId: string }) => fieldId === 'OUT_DIR').value,
      'custom-dist',
    );
    assert.equal(scriptResult.output.result, 'generated');
    assert.equal(scriptResult.output.static.name, '站点目录');
    assert.equal(scriptResult.output.html.scope, 'TEMPORARY');
    assert.equal(scriptResult.output.html.rootRunId, custom.detail.id);
    assert.equal(scriptResult.output.optional, undefined);
    assert.equal(scriptResult.output.artifacts.length, 2);
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
      buildEnd.output.jar.instances.map(({ instanceId }: { instanceId: string }) => instanceId),
      [artifactRows[1]!.id],
    );
    assert.deepEqual(
      buildEnd.output.image.instances.map(({ instanceId }: { instanceId: string }) => instanceId),
      [savedImage],
    );
    assert.equal(buildEnd.output.jar.artifactId, artifactRows[1]!.logical_artifact_id);
    assert.equal(buildEnd.output.image.artifactId, artifactRows[0]!.logical_artifact_id);
    const historicalRelease = await submit('release', { image: savedImage });
    assert.equal(
      historicalRelease.detail.status,
      'SUCCESS',
      JSON.stringify(historicalRelease.detail.nodes),
    );
    assert.equal(produced.physical.engineId, 'fixture-manager-engine');
    assert.ok(
      remoteCommands
        .slice(beforePublish)
        .some(
          ({ serverId, command }) =>
            serverId === serverIds[0] && command.includes('image load --input'),
        ),
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
    assert.deepEqual(released.composeRelease.template, produced.composeTemplate);
    assert.equal(
      released.composeRelease.imageReference,
      (await list('/artifacts', { recordId: released.artifactId }))[0].storageKey,
    );
    assert.equal(released.composeRelease.imageId, imageId);
    assert.equal(released.composeRelease.dockerEngineId, 'fixture-engine-' + serverIds[0]);
    const implicitLatest = await submit('latest');
    assert.equal(
      implicitLatest.detail.status,
      'SUCCESS',
      JSON.stringify(implicitLatest.detail.nodes),
    );
    assert.deepEqual(implicitLatest.reviewed.deliveries[0].artifactIds, [
      releaseNode.output.release.deployments[0].artifactId,
    ]);
    const historicalInput = args({ image: savedImage });
    const reviewPreview = graphPath + '/flows/release/preview';
    const guardedPlan = await create(graphPath + '/flows/guarded/preview', historicalInput);
    assert.equal(
      guardedPlan.gates.find(({ nodeId }: { nodeId: string }) => nodeId === 'approve-image')
        ?.releaseNodeId,
      'deploy-node',
    );
    assert.ok(
      guardedPlan.gates.some(
        ({ nodeId, kind }: { nodeId: string; kind: string }) =>
          nodeId === 'review-image' && kind === 'SOURCE_REVIEW',
      ),
    );

    const previousAutomaticKinds = process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS;
    const previousBuildSocket = process.env.WEBHOOK_BUILD_DOCKER_SOCKET;
    process.env.VEYOPS_AUTO_DELIVERY_TRIGGERS = 'API,WEBHOOK,CRON,UPSTREAM';
    process.env.WEBHOOK_BUILD_DOCKER_SOCKET = '/run/user/1000/fixture-docker.sock';
    const managerSocket = mock.method(
      BuildsService,
      'automaticManagerSocket',
      async () => '/run/user/1000/fixture-docker.sock',
    );
    const grant = async (enabled: boolean) =>
      (
        await api
          .patch('/api/v1/servers/' + serverIds[0] + '/automatic-execution')
          .send({ enabled })
          .expect(200)
      ).body.data;
    try {
      assert.equal((await grant(true)).automaticExecutionEnabled, true);
      const triggerPath = graphPath + '/triggers';
      const triggers = app.get(GraphTriggersService);
      const targetCron = await create(triggerPath, {
        name: '目标端定时构建',
        kind: 'CRON',
        flowId: 'auto-target-start',
        version: published.publishedVersion,
        enabled: true,
        cron: '0 2 * * *',
        timeZone: 'Asia/Shanghai',
      });
      const beforeTarget = remoteCommands.length;
      await triggers.tick(targetCron.nextAt);
      const scheduled = await list(triggerPath + '/' + targetCron.id + '/events', {});
      assert.equal(scheduled.length, 1);
      const builtByCron = await waitGraph(scheduled[0].runId);
      assert.equal(builtByCron.status, 'SUCCESS', JSON.stringify(builtByCron.nodes));
      const automaticCommands = remoteCommands.slice(beforeTarget);
      for (const marker of ['GRAPH_AUTOMATIC_TARGET_CHECK', 'GRAPH_AUTOMATIC_TARGET_BUILD']) {
        const commands = automaticCommands.filter(({ command }) => command.includes(marker));
        assert.equal(commands.length, 1);
        assert.equal(commands[0].serverId, serverIds[0]);
        assert.match(commands[0].command, /\/\.veyops\/workspace\/veyops-/);
      }
      await api
        .patch('/api/v1' + triggerPath + '/' + targetCron.id)
        .send({
          name: '目标端定时构建',
          kind: 'CRON',
          flowId: 'auto-target-start',
          version: published.publishedVersion,
          enabled: false,
          cron: '0 2 * * *',
          timeZone: 'Asia/Shanghai',
        })
        .expect(200);
      const releaseRule = {
        name: 'Automatic archive release',
        enabled: true,
        version: published.publishedVersion,
        flowId: 'guarded',
        parameterMappings: { image: { source: 'VALUE', value: savedImage } },
      };
      const events = (ruleId: string) => list(triggerPath + '/' + ruleId + '/events', {});
      const invoke = (ruleId: string, eventId: string) =>
        post(triggerPath + '/' + ruleId + '/invoke', {
          eventId,
          repositoryId: repo.id,
          commitSha: failingCommit,
        }).expect(202);
      const releaseTaskFor = async (ruleId: string, kind: string, guarded = true) => {
        const rows = await events(ruleId);
        assert.equal(rows.length, 1, JSON.stringify(rows));
        const [event] = rows;
        assert.equal(event.status, 'QUEUED', JSON.stringify(event));
        const runPath = graphPath + '/runs/' + event.runId;
        const graphRun = async () => (await api.get('/api/v1' + runPath).expect(200)).body.data;
        let run = await graphRun();
        assert.equal(run.triggerType, kind);
        if (kind === 'API' || kind === 'WEBHOOK')
          assert.equal(run.trigger.commitSha, failingCommit);
        const releaseNode = () =>
          run.nodes.find((item: { nodeId: string }) => item.nodeId === 'deploy-node');
        const decide = async (nodeId: string, scopeHash: string) => {
          const receipt = await create(runPath + '/nodes/' + nodeId + '/decision', {
            decision: 'APPROVE',
            expectedScopeHash: scopeHash,
          });
          assert.equal(
            receipt.nodes.find((item: { nodeId: string }) => item.nodeId === nodeId).output
              .decision,
            'APPROVE',
          );
          run = await graphRun();
        };
        if (guarded) {
          const gate = (nodeId: string) => {
            const node = run.nodes.find((item: { nodeId: string }) => item.nodeId === nodeId);
            assert.equal(node.status, 'WAITING', JSON.stringify(node));
            assert.equal(releaseNode().taskId, null, 'publication never queues before its gates');
            assert.match(node.output.scopeHash, /^[a-f0-9]{64}$/);
            return node.output;
          };
          const review = gate('review-image');
          assert.equal(review.scope.kind, 'SOURCE_REVIEW');
          assert.deepEqual(review.scope.artifactIds, [savedImage]);
          assert.deepEqual(
            review.scope.sources
              .map(
                ({ repositoryId, commitSha }: { repositoryId: string; commitSha: string }) =>
                  `${repositoryId}:${commitSha}`,
              )
              .sort(),
            [
              `${sharedRepo.id}:${successfulCommit}`,
              `${dependencyRepo.id}:${auxiliaryCommit}`,
            ].sort(),
          );
          await post(runPath + '/nodes/review-image/decision', {
            decision: 'APPROVE',
            expectedScopeHash: '0'.repeat(64),
          }).expect(409);
          await decide('review-image', review.scopeHash);
          const approval = gate('approve-image');
          assert.equal(approval.scope.kind, 'RELEASE');
          assert.equal(approval.scope.releaseNodeId, 'deploy-node');
          assert.equal(approval.scope.serviceId, service.id);
          assert.deepEqual(approval.scope.serverIds, [serverIds[0]]);
          assert.deepEqual(approval.scope.artifactIds, [savedImage]);
          await decide('approve-image', approval.scopeHash);
        }
        const node = releaseNode();
        assert.ok(node.taskId, JSON.stringify(node));
        const task = await getTask(node.taskId);
        assert.equal(task.triggerType, kind);
        assert.equal(task.approvalStatus, null);
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
        assert.equal(
          payload.pipeline.graphGate?.review?.nodeId,
          guarded ? 'review-image' : undefined,
        );
        assert.equal(
          payload.pipeline.graphGate?.approval?.nodeId,
          guarded ? 'approve-image' : undefined,
        );
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
        const release = await runTask(taskId);
        assert.equal(release.status, 'SUCCESS', release.errorSummary);
        assert.equal(activations().length, activated + 1);
        assert.equal(activations().at(-1)?.serverId, serverIds[0]);
      }

      const revokedRule = await create(triggerPath, { ...releaseRule, kind: 'API' });
      await invoke(revokedRule.id, 'native-api-revoked-rule');
      await triggers.tick();
      const revokedTaskId = await releaseTaskFor(revokedRule.id, 'API');
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
      await api
        .patch('/api/v1/users/' + ruleOwner.id)
        .send({ role: 'VIEWER' })
        .expect(200);
      const afterRoleChanged = remoteCommands.length;
      const ownerRevoked = await runTask(ownerTaskId);
      assert.equal(remoteCommands.length, afterRoleChanged);
      assert.equal(ownerRevoked.status, 'FAILED', ownerRevoked.errorSummary);
      assert.match(ownerRevoked.errorSummary, /配置管理员已失效/);

      const direct = await create(triggerPath, { ...releaseRule, kind: 'API', flowId: 'release' });
      await invoke(direct.id, 'native-api-direct-release');
      await triggers.tick();
      const directTaskId = await releaseTaskFor(direct.id, 'API', false);
      const activated = activations().length;
      const directRelease = await runTask(directTaskId);
      assert.equal(directRelease.status, 'SUCCESS', directRelease.errorSummary);
      assert.equal(activations().length, activated + 1);

      const targetEventId = (await invoke(direct.id, 'native-api-revoked-target')).body.data.id;
      await triggers.tick();
      const targetEvent = (await events(direct.id)).find(
        (item: { id: string }) => item.id === targetEventId,
      );
      const targetRun = (
        await api.get('/api/v1' + graphPath + '/runs/' + targetEvent.runId).expect(200)
      ).body.data;
      const affectedTask = targetRun.nodes.find(
        ({ nodeId }: { nodeId: string }) => nodeId === 'deploy-node',
      ).taskId;
      assert.ok(affectedTask);
      assert.notEqual(affectedTask, directTaskId);
      const commandsBeforeRevoke = remoteCommands.length;
      assert.equal((await grant(false)).automaticExecutionEnabled, false);
      const targetRevoked = await runTask(affectedTask);
      assert.equal(targetRevoked.status, 'FAILED', targetRevoked.errorSummary);
      assert.equal(remoteCommands.length, commandsBeforeRevoke);
      assert.match(targetRevoked.errorSummary, /缺少有效的自动执行授权/);
    } finally {
      managerSocket.mock.restore();
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
    const importedSnapshot: PipelineSnapshot = {
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
    };
    const imageArtifact = {
      name: 'imported',
      kind: 'DOCKER_IMAGE',
      storageType: 'LOCAL_IMAGE',
      imageReference: 'fixture/test:local',
      imageId,
      storageKey: produced.storageKey,
      composeYaml: compose,
    } as const;
    const artifactsService = app.get(ArtifactsService);
    const imported = await artifactsService.create(importedSnapshot, imageArtifact);
    assert.equal((await artifactsService.create(importedSnapshot, imageArtifact)).id, imported.id);
    for (const composeYaml of [undefined, compose + '# changed']) {
      await assert.rejects(
        artifactsService.create(importedSnapshot, { ...imageArtifact, composeYaml }),
        /Compose 归档与本次恢复不一致/,
      );
    }
    const [importedRecord] = await list('/artifacts', {
      projectId: project.id,
      recordId: imported.id,
    });
    assert.deepEqual(
      importedRecord.sources,
      [],
      'an imported image cannot inherit the build checkout provenance',
    );
    const externalServerId = serverIds[0]!;
    const externalServer = await db
      .selectFrom('servers')
      .select('host_key_fingerprint')
      .where('id', '=', externalServerId)
      .executeTakeFirstOrThrow();
    const externalReference = 'fixture/script-image:1';
    const external = await artifactsService.create(importedSnapshot, {
      ...imageArtifact,
      name: 'external-script-image',
      storageType: 'REMOTE_IMAGE',
      storageKey: externalReference,
      imageReference: externalReference,
      serverId: externalServerId,
      physical: {
        kind: 'DOCKER_IMAGE',
        location: 'DOCKER_ENGINE',
        owner: 'EXTERNAL',
        serverId: externalServerId,
        engineId: `fixture-engine-${externalServerId}`,
        hostKeyFingerprint: externalServer.host_key_fingerprint ?? undefined,
        platform: 'linux/amd64',
        imageId,
        imageReference: externalReference,
      },
    });
    const eligibleExternal = () =>
      artifactsService.deployableIn(db, snapshot.runId, true, false, undefined, [external.id]);
    assert.deepEqual(
      (await eligibleExternal()).map(({ id }) => id),
      [external.id],
    );
    await db
      .updateTable('artifacts')
      .set({ storage_key: externalReference + '-unconfirmed' })
      .where('id', '=', external.id)
      .execute();
    assert.deepEqual(await eligibleExternal(), []);
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

    const revision2 = await create(managedPath, managed(managedV2, 1));
    assert.equal(revision2.version, 2);

    // Graph deployments require their declared Compose source even if a legacy template is active.
    await db
      .updateTable('artifacts')
      .set({ compose_yaml: null, compose_checksum: null })
      .where('id', '=', savedImage)
      .execute();
    await post(reviewPreview, historicalInput).expect(409);
    const firstRepository = await submit('repository-template', { image: savedImage });
    assert.equal(
      firstRepository.detail.status,
      'SUCCESS',
      JSON.stringify(firstRepository.detail.nodes),
    );
    assert.equal(composeUploads.at(-1), repositoryCompose);
    const repositoryDeployTask = firstRepository.detail.nodes.find(
      (node: { nodeId: string }) => node.nodeId === 'deploy-repository',
    ).taskId;
    const [repositoryRecord] = await list('/deployments', { taskId: repositoryDeployTask });
    const repositoryTemplate = {
      source: 'REPOSITORY_FILE',
      path: repositoryComposePath,
      repositoryId: sharedRepo.id,
      commitSha: successfulCommit,
      checksum: createHash('sha256').update(repositoryCompose).digest('hex'),
    };
    assert.deepEqual(firstRepository.reviewed.deliveries[0].composeTemplate, repositoryTemplate);
    const { composeProject, ...composeEvidence } = repositoryRecord.composeRelease;
    assert.match(composeProject, /^veyops-[a-f0-9]{24}$/);
    assert.deepEqual(composeEvidence, {
      template: repositoryTemplate,
      imageReference: produced.storageKey,
      imageId,
      dockerEngineId: 'fixture-engine-' + serverIds[0],
    });

    const repositoryFlow = graphPath + '/flows/repository-template';
    const oldPlan = await create(repositoryFlow + '/preview', historicalInput);
    const confirmRepository = {
      ...historicalInput,
      expectedConfigurationHash: oldPlan.configurationHash,
    };
    const changedRepository = repositoryCompose + '# Unexpected bytes for the same Git object\n';
    repositoryComposeRead = changedRepository;
    await post(repositoryFlow + '/run', {
      ...confirmRepository,
      idempotencyKey: randomUUID(),
    }).expect(409);
    repositoryComposeRead = repositoryCompose;
    const queuedRepository = await create(repositoryFlow + '/run', {
      ...confirmRepository,
      idempotencyKey: randomUUID(),
    });
    const activationCount = activations().length;
    repositoryComposeRead = changedRepository;
    const changedRun = await waitGraph(queuedRepository.id);
    assert.equal(changedRun.status, 'FAILED', JSON.stringify(changedRun.nodes));
    assert.equal(activations().length, activationCount);
    assert.equal(composeUploads.at(-1), repositoryCompose);
    repositoryComposeRead = repositoryCompose;

    const expanded = expandGraphTemplate('CD_DEPLOY', 'DOCKER_IMAGE');
    const templateRelease = expanded.canvas.nodes.find(
      ({ operation }) => operation === 'DEPLOY_ARTIFACT',
    )!;
    const templateApproval = expanded.canvas.nodes.find(
      ({ operation }) => operation === 'APPROVAL',
    )!;
    templateApproval.approval!.timeoutSeconds = 60;
    const templateProbe = expanded.canvas.nodes.find(
      ({ operation }) => operation === 'HEALTH_CHECK',
    )!;
    templateRelease.deploy = {
      method: 'COMPOSE',
      deployPath: '/srv/veyops-graph-template',
      composeSource: {
        kind: 'REPOSITORY_FILE',
        repositoryId: sharedRepo.id,
        commitSha: successfulCommit,
        path: repositoryComposePath,
      },
    };
    templateProbe.healthCheck!.command = 'echo GRAPH_TEMPLATE_HEALTH_CHECK';
    const cdDraft = (
      await api
        .put('/api/v1' + graphPath + '/draft')
        .send({
          expectedRevision: edited.revision,
          definition: { canvas: expanded.canvas },
        })
        .expect(200)
    ).body.data;
    const publishReplacement = () =>
      api.post('/api/v1' + graphPath + '/publish').send({ expectedRevision: cdDraft.revision });
    const blockedReplacement = await publishReplacement().expect(400);
    assert.ok(
      ['build', 'guarded', 'release'].includes(blockedReplacement.body.error.planIssue.nodeId),
    );
    for (const rule of await list(graphPath + '/triggers', {})) {
      if (!rule.enabled) continue;
      const {
        name,
        kind,
        flowId,
        version,
        cron,
        timeZone,
        credentialId,
        upstreamFlowId,
        upstreamStatus,
        parameterMappings,
        repositoryId,
        refPrefix,
      } = rule;
      await api
        .patch('/api/v1' + graphPath + '/triggers/' + rule.id)
        .send({
          enabled: false,
          name,
          kind,
          flowId,
          version,
          cron,
          timeZone,
          credentialId,
          upstreamFlowId,
          upstreamStatus,
          parameterMappings,
          repositoryId,
          refPrefix,
        })
        .expect(200);
    }
    const cdVersion = (await create(graphPath + '/publish', { expectedRevision: cdDraft.revision }))
      .publishedVersion;
    const cdFlow = `${graphPath}/flows/${expanded.startId}`;
    const cdRequest = {
      version: cdVersion,
      inputs: {
        parameters: {
          artifact: { artifactId: savedImage },
          service: { serviceId: service.id },
          releaseTargets: { serverIds: [serverIds[0]!] },
        },
      },
    };
    const queueCd = async (
      request:
        | typeof cdRequest
        | {
            version: number;
            inputs: { parameters: Omit<typeof cdRequest.inputs.parameters, 'service'> };
          },
    ) => {
      const plan = await create(cdFlow + '/preview', request);
      const run = await create(cdFlow + '/run', {
        ...request,
        idempotencyKey: randomUUID(),
        expectedConfigurationHash: plan.configurationHash,
      });
      const approval = run.nodes.find(
        ({ nodeId }: { nodeId: string }) => nodeId === templateApproval.id,
      );
      assert.equal(approval.status, 'WAITING');
      assert.equal(approval.output.scope.serviceId, service.id);
      assert.deepEqual(approval.output.scope.artifactIds, [savedImage]);
      const decide = (decision: 'APPROVE' | 'REJECT') =>
        create(`${graphPath}/runs/${run.id}/nodes/${approval.nodeId}/decision`, {
          decision,
          expectedScopeHash: approval.output.scopeHash,
        });
      return { run, decide };
    };
    const rejected = await queueCd(cdRequest);
    await rejected.decide('REJECT');
    const refused = await waitGraph(rejected.run.id);
    assert.equal(refused.status, 'FAILED');
    assert.equal(
      refused.nodes.find(({ nodeId }: { nodeId: string }) => nodeId === templateRelease.id).taskId,
      null,
    );
    const expired = await queueCd(cdRequest);
    await db
      .updateTable('execution_node_runs')
      .set({ started_at: Date.now() - 61_000 })
      .where('run_id', '=', expired.run.id)
      .where('node_id', '=', templateApproval.id)
      .execute();
    const expiredApproval = expired.run.nodes.find(
      ({ nodeId }: { nodeId: string }) => nodeId === templateApproval.id,
    );
    await api
      .post(`/api/v1${graphPath}/runs/${expired.run.id}/nodes/${templateApproval.id}/decision`)
      .send({ decision: 'APPROVE', expectedScopeHash: expiredApproval.output.scopeHash })
      .expect(409);
    const timedOut = await waitGraph(expired.run.id);
    assert.equal(timedOut.status, 'TIMED_OUT');
    assert.equal(
      timedOut.nodes.find(({ nodeId }: { nodeId: string }) => nodeId === templateRelease.id).taskId,
      null,
    );
    for (const [code, status, health] of [
      [0, 'SUCCESS', 'HEALTHY'],
      [10, 'FAILED', 'UNHEALTHY'],
      [127, 'NEEDS_ATTENTION', 'UNKNOWN'],
    ] as const) {
      strictGraphProbeExitCode = code;
      const { run, decide } = await queueCd(cdRequest);
      await decide('APPROVE');
      const result = await waitGraph(run.id);
      assert.equal(result.status, status, JSON.stringify(result.nodes));
      const probe = result.nodes.find(
        ({ nodeId }: { nodeId: string }) => nodeId === templateProbe.id,
      );
      assert.equal(probe.status, status);
      assert.equal(probe.output.release.targets[0].health, health);
      assert.equal(probe.output.release.targets[0].probeExitCode, code);
      if (status === 'SUCCESS') assert.equal(result.outputs.healthStatus, health);
    }

    // A fixed service must follow the same health verdict as a service selected at run time.
    const fixed = structuredClone(expanded.canvas);
    const [fixedStart] = fixed.nodes;
    fixedStart!.inputs = fixedStart!.inputs!.filter(({ id }) => id !== 'service');
    fixed.endpoints[0]!.serviceId = service.id;
    fixed.endpoints[0]!.inputBindings![templateRelease.id]!.service = {
      kind: 'VALUE',
      value: { serviceId: service.id },
    };
    const fixedDraft = (
      await api
        .put('/api/v1' + graphPath + '/draft')
        .send({
          expectedRevision: cdDraft.revision,
          definition: { canvas: fixed },
        })
        .expect(200)
    ).body.data;
    const fixedVersion = (
      await create(graphPath + '/publish', { expectedRevision: fixedDraft.revision })
    ).publishedVersion;
    strictGraphProbeExitCode = 10;
    const fixedCd = await queueCd({
      version: fixedVersion,
      inputs: {
        parameters: {
          artifact: { artifactId: savedImage },
          releaseTargets: { serverIds: [serverIds[0]!] },
        },
      },
    });
    await fixedCd.decide('APPROVE');
    const fixedFailure = await waitGraph(fixedCd.run.id);
    assert.equal(fixedFailure.status, 'FAILED', JSON.stringify(fixedFailure.nodes));
    assert.equal(
      fixedFailure.nodes.find(({ nodeId }: { nodeId: string }) => nodeId === templateProbe.id)
        .output.status,
      'UNHEALTHY',
    );

    const ci = expandGraphTemplate('CI_BUILD', 'FILE');
    const ciCheck = ci.canvas.nodes.find(({ operation }) => operation === 'CHECK')!;
    const ciBuild = ci.canvas.nodes.find(({ operation }) => operation === 'BUILD')!;
    ciCheck.shell!.command = 'echo GRAPH_TEMPLATE_CI_FAIL; exit 23';
    ciBuild.build!.buildLocation = 'MANAGER';
    ciBuild.build!.buildCommand = 'echo GRAPH_TEMPLATE_BUILD_BLOCKED';
    ciBuild.build!.artifacts![0]!.path = 'app.jar';
    const ciDraft = (
      await api
        .put('/api/v1' + graphPath + '/draft')
        .send({ expectedRevision: fixedDraft.revision, definition: { canvas: ci.canvas } })
        .expect(200)
    ).body.data;
    const ciVersion = (await create(graphPath + '/publish', { expectedRevision: ciDraft.revision }))
      .publishedVersion;
    const ciFlow = `${graphPath}/flows/${ci.startId}`;
    const ciRequest = {
      version: ciVersion,
      inputs: {
        parameters: {
          repository: sharedRepo.id,
          gitVersion: { kind: 'COMMIT', value: successfulCommit },
        },
      },
    };
    const ciPlan = await create(ciFlow + '/preview', ciRequest);
    const ciQueued = await create(ciFlow + '/run', {
      ...ciRequest,
      idempotencyKey: randomUUID(),
      expectedConfigurationHash: ciPlan.configurationHash,
    });
    const ciFailed = await waitGraph(ciQueued.id);
    const findCiNode = (id: string) =>
      ciFailed.nodes.find(({ nodeId }: { nodeId: string }) => nodeId === id);
    assert.equal(ciFailed.status, 'FAILED');
    assert.equal(findCiNode(ciCheck.id).status, 'FAILED');
    assert.equal(findCiNode(ciBuild.id).status, 'SKIPPED');
    assert.equal(findCiNode(ciBuild.id).taskId, null);
    assert.deepEqual(ciFailed.artifactIds, []);
    const ciLog = (
      await api.get(`/api/v1${graphPath}/runs/${ciFailed.id}/nodes/${ciCheck.id}/logs`).expect(200)
    ).body.data;
    assert.match(ciLog.content, /fixture check failed/);

    const archiveRevision = await create(managedPath, { source: 'ARCHIVE', expectedVersion: 2 });
    assert.equal(archiveRevision.version, 3);
    await post(reviewPreview, historicalInput).expect(409);
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
