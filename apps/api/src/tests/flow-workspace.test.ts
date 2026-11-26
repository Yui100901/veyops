import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import type { SshOptions, SshTarget } from '../infrastructure/ssh/ssh.service';
import type { GraphCheckoutSnapshot } from '../modules/projects/repository-metadata.service';
import type { TaskExecutionContext } from '../modules/tasks/tasks.types';

test('flow workspaces preserve files across actions, isolate runs and verify path ownership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'veyops-flow-workspace-'));
  Object.assign(process.env, {
    DATA_DIR: root,
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const { FlowWorkspaceService } =
    await import('../modules/execution-graphs/flow-workspace.service.js');
  const { ArtifactPhysicalService } =
    await import('../modules/artifacts/artifact-physical.service.js');
  const { ProcessRunnerService } =
    await import('../infrastructure/build-runner/process-runner.service.js');
  const runId = randomUUID();
  const context: TaskExecutionContext = {
    signal: new AbortController().signal,
    log: () => undefined,
    startTarget: async () => randomUUID(),
    finishTarget: async () => undefined,
    startStep: async () => randomUUID(),
    finishStep: async () => undefined,
  };
  const command = {
    taskId: randomUUID(),
    directory: 'frontend/example',
    command: 'fixture command',
    timeout: 30,
    variables: { values: { CHOICE: 'test' }, secrets: [] },
  };
  const sources: GraphCheckoutSnapshot[] = ['a', 'b'].map((digit) => ({
    repositoryId: randomUUID(),
    fullClone: false,
    commitSha: digit.repeat(40),
    access: { clone_url: 'https://git.example.test/example.git', credential_id: null },
  }));
  const managed = new FlowWorkspaceService(
    null!,
    {
      async managerFlowCommand(
        _session: unknown,
        workspace: string,
        commandText: string,
        directory: string,
        variables: Record<string, string>,
      ) {
        assert.equal(variables.VEYOPS_RUN_ID, runId);
        assert.equal(variables.VEYOPS_WORKSPACE, '/workspace');
        assert.equal(variables.CHOICE, 'test');
        assert.equal(
          await readFile(join(workspace, directory, 'source.txt'), 'utf8'),
          sources[0]!.commitSha,
        );
        const artifact = join(workspace, directory, 'build.txt');
        if (commandText === 'build') await writeFile(artifact, 'compiled');
        else assert.equal(await readFile(artifact, 'utf8'), 'compiled');
        return { exitCode: 0 };
      },
    } as never,
    {
      async checkoutGraphSource(
        _projectId: string,
        source: GraphCheckoutSnapshot,
        _signal: AbortSignal,
        destination: string,
      ) {
        await mkdir(destination);
        await writeFile(join(destination, 'source.txt'), source.commitSha);
        return { shallow: !source.fullClone, subject: 'source', commitSha: source.commitSha };
      },
    } as never,
    null!,
  );
  const placement = { location: 'MANAGER', projectSlug: 'project1' } as const;
  const [workspace, concurrent] = await Promise.all([
    managed.open(runId, placement),
    managed.open(runId, placement),
  ]);
  assert.equal(workspace.path, concurrent.path);
  assert.ok(workspace.path.endsWith(sep + join('flow-workspaces', 'project1', runId)));
  const other = await managed.open(randomUUID(), placement);
  assert.notEqual(workspace.path, other.path);
  const checkouts = sources.map((source, index) => ({
    source,
    directory: index === 0 ? './frontend/example' : 'admin/example',
  }));
  const receipt = await managed.checkout(workspace, 'project', checkouts, context);
  assert.deepEqual(
    receipt.map(({ directory, commitSha }) => [directory, commitSha]),
    [
      ['frontend/example', sources[0]!.commitSha],
      ['admin/example', sources[1]!.commitSha],
    ],
  );
  await managed.command(workspace, { ...command, command: 'build' }, context);
  await managed.command(workspace, { ...command, command: 'check' }, context);
  await assert.rejects(readFile(join(other.path, 'frontend', 'example', 'build.txt'), 'utf8'));
  await assert.rejects(managed.checkout(workspace, 'project', checkouts, context), /已存在/);
  await assert.rejects(
    managed.checkout(
      workspace,
      'project',
      [
        { ...checkouts[0]!, directory: 'overlap' },
        { ...checkouts[1]!, directory: 'overlap/child' },
      ],
      context,
    ),
    /不可重名或相互包含/,
  );
  await symlink(other.path, join(workspace.path, 'external'), 'junction');
  await assert.rejects(
    managed.checkout(
      workspace,
      'project',
      [{ ...checkouts[0]!, directory: 'external/example' }],
      context,
    ),
    /包含符号链接/,
  );
  await assert.rejects(managed.open(runId, placement, undefined, other.path), /已变化/);
  await assert.rejects(managed.cleanup({ ...workspace, path: other.path }), /已变化/);
  await writeFile(join(workspace.path, '.env'), 'PRIVATE_VALUE=keep-local');
  await writeFile(join(workspace.path, 'private-settings'), 'private-value');
  const processes = new ProcessRunnerService();
  const artifacts = new ArtifactPhysicalService(null!, null!, processes, null!, null!);
  const retained = await artifacts.retainFlowWorkspace({
    workspace,
    excludePaths: ['private-settings'],
  });
  assert.equal(retained.path, workspace.path);
  assert.equal(await readFile(join(retained.path!, '.env'), 'utf8'), 'PRIVATE_VALUE=keep-local');
  assert.equal((await artifacts.verify(retained)).status, 'AVAILABLE');
  const archive = join(root, 'workspace.tar.gz');
  await artifacts.stageBuilderArchive(retained, archive, '.');
  const contents = await processes.run('tar', ['-tzf', archive], { timeout: 10 });
  assert.equal(contents.exitCode, 0);
  assert.match(contents.stdout, /frontend\/example\/build.txt/);
  assert.doesNotMatch(contents.stdout, /\.env|external|private-settings/);
  await assert.rejects(artifacts.verifyPathSelection(retained, 'private-settings'), /找不到/);
  const output = join(workspace.path, 'frontend', 'example', 'build.txt');
  await writeFile(output, 'changed');
  assert.equal((await artifacts.verify(retained)).status, 'CHANGED');
  assert.equal((await artifacts.remove(retained)).status, 'RETRY');
  await writeFile(output, 'compiled');
  assert.equal((await artifacts.remove(retained)).status, 'DELETED');
  await assert.rejects(managed.open(runId, placement, undefined, workspace.path));
  await managed.cleanup(other);

  const server: SshTarget = {
    id: randomUUID(),
    name: 'target',
    host: 'example.test',
    port: 22,
    username: 'operator',
    credentialId: randomUUID(),
    hostKeyFingerprint: 'SHA256:expected',
  };
  const remotePath = '/srv/work/project1/' + runId;
  let remoteReceipt = remotePath;
  let checkoutSha = sources[0]!.commitSha;
  const requests: Array<{ command: string; options: SshOptions }> = [];
  const uploads: Array<{ contents: string; destination: string; mode?: number }> = [];
  const target = new FlowWorkspaceService(
    {
      async execute(connection: SshTarget, commandText: string, options: SshOptions) {
        assert.equal(connection, server);
        requests.push({ command: commandText, options });
        if (commandText.includes('VEYOPS_FLOW_WORKSPACE='))
          options.onData?.('VEYOPS_FLOW_WORKSPACE=' + remoteReceipt + '\n', 'stdout');
        if (commandText.includes('git fixture checkout'))
          options.onData?.('VEYOPS_FLOW_GIT=' + checkoutSha + ':true\n', 'stdout');
        return { exitCode: 0 };
      },
      async uploadContent(
        connection: SshTarget,
        contents: string,
        destination: string,
        options: { mode?: number },
      ) {
        assert.equal(connection, server);
        uploads.push({ contents, destination, mode: options.mode });
      },
    } as never,
    {
      async prepareFlowTargetCheckout(
        projectId: string,
        source: GraphCheckoutSnapshot,
        directory: string,
      ) {
        assert.equal(projectId, 'project');
        assert.equal(source.commitSha, sources[0]!.commitSha);
        return {
          command: 'git fixture checkout',
          credential: {
            path: directory + '/credential',
            response: 'fixture-credential-response',
            values: ['fixture-credential-response'],
          },
        };
      },
    } as never,
    null!,
    null!,
  );
  const remote = await target.open(runId, {
    location: 'TARGET',
    projectSlug: 'project1',
    target: server,
    root: '/srv/work',
  });
  assert.equal(remote.path, remotePath);
  const [frozenSource] = await target.checkout(remote, 'project', [checkouts[0]!], context);
  assert.equal(frozenSource?.commitSha, sources[0]!.commitSha);
  assert.equal(frozenSource?.shallow, true);
  assert.equal(uploads[0]?.mode, 0o600);
  assert.match(uploads[0]!.destination, /\/\.runs\/.*\/checkout-.*\/credential$/);
  const checkout = requests.find(({ command: script }) => script.includes('git fixture checkout'))!;
  assert.match(checkout.command, /flock -n 9.*git fixture checkout.*mv -T/s);
  assert.doesNotMatch(checkout.command, /fixture-credential-response/);
  assert.deepEqual(checkout.options.secrets, ['fixture-credential-response']);
  checkoutSha = sources[1]!.commitSha;
  await assert.rejects(
    target.checkout(remote, 'project', [checkouts[0]!], context),
    /提交与已确认版本不一致/,
  );
  await target.command(
    remote,
    {
      ...command,
      command: 'printf "%s" "$PASSWORD"',
      variables: { values: { PASSWORD: 'fixture-password' }, secrets: ['fixture-password'] },
    },
    context,
  );
  const request = requests.at(-1)!;
  assert.match(request.command, /flock -sn 9/);
  assert.match(request.command, /frontend\/example/);
  assert.doesNotMatch(request.command, /fixture-password/);
  assert.equal(request.options.variables?.variables.VEYOPS_WORKSPACE, remotePath);
  assert.deepEqual(request.options.secrets, ['fixture-password']);
  remoteReceipt = '/srv/other/project1/' + runId;
  await assert.rejects(target.cleanup(remote), /未确认/);
  remoteReceipt = remotePath;
  await target.cleanup(remote);
  assert.match(requests.at(-1)!.command, /flock -n 9.*rm -rf/s);
});
