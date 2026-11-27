import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MultiTargetExecutor } from '../infrastructure/ssh/multi-target.executor';
import type { SshOptions, SshService, SshTarget } from '../infrastructure/ssh/ssh.service';
import { draftOperationActions } from '../modules/ai/ai-operation-plan-assistant';
import {
  legacyOperationChain,
  operationFactsProbe,
  resolveOperationChain,
  validateOperationChain,
} from '../modules/operation-plans/operation-chain';
import type { TaskExecutionContext, TaskStatus } from '../modules/tasks/tasks.types';

const targets = [
  { os: 'ubuntu', manager: 'apt-get', uid: '0' },
  { os: 'rocky', manager: 'dnf', uid: '0' },
];
const actions = [
  { type: 'INSPECT_DISK' },
  { type: 'INSTALL_PACKAGES', packages: { 'apt-get': ['nginx'], dnf: ['nginx'] } },
  { type: 'INSPECT_SERVICES' },
];

test('legacy operation versions can display all phases in the same execution chain', () => {
  const chain = legacyOperationChain({
    preChecks: [{ name: 'ready', command: 'echo ready' }],
    steps: [{ name: 'install', command: 'echo install', failurePolicy: 'CONTINUE' }],
    postChecks: [{ name: 'verify', command: 'echo verify' }],
  });
  validateOperationChain(chain);
  assert.deepEqual(
    resolveOperationChain(chain, {}).steps.map(({ name, failurePolicy }) => [name, failurePolicy]),
    [
      ['前置检查 · ready', 'STOP'],
      ['install', 'CONTINUE'],
      ['执行后验证 · verify', 'STOP'],
    ],
  );
});

test('operation chain rejects orphaned nodes and cycles before saving', () => {
  const chain = legacyOperationChain({ steps: [{ name: 'command', command: 'true' }] });
  assert.throws(
    () =>
      validateOperationChain({
        ...chain,
        edges: [
          { from: 'start', to: 'step-1' },
          { from: 'step-1', to: 'step-1' },
        ],
      }),
    /环路/,
  );
  assert.throws(
    () =>
      validateOperationChain({
        ...chain,
        edges: [
          { from: 'start', to: 'end' },
          { from: 'step-1', to: 'end' },
        ],
      }),
    /连接至开始节点/,
  );
});

test('AI install recipes require grounded branches and safe package identifiers', () => {
  assert.throws(
    () => draftOperationActions(actions, [targets[0]!, { manager: 'apk', uid: '0' }]),
    /不兼容/,
  );
  assert.throws(() => draftOperationActions(actions, [{ manager: 'dnf', uid: '1000' }]), /不兼容/);
  assert.throws(
    () =>
      draftOperationActions(
        [{ type: 'INSTALL_PACKAGES', packages: { 'apt-get': ['nginx; fail'] } }],
        [targets[0]!],
      ),
    /不兼容/,
  );
  const chain = draftOperationActions(actions, targets);
  assert.deepEqual(
    chain.edges.flatMap(({ when }) => when ?? []),
    ['apt-get', 'dnf'],
  );
  assert.throws(() => resolveOperationChain(chain, { PACKAGE_MANAGER: 'apk' }), /没有匹配分支/);
});

test('operation worker executes only the selected branch on each server and isolates an unmatched target', async () => {
  const chain = draftOperationActions(actions, targets);
  const machines: SshTarget[] = [...targets, { os: 'alpine', manager: 'apk', uid: '0' }].map(
    ({ os }) => ({
      id: os,
      name: os,
      host: 'localhost',
      port: 22,
      username: 'root',
      credentialId: 'credential',
      hostKeyFingerprint: 'fingerprint',
    }),
  );
  const commands = new Map<string, string[]>();
  const status = new Map<string, TaskStatus>();
  const stepKeys = new Map<string, string[]>();
  const ssh = {
    async execute(target: SshTarget, command: string, options: SshOptions) {
      if (command === operationFactsProbe) {
        const manager = target.id === 'ubuntu' ? 'apt-get' : target.id === 'rocky' ? 'dnf' : 'apk';
        options.onData?.(`os=${target.id}\n${manager}=available\nprobeComplete=1\n`, 'stdout');
      } else commands.set(target.id, [...(commands.get(target.id) ?? []), command]);
      return { exitCode: 0 };
    },
  } as SshService;
  const context: TaskExecutionContext = {
    signal: new AbortController().signal,
    log: () => undefined,
    startTarget: async (id) => id,
    finishTarget: async (id, state) => {
      status.set(id, state);
    },
    startStep: async (_target, id, step) => {
      stepKeys.set(id, [...(stepKeys.get(id) ?? []), step.key!]);
      return step.key!;
    },
    finishStep: async () => undefined,
  };
  await new MultiTargetExecutor(ssh).execute(
    {
      id: 'plan-task',
      name: 'Install and verify',
      type: 'OPERATION_PLAN',
      payload: {
        operationChain: chain,
        targets: machines,
        steps: [],
        strategy: 'PARALLEL',
        maxParallel: 3,
        failurePolicy: 'CONTINUE',
        timeout: 30,
      },
    },
    context,
  );
  assert.deepEqual(
    commands.get('ubuntu')?.map((command) => command.includes('apt-get')),
    [false, true, false],
  );
  assert.deepEqual(
    commands.get('rocky')?.map((command) => command.includes('dnf')),
    [false, true, false],
  );
  assert.deepEqual(stepKeys.get('ubuntu'), ['read-0', 'install-1-apt-get', 'read-2']);
  assert.deepEqual(stepKeys.get('rocky'), ['read-0', 'install-1-dnf', 'read-2']);
  assert.equal(commands.has('alpine'), false);
  assert.equal(status.get('alpine'), 'FAILED');
  assert.equal(status.get('ubuntu'), 'SUCCESS');
  assert.equal(status.get('rocky'), 'SUCCESS');
});
