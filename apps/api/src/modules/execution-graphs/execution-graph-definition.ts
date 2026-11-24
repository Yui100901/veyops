import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsOptional,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { isGitBranchName } from '../projects/git-ref';
import { redactTaskLog } from '../tasks/task-log.service';
import { relativePath, safeDeployPath } from '../pipelines/pipeline.validation';
import {
  GraphCompileError,
  GraphField,
  graphArtifactTypes,
  graphModulePorts,
  graphReferenceFormat,
  safeGraphId,
  type GraphArtifactType,
  type GraphBinding,
  type GraphDiagnostic,
} from './graph-fields';
import { validateFlowBindings, type GraphCompiledFlow } from './graph-binding-validation';

const idFormat = /^[A-Za-z0-9_-]{1,64}$/;
const maxFlows = 50;
const maxNodes = 100;
const maxEdges = 300;
const maxExpandedNodes = 1000;
const nodeTypes = [
  'START',
  'LOG',
  'CHECKOUT',
  'LOAD_ENV',
  'SHELL',
  'CHECK',
  'BUILD',
  'REGISTER_ARTIFACT',
  'DEPLOY_ARTIFACT',
  'ROLLBACK_ARTIFACT',
  'HEALTH_CHECK',
  'SOURCE_REVIEW',
  'CONDITION',
  'SWITCH',
  'DELAY',
  'APPROVAL',
  'PARALLEL',
  'JOIN',
  'FLOW_CALL',
  'END',
] as const;
const functionOperations = nodeTypes.filter(
  (type) => type !== 'START' && type !== 'END' && type !== 'CONDITION' && type !== 'SWITCH',
);

class GraphCondition {
  @IsOptional() @IsIn(['input', 'commitSha']) key?: 'input' | 'commitSha';
  @IsString() @MaxLength(2000) value!: string;
}

const maxSwitchCases = 10;
const maxDelaySeconds = 86_400;
const maxApprovalSeconds = 604_800;
export const defaultApprovalSeconds = 86_400;
const commitFormat = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

class GraphBranchCase {
  @Matches(idFormat) id!: string;
  @IsString() @MaxLength(500) value!: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(100) label?: string;
}

class GraphBranch {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(maxSwitchCases)
  @ValidateNested({ each: true })
  @Type(() => GraphBranchCase)
  cases!: GraphBranchCase[];
}

class GraphSwitch {
  @IsOptional() @IsIn(['input', 'commitSha']) key?: 'input' | 'commitSha';
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(maxSwitchCases)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  cases!: string[];
}

class GraphApproval {
  @ValidateIf((_o, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(maxApprovalSeconds)
  timeoutSeconds?: number;
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) releaseNodeId?: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) buildNodeId?: string;
}

class GraphNodePosition {
  @IsInt() @Min(0) @Max(30000) x!: number;
  @IsInt() @Min(0) @Max(30000) y!: number;
}

class GraphCheckout {
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() repositoryId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['BRANCH', 'COMMIT', 'TAG'])
  mode?: 'BRANCH' | 'COMMIT' | 'TAG';
  @ValidateIf((_o, v) => v !== undefined) @IsString() @Length(1, 255) branch?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @Length(1, 255) tag?: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(commitFormat) commitSha?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() fullClone?: boolean;
}

class GraphShell {
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() serverId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(10_000) command?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['MANAGER', 'TARGET'])
  location?: 'MANAGER' | 'TARGET';
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(1) @Max(7200) timeout?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(1024) directory?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(1024) artifactPath?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() continueOnFailure?: boolean;
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => GraphField)
  params?: GraphField[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => GraphField)
  outputs?: GraphField[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => GraphArtifactDeclaration)
  artifacts?: GraphArtifactDeclaration[];
}

