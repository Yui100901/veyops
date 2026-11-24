import { redactTaskLog } from '../tasks/task-log.service';
import { graphConditionMatch } from './execution-graph-definition';
import type { GraphEdge, GraphFlow, GraphNode } from './execution-graph-definition';
import { environmentFilePath } from './graph-environment';
import {
  compatibleGraphFields,
  graphArtifactDeclarations,
  GraphCompileError,
  graphContextFields,
  graphDefaultBinding,
  graphModulePorts,
  graphNodeEnvironmentBindings,
  graphOperationPorts,
  graphPresetStartPort,
  graphRecord,
  graphScriptInputs,
  graphScriptInputTypes,
  graphScriptOutputs,
  graphScriptOutputTypes,
  safeGraphEnvironmentKey,
  safeGraphId,
  safeGraphReference,
  validateGraphBinding,
  validateGraphField,
  validateGraphValue,
  type GraphBinding,
  type GraphField,
  type GraphDiagnostic,
} from './graph-fields';

export interface GraphCompiledFlow {
  presetResourceGroups?: true;
  order: string[];
  nodes: Record<
    string,
    {
      inputs: GraphField[];
      outputs: GraphField[];
      inputBindings: Record<string, GraphBinding>;
      environmentBindings: Record<string, GraphBinding>;
      dependencies: { nodeId: string; fieldId: string; consumerFieldId: string }[];
    }
  >;
  outputBindings: Record<string, GraphBinding>;
}

export interface GraphCandidate {
  label: string;
  referenceName: string;
  field: GraphField;
  binding: GraphBinding;
  availability: 'ALWAYS' | 'CONDITIONAL';
  branches: string[];
}

interface PathScenario {
  active: Set<string>;
  edges: GraphEdge[];
  branches: { id: string; label: string; edge: GraphEdge }[];
}

type DiagnosticLocation = Pick<
  GraphDiagnostic,
  | 'fieldId'
  | 'fieldSection'
  | 'artifactField'
  | 'sourceNodeId'
  | 'sourceFieldId'
  | 'branchId'
  | 'edge'
>;

function branchLocation(path: PathScenario): DiagnosticLocation {
  return {
    branchId: path.branches.map(({ id }) => id).join('/') || undefined,
    edge: path.branches.length === 1 ? path.branches[0]?.edge : undefined,
  };
}

const maxScenarios = 256;
const scalarTypes = ['TEXT', 'NUMBER', 'BOOLEAN', 'GIT_FETCH_MODE'];
const environmentNodes = ['BUILD', 'SHELL', 'CHECK'];

function locatedIssue(
  flow: GraphFlow,
  node: GraphNode,
  message: string,
  field?: GraphField,
  evidence: DiagnosticLocation = {},
): GraphDiagnostic {
  return {
    flowId: flow.id,
    nodeId: node.id,
    fieldId: field?.id,
    severity: 'ERROR',
    ...evidence,
    message: `「${flow.name}」 → 「${node.name}」${field ? ` → 「${field.name}」` : ''} · ${message}`,
  };
}

function fail(
  flow: GraphFlow,
  node: GraphNode,
  message: string,
  field?: GraphField,
  evidence?: DiagnosticLocation,
): never {
  throw new GraphCompileError(locatedIssue(flow, node, message, field, evidence));
}

function checkFields(
  flow: GraphFlow,
  node: GraphNode,
  fields: GraphField[],
  kind: 'INPUT' | 'OUTPUT',
  functional = false,
) {
  const seen = new Set<string>();
  const references = new Map<string, GraphField>();
  const aliases = new Map<string, GraphField>();
  const fieldSection = kind === 'INPUT' ? 'input' : 'output';
  for (const field of fields) {
    const error = validateGraphField(field, kind, functional);
    if (error) fail(flow, node, error, field, { fieldSection });
    if (seen.has(field.id)) fail(flow, node, '字段标识不可重复', field, { fieldSection });
    seen.add(field.id);
    for (const [value, group] of [
      [field.referenceName ?? field.id, references],
      [field.exportName ?? field.id, aliases],
    ] as const) {
      const existing = group.get(value);
      if (existing)
        fail(flow, node, '字段引用名或导出名不可重复', field, {
          fieldSection,
          sourceNodeId: node.id,
          sourceFieldId: existing.id,
        });
      group.set(value, field);
    }
  }
}

function authoredBinding(flow: GraphFlow, node: GraphNode, port: string) {
  const fields = Object.hasOwn(flow.inputBindings ?? {}, node.id)
    ? flow.inputBindings?.[node.id]
    : undefined;
  return fields && Object.hasOwn(fields, port) ? fields[port] : undefined;
}

function bindingAt(flow: GraphFlow, node: GraphNode, port: string) {
  return authoredBinding(flow, node, port) ?? graphDefaultBinding(flow, node, port);
}

