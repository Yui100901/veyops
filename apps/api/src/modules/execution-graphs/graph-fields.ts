import { BadRequestException } from '@nestjs/common';
import {
  Allow,
  IsBoolean,
  IsIn,
  IsString,
  Length,
  Matches,
  ValidateIf,
  isUUID,
} from 'class-validator';
import { isGitBranchName } from '../projects/git-ref';
import { relativePath } from '../pipelines/pipeline.validation';
import { redactTaskLog } from '../tasks/task-log.service';
import type { GraphFlow, GraphNode } from './execution-graph-definition';

export const graphIdFormat = /^[A-Za-z0-9_-]{1,64}$/;
export const graphReferenceFormat = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const graphEnvironmentKeyFormat = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const graphArtifactTypes = ['FILE', 'DIRECTORY', 'DOCKER_IMAGE'] as const;
export const graphMissingPolicies = ['ERROR', 'OMIT', 'USE_DEFAULT', 'REPOSITORY_DEFAULT'] as const;
export const graphFieldTypes = {
  TEXT: '文本',
  NUMBER: '数值',
  BOOLEAN: '布尔值',
  REPOSITORY: '项目仓库',
  GIT_REF: 'Git 版本',
  ENVIRONMENT: '项目环境',
  ENVIRONMENT_SET: '环境变量集合',
  SERVICE: '项目服务',
  TARGETS: '服务器或分组',
  ARTIFACT: '构建产物',
  PATH: '工作区相对路径',
  IMAGE: '镜像地址',
  WORKSPACE: '运行工作区',
  SOURCE: '实际源码版本',
  RELEASE: '服务发布结果',
  REVIEW: '源码审核凭证',
  REPORT: '检查结果或报告',
  CREDENTIAL: '凭据引用',
  VARIABLES: '加载的环境变量',
} as const;

export type GraphFieldType = keyof typeof graphFieldTypes;
export type GraphArtifactType = (typeof graphArtifactTypes)[number];

export class GraphField {
  @Matches(graphIdFormat) id!: string;
  @IsString() @Length(1, 100) @Matches(/\S/) name!: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(graphReferenceFormat) referenceName?: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(graphReferenceFormat) exportName?: string;
  @IsIn(Object.keys(graphFieldTypes)) type!: GraphFieldType;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() required?: boolean;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() multiple?: boolean;
  @Allow() defaultValue?: unknown;
  @Allow() options?: unknown[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['LATEST_COMPATIBLE'])
  selection?: 'LATEST_COMPATIBLE';
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(graphArtifactTypes)
  artifactType?: GraphArtifactType;
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['CURRENT_RUN'])
  source?: 'CURRENT_RUN';
}

export type GraphMissingPolicy = (typeof graphMissingPolicies)[number];
export type GraphBinding = (
  | { kind: 'INPUT'; fieldId: string }
  | { kind: 'NODE_INPUT'; fieldId: string }
  | { kind: 'OUTPUT'; nodeId: string; fieldId: string }
  | { kind: 'CONTEXT'; fieldId: string }
  | { kind: 'VALUE'; value: unknown }
  | { kind: 'ENVIRONMENT_KEY'; key: string }
  | { kind: 'CREDENTIAL'; credentialId: string }
  | { kind: 'FIRST_AVAILABLE'; sources: GraphBinding[] }
  | { kind: 'AS_GIT_REF'; refKind: 'BRANCH' | 'TAG'; source: GraphBinding }
) & { onMissing?: GraphMissingPolicy };

export interface GraphDiagnostic {
  flowId?: string;
  nodeId?: string;
  fieldId?: string;
  sourceNodeId?: string;
  sourceFieldId?: string;
  branchId?: string;
  severity?: 'ERROR' | 'WARNING';
  message: string;
}

export class GraphCompileError extends BadRequestException {
  constructor(
    readonly issue: GraphDiagnostic,
    readonly issues = [issue],
  ) {
    super(issue.message);
  }
}

export function safeGraphId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    graphIdFormat.test(value) &&
    !['__proto__', 'prototype', 'constructor'].includes(value)
  );
}

export function safeGraphReference(value: unknown): value is string {
  return typeof value === 'string' && graphReferenceFormat.test(value) && safeGraphId(value);
}

export function safeGraphEnvironmentKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    graphEnvironmentKeyFormat.test(value) &&
    safeGraphId(value) &&
    !/^VEYOPS_/i.test(value)
  );
}

export function graphRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && isUUID(value);
}

