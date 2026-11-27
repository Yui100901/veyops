import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Allow } from 'class-validator';
import type { GraphCanvas, GraphEndpoint, GraphNode } from './execution-graph-definition';
import {
  graphArtifactTypes,
  type GraphArtifactType,
  type GraphBinding,
  type GraphField,
} from './graph-fields';

const legacyTemplates = [
  {
    id: 'MINIMAL_CI_CD',
    name: '最小构建并部署',
    description: '一次完成代码拉取、构建和部署。',
    operations: ['CHECKOUT', 'BUILD', 'DEPLOY_ARTIFACT'],
  },
  {
    id: 'CI_BUILD',
    name: '较完整的构建',
    description: '先检查与测试，通过后构建并留档。',
    operations: ['CHECKOUT', 'CHECK', 'BUILD'],
  },
  {
    id: 'CD_DEPLOY',
    name: '较完整的部署',
    description: '发布已有产物，部署前审批，部署后检查健康状态。',
    operations: ['APPROVAL', 'DEPLOY_ARTIFACT', 'HEALTH_CHECK'],
  },
] as const;

const simplifiedTemplates = [
  {
    id: 'MINIMAL_CI_CD',
    name: '最小构建并部署',
    description: '适合首次交付，也可以单独构建或部署已有产物。',
    build: ['CHECKOUT', 'BUILD'],
    release: ['DEPLOY_ARTIFACT'],
    requireRelease: 'ACTIVATED',
  },
  {
    id: 'COMPLETE_CI_CD',
    name: '较完整的构建并部署',
    description: '构建前检查与测试，发布前审批，部署后检查健康状态。',
    build: ['CHECKOUT', 'CHECK', 'BUILD'],
    release: ['APPROVAL', 'DEPLOY_ARTIFACT', 'HEALTH_CHECK'],
    requireRelease: 'HEALTHY',
  },
] as const;

type SimplifiedTemplate = (typeof simplifiedTemplates)[number];
type TemplateId = (typeof legacyTemplates)[number]['id'] | SimplifiedTemplate['id'];
type TemplateOperation =
  SimplifiedTemplate['build'][number] | SimplifiedTemplate['release'][number];

const labels: Record<TemplateOperation, string> = {
  CHECKOUT: '代码拉取',
  CHECK: '检查与测试',
  BUILD: '构建',
  APPROVAL: '发布审批',
  DEPLOY_ARTIFACT: '部署',
  HEALTH_CHECK: '发布健康检查',
};

const entryNames = { delivery: '构建并部署', build: '仅构建', release: '仅部署' };
const endNames = { build: '构建结束', release: '发布结束' };

export const simplifiedFlowTemplates = simplifiedTemplates.map((template) => {
  const build = template.build.map((operation) => labels[operation]);
  const release = template.release.map((operation) => labels[operation]);
  const steps = [entryNames.delivery, ...build, ...release, endNames.release];
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    steps,
    entries: [
      { name: entryNames.delivery, steps },
      { name: entryNames.build, steps: [entryNames.build, ...build, endNames.build] },
      { name: entryNames.release, steps: [entryNames.release, ...release, endNames.release] },
    ],
    artifactTypes: ['DIRECTORY', 'DOCKER_IMAGE'] as const,
  };
});

export class ExpandGraphTemplateDto {
  @Allow() templateId!: TemplateId;
  @Allow() artifactType?: GraphArtifactType;
  @Allow() model?: 'FLOW_V2';
}

function invalidTemplateField(path: keyof ExpandGraphTemplateDto, message: string): never {
  throw new BadRequestException({
    message,
    details: { fieldErrors: [{ path: [path], code: 'INVALID_VALUE', message }] },
  });
}

const primaryArtifactId = 'primaryArtifact';
const artifactFields = {
  FILE: { name: '构建文件', referenceName: 'BUILD_OUTPUT_FILE' },
  DIRECTORY: { name: '构建目录', referenceName: 'BUILD_OUTPUT_DIR' },
  DOCKER_IMAGE: { name: '构建镜像', referenceName: 'DOCKER_IMAGE' },
} satisfies Record<GraphArtifactType, { name: string; referenceName: string }>;

const input = (fieldId: string): GraphBinding => ({ kind: 'INPUT', fieldId });
const output = (node: GraphNode, fieldId: string): GraphBinding => ({
  kind: 'OUTPUT',
  nodeId: node.id,
  fieldId,
});