export class GraphArtifactDeclaration {
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) id?: string;
  @IsString() @Length(1, 100) @Matches(/\S/) name!: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(64) referenceName?: string;
  @IsIn(graphArtifactTypes) type!: GraphArtifactType;
  @ValidateIf((_o, v) => v !== undefined)
  @IsIn(['WORK_DIRECTORY', 'PATH'])
  collection?: 'WORK_DIRECTORY' | 'PATH';
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  excludePaths?: string[];
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(1024) path?: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) pathInput?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(512) imageReference?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() required?: boolean;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() persist?: boolean;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(1024) composeFilePath?: string;
}

class GraphRegisterArtifacts {
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => GraphArtifactDeclaration)
  artifacts!: GraphArtifactDeclaration[];
}

class GraphEnvironmentPathRule {
  @Matches(idFormat) key!: string;
  @IsObject() paths!: Record<string, string>;
}

class GraphLoadEnvironment {
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(1024) envFile?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(1024) directory?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() required?: boolean;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphEnvironmentPathRule)
  pathRule?: GraphEnvironmentPathRule;
}

export class GraphEnvironmentSet {
  @IsIn(['NONE', 'FIXED', 'INPUT']) mode!: 'NONE' | 'FIXED' | 'INPUT';
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() environmentSetId?: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) fieldId?: string;
}

export class GraphBuildSettings {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ArrayUnique()
  @Matches(/^[a-z][a-z0-9-]{0,31}$/, { each: true })
  dependencies?: string[];
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() repositoryId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @Length(1, 255) branch?: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(commitFormat) commitSha?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsIn(['TARGET', 'MANAGER']) buildLocation?:
    'TARGET' | 'MANAGER';
  @ValidateIf((_o, v) => v !== undefined) @IsIn(['FILE', 'DOCKER_IMAGE']) artifactType?:
    'FILE' | 'DOCKER_IMAGE';
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(200) buildImage?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(300) repoPath?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(65536) installCommand?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(65536) buildCommand?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(300) outputPath?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(300) dockerfilePath?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(250) imageRepository?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() registryId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => GraphArtifactDeclaration)
  artifacts?: GraphArtifactDeclaration[];
}

class GraphComposeSource {
  @IsIn(['ARTIFACT', 'REPOSITORY_FILE']) kind!: 'ARTIFACT' | 'REPOSITORY_FILE';
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() repositoryId?: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(commitFormat) commitSha?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @Length(1, 300) path?: string;
}

class GraphHealthCheck {
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(65536) command?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(1) @Max(180) timeoutSeconds?: number;
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() requireHealthy?: boolean;
}

export class GraphDeploySettings {
  @ValidateIf((_o, v) => v !== undefined) @IsIn(['FILE', 'COMPOSE']) method?: 'FILE' | 'COMPOSE';
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(1024) artifactPath?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphComposeSource)
  composeSource?: GraphComposeSource;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(1024) deployPath?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(300) composeFilePath?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(65536) startCommand?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(65536) stopCommand?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(65536) healthCheckCommand?: string;
}

export class GraphNode {
  @Matches(idFormat) id!: string;
  @IsString() @Length(1, 100) @Matches(/\S/) name!: string;
  @ValidateIf((_o, v) => v !== undefined) @Matches(graphReferenceFormat) referenceName?: string;
  @IsIn([...nodeTypes, 'FUNCTION']) type!: (typeof nodeTypes)[number] | 'FUNCTION';
  @ValidateIf((_o, v) => v !== undefined) @IsIn(['PRESET']) contract?: 'PRESET';
  @ValidateIf((_o, v) => v !== undefined) @IsBoolean() sameHostRelease?: boolean;
  @ValidateIf((node, value) => node.type === 'FUNCTION' || value !== undefined)
  @IsIn(functionOperations)
  operation?: (typeof functionOperations)[number];
  @ValidateIf((_o, value) => value !== undefined) @IsBoolean() declaredPorts?: boolean;
  @ValidateIf((_o, v) => v !== undefined) @IsObject() inputDefaults?: Record<string, unknown>;
  @ValidateIf((_o, v) => v !== undefined) @IsObject() environmentDefaults?: Record<string, string>;
  @ValidateIf((_o, v) => v !== undefined) @IsString() @MaxLength(80) moduleId?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsInt() @Min(1) moduleVersion?: number;
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => GraphField)
  inputs?: GraphField[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => GraphField)
  outputs?: GraphField[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphBuildSettings)
  build?: GraphBuildSettings;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphDeploySettings)
  deploy?: GraphDeploySettings;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphHealthCheck)
  healthCheck?: GraphHealthCheck;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphRegisterArtifacts)
  registerArtifacts?: GraphRegisterArtifacts;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphLoadEnvironment)
  loadEnvironment?: GraphLoadEnvironment;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphEnvironmentSet)
  environmentSet?: GraphEnvironmentSet;
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 2000)
  @Matches(/\S/)
  message?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphCondition)
  condition?: GraphCondition;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphBranch)
  branch?: GraphBranch;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphSwitch)
  switch?: GraphSwitch;
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1)
  @Max(maxDelaySeconds)
  delaySeconds?: number;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphApproval)
  approval?: GraphApproval;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphCheckout)
  checkout?: GraphCheckout;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphShell)
  shell?: GraphShell;
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) flowId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphNodePosition)
  position?: GraphNodePosition;
}

