import { redactTaskLog } from '../tasks/task-log.service';
import type { GraphEdge, GraphFlow, GraphNode } from './execution-graph-definition';
import {
  compatibleGraphFields,
  GraphCompileError,
  graphContextFields,
  graphDefaultBinding,
  graphModulePorts,
  graphRecord,
  safeGraphId,
  validateGraphBinding,
  validateGraphField,
  validateGraphValue,
  type GraphBinding,
  type GraphField,
} from './graph-fields';

interface PathScenario {
  active: Set<string>;
  edges: GraphEdge[];
  branches: string[];
}

const maxScenarios = 256;
const scalarTypes = ['TEXT', 'NUMBER', 'BOOLEAN'];

function fail(flow: GraphFlow, node: GraphNode, message: string, field?: GraphField): never {
  throw new GraphCompileError({
    flowId: flow.id,
    nodeId: node.id,
    fieldId: field?.id,
    message: `「${flow.name}」 → 「${node.name}」${field ? ` → 「${field.name}」` : ''} · ${message}`,
  });
}

function checkFields(
  flow: GraphFlow,
  node: GraphNode,
  fields: GraphField[],
  kind: 'INPUT' | 'OUTPUT',
) {
  const seen = new Set<string>();
  for (const field of fields) {
    const error = validateGraphField(field, kind);
    if (error) fail(flow, node, error, field);
    if (seen.has(field.id)) fail(flow, node, '字段标识不可重复', field);
    seen.add(field.id);
  }
}

function bindingAt(flow: GraphFlow, node: GraphNode, port: string) {
  const fields = Object.hasOwn(flow.inputBindings ?? {}, node.id)
    ? flow.inputBindings?.[node.id]
    : undefined;
  return fields && Object.hasOwn(fields, port)
    ? fields[port]
    : graphDefaultBinding(flow, node, port);
}

function outgoingBranches(flow: GraphFlow, node: GraphNode, edges: readonly GraphEdge[]) {
  if (node.type !== 'CONDITION' && node.type !== 'SWITCH') return [edges];
  const binding = bindingAt(flow, node, 'value');
  if (binding?.kind === 'VALUE') {
    const actual = String(binding.value);
    const index = node.switch?.cases.indexOf(actual) ?? -1;
    const branch =
      node.type === 'CONDITION'
        ? node.condition?.value === actual
          ? 'TRUE'
          : 'FALSE'
        : index === -1
          ? 'DEFAULT'
          : `CASE:${index}`;
    return [edges.filter((edge) => edge.when === branch)];
  }
  return edges.map((edge) => [edge]);
}

function possiblePaths(flow: GraphFlow, ordered: GraphNode[]) {
  const outgoing = new Map(ordered.map((node) => [node.id, [] as GraphEdge[]]));
  for (const edge of flow.edges) outgoing.get(edge.from)!.push(edge);
  let paths: PathScenario[] = [{ active: new Set([ordered[0]!.id]), branches: [], edges: [] }];
  for (const node of ordered) {
    paths = paths.flatMap((path) => {
      if (!path.active.has(node.id)) return [path];
      return outgoingBranches(flow, node, outgoing.get(node.id)!).map((edges) => ({
        active: new Set([...path.active, ...edges.map((edge) => edge.to)]),
        edges: [...path.edges, ...edges],
        branches: [
          ...path.branches,
          ...edges.flatMap((edge) => (edge.when ? [`${node.name} ${edge.when}`] : [])),
        ],
      }));
    });
    if (paths.length > maxScenarios)
      fail(flow, node, '分支组合过多，无法验证全部必填路径，请将部分判断拆到子执行流');
  }
  return paths;
}

function predecessors(edges: readonly GraphEdge[], ordered: GraphNode[]) {
  const incoming = new Map(ordered.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) incoming.get(edge.to)!.push(edge.from);
  const result = new Map<string, Set<string>>();
  for (const node of ordered) {
    const parents = incoming.get(node.id)!;
    result.set(
      node.id,
      new Set(parents.flatMap((parent) => [parent, ...(result.get(parent) ?? [])])),
    );
  }
  return result;
}

interface BindingContext {
  flow: GraphFlow;
  inputs: Map<string, GraphField>;
  nodes: Map<string, GraphNode>;
  outputs: Map<string, GraphField[]>;
  flows: Map<string, GraphFlow>;
}

function guarantee(input: GraphField) {
  return (
    input.required !== false || input.defaultValue !== undefined || input.selection !== undefined
  );
}

