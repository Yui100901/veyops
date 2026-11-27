import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { posix } from 'node:path';
import { normalizeRelativePath } from '../pipelines/pipeline.validation';
import { isGitBranchName } from '../projects/git-ref';
import { httpCloneUrl } from '../projects/http-clone-url';
import { redactTaskLog } from '../tasks/task-log.service';
import type { GraphCanvas, GraphFlow, GraphNode } from './execution-graph-definition';
import { graphBranchPaths } from './graph-binding-validation';
import {
  GraphCompileError,
  safeGraphEnvironmentKey,
  type GraphDiagnostic,
  type GraphField,
} from './graph-fields';

const idFormat = /^[A-Za-z0-9_-]{1,64}$/;
const variableFormat = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;
const shaFormat = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export class SimplifiedGitRef {
  @IsIn(['BRANCH', 'TAG', 'COMMIT']) kind!: 'BRANCH' | 'TAG' | 'COMMIT';
  @IsString() @Length(1, 255) value!: string;
}

export class SimplifiedSource {
  @Matches(idFormat) id!: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() repositoryId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => SimplifiedGitRef)
  ref?: SimplifiedGitRef;
}

export class SimplifiedExecution {
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() serverId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  serverIds?: string[];
}

export function fixedFlowServerIds(execution?: SimplifiedExecution) {
  return execution?.serverIds ?? (execution?.serverId ? [execution.serverId] : []);
}

export type HistoricalSimplifiedExecution = SimplifiedExecution & {
  location?: 'INHERIT' | 'MANAGER' | 'TARGET';
  groupId?: string;
};

export type HistoricalSimplifiedRelease = SimplifiedRelease & {
  targets?: { serverIds?: string[]; groupIds?: string[] };
  contentPath?: string;
  reuseExecutionServer?: boolean;
};

export class SimplifiedComposeFile {
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) sourceId?: string;
  @IsString() @Length(1, 1024) path!: string;
}

export class SimplifiedRelease {
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() serviceId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() artifactId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsIn(['RUN_PARAMETER']) artifactSource?: 'RUN_PARAMETER';
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() useUpstreamArtifact?: boolean;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() allowArtifactOverride?: boolean;
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) imageId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @Matches(idFormat, { each: true })
  imageIds?: string[];
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(255) upstreamArtifactName?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => SimplifiedComposeFile)
  compose?: SimplifiedComposeFile;
}

export class SimplifiedVariable {
  @Matches(variableFormat) key!: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(65536) value?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() credentialId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() allowOverride?: boolean;
}

export class SimplifiedDotenv {
  @Matches(idFormat) sourceId!: string;
  @IsString() @Length(1, 1024) path!: string;
}

export class SimplifiedStart {
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => SimplifiedSource)
  sources?: SimplifiedSource[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => SimplifiedExecution)
  execution?: SimplifiedExecution;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => SimplifiedRelease)
  release?: SimplifiedRelease;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() environmentSetId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => SimplifiedVariable)
  variables?: SimplifiedVariable[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => SimplifiedDotenv)
  dotenv?: SimplifiedDotenv;
}

export class SimplifiedFinishImage {
  @Matches(idFormat) id!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsIn(['BUILT_IN', 'WORKSPACE', 'REGISTRY']) source!: 'BUILT_IN' | 'WORKSPACE' | 'REGISTRY';
  @ValidateIf((_o, v) => v !== undefined) @IsString() @Length(1, 512) reference?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() registryId?: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) buildNodeId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @Length(1, 1024) composePath?: string;
}

export class SimplifiedFinish {
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() saveWorkspace?: boolean;
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => SimplifiedFinishImage)
  images?: SimplifiedFinishImage[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['ACTIVATED', 'HEALTHY'])
  requireRelease?: 'ACTIVATED' | 'HEALTHY';
}

const imageComponent = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const imageHost = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?$/;

export function simplifiedImageName(value: string) {
  const name = value.trim().toLowerCase();
  const parts = name.split('/');
  return name.length <= 255 &&
    parts.every(
      (part, index) =>
        imageComponent.test(part) || (index === 0 && parts.length > 1 && imageHost.test(part)),
    )
    ? name
    : undefined;
}