function sha(value: unknown) {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function path(value: unknown) {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\0')) return false;
  try {
    relativePath(value);
    return value.length > 0;
  } catch {
    return false;
  }
}

function scalar(field: GraphField, value: unknown): boolean {
  switch (field.type) {
    case 'TEXT':
      return typeof value === 'string' && value.length <= 65_536 && !value.includes('\0');
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value);
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'REPOSITORY':
    case 'ENVIRONMENT':
    case 'ENVIRONMENT_SET':
    case 'CREDENTIAL':
      return uuid(value);
    case 'SERVICE':
      return (
        uuid(value) ||
        (graphRecord(value) && Object.keys(value).length === 1 && uuid(value.serviceId))
      );
    case 'GIT_REF':
      return (
        graphRecord(value) &&
        typeof value.value === 'string' &&
        (value.kind === 'COMMIT'
          ? sha(value.value)
          : (value.kind === 'BRANCH' || value.kind === 'TAG') && isGitBranchName(value.value))
      );
    case 'PATH':
      return path(value);
    case 'IMAGE':
      return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 512 &&
        /^[A-Za-z0-9][A-Za-z0-9.:/@_-]*$/.test(value)
      );
    case 'TARGETS':
      return (
        graphRecord(value) &&
        ['serverIds', 'groupIds'].every(
          (key) =>
            value[key] === undefined ||
            (Array.isArray(value[key]) &&
              value[key].length <= 100 &&
              value[key].every(uuid) &&
              new Set(value[key]).size === value[key].length),
        ) &&
        Boolean(
          (Array.isArray(value.serverIds) && value.serverIds.length) ||
          (Array.isArray(value.groupIds) && value.groupIds.length),
        ) &&
        (value.strategy === undefined ||
          ['SEQUENTIAL', 'PARALLEL'].includes(String(value.strategy))) &&
        (value.failurePolicy === undefined ||
          ['STOP', 'CONTINUE'].includes(String(value.failurePolicy))) &&
        (value.maxParallel === undefined ||
          (typeof value.maxParallel === 'number' &&
            Number.isInteger(value.maxParallel) &&
            value.maxParallel >= 1 &&
            value.maxParallel <= 100)) &&
        Object.keys(value).every((key) =>
          ['serverIds', 'groupIds', 'strategy', 'failurePolicy', 'maxParallel'].includes(key),
        )
      );
    case 'ARTIFACT':
      return (
        uuid(value) ||
        (graphRecord(value) &&
          ((uuid(value.temporaryArtifactId) &&
            value.artifactId === undefined &&
            value.instanceId === undefined &&
            value.id === undefined) ||
            (uuid(value.artifactId ?? value.id) &&
              value.temporaryArtifactId === undefined &&
              (value.artifactId === undefined ||
                value.id === undefined ||
                value.artifactId === value.id ||
                value.instanceId === value.id) &&
              (value.instanceId === undefined || uuid(value.instanceId)) &&
              (value.checksum === undefined ||
                value.checksum === null ||
                typeof value.checksum === 'string'))))
      );
    case 'SOURCE':
      return graphRecord(value) && uuid(value.repositoryId) && sha(value.commitSha);
    case 'WORKSPACE':
    case 'RELEASE':
    case 'REPORT':
    case 'VARIABLES':
      return graphRecord(value);
    case 'REVIEW':
      return (
        graphRecord(value) &&
        uuid(value.runId) &&
        safeGraphId(value.nodeId) &&
        uuid(value.actorId) &&
        typeof value.hash === 'string' &&
        /^[a-f0-9]{64}$/.test(value.hash)
      );
  }
}

export function validateGraphValue(field: GraphField, value: unknown): boolean {
  if (value === undefined || value === null) return field.required === false;
  const values = field.multiple && Array.isArray(value) ? value : [value];
  if (field.multiple && !Array.isArray(value) && field.type !== 'ARTIFACT') return false;
  if (values.length > 100 || (values.length === 0 && field.required !== false)) return false;
  return values.every(
    (item) =>
      scalar(field, item) && (!field.options || field.options.some((option) => option === item)),
  );
}

