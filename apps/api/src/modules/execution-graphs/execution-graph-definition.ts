import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
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
import { redactTaskLog } from '../tasks/task-log.service';

const idFormat = /^[A-Za-z0-9_-]{1,64}$/;
const maxFlows = 50;
const maxNodes = 100;
const maxEdges = 300;
const maxExpandedNodes = 1000;
const nodeTypes = [
  'START',
  'LOG',
  'BUILD',
  'DEPLOY_ARTIFACT',
  'CONDITION',
  'PARALLEL',
  'JOIN',
  'FLOW_CALL',
  'END',
] as const;

class GraphCondition {
  @IsIn(['input', 'commitSha']) key!: 'input' | 'commitSha';
  @IsString() @MaxLength(2000) value!: string;
}

class GraphNodePosition {
  @IsInt() @Min(0) @Max(30000) x!: number;
  @IsInt() @Min(0) @Max(30000) y!: number;
}

export class GraphNode {
  @Matches(idFormat) id!: string;
  @IsString() @Length(1, 100) @Matches(/\S/) name!: string;
  @IsIn(nodeTypes) type!: (typeof nodeTypes)[number];
  @ValidateIf((_o, v) => v !== undefined)
  @IsString()
  @Length(1, 2000)
  @Matches(/\S/)
  message?: string;
  @ValidateIf((_o, v) => v !== undefined) @IsUUID() pipelineId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  pipelineVersion?: number;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphCondition)
  condition?: GraphCondition;
  @ValidateIf((_o, v) => v !== undefined) @Matches(idFormat) flowId?: string;
  @ValidateIf((_o, v) => v !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GraphNodePosition)
  position?: GraphNodePosition;
}
export class GraphEdge {
  @Matches(idFormat) from!: string;
  @Matches(idFormat) to!: string;
  @ValidateIf((_o, v) => v !== undefined) @IsIn(['TRUE', 'FALSE']) when?: 'TRUE' | 'FALSE';
}
export class GraphFlow {
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
export class GraphDefinition {
  @IsArray()
  @IsObject({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(maxFlows)
  @ValidateNested({ each: true })
  @Type(() => GraphFlow)
  flows!: GraphFlow[];
}
export class ExpectedGraphRevisionDto {
  @IsInt() @Min(1) @Max(2147483647) expectedRevision!: number;
}
export class SaveGraphDraftDto extends ExpectedGraphRevisionDto {
  @IsObject() @ValidateNested() @Type(() => GraphDefinition) definition!: GraphDefinition;
}

export class ExtractGraphFlowDto extends ExpectedGraphRevisionDto {
  @Matches(idFormat) flowId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(maxNodes - 2)
  @ArrayUnique()
  @Matches(idFormat, { each: true })
  nodeIds!: string[];
  @IsString() @Length(1, 100) @Matches(/\S/) name!: string;
  @IsIn(['REPLACE', 'COPY']) mode!: 'REPLACE' | 'COPY';
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
    if (!edges || count === undefined || edges.some(({ to }) => to === edge.to))
      throw new BadRequestException('连线须连接同一执行流中的节点，且起点与终点的组合必须唯一');
    edges.push(edge);
    incoming.set(edge.to, count + 1);
  }
  for (const node of flow.nodes) {
    const edges = outgoing.get(node.id)!;
    const count = incoming.get(node.id)!;
    const validInputs =
      node.type === 'START' ? count === 0 : node.type === 'JOIN' ? count >= 2 : count === 1;
    const validOutputs =
      node.type === 'CONDITION'
        ? edges.length === 2 &&
          new Set(edges.map(({ when }) => when)).size === 2 &&
          edges.every(({ when }) => when === 'TRUE' || when === 'FALSE')
        : edges.every(({ when }) => when === undefined) &&
          (node.type === 'END'
            ? edges.length === 0
            : node.type === 'PARALLEL'
              ? edges.length >= 2
              : edges.length === 1);
    if (!validInputs || !validOutputs)
      throw new BadRequestException(
        `节点「${node.name}」的连线不完整。并行节点至少需要两个出口，汇合节点至少需要两个入口，条件节点必须各有一条真、假连线`,
      );
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

export function validateGraphDefinition(definition: GraphDefinition) {
  if (!definition.flows.length || definition.flows.length > maxFlows)
    throw new BadRequestException(`每张图须包含 1 到 ${maxFlows} 个执行流`);
  const calls = new Map<string, { nodeCount: number; children: string[] }>();
  const nodeIds = new Set<string>();
  for (const flow of definition.flows) {
    if (calls.has(flow.id)) throw new BadRequestException('执行流 ID 重复');
    if (flow.nodes.length > maxNodes || flow.edges.length > maxEdges)
      throw new BadRequestException(
        `执行流「${flow.name}」超过 ${maxNodes} 个节点或 ${maxEdges} 条连线的上限`,
      );
    const references = { nodeCount: flow.nodes.length, children: [] as string[] };
    calls.set(flow.id, references);
    for (const node of orderedFlowNodes(flow)) {
      if (nodeIds.has(node.id)) throw new BadRequestException('同一图版本中的节点 ID 必须唯一');
      nodeIds.add(node.id);
      const action = node.type === 'BUILD' || node.type === 'DEPLOY_ARTIFACT';
      if (action) {
        if (!node.pipelineId || !node.pipelineVersion)
          throw new BadRequestException('交付节点须选择流水线和固定版本');
      } else if (node.pipelineId !== undefined || node.pipelineVersion !== undefined) {
        throw new BadRequestException('流水线引用仅适用于构建或部署节点');
      }
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
      if (node.type === 'CONDITION') {
        const condition = node.condition;
        if (
          !condition ||
          !['input', 'commitSha'].includes(condition.key) ||
          typeof condition.value !== 'string'
        )
          throw new BadRequestException('条件节点须配置比较字段与匹配值');
        if (redactTaskLog(condition.value) !== condition.value)
          throw new BadRequestException('条件值应使用普通文本，不能包含明文凭据');
      } else if (node.condition !== undefined) {
        throw new BadRequestException('仅条件节点可配置判断条件');
      }
    }
  }
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
}

export function extractGraphFlow(definition: GraphDefinition, input: ExtractGraphFlowDto) {
  const source = definition.flows.find((flow) => flow.id === input.flowId);
  if (!source) throw new BadRequestException('要提取的源执行流不存在');
  const selected = new Set(input.nodeIds);
  const nodes = orderedFlowNodes(source).filter((node) => selected.has(node.id));
  if (
    nodes.length !== selected.size ||
    !nodes.length ||
    nodes.some((node) => node.type === 'START' || node.type === 'END')
  )
    throw new BadRequestException('只能提取同一执行流中的中间节点，请移除入口、出口或无效节点');

  const entries = source.edges.filter(({ from, to }) => !selected.has(from) && selected.has(to));
  const exits = source.edges.filter(({ from, to }) => selected.has(from) && !selected.has(to));
  if (entries.length !== 1 || exits.length !== 1 || exits[0]!.when)
    throw new BadRequestException(
      '选区须有一条进入连线和一条无条件离开连线，请完整选择条件或并行分支及其汇合节点',
    );
  const entry = entries[0]!;
  const exit = exits[0]!;

  const key = createHash('sha256')
    .update(
      JSON.stringify([input.expectedRevision, input.flowId, input.mode, nodes.map(({ id }) => id)]),
    )
    .digest('hex')
    .slice(0, 24);
  const taken = new Set(
    definition.flows.flatMap((flow) => [flow.id, ...flow.nodes.map(({ id }) => id)]),
  );
  const nextId = (prefix: string) => {
    let index = 1;
    while (taken.has(`${prefix}-${key}-${index}`)) index++;
    const id = `${prefix}-${key}-${index}`;
    taken.add(id);
    return id;
  };
  const createdFlowId = nextId('flow');
  const startId = nextId('start');
  const endId = nextId('end');
  const mapped = new Map(nodes.map(({ id }) => [id, input.mode === 'COPY' ? nextId('node') : id]));
  const internal = source.edges
    .filter(({ from, to }) => selected.has(from) && selected.has(to))
    .map((edge) => ({ ...edge, from: mapped.get(edge.from)!, to: mapped.get(edge.to)! }));
  const child: GraphFlow = {
    id: createdFlowId,
    name: input.name.trim(),
    nodes: [
      { id: startId, name: '开始', type: 'START' },
      ...nodes.map((node) => {
        const extractedNode = { ...node, id: mapped.get(node.id)! };
        delete extractedNode.position;
        return extractedNode;
      }),
      { id: endId, name: '结束', type: 'END' },
    ],
    edges: [
      { from: startId, to: mapped.get(entry.to)! },
      ...internal,
      { from: mapped.get(exit.from)!, to: endId },
    ],
  };
  let flows = definition.flows;
  if (input.mode === 'REPLACE') {
    const callerId = nextId('call');
    const position = source.nodes.find(({ id }) => id === entry.to)?.position;
    const parent: GraphFlow = {
      ...source,
      nodes: [
        ...source.nodes.filter(({ id }) => !selected.has(id)),
        {
          id: callerId,
          name: child.name,
          type: 'FLOW_CALL',
          flowId: child.id,
          ...(position && { position }),
        },
      ],
      edges: [
        ...source.edges.filter(({ from, to }) => !selected.has(from) && !selected.has(to)),
        { ...entry, to: callerId },
        { from: callerId, to: exit.to },
      ],
    };
    flows = flows.map((flow) => (flow.id === source.id ? parent : flow));
  }
  const extracted: GraphDefinition = { flows: [...flows, child] };
  validateGraphDefinition(extracted);
  return {
    definition: extracted,
    preview: {
      flowId: source.id,
      createdFlowId,
      nodeCount: nodes.length,
      entryNodeIds: [entry.to],
      exitNodeIds: [exit.from],
    },
  };
}