export function simplifiedReleaseImages(
  finish: SimplifiedFinish,
  release: SimplifiedRelease,
): SimplifiedFinishImage[] {
  const images = finish.images ?? [];
  const ids = release.imageIds ?? (release.imageId ? [release.imageId] : []);
  if (!ids.length) return images.length === 1 ? images : [];
  const selected = ids.map((id) => images.find((image) => image.id === id));
  return selected.every((image): image is SimplifiedFinishImage => Boolean(image)) ? selected : [];
}

export function simplifiedComposeImageVariable(id: string) {
  return 'VEYOPS_IMAGE_' + id.toUpperCase().replaceAll('-', '_');
}

function dockerImageName(name: string) {
  const [first, ...rest] = name.split('/');
  const hasRegistry = rest.length && (first === 'localhost' || /[.:]/.test(first!));
  const host = hasRegistry ? (first === 'index.docker.io' ? 'docker.io' : first) : 'docker.io';
  const path = hasRegistry ? rest : [first, ...rest];
  return [host, ...(host === 'docker.io' && path.length === 1 ? ['library'] : []), ...path].join(
    '/',
  );
}

export function simplifiedRelativePath(path?: string) {
  return normalizeRelativePath(path?.trim() || '.');
}

export function simplifiedSourceDirectory(cloneUrl: string) {
  const safeUrl = new URL(httpCloneUrl(cloneUrl));
  let name: string;
  try {
    name = decodeURIComponent(safeUrl.pathname.replace(/\/+$/, '').split('/').at(-1) ?? '').replace(
      /\.git$/i,
      '',
    );
  } catch {
    throw new BadRequestException('无法从仓库地址生成检出目录');
  }
  if (!name.trim() || name === '.' || name.includes('/') || /^\.(git|veyops)$/i.test(name))
    throw new BadRequestException('无法从仓库地址生成安全的检出目录');
  return normalizeRelativePath(name);
}

export function legacySimplifiedSourceDirectory(cloneUrl: string, parentDirectory: string) {
  const parent = simplifiedRelativePath(parentDirectory);
  if (parent.split('/').some((part) => /^\.(git|veyops)$/i.test(part)))
    throw new BadRequestException('检出父目录包含 Git 或平台保留名称');
  return posix.join(parent, simplifiedSourceDirectory(cloneUrl));
}

export function simplifiedGitRefValid(ref: SimplifiedGitRef) {
  switch (ref.kind) {
    case 'COMMIT':
      return shaFormat.test(ref.value);
    case 'BRANCH':
    case 'TAG':
      return isGitBranchName(ref.value);
    default:
      return false;
  }
}

export function isSimplifiedCanvasNode(canvas: GraphCanvas, node?: GraphNode) {
  return (canvas.model ?? node?.model) === 'FLOW_V2';
}

const obsoleteFields = [
  'contract',
  'buildLocation',
  'sameHostRelease',
  'declaredPorts',
  'moduleId',
  'moduleVersion',
  'inputDefaults',
  'environmentDefaults',
  'inputs',
  'outputs',
  'environmentSet',
  'registerArtifacts',
  'loadEnvironment',
] as const;
const obsoleteActionFields = {
  checkout: ['repositoryId', 'mode', 'branch', 'tag', 'commitSha'],
  shell: ['serverId', 'location', 'params', 'outputs', 'artifacts', 'artifactPath'],
  build: [
    'repositoryId',
    'branch',
    'commitSha',
    'buildLocation',
    'buildImage',
    'artifactType',
    'outputPath',
    'artifacts',
    'registryId',
    'imageRepository',
    'dependencies',
  ],
  deploy: ['deployPath', 'artifactPath', 'composeSource'],
  approval: ['releaseNodeId', 'buildNodeId'],
} as const;

function nodeIssue(node: GraphNode, fieldId: string, message: string, flowId?: string): never {
  throw new GraphCompileError({
    flowId: flowId ?? (node.type === 'START' ? node.id : undefined),
    nodeId: node.id,
    fieldId,
    fieldSection: 'execution',
    severity: 'ERROR',
    message: `「${node.name}」 · ${message}`,
  });
}

