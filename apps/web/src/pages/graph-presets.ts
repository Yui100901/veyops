import type { ProjectDetail } from '../models';
import {
  effectiveNodeType,
  graphKey,
  graphNodeFamily,
  graphNodeLabels,
  isReleaseNode,
} from './execution-graph-definition';
import type {
  GraphArtifactOutput,
  GraphArtifactType,
  GraphBinding,
  GraphCanvas,
  GraphField,
  GraphNode,
  GraphOperation,
} from './execution-graph-definition';
import { presetReference } from './graph-field-presets';

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
    ...(type === 'CONDITION' && { condition: { key: 'input', value: 'yes' } }),
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

export const graphTemplates: { name: string; nodes: GraphNode['type'][] }[] = [
  { name: '检出源码并核对提交', nodes: ['CHECKOUT', 'SHELL'] },
  { name: '仅构建', nodes: ['CHECKOUT', 'BUILD'] },
  { name: '源码审核后构建', nodes: ['CHECKOUT', 'SOURCE_REVIEW', 'BUILD'] },
  { name: '构建并部署', nodes: ['CHECKOUT', 'BUILD', 'APPROVAL', 'DEPLOY_ARTIFACT'] },
  { name: '仅部署', nodes: ['APPROVAL', 'DEPLOY_ARTIFACT'] },
  { name: '按历史产物回滚', nodes: ['APPROVAL', 'ROLLBACK_ARTIFACT'] },
  { name: '审批后执行脚本', nodes: ['APPROVAL', 'SHELL'] },
];

export function primaryBuildArtifact(type: GraphArtifactType): GraphArtifactOutput {
  const [name, referenceName, path] = {
    FILE: ['构建文件', 'BUILD_OUTPUT_FILE', 'dist/app.tar.gz'],
    DIRECTORY: ['构建目录', 'BUILD_OUTPUT_DIR', 'dist'],
    DOCKER_IMAGE: ['构建镜像', 'DOCKER_IMAGE', 'Dockerfile'],
  }[type]!;
  return { id: 'primaryArtifact', name: name!, type, referenceName, path, required: true };
}

