import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ProcessRunnerService,
  ProcessExecutionError,
} from '../infrastructure/build-runner/process-runner.service';

test('trusted process runner uses argv without shell interpolation and scrubs streamed secrets', async () => {
  const runner = new ProcessRunnerService();
  let logs = '';
  const value = 'literal; echo unsafe $(whoami)';
  const result = await runner.run(
    process.execPath,
    [
      '-e',
      "process.stdout.write(process.argv[1]+'\\n');process.stdout.write('token-demo');process.stderr.write('token-demo');",
      value,
    ],
    {
      timeout: 5,
      secrets: ['token-demo'],
      onData: (text) => {
        logs += text;
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes(value));
  assert.ok(result.stdout.includes('[REDACTED]'));
  assert.equal(logs.includes('token-demo'), false);
});
test('build processes do not inherit platform secrets and accept secret input on stdin', async () => {
  const old = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'never-forward-this';
  try {
    const result = await new ProcessRunnerService().run(
      process.execPath,
      [
        '-e',
        "if(process.env.ENCRYPTION_KEY)process.exit(9);process.stdin.on('data',d=>process.stdout.write(d));",
      ],
      { timeout: 5, stdin: 'stdin-secret', secrets: ['stdin-secret'] },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '[REDACTED]');
  } finally {
    if (old === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = old;
  }
});
test('build runner handles exit codes, missing runtimes, cancellation and timeout', async () => {
  const runner = new ProcessRunnerService();
  assert.equal(
    (await runner.run(process.execPath, ['-e', 'process.exit(7)'], { timeout: 5 })).exitCode,
    7,
  );
  await assert.rejects(
    runner.run('veyops-nonexistent-runtime', [], { timeout: 5 }),
    /构建运行器启动失败/,
  );
  const abort = new AbortController();
  const waiting = runner.run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], {
    timeout: 5,
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(
    waiting,
    (e: unknown) => e instanceof ProcessExecutionError && e.kind === 'CANCELLED',
  );
  await assert.rejects(
    runner.run(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeout: 1 }),
    (e: unknown) => e instanceof ProcessExecutionError && e.kind === 'TIMED_OUT',
  );
});
