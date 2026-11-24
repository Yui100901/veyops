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

const templates = [
  {
    id: 'MINIMAL_CI_CD',
    name: '最小构建并部署',
    operations: ['CHECKOUT', 'BUILD', 'DEPLOY_ARTIFACT'],
  },
  {
    id: 'CI_BUILD',
    name: '较完整的构建',
    operations: ['CHECKOUT', 'CHECK', 'BUILD'],
  },
  {
    id: 'CD_DEPLOY',
    name: '较完整的部署',
    operations: ['APPROVAL', 'DEPLOY_ARTIFACT', 'HEALTH_CHECK'],
  },
] as const;

type TemplateId = (typeof templates)[number]['id'];
type TemplateOperation = (typeof templates)[number]['operations'][number];

const labels: Record<TemplateOperation, string> = {
  CHECKOUT: '代码拉取',
  CHECK: '检查与测试',
  BUILD: '构建',
  APPROVAL: '人工审批',
  DEPLOY_ARTIFACT: '部署',
  HEALTH_CHECK: '发布健康检查',
};

export const graphFlowTemplates = templates.map(({ id, name, operations }) => ({
  id,
  name,
  steps: ['开始', ...operations.map((operation) => labels[operation]), '结束'],
  artifactTypes: graphArtifactTypes,
}));

export class ExpandGraphTemplateDto {
  @Allow() templateId!: TemplateId;
  @Allow() artifactType?: GraphArtifactType;
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
): { canvas: GraphCanvas; startId: string } {
  const template = templates.find(({ id }) => id === templateId);
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
    inputBindings[checkout.id] = {
      repository: input('repository'),
      version: { ...input('gitVersion'), onMissing: 'REPOSITORY_DEFAULT' },
    };
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
          path: artifactType === 'DOCKER_IMAGE' ? 'Dockerfile' : '',
        },
      ],
    };
    inputBindings[build.id] = {
      ...workspace,
      service: input('service'),
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
      service: input('service'),
      targets: input('releaseTargets'),
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
