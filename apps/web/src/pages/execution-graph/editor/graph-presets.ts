import type { ProjectDetail } from '../../../models';
import { placeFlowTemplate } from './ExecutionGraphCanvas';
import {
  effectiveNodeType,
  graphKey,
  graphNodeFamily,
  graphNodeLabels,
} from '../execution-graph-definition';
import type {
  GraphArtifactOutput,
  GraphArtifactType,
  GraphCanvas,
  GraphFlowExpansion,
  GraphNode,
  GraphOperation,
} from '../execution-graph-definition';

export function makeNode(
  type: GraphNode['type'],
  project: ProjectDetail,
  preset = true,
): GraphNode {
  const name = graphNodeLabels[type];
  const operation = type === 'FUNCTION' ? 'SHELL' : type;
  const repo = project.repositories.length === 1 ? project.repositories[0] : undefined;
  return authoredNode({
    id: graphKey('node'),
    type,
    name,
    ...(type === 'LOG' && { message: name }),
    ...(operation === 'SHELL' || operation === 'CHECK'
      ? { shell: { location: 'MANAGER' as const, timeout: 180 } }
      : {}),
    ...(preset && type === 'BUILD' && repo && { inputDefaults: { repository: repo.id } }),
    ...(preset &&
      type === 'CHECKOUT' && {
        inputs: [
          {
            id: 'repository',
            name: '项目仓库',
            referenceName: 'GIT_REPOSITORY',
            type: 'REPOSITORY' as const,
            required: true,
            defaultValue: repo?.cloneUrl,
          },
          {
            id: 'fetchMode',
            name: '拉取方式',
            referenceName: 'GIT_FETCH_MODE',
            type: 'GIT_FETCH_MODE' as const,
            required: true,
            defaultValue: 'LATEST',
          },
        ],
        outputs: [
          {
            id: 'commitSha',
            name: '检出提交',
            referenceName: 'GIT_COMMIT_SHA',
            type: 'TEXT' as const,
            required: true,
          },
        ],
      }),
    ...(preset &&
      type === 'REGISTER_ARTIFACT' && {
        inputs: [
          {
            id: 'path',
            name: '产物目录',
            referenceName: 'ARTIFACT_DIR',
            type: 'PATH' as const,
            required: true,
            defaultValue: './dist',
          },
        ],
      }),
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
  return { id: 'primaryArtifact', name: name!, type, referenceName, required: true };
}

export function appendFlowTemplate(
  canvas: GraphCanvas,
  expansion: GraphFlowExpansion,
): GraphCanvas {
  const { canvas: fragment, startId } = expansion;
  if (
    canvas.nodes.length + fragment.nodes.length > 500 ||
    canvas.edges.length + fragment.edges.length > 1500 ||
    canvas.endpoints.length + fragment.endpoints.length > 50
  )
    throw new Error('草稿已接近容量上限，请移除不用的节点或执行流后重试。');
  const ids = [...canvas.nodes, ...canvas.templates, ...fragment.nodes].map(({ id }) => id);
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
  };
}
