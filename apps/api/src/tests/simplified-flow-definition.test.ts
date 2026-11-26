import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  canvasIssues,
  compileCanvas,
  withDraftCanvas,
} from '../modules/execution-graphs/execution-graph-canvas';
import { SaveGraphDraftDto } from '../modules/execution-graphs/execution-graph-definition';
import type { GraphCanvas } from '../modules/execution-graphs/execution-graph-definition';
import {
  legacySimplifiedSourceDirectory,
  simplifiedSourceDirectory,
  simplifiedWorkspaceInput,
  validateSimplifiedSourceDirectories,
} from '../modules/execution-graphs/simplified-flow-definition';
import { GraphCompileError } from '../modules/execution-graphs/graph-fields';
import { graphResourceReferences } from '../modules/projects/project-resource-extraction';

const repositoryId = 'd408caad-b09a-4c8e-95a4-a74a44a60387';
const serviceId = 'ad122a9c-1026-43c2-a1f4-32b99ac5a40a';
const serverId = 'c225d607-01ed-46bf-9e43-4e1096ab165f';

function deployment(): GraphCanvas {
  return {
    model: 'FLOW_V2',
    nodes: [
      {
        id: 'start',
        name: '开始',
        type: 'START',
        start: {
          sources: [{ id: 'source', repositoryId }],
          execution: { serverId },
          release: {
            serviceId,
          },
        },
      },
      { id: 'checkout', name: '检出', type: 'FUNCTION', operation: 'CHECKOUT' },
      {
        id: 'build',
        name: '构建',
        type: 'FUNCTION',
        operation: 'BUILD',
        build: { repoPath: 'app', buildCommand: 'mkdir dist' },
      },
      {
        id: 'deploy',
        name: '部署',
        type: 'FUNCTION',
        operation: 'DEPLOY_ARTIFACT',
        deploy: { method: 'FILE' },
      },
      {
        id: 'end',
        name: '结果',
        type: 'END',
        finish: { saveWorkspace: true, requireRelease: 'ACTIVATED' },
      },
    ],
    edges: [
      { from: 'start', to: 'checkout' },
      { from: 'checkout', to: 'build' },
      { from: 'build', to: 'deploy' },
      { from: 'deploy', to: 'end' },
    ],
    endpoints: [{ startId: 'start', endId: 'end' }],
    templates: [],
  };
}

test('a V2 canvas publishes actions and resource references without generic bindings', () => {
  const accepted = plainToInstance(SaveGraphDraftDto, {
    expectedRevision: 1,
    definition: { canvas: deployment() },
  });
  assert.deepEqual(validateSync(accepted, { whitelist: true, forbidNonWhitelisted: true }), []);
  const graph = compileCanvas(accepted.definition.canvas!, true);
  const flow = graph.flows[0]!;
  assert.equal(flow.model, 'FLOW_V2');
  assert.equal(flow.compiled, undefined);
  assert.equal(flow.nodes[2]?.type, 'BUILD');
  assert.equal(flow.nodes[2]?.declaredPorts, undefined);
  assert.equal(flow.nodes[2]?.moduleId, undefined);
  const references = graphResourceReferences(graph, { state: 'RUNNABLE', sourceId: 'fixture' });
  assert.deepEqual(
    references.map(({ resourceType, resourceId, fieldId }) => [resourceType, resourceId, fieldId]),
    [
      ['REPOSITORY', repositoryId, 'start.sources.source.repositoryId'],
      ['SERVER', serverId, 'start.execution.serverId'],
      ['SERVICE', serviceId, 'start.release.serviceId'],
    ],
  );
});

