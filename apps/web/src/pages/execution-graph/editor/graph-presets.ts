import { placeFlowTemplate } from './ExecutionGraphCanvas';
import {
  effectiveNodeType,
  graphKey,
  graphNodeFamily,
  graphNodeLabels,
} from '../execution-graph-definition';
import { simplifiedModel, simplifiedNodeLabel } from '../simplified-flow';
import type {
  GraphArtifactOutput,
  GraphArtifactType,
  GraphCanvas,
  GraphFlowExpansion,
  GraphNode,
  GraphOperation,
} from '../execution-graph-definition';

export function makeNode(type: GraphNode['type'], model?: GraphCanvas['model']): GraphNode {
  const simple = model === simplifiedModel;
  const operation = type === 'FUNCTION' ? 'SHELL' : type;
  const name = simple ? simplifiedNodeLabel(operation) : graphNodeLabels[type];
  return authoredNode({
    id: graphKey('node'),
    type,
    name,
    ...(simple && { model }),
    ...(type === 'START' &&
      (simple
        ? { start: { execution: { location: 'INHERIT' as const } } }
        : { contract: 'PRESET' as const })),
    ...(simple && type === 'END' && { finish: {} }),
    ...(type === 'LOG' && { message: name }),
    ...(operation === 'SHELL' || operation === 'CHECK' ? { shell: { timeout: 180 } } : {}),
    ...(type === 'BUILD' && { build: {} }),
    ...(type === 'LOAD_ENV' ? { loadEnvironment: { required: true } } : {}),
    ...(type === 'DEPLOY_ARTIFACT' || type === 'ROLLBACK_ARTIFACT'
      ? { deploy: { method: 'FILE' as const } }
      : {}),
    ...(type === 'HEALTH_CHECK' ? { healthCheck: { command: '', timeoutSeconds: 30 } } : {}),
    ...(type === 'CONDITION' && { branch: { cases: [{ id: 'match', value: 'yes' }] } }),
    ...(type === 'SWITCH' && { switch: { key: 'input', cases: ['release'] } }),
    ...(type === 'DELAY' && { delaySeconds: 5 }),
    ...((type === 'APPROVAL' || type === 'SOURCE_REVIEW') && {
      approval: { timeoutSeconds: 3600 },
    }),
  });
}

export function authoredNode(node: GraphNode): GraphNode {
  if (graphNodeFamily(node) !== 'function') return node;
  return { ...node, type: 'FUNCTION', operation: effectiveNodeType(node) as GraphOperation };
}

export function primaryBuildArtifact(type: GraphArtifactType): GraphArtifactOutput {
  const [name, referenceName] = {
    FILE: ['构建文件', 'BUILD_OUTPUT_FILE'],
    DIRECTORY: ['构建目录', 'BUILD_OUTPUT_DIR'],
    DOCKER_IMAGE: ['构建镜像', 'DOCKER_IMAGE'],
  }[type]!;
  return {
    id: 'primaryArtifact',
    name: name!,
    type,
    referenceName,
    required: true,
    ...(type === 'DIRECTORY' && { collection: 'WORK_DIRECTORY' }),
  };
}

export function appendFlowTemplate(
  canvas: GraphCanvas,
  expansion: GraphFlowExpansion,
): GraphCanvas {
  const { canvas: fragment, startId } = expansion;
  if (canvas.model !== simplifiedModel || fragment.model !== simplifiedModel)
    throw new Error('请在简化执行图草稿中添加模板。');
  if (
    canvas.nodes.length + fragment.nodes.length > 500 ||
    canvas.edges.length + fragment.edges.length > 1500 ||
    canvas.endpoints.length + fragment.endpoints.length > 50 ||
    canvas.templates.length + fragment.templates.length > 100
  )
    throw new Error('草稿已接近容量上限，请移除不用的节点或执行流后重试。');
  const ids = [...canvas.nodes, ...canvas.templates, ...fragment.nodes, ...fragment.templates].map(
    ({ id }) => id,
  );
  if (new Set(ids).size !== ids.length) throw new Error('生成的节点 ID 与草稿重复，请重新插入。');
  const start = fragment.nodes.find(({ id, type }) => id === startId && type === 'START');
  if (!start || !fragment.endpoints.some(({ startId: id }) => id === startId))
    throw new Error('模板缺少开始与结束配对，请重新插入。');

  const names = new Set(
    canvas.nodes.filter(({ type }) => type === 'START').map(({ name }) => name),
  );
  let name = start.name;
  for (let suffix = 2; names.has(name); suffix++) name = start.name + '（' + suffix + '）';
  const nodes = placeFlowTemplate(canvas, fragment);
  return {
    ...canvas,
    nodes: [
      ...canvas.nodes,
      ...nodes.map((node) => (node.id === startId ? { ...node, name } : node)),
    ],
    edges: [...canvas.edges, ...fragment.edges],
    endpoints: [...canvas.endpoints, ...fragment.endpoints],
    templates: [...canvas.templates, ...fragment.templates],
  };
}
