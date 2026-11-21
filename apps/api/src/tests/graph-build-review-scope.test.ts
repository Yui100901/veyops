import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  assertReviewedSources,
  reviewSources,
  type GraphGateScope,
} from '../modules/execution-graphs/graph-release-gates';

test('build review matches the complete pinned source set and the associated node', () => {
  const main = { repositoryId: randomUUID(), commitSha: 'a'.repeat(40) };
  const dependency = { repositoryId: randomUUID(), commitSha: 'b'.repeat(40) };
  const envFile = { repositoryId: main.repositoryId, commitSha: 'c'.repeat(40) };
  const scope: GraphGateScope = {
    kind: 'SOURCE_REVIEW',
    buildNodeId: 'assemble',
    sources: reviewSources([main, dependency, envFile]),
    artifactIds: [],
  };

  assert.doesNotThrow(() =>
    assertReviewedSources(scope, [envFile, dependency, main, main], 'assemble'),
  );
  assert.throws(() => assertReviewedSources(scope, [envFile, main], 'assemble'), /审核范围不一致/);
  assert.throws(
    () =>
      assertReviewedSources(
        scope,
        [main, dependency, { ...envFile, commitSha: 'd'.repeat(40) }],
        'assemble',
      ),
    /审核范围不一致/,
  );
  assert.throws(
    () => assertReviewedSources(scope, [main, dependency, envFile], 'other-build'),
    /构建节点不一致/,
  );
  assert.throws(() => assertReviewedSources(scope, [main, dependency, envFile]), /构建节点不一致/);
});