test('a historical Compose-only route shares its end with a build without registering another image', () => {
  const canvas = deployment();
  const [start, , , deploy, end] = canvas.nodes;
  delete start!.start!.sources;
  start!.start!.release!.artifactSource = 'RUN_PARAMETER';
  deploy!.deploy = { method: 'COMPOSE' };
  end!.finish!.images = [{ id: 'image', name: 'fixture/image', source: 'BUILT_IN' }];
  canvas.nodes = [start!, deploy!, end!];
  canvas.edges = [
    { from: start!.id, to: deploy!.id },
    { from: deploy!.id, to: end!.id },
  ];

  assert.doesNotThrow(() => compileCanvas(canvas, true));
  start!.start!.release!.artifactId = '3e09e540-0d0b-41b8-96bc-98eb47fac029';
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'start.release.artifactSource');
  delete start!.start!.release!.artifactId;
  start!.start!.release!.compose = { path: 'compose.yaml' };
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'start.release.compose.sourceId');
});

test('parallel Docker builds publish a Compose group from two explicit image registrations', () => {
  const canvas = deployment();
  const [start, checkout, front, deploy, finish] = canvas.nodes;
  front!.build = { repoPath: 'app/front', dockerfilePath: 'Dockerfile' };
  const back = {
    id: 'build-back',
    name: '构建后端',
    type: 'FUNCTION' as const,
    operation: 'BUILD' as const,
    build: { repoPath: 'app/back', dockerfilePath: 'Dockerfile' },
  };
  canvas.nodes.push(back);
  canvas.edges.push({ from: checkout!.id, to: back.id }, { from: back.id, to: deploy!.id });
  deploy!.deploy = { method: 'COMPOSE' };
  start!.start!.release!.imageIds = ['front', 'back'];
  start!.start!.release!.compose = { path: 'app/compose.yaml' };
  finish!.finish!.images = [
    { id: 'front', name: 'fixture/frontend', source: 'BUILT_IN', buildNodeId: front!.id },
    { id: 'back', name: 'fixture/backend', source: 'BUILT_IN', buildNodeId: back.id },
  ];
  assert.doesNotThrow(() => compileCanvas(canvas, true));

  delete finish!.finish!.images[1]!.buildNodeId;
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'finish.images.1.buildNodeId');
  finish!.finish!.images[1]!.buildNodeId = 'unrelated';
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'finish.images.1.buildNodeId');

  finish!.finish!.images[1]!.buildNodeId = back.id;
  start!.start!.release!.imageIds = ['front', 'missing'];
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'start.release.imageIds');
});

function existingCanvas(): GraphCanvas {
  return {
    nodes: [
      {
        id: 'old-start',
        name: '原开始',
        type: 'START',
        inputs: [{ id: 'name', name: '原参数', type: 'TEXT' }],
      },
      { id: 'old-log', name: '原日志', type: 'LOG', message: 'existing' },
      { id: 'old-end', name: '原结束', type: 'END' },
    ],
    edges: [
      { from: 'old-start', to: 'old-log' },
      { from: 'old-log', to: 'old-end' },
    ],
    endpoints: [{ startId: 'old-start', endId: 'old-end', serviceId }],
    templates: [
      {
        id: 'old-library',
        name: '原节点模板',
        type: 'FUNCTION',
        operation: 'CHECKOUT',
        inputDefaults: { repository: repositoryId },
      },
    ],
  };
}

function combinedCanvas(legacy = existingCanvas()): GraphCanvas {
  const added = deployment();
  return {
    nodes: [
      ...legacy.nodes,
      ...added.nodes.map((node) => ({ ...node, model: 'FLOW_V2' as const })),
    ],
    edges: [...legacy.edges, ...added.edges],
    endpoints: [...legacy.endpoints, ...added.endpoints],
    templates: [...legacy.templates, ...added.templates],
  };
}

