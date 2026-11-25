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
  simplifiedSourceDirectory,
  validateSimplifiedSourceDirectories,
} from '../modules/execution-graphs/simplified-flow-definition';
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
          execution: { location: 'MANAGER' },
          release: {
            serviceId,
            targets: { serverIds: [serverId] },
            deployPath: '/srv/app',
            contentPath: 'app/dist/',
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
      ['SERVICE', serviceId, 'start.release.serviceId'],
      ['SERVER', serverId, 'start.release.targets'],
    ],
  );
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
  canvas.nodes[0]!.start!.release!.contentPath = '';
  assert.doesNotThrow(() => compileCanvas(canvas, false));
  assert.equal(canvasIssues(canvas)[0]?.fieldId, 'start.release.contentPath');
});

test('V2 computes safe repository directories and identifies overlapping roots', () => {
  const url = 'https://git.example.com/team/example.git';
  assert.equal(simplifiedSourceDirectory(url), 'example');
  assert.equal(simplifiedSourceDirectory(url, './parent/'), 'parent/example');
  assert.throws(() => simplifiedSourceDirectory(url, '../outside'), /路径/);
  assert.throws(() => simplifiedSourceDirectory(url, '.git/submodules'), /保留名称/);
  assert.throws(() => simplifiedSourceDirectory('https://git.example.com/foo%2fbar.git'), /安全/);
  const canvas = deployment();
  canvas.nodes[0]!.start!.sources!.push({
    id: 'second',
    repositoryId,
    parentDirectory: 'example/subdir',
  });
  const flow = compileCanvas(canvas, true).flows[0]!;
  assert.throws(
    () => validateSimplifiedSourceDirectories(flow, new Map([[repositoryId, url]])),
    /重名或相互包含/,
  );
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