export function applyGraphPreset(
  canvas: GraphCanvas,
  start: GraphNode,
  types: GraphNode['type'][],
  project: ProjectDetail,
  artifactType: GraphArtifactType,
  latestCompatible = false,
): GraphCanvas {
  const endpoint = canvas.endpoints.find(({ startId }) => startId === start.id);
  const end = canvas.nodes.find(({ id }) => id === endpoint?.endId);
  const outgoing = canvas.edges.filter(({ from }) => from === start.id);
  if (!endpoint || !end || outgoing.length !== 1 || outgoing[0]?.to !== end.id) return canvas;

  const nodes = types.map((type) => makeNode(type, project));
  const checkout = nodes.find((node) => effectiveNodeType(node) === 'CHECKOUT');
  const script = nodes.find((node) => effectiveNodeType(node) === 'SHELL');
  const build = nodes.find((node) => effectiveNodeType(node) === 'BUILD');
  const review = nodes.find((node) => effectiveNodeType(node) === 'SOURCE_REVIEW');
  const approval = nodes.find((node) => effectiveNodeType(node) === 'APPROVAL');
  const deploy = nodes.find(isReleaseNode);
  const inputs = [...(start.inputs ?? [])];
  const outputs = [...(end.outputs ?? [])];
  const inputBindings = { ...endpoint.inputBindings };
  const outputBindings = { ...endpoint.outputBindings };
  const bind = (node: GraphNode, field: string, value: GraphBinding) => {
    inputBindings[node.id] = { ...inputBindings[node.id], [field]: value };
  };
  const declare = (
    fields: GraphField[],
    field: GraphField,
    occupied: (id: string) => boolean = () => false,
  ) => {
    const existing = fields.find(({ id }) => id === field.id);
    if (
      existing &&
      !occupied(existing.id) &&
      existing.type === field.type &&
      Boolean(existing.multiple) === Boolean(field.multiple) &&
      (existing.required !== false) === (field.required !== false) &&
      existing.artifactType === field.artifactType &&
      existing.source === field.source &&
      existing.selection === field.selection &&
      !existing.options?.length
    )
      return existing.id;
    const id = existing ? graphKey('field') : field.id;
    const base = presetReference(field);
    let referenceName = base;
    for (let suffix = 2; fields.some((item) => presetReference(item) === referenceName); suffix++)
      referenceName = base + '_' + suffix;
    fields.push({ ...field, id, referenceName });
    return id;
  };
  const input = (field: GraphField): GraphBinding => ({
    kind: 'INPUT',
    fieldId: declare(inputs, field),
  });
  const from = (node: GraphNode, fieldId: string): GraphBinding => ({
    kind: 'OUTPUT',
    nodeId: node.id,
    fieldId,
  });
  const output = (field: GraphField, node: GraphNode, port: string) => {
    const id = declare(outputs, field, (id) => Object.hasOwn(outputBindings, id));
    outputBindings[id] = from(node, port);
  };

  if (checkout) {
    const repository = project.repositories.length === 1 ? project.repositories[0] : undefined;
    bind(
      checkout,
      'repository',
      repository
        ? { kind: 'VALUE', value: repository.id }
        : input({ id: 'repository', name: '项目仓库', type: 'REPOSITORY', required: true }),
    );
    bind(checkout, 'version', {
      ...input({
        id: 'gitVersion',
        name: 'Git 版本',
        referenceName: 'GIT_VERSION',
        type: 'GIT_REF',
        required: false,
      }),
      onMissing: 'REPOSITORY_DEFAULT',
    });
  }
  if (script) {
    script.shell = { ...script.shell, location: 'MANAGER' };
    if (checkout) {
      bind(script, 'source', from(checkout, 'source'));
      bind(script, 'workspace', from(checkout, 'workspace'));
      script.shell.command = 'test -n "$VEYOPS_GIT_COMMIT_SHA"';
      output({ id: 'commit', name: '实际提交 SHA', type: 'TEXT' }, checkout, 'commitSha');
    } else {
      output({ id: 'exitCode', name: '退出码', type: 'NUMBER' }, script, 'exitCode');
    }
    output({ id: 'report', name: '执行报告', type: 'REPORT' }, script, 'report');
  }
  const service =
    (build || deploy) &&
    (endpoint.serviceId
      ? ({ kind: 'VALUE', value: endpoint.serviceId } as const)
      : input({ id: 'service', name: '项目服务', type: 'SERVICE', required: !!deploy }));
  if (build && checkout) {
    const primary = primaryBuildArtifact(artifactType);
    delete build.inputDefaults;
    build.build = { ...build.build, buildLocation: undefined, artifacts: [primary] };
    bind(build, 'workspace', from(checkout, 'workspace'));
    bind(build, 'source', from(checkout, 'source'));
    if (service) bind(build, 'service', service);
    bind(
      build,
      'targets',
      input({ id: 'buildTargets', name: '目标端构建服务器', type: 'TARGETS', required: false }),
    );
    if (review) {
      review.approval = { ...review.approval, buildNodeId: build.id };
      bind(build, 'review', from(review, 'review'));
    }
    output(
      {
        id: 'buildArtifact',
        name: primary.name,
        referenceName: primary.referenceName,
        type: 'ARTIFACT',
        artifactType,
        source: 'CURRENT_RUN',
      },
      build,
      primary.id!,
    );
  }
  if (deploy) {
    const rollback = effectiveNodeType(deploy) === 'ROLLBACK_ARTIFACT';
    deploy.deploy = {
      ...deploy.deploy,
      method: artifactType === 'DOCKER_IMAGE' ? 'COMPOSE' : 'FILE',
    };
    if (approval) approval.approval = { ...approval.approval, releaseNodeId: deploy.id };
    if (service) bind(deploy, 'service', service);
    bind(
      deploy,
      'targets',
      input({ id: 'releaseTargets', name: rollback ? '回滚目标' : '发布目标', type: 'TARGETS' }),
    );
    bind(
      deploy,
      'artifact',
      build
        ? from(build, 'primaryArtifact')
        : input({
            id: 'artifact',
            name: '历史构建产物',
            type: 'ARTIFACT',
            artifactType: artifactType === 'DOCKER_IMAGE' ? artifactType : undefined,
            selection: !rollback && latestCompatible ? 'LATEST_COMPATIBLE' : undefined,
          }),
    );
    output(
      { id: 'release', name: rollback ? '回滚结果' : '服务发布结果', type: 'RELEASE' },
      deploy,
      'release',
    );
  }

  // A required result introduced here must not alter another flow sharing this end node.
  const shared = canvas.endpoints.some(
    ({ startId, endId }) => endId === end.id && startId !== start.id,
  );
  const updatedEnd = shared
    ? {
        ...end,
        id: graphKey('end'),
        position: end.position && { ...end.position, y: end.position.y + 100 },
        outputs,
      }
    : { ...end, outputs };
  const path = [start.id, ...nodes.map(({ id }) => id), updatedEnd.id];
  const edgeSelections = { ...endpoint.edgeSelections };
  delete edgeSelections[start.id];
  return {
    ...canvas,
    nodes: [
      ...canvas.nodes.map((node) =>
        node.id === start.id ? { ...node, inputs } : node.id === updatedEnd.id ? updatedEnd : node,
      ),
      ...nodes,
      ...(shared ? [updatedEnd] : []),
    ],
    endpoints: canvas.endpoints.map((item) =>
      item.startId === start.id
        ? { ...item, endId: updatedEnd.id, inputBindings, outputBindings, edgeSelections }
        : item,
    ),
    edges: [
      ...canvas.edges.filter((edge) => edge !== outgoing[0]),
      ...path.slice(1).map((to, index) => ({ from: path[index]!, to })),
    ],
  };
}