function outgoingBranches(flow: GraphFlow, node: GraphNode, edges: readonly GraphEdge[]) {
  if (
    (node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT') &&
    edges.some(({ when }) => when !== undefined)
  )
    return edges.map((edge) => [edge]);
  if (node.type !== 'CONDITION' && node.type !== 'SWITCH') return [edges];
  const binding = bindingAt(flow, node, 'value');
  if (binding?.kind === 'VALUE') {
    const branch = graphConditionMatch(node, binding.value);
    return [edges.filter((edge) => edge.when === branch)];
  }
  return edges.map((edge) => [edge]);
}

export function graphBranchPaths(flow: GraphFlow, ordered: GraphNode[]) {
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
          ...edges.flatMap((edge) =>
            edge.when
              ? [
                  {
                    id: `${node.id}:${edge.when}`,
                    label: `${node.name} ${node.branch?.cases.find(({ id }) => edge.when === `CASE:${id}`)?.label || (edge.when === 'DEFAULT' ? '默认' : edge.when)}`,
                    edge,
                  },
                ]
              : [],
          ),
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
  start: GraphNode;
  inputs: Map<string, GraphField>;
  nodes: Map<string, GraphNode>;
  outputs: Map<string, GraphField[]>;
  nodeInputs: Map<string, GraphField[]>;
  flows: Map<string, GraphFlow>;
}

type PathOrder = { path: PathScenario; order: Map<string, Set<string>> };

type InferredBinding = { binding?: GraphBinding; issue?: string };

type ResourceGroup = {
  id: string;
  label: string;
  primary: GraphField;
  companion?: GraphField;
};

type ResolvedResourceGroup = {
  candidates: ResourceGroup[];
  bindings: Record<string, GraphBinding>;
  issue?: { message: string; fieldId: string; sourceFieldId?: string };
};

const groupSpecs = {
  source: {
    primaryId: 'repository',
    primaryType: 'REPOSITORY',
    primaryPort: 'repository',
    companionId: 'gitVersion',
    companionType: 'GIT_REF',
    companionPort: 'version',
    label: '源码',
  },
  release: {
    primaryId: 'service',
    primaryType: 'SERVICE',
    primaryPort: 'service',
    companionId: 'releaseTargets',
    companionType: 'TARGETS',
    companionPort: 'targets',
    label: '发布组合',
  },
} as const;

type GroupKind = keyof typeof groupSpecs;

function matchesStartField(field: GraphField | undefined, type: GraphField['type']) {
  return field?.type === type && !field.multiple;
}

function resourceGroups(context: BindingContext, kind: GroupKind) {
  const { inputs } = context;
  const spec = groupSpecs[kind];
  const fields = [...inputs.values()];
  const primaries = fields.filter((field) => matchesStartField(field, spec.primaryType));
  return primaries.flatMap((primary) => {
    const named = primary.id === spec.primaryId || primary.id.startsWith(spec.primaryId + '-');
    if (!named && primaries.length > 1) return [];
    const suffix = named ? primary.id.slice(spec.primaryId.length) : '';
    const key = spec.companionId + suffix;
    const expected = inputs.get(key);
    const legacy =
      !expected && !suffix && (primary.id === spec.primaryId || primaries.length === 1)
        ? fields.filter(
            (field) =>
              matchesStartField(field, spec.companionType) &&
              (kind === 'release'
                ? field.purpose === 'RELEASE_TARGETS' && !field.id.startsWith(key + '-')
                : !field.id.startsWith(key + '-')),
          )
        : [];
    const validPurpose = kind !== 'release' || expected?.purpose !== 'BUILD_TARGETS';
    const companion =
      validPurpose && matchesStartField(expected, spec.companionType)
        ? expected
        : legacy.length === 1
          ? legacy[0]
          : undefined;
    return [{ id: primary.id, label: primary.name, primary, companion, expectedId: key }];
  });
}

function resourceGroupBinding(
  context: BindingContext,
  node: GraphNode,
  kind: GroupKind,
  allowAbsent: boolean,
): ResolvedResourceGroup {
  const spec = groupSpecs[kind];
  const primary = authoredBinding(context.flow, node, spec.primaryPort);
  const secondary = authoredBinding(context.flow, node, spec.companionPort);
  const groups = resourceGroups(context, kind);
  const sameHost =
    kind === 'release' &&
    (context.start.sameHostRelease ||
      (secondary?.kind === 'INPUT' && secondary.fieldId === 'buildTargets'));
  const builder = sameHost && groups.length === 1 ? context.inputs.get('buildTargets') : undefined;
  const buildTargets =
    matchesStartField(builder, 'TARGETS') && builder?.purpose !== 'RELEASE_TARGETS'
      ? builder
      : undefined;
  const candidates: ResourceGroup[] = groups.map(({ id, label, primary, companion }) => ({
    id,
    label,
    primary,
    companion: buildTargets ?? companion,
  }));
  const invalid = (message: string, fieldId: string, sourceFieldId?: string) => ({
    candidates,
    bindings: {},
    issue: { message, fieldId, sourceFieldId },
  });
  const selected =
    primary?.kind === 'INPUT'
      ? groups.find(({ id }) => id === primary.fieldId)
      : !primary && groups.length === 1
        ? groups[0]
        : undefined;
  if (!selected) {
    if (allowAbsent && !groups.length && !primary && !secondary)
      return { candidates, bindings: {} };
    const detail =
      primary?.kind === 'INPUT'
        ? '所选来源缺失或类型无效'
        : primary
          ? '请选择开始节点配置，不可在此固定外部资源'
          : '请选择完整的一组配置';
    return invalid(
      `开始节点${spec.label}：${detail}`,
      spec.primaryPort,
      primary?.kind === 'INPUT' ? primary.fieldId : undefined,
    );
  }
  if (sameHost && !buildTargets)
    return invalid(
      '构建与发布同机需要唯一发布组合及开始节点的构建目标',
      spec.companionPort,
      'buildTargets',
    );
  const companion = buildTargets ?? selected.companion;
  if (!companion)
    return invalid(
      `所选${spec.label}缺少有效的${kind === 'source' ? '版本' : '发布目标'}字段，请在开始节点补齐`,
      spec.companionPort,
      selected.expectedId,
    );
  if (
    secondary &&
    (secondary.kind !== 'INPUT' ||
      secondary.fieldId !== companion.id ||
      (secondary.onMissing !== undefined &&
        secondary.onMissing !== 'ERROR' &&
        !(kind === 'source' && secondary.onMissing === 'REPOSITORY_DEFAULT')))
  )
    return invalid(
      `输入跨越不同的${spec.label}或使用固定值，请为此节点重新选择完整组合`,
      spec.companionPort,
      companion.id,
    );
  if (primary?.onMissing !== undefined && primary.onMissing !== 'ERROR')
    return invalid(
      '预设资源不能使用固定兜底，请在开始节点设置默认值',
      spec.primaryPort,
      selected.id,
    );
  const bindings: Record<string, GraphBinding> = {
    [spec.primaryPort]: { kind: 'INPUT', fieldId: selected.primary.id },
    [spec.companionPort]: {
      kind: 'INPUT',
      fieldId: companion.id,
      ...(kind === 'source' && { onMissing: 'REPOSITORY_DEFAULT' as const }),
    },
  };
  return { candidates, bindings };
}

function usesStartSource(context: BindingContext, node: GraphNode, paths: PathOrder[]) {
  return (
    node.type === 'CHECKOUT' ||
    (node.type === 'BUILD' &&
      !bindingAt(context.flow, node, 'workspace') &&
      !bindingAt(context.flow, node, 'source') &&
      !paths.some(
        ({ path, order }) =>
          path.active.has(node.id) &&
          [...(order.get(node.id) ?? [])].some((id) => context.nodes.get(id)?.type === 'CHECKOUT'),
      ))
  );
}

const usesReleaseGroup = (node: GraphNode) =>
  node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT';

function selectedResourceGroups(context: BindingContext, node: GraphNode, paths: PathOrder[]) {
  return {
    source: usesStartSource(context, node, paths)
      ? resourceGroupBinding(context, node, 'source', node.type === 'BUILD')
      : undefined,
    release: usesReleaseGroup(node)
      ? resourceGroupBinding(context, node, 'release', false)
      : undefined,
  };
}

function fixedPresetResource(binding: GraphBinding): boolean {
  if (binding.onMissing === 'USE_DEFAULT') return true;
  switch (binding.kind) {
    case 'VALUE':
      return true;
    case 'FIRST_AVAILABLE':
      return binding.sources.some(fixedPresetResource);
    case 'AS_GIT_REF':
    case 'PROJECT_VALUE':
      return fixedPresetResource(binding.source);
    default:
      return false;
  }
}

const legacyResourceDefaults = [
  { section: 'checkout', key: 'repositoryId', port: 'repository' },
  { section: 'checkout', key: 'mode', port: 'version' },
  { section: 'checkout', key: 'branch', port: 'version' },
  { section: 'checkout', key: 'tag', port: 'version' },
  { section: 'checkout', key: 'commitSha', port: 'version' },
  { section: 'build', key: 'repositoryId', port: 'repository' },
  { section: 'build', key: 'branch', port: 'version' },
  { section: 'build', key: 'commitSha', port: 'version' },
  { section: 'build', key: 'buildLocation', port: 'targets' },
  { section: 'shell', key: 'serverId', port: 'targets' },
] as const;

const startConfigIssue = '预设节点的固定资源必须移到开始节点的对应配置';

function presetBinding(
  context: BindingContext,
  node: GraphNode,
  field: GraphField,
  paths: PathOrder[],
): InferredBinding {
  const { flow, inputs, nodes, outputs } = context;
  const ancestors = paths
    .filter(({ path }) => path.active.has(node.id))
    .map(({ order }) => order.get(node.id)!);
  const isBuild = node.type === 'BUILD';
  const isScript = node.type === 'SHELL' || node.type === 'CHECK';
  const isRelease = usesReleaseGroup(node);
  const useStart = (choices: GraphField[]): InferredBinding => {
    if (choices.length > 1) return { issue: '开始节点有多个可用来源，请为此字段选择一项' };
    const choice = choices[0];
    return choice ? { binding: { kind: 'INPUT', fieldId: choice.id } } : {};
  };
  const useType = (type: GraphField['type']) =>
    useStart(
      [...inputs.values()].filter(
        (candidate) => candidate.type === type && compatibleGraphFields(field, candidate),
      ),
    );
  if (field.id === 'service' && (isBuild || isScript || node.type === 'REGISTER_ARTIFACT')) {
    const consumerIds = new Set<string>();
    for (const release of nodes.values()) {
      if (!usesReleaseGroup(release)) continue;
      const artifact = context.nodeInputs.get(release.id)?.find(({ id }) => id === 'artifact');
      const artifactSource =
        authoredBinding(flow, release, 'artifact') ??
        (artifact && presetBinding(context, release, artifact, paths).binding);
      if (
        !artifactSource ||
        !producerBindings(artifactSource).some(({ nodeId }) => nodeId === node.id)
      )
        continue;
      const selected = resourceGroupBinding(context, release, 'release', false).bindings.service;
      if (selected?.kind === 'INPUT') consumerIds.add(selected.fieldId);
    }
    if (consumerIds.size === 1)
      return { binding: { kind: 'INPUT', fieldId: [...consumerIds][0]! } };
    if (consumerIds.size > 1) return {};
    const services = [...inputs.values()].filter(
      (candidate) => candidate.type === 'SERVICE' && compatibleGraphFields(field, candidate),
    );
    return services.length === 1 ? useStart(services) : {};
  }
  if (field.id === 'environment' && (isBuild || isScript || isRelease))
    return useType('ENVIRONMENT');
  if (field.id === 'targets' && (isBuild || isScript || isRelease)) {
    if (isScript && node.shell?.location === 'MANAGER') return {};
    const purpose = isRelease ? 'RELEASE_TARGETS' : 'BUILD_TARGETS';
    const standardId = isRelease ? 'releaseTargets' : 'buildTargets';
    return useStart(
      [...inputs.values()].filter(
        (candidate) =>
          candidate.type === 'TARGETS' &&
          compatibleGraphFields(field, candidate) &&
          (candidate.purpose ? candidate.purpose === purpose : candidate.id === standardId),
      ),
    );
  }

  const checkout = (producer: GraphNode) => producer.type === 'CHECKOUT';
  let producerMatches: ((producer: GraphNode, port: GraphField) => boolean) | undefined;
  if (
    (field.id === 'workspace' || field.id === 'source') &&
    (isBuild || isScript || node.type === 'LOAD_ENV' || node.type === 'REGISTER_ARTIFACT')
  ) {
    const counterpart = bindingAt(flow, node, field.id === 'source' ? 'workspace' : 'source');
    if (counterpart && counterpart.kind !== 'OUTPUT') return {};
    producerMatches = (producer, port) =>
      checkout(producer) &&
      port.id === field.id &&
      (!counterpart || counterpart.nodeId === producer.id);
  } else if (field.id === 'variables' && (isBuild || isScript)) {
    producerMatches = (producer, port) => producer.type === 'LOAD_ENV' && port.id === 'variables';
  } else if (field.id === 'release' && node.type === 'HEALTH_CHECK') {
    producerMatches = (producer, port) =>
      ['DEPLOY_ARTIFACT', 'ROLLBACK_ARTIFACT'].includes(producer.type) && port.id === 'release';
  } else if (field.id === 'artifact' && isRelease) {
    producerMatches = (producer, port) =>
      (producer.type === 'BUILD' ||
        producer.type === 'REGISTER_ARTIFACT' ||
        producer.type === 'CHECK' ||
        producer.type === 'SHELL') &&
      port.type === 'ARTIFACT' &&
      !port.multiple;
  }
  if (!producerMatches) return {};
  const choices = [...nodes.values()].flatMap((producer) =>
    ancestors.some((ids) => ids.has(producer.id))
      ? (outputs.get(producer.id) ?? [])
          .filter((port) => producerMatches(producer, port) && compatibleGraphFields(field, port))
          .map((port) => ({ producer, port }))
      : [],
  );
  if (!choices.length && field.id === 'artifact' && isRelease) return useType('ARTIFACT');
  if (choices.length > 1) return { issue: '存在多个兼容的上游来源，请选择此步骤所需的具体结果' };
  const selected = choices[0];
  if (!selected) return {};
  if (selected.port.required === false || ancestors.some((ids) => !ids.has(selected.producer.id)))
    return { issue: '上游结果无法覆盖每条到达路径，请选择覆盖完整的来源' };
  return { binding: { kind: 'OUTPUT', nodeId: selected.producer.id, fieldId: selected.port.id } };
}

function suggestedInputBinding(
  context: BindingContext,
  node: GraphNode,
  field: GraphField,
  staticOrder: ReadonlyMap<string, Set<string>>,
  paths: PathOrder[],
): GraphBinding | undefined {
  if (!node.declaredPorts || !node.inputs?.some(({ id }) => id === field.id)) return undefined;
  const reference = field.referenceName ?? field.id;
  const matches = (candidate: GraphField) =>
    (candidate.referenceName ?? candidate.exportName ?? candidate.id) === reference &&
    compatibleGraphFields(field, candidate);
  const ancestors = staticOrder.get(node.id) ?? new Set<string>();
  const outputs = [...context.nodes.values()].reverse().flatMap((producer) => {
    if (!ancestors.has(producer.id)) return [];
    return (context.outputs.get(producer.id) ?? [])
      .filter(matches)
      .filter(
        ({ id }) =>
          producer.type !== 'SOURCE_REVIEW' ||
          !producer.approval?.buildNodeId ||
          id !== 'review' ||
          (node.type === 'BUILD' &&
            node.id === producer.approval.buildNodeId &&
            field.id === 'review'),
      )
      .map((port) => ({ producer, port }));
  });
  for (const { order } of paths) {
    const reached = order.get(node.id);
    if (!reached) continue;
    const available = outputs.filter(({ producer }) => reached.has(producer.id));
    const latest = available.filter(
      ({ producer }) => !available.some((other) => order.get(other.producer.id)?.has(producer.id)),
    );
    if (latest.length > 1) return undefined;
  }
  const sources: GraphBinding[] = outputs.map(({ producer, port }) => ({
    kind: 'OUTPUT',
    nodeId: producer.id,
    fieldId: port.id,
  }));
  sources.push(
    ...[...context.inputs.values()].filter(matches).map(({ id }): GraphBinding => ({
      kind: 'INPUT',
      fieldId: id,
    })),
  );
  if (sources.length === 0 || sources.length > 16) return undefined;
  const binding =
    sources.length === 1 ? sources[0]! : { kind: 'FIRST_AVAILABLE' as const, sources };
  return field.defaultValue === undefined ? binding : { ...binding, onMissing: 'USE_DEFAULT' };
}

function validateFunctionalDeclarations(
  flow: GraphFlow,
  node: GraphNode,
  calledFlow: GraphFlow | undefined,
) {
  const standard = graphOperationPorts(node, calledFlow);
  for (const [kind, declarations, builtIns] of [
    ['INPUT', node.inputs, standard?.inputs],
    ['OUTPUT', node.outputs, standard?.outputs],
  ] as const) {
    const fields = declarations ?? [];
    for (const field of fields) {
      const port = builtIns?.find(({ id }) => id === field.id);
      if (
        port &&
        (port.type !== field.type ||
          (field.artifactType !== undefined && port.artifactType !== field.artifactType))
      )
        fail(flow, node, '显式字段必须匹配执行动作的输入或输出类型', field);
      if (port && kind === 'OUTPUT' && field.defaultValue !== undefined)
        fail(flow, node, '执行动作输出使用实际结果，不能设置默认值', field);
      if (
        port &&
        kind === 'INPUT' &&
        field.defaultValue !== undefined &&
        !validatesLiteral(port, field.defaultValue, node)
      )
        fail(flow, node, '默认值不符合模块端口类型或包含明文凭据', field);
      if (!port && node.type !== 'SHELL' && node.type !== 'CHECK')
        fail(flow, node, '当前执行动作没有该字段，仅 Shell 或检查支持新增字段', field);
      if (!port && (field.required === false || field.multiple || field.options !== undefined))
        fail(flow, node, '自定义字段必须为单值必填，且不能配置选项约束', field);
    }
    checkFields(flow, node, fields, kind, true);
  }
}

function guarantee(input: GraphField) {
  return (
    input.required !== false || input.defaultValue !== undefined || input.selection !== undefined
  );
}

function contextSource(context: BindingContext, id: string) {
  const definition = graphContextFields.find((field) => field.id === id);
  if (!definition) return undefined;
  if (id === 'serviceId' && context.start.contract !== 'PRESET' && context.flow.serviceId)
    return { ...definition, required: true };
  if (id === 'environmentSetId') {
    const start = context.flow.nodes.find(({ type }) => type === 'START');
    const set = start?.environmentSet;
    const selected = set?.fieldId && context.inputs.get(set.fieldId);
    if (set?.mode === 'FIXED' || (selected && guarantee(selected)))
      return { ...definition, required: true };
    if (!set && start?.contract === 'PRESET') {
      const candidates = [...context.inputs.values()].filter(
        (field) => field.type === 'ENVIRONMENT_SET' && !field.multiple,
      );
      if (candidates.length === 1 && guarantee(candidates[0]!))
        return { ...definition, required: true };
    }
  }
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
  if (['WORKSPACE', 'SOURCE', 'RELEASE', 'REVIEW', 'REPORT', 'VARIABLES'].includes(field.type))
    return false;
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
  environment = false,
) {
  const { flow } = context;
  const evidence: DiagnosticLocation = {
    fieldSection: environment ? undefined : node.type === 'END' ? 'output' : 'input',
    ...(binding.kind === 'OUTPUT'
      ? { sourceNodeId: binding.nodeId, sourceFieldId: binding.fieldId }
      : binding.kind === 'INPUT'
        ? { sourceNodeId: flow.id, sourceFieldId: binding.fieldId }
        : {}),
  };
  if (binding.onMissing === 'OMIT' && field.required !== false)
    fail(flow, node, '仅可选端口允许缺值时省略', field, evidence);
  if (binding.onMissing === 'USE_DEFAULT' && field.defaultValue === undefined)
    fail(flow, node, '端口未定义缺值默认值', field, evidence);
  if (
    binding.onMissing === 'REPOSITORY_DEFAULT' &&
    (field.id !== 'version' ||
      field.type !== 'GIT_REF' ||
      !['CHECKOUT', 'BUILD'].includes(node.type))
  )
    fail(flow, node, '仓库默认版本策略仅用于检出或构建的 Git 版本端口', field, evidence);
  if (binding.kind === 'FIRST_AVAILABLE') {
    for (const source of binding.sources)
      assertBinding(context, node, field, source, ancestors, environment);
    return;
  }
  if (binding.kind === 'AS_GIT_REF') {
    if (field.type !== 'GIT_REF' || field.multiple)
      fail(flow, node, 'Git 引用转换仅用于单值 Git 版本端口', field, evidence);
    assertBinding(
      context,
      node,
      { ...field, type: 'TEXT', options: undefined },
      binding.source,
      ancestors,
    );
    return;
  }
  if (binding.kind === 'PROJECT_VALUE') {
    if (!environment || !['SHELL', 'CHECK'].includes(node.type))
      fail(flow, node, '仅 Shell 或检查的环境变量可投影上游执行资源', field, evidence);
    const { nodeId, fieldId } = binding.source;
    const producer = context.nodes.get(nodeId);
    const workspace = binding.projection === 'WORKSPACE_PATH';
    const producerTypes = workspace
      ? ['CHECKOUT', 'SHELL', 'CHECK']
      : ['BUILD', 'REGISTER_ARTIFACT', 'SHELL', 'CHECK'];
    if (!producer || !producerTypes.includes(producer.type))
      fail(flow, node, '投影须使用对应模块的正式输出', field, {
        ...evidence,
        sourceNodeId: nodeId,
        sourceFieldId: fieldId,
      });
    assertBinding(
      context,
      node,
      {
        ...field,
        type: workspace ? 'WORKSPACE' : 'ARTIFACT',
        ...(workspace
          ? {}
          : {
              acceptedArtifactTypes:
                binding.projection === 'ARTIFACT_PATH' ? ['FILE', 'DIRECTORY'] : ['DOCKER_IMAGE'],
            }),
      },
      binding.source,
      ancestors,
    );
    return;
  }
  if (binding.kind === 'CREDENTIAL' || binding.kind === 'ENVIRONMENT_KEY') {
    const isConditionKey =
      binding.kind === 'ENVIRONMENT_KEY' && node.branch && field.id === 'value';
    if (!environment && !isConditionKey)
      fail(flow, node, '凭据用于脚本环境注入，集合变量键也可供条件分支比较', field, evidence);
    if (
      binding.kind === 'ENVIRONMENT_KEY' &&
      !context.flow.nodes.some(
        (entry) =>
          entry.type === 'START' && entry.environmentSet && entry.environmentSet.mode !== 'NONE',
      )
    )
      fail(flow, node, '当前开始节点未选择变量集合来源', field, evidence);
    return;
  }
  let source: GraphField | undefined;
  let producer: GraphNode | undefined;
  if (binding.kind === 'INPUT') source = context.inputs.get(binding.fieldId);
  if (binding.kind === 'CONTEXT') source = contextSource(context, binding.fieldId);
  if (binding.kind === 'NODE_INPUT') {
    if (!environment) fail(flow, node, '仅节点环境注入可引用本节点的已解析输入', field, evidence);
    source = context.nodeInputs.get(node.id)?.find((port) => port.id === binding.fieldId);
  }
  if (binding.kind === 'OUTPUT') {
    producer = context.nodes.get(binding.nodeId);
    if (!producer || !ancestors.has(binding.nodeId))
      fail(flow, node, '输出来源必须位于控制上游，并行支路需先汇合或连接顺序依赖', field, evidence);
    if (
      producer.type === 'SOURCE_REVIEW' &&
      producer.approval?.buildNodeId &&
      binding.fieldId === 'review' &&
      (node.type !== 'BUILD' || node.id !== producer.approval.buildNodeId || field.id !== 'review')
    )
      fail(flow, node, '此审核凭证只可供关联构建使用', field, evidence);
    source = context.outputs.get(binding.nodeId)?.find((port) => port.id === binding.fieldId);
  }
  if (
    field.source === 'CURRENT_RUN' &&
    (!producer ||
      (!['BUILD', 'REGISTER_ARTIFACT', 'SHELL', 'CHECK'].includes(producer.type) &&
        source?.source !== 'CURRENT_RUN'))
  )
    fail(flow, node, '仅能绑定本次运行由构建或登记模块产生的产物', field, evidence);
  if (binding.kind === 'VALUE') {
    if (
      !validatesLiteral(field, binding.value, node) &&
      !(environment && ['number', 'boolean'].includes(typeof binding.value))
    )
      fail(flow, node, '固定值不符合字段类型或包含明文凭据', field, evidence);
    return;
  }
  const scalarCondition =
    (node.type === 'CONDITION' || node.type === 'SWITCH') &&
    field.id === 'value' &&
    source &&
    !source.multiple &&
    scalarTypes.includes(source.type);
  const environmentScalar =
    environment &&
    source &&
    !source.multiple &&
    ([...scalarTypes, 'PATH'].includes(source.type) ||
      (binding.kind === 'NODE_INPUT' && source.type === 'CREDENTIAL'));
  if (!source || (!scalarCondition && !environmentScalar && !compatibleGraphFields(field, source)))
    fail(flow, node, '来源不存在，或数据类型、数量、产物类型不匹配', field, evidence);
  if (
    field.type === 'RELEASE' &&
    context.start.contract !== 'PRESET' &&
    flow.serviceId &&
    producer
  ) {
    const service =
      producer.type === 'FLOW_CALL'
        ? context.flows.get(producer.flowId!)?.serviceId
        : bindingAt(flow, producer, 'service');
    if (
      (typeof service === 'string' && service !== flow.serviceId) ||
      (typeof service === 'object' &&
        service.kind === 'VALUE' &&
        (graphRecord(service.value) ? service.value.serviceId : service.value) !== flow.serviceId)
    )
      fail(flow, node, '发布结果来源与执行流关联的服务不一致', field, evidence);
  }
}

function available(
  context: BindingContext,
  binding: GraphBinding,
  ancestors: ReadonlySet<string>,
  inputs?: ReadonlyMap<string, boolean>,
): boolean {
  switch (binding.kind) {
    case 'INPUT':
      return Boolean(
        context.inputs.get(binding.fieldId) && guarantee(context.inputs.get(binding.fieldId)!),
      );
    case 'NODE_INPUT':
      return inputs?.get(binding.fieldId) ?? false;
    case 'CONTEXT':
      return Boolean(
        contextSource(context, binding.fieldId) &&
        guarantee(contextSource(context, binding.fieldId)!),
      );
    case 'VALUE':
    case 'CREDENTIAL':
      return true;
    case 'ENVIRONMENT_KEY':
      return contextSource(context, 'environmentSetId')?.required === true;
    case 'OUTPUT': {
      const output = context.outputs
        .get(binding.nodeId)
        ?.find((port) => port.id === binding.fieldId);
      return Boolean(output && output.required !== false && ancestors.has(binding.nodeId));
    }
    case 'FIRST_AVAILABLE':
      return binding.sources.some((source) => available(context, source, ancestors, inputs));
    case 'AS_GIT_REF':
    case 'PROJECT_VALUE':
      return available(context, binding.source, ancestors, inputs);
  }
}

function checkoutOnPath(
  context: BindingContext,
  binding: GraphBinding | undefined,
  ancestors: ReadonlySet<string>,
): string | undefined {
  if (binding?.kind === 'OUTPUT')
    return context.nodes.get(binding.nodeId)?.type === 'CHECKOUT' && ancestors.has(binding.nodeId)
      ? binding.nodeId
      : undefined;
  if (binding?.kind !== 'FIRST_AVAILABLE') return undefined;
  for (const candidate of binding.sources) {
    const checkout = checkoutOnPath(context, candidate, ancestors);
    if (checkout) return checkout;
    // An available or optional non-checkout source may win the selection at runtime.
    if (
      available(context, candidate, ancestors) ||
      producerBindings(candidate).some(({ nodeId }) => ancestors.has(nodeId))
    )
      return undefined;
  }
  return undefined;
}

function validateArtifactConfig(flow: GraphFlow, node: GraphNode, ports: GraphField[]) {
  const declaration = graphArtifactDeclarations(node);
  const script = node.type === 'SHELL' || node.type === 'CHECK';
  const references = new Set(
    script
      ? [
          'artifacts',
          'workspace',
          'report',
          'exitCode',
          ...graphScriptOutputs(node).map(({ id, referenceName }) => referenceName ?? id),
        ]
      : ['artifacts'],
  );
  for (const artifact of declaration ?? []) {
    const id = artifact.id ?? artifact.name;
    const port = ports.find((candidate) => candidate.id === id);
    const invalid = (message: string, artifactField?: GraphDiagnostic['artifactField']): never =>
      fail(flow, node, message, port, { fieldId: id, fieldSection: 'output', artifactField });
    if (!port || id === 'artifacts' || !safeGraphId(id))
      invalid('具名产物必须使用有效且不同于产物列表的端口标识');
    const reference = artifact.referenceName ?? id;
    if (
      (artifact.referenceName !== undefined && !safeGraphReference(reference)) ||
      references.has(reference)
    )
      invalid('具名产物引用名无效或重复', 'referenceName');
    references.add(reference);
    if (
      artifact.collection === 'WORK_DIRECTORY' &&
      (node.type !== 'BUILD' || artifact.type !== 'DIRECTORY' || artifact.pathInput)
    )
      invalid('保存工作目录只能用于构建节点的目录产物', 'path');
    if (
      artifact.excludePaths?.some(
        (path) =>
          !validateGraphValue({ id: 'path', name: '排除路径', type: 'PATH' }, path) ||
          !path.split('/').some((part) => part && part !== '.'),
      ) ||
      (artifact.excludePaths?.length && artifact.collection !== 'WORK_DIRECTORY')
    )
      invalid('排除项须为构建工作目录内的文件或目录', 'path');
    if (artifact.type !== 'DOCKER_IMAGE' && artifact.imageReference)
      invalid('镜像地址只适用于 Docker 镜像产物', 'imageReference');
    if (artifact.pathInput !== undefined) {
      const input = graphScriptInputs(node).find(({ id }) => id === artifact.pathInput);
      if (!script || artifact.type === 'DOCKER_IMAGE' || input?.type !== 'PATH' || input.multiple)
        invalid('路径来源必须是本节点声明的单值相对路径输入', 'pathInput');
    }
    if (script && artifact.type === 'DOCKER_IMAGE' && !artifact.imageReference)
      invalid('脚本镜像产物须明确指定执行端已有的镜像引用', 'imageReference');
    if (script && artifact.type !== 'DOCKER_IMAGE' && !artifact.path && !artifact.pathInput)
      invalid('请填写相对产物路径或选择脚本的路径输入', 'path');
    for (const field of ['path', 'composeFilePath'] as const) {
      const value = artifact[field];
      if (
        field === 'path' &&
        node.type === 'BUILD' &&
        artifact.type !== 'DOCKER_IMAGE' &&
        !value?.trim()
      )
        continue;
      if (
        value !== undefined &&
        !validateGraphValue({ id: 'path', name: '产物路径', type: 'PATH' }, value)
      )
        invalid(field === 'path' ? '产物路径必须在工作区内' : 'Compose 路径必须在工作区内', field);
    }
    if (
      artifact.imageReference &&
      !validateGraphValue({ id: 'image', name: '镜像地址', type: 'IMAGE' }, artifact.imageReference)
    )
      invalid('镜像地址无效', 'imageReference');
  }
}

export function validateFlowBindings(
  flow: GraphFlow,
  definitions: GraphFlow[],
  ordered: GraphNode[],
) {
  const start = ordered[0]!;
  const end = ordered.at(-1)!;
  const preset = start.contract === 'PRESET';
  const flows = new Map(definitions.map((candidate) => [candidate.id, candidate]));
  const nodes = new Map(ordered.map((node) => [node.id, node]));
  checkFields(flow, start, start.inputs ?? [], 'INPUT');
  const missingFixed = start.inputs?.find(
    (field) =>
      field.runtimeOverride === false &&
      field.required !== false &&
      field.defaultValue === undefined &&
      field.selection !== 'LATEST_COMPATIBLE',
  );
  if (missingFixed)
    fail(flow, start, '不可覆盖的必填参数需要已发布默认值', missingFixed, {
      fieldSection: 'input',
    });
  checkFields(flow, end, end.outputs ?? [], 'OUTPUT');
  const inputs = new Map((start.inputs ?? []).map((input) => [input.id, input]));
  const set = start.environmentSet;
  const setField = set?.fieldId ? inputs.get(set.fieldId) : undefined;
  if (set?.mode === 'FIXED' && (!set.environmentSetId || set.fieldId !== undefined))
    fail(flow, start, '固定引用需要选择当前项目的变量集合');
  if (
    set?.mode === 'INPUT' &&
    (set.environmentSetId !== undefined ||
      setField?.type !== 'ENVIRONMENT_SET' ||
      setField.multiple)
  )
    fail(flow, start, '运行时选择需要绑定一个单值变量集合参数', setField);
  if (set?.mode === 'NONE' && (set.environmentSetId !== undefined || set.fieldId !== undefined))
    fail(flow, start, '无引用模式不接收变量集合或参数绑定');
  const nodePorts = new Map(
    ordered.map((node) => [node.id, graphModulePorts(node, flows.get(node.flowId ?? ''))]),
  );
  const outputs = new Map(ordered.map((node) => [node.id, nodePorts.get(node.id)?.outputs ?? []]));
  const nodeInputs = new Map(
    ordered.map((node) => [node.id, nodePorts.get(node.id)?.inputs ?? []]),
  );
  const context: BindingContext = { flow, start, inputs, nodes, outputs, nodeInputs, flows };
  if (
    !graphRecord(flow.inputBindings ?? {}) ||
    !graphRecord(flow.outputBindings ?? {}) ||
    !graphRecord(flow.environmentBindings ?? {})
  )
    fail(flow, start, '流内绑定格式无效');
  for (const [nodeId, ports] of Object.entries(flow.inputBindings ?? {})) {
    const node = nodes.get(nodeId);
    if (!node || !safeGraphId(nodeId) || !graphRecord(ports))
      fail(flow, node ?? start, '输入绑定必须指向此流的功能节点');
    if (node.type === 'SOURCE_REVIEW' && node.approval?.buildNodeId) {
      const alternate = Object.keys(ports).find((id) => id === 'source' || id === 'artifact');
      if (alternate)
        fail(flow, node, '关联构建计划时不能同时绑定源码或产物', {
          id: alternate,
          name: alternate === 'source' ? '源码' : '产物',
          type: alternate === 'source' ? 'SOURCE' : 'ARTIFACT',
        });
    }
    const knownPorts = nodePorts.get(node.id)?.inputs ?? [];
    for (const [portId, binding] of Object.entries(ports)) {
      const port = knownPorts.find((candidate) => candidate.id === portId);
      if (!port || !validateGraphBinding(binding))
        fail(
          flow,
          node,
          '输入端口或绑定格式无效',
          port ?? { id: portId, name: portId, type: 'TEXT' },
          { fieldSection: 'input' },
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
        { fieldSection: 'output' },
      );
  }

  for (const [nodeId, variables] of Object.entries(flow.environmentBindings ?? {})) {
    const node = nodes.get(nodeId);
    if (!node || !environmentNodes.includes(node.type) || !graphRecord(variables))
      fail(flow, node ?? start, '环境绑定必须指向此流的构建、Shell 或检查节点');
    if (Object.keys(variables).length > 30) fail(flow, node, '每个节点最多声明 30 个环境绑定');
    for (const [key, binding] of Object.entries(variables)) {
      const field: GraphField = { id: key, name: key, type: 'TEXT', required: false };
      if (!safeGraphEnvironmentKey(key) || !validateGraphBinding(binding))
        fail(flow, node, '环境变量名或来源格式无效', field);
    }
  }

  const paths = graphBranchPaths(flow, ordered);
  const staticOrder = predecessors(flow.edges, ordered);
  const pathOrders = paths.map((path) => ({ path, order: predecessors(path.edges, ordered) }));
  const coverage = new Map<string, GraphDiagnostic>();
  const record = (issue: GraphDiagnostic) => {
    if (coverage.size >= 64) return;
    const key = JSON.stringify([issue.nodeId, issue.fieldId, issue.branchId]);
    coverage.set(key, issue);
  };
  const compiled: GraphCompiledFlow = {
    ...(preset && { presetResourceGroups: true as const }),
    order: ordered.map(({ id }) => id),
    nodes: {},
    outputBindings: {},
  };
  for (const node of ordered) {
    const ports = nodePorts.get(node.id);
    if (node.type !== 'START' && node.contract !== undefined)
      fail(flow, node, '固定契约只能在开始节点声明');
    if (node.sameHostRelease !== undefined && (node.type !== 'START' || !preset))
      fail(flow, node, '同机发布只能在预设流的开始节点配置');
    if (preset && node.type !== 'START' && node.type !== 'END') {
      const declarations = [
        ...(node.inputs ?? []),
        ...(node.outputs ?? []),
        ...(node.shell?.params ?? []),
        ...(node.shell?.outputs ?? []),
      ];
      const standard = graphOperationPorts(node, flows.get(node.flowId ?? ''));
      const native = new Set(
        [...(standard?.inputs ?? []), ...(standard?.outputs ?? [])].map(({ id }) => id),
      );
      const forbidden = declarations.find((field) => node.type !== 'SHELL' || native.has(field.id));
      if (forbidden)
        fail(
          flow,
          node,
          '预设动作使用系统定义的固定端口，自定义命令可声明自己的脚本字段',
          forbidden,
        );
      for (const { section, key, port } of legacyResourceDefaults) {
        const settings = node[section];
        if (!settings || Reflect.get(settings, key) === undefined) continue;
        const field = ports?.inputs.find(({ id }) => id === port);
        fail(flow, node, `${startConfigIssue}（${section}.${key}）`, field, {
          fieldSection: 'execution',
          sourceNodeId: start.id,
        });
      }
    }
    if (node.declaredPorts)
      validateFunctionalDeclarations(flow, node, flows.get(node.flowId ?? ''));
    if (node.inputDefaults !== undefined) {
      if (!graphRecord(node.inputDefaults) || !ports || ['CONDITION', 'SWITCH'].includes(node.type))
        fail(flow, node, '仅功能节点可以配置固定输入');
      for (const [id, value] of Object.entries(node.inputDefaults)) {
        const field = ports.inputs.find((port) => port.id === id);
        if (preset && graphPresetStartPort(node, id))
          fail(flow, node, `${startConfigIssue}（inputDefaults.${id}）`, field, {
            fieldSection: 'input',
            sourceNodeId: start.id,
          });
        if (!field || !validatesLiteral(field, value, node))
          fail(
            flow,
            node,
            '固定输入不符合端口类型或包含明文凭据',
            field ?? { id, name: id, type: 'TEXT' },
          );
      }
    }
    if (node.environmentDefaults !== undefined) {
      if (!environmentNodes.includes(node.type) || !graphRecord(node.environmentDefaults))
        fail(flow, node, '固定环境变量仅用于构建、Shell 或检查节点');
      for (const [key, value] of Object.entries(node.environmentDefaults))
        if (!safeGraphEnvironmentKey(key) || typeof value !== 'string')
          fail(flow, node, '固定环境变量名无效或值不是文本', { id: key, name: key, type: 'TEXT' });
    }
    const environmentBindings = graphNodeEnvironmentBindings(flow, node);
    if (Object.keys(environmentBindings).length > 30)
      fail(flow, node, '每个节点最多声明 30 个环境变量');
    if (node.inputs !== undefined && node.type !== 'START' && !node.declaredPorts)
      fail(flow, node, '输入只可在开始节点或功能节点声明');
    if (node.environmentSet && node.type !== 'START')
      fail(flow, node, '变量集合引用只能声明在开始节点');
    if (node.type === 'LOAD_ENV') {
      const config = node.loadEnvironment;
      const mapping = config?.pathRule?.paths;
      const fileField = { id: 'envFile', name: '环境文件', type: 'PATH' } as const;
      if (
        mapping &&
        (config?.envFile || !Object.keys(mapping).length || Object.keys(mapping).length > 30)
      )
        fail(flow, node, '请选择单一路径或填写 1–30 条环境文件映射', fileField, {
          fieldSection: 'execution',
        });
      if (!mapping && !config?.envFile && config?.required === true)
        fail(flow, node, '必需环境文件应填写路径或映射', fileField, { fieldSection: 'execution' });
      try {
        for (const file of mapping
          ? Object.values(mapping)
          : config?.envFile
            ? [config.envFile]
            : [])
          environmentFilePath(file);
        if (config?.directory && config.directory !== '.') environmentFilePath(config.directory);
      } catch {
        fail(flow, node, '环境文件必须使用有效的仓库内相对路径', fileField, {
          fieldSection: 'execution',
        });
      }
    }
    if (
      node.outputs !== undefined &&
      !node.declaredPorts &&
      !['END', 'SHELL', 'CHECK'].includes(node.type)
    )
      fail(flow, node, '输出只可在结束节点或功能节点声明');
    if (node.type === 'SHELL' || node.type === 'CHECK') {
      const scriptsIn = graphScriptInputs(node);
      const scriptsOut = graphScriptOutputs(node);
      checkFields(flow, node, scriptsIn, 'INPUT', node.declaredPorts && node.inputs !== undefined);
      checkFields(
        flow,
        node,
        scriptsOut,
        'OUTPUT',
        node.declaredPorts && node.outputs !== undefined,
      );
      for (const field of scriptsIn) {
        if (!safeGraphEnvironmentKey(field.exportName ?? field.id))
          fail(flow, node, '脚本输入导出名须为可用的环境变量名', field);
        if (!graphScriptInputTypes.includes(field.type))
          fail(flow, node, '脚本输入只支持可作为环境变量导出的字段类型', field);
        if (field.type === 'CREDENTIAL' && field.multiple)
          fail(flow, node, '每个脚本环境变量只能关联一个凭据', field);
      }
      const builtinOutputs = new Set(['workspace', 'report', 'exitCode']);
      for (const field of scriptsOut) {
        if (!graphScriptOutputTypes.includes(field.type))
          fail(
            flow,
            node,
            '脚本自定义输出支持文本、数值、布尔值、拉取方式、相对路径、项目仓库和项目服务',
            field,
          );
        if (builtinOutputs.has(field.exportName ?? field.id))
          fail(flow, node, '脚本自定义输出不得使用内置输出名', field);
      }
      for (const field of scriptsIn)
        if (Object.hasOwn(environmentBindings, field.exportName ?? field.id))
          fail(flow, node, '脚本输入的导出名与节点变量重复，请使用一个显式环境绑定', field);
    }
    for (const fields of [ports?.inputs ?? [], ports?.outputs ?? []]) {
      if (new Set(fields.map((field) => field.id)).size !== fields.length)
        fail(flow, node, '功能端口标识不可重复');
    }
    if (graphArtifactDeclarations(node)?.length)
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
      !preset &&
      flow.serviceId &&
      ordered.some(
        (candidate) =>
          candidate.type === 'DEPLOY_ARTIFACT' ||
          candidate.type === 'ROLLBACK_ARTIFACT' ||
          (candidate.type === 'FLOW_CALL' &&
            outputs.get(candidate.id)?.some((port) => port.type === 'RELEASE')),
      ) &&
      !destinations.some((field) => field.type === 'RELEASE' && field.required !== false)
    )
      fail(flow, node, '关联服务的发布流需声明必填的服务发布结果');

    const groups = preset ? selectedResourceGroups(context, node, pathOrders) : undefined;
    for (const group of [groups?.source, groups?.release]) {
      const issue = group?.issue;
      if (issue)
        fail(
          flow,
          node,
          issue.message,
          destinations.find(({ id }) => id === issue.fieldId),
          {
            fieldSection: 'input',
            sourceNodeId: start.id,
            sourceFieldId: issue.sourceFieldId,
          },
        );
    }
    const bindings = new Map(
      destinations.map((field) => {
        if (node.type === 'END') return [field.id, flow.outputBindings?.[field.id]];
        if (groups?.source && ['repository', 'version'].includes(field.id))
          return [field.id, groups.source.bindings[field.id]];
        if (groups?.release && ['service', 'targets'].includes(field.id))
          return [field.id, groups.release.bindings[field.id]];
        const explicit = authoredBinding(flow, node, field.id);
        if (
          preset &&
          explicit &&
          graphPresetStartPort(node, field.id) &&
          fixedPresetResource(explicit)
        )
          fail(flow, node, startConfigIssue, field, {
            fieldSection: 'input',
            sourceNodeId: start.id,
          });
        const declaredDefault =
          node.declaredPorts &&
          node.inputs?.some(({ id }) => id === field.id) &&
          field.defaultValue !== undefined;
        const inferred =
          preset && !explicit ? presetBinding(context, node, field, pathOrders) : undefined;
        if (inferred?.issue) fail(flow, node, inferred.issue, field, { fieldSection: 'input' });
        const binding = explicit
          ? declaredDefault && explicit.onMissing === undefined
            ? { ...explicit, onMissing: 'USE_DEFAULT' as const }
            : explicit
          : (inferred?.binding ?? graphDefaultBinding(flow, node, field.id));
        return [field.id, binding];
      }),
    );
    for (const field of destinations) {
      const binding = bindings.get(field.id);
      if (binding) assertBinding(context, node, field, binding, staticOrder.get(node.id)!);
    }
    for (const [key, binding] of Object.entries(environmentBindings))
      assertBinding(
        context,
        node,
        { id: key, name: key, type: 'TEXT', required: false },
        binding,
        staticOrder.get(node.id)!,
        true,
      );
    const authored = Object.fromEntries(
      [...bindings].filter((item): item is [string, GraphBinding] => item[1] !== undefined),
    );
    if (node.type === 'END') compiled.outputBindings = authored;
    compiled.nodes[node.id] = {
      inputs: node.type === 'START' ? (node.inputs ?? []) : (ports?.inputs ?? []),
      outputs: node.type === 'END' ? (node.outputs ?? []) : (ports?.outputs ?? []),
      inputBindings: node.type === 'END' ? {} : authored,
      environmentBindings,
      dependencies: [...Object.entries(authored), ...Object.entries(environmentBindings)].flatMap(
        ([consumerFieldId, binding]) =>
          producerBindings(binding).map((producer) => ({
            nodeId: producer.nodeId,
            fieldId: producer.fieldId,
            consumerFieldId,
          })),
      ),
    };
    for (const { path, order } of pathOrders) {
      if (!path.active.has(node.id)) continue;
      const ancestors = order.get(node.id)!;
      const has = (id: string) => {
        const binding = bindings.get(id);
        return (
          binding !== undefined &&
          (binding.onMissing === 'USE_DEFAULT' || available(context, binding, ancestors))
        );
      };
      const branch = path.branches.length
        ? `（分支 ${path.branches.map(({ label }) => label).join(' / ')}）`
        : '';
      const location = branchLocation(path);
      if (preset) {
        const workspace = checkoutOnPath(context, bindings.get('workspace'), ancestors);
        const source = checkoutOnPath(context, bindings.get('source'), ancestors);
        if (workspace && source && workspace !== source)
          fail(
            flow,
            node,
            '工作区和 Git 来源必须来自同一次检出' + branch,
            destinations.find(({ id }) => id === 'workspace'),
            { ...location, fieldSection: 'input' },
          );
      }
      for (const field of destinations) {
        const binding = bindings.get(field.id);
        const needsValue = field.required !== false || binding?.onMissing === 'ERROR';
        const hasDefault =
          field.defaultValue !== undefined &&
          (binding === undefined || binding.onMissing === 'USE_DEFAULT');
        if (needsValue && !has(field.id) && !hasDefault) {
          const source = binding && producerBindings(binding)[0];
          record(
            locatedIssue(
              flow,
              node,
              `缺少必填来源${branch}，请绑定开始参数、固定配置或上游输出`,
              field,
              {
                ...location,
                fieldSection: node.type === 'END' ? 'output' : 'input',
                sourceNodeId: source?.nodeId,
                sourceFieldId: source?.fieldId,
              },
            ),
          );
        }
      }
      for (const [key, binding] of Object.entries(environmentBindings)) {
        if (binding.onMissing !== 'ERROR') continue;
        const known = new Map(destinations.map((field) => [field.id, has(field.id)]));
        if (!available(context, binding, ancestors, known))
          record(
            locatedIssue(
              flow,
              node,
              `环境变量缺少可用值${branch}`,
              { id: key, name: key, type: 'TEXT' },
              location,
            ),
          );
      }
      if (node.type === 'BUILD' && !has('repository') && !has('source') && !has('workspace'))
        fail(
          flow,
          node,
          `没有可用的构建源码${branch}，请绑定工作区、实际源码版本或项目仓库`,
          destinations.find((port) => port.id === 'workspace'),
          location,
        );
      if (
        (node.type === 'SHELL' || node.type === 'CHECK') &&
        (node.shell?.location === 'TARGET'
          ? !has('targets') && bindings.get('targets')?.kind !== 'INPUT'
          : node.shell?.location !== 'MANAGER' && !has('workspace') && !has('targets'))
      )
        fail(
          flow,
          node,
          `缺少脚本执行位置${branch}，请绑定工作区或服务器`,
          destinations.find((port) => port.id === 'targets'),
          { ...location, fieldSection: 'input' },
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
          location,
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
          location,
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
          location,
        );
      if ((node.type === 'DEPLOY_ARTIFACT' || node.type === 'ROLLBACK_ARTIFACT') && !has('service'))
        record(
          locatedIssue(
            flow,
            node,
            `缺少项目服务来源${branch}`,
            destinations.find((port) => port.id === 'service'),
            location,
          ),
        );
      if (preset && usesReleaseGroup(node) && !has('targets')) {
        const target = bindings.get('targets');
        record(
          locatedIssue(
            flow,
            node,
            `开始节点的发布组合缺少目标${branch}`,
            destinations.find((port) => port.id === 'targets'),
            {
              ...location,
              fieldSection: 'input',
              sourceNodeId: start.id,
              sourceFieldId: target?.kind === 'INPUT' ? target.fieldId : undefined,
            },
          ),
        );
      }
      if (
        node.type === 'SOURCE_REVIEW' &&
        !node.approval?.buildNodeId &&
        Number(has('source')) + Number(has('artifact')) !== 1
      )
        fail(flow, node, '源码审核须关联构建，或绑定一个实际源码来源或一组产物');
    }
  }
  const gated = new Set<string>();
  for (const gate of ordered) {
    if (gate.type === 'SOURCE_REVIEW' && gate.approval?.buildNodeId) {
      const buildId = gate.approval.buildNodeId;
      const selection = { id: 'buildNodeId', name: '关联构建节点', type: 'TEXT' } as const;
      const build = nodes.get(buildId);
      const review = build && compiled.nodes[build.id]?.inputBindings.review;
      if (!build || build.type !== 'BUILD' || !staticOrder.get(buildId)?.has(gate.id))
        fail(flow, gate, '请选择当前执行流中位于下游的构建节点', selection);
      if (
        review?.kind !== 'OUTPUT' ||
        review.nodeId !== gate.id ||
        review.fieldId !== 'review' ||
        (review.onMissing !== undefined && review.onMissing !== 'ERROR')
      )
        fail(
          flow,
          build,
          '关联构建须直接使用对应审核节点的审核凭证，且凭证不可省略',
          { id: 'review', name: '审核凭证', type: 'REVIEW' },
          { sourceNodeId: gate.id, sourceFieldId: 'review' },
        );
      for (const { path, order } of pathOrders) {
        const reachesReview = path.active.has(gate.id);
        const reachesBuild = path.active.has(buildId);
        if (reachesReview !== reachesBuild || (reachesBuild && !order.get(buildId)?.has(gate.id)))
          fail(
            flow,
            gate,
            '关联构建与源码审核必须处于同一执行路径，且构建须经过该审核',
            selection,
            {
              sourceNodeId: buildId,
              ...branchLocation(path),
            },
          );
      }
    }
    if (gate.type !== 'APPROVAL' || !gate.approval?.releaseNodeId) continue;
    const releaseId = gate.approval.releaseNodeId;
    const release = ordered.find(({ id }) => id === releaseId);
    if (
      !release ||
      (release.type !== 'DEPLOY_ARTIFACT' && release.type !== 'ROLLBACK_ARTIFACT') ||
      !staticOrder.get(releaseId)?.has(gate.id) ||
      gated.has(releaseId)
    )
      fail(flow, gate, '请选择唯一关联且位于下游的部署或回滚节点');
    gated.add(releaseId);
    const artifact = compiled.nodes[releaseId]?.inputBindings.artifact;
    const previous = compiled.nodes[releaseId]?.inputBindings.afterRelease;
    for (const { path, order } of pathOrders) {
      if (!path.active.has(releaseId)) continue;
      const earlier = order.get(gate.id);
      if (
        !earlier ||
        !order.get(releaseId)?.has(gate.id) ||
        !artifact ||
        !available(context, artifact, earlier) ||
        (previous && !available(context, previous, earlier))
      )
        fail(flow, gate, '每条发布路径都须经过对应审批，审批时必须已经取得产物和关联发布结果');
    }
  }
  for (const node of ordered) {
    if (
      !['DEPLOY_ARTIFACT', 'ROLLBACK_ARTIFACT'].includes(node.type) ||
      node.deploy?.artifactPath?.trim()
    )
      continue;
    const binding = compiled.nodes[node.id]?.inputBindings.artifact;
    if (
      binding &&
      producerBindings(binding).some(({ nodeId, fieldId }) =>
        nodes
          .get(nodeId)
          ?.build?.artifacts?.some(
            (artifact) =>
              artifact.collection === 'WORK_DIRECTORY' &&
              ((artifact.id ?? artifact.name) === fieldId || fieldId === 'artifacts'),
          ),
      )
    )
      fail(flow, node, '请选择工作目录快照的子路径，或填写 . 使用整个目录', undefined, {
        fieldId: 'artifactPath',
        fieldSection: 'execution',
      });
  }
  const missing = [...coverage.values()];
  if (missing.length) throw new GraphCompileError(missing[0]!, missing);
  return compiled;
}

function producerBindings(binding: GraphBinding): Extract<GraphBinding, { kind: 'OUTPUT' }>[] {
  switch (binding.kind) {
    case 'OUTPUT':
      return [binding];
    case 'FIRST_AVAILABLE':
      return binding.sources.flatMap(producerBindings);
    case 'AS_GIT_REF':
    case 'PROJECT_VALUE':
      return producerBindings(binding.source);
    default:
      return [];
  }
}

export function flowCandidateCatalog(
  flow: GraphFlow,
  flows: GraphFlow[],
  ordered: GraphNode[],
  nodeId?: string,
) {
  const start = flow.nodes.find(({ type }) => type === 'START');
  if (!start) return { nodes: {} };
  // Only derived, acyclic control paths reach this catalog. Until validation can
  // prove every branch, conservative candidates still let the draft be repaired.
  const staticOrder = predecessors(flow.edges, ordered);
  let paths: { path: PathScenario; order: Map<string, Set<string>> }[] = [];
  try {
    paths = graphBranchPaths(flow, ordered).map((path) => ({
      path,
      order: predecessors(path.edges, ordered),
    }));
  } catch (error) {
    if (!(error instanceof GraphCompileError)) throw error;
  }
  const inputs = new Map((start.inputs ?? []).map((field) => [field.id, field]));
  const called = new Map(flows.map((entry) => [entry.id, entry]));
  const ports = new Map(
    ordered.map((node) => [
      node.id,
      graphModulePorts(node, node.flowId ? called.get(node.flowId) : undefined),
    ]),
  );
  const outputs = new Map(ordered.map((node) => [node.id, ports.get(node.id)?.outputs ?? []]));
  const context: BindingContext = {
    flow,
    start,
    inputs,
    outputs,
    flows: called,
    nodes: new Map(ordered.map((node) => [node.id, node])),
    nodeInputs: new Map(ordered.map((node) => [node.id, ports.get(node.id)?.inputs ?? []])),
  };
  return {
    nodes: Object.fromEntries(
      ordered
        .filter(({ id }) => !nodeId || id === nodeId)
        .map((node) => {
          const groups =
            start.contract === 'PRESET' ? selectedResourceGroups(context, node, paths) : undefined;
          const candidates: GraphCandidate[] = [];
          for (const field of inputs.values())
            candidates.push({
              label: '开始参数 · ' + field.name,
              referenceName: 'start.' + (field.referenceName ?? field.id),
              field,
              binding: { kind: 'INPUT', fieldId: field.id },
              availability: guarantee(field) ? 'ALWAYS' : 'CONDITIONAL',
              branches: [],
            });
          for (const { id } of graphContextFields) {
            const field = contextSource(context, id)!;
            candidates.push({
              label: '系统上下文 · ' + field.name,
              referenceName: 'context.' + id,
              field,
              binding: { kind: 'CONTEXT', fieldId: id },
              availability: guarantee(field) ? 'ALWAYS' : 'CONDITIONAL',
              branches: [],
            });
          }
          const eligible = paths.filter(({ path }) => path.active.has(node.id));
          const visibleSources = [...(staticOrder.get(node.id) ?? new Set<string>())];
          const references = visibleSources.map((id) => context.nodes.get(id)?.referenceName ?? id);
          for (const sourceId of staticOrder.get(node.id) ?? []) {
            const producer = context.nodes.get(sourceId)!;
            const reference = producer.referenceName ?? producer.id;
            const producerLabel =
              references.indexOf(reference) === references.lastIndexOf(reference)
                ? producer.name
                : `${producer.name}（${producer.id}）`;
            const present = eligible.filter(({ order }) => order.get(node.id)?.has(sourceId));
            if (eligible.length && !present.length) continue;
            const branches = [
              ...new Set(present.flatMap(({ path }) => path.branches.map(({ label }) => label))),
            ];
            for (const field of outputs.get(sourceId) ?? [])
              candidates.push({
                label: producerLabel + ' · ' + field.name,
                referenceName: reference + '.' + (field.referenceName ?? field.id),
                field,
                binding: { kind: 'OUTPUT', nodeId: producer.id, fieldId: field.id },
                availability:
                  eligible.length && eligible.length === present.length && guarantee(field)
                    ? 'ALWAYS'
                    : 'CONDITIONAL',
                branches,
              });
          }
          return [
            node.id,
            {
              inputs:
                node.type === 'START' ? (node.inputs ?? []) : (ports.get(node.id)?.inputs ?? []),
              outputs: node.type === 'END' ? (node.outputs ?? []) : (outputs.get(node.id) ?? []),
              candidates,
              ...(groups?.source && { sourceGroups: groups.source.candidates }),
              ...(groups?.release && { releaseGroups: groups.release.candidates }),
              automaticInputBindings: Object.fromEntries(
                (ports.get(node.id)?.inputs ?? []).flatMap((field) => {
                  const binding =
                    groups?.source && ['repository', 'version'].includes(field.id)
                      ? groups.source.bindings[field.id]
                      : groups?.release && ['service', 'targets'].includes(field.id)
                        ? groups.release.bindings[field.id]
                        : start.contract === 'PRESET'
                          ? presetBinding(context, node, field, paths).binding
                          : suggestedInputBinding(context, node, field, staticOrder, paths);
                  return binding ? [[field.id, binding]] : [];
                }),
              ),
            },
          ];
        }),
    ),
  };
}