test('an appended V2 chain preserves the legacy projection, resources, and draft nodes', () => {
  const legacy = existingCanvas();
  const old = compileCanvas(legacy, true);
  const mixed = combinedCanvas(legacy);
  const accepted = plainToInstance(SaveGraphDraftDto, {
    expectedRevision: 1,
    definition: { canvas: mixed },
  });
  assert.deepEqual(validateSync(accepted, { whitelist: true, forbidNonWhitelisted: true }), []);
  const published = compileCanvas(accepted.definition.canvas!, true);
  assert.deepEqual(JSON.parse(JSON.stringify(published.flows[0])), old.flows[0]);
  assert.equal(published.flows[1]?.model, 'FLOW_V2');
  assert.equal(published.flows[1]?.nodes[1]?.declaredPorts, undefined);
  assert.equal(published.canvas?.templates[0]?.inputDefaults?.repository, repositoryId);

  const references = graphResourceReferences(published, { state: 'RUNNABLE', sourceId: 'mixed' });
  assert.ok(
    references.some(
      (reference) =>
        reference.flowId === 'old-start' &&
        reference.resourceType === 'SERVICE' &&
        reference.resourceId === serviceId,
    ),
  );
  assert.ok(
    references.some(
      (reference) =>
        reference.flowId === 'start' &&
        reference.resourceType === 'REPOSITORY' &&
        reference.resourceId === repositoryId,
    ),
  );

  mixed.endpoints.pop();
  const draft = compileCanvas(mixed, false);
  const draftReferences = graphResourceReferences(draft, { state: 'DRAFT', sourceId: 'mixed' });
  assert.ok(
    draftReferences.some(
      (reference) =>
        reference.nodeId === 'start' &&
        reference.resourceType === 'REPOSITORY' &&
        reference.resourceId === repositoryId,
    ),
  );
});

test('mixed canvases reject cross-model links and legacy fields on new V2 nodes', () => {
  const mixed = combinedCanvas();
  const edge = { from: 'old-log', to: 'checkout' };
  mixed.edges.push(edge);
  assert.deepEqual(canvasIssues(mixed)[0]?.edge, edge);
  mixed.edges.pop();

  mixed.endpoints[0]!.endId = 'end';
  assert.equal(canvasIssues(mixed)[0]?.nodeId, 'old-start');
  mixed.endpoints[0]!.endId = 'old-end';

  mixed.nodes.find(({ id }) => id === 'checkout')!.inputs = [];
  assert.equal(canvasIssues(mixed)[0]?.fieldId, 'inputs');
  delete mixed.nodes.find(({ id }) => id === 'checkout')!.inputs;

  mixed.nodes[1] = { id: 'old-log', name: '调用', type: 'FLOW_CALL', flowId: 'start' };
  assert.match(canvasIssues(mixed)[0]!.message, /相同编排类型/);
});

test('older flow-only drafts preserve endpoint settings and remap references when converted', () => {
  const legacy = existingCanvas();
  const flow = {
    id: 'old-log',
    name: '原流程',
    nodes: legacy.nodes,
    edges: legacy.edges,
    serviceId,
    inputBindings: {
      'old-log': { source: { kind: 'OUTPUT' as const, nodeId: 'old-start', fieldId: 'name' } },
    },
    environmentBindings: { 'old-end': { SETTING: { kind: 'INPUT' as const, fieldId: 'name' } } },
    outputBindings: {
      result: {
        kind: 'FIRST_AVAILABLE' as const,
        sources: [{ kind: 'OUTPUT' as const, nodeId: 'old-log', fieldId: 'result' }],
      },
    },
    edgeSelections: { 'old-start': ['old-log'], 'old-log': ['old-end'] },
  };
  const { canvas } = withDraftCanvas({ flows: [flow] });
  const newActionId = canvas.nodes[1]!.id;
  assert.notEqual(newActionId, 'old-log');
  assert.deepEqual(canvas.endpoints[0], {
    startId: flow.id,
    endId: 'old-end',
    serviceId,
    inputBindings: {
      [newActionId]: { source: { kind: 'OUTPUT', nodeId: flow.id, fieldId: 'name' } },
    },
    environmentBindings: flow.environmentBindings,
    outputBindings: {
      result: {
        kind: 'FIRST_AVAILABLE',
        sources: [{ kind: 'OUTPUT', nodeId: newActionId, fieldId: 'result' }],
      },
    },
    edgeSelections: { [flow.id]: [newActionId], [newActionId]: ['old-end'] },
  });
});