function contextSource(context: BindingContext, id: string) {
  const definition = graphContextFields.find((field) => field.id === id);
  if (!definition) return undefined;
  if (id === 'serviceId' && context.flow.serviceId) return { ...definition, required: true };
  if (id === 'environmentId' || id === 'serviceId') {
    const matches = [...context.inputs.values()].filter(
      (input) => input.type === definition.type && !input.multiple,
    );
    if (matches.length === 1 && guarantee(matches[0]!)) return { ...definition, required: true };
  }
  return definition;
}

function validatesLiteral(field: GraphField, value: unknown, node: GraphNode) {
  if (
    (node.type === 'CONDITION' || node.type === 'SWITCH') &&
    field.id === 'value' &&
    ['number', 'boolean'].includes(typeof value)
  )
    return true;
  if (['WORKSPACE', 'SOURCE', 'RELEASE', 'REPORT', 'VARIABLES'].includes(field.type)) return false;
  return (
    validateGraphValue({ ...field, required: true }, value) &&
    redactTaskLog(JSON.stringify(value)) === JSON.stringify(value)
  );
}

function assertBinding(
  context: BindingContext,
  node: GraphNode,
  field: GraphField,
  binding: GraphBinding,
  ancestors: ReadonlySet<string>,
) {
  const { flow } = context;
  if (binding.kind === 'FIRST_AVAILABLE') {
    for (const source of binding.sources) assertBinding(context, node, field, source, ancestors);
    return;
  }
  let source: GraphField | undefined;
  let producer: GraphNode | undefined;
  if (binding.kind === 'INPUT') source = context.inputs.get(binding.fieldId);
  if (binding.kind === 'CONTEXT') source = contextSource(context, binding.fieldId);
  if (binding.kind === 'OUTPUT') {
    producer = context.nodes.get(binding.nodeId);
    if (!producer || !ancestors.has(binding.nodeId))
      fail(flow, node, '输出来源必须是控制连线上的上游节点', field);
    source = context.outputs.get(binding.nodeId)?.find((port) => port.id === binding.fieldId);
  }
  if (
    field.source === 'CURRENT_RUN' &&
    (!producer ||
      (!['BUILD', 'REGISTER_ARTIFACT'].includes(producer.type) && source?.source !== 'CURRENT_RUN'))
  )
    fail(flow, node, '仅能绑定本次运行由构建或登记模块产生的产物', field);
  if (binding.kind === 'VALUE') {
    if (!validatesLiteral(field, binding.value, node))
      fail(flow, node, '固定值不符合字段类型或包含明文凭据', field);
    return;
  }
  const scalarCondition =
    (node.type === 'CONDITION' || node.type === 'SWITCH') &&
    field.id === 'value' &&
    source &&
    !source.multiple &&
    scalarTypes.includes(source.type);
  if (!source || (!scalarCondition && !compatibleGraphFields(field, source)))
    fail(flow, node, '来源不存在，或数据类型、数量、产物类型不匹配', field);
  if (field.type === 'RELEASE' && flow.serviceId && producer) {
    const service =
      producer.type === 'FLOW_CALL'
        ? context.flows.get(producer.flowId!)?.serviceId
        : bindingAt(flow, producer, 'service');
    if (
      (typeof service === 'string' && service !== flow.serviceId) ||
      (typeof service === 'object' && service.kind === 'VALUE' && service.value !== flow.serviceId)
    )
      fail(flow, node, '发布结果来源与执行流关联的服务不一致', field);
  }
}

function available(
  context: BindingContext,
  binding: GraphBinding,
  ancestors: ReadonlySet<string>,
): boolean {
  switch (binding.kind) {
    case 'INPUT':
      return guarantee(context.inputs.get(binding.fieldId)!);
    case 'CONTEXT':
      return guarantee(contextSource(context, binding.fieldId)!);
    case 'VALUE':
      return true;
    case 'OUTPUT': {
      const output = context.outputs
        .get(binding.nodeId)
        ?.find((port) => port.id === binding.fieldId);
      return Boolean(output && output.required !== false && ancestors.has(binding.nodeId));
    }
    case 'FIRST_AVAILABLE':
      return binding.sources.some((source) => available(context, source, ancestors));
  }
}

