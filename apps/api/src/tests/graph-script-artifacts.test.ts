import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SshOptions, SshTarget } from '../infrastructure/ssh/ssh.service';
import {
  ArtifactOutputMissing,
  type ArtifactPhysicalService,
} from '../modules/artifacts/artifact-physical.service';
import { GraphNodeTasks } from '../modules/execution-graphs/graph-node-tasks';
import { PipelineDefinitionDto } from '../modules/pipelines/pipeline.dto';
import type { PipelineArtifact, PipelineSnapshot } from '../modules/pipelines/pipeline.types';
import { TaskHandlerRegistry } from '../modules/tasks/task-handler.registry';
import type { TaskExecutionContext, TaskRecord, TaskStatus } from '../modules/tasks/tasks.types';

const target: SshTarget = {
  id: 'target',
  name: '目标服务器',
  host: 'target.example.invalid',
  port: 22,
  username: 'runner',
  credentialId: null,
  hostKeyFingerprint: 'fixture-host-key',
};
const work = '/srv/fixture/workspaces/veyops-script-task';
const definition = Object.assign(new PipelineDefinitionDto(), {
  repoPath: 'out',
  artifacts: [
    { name: 'missing', type: 'FILE', path: 'optional.txt', required: false },
    { name: 'directory', type: 'DIRECTORY', path: 'dist', persist: false },
  ],
});
const artifactScope: PipelineSnapshot = {
  runId: 'build-run',
  pipelineId: 'pipeline',
  pipelineVersionId: 'version',
  projectId: 'project',
  serviceId: 'service',
  environmentId: 'environment',
  commitSha: 'a'.repeat(40),
  mode: 'BUILD_ONLY',
  graph: { runId: 'run', nodeRunId: 'node-run' },
  repository: { url: '', credentialId: null },
  variables: {},
  secretVariables: {},
  definition,
};
const task: TaskRecord = {
  id: 'task',
  type: 'GRAPH_MODULE',
  name: '脚本产物',
  payload: {
    targets: [target],
    steps: [],
    strategy: 'SEQUENTIAL',
    maxParallel: 1,
    failurePolicy: 'STOP',
    timeout: 120,
    pipeline: artifactScope,
    graphModule: {
      type: 'CHECK',
      projectId: 'project',
      targetDirectory: 'out',
      targetWorkspaceRoot: '/srv/fixture/workspaces',
      shell: {
        command: 'echo report',
        timeout: 30,
        continueOnFailure: false,
        parameters: { variables: {}, secretVariables: {} },
        outputs: [],
      },
    },
  },
};

function fixture(receipt: string) {
  const registry = new TaskHandlerRegistry();
  const commands: string[] = [];
  const collected: Parameters<ArtifactPhysicalService['collectServerPath']>[0][] = [];
  const registered: Omit<PipelineArtifact, 'id'>[] = [];
  const statuses: TaskStatus[] = [];
  const log: string[] = [];
  const context: TaskExecutionContext = {
    signal: AbortSignal.timeout(1000),
    log: (line) => log.push(line),
    startTarget: async () => 'task-target',
    finishTarget: async (_id, status) => {
      statuses.push(status);
    },
    startStep: async () => {
      throw new Error('unanticipated task step');
    },
    finishStep: async () => {
      throw new Error('unanticipated task step');
    },
  };
  const builds = {
    resolveVariables: async () => ({ values: {}, secrets: [] }),
    remoteCapture: async (_target: SshTarget, command: string) => {
      assert.match(command, /mkdir -- 'veyops-script-task'/);
      return receipt;
    },
  };
  const artifacts = {
    create: async (scope: PipelineSnapshot, output: Omit<PipelineArtifact, 'id'>) => {
      assert.equal(scope, artifactScope);
      registered.push(output);
    },
  };
  const ssh = {
    execute: async (_target: SshTarget, command: string, options: SshOptions) => {
      commands.push(command);
      options.onData?.('fixture output\n', 'stdout');
      return { exitCode: 0 };
    },
  };
  const physical = {
    collectServerPath: async (
      input: Parameters<ArtifactPhysicalService['collectServerPath']>[0],
    ) => {
      collected.push(input);
      if (input.kind === 'FILE') throw new ArtifactOutputMissing();
      return { path: '/srv/fixture/artifacts/dir', sha256: 'e'.repeat(64), sizeBytes: 17 };
    },
  };
  new GraphNodeTasks(
    {} as never,
    {} as never,
    registry,
    {} as never,
    {} as never,
    builds as never,
    artifacts as never,
    ssh as never,
    {} as never,
    physical as never,
    {} as never,
  ).onModuleInit();
  return {
    execute: () => registry.get('GRAPH_MODULE').execute(task, context),
    commands,
    collected,
    registered,
    statuses,
    log,
  };
}

test('target checks collect declared outputs from the script working directory and skip missing optional files', async () => {
  const fixtureRun = fixture(`VEYOPS_WORKSPACE=${work}\n`);
  const result = await fixtureRun.execute();
  assert.equal(result?.graphOutputs.exitCode, 0);
  assert.match(fixtureRun.commands[0]!, /cd -P -- 'out'/);
  assert.ok(fixtureRun.commands[0]!.startsWith(`cd -P -- '${work}'`));
  assert.ok(fixtureRun.commands[1]!.endsWith(`rm -rf -- '${work}'`));
  assert.deepEqual(
    fixtureRun.collected.map(({ workspace, relativePath }) => [workspace, relativePath]),
    [
      [work, 'out/optional.txt'],
      [work, 'out/dist'],
    ],
  );
  const [output] = fixtureRun.registered;
  assert.equal(fixtureRun.registered.length, 1);
  assert.equal(output?.persist, false);
  assert.equal(output?.serverId, target.id);
  assert.equal(output?.storageType, 'REMOTE_FILE');
  assert.deepEqual(fixtureRun.statuses, ['SUCCESS']);
});

test('an invalid target workspace receipt never executes a script, collects a path, or removes the directory', async () => {
  const fixtureRun = fixture('VEYOPS_WORKSPACE=/srv/unrelated-workspace\n');
  await assert.rejects(fixtureRun.execute(), /未返回有效/);
  assert.deepEqual(fixtureRun.commands, []);
  assert.deepEqual(fixtureRun.collected, []);
  assert.deepEqual(fixtureRun.registered, []);
  assert.deepEqual(fixtureRun.statuses, ['FAILED']);
});
