import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SshExecutionError,
  type SshOptions,
  type SshTarget,
} from '../infrastructure/ssh/ssh.service';
import {
  ArtifactOutputMissing,
  type ArtifactPhysicalService,
} from '../modules/artifacts/artifact-physical.service';
import { ExecutionPlanIssueError } from '../core/execution-plan-issue';
import { GraphNodeTasks, type GraphNodeScope } from '../modules/execution-graphs/graph-node-tasks';
import type { GraphNode } from '../modules/execution-graphs/execution-graph-definition';
import type { GraphWorkspaceRef } from '../modules/execution-graphs/graph-workspace';
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

function fixture(
  receipt: string,
  options: {
    task?: TaskRecord;
    transferError?: Error;
    compose?: Record<string, string>;
    exitCode?: number;
    noImage?: boolean;
  } = {},
) {
  const record = options.task ?? task;
  const registry = new TaskHandlerRegistry();
  const commands: string[] = [];
  const collected: Parameters<ArtifactPhysicalService['collectServerPath']>[0][] = [];
  const registered: Omit<PipelineArtifact, 'id'>[] = [];
  const transferred: GraphWorkspaceRef[] = [];
  const composePaths: { root: string; directory: string; path: string }[] = [];
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
    transferGraphWorkspace: async (
      _target: SshTarget,
      directory: string,
      _session: unknown,
      source: GraphWorkspaceRef,
    ) => {
      assert.equal(directory, work);
      transferred.push(source);
      if (options.transferError) throw options.transferError;
    },
    remoteComposeSnapshot: async (
      _target: SshTarget,
      directory: string,
      _session: unknown,
      source: (typeof composePaths)[number],
    ) => {
      assert.equal(directory, work);
      composePaths.push(source);
      return options.compose?.[source.path];
    },
  };
  const artifacts = {
    create: async (scope: PipelineSnapshot, output: Omit<PipelineArtifact, 'id'>) => {
      assert.equal(scope, record.payload.pipeline);
      registered.push(output);
    },
  };
  const ssh = {
    execute: async (_target: SshTarget, command: string, execution: SshOptions) => {
      commands.push(command);
      execution.onData?.('fixture output\n', 'stdout');
      return { exitCode: execution.onData ? (options.exitCode ?? 0) : 0 };
    },
  };
  const physical = {
    describeImage: async ({ reference }: { reference: string }) => {
      if (options.noImage) throw new ArtifactOutputMissing();
      return {
        imageReference: reference,
        imageId: 'sha256:' + (reference.endsWith(':two') ? 'b' : 'a').repeat(64),
      };
    },
    collectServerPath: async (
      input: Parameters<ArtifactPhysicalService['collectServerPath']>[0],
    ) => {
      collected.push(input);
      if (input.kind === 'FILE') throw new ArtifactOutputMissing();
      return { path: '/srv/fixture/artifacts/dir', sha256: 'e'.repeat(64), sizeBytes: 17 };
    },
  };
  const service = new GraphNodeTasks(
    {} as never,
    {
      preview: async ({ serverIds }: { serverIds: string[] }) => ({
        targets: serverIds.map((id) => ({ id, name: target.name })),
        targetHash: 'confirmed-hash',
      }),
    } as never,
    registry,
    {
      resolveVariables: async () => ({ variables: {}, secretVariables: {}, variableSources: [] }),
    } as never,
    {} as never,
    builds as never,
    artifacts as never,
    ssh as never,
    {} as never,
    physical as never,
    { get: async () => ({ targetWorkspaceRoot: '/srv/fixture/workspaces' }) } as never,
  );
  service.onModuleInit();
  return {
    execute: () => registry.get('GRAPH_MODULE').execute(record, context),
    prepare: (node: GraphNode, scope: GraphNodeScope) => service.prepare('project', node, scope),
    commands,
    collected,
    registered,
    transferred,
    composePaths,
    statuses,
    log,
  };
}

