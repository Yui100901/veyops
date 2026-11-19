import assert from 'node:assert/strict';
import test from 'node:test';
import type { SshOptions, SshService, SshTarget } from '../infrastructure/ssh/ssh.service';
import {
  compareServerConfigurations,
  configurationProbe,
} from '../modules/servers/configuration-comparison';

const left = { id: 'left', name: 'left' } as SshTarget;
const right = { id: 'right', name: 'right' } as SshTarget;

test('comparison distinguishes a partial read, a real difference and an unreachable host', async () => {
  let unreachable = false;
  const ssh = {
    async execute(target: SshTarget, command: string, options: SshOptions) {
      assert.equal(command, configurationProbe);
      if (target === right && unreachable) throw new Error('private diagnostic');
      options.onData?.('secret=hidden\n', 'stderr');
      options.onData?.('extraField=hidden\nkernel=6.', 'stdout');
      options.onData?.(`1\narchitecture=x86_64\nprocessors=${target === left ? 2 : 8}\n`, 'stdout');
      if (target === left) options.onData?.('memory=4096\n', 'stdout');
      return { exitCode: 0 };
    },
  } as unknown as SshService;
  const both = await compareServerConfigurations(ssh, left, right);
  assert.equal(both.baseline.status, 'OK');
  assert.deepEqual(
    ['kernel', 'processors', 'memory'].map(
      (key) => both.rows.find((row) => row.key === key)?.status,
    ),
    ['EQUAL', 'DIFFERENT', 'UNKNOWN'],
  );
  assert.doesNotMatch(JSON.stringify(both), /hidden/);
  unreachable = true;
  const partial = await compareServerConfigurations(ssh, left, right);
  assert.equal(partial.comparison.status, 'UNAVAILABLE');
  assert.equal(partial.comparison.collectedAt, null);
  assert.ok(partial.rows.every((row) => row.status === 'UNKNOWN' && row.comparison === null));
  assert.doesNotMatch(JSON.stringify(partial), /private diagnostic/);
});
