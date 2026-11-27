import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AiExecutionGraphDraftService } from '../modules/ai/ai-execution-graph-draft';
import { compileCanvas } from '../modules/execution-graphs/execution-graph-canvas';

const projectId = '0d1c0206-da3a-49e9-9d2f-43a2de5f824e';
const repositoryId = 'cb043719-f7a1-418a-9c4e-8f4c9adcdbf1';
const serviceId = 'c4c92a33-ea48-460e-a2d2-764a1ae58219';
const serverId = 'bf2bf2c4-a76d-4cbf-8087-5765bc44a9a5';
const commitSha = 'a'.repeat(40);
const repoSecret = 'example-fake-password-33';
const files = [
  { path: 'DEPLOY.md', kind: 'deployment', content: `build and deploy\npassword=${repoSecret}` },
  { path: 'frontend/Dockerfile', kind: 'configuration', content: 'FROM busybox:1.36' },
  { path: 'frontend/index.html', kind: 'source', content: '<main>Frontend</main>' },
  { path: 'backend/Dockerfile', kind: 'configuration', content: 'FROM busybox:1.36' },
  {
    path: 'compose.yaml',
    kind: 'configuration',
    content:
      'services:\n  front:\n    image: ${VEYOPS_IMAGE_FRONTEND}\n  back:\n    image: ${VEYOPS_IMAGE_BACKEND}\n',
  },
];

function fixture(recipe: unknown) {
  const calls: unknown[][] = [];
  const argumentsForService = [
    {
      get: async () => ({
        repositories: [{ id: repositoryId, cloneUrl: 'https://example.test/demo.git' }],
        services: [{ id: serviceId, name: 'demo' }],
      }),
    },
    {
      readAnalysisContext: async (...args: unknown[]) => {
        calls.push(['source', ...args]);
        return { files, lockfiles: [], commitSha };
      },
    },
    {
      snapshot: async () => ({}),
      assertRead: () => {},
      assertRepository: () => {},
    },
    { resolve: async () => ({ apiKey: 'fake-provider-private-key' }) },
    {
      complete: async (...args: unknown[]) => {
        calls.push(['provider', ...args]);
        return { content: JSON.stringify(recipe) };
      },
    },
    { record: async () => {} },
  ] as unknown as ConstructorParameters<typeof AiExecutionGraphDraftService>;
  return { service: new AiExecutionGraphDraftService(...argumentsForService), calls };
}

test('AI graph proposal uses fixed repository evidence and compiles the reviewed parallel builds', async () => {
  const { service, calls } = fixture({
    name: '前后端部署',
    builds: [
      { directory: 'frontend', dockerfile: 'Dockerfile', composeVariable: 'VEYOPS_IMAGE_FRONTEND' },
      { directory: 'backend', dockerfile: 'Dockerfile', composeVariable: 'VEYOPS_IMAGE_BACKEND' },
    ],
    release: { method: 'COMPOSE', composePath: 'compose.yaml' },
  });
  const ref = { kind: 'BRANCH' as const, value: 'release' };
  const proposal = await service.propose(projectId, { repositoryId, serviceId, ref }, 'operator');
  assert.deepEqual(calls[0], [
    'source',
    projectId,
    repositoryId,
    { branch: 'release', commitSha: undefined },
  ]);
  const payload = JSON.stringify(calls[1]?.[2]);
  assert.match(payload, /frontend\/index\.html/);
  assert.match(payload, /DEPLOY\.md/);
  assert.match(payload, /\[REDACTED\]/);
  assert.doesNotMatch(payload, new RegExp(repoSecret));
  const start = proposal.canvas.nodes.find(({ id }) => id === proposal.startId)!;
  assert.equal(start.start?.execution, undefined);
  assert.deepEqual(start.start?.sources?.[0].ref, ref);
  start.start!.execution = { serverId };
  const [flow] = compileCanvas(proposal.canvas, true).flows;
  assert.equal(flow?.model, 'FLOW_V2');
  assert.ok(flow?.nodes.some(({ type }) => type === 'PARALLEL'));
  assert.ok(flow?.nodes.some(({ type }) => type === 'JOIN'));
  assert.deepEqual(start.start?.release?.imageIds, ['frontend', 'backend']);
  assert.ok(flow?.nodes.some(({ deploy }) => deploy?.method === 'COMPOSE'));
  assert.equal(proposal.commitSha, commitSha);
});

test('AI graph proposal rejects unknown repository selections and directories outside the evidence', async () => {
  const { service, calls } = fixture({ builds: [{ directory: 'invented', buildCommand: 'make' }] });
  await assert.rejects(
    service.propose(projectId, { repositoryId: serverId }, 'operator'),
    /当前项目/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    service.propose(projectId, { repositoryId }, 'operator'),
    /未生成可用的执行图/,
  );
});