/** The canvas keeps editable function nodes. Execution uses the existing native modules. */
export function runtimeGraphNode(node: GraphNode): GraphNode {
  if (node.type !== 'FUNCTION' && node.operation === undefined) return node;
  const { operation, ...definition } = node;
  if (node.type === 'FUNCTION' && operation && functionOperations.includes(operation))
    return { ...definition, type: operation, declaredPorts: true };
  throw new GraphCompileError({
    nodeId: node.id,
    fieldId: 'operation',
    fieldSection: 'execution',
    message: '功能节点必须选择有效的执行方式',
  });
}
export class GraphEdge {
  @Matches(idFormat) from!: string;
  @Matches(idFormat) to!: string;
  @ValidateIf((_o, v) => v !== undefined)
  @Matches(/^(?:TRUE|FALSE|DEFAULT|CASE:[A-Za-z0-9_-]{1,64}|SUCCESS|PARTIAL_SUCCESS)$/)
  when?: 'TRUE' | 'FALSE' | 'DEFAULT' | `CASE:${string}` | 'SUCCESS' | 'PARTIAL_SUCCESS';
}

export function graphDynamicOutlets(node: GraphNode, edges: readonly GraphEdge[] = []) {
  return (
    ['CONDITION', 'SWITCH', 'PARALLEL'].includes(node.type) ||
    (['DEPLOY_ARTIFACT', 'ROLLBACK_ARTIFACT'].includes(node.type) &&
      edges.some(({ when }) => when === 'SUCCESS' || when === 'PARTIAL_SUCCESS'))
  );
}