export function validateGraphField(field: GraphField, declaration: 'INPUT' | 'OUTPUT') {
  if (
    !field ||
    !safeGraphId(field.id) ||
    !Object.hasOwn(graphFieldTypes, field.type) ||
    typeof field.name !== 'string' ||
    !field.name.trim() ||
    field.name.length > 100
  )
    return '字段名称、类型或标识无效';
  if (field.source && (declaration !== 'OUTPUT' || field.type !== 'ARTIFACT'))
    return '仅输出产物可以选择本次运行的来源约束';
  if (field.selection && (declaration !== 'INPUT' || field.type !== 'ARTIFACT'))
    return '仅产物输入可以使用最新兼容产物规则';
  if (declaration === 'OUTPUT' && field.type === 'CREDENTIAL') return '凭据引用仅可用于执行输入';
  if (
    field.artifactType &&
    (field.type !== 'ARTIFACT' || !graphArtifactTypes.includes(field.artifactType))
  )
    return '产物类型约束仅适用于产物字段';
  if (
    field.options &&
    (!Array.isArray(field.options) ||
      field.options.length > 100 ||
      !['TEXT', 'NUMBER', 'BOOLEAN', 'ENVIRONMENT_SET'].includes(field.type) ||
      field.options.some(
        (option) =>
          !scalar(field, option) ||
          (typeof option === 'string' && redactTaskLog(option) !== option),
      ) ||
      new Set(field.options).size !== field.options.length)
  )
    return '选项须为符合字段类型的不同值';
  if (field.referenceName !== undefined && !safeGraphReference(field.referenceName))
    return '字段引用名无效';
  if (field.exportName !== undefined && !safeGraphReference(field.exportName))
    return '字段导出名无效';
  if (
    field.defaultValue !== undefined &&
    (declaration !== 'INPUT' ||
      field.selection !== undefined ||
      !validateGraphValue({ ...field, required: true }, field.defaultValue) ||
      redactTaskLog(JSON.stringify(field.defaultValue)) !== JSON.stringify(field.defaultValue))
  )
    return '默认值不符合字段类型或与取值规则冲突';
  if (
    declaration === 'INPUT' &&
    ['WORKSPACE', 'SOURCE', 'RELEASE', 'REVIEW', 'REPORT', 'VARIABLES'].includes(field.type)
  )
    return '执行期间生成的数据须绑定上游模块输出';
  return undefined;
}

export function validateGraphBinding(binding: unknown, depth = 0): binding is GraphBinding {
  if (depth > 3 || !graphRecord(binding)) return false;
  const keys = Object.keys(binding).filter((key) => key !== 'onMissing');
  if (
    Object.hasOwn(binding, 'onMissing') &&
    (depth !== 0 || !graphMissingPolicies.includes(binding.onMissing as GraphMissingPolicy))
  )
    return false;
  switch (binding.kind) {
    case 'INPUT':
    case 'NODE_INPUT':
    case 'CONTEXT':
      return safeGraphId(binding.fieldId) && keys.length === 2;
    case 'OUTPUT':
      return safeGraphId(binding.nodeId) && safeGraphId(binding.fieldId) && keys.length === 3;
    case 'VALUE':
      return Object.hasOwn(binding, 'value') && keys.length === 2;
    case 'ENVIRONMENT_KEY':
      return safeGraphEnvironmentKey(binding.key) && keys.length === 2;
    case 'CREDENTIAL':
      return uuid(binding.credentialId) && keys.length === 2;
    case 'AS_GIT_REF':
      return (
        (binding.refKind === 'BRANCH' || binding.refKind === 'TAG') &&
        validateGraphBinding(binding.source, depth + 1) &&
        keys.length === 3
      );
    case 'FIRST_AVAILABLE':
      return (
        Array.isArray(binding.sources) &&
        binding.sources.length >= 1 &&
        binding.sources.length <= 16 &&
        binding.sources.every((source) => validateGraphBinding(source, depth + 1)) &&
        keys.length === 2
      );
    default:
      return false;
  }
}

export function compatibleGraphFields(input: GraphField, source: GraphField) {
  return (
    input.type === source.type &&
    (input.multiple === source.multiple ||
      (!input.multiple && !source.multiple) ||
      (input.type === 'ARTIFACT' && Boolean(input.multiple) && !source.multiple)) &&
    (!input.artifactType || !source.artifactType || input.artifactType === source.artifactType)
  );
}

const field = (
  id: string,
  type: GraphFieldType,
  required = false,
  name: string = graphFieldTypes[type],
): GraphField => ({ id, name, type, required });

export const graphContextFields = [
  field('projectId', 'TEXT', true, '项目 ID'),
  field('serviceId', 'SERVICE'),
  field('environmentId', 'ENVIRONMENT'),
  field('environmentSetId', 'ENVIRONMENT_SET'),
  field('triggeredAt', 'NUMBER', true, '触发时间'),
  field('triggerCommitSha', 'TEXT', false, '触发事件提交 SHA'),
];
const serviceEnvTargets = [
  field('service', 'SERVICE'),
  field('environment', 'ENVIRONMENT'),
  field('targets', 'TARGETS'),
];
const shellInputs = [
  field('workspace', 'WORKSPACE'),
  field('source', 'SOURCE'),
  field('service', 'SERVICE'),
  field('environment', 'ENVIRONMENT'),
  field('targets', 'TARGETS'),
  field('variables', 'VARIABLES'),
];
const shellOutputs = [
  field('exitCode', 'NUMBER', true, '退出码'),
  field('report', 'REPORT', true),
  field('workspace', 'WORKSPACE'),
];
const allArtifacts = { ...field('artifacts', 'ARTIFACT', true), multiple: true };
const artifactsInput = { ...field('artifact', 'ARTIFACT', true), multiple: true };
const reviewInput = field('review', 'REVIEW');
const releaseOutput = field('release', 'RELEASE', true);