test('V2 rejects legacy writes and still permits saving incomplete configurations', () => {
  const canvas = deployment();
  canvas.nodes[2]!.inputs = [];
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'inputs');
  assert.throws(() => compileCanvas(canvas, false), /旧字段/);
  delete canvas.nodes[2]!.inputs;
  canvas.endpoints[0]!.outputBindings = {};
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'outputBindings');
  delete canvas.endpoints[0]!.outputBindings;
  delete canvas.nodes[0]!.start!.release!.serviceId;
  assert.doesNotThrow(() => compileCanvas(canvas, false));
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'start.release.serviceId');
});

test('V2 computes safe repository roots and diagnoses every colliding source row', () => {
  const url = 'https://git.example.com/team/example.git';
  assert.equal(simplifiedSourceDirectory(url), 'example');
  assert.equal(legacySimplifiedSourceDirectory(url, './parent/'), 'parent/example');
  assert.throws(() => legacySimplifiedSourceDirectory(url, '../outside'), /路径/);
  assert.throws(() => legacySimplifiedSourceDirectory(url, '.git/submodules'), /保留名称/);
  assert.throws(() => simplifiedSourceDirectory('https://git.example.com/foo%2fbar.git'), /安全/);
  const canvas = deployment();
  canvas.nodes[0]!.start!.sources!.push({
    id: 'second',
    repositoryId,
  });
  const flow = compileCanvas(canvas, true).flows[0]!;
  assert.throws(
    () => validateSimplifiedSourceDirectories(flow, new Map([[repositoryId, url]])),
    (error) =>
      error instanceof GraphCompileError &&
      error.issues.map(({ fieldId }) => fieldId).join(',') ===
        'start.sources.source.repositoryId,start.sources.second.repositoryId',
  );
});

test('V2 rejects superseded start fields and permits a history-only build path', () => {
  const old = deployment();
  Object.assign(old.nodes[0]!.start!.sources![0]!, {
    parentDirectory: 'nested',
    allowRefOverride: true,
  });
  Object.assign(old.nodes[0]!.start!.release!, { reuseExecutionServer: true, contentPath: 'dist' });
  const input = plainToInstance(SaveGraphDraftDto, {
    expectedRevision: 1,
    definition: { canvas: old },
  });
  const problems = JSON.stringify(
    validateSync(input, { whitelist: true, forbidNonWhitelisted: true }),
  );
  for (const key of ['parentDirectory', 'allowRefOverride', 'reuseExecutionServer', 'contentPath'])
    assert.match(problems, new RegExp('property ' + key + ' should not exist'));

  const canvas = deployment();
  delete canvas.nodes[0]!.start!.sources;
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'start.sources');
  delete canvas.nodes[0]!.start!.release;
  delete canvas.nodes.find(({ id }) => id === 'end')!.finish!.requireRelease;
  canvas.nodes = canvas.nodes.filter(({ id }) => id !== 'deploy');
  canvas.edges = canvas.edges.filter(({ from, to }) => from !== 'deploy' && to !== 'deploy');
  canvas.edges.push({ from: 'build', to: 'end' });
  const [flow] = compileCanvas(canvas, true).flows;
  assert.equal(simplifiedWorkspaceInput(flow!)?.required, true);
});

test('V2 requires an explicit order between snapshot creation and parallel writes', () => {
  const canvas = deployment();
  canvas.nodes.push({
    id: 'write',
    name: '写入文件',
    type: 'FUNCTION',
    operation: 'SHELL',
    shell: { command: 'touch ready' },
  });
  canvas.edges.push({ from: 'checkout', to: 'write' }, { from: 'write', to: 'end' });
  assert.equal(canvasIssues(canvas)[0]?.nodeId, 'write');
  canvas.edges.at(-1)!.to = 'deploy';
  assert.deepEqual(canvasIssues(canvas), []);
});