export function graphConditionMatch(
  node: GraphNode,
  value: unknown,
  caseInsensitive = false,
): GraphEdge['when'] {
  const matches = (candidate: string) =>
    value !== undefined &&
    (caseInsensitive ? candidate.toLowerCase() : candidate) === String(value);
  if (node.branch) {
    const entry = node.branch.cases.find((choice) => matches(choice.value));
    return entry ? `CASE:${entry.id}` : 'DEFAULT';
  }
  if (node.condition) return matches(node.condition.value) ? 'TRUE' : 'FALSE';
  const index = node.switch?.cases.findIndex(matches);
  return index === undefined ? undefined : index < 0 ? 'DEFAULT' : `CASE:${index}`;
}
class GraphFlowConfiguration {
  @IsOptional() @IsUUID() serviceId?: string;
  @IsOptional() @IsObject() inputBindings?: Record<string, Record<string, GraphBinding>>;
  @IsOptional() @IsObject() outputBindings?: Record<string, GraphBinding>;
  @IsOptional() @IsObject() environmentBindings?: Record<string, Record<string, GraphBinding>>;
  @IsOptional() @IsObject() edgeSelections?: Record<string, string[]>;
}
export class GraphFlow extends GraphFlowConfiguration {
  declare compiled?: GraphCompiledFlow;
  @Matches(idFormat) id!: string;
  @IsString() @Length(1, 100) @Matches(/\S/) name!: string;
  @IsArray()
  @IsObject({ each: true })
  @ArrayMinSize(2)
  @ArrayMaxSize(maxNodes)
  @ValidateNested({ each: true })
  @Type(() => GraphNode)
  nodes!: GraphNode[];
  @IsArray()
  @IsObject({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(maxEdges)
  @ValidateNested({ each: true })
  @Type(() => GraphEdge)
  edges!: GraphEdge[];
}
export class GraphEndpoint extends GraphFlowConfiguration {
  @Matches(idFormat) startId!: string;
  @Matches(idFormat) endId!: string;
}

export class GraphCanvas {
  @IsArray()
  @IsObject({ each: true })
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => GraphNode)
  nodes!: GraphNode[];
  @IsArray()
  @IsObject({ each: true })
  @ArrayMaxSize(1500)
  @ValidateNested({ each: true })
  @Type(() => GraphEdge)
  edges!: GraphEdge[];
  @IsArray()
  @IsObject({ each: true })
  @ArrayMaxSize(maxFlows)
  @ValidateNested({ each: true })
  @Type(() => GraphEndpoint)
  endpoints!: GraphEndpoint[];
  @IsArray()
  @IsObject({ each: true })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GraphNode)
  templates!: GraphNode[];
}