function validateArtifactConfig(flow: GraphFlow, node: GraphNode, ports: GraphField[]) {
  const declaration =
    node.type === 'BUILD' ? node.build?.artifacts : node.registerArtifacts?.artifacts;
  for (const artifact of declaration ?? []) {
    const port = ports.find((candidate) => candidate.id === artifact.name);
    if (!port || artifact.name === 'artifacts') fail(flow, node, '具名产物标识不可与产物列表重名');
    if (artifact.type !== 'DOCKER_IMAGE' && artifact.imageReference)
      fail(flow, node, '镜像地址只适用于 Docker 镜像产物', port);
    for (const value of [artifact.path, artifact.composeFilePath]) {
      if (
        value !== undefined &&
        !validateGraphValue({ id: 'path', name: '产物路径', type: 'PATH' }, value)
      )
        fail(flow, node, '产物路径必须在工作区内', port);
    }
    if (
      artifact.imageReference &&
      !validateGraphValue({ id: 'image', name: '镜像地址', type: 'IMAGE' }, artifact.imageReference)
    )
      fail(flow, node, '镜像地址无效', port);
  }
}

export function validateFlowBindings(
  flow: GraphFlow,
  definitions: GraphFlow[],
  ordered: GraphNode[],
) {
  const start = ordered[0]!;
  const end = ordered.at(-1)!;
  const flows = new Map(definitions.map((candidate) => [candidate.id, candidate]));
  const nodes = new Map(ordered.map((node) => [node.id, node]));
  checkFields(flow, start, start.inputs ?? [], 'INPUT');
  checkFields(flow, end, end.outputs ?? [], 'OUTPUT');
  const inputs = new Map((start.inputs ?? []).map((input) => [input.id, input]));
  const nodePorts = new Map(
    ordered.map((node) => [node.id, graphModulePorts(node, flows.get(node.flowId ?? ''))]),
  );
  const outputs = new Map(ordered.map((node) => [node.id, nodePorts.get(node.id)?.outputs ?? []]));
  const context: BindingContext = { flow, inputs, nodes, outputs, flows };
  if (!graphRecord(flow.inputBindings ?? {}) || !graphRecord(flow.outputBindings ?? {}))
    fail(flow, start, '流内绑定格式无效');
  for (const [nodeId, ports] of Object.entries(flow.inputBindings ?? {})) {
    const node = nodes.get(nodeId);
    if (!node || !safeGraphId(nodeId) || !graphRecord(ports))
      fail(flow, node ?? start, '输入绑定必须指向此流的功能节点');
    const knownPorts = nodePorts.get(node.id)?.inputs ?? [];
    for (const [portId, binding] of Object.entries(ports)) {
      const port = knownPorts.find((candidate) => candidate.id === portId);
      if (!port || !validateGraphBinding(binding))
        fail(
          flow,
          node,
          '输入端口或绑定格式无效',
          port ?? { id: portId, name: portId, type: 'TEXT' },
        );
    }
  }
  for (const [fieldId, binding] of Object.entries(flow.outputBindings ?? {})) {
    const field = end.outputs?.find((output) => output.id === fieldId);
    if (!field || !validateGraphBinding(binding))
      fail(
        flow,
        end,
        '结束字段或绑定格式无效',
        field ?? { id: fieldId, name: fieldId, type: 'TEXT' },
      );
  }

  const paths = possiblePaths(flow, ordered);
  const staticOrder = predecessors(flow.edges, ordered);
  const pathOrders = paths.map((path) => ({ path, order: predecessors(path.edges, ordered) }));
  for (const node of ordered) {
    const ports = nodePorts.get(node.id);
    if (node.inputs !== undefined && node.type !== 'START')
      fail(flow, node, '开始入参只能声明在开始节点');
    if (node.outputs !== undefined && !['END', 'SHELL', 'CHECK'].includes(node.type))
      fail(flow, node, '仅结束、Shell 和检查节点允许声明输出');
    if (node.type === 'SHELL' || node.type === 'CHECK') {
      checkFields(flow, node, node.shell?.params ?? [], 'INPUT');
      checkFields(flow, node, node.outputs ?? node.shell?.outputs ?? [], 'OUTPUT');
      for (const field of node.shell?.params ?? []) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.id) || /^VEYOPS_/i.test(field.id))
          fail(flow, node, '脚本入参标识须为可用的环境变量名', field);
        if (
          !scalarTypes.includes(field.type) &&
          field.type !== 'PATH' &&
          field.type !== 'CREDENTIAL'
        )
          fail(flow, node, '脚本入参支持文本、数值、布尔值、相对路径及凭据引用', field);
        if (field.type === 'CREDENTIAL' && field.multiple)
          fail(flow, node, '每个脚本环境变量只能关联一个凭据', field);
      }
      for (const field of node.outputs ?? node.shell?.outputs ?? [])
        if (!scalarTypes.includes(field.type))
          fail(flow, node, '脚本自定义输出支持文本、数值、布尔值及其列表', field);
    }
    for (const fields of [ports?.inputs ?? [], ports?.outputs ?? []]) {
      if (new Set(fields.map((field) => field.id)).size !== fields.length)
        fail(flow, node, '功能端口标识不可重复');
    }
    if (node.type === 'BUILD' || node.type === 'REGISTER_ARTIFACT')
      validateArtifactConfig(flow, node, ports?.outputs ?? []);
    const conditional = node.type === 'CONDITION' || node.type === 'SWITCH';
    const destinations =
      node.type === 'END'
        ? (node.outputs ?? [])
        : (ports?.inputs ?? []).map((port) =>
            conditional && port.id === 'value' && flow.inputBindings?.[node.id]?.value
              ? { ...port, required: true }
              : port,
          );
    if (
      node.type === 'END' &&
      flow.serviceId &&
      ordered.some(
        (candidate) =>
          candidate.type === 'DEPLOY_ARTIFACT' ||
          (candidate.type === 'FLOW_CALL' &&
            outputs.get(candidate.id)?.some((port) => port.type === 'RELEASE')),
      ) &&
      !destinations.some((field) => field.type === 'RELEASE' && field.required !== false)
    )
      fail(flow, node, '关联服务的发布流需声明必填的服务发布结果');

    const bindings = new Map(
      destinations.map((field) => [
        field.id,
        node.type === 'END' ? flow.outputBindings?.[field.id] : bindingAt(flow, node, field.id),
      ]),
    );
    for (const field of destinations) {
      const binding = bindings.get(field.id);
      if (binding) assertBinding(context, node, field, binding, staticOrder.get(node.id)!);
    }
    for (const { path, order } of pathOrders) {
      if (!path.active.has(node.id)) continue;
      const ancestors = order.get(node.id)!;
      const has = (id: string) => {
        const binding = bindings.get(id);
        return binding !== undefined && available(context, binding, ancestors);
      };
      const branch = path.branches.length ? `（分支 ${path.branches.join(' / ')}）` : '';
      for (const field of destinations) {
        if (field.required !== false && !has(field.id) && field.defaultValue === undefined)
          fail(flow, node, `缺少必填来源${branch}，请绑定开始参数、固定配置或上游输出`, field);
      }
      if (node.type === 'BUILD' && !has('repository') && !has('source') && !has('workspace'))
        fail(
          flow,
          node,
          `没有可用的构建源码${branch}，请绑定工作区、实际源码版本或项目仓库`,
          destinations.find((port) => port.id === 'workspace'),
        );
      if (
        (node.type === 'SHELL' || node.type === 'CHECK') &&
        node.shell?.location !== 'MANAGER' &&
        !has('workspace') &&
        !has('targets')
      )
        fail(
          flow,
          node,
          `缺少脚本执行位置${branch}，请绑定工作区或服务器`,
          destinations.find((port) => port.id === 'targets'),
        );
      if (node.type === 'REGISTER_ARTIFACT' && !node.registerArtifacts?.artifacts.length)
        fail(flow, node, '请配置至少一个具名产物');
      if (
        node.type === 'REGISTER_ARTIFACT' &&
        node.registerArtifacts?.artifacts.some((artifact) => artifact.type !== 'DOCKER_IMAGE') &&
        !has('workspace')
      )
        fail(
          flow,
          node,
          `缺少可读取产物的工作区${branch}`,
          destinations.find((port) => port.id === 'workspace'),
        );
      if (
        node.type === 'REGISTER_ARTIFACT' &&
        node.registerArtifacts?.artifacts.some(
          (artifact) => artifact.type !== 'DOCKER_IMAGE' && !artifact.path,
        ) &&
        !has('path')
      )
        fail(
          flow,
          node,
          `配置的产物缺少工作区相对路径${branch}`,
          destinations.find((port) => port.id === 'path'),
        );
      if (
        node.type === 'REGISTER_ARTIFACT' &&
        node.registerArtifacts?.artifacts.some(
          (artifact) => artifact.type === 'DOCKER_IMAGE' && !artifact.imageReference,
        ) &&
        !has('image')
      )
        fail(
          flow,
          node,
          `配置的镜像缺少引用${branch}`,
          destinations.find((port) => port.id === 'image'),
        );
      if (['BUILD', 'DEPLOY_ARTIFACT', 'REGISTER_ARTIFACT'].includes(node.type)) {
        if (!has('service'))
          fail(
            flow,
            node,
            `缺少项目服务来源${branch}`,
            destinations.find((port) => port.id === 'service'),
          );
        if (!has('environment'))
          fail(
            flow,
            node,
            `缺少项目环境来源${branch}`,
            destinations.find((port) => port.id === 'environment'),
          );
      }
    }
  }
}