export function validateSimplifiedCanvas(canvas: GraphCanvas) {
  for (const node of [...canvas.nodes, ...canvas.templates]) {
    if (!isSimplifiedCanvasNode(canvas, node)) continue;
    for (const field of obsoleteFields) {
      if (node[field] !== undefined)
        nodeIssue(node, field, '新流程使用开始配置和结尾核对规则，请移除旧字段');
    }
    for (const [section, fields] of Object.entries(obsoleteActionFields)) {
      const config = node[section as keyof typeof obsoleteActionFields];
      if (!config) continue;
      for (const field of fields)
        if (Reflect.get(config, field) !== undefined)
          nodeIssue(node, section + '.' + field, '请在开始节点配置运行资源，在结束节点配置交付');
    }
    if (node.start !== undefined && node.type !== 'START')
      nodeIssue(node, 'start', '仅开始节点可配置运行资源');
    if (node.finish !== undefined && node.type !== 'END')
      nodeIssue(node, 'finish', '仅结束节点可配置交付结果');
  }
  for (const endpoint of canvas.endpoints) {
    const start = canvas.nodes.find(({ id }) => id === endpoint.startId);
    if (!start || !isSimplifiedCanvasNode(canvas, start)) continue;
    for (const field of [
      'inputBindings',
      'outputBindings',
      'environmentBindings',
      'serviceId',
      'edgeSelections',
    ] as const) {
      if (endpoint[field] === undefined) continue;
      nodeIssue(start, field, '执行流通过控制连线决定步骤顺序，请移除旧绑定');
    }
  }
}

function safeRelative(node: GraphNode, id: string, value: string | undefined, flowId: string) {
  try {
    return simplifiedRelativePath(value);
  } catch {
    return nodeIssue(node, id, '请填写不含父级跳转的相对路径', flowId);
  }
}

export function validateSimplifiedSourceDirectories(
  flow: GraphFlow,
  repositoryUrls: ReadonlyMap<string, string>,
) {
  const start = flow.nodes.find(({ type }) => type === 'START')!;
  const directories = new Map<string, SimplifiedSource[]>();
  for (const source of start.start?.sources ?? []) {
    const url = source.repositoryId && repositoryUrls.get(source.repositoryId);
    if (!url) continue;
    let directory: string;
    try {
      directory = simplifiedSourceDirectory(url);
    } catch {
      nodeIssue(
        start,
        'start.sources.' + source.id + '.repositoryId',
        '无法生成安全的检出目录',
        flow.id,
      );
    }
    const key = directory.toLowerCase();
    directories.set(key, [...(directories.get(key) ?? []), source]);
  }
  const collisions = [...directories].flatMap(([directory, sources]): GraphDiagnostic[] =>
    sources.length < 2
      ? []
      : sources.map(({ id }) => ({
          flowId: flow.id,
          nodeId: start.id,
          fieldId: 'start.sources.' + id + '.repositoryId',
          fieldSection: 'execution',
          severity: 'ERROR',
          message: `「${start.name}」 · 源码目录「${directory}」重名，请选择不同的仓库`,
        })),
  );
  if (collisions.length) throw new GraphCompileError(collisions[0]!, collisions);
}

const workspaceActions = new Set(['CHECKOUT', 'SHELL', 'CHECK', 'BUILD']);

export function simplifiedUsesWorkspace(nodes: readonly GraphNode[]) {
  return nodes.some(({ type }) => workspaceActions.has(type));
}

export function simplifiedWorkspaceInput(flow: GraphFlow): GraphField | undefined {
  if (
    flow.model !== 'FLOW_V2' ||
    flow.nodes.some(({ type }) =>
      ['DEPLOY_ARTIFACT', 'ROLLBACK_ARTIFACT', 'SOURCE_REVIEW'].includes(type),
    ) ||
    !flow.nodes.some(({ type }) => ['BUILD', 'SHELL', 'CHECK'].includes(type))
  )
    return undefined;
  const start = flow.nodes.find(({ type }) => type === 'START');
  return {
    id: 'workspaceArtifactId',
    name: '历史目录',
    type: 'ARTIFACT',
    required: flow.nodes.some(({ type }) => type === 'CHECKOUT') && !start?.start?.sources?.length,
    acceptedArtifactTypes: ['DIRECTORY'],
  };
}

