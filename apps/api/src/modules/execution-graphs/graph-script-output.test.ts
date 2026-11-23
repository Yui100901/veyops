import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphField } from './graph-fields';
import { GraphScriptOutput } from './graph-script-output';

const directory: GraphField = {
  id: 'result-directory',
  name: '产物目录',
  exportName: 'ARTIFACT_DIR',
  type: 'PATH',
  required: true,
  defaultValue: './dist',
};

function result(stdout: string, field: GraphField = directory) {
  const reader = new GraphScriptOutput(() => undefined, []);
  reader.finish({ stdout, stderr: '' });
  return reader.values([field]);
}

test('a required script output uses its default only when the script omits the key', () => {
  assert.deepEqual(result(''), { 'result-directory': './dist' });
  assert.deepEqual(result('VEYOPS_OUTPUT={"ARTIFACT_DIR":"./custom"}\n'), {
    'result-directory': './custom',
  });
  assert.throws(() => result('VEYOPS_OUTPUT={"ARTIFACT_DIR":[]}\n'), /产物目录/);
  assert.throws(() => result('', { ...directory, defaultValue: undefined }), /产物目录/);
});

test('a project service output accepts a typed object while checking only top-level output names', () => {
  const service: GraphField = {
    id: 'service',
    name: '项目服务',
    exportName: 'PROJECT_SERVICE',
    type: 'SERVICE',
  };
  const serviceId = 'a4f69b37-ef17-4a4d-9bd1-214357683a4b';
  assert.deepEqual(
    result(`VEYOPS_OUTPUT={"PROJECT_SERVICE":{"serviceId":"${serviceId}"}}\n`, service),
    { service: { serviceId } },
  );
  assert.throws(
    () =>
      result(
        `VEYOPS_OUTPUT={"PROJECT_SERVICE":"${serviceId}","serviceId":"${serviceId}"}\n`,
        service,
      ),
    /未声明的输出/,
  );
  assert.throws(
    () =>
      result(
        `VEYOPS_OUTPUT={"PROJECT_SERVICE":"${serviceId}","PROJECT_SERVICE":"${serviceId}"}\n`,
        service,
      ),
    /重复提供输出/,
  );
});
