import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeGraphNodeEnvironment } from '../modules/execution-graphs/graph-environment';

test('build environment bindings override inherited values and freeze credential revisions', () => {
  const inherited = {
    variables: { APP_TOKEN: 'inherited value', RETAINED: 'retained' },
    secretVariables: { GIT_SHA: 'inherited-credential' },
    secretCredentialNonces: { GIT_SHA: 'inherited-revision' },
  };
  const merged = mergeGraphNodeEnvironment(inherited, {
    variables: { GIT_SHA: 'git-sha' },
    secretVariables: { APP_TOKEN: 'node-credential' },
    secretCredentialNonces: { APP_TOKEN: 'node-revision' },
  });
  assert.deepEqual({ ...merged.variables }, { RETAINED: 'retained', GIT_SHA: 'git-sha' });
  assert.deepEqual({ ...merged.secretVariables }, { APP_TOKEN: 'node-credential' });
  assert.deepEqual({ ...merged.secretCredentialNonces }, { APP_TOKEN: 'node-revision' });
  assert.equal(inherited.secretCredentialNonces.GIT_SHA, 'inherited-revision');
  assert.equal(inherited.variables.APP_TOKEN, 'inherited value');
});

test('build environment bindings reject reserved keys and credentials without a confirmed revision', () => {
  const inherited = { variables: {}, secretVariables: {} };
  assert.throws(
    () =>
      mergeGraphNodeEnvironment(inherited, {
        variables: { VEYOPS_GIT_COMMIT_SHA: 'attempted override' },
        secretVariables: {},
      }),
    /构建节点环境变量/,
  );
  assert.throws(
    () =>
      mergeGraphNodeEnvironment(inherited, {
        variables: {},
        secretVariables: { APP_TOKEN: 'node-credential' },
      }),
    /已确认的凭据版本/,
  );
});
