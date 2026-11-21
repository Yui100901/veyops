import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphProbeResult } from '../modules/pipelines/graph-release-health';

test('graph rollback health gate only accepts an explicit unhealthy probe result', () => {
  assert.deepEqual(graphProbeResult({ exitCode: 0 }), { health: 'HEALTHY', probeExitCode: 0 });
  assert.deepEqual(graphProbeResult({ exitCode: 10 }), { health: 'UNHEALTHY', probeExitCode: 10 });
  for (const exitCode of [1, 2, 22, 90, 126, 127, 137]) {
    const result = graphProbeResult({ exitCode });
    assert.equal(result.health, 'UNKNOWN');
    assert.ok(result.healthReason);
  }
  assert.equal(graphProbeResult({ exitCode: 10, signal: 'SIGTERM' }).health, 'UNKNOWN');
});