test('target checks collect declared outputs from the script working directory and skip missing optional files', async () => {
  const fixtureRun = fixture(`VEYOPS_WORKSPACE=${work}\n`);
  const result = await fixtureRun.execute();
  assert.equal(result?.graphOutputs.exitCode, 0);
  assert.match(fixtureRun.commands[0]!, /cd -P -- '\.\/out'/);
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

const checkout: GraphWorkspaceRef = {
  runId: '10000000-0000-4000-8000-000000000001',
  nodeRunId: '10000000-0000-4000-8000-000000000002',
  repositoryId: '10000000-0000-4000-8000-000000000003',
  commitSha: 'a'.repeat(40),
};
const checker: GraphNode = {
  id: 'check',
  name: '远程检查',
  type: 'CHECK',
  shell: { command: 'echo report', location: 'TARGET', directory: 'out' },
};

test('target check previews the pinned workspace, execution directory, and exactly one target', async () => {
  const run = fixture('');
  const values = { workspace: checkout, source: checkout, targets: { serverIds: [target.id] } };
  const plan = await run.prepare(checker, {
    values,
    inputEvidence: [
      {
        fieldId: 'workspace',
        name: '源码工作区',
        type: 'WORKSPACE',
        state: 'RESOLVED',
        source: { kind: 'OUTPUT', nodeId: 'checkout', fieldId: 'workspace' },
      },
    ],
  });
  assert.ok(plan.type === 'CHECK');
  assert.equal(plan.serverId, target.id);
  assert.equal(plan.targetWorkspaceRoot, '/srv/fixture/workspaces');
  assert.equal(plan.directory, 'out');
  assert.deepEqual(plan.workspace, {
    producerNodeId: 'checkout',
    producerField: 'workspace',
    repositoryId: checkout.repositoryId,
    commitSha: checkout.commitSha,
    deferred: false,
  });
  for (const targets of [undefined, { serverIds: ['one', 'two'] }])
    await assert.rejects(
      run.prepare(checker, { values: { ...values, targets } }),
      (error) => error instanceof ExecutionPlanIssueError && error.issue.fieldId === 'targets',
    );
  await assert.rejects(
    run.prepare(checker, {
      values: {
        ...values,
        source: { ...checkout, commitSha: 'b'.repeat(40) },
      },
    }),
    (error) => error instanceof ExecutionPlanIssueError && error.issue.fieldId === 'workspace',
  );
});

test('a target check without artifacts copies upstream workspace into its private repo and cleans it', async () => {
  const record = structuredClone(task);
  record.payload.pipeline = undefined;
  record.payload.graphModule!.workspace = checkout;
  const receipt = 'VEYOPS_WORKSPACE=' + work + '\n';
  const run = fixture(receipt, { task: record });
  assert.equal((await run.execute())?.graphOutputs.exitCode, 0);
  assert.deepEqual(run.transferred, [checkout]);
  assert.ok(run.commands[0]!.startsWith("cd -P -- '" + work + "/repo'"));
  assert.match(run.commands[0]!, /cd -P -- '\.\/out'/);
  assert.ok(run.commands[1]!.endsWith("rm -rf -- '" + work + "'"));
  assert.equal(run.registered.length, 0);

  const failed = fixture(receipt, {
    task: record,
    transferError: new SshExecutionError('upload cancelled', 'CANCELLED'),
  });
  await assert.rejects(failed.execute(), /upload cancelled/);
  assert.equal(failed.commands.length, 1);
  assert.ok(failed.commands[0]!.endsWith("rm -rf -- '" + work + "'"));
  assert.deepEqual(failed.statuses, ['CANCELLED']);

  const exited = fixture(receipt, { task: record, exitCode: 7 });
  await assert.rejects(exited.execute(), /脚本退出码 7/);
  assert.equal(exited.commands.length, 2);
  assert.ok(exited.commands[1]!.endsWith("rm -rf -- '" + work + "'"));
  assert.deepEqual(exited.statuses, ['FAILED']);

  const uncertain = fixture(receipt, {
    task: record,
    transferError: new SshExecutionError('unconfirmed extraction', 'NEEDS_ATTENTION'),
  });
  await assert.rejects(uncertain.execute(), /unconfirmed extraction/);
  assert.deepEqual(uncertain.commands, []);
  assert.deepEqual(uncertain.statuses, ['NEEDS_ATTENTION']);
});

test('target scripts attach a scoped Compose snapshot to each image, with consistent missing-file semantics', async () => {
  const record = structuredClone(task);
  record.payload.graphModule!.workspace = checkout;
  const first = 'services:\n  web:\n    image: ${VEYOPS_IMAGE}\n';
  const second = 'services:\n  api:\n    image: ${VEYOPS_IMAGE}\n';
  record.payload.pipeline!.definition.artifacts = [
    {
      name: 'one',
      type: 'DOCKER_IMAGE',
      imageReference: 'fixture:one',
      composeFilePath: 'ops/one.yaml',
      persist: false,
    },
    {
      name: 'two',
      type: 'DOCKER_IMAGE',
      imageReference: 'fixture:two',
      composeFilePath: 'ops/two.yaml',
      required: false,
    },
  ];
  const receipt = 'VEYOPS_WORKSPACE=' + work + '\n';
  const valid = fixture(receipt, {
    task: record,
    compose: { 'ops/one.yaml': first, 'ops/two.yaml': second },
  });
  await valid.execute();
  assert.deepEqual(valid.composePaths, [
    { root: work + '/repo', directory: 'out', path: 'ops/one.yaml' },
    { root: work + '/repo', directory: 'out', path: 'ops/two.yaml' },
  ]);
  assert.deepEqual(
    valid.registered.map(({ name, composeYaml, imageId, persist }) => [
      name,
      composeYaml,
      imageId,
      persist,
    ]),
    [
      ['one', first, 'sha256:' + 'a'.repeat(64), false],
      ['two', second, 'sha256:' + 'b'.repeat(64), undefined],
    ],
  );

  for (const invalid of [
    undefined,
    'services:\n  web:\n    privileged: true\n    image: ${VEYOPS_IMAGE}\n',
  ]) {
    const missing = fixture(receipt, {
      task: record,
      compose: {
        'ops/one.yaml': first,
        ...(invalid && { 'ops/two.yaml': invalid }),
      },
    });
    await assert.rejects(
      missing.execute(),
      (error) =>
        error instanceof ExecutionPlanIssueError &&
        error.issue.fieldId === 'two' &&
        error.issue.artifactField === 'composeFilePath' &&
        error.message.includes('out/ops/two.yaml'),
    );
  }
  record.payload.pipeline!.definition.artifacts.shift();
  const skipped = fixture(receipt, { task: record, noImage: true });
  await skipped.execute();
  assert.deepEqual(skipped.composePaths, []);
  assert.deepEqual(skipped.registered, []);
});

test('an invalid target workspace receipt never executes a script, collects a path, or removes the directory', async () => {
  const fixtureRun = fixture('VEYOPS_WORKSPACE=/srv/unrelated-workspace\n');
  await assert.rejects(fixtureRun.execute(), /未返回有效/);
  assert.deepEqual(fixtureRun.commands, []);
  assert.deepEqual(fixtureRun.collected, []);
  assert.deepEqual(fixtureRun.registered, []);
  assert.deepEqual(fixtureRun.statuses, ['FAILED']);
});