interface ModulePorts {
  id: string;
  version: number;
  inputs: (GraphField & { acceptedTypes?: GraphFieldType[] })[];
  outputs: GraphField[];
}

const modulePorts = (
  id: string,
  inputs: ModulePorts['inputs'],
  outputs: GraphField[],
): ModulePorts => ({
  id,
  version: 1,
  inputs,
  outputs,
});
const branchValue = {
  ...field('value', 'TEXT'),
  acceptedTypes: ['TEXT', 'NUMBER', 'BOOLEAN'] as GraphFieldType[],
};
const graphModules = {
  CHECKOUT: modulePorts(
    'git.checkout',
    [field('repository', 'REPOSITORY', true), field('version', 'GIT_REF')],
    [
      field('source', 'SOURCE', true),
      field('workspace', 'WORKSPACE', true),
      field('repositoryId', 'REPOSITORY', true, '实际仓库 ID'),
      field('repositoryName', 'TEXT', true, '实际仓库名称'),
      field('ref', 'TEXT', true, '实际 Git 引用'),
      field('branch', 'TEXT', false, '实际分支'),
      field('tag', 'TEXT', false, '实际标签'),
      field('commitSha', 'TEXT', true, '实际 Git SHA'),
      field('subject', 'TEXT', false, '提交摘要'),
    ],
  ),
  LOAD_ENV: modulePorts(
    'environment.load',
    [
      field('workspace', 'WORKSPACE'),
      field('environment', 'ENVIRONMENT'),
      field('source', 'SOURCE'),
    ],
    [field('variables', 'VARIABLES', true)],
  ),
  SHELL: modulePorts('shell.run', shellInputs, shellOutputs),
  CHECK: modulePorts('shell.check', shellInputs, shellOutputs),
  BUILD: modulePorts(
    'delivery.build',
    [
      field('repository', 'REPOSITORY'),
      field('version', 'GIT_REF'),
      field('source', 'SOURCE'),
      field('workspace', 'WORKSPACE'),
      field('variables', 'VARIABLES'),
      reviewInput,
      ...serviceEnvTargets,
    ],
    [allArtifacts],
  ),
  REGISTER_ARTIFACT: modulePorts(
    'artifact.register',
    [
      field('workspace', 'WORKSPACE'),
      field('path', 'PATH'),
      field('image', 'IMAGE'),
      field('service', 'SERVICE'),
      field('environment', 'ENVIRONMENT'),
    ],
    [allArtifacts],
  ),
  DEPLOY_ARTIFACT: modulePorts(
    'deploy.artifact',
    [artifactsInput, reviewInput, ...serviceEnvTargets],
    [releaseOutput],
  ),
  ROLLBACK_ARTIFACT: modulePorts(
    'deploy.rollback',
    [artifactsInput, reviewInput, field('afterRelease', 'RELEASE'), ...serviceEnvTargets],
    [releaseOutput],
  ),
  HEALTH_CHECK: modulePorts(
    'deploy.health',
    [field('release', 'RELEASE', true)],
    [releaseOutput, field('status', 'TEXT', true), field('healthy', 'BOOLEAN', true)],
  ),
  SOURCE_REVIEW: modulePorts(
    'delivery.source-review',
    [field('source', 'SOURCE'), { ...artifactsInput, required: false }],
    [field('review', 'REVIEW', true)],
  ),
  CONDITION: modulePorts('control.condition', [branchValue], []),
  SWITCH: modulePorts('control.switch', [branchValue], []),
  FLOW_CALL: modulePorts('control.call', [], []),
} satisfies Partial<Record<GraphNode['type'], ModulePorts>>;

