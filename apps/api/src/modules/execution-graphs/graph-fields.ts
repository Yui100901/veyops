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
import { graphRepositoryUrl } from '../projects/http-clone-url';
import { relativePath } from '../pipelines/pipeline.validation';
import { redactTaskLog } from '../tasks/task-log.service';
import type { GraphEdge, GraphFlow, GraphNode } from './execution-graph-definition';

export const graphIdFormat = /^[A-Za-z0-9_-]{1,64}$/;
export const graphReferenceFormat = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export const graphEnvironmentKeyFormat = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const graphArtifactTypes = ['FILE', 'DIRECTORY', 'DOCKER_IMAGE'] as const;
export const graphGitFetchModes = ['LATEST', 'FULL'] as const;
export type GraphGitFetchMode = (typeof graphGitFetchModes)[number];
export const graphMissingPolicies = ['ERROR', 'OMIT', 'USE_DEFAULT', 'REPOSITORY_DEFAULT'] as const;
export const graphFieldTypes = {
  TEXT: '文本',
  NUMBER: '数值',
  BOOLEAN: '布尔值',
  REPOSITORY: '项目仓库',
  GIT_REF: 'Git 版本',
  GIT_FETCH_MODE: '拉取方式',
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
export const graphValueProjections = [
  'WORKSPACE_PATH',
  'ARTIFACT_PATH',
  'IMAGE_NAME',
  'IMAGE_ID',
  'IMAGE_DIGEST',
] as const;
export type GraphValueProjection = (typeof graphValueProjections)[number];
export const graphScriptInputTypes: readonly GraphFieldType[] = [
  'TEXT',
  'NUMBER',
  'BOOLEAN',
  'GIT_FETCH_MODE',
  'PATH',
  'CREDENTIAL',
  'REPOSITORY',
  'GIT_REF',
  'ENVIRONMENT',
  'ENVIRONMENT_SET',
  'SERVICE',
  'TARGETS',
  'ARTIFACT',
  'IMAGE',
];
export const graphScriptOutputTypes: readonly GraphFieldType[] = [
  'TEXT',
  'NUMBER',
  'BOOLEAN',
  'GIT_FETCH_MODE',
  'PATH',
  'REPOSITORY',
  'SERVICE',
];

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
  declare acceptedTypes?: GraphFieldType[];
  declare acceptedArtifactTypes?: readonly GraphArtifactType[];
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
  | {
      kind: 'PROJECT_VALUE';
      projection: GraphValueProjection;
      source: { kind: 'OUTPUT'; nodeId: string; fieldId: string };
      serverId?: string;
    }
) & { onMissing?: GraphMissingPolicy };