export function expandGraphTemplate(
  templateId: TemplateId,
  artifactType: GraphArtifactType = 'DIRECTORY',
  model?: 'FLOW_V2',
): { canvas: GraphCanvas; startId: string } {
  if (model !== undefined && model !== 'FLOW_V2')
    invalidTemplateField('model', '请选择有效的执行流定义');
  if (model === 'FLOW_V2') {
    const template = simplifiedTemplates.find(({ id }) => id === templateId);
    if (!template) invalidTemplateField('templateId', '请选择有效的流程模板');
    if (artifactType !== 'DIRECTORY' && artifactType !== 'DOCKER_IMAGE')
      invalidTemplateField('artifactType', '请选择目录或 Docker 镜像');
    return expandSimplifiedTemplate(template, artifactType);
  }
  const template = legacyTemplates.find(({ id }) => id === templateId);
  if (!template) invalidTemplateField('templateId', '请选择有效的流程模板');
  if (!graphArtifactTypes.includes(artifactType))
    invalidTemplateField('artifactType', '请选择文件、目录或 Docker 镜像');
  const startInputs: GraphField[] = [];
  const endOutputs: GraphField[] = [];
  const inputBindings: NonNullable<GraphEndpoint['inputBindings']> = {};
  const outputBindings: NonNullable<GraphEndpoint['outputBindings']> = {};
  const start: GraphNode = {
    id: `start-${randomUUID()}`,
    name: template.name,
    type: 'START',
    contract: 'PRESET',
    inputs: startInputs,
  };
  const end: GraphNode = {
    id: `end-${randomUUID()}`,
    name: '结束',
    type: 'END',
    outputs: endOutputs,
  };
  const byOperation = new Map<TemplateOperation, GraphNode>(
    template.operations.map((operation): [TemplateOperation, GraphNode] => [
      operation,
      { id: `node-${randomUUID()}`, name: labels[operation], type: 'FUNCTION', operation },
    ]),
  );
  const checkout = byOperation.get('CHECKOUT');
  const check = byOperation.get('CHECK');
  const build = byOperation.get('BUILD');
  const approve = byOperation.get('APPROVAL');
  const deploy = byOperation.get('DEPLOY_ARTIFACT');
  const health = byOperation.get('HEALTH_CHECK');
  const finish = (field: GraphField, binding: GraphBinding) => {
    endOutputs.push(field);
    outputBindings[field.id] = binding;
  };

  if (checkout) {
    startInputs.push(
      { id: 'repository', name: '项目仓库', type: 'REPOSITORY', required: true },
      { id: 'gitVersion', name: 'Git 版本', type: 'GIT_REF', required: false },
    );
  }

  const workspace = checkout && {
    workspace: output(checkout, 'workspace'),
    source: output(checkout, 'source'),
  };
  if (check && workspace) {
    check.shell = { timeout: 180 };
    inputBindings[check.id] = workspace;
  }

  // A service is optional for a standalone build and required when its artefact is deployed.
  startInputs.push({ id: 'service', name: '项目服务', type: 'SERVICE', required: Boolean(deploy) });
  if (build && workspace) {
    start.buildLocation = 'INHERIT';
    startInputs.push({
      id: 'buildTargets',
      name: '构建目标',
      type: 'TARGETS',
      required: false,
      purpose: 'BUILD_TARGETS',
    });
    build.build = {
      artifacts: [
        {
          id: primaryArtifactId,
          ...artifactFields[artifactType],
          type: artifactType,
          required: true,
          persist: true,
          ...(artifactType === 'DIRECTORY'
            ? { collection: 'WORK_DIRECTORY' as const }
            : { path: artifactType === 'DOCKER_IMAGE' ? 'Dockerfile' : '' }),
        },
      ],
    };
    inputBindings[build.id] = {
      ...workspace,
      targets: input('buildTargets'),
    };
    finish(
      {
        id: 'buildArtifact',
        ...artifactFields[artifactType],
        type: 'ARTIFACT',
        artifactType,
        source: 'CURRENT_RUN',
      },
      output(build, primaryArtifactId),
    );
  }
  if (check) finish({ id: 'report', name: '检查报告', type: 'REPORT' }, output(check, 'report'));

  if (deploy) {
    if (!build)
      startInputs.push({
        id: 'artifact',
        name: '部署产物',
        type: 'ARTIFACT',
        artifactType,
        required: true,
      });
    startInputs.push({
      id: 'releaseTargets',
      name: '发布目标',
      type: 'TARGETS',
      required: true,
      purpose: 'RELEASE_TARGETS',
    });
    deploy.deploy = {
      method: artifactType === 'DOCKER_IMAGE' ? 'COMPOSE' : 'FILE',
      ...(artifactType === 'DOCKER_IMAGE' && { composeSource: { kind: 'ARTIFACT' } }),
    };
    inputBindings[deploy.id] = {
      artifact: build ? output(build, primaryArtifactId) : input('artifact'),
    };
    if (approve) approve.approval = { releaseNodeId: deploy.id };
    if (health) {
      health.healthCheck = { timeoutSeconds: 30, requireHealthy: true };
      inputBindings[health.id] = { release: output(deploy, 'release') };
    }
    finish(
      { id: 'release', name: '发布结果', type: 'RELEASE' },
      output(health ?? deploy, 'release'),
    );
    if (health)
      finish({ id: 'healthStatus', name: '健康状态', type: 'TEXT' }, output(health, 'status'));
  }

  const nodes = [start, ...byOperation.values(), end].map((node, index) => ({
    ...node,
    position: { x: 48 + index * 244, y: 64 },
  }));
  return {
    startId: start.id,
    canvas: {
      nodes,
      edges: nodes.slice(1).map(({ id }, index) => ({ from: nodes[index]!.id, to: id })),
      endpoints: [{ startId: start.id, endId: end.id, inputBindings, outputBindings }],
      templates: [],
    },
  };
}