export function simplifiedEffectiveFinish(
  nodes: readonly GraphNode[],
  finish: SimplifiedFinish,
  usesExistingArtifact: boolean,
): SimplifiedFinish {
  return usesExistingArtifact && !simplifiedUsesWorkspace(nodes)
    ? { saveWorkspace: false, requireRelease: finish.requireRelease }
    : finish;
}

export function simplifiedTriggerArtifactInput(flow?: GraphFlow): GraphField | undefined {
  if (
    flow?.model !== 'FLOW_V2' ||
    flow.nodes.find(({ type }) => type === 'START')?.start?.release?.artifactSource !==
      'RUN_PARAMETER'
  )
    return undefined;
  return { id: 'artifactId', name: '发布产物', type: 'ARTIFACT', required: true };
}
const simpleActions = new Set([
  'START',
  'END',
  'CHECKOUT',
  'SHELL',
  'CHECK',
  'BUILD',
  'DEPLOY_ARTIFACT',
  'ROLLBACK_ARTIFACT',
  'APPROVAL',
  'SOURCE_REVIEW',
  'HEALTH_CHECK',
  'LOG',
  'DELAY',
  'CONDITION',
  'SWITCH',
  'PARALLEL',
  'JOIN',
]);

export function validateSimplifiedFlow(flow: GraphFlow, ordered: GraphNode[]) {
  const start = ordered[0]!;
  const finish = ordered.at(-1)!;
  const config = start.start ?? {};
  const report = (id: string, message: string) => nodeIssue(start, id, message, flow.id);
  const sources = config.sources ?? [];
  const sourceIds = new Set<string>();
  for (const source of sources) {
    if (sourceIds.has(source.id)) report('start.sources.' + source.id, '源码标识不能重复');
    sourceIds.add(source.id);
    if (!source.repositoryId)
      report('start.sources.' + source.id + '.repositoryId', '请选择项目仓库');
    if (source.ref && !simplifiedGitRefValid(source.ref))
      report('start.sources.' + source.id + '.ref', '请选择有效的分支、标签或完整提交 SHA');
  }
  const checkouts = ordered.filter(({ type }) => type === 'CHECKOUT');
  if (checkouts.length && !sources.length && !simplifiedWorkspaceInput(flow)?.required)
    report('start.sources', '请配置代码拉取使用的项目仓库');
  if (checkouts.length > 1)
    nodeIssue(
      checkouts[1]!,
      'operation',
      '一次运行只需一个代码拉取动作，它会检出开始节点配置的仓库',
      flow.id,
    );
  if (sources.length && !checkouts.length)
    report('start.sources', '请添加代码拉取动作以检出配置的仓库');

  const keys = new Set<string>();
  for (const { key, value, credentialId, allowOverride } of config.variables ?? []) {
    if (!safeGraphEnvironmentKey(key) || keys.has(key))
      report('start.variables.' + key, '变量名不合法、已保留或重复');
    if ((value === undefined) === (credentialId === undefined))
      report('start.variables.' + key, '请填写普通值或选择一项凭据');
    if ((value !== undefined && redactTaskLog(value) !== value) || (credentialId && allowOverride))
      report('start.variables.' + key, '敏感值须使用凭据引用，凭据变量不能接受运行时文本覆盖');
    keys.add(key);
  }
  if (config.dotenv) {
    if (!sourceIds.has(config.dotenv.sourceId))
      report('start.dotenv.sourceId', '请选择变量文件的源码项');
    if (safeRelative(start, 'start.dotenv.path', config.dotenv.path, flow.id) === '.')
      report('start.dotenv.path', '请填写变量文件路径');
  }

  const deploys = ordered.filter(
    ({ type }) => type === 'DEPLOY_ARTIFACT' || type === 'ROLLBACK_ARTIFACT',
  );
  const releaseConfig = config.release;
  const existingArtifact = Boolean(
    releaseConfig?.artifactId ||
    releaseConfig?.useUpstreamArtifact ||
    releaseConfig?.artifactSource === 'RUN_PARAMETER',
  );
  const activeFinish = simplifiedEffectiveFinish(ordered, finish.finish ?? {}, existingArtifact);
  if (deploys.length > 1)
    nodeIssue(deploys[1]!, 'operation', '一条流程配置一个受管发布动作', flow.id);
  if (!deploys.length) {
    for (const [field, value] of Object.entries(config.release ?? {})) {
      if (field !== 'serviceId' && value)
        report('start.release.' + field, '本流没有受管发布动作，请清除该发布配置');
    }
  }
  if (deploys.length) {
    const release = config.release;
    if (deploys[0]!.type === 'ROLLBACK_ARTIFACT' && !release?.artifactId)
      report('start.release.artifactId', '按产物回滚需要在开始节点指定曾成功发布的实例');
    if (!release?.serviceId) report('start.release.serviceId', '请选择发布的项目服务');
    if (
      release?.artifactSource === 'RUN_PARAMETER' &&
      (release.artifactId ||
        release.useUpstreamArtifact ||
        release.imageId ||
        release.imageIds?.length)
    )
      report('start.release.artifactSource', '运行时选择产物不能与其他产物来源同时设置');
    if (release?.useUpstreamArtifact && release.artifactId)
      report('start.release.artifactId', '请在固定历史产物与接收上游产物之间选择一种来源');
    if (release?.upstreamArtifactName && !release.useUpstreamArtifact)
      report('start.release.upstreamArtifactName', '选择接收上游产物后才可指定登记名称');
    if (release?.upstreamArtifactName && !simplifiedImageName(release.upstreamArtifactName))
      report('start.release.upstreamArtifactName', '请填写有效的上游产物登记名称');
    if (release?.imageId && release.imageIds?.length)
      report('start.release.imageIds', '请选择一组本次发布镜像');
    if (deploys[0]!.deploy?.method !== 'COMPOSE') {
      if (release?.imageId || release?.imageIds?.length)
        report('start.release.imageIds', '文件发布无需选择本次镜像');
    }
  }
  if (config.execution?.serverId && config.execution.serverIds)
    report('start.execution.serverId', '请使用一组固定执行服务器');
  if (config.execution?.serverIds?.length === 0)
    report('start.execution.serverId', '请至少选择一台固定执行服务器');
  if (activeFinish.requireRelease && !deploys.length)
    nodeIssue(finish, 'finish.requireRelease', '核对发布结果需要受管发布动作', flow.id);

  const dockerBuilds = ordered.filter(
    (node) => node.type === 'BUILD' && node.build?.dockerfilePath,
  );
  const imageIds = new Set<string>();
  const imageNames = new Set<string>();
  const images = activeFinish.images ?? [];
  for (const [index, image] of images.entries()) {
    const field = 'finish.images.' + index;
    const name = simplifiedImageName(image.name);
    const canonical = name && dockerImageName(name);
    if (!canonical || imageNames.has(canonical))
      nodeIssue(
        finish,
        field + '.name',
        '镜像名称无效或重复，请填写唯一的 Docker 仓库名称',
        flow.id,
      );
    if (imageIds.has(image.id)) nodeIssue(finish, field + '.id', '镜像登记项标识重复', flow.id);
    if (image.composePath) {
      safeRelative(finish, field + '.composePath', image.composePath, flow.id);
      if (!/\.ya?ml$/i.test(image.composePath) || !simplifiedUsesWorkspace(ordered))
        nodeIssue(
          finish,
          field + '.composePath',
          '请选择本次工作区内的 Compose YAML 文件',
          flow.id,
        );
    }
    if (image.source === 'BUILT_IN') {
      const producer = image.buildNodeId
        ? dockerBuilds.find(({ id }) => id === image.buildNodeId)
        : dockerBuilds.length === 1
          ? dockerBuilds[0]
          : undefined;
      if (!producer)
        nodeIssue(
          finish,
          field + '.buildNodeId',
          '请选择本流中产生该镜像的 Dockerfile 构建节点',
          flow.id,
        );
    } else if (image.buildNodeId) {
      nodeIssue(finish, field + '.buildNodeId', '只有内置 Dockerfile 镜像关联构建节点', flow.id);
    }
    if (
      image.source === 'WORKSPACE' &&
      !ordered.some(({ type }) => ['BUILD', 'SHELL', 'CHECK'].includes(type))
    )
      nodeIssue(finish, field + '.source', '请添加生成本次镜像的命令动作', flow.id);
    if (image.source === 'REGISTRY') {
      if (!image.registryId) nodeIssue(finish, field + '.registryId', '请选择镜像仓库', flow.id);
      if (!/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image.reference ?? ''))
        nodeIssue(
          finish,
          field + '.reference',
          '请填写含固定 Digest 的完整 Registry 引用',
          flow.id,
        );
    } else if (image.registryId || image.reference) {
      nodeIssue(finish, field + '.source', '本次构建镜像由登记名称和运行 Tag 生成引用', flow.id);
    }
    imageIds.add(image.id);
    imageNames.add(canonical);
  }
  const ancestors = new Map<string, Set<string>>();
  for (const node of ordered) {
    if (!simpleActions.has(node.type))
      nodeIssue(node, 'operation', '当前简化流程尚未支持此动作', flow.id);
    if (
      ['DEPLOY_ARTIFACT', 'ROLLBACK_ARTIFACT'].includes(node.type) &&
      node.deploy?.method === 'COMPOSE'
    ) {
      const compose = config.release?.compose;
      const selection = simplifiedReleaseImages(activeFinish, config.release ?? {});
      if (!existingArtifact && !selection.length) {
        if (images.length) report('start.release.imageIds', '请选择本次要发布的镜像登记项');
        nodeIssue(finish, 'finish.images', '从本次构建发布时请登记镜像', flow.id);
      }
      if (
        selection.length > 1 &&
        (selection.some(({ source }) => source === 'REGISTRY') ||
          new Set(selection.map(({ id }) => simplifiedComposeImageVariable(id))).size !==
            selection.length)
      )
        report(
          'start.release.imageIds',
          '多镜像发布需选择本机镜像，登记标识转换后的 Compose 变量必须唯一',
        );
      if (!existingArtifact && !compose && (selection.length > 1 || !selection[0]?.composePath))
        report('start.release.compose', '从本次构建发布时请选择 Compose 文件');
      if (compose) {
        safeRelative(start, 'start.release.compose.path', compose.path, flow.id);
        if (!/\.ya?ml$/i.test(compose.path))
          report('start.release.compose.path', '请选择 YAML 文件');
        if (compose.sourceId && !sources.some(({ id }) => id === compose.sourceId))
          report('start.release.compose.sourceId', '请选择此流开始节点中的源码');
        if (existingArtifact && !compose.sourceId)
          report(
            'start.release.compose.sourceId',
            '历史发布请选择固定提交中的 Compose 文件，或沿用产物内的文件',
          );
      }
    }
    const parameter =
      node.condition?.parameterKey ?? node.branch?.parameterKey ?? node.switch?.parameterKey;
    if (
      parameter &&
      !(config.variables ?? []).some(({ key, credentialId }) => key === parameter && !credentialId)
    )
      nodeIssue(node, 'parameterKey', '分支条件须选择开始节点的普通变量', flow.id);
    if (node.type === 'BUILD') {
      safeRelative(node, 'build.repoPath', node.build?.repoPath, flow.id);
      if (node.build?.dockerfilePath) {
        if (safeRelative(node, 'build.dockerfilePath', node.build.dockerfilePath, flow.id) === '.')
          nodeIssue(node, 'build.dockerfilePath', '请选择构建目录下的 Dockerfile', flow.id);
      } else if (!node.build?.buildCommand?.trim() && !node.build?.installCommand?.trim())
        nodeIssue(node, 'build.buildCommand', '请填写构建命令', flow.id);
    }
    if (node.type === 'SHELL' || node.type === 'CHECK') {
      safeRelative(node, 'shell.directory', node.shell?.directory, flow.id);
      if (!node.shell?.command?.trim()) nodeIssue(node, 'shell.command', '请填写执行命令', flow.id);
    }
    if (node.type === 'HEALTH_CHECK' && !node.healthCheck?.command?.trim())
      nodeIssue(node, 'healthCheck.command', '请填写健康检查命令', flow.id);
    const parents = new Set<string>();
    for (const { from } of flow.edges.filter(({ to }) => to === node.id)) {
      parents.add(from);
      for (const ancestor of ancestors.get(from) ?? []) parents.add(ancestor);
    }
    ancestors.set(node.id, parents);
  }
  const release = deploys[0];
  for (const node of ordered) {
    if ((node.type === 'APPROVAL' || node.type === 'HEALTH_CHECK') && !release)
      nodeIssue(node, 'operation', '此动作需要同一流程中的受管发布', flow.id);
    if (node.type === 'APPROVAL' && release && !ancestors.get(release.id)?.has(node.id))
      nodeIssue(node, 'operation', '请将审批连在发布之前', flow.id);
    if (node.type === 'HEALTH_CHECK' && release && !ancestors.get(node.id)?.has(release.id))
      nodeIssue(node, 'operation', '请将健康检查连在发布之后', flow.id);
    if (node.type === 'SOURCE_REVIEW' && !sources.length)
      nodeIssue(node, 'operation', '源码审核需要开始节点的仓库', flow.id);
  }
  if (
    activeFinish.requireRelease === 'HEALTHY' &&
    !ordered.some(({ type }) => type === 'HEALTH_CHECK')
  )
    nodeIssue(finish, 'finish.requireRelease', '请在发布后添加健康检查', flow.id);
  if (!release) return;
  const probes = ordered.filter(({ type }) => type === 'HEALTH_CHECK');
  const approvals = ordered.filter(({ type }) => type === 'APPROVAL');
  for (const path of graphBranchPaths(flow, ordered)) {
    if (!path.active.has(release.id)) {
      if (activeFinish.requireRelease)
        nodeIssue(
          finish,
          'finish.requireRelease',
          '要求核对发布结果时，每条分支均须执行受管发布',
          flow.id,
        );
      continue;
    }
    if (release.type === 'ROLLBACK_ARTIFACT' && !approvals.some(({ id }) => path.active.has(id)))
      nodeIssue(release, 'operation', '每条回滚分支都须先完成人工审批', flow.id);
    if (activeFinish.requireRelease === 'HEALTHY' && !probes.some(({ id }) => path.active.has(id)))
      nodeIssue(
        finish,
        'finish.requireRelease',
        '要求健康时，每条发布分支均须执行健康检查',
        flow.id,
      );
    if (existingArtifact) continue;
    const happensBefore = new Map<string, Set<string>>();
    for (const node of ordered) {
      const direct = path.edges.filter(({ to }) => to === node.id).map(({ from }) => from);
      happensBefore.set(
        node.id,
        new Set(direct.flatMap((from) => [from, ...(happensBefore.get(from) ?? [])])),
      );
    }
    const stage = approvals.find(({ id }) => path.active.has(id)) ?? release;
    const before = happensBefore.get(stage.id)!;
    const compose = release.deploy?.method === 'COMPOSE';
    const releaseImages = compose ? simplifiedReleaseImages(activeFinish, config.release!) : [];
    if (
      releaseImages.some(
        (image) =>
          image.source === 'BUILT_IN' && !before.has(image.buildNodeId ?? dockerBuilds[0]!.id),
      )
    )
      report(
        'start.release.imageIds',
        '所选镜像的 Dockerfile 构建须在每条发布路径上的审批与部署之前执行',
      );
    const writers = ordered.filter(
      ({ id, type }) => workspaceActions.has(type) && path.active.has(id),
    );
    if (
      !writers.some(({ id }) => before.has(id)) &&
      (!compose || releaseImages[0]?.source !== 'REGISTRY' || !config.release?.compose?.sourceId)
    )
      report('start.release.artifactId', '请选择历史产物，或在固化交付内容前添加工作区动作');
    for (const node of writers) {
      if (!before.has(node.id) && !happensBefore.get(node.id)?.has(stage.id))
        nodeIssue(node, 'operation', '请用连线明确此动作与固化交付内容的先后关系', flow.id);
    }
  }
}