export interface GraphDiagnostic {
  flowId?: string;
  nodeId?: string;
  fieldId?: string;
  sourceNodeId?: string;
  sourceFieldId?: string;
  branchId?: string;
  edge?: GraphEdge;
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
      return uuid(value) || Boolean(graphRepositoryUrl(value));
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
    case 'GIT_FETCH_MODE':
      return graphGitFetchModes.some((mode) => mode === value);
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

export function validateGraphField(
  field: GraphField,
  declaration: 'INPUT' | 'OUTPUT',
  functional = false,
) {
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
      !['TEXT', 'NUMBER', 'BOOLEAN', 'ENVIRONMENT_SET', 'GIT_FETCH_MODE'].includes(field.type) ||
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
    ((!functional && declaration !== 'INPUT') ||
      field.selection !== undefined ||
      !validateGraphValue({ ...field, required: true }, field.defaultValue) ||
      redactTaskLog(JSON.stringify(field.defaultValue)) !== JSON.stringify(field.defaultValue))
  )
    return '默认值不符合字段类型或与取值规则冲突';
  if (
    !functional &&
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
    case 'PROJECT_VALUE':
      return (
        graphValueProjections.includes(binding.projection as GraphValueProjection) &&
        graphRecord(binding.source) &&
        binding.source.kind === 'OUTPUT' &&
        validateGraphBinding(binding.source, depth + 1) &&
        (binding.serverId === undefined || uuid(binding.serverId)) &&
        keys.every((key) => ['kind', 'projection', 'source', 'serverId'].includes(key))
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

export function graphFieldArtifactTypes(
  field?: GraphField,
): readonly GraphArtifactType[] | undefined {
  if (field?.artifactType) return [field.artifactType];
  return field?.acceptedArtifactTypes;
}

export function compatibleGraphFields(input: GraphField, source: GraphField) {
  const expectedArtifacts = graphFieldArtifactTypes(input);
  const actualArtifacts = graphFieldArtifactTypes(source);
  return (
    (input.type === source.type || input.acceptedTypes?.includes(source.type) === true) &&
    (input.multiple === source.multiple ||
      (!input.multiple && !source.multiple) ||
      (input.type === 'ARTIFACT' && Boolean(input.multiple) && !source.multiple)) &&
    (!expectedArtifacts ||
      !actualArtifacts ||
      actualArtifacts.every((kind) => expectedArtifacts.includes(kind)))
  );
}

const field = (
  id: string,
  type: GraphFieldType,
  required = false,
  name: string = graphFieldTypes[type],
): GraphField => ({ id, name, type, required });

const preset = (
  id: string,
  type: GraphFieldType,
  referenceName: string,
  required?: boolean,
  name?: string,
): GraphField => ({ ...field(id, type, required, name), referenceName });

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
const artifactInput = field('artifact', 'ARTIFACT', true);
const reviewInput = field('review', 'REVIEW');
const releaseOutput = field('release', 'RELEASE', true);

interface ModulePorts {
  id: string;
  version: number;
  inputs: GraphField[];
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
    [
      preset('repository', 'REPOSITORY', 'GIT_REPOSITORY', true),
      preset('version', 'GIT_REF', 'GIT_VERSION', false, 'Git 版本（留空使用仓库默认分支）'),
      {
        ...field('fetchMode', 'GIT_FETCH_MODE', true),
        defaultValue: 'LATEST',
        options: [...graphGitFetchModes],
      },
    ],
    [
      preset('source', 'SOURCE', 'GIT_SOURCE', true),
      preset('workspace', 'WORKSPACE', 'CODE_DIR', true, '代码目录'),
      field('repositoryId', 'REPOSITORY', true, '实际仓库 ID'),
      field('repositoryName', 'TEXT', true, '实际仓库名称'),
      field('ref', 'TEXT', true, '实际 Git 引用'),
      field('branch', 'TEXT', false, '实际分支'),
      field('tag', 'TEXT', false, '实际标签'),
      preset('commitSha', 'TEXT', 'GIT_COMMIT_SHA', true, '实际 Git SHA'),
      preset('version', 'GIT_REF', 'GIT_VERSION', true, '实际提交版本'),
      field('fetchMode', 'GIT_FETCH_MODE', true, '实际拉取方式'),
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
    [field('artifact', 'ARTIFACT', true), allArtifacts],
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
    [artifactInput, reviewInput, ...serviceEnvTargets],
    [releaseOutput],
  ),
  ROLLBACK_ARTIFACT: modulePorts(
    'deploy.rollback',
    [artifactInput, reviewInput, field('afterRelease', 'RELEASE'), ...serviceEnvTargets],
    [releaseOutput],
  ),
  HEALTH_CHECK: modulePorts(
    'deploy.health',
    [field('release', 'RELEASE', true), field('targets', 'TARGETS')],
    [releaseOutput, field('status', 'TEXT', true), field('healthy', 'BOOLEAN', true)],
  ),
  SOURCE_REVIEW: modulePorts(
    'delivery.source-review',
    [field('source', 'SOURCE'), { ...artifactInput, multiple: true, required: false }],
    [field('review', 'REVIEW', true)],
  ),
  CONDITION: modulePorts(
    'control.condition',
    [branchValue],
    [field('matched', 'BOOLEAN', true, '是否匹配')],
  ),
  SWITCH: modulePorts(
    'control.switch',
    [branchValue],
    [field('matched', 'TEXT', true, '匹配的出口'), field('branchId', 'TEXT', true, '分支标识')],
  ),
  FLOW_CALL: modulePorts('control.call', [], []),
} satisfies Partial<Record<GraphNode['type'], ModulePorts>>;

export const graphCatalog = {
  fieldTypes: graphFieldTypes,
  scriptInputTypes: graphScriptInputTypes,
  scriptOutputTypes: graphScriptOutputTypes,
  missingPolicies: graphMissingPolicies,
  contextFields: graphContextFields,
  inputPresets: [
    preset('repository', 'REPOSITORY', 'GIT_REPOSITORY', true),
    preset('version', 'GIT_REF', 'GIT_VERSION', false, 'Git 版本（留空使用仓库默认分支）'),
    preset('fetchMode', 'GIT_FETCH_MODE', 'GIT_FETCH_MODE', false, 'Git 拉取方式'),
    preset('environment', 'ENVIRONMENT', 'PROJECT_ENVIRONMENT', true),
    preset('environmentSet', 'ENVIRONMENT_SET', 'ENVIRONMENT_SET', true),
    preset('service', 'SERVICE', 'PROJECT_SERVICE', true),
    preset('targets', 'TARGETS', 'TARGETS', true),
    preset('artifact', 'ARTIFACT', 'ARTIFACT', true, '输入构建产物'),
    { ...preset('artifacts', 'ARTIFACT', 'ARTIFACTS', true, '输入构建产物组'), multiple: true },
    preset('outputDir', 'PATH', 'ARTIFACT_DIR', false, '产物目录'),
    preset('image', 'IMAGE', 'IMAGE', true),
    preset('credential', 'CREDENTIAL', 'CREDENTIAL', true),
  ],
  outputPresets: [
    {
      ...preset('namedArtifact', 'ARTIFACT', 'ARTIFACT', true, '输出本次运行的单项产物'),
      source: 'CURRENT_RUN',
    },
    {
      ...preset('artifact', 'ARTIFACT', 'ARTIFACTS', true, '输出构建产物'),
      source: 'CURRENT_RUN',
      multiple: true,
    },
    {
      ...preset('systemArtifact', 'ARTIFACT', 'SYSTEM_ARTIFACTS', true, '输出系统产物'),
      multiple: true,
    },
    preset('service', 'SERVICE', 'PROJECT_SERVICE', true, '输出项目服务'),
    preset('release', 'RELEASE', 'RELEASE', true, '输出服务发布结果'),
    preset('source', 'SOURCE', 'SOURCE', true, '输出源码版本'),
    preset('report', 'REPORT', 'REPORT', true, '输出检查结果或报告'),
  ],
  modules: graphModules,
};

export function graphOperationPorts(
  node: GraphNode,
  calledFlow?: GraphFlow,
): ModulePorts | undefined {
  const definition = (graphModules as Partial<Record<GraphNode['type'], ModulePorts>>)[node.type];
  if (!definition) return undefined;
  if (node.type === 'SOURCE_REVIEW' && node.approval?.buildNodeId)
    return { ...definition, inputs: [] };
  if (node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT') {
    const method = node.deploy?.method;
    const acceptedArtifactTypes: readonly GraphArtifactType[] | undefined =
      method === 'COMPOSE'
        ? ['DOCKER_IMAGE']
        : method === 'FILE'
          ? ['FILE', 'DIRECTORY']
          : undefined;
    return {
      ...definition,
      inputs: definition.inputs.map((input) =>
        input.id === 'artifact' && acceptedArtifactTypes
          ? { ...input, acceptedArtifactTypes }
          : input,
      ),
    };
  }
  if (node.type === 'FLOW_CALL')
    return {
      ...definition,
      inputs: calledFlow?.nodes.find((candidate) => candidate.type === 'START')?.inputs ?? [],
      outputs: calledFlow?.nodes.find((candidate) => candidate.type === 'END')?.outputs ?? [],
    };
  if (node.type === 'SHELL' || node.type === 'CHECK')
    return {
      ...definition,
      outputs: definition.outputs.map((port) =>
        port.id === 'workspace' && node.shell?.location === 'MANAGER'
          ? { ...port, required: true }
          : port,
      ),
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
        ...artifacts.map(({ id, name, referenceName, type, required }) => ({
          ...field(id ?? name, 'ARTIFACT', required !== false, name),
          ...(referenceName && { referenceName }),
          artifactType: type,
        })),
      ],
    };
  if (node.type === 'BUILD' && node.build?.artifactType)
    return {
      ...definition,
      inputs,
      outputs: definition.outputs.map((output) => ({
        ...output,
        artifactType: node.build?.artifactType,
      })),
    };
  return { ...definition, inputs };
}

function scriptDeclarations(node: GraphNode, kind: 'inputs' | 'outputs'): GraphField[] {
  return (
    node[kind]?.map((field) => ({
      ...field,
      exportName: field.referenceName ?? field.id,
      required: true,
    })) ?? []
  );
}

export function graphScriptInputs(node: GraphNode): GraphField[] {
  if (node.type !== 'SHELL' && node.type !== 'CHECK') return [];
  if (!node.declaredPorts || node.inputs === undefined) return node.shell?.params ?? [];
  const native = new Set(shellInputs.map(({ id }) => id));
  return scriptDeclarations(node, 'inputs').filter(({ id }) => !native.has(id));
}

export function graphScriptOutputs(node: GraphNode): GraphField[] {
  if (node.type !== 'SHELL' && node.type !== 'CHECK') return [];
  if (!node.declaredPorts || node.outputs === undefined)
    return node.outputs ?? node.shell?.outputs ?? [];
  const native = new Set(shellOutputs.map(({ id }) => id));
  return scriptDeclarations(node, 'outputs').filter(({ id }) => !native.has(id));
}

function exposedPorts(standard: GraphField[], declared?: GraphField[]) {
  if (!declared) return standard;
  const byId = new Map(declared.map((field) => [field.id, field]));
  return standard.map((field) => {
    const declaration = byId.get(field.id);
    if (!declaration) return field;
    const { name, referenceName, defaultValue } = declaration;
    return {
      ...field,
      name,
      referenceName: referenceName ?? field.referenceName,
      ...(defaultValue !== undefined && { defaultValue }),
    };
  });
}

export function graphModulePorts(node: GraphNode, calledFlow?: GraphFlow): ModulePorts | undefined {
  const runtime =
    node.type === 'FUNCTION' && node.operation
      ? { ...node, type: node.operation, declaredPorts: true }
      : node;
  const ports = graphOperationPorts(runtime, calledFlow);
  if (!ports) return undefined;
  const inputs = [
    ...exposedPorts(ports.inputs, runtime.declaredPorts ? node.inputs : undefined),
    ...graphScriptInputs(runtime),
  ];
  return {
    ...ports,
    inputs: inputs.map((port) => {
      if (
        runtime.declaredPorts &&
        node.inputs?.some(({ id, defaultValue }) => id === port.id && defaultValue !== undefined)
      )
        return port;
      if (Object.hasOwn(node.inputDefaults ?? {}, port.id))
        return { ...port, defaultValue: node.inputDefaults?.[port.id] };
      if (port.id === 'fetchMode' && runtime.type === 'CHECKOUT' && node.checkout?.fullClone)
        return { ...port, defaultValue: 'FULL' };
      return port;
    }),
    outputs: [
      ...exposedPorts(ports.outputs, runtime.declaredPorts ? node.outputs : undefined),
      ...graphScriptOutputs(runtime),
    ],
  };
}

export function graphNodeEnvironmentBindings(
  flow: GraphFlow,
  node: GraphNode,
): Record<string, GraphBinding> {
  return {
    ...Object.fromEntries(
      Object.entries(node.environmentDefaults ?? {}).map(([key, value]) => [
        key,
        { kind: 'VALUE' as const, value },
      ]),
    ),
    ...flow.environmentBindings?.[node.id],
  };
}

export function graphDefaultBinding(
  flow: GraphFlow,
  node: GraphNode,
  fieldId: string,
): GraphBinding | undefined {
  const declared = node.declaredPorts && node.inputs?.find(({ id }) => id === fieldId);
  if (declared && declared.defaultValue !== undefined)
    return { kind: 'VALUE', value: declared.defaultValue };
  if (Object.hasOwn(node.inputDefaults ?? {}, fieldId))
    return { kind: 'VALUE', value: node.inputDefaults?.[fieldId] };
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
  if (contextType && !(fieldId === 'targets' && node.type === 'HEALTH_CHECK')) {
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