function expandSimplifiedTemplate(
  template: SimplifiedTemplate,
  artifactType: 'DIRECTORY' | 'DOCKER_IMAGE',
): { canvas: GraphCanvas; startId: string } {
  const image = artifactType === 'DOCKER_IMAGE';
  const column = (index: number) => 48 + index * 220;
  const start = (name: string, config: GraphNode['start'], x: number, y: number): GraphNode => ({
    id: `start-${randomUUID()}`,
    name,
    type: 'START',
    start: config,
    position: { x, y },
  });
  const buildInput = (): NonNullable<GraphNode['start']> => ({
    sources: [{ id: 'source' }],
  });
  const end = (
    name: string,
    x: number,
    y: number,
    requireRelease?: SimplifiedTemplate['requireRelease'],
  ): GraphNode => ({
    id: `end-${randomUUID()}`,
    name,
    type: 'END',
    position: { x, y },
    finish: {
      saveWorkspace: true,
      ...(image && { images: [{ id: 'app', name: 'app', source: 'BUILT_IN' }] }),
      ...(requireRelease && { requireRelease }),
    },
  });
  const action = (operation: TemplateOperation, index: number): GraphNode => ({
    id: `node-${randomUUID()}`,
    name: labels[operation],
    type: 'FUNCTION',
    operation,
    position: { x: column(index + 1), y: 148 },
    ...(operation === 'CHECK' && { shell: { timeout: 180 } }),
    ...(operation === 'BUILD' && image && { build: { dockerfilePath: 'Dockerfile' } }),
    ...(operation === 'DEPLOY_ARTIFACT' && { deploy: { method: image ? 'COMPOSE' : 'FILE' } }),
    ...(operation === 'HEALTH_CHECK' && {
      healthCheck: { timeoutSeconds: 30, requireHealthy: true },
    }),
  });
  const operations = [...template.build, ...template.release].map(action);
  const firstRelease = template.build.length;
  const deliveryStart = start(
    entryNames.delivery,
    {
      ...buildInput(),
      release: image ? { compose: { path: 'compose.yaml' }, imageId: 'app' } : {},
    },
    column(0),
    148,
  );
  const buildStart = start(entryNames.build, buildInput(), column(0), 292);
  const releaseStart = start(
    entryNames.release,
    { release: { artifactSource: 'RUN_PARAMETER' } },
    column(firstRelease),
    12,
  );
  const releaseEnd = end(
    endNames.release,
    column(operations.length + 1),
    148,
    template.requireRelease,
  );
  const buildEnd = end(endNames.build, column(firstRelease + 1), 292);
  const mainRoute = [deliveryStart, ...operations, releaseEnd];
  return {
    startId: deliveryStart.id,
    canvas: {
      model: 'FLOW_V2',
      nodes: [...mainRoute, buildStart, buildEnd, releaseStart],
      edges: [
        ...mainRoute.slice(1).map(({ id }, index) => ({ from: mainRoute[index]!.id, to: id })),
        { from: buildStart.id, to: operations[0]!.id },
        { from: operations[firstRelease - 1]!.id, to: buildEnd.id },
        { from: releaseStart.id, to: operations[firstRelease]!.id },
      ],
      endpoints: [
        { startId: deliveryStart.id, endId: releaseEnd.id },
        { startId: buildStart.id, endId: buildEnd.id },
        { startId: releaseStart.id, endId: releaseEnd.id },
      ],
      templates: [],
    },
  };
}