export const graphCatalog = {
  fieldTypes: graphFieldTypes,
  missingPolicies: graphMissingPolicies,
  contextFields: graphContextFields,
  inputPresets: [
    field('repository', 'REPOSITORY', true),
    field('version', 'GIT_REF'),
    field('environmentSet', 'ENVIRONMENT_SET', true),
    field('service', 'SERVICE', true),
    field('targets', 'TARGETS', true),
    field('artifact', 'ARTIFACT', true, '输入构建产物'),
    field('outputDir', 'PATH', false, '产物目录'),
    field('image', 'IMAGE', true),
  ],
  outputPresets: [
    {
      ...field('artifact', 'ARTIFACT', true, '输出构建产物'),
      source: 'CURRENT_RUN',
      multiple: true,
    },
    { ...field('systemArtifact', 'ARTIFACT', true, '输出系统产物'), multiple: true },
    field('release', 'RELEASE', true, '输出服务发布结果'),
    field('source', 'SOURCE', true, '输出源码版本'),
    field('report', 'REPORT', true, '输出检查结果或报告'),
  ],
  modules: graphModules,
};

export function graphModulePorts(node: GraphNode, calledFlow?: GraphFlow): ModulePorts | undefined {
  const definition = (graphModules as Partial<Record<GraphNode['type'], ModulePorts>>)[node.type];
  if (!definition) return undefined;
  if (node.type === 'SOURCE_REVIEW' && node.approval?.buildNodeId)
    return { ...definition, inputs: [] };
  if (node.type === 'FLOW_CALL')
    return {
      ...definition,
      inputs: calledFlow?.nodes.find((candidate) => candidate.type === 'START')?.inputs ?? [],
      outputs: calledFlow?.nodes.find((candidate) => candidate.type === 'END')?.outputs ?? [],
    };
  if (node.type === 'SHELL' || node.type === 'CHECK')
    return {
      ...definition,
      inputs: [...definition.inputs, ...(node.shell?.params ?? [])],
      outputs: [
        ...definition.outputs.map((port) =>
          port.id === 'workspace' && node.shell?.location === 'MANAGER'
            ? { ...port, required: true }
            : port,
        ),
        ...(node.outputs ?? node.shell?.outputs ?? []),
      ],
    };
  const artifacts =
    node.type === 'BUILD'
      ? node.build?.artifacts
      : node.type === 'REGISTER_ARTIFACT'
        ? node.registerArtifacts?.artifacts
        : undefined;
  const inputs =
    node.type === 'BUILD' && node.build?.dependencies?.length
      ? [
          ...definition.inputs,
          ...node.build.dependencies.map((alias) =>
            field('dependency_' + alias, 'WORKSPACE', true, '源码依赖 · ' + alias),
          ),
        ]
      : definition.inputs;
  if (artifacts?.length)
    return {
      ...definition,
      inputs,
      outputs: [
        { ...allArtifacts, required: artifacts.some((artifact) => artifact.required !== false) },
        ...artifacts.map(({ name, type, required }) => ({
          ...field(name, 'ARTIFACT', required !== false, name),
          artifactType: type,
          multiple: true,
        })),
      ],
    };
  return { ...definition, inputs };
}

export function graphDefaultBinding(
  flow: GraphFlow,
  node: GraphNode,
  fieldId: string,
): GraphBinding | undefined {
  if (fieldId === 'repository') {
    const repository = node.checkout?.repositoryId ?? node.build?.repositoryId;
    if (repository) return { kind: 'VALUE', value: repository };
  }
  if (fieldId === 'version') {
    const checkout = node.checkout;
    const ref =
      checkout?.mode === 'COMMIT'
        ? checkout.commitSha
        : checkout?.mode === 'TAG'
          ? checkout.tag
          : checkout?.branch;
    if (ref && checkout?.mode) return { kind: 'VALUE', value: { kind: checkout.mode, value: ref } };
    const fixed = node.build?.commitSha ?? node.build?.branch;
    if (fixed)
      return {
        kind: 'VALUE',
        value: {
          kind: node.build?.commitSha ? 'COMMIT' : 'BRANCH',
          value: fixed,
        },
      };
  }
  if (fieldId === 'service' && flow.serviceId) return { kind: 'VALUE', value: flow.serviceId };
  if (fieldId === 'targets' && node.shell?.serverId)
    return { kind: 'VALUE', value: { serverIds: [node.shell.serverId] } };
  const contextType = { service: 'SERVICE', environment: 'ENVIRONMENT', targets: 'TARGETS' }[
    fieldId
  ];
  if (contextType) {
    const candidates =
      flow.nodes
        .find((n) => n.type === 'START')
        ?.inputs?.filter((input) => input.type === contextType && !input.multiple) ?? [];
    if (candidates.length === 1) return { kind: 'INPUT', fieldId: candidates[0]!.id };
  }
  const port = graphModulePorts(node)?.inputs.find((item) => item.id === fieldId);
  if (port?.defaultValue !== undefined) return { kind: 'VALUE', value: port.defaultValue };
  return undefined;
}