export class GraphDefinition {
  @ValidateIf((o: GraphDefinition) => o.canvas === undefined)
  @IsArray()
  @IsObject({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(maxFlows)
  @ValidateNested({ each: true })
  @Type(() => GraphFlow)
  flows!: GraphFlow[];
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphCanvas)
  canvas?: GraphCanvas;
}
export class ExpectedGraphRevisionDto {
  @IsInt() @Min(1) @Max(2147483647) expectedRevision!: number;
}
export class SaveGraphDraftDto extends ExpectedGraphRevisionDto {
  @IsObject() @ValidateNested() @Type(() => GraphDefinition) definition!: GraphDefinition;
}
export class ValidateGraphDraftDto {
  @IsObject() @ValidateNested() @Type(() => GraphDefinition) definition!: GraphDefinition;
}

export function orderedFlowNodes(flow: GraphFlow): GraphNode[] {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const starts = flow.nodes.filter((node) => node.type === 'START');
  const ends = flow.nodes.filter((node) => node.type === 'END');
  if (starts.length !== 1 || ends.length !== 1 || byId.size !== flow.nodes.length)
    throw new BadRequestException('每个执行流需要一个开始节点、一个结束节点和互不重复的节点 ID');
  const outgoing = new Map(flow.nodes.map((node) => [node.id, [] as GraphEdge[]]));
  const incoming = new Map(flow.nodes.map((node) => [node.id, 0]));
  for (const edge of flow.edges) {
    const edges = outgoing.get(edge.from);
    const count = incoming.get(edge.to);
    if (
      !edges ||
      count === undefined ||
      edges.some(({ to, when }) => to === edge.to && when === edge.when)
    )
      throw new BadRequestException('连线须连接同一执行流中的节点，且相同出口不能重复连接同一节点');
    edges.push(edge);
    incoming.set(edge.to, count + 1);
  }
  for (const node of flow.nodes) {
    const edges = outgoing.get(node.id)!;
    const count = incoming.get(node.id)!;
    const validInputs = node.type === 'START' ? count === 0 : count >= 1;
    if (!validInputs || !hasValidOutputs(node, edges))
      throw new GraphCompileError({
        flowId: flow.id,
        nodeId: node.id,
        edge: edges.find(
          ({ when }, index) =>
            edges.findIndex((edge) => edge.when === when) < index && when !== undefined,
        ),
        message: `节点「${node.name}」的连线不完整。检查入口与出口，每个条件或发布结果出口须连接一条线`,
      });
  }
  // A unique source and sink, plus a topological ordering of all nodes, makes
  // every node reachable from START and ensures every path can reach END.
  const ordered: GraphNode[] = [];
  const ready = [starts[0]!];
  while (ready.length) {
    const node = ready.shift()!;
    ordered.push(node);
    for (const { to } of outgoing.get(node.id)!) {
      const remaining = incoming.get(to)! - 1;
      incoming.set(to, remaining);
      if (remaining === 0) ready.push(byId.get(to)!);
    }
  }
  if (ordered.length !== byId.size || ordered.at(-1)?.type !== 'END')
    throw new BadRequestException('执行流包含环、断开的节点或无法到达的结束节点');
  return ordered;
}

function hasValidOutputs(node: GraphNode, edges: GraphEdge[]) {
  const labels = new Set(edges.map(({ when }) => when));
  if (
    (node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT') &&
    edges.some(({ when }) => when !== undefined)
  )
    return edges.length === 2 && labels.has('SUCCESS') && labels.has('PARTIAL_SUCCESS');
  if (node.type === 'CONDITION' && node.branch) {
    const cases = node.branch.cases;
    return (
      Array.isArray(cases) &&
      edges.length === cases.length + 1 &&
      labels.has('DEFAULT') &&
      cases.every((entry) => entry && labels.has(`CASE:${entry.id}`))
    );
  }
  if (node.type === 'CONDITION')
    return edges.length === 2 && labels.has('TRUE') && labels.has('FALSE');
  if (node.type === 'SWITCH') {
    const cases = node.switch?.cases;
    return (
      Array.isArray(cases) &&
      edges.length === cases.length + 1 &&
      labels.has('DEFAULT') &&
      cases.every((_value, index) => labels.has(`CASE:${index}`))
    );
  }
  if (edges.some(({ when }) => when !== undefined)) return false;
  if (node.type === 'END') return !edges.length;
  if (node.type === 'PARALLEL') return edges.length >= 2;
  return edges.length >= 1;
}

function validateAdvancedNode(node: GraphNode) {
  if (node.branch !== undefined) {
    const cases = node.branch?.cases;
    if (
      node.type !== 'CONDITION' ||
      node.condition ||
      !Array.isArray(cases) ||
      !cases.length ||
      cases.length > maxSwitchCases ||
      cases.some(
        (entry) =>
          !entry ||
          !safeGraphId(entry.id) ||
          typeof entry.value !== 'string' ||
          entry.value.length > 500 ||
          redactTaskLog(entry.value) !== entry.value ||
          (entry.label !== undefined &&
            (typeof entry.label !== 'string' ||
              entry.label.length > 100 ||
              redactTaskLog(entry.label) !== entry.label)),
      )
    )
      throw new BadRequestException('条件分支须配置 1 到 10 个有效规则');
    if (
      new Set(cases.map(({ id }) => id)).size !== cases.length ||
      new Set(cases.map(({ value }) => value)).size !== cases.length
    )
      throw new BadRequestException('条件分支的规则 ID 和匹配值须各自唯一');
  }
  const config = node.switch;
  if (node.type === 'SWITCH') {
    if (
      !config ||
      (config.key !== undefined && !['input', 'commitSha'].includes(config.key)) ||
      !Array.isArray(config.cases) ||
      !config.cases.length ||
      config.cases.length > maxSwitchCases ||
      config.cases.some((value) => typeof value !== 'string' || value.length > 500)
    )
      throw new BadRequestException('多分支节点须配置比较字段及 1 到 10 个匹配值');
    const cases =
      config.key === 'commitSha' ? config.cases.map((value) => value.toLowerCase()) : config.cases;
    if (new Set(cases).size !== cases.length)
      throw new BadRequestException('多分支节点的匹配值不可重复');
    if (config.key === 'commitSha' && cases.some((value) => !commitFormat.test(value)))
      throw new BadRequestException('按提交判断的分支必须填写完整提交 SHA');
    if (cases.some((value) => redactTaskLog(value) !== value))
      throw new BadRequestException('多分支匹配值只接受普通文本，请移除凭据');
  } else if (config !== undefined) {
    throw new BadRequestException('仅多分支节点可配置匹配值');
  }
  if (node.type === 'DELAY') {
    if (
      !Number.isInteger(node.delaySeconds) ||
      node.delaySeconds! < 1 ||
      node.delaySeconds! > maxDelaySeconds
    )
      throw new BadRequestException('延时节点须配置 1 到 86400 秒');
  } else if (node.delaySeconds !== undefined) {
    throw new BadRequestException('仅延时节点可配置等待秒数');
  }
  if (node.type === 'APPROVAL' || node.type === 'SOURCE_REVIEW') {
    const timeout = node.approval?.timeoutSeconds;
    if (
      node.approval === null ||
      (timeout !== undefined &&
        (!Number.isInteger(timeout) || timeout < 1 || timeout > maxApprovalSeconds))
    )
      throw new BadRequestException('审批超时须在 1 到 604800 秒之间');
    const { buildNodeId, releaseNodeId } = node.approval ?? {};
    if (releaseNodeId !== undefined && (node.type !== 'APPROVAL' || !safeGraphId(releaseNodeId)))
      throw new BadRequestException('仅人工审批节点可关联有效的发布节点 ID');
    if (buildNodeId !== undefined && (node.type !== 'SOURCE_REVIEW' || !safeGraphId(buildNodeId)))
      throw new BadRequestException('仅源码审核节点可关联有效的构建节点 ID');
  } else if (node.approval !== undefined) {
    throw new BadRequestException('仅审批节点可配置审批超时');
  }
  if (node.type === 'CHECKOUT') {
    const checkout = node.checkout;
    if (checkout?.branch && (checkout.mode !== 'BRANCH' || !isGitBranchName(checkout.branch)))
      throw new BadRequestException('源码拉取须填写有效分支');
    if (checkout?.tag && (checkout.mode !== 'TAG' || !isGitBranchName(checkout.tag)))
      throw new BadRequestException('源码拉取须填写有效标签');
    if (
      checkout?.commitSha &&
      (checkout.mode !== 'COMMIT' || !commitFormat.test(checkout.commitSha))
    )
      throw new BadRequestException('源码拉取须填写完整提交 SHA');
  } else if (node.checkout !== undefined) {
    throw new BadRequestException('仅源码拉取节点可配置仓库');
  }
  if (node.type === 'SHELL' || node.type === 'CHECK') {
    const command = node.shell?.command;
    if (command && redactTaskLog(command) !== command)
      throw new BadRequestException('Shell 命令包含明文凭据，请移除敏感值');
  } else if (node.shell !== undefined) {
    throw new BadRequestException('仅 Shell 或检查节点可配置命令');
  }
}

export function annotateGraphIssue(error: unknown, flow: GraphFlow, node?: GraphNode): never {
  if (error instanceof GraphCompileError) throw error;
  if (error instanceof BadRequestException)
    throw new GraphCompileError({
      flowId: flow.id,
      nodeId: node?.id,
      message: `「${flow.name}」${node ? ` → 「${node.name}」` : ''} · ${error.message}`,
    });
  throw error;
}

function missingNodeConfiguration(node: GraphNode): GraphDiagnostic[] {
  if (node.type === 'BUILD')
    return (node.build?.artifacts ?? []).flatMap(({ id, name, type, path, collection }) =>
      type !== 'DOCKER_IMAGE' && collection !== 'WORK_DIRECTORY' && !path?.trim()
        ? [
            {
              fieldId: id ?? name,
              fieldSection: 'output',
              artifactField: 'path',
              message: `请填写「${name}」相对构建工作目录的路径`,
            },
          ]
        : [],
    );
  if (
    (node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT') &&
    !node.deploy?.deployPath?.trim()
  )
    return [{ fieldId: 'deployPath', fieldSection: 'execution', message: '请填写节点的发布目录' }];
  if (node.type === 'HEALTH_CHECK' && !node.healthCheck?.command?.trim())
    return [{ fieldId: 'command', fieldSection: 'execution', message: '请填写健康检查命令' }];
  if ((node.type === 'SHELL' || node.type === 'CHECK') && !node.shell?.command?.trim())
    return [{ fieldId: 'command', fieldSection: 'execution', message: '请填写脚本或检查命令' }];
  return [];
}

export function validateGraphDefinition(definition: GraphDefinition) {
  if (!definition.flows.length || definition.flows.length > maxFlows)
    throw new BadRequestException(`每张图须包含 1 到 ${maxFlows} 个执行流`);
  const calls = new Map<string, { nodeCount: number; children: string[] }>();
  const nodeIds = new Set<string>();
  const issues: GraphDiagnostic[] = [];
  for (const flow of definition.flows) {
    if (calls.has(flow.id)) throw new BadRequestException('执行流 ID 重复');
    if (flow.nodes.length > maxNodes || flow.edges.length > maxEdges)
      throw new BadRequestException(
        `执行流「${flow.name}」超过 ${maxNodes} 个节点或 ${maxEdges} 条连线的上限`,
      );
    const references = { nodeCount: flow.nodes.length, children: [] as string[] };
    calls.set(flow.id, references);
    let ordered: GraphNode[];
    try {
      ordered = orderedFlowNodes(flow);
    } catch (error) {
      annotateGraphIssue(error, flow);
    }
    for (const node of ordered) {
      try {
        if (!safeGraphId(node.id)) throw new BadRequestException('节点 ID 无效');
        if (node.type === 'FUNCTION' || node.operation !== undefined)
          throw new BadRequestException('功能节点须在画布中声明后编译');
        for (const [fieldId, directory] of [
          ['repoPath', node.build?.repoPath],
          ['directory', node.shell?.directory],
          ['artifactPath', node.shell?.artifactPath ?? node.deploy?.artifactPath],
        ] as const) {
          if (!directory?.trim()) continue;
          try {
            relativePath(directory.trim());
          } catch {
            issues.push({
              flowId: flow.id,
              nodeId: node.id,
              fieldId,
              fieldSection: 'execution',
              severity: 'ERROR',
              message: `「${flow.name}」 → 「${node.name}」 · ${fieldId === 'artifactPath' ? '产物子路径' : '工作目录'}必须为不含 .. 的相对路径`,
            });
          }
        }
        if (!definition.canvas && nodeIds.has(node.id))
          throw new BadRequestException('同一图版本中的节点 ID 必须唯一');
        nodeIds.add(node.id);
        for (const issue of missingNodeConfiguration(node))
          issues.push({
            ...issue,
            flowId: flow.id,
            nodeId: node.id,
            severity: 'ERROR',
            message: `「${flow.name}」 → 「${node.name}」 · ${issue.message}`,
          });
        validateAdvancedNode(node);
        if ('delivery' in node || 'pipelineId' in node || 'pipelineVersion' in node)
          throw new BadRequestException('请使用功能节点配置构建和部署');
        if (
          (node.build !== undefined && node.type !== 'BUILD') ||
          (node.deploy !== undefined &&
            node.type !== 'DEPLOY_ARTIFACT' &&
            node.type !== 'ROLLBACK_ARTIFACT') ||
          (node.healthCheck !== undefined && node.type !== 'HEALTH_CHECK') ||
          (node.registerArtifacts !== undefined && node.type !== 'REGISTER_ARTIFACT') ||
          (node.loadEnvironment !== undefined && node.type !== 'LOAD_ENV') ||
          (node.environmentSet !== undefined && node.type !== 'START')
        )
          throw new BadRequestException('功能配置与节点模块不匹配');
        if (node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT') {
          if (node.deploy?.deployPath?.trim()) safeDeployPath(node.deploy.deployPath);
          if (node.deploy?.method === 'COMPOSE' && node.deploy.artifactPath)
            throw new BadRequestException('Compose 部署使用镜像，不能选择目录产物子路径');
          const template = node.deploy?.composeSource;
          if (template && node.deploy?.method === 'FILE')
            throw new BadRequestException('文件发布不能声明 Compose 模板');
          if (template?.kind === 'REPOSITORY_FILE') {
            if (!template.repositoryId || !template.commitSha || !template.path)
              throw new BadRequestException('仓库 Compose 模板需要仓库、完整提交 SHA 和路径');
            relativePath(template.path);
          } else if (template && (template.repositoryId || template.commitSha || template.path)) {
            throw new BadRequestException('产物 Compose 模板不能包含仓库字段');
          }
        }
        if (
          node.type === 'HEALTH_CHECK' &&
          node.healthCheck?.command &&
          redactTaskLog(node.healthCheck.command) !== node.healthCheck.command
        )
          throw new BadRequestException('请填写健康检查命令并通过变量引用传入凭据');
        if (node.build?.branch && (!isGitBranchName(node.build.branch) || node.build.commitSha))
          throw new BadRequestException('构建须使用有效分支或固定提交 SHA');
        const ports = graphModulePorts(node);
        if (
          (node.moduleId !== undefined && node.moduleId !== ports?.id) ||
          (node.moduleVersion !== undefined && node.moduleVersion !== ports?.version)
        )
          throw new BadRequestException('图引用了不可用的功能模块或模块版本');
        if (node.type === 'LOG') {
          if (!node.message?.trim()) throw new BadRequestException('请填写日志节点消息');
          if (redactTaskLog(node.message) !== node.message)
            throw new BadRequestException('日志消息包含明文凭据，请移除敏感值');
        } else if (node.message !== undefined) {
          throw new BadRequestException('仅日志节点接受日志消息');
        }
        if (node.type === 'FLOW_CALL') {
          if (!node.flowId) throw new BadRequestException('调用节点须选择同图中的执行流');
          references.children.push(node.flowId);
        } else if (node.flowId !== undefined) {
          throw new BadRequestException('仅调用节点可引用其他执行流');
        }
        if (node.type === 'CONDITION' && !node.branch) {
          const condition = node.condition;
          if (
            !condition ||
            (condition.key !== undefined && !['input', 'commitSha'].includes(condition.key)) ||
            typeof condition.value !== 'string'
          )
            throw new BadRequestException('条件节点须配置比较字段与匹配值');
          if (redactTaskLog(condition.value) !== condition.value)
            throw new BadRequestException('条件值应使用普通文本，不能包含明文凭据');
        } else if (node.condition !== undefined) {
          throw new BadRequestException('仅条件节点可配置判断条件');
        }
      } catch (error) {
        annotateGraphIssue(error, flow, node);
      }
    }
  }
  if (issues.length) throw new GraphCompileError(issues[0]!, issues);
  const seen = new Set<string>();
  const expanded = new Map<string, number>();
  const count = (flowId: string): number => {
    const cached = expanded.get(flowId);
    if (cached !== undefined) return cached;
    if (seen.has(flowId)) throw new BadRequestException('执行流调用存在循环依赖');
    const flow = calls.get(flowId);
    if (!flow) throw new BadRequestException('调用节点引用的执行流不存在');
    seen.add(flowId);
    let total = flow.nodeCount;
    for (const child of flow.children) {
      total += count(child);
      if (total > maxExpandedNodes)
        throw new BadRequestException(`一条流包含子流在内最多执行 ${maxExpandedNodes} 个节点`);
    }
    seen.delete(flowId);
    expanded.set(flowId, total);
    return total;
  };
  for (const flowId of calls.keys()) count(flowId);
  const compiled = new Map<string, GraphCompiledFlow>();
  for (const flow of definition.flows) {
    try {
      compiled.set(flow.id, validateFlowBindings(flow, definition.flows, orderedFlowNodes(flow)));
    } catch (error) {
      if (!(error instanceof GraphCompileError)) throw error;
      issues.push(...error.issues);
    }
  }
  if (issues.length) throw new GraphCompileError(issues[0]!, issues);
  return Object.fromEntries(compiled);
}
