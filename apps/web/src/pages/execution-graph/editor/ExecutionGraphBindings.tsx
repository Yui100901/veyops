import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useResource } from '../../../api';
import { Field } from '../../../components';
import type { ProjectDetail, Server } from '../../../models';
import {
  graphPresetTypePatch,
  matchingGraphPreset,
  presetReference,
  scriptInputTypes,
  scriptOutputTypes,
} from './graph-field-presets';
export { suggestedGraphPortReference } from './graph-field-presets';
import {
  acceptsFixedGraphValue,
  GraphBindingField,
  GraphFieldValue,
  hasMissingGraphBindingSource,
} from './ExecutionGraphFields';
import type { BindingChoice } from './ExecutionGraphFields';
import {
  effectiveNodeType,
  graphDynamicOutlets,
  graphKey,
  graphNodeFamily,
  graphProjectionLabels,
} from '../execution-graph-definition';
import type {
  GraphBinding,
  GraphCanvas,
  GraphCandidate,
  GraphCatalog,
  GraphEndpoint,
  GraphField,
  GraphFieldType,
  GraphNode,
} from '../execution-graph-definition';

export function moduleFields(
  node: GraphNode,
  kind: 'inputs' | 'outputs',
  canvas: GraphCanvas,
  catalog?: GraphCatalog,
): GraphField[] {
  const declared = node[kind] ?? [];
  const standard = operationFields(node, kind, canvas, catalog);
  if (graphNodeFamily(node) !== 'function') return standard;
  return [
    ...standard.map((port) => {
      const custom = declared.find(({ id }) => id === port.id);
      return custom
        ? {
            ...port,
            name: custom.name,
            referenceName: custom.referenceName ?? port.referenceName,
            defaultValue: custom.defaultValue ?? port.defaultValue,
          }
        : port;
    }),
    ...declared.filter(({ id }) => !standard.some((port) => port.id === id)),
  ];
}

function operationFields(
  node: GraphNode,
  kind: 'inputs' | 'outputs',
  canvas: GraphCanvas,
  catalog?: GraphCatalog,
): GraphField[] {
  const operation = effectiveNodeType(node);
  if (operation === 'FLOW_CALL') {
    const flow = canvas.endpoints.find(({ startId }) => startId === node.flowId);
    return (
      canvas.nodes.find(({ id }) => id === (kind === 'inputs' ? flow?.startId : flow?.endId))?.[
        kind
      ] ?? []
    );
  }
  const standard = catalog?.modules[operation]?.[kind] ?? [];
  if (operation === 'CONDITION' && node.branch)
    return kind === 'inputs'
      ? standard.map((field) => (field.id === 'value' ? { ...field, required: true } : field))
      : [...standard, { id: 'branchId', name: '分支标识', type: 'TEXT', required: true }];
  if (kind === 'inputs' && ['DEPLOY_ARTIFACT', 'ROLLBACK_ARTIFACT'].includes(operation))
    return standard.map((field) =>
      field.id === 'artifact'
        ? {
            ...field,
            multiple: false,
            acceptedArtifactTypes:
              node.deploy?.method === 'COMPOSE'
                ? ['DOCKER_IMAGE']
                : node.deploy?.method === 'FILE'
                  ? ['FILE', 'DIRECTORY']
                  : undefined,
          }
        : field,
    );
  if (operation === 'BUILD' && kind === 'inputs')
    return [
      ...standard,
      ...(node.build?.dependencies ?? []).map((alias): GraphField => ({
        id: 'dependency_' + alias,
        name: '源码依赖 · ' + alias,
        type: 'WORKSPACE',
        required: true,
      })),
    ];
  const script = operation === 'SHELL' || operation === 'CHECK';
  if (script && kind === 'inputs') return [...standard, ...(node.shell?.params ?? [])];
  if (
    kind === 'outputs' &&
    (script || operation === 'BUILD' || operation === 'REGISTER_ARTIFACT')
  ) {
    const artifacts =
      operation === 'BUILD'
        ? node.build?.artifacts
        : script
          ? node.shell?.artifacts
          : node.registerArtifacts?.artifacts;
    return [
      ...(operation === 'BUILD' && artifacts?.length
        ? standard.filter(({ id }) => id !== 'artifact')
        : standard),
      ...(script && artifacts?.length
        ? [
            {
              id: 'artifacts',
              name: '产物列表',
              type: 'ARTIFACT' as const,
              multiple: true,
              required: artifacts.some(({ required }) => required !== false),
            },
          ]
        : []),
      ...(artifacts ?? [])
        .filter(({ id, name }) => (id ?? name) && (id ?? name) !== 'artifacts')
        .map(({ id, name, referenceName, type, required }): GraphField => ({
          id: id ?? name,
          name,
          referenceName,
          type: 'ARTIFACT',
          artifactType: type,
          required: required !== false,
        })),
    ];
  }
  return standard;
}

function addFunctionField(
  fields: GraphField[],
  input: boolean,
  port?: GraphField,
  defaultValue?: unknown,
  preset?: GraphField,
): GraphField {
  const id = port?.id ?? graphKey('field');
  const definition = port ?? preset;
  const prefix = definition ? presetReference(definition) : input ? 'INPUT' : 'OUTPUT';
  let referenceName = prefix;
  for (let i = 2; fields.some((field) => field.referenceName === referenceName); i++)
    referenceName = prefix + '_' + i;
  return {
    id,
    name: definition?.name ?? (input ? '自定义输入' : '自定义输出'),
    referenceName,
    type: definition?.type ?? 'TEXT',
    required: port?.required ?? true,
    ...(definition?.multiple && { multiple: true }),
    ...(definition?.artifactType && { artifactType: definition.artifactType }),
    ...(input && defaultValue !== undefined && { defaultValue }),
  };
}

function AddFunctionField({
  kind,
  node,
  nativePorts,
  allowCustom,
  catalog,
  candidates = [],
  patch,
}: {
  kind: 'inputs' | 'outputs';
  node: GraphNode;
  nativePorts: GraphField[];
  allowCustom: boolean;
  catalog?: GraphCatalog;
  candidates?: GraphCandidate[];
  patch: (fields: Partial<GraphNode>) => void;
}) {
  const input = kind === 'inputs';
  const [selection, setSelection] = useState('');
  const declared = node[kind] ?? [];
  const native = nativePorts.filter(
    (port) => !port.multiple && !declared.some(({ id }) => id === port.id),
  );
  const current = native.find(({ id }) => id === selection);
  const standards = input ? catalog?.inputPresets : catalog?.outputPresets;
  const allowedTypes = input
    ? (catalog?.scriptInputTypes ?? scriptInputTypes)
    : (catalog?.scriptOutputTypes ?? scriptOutputTypes);
  const presets = allowCustom
    ? (standards ?? []).filter(
        (field) =>
          !field.multiple &&
          allowedTypes.includes(field.type) &&
          !declared.some(({ referenceName }) => referenceName === presetReference(field)),
      )
    : [];
  const selectedPreset = presets.find((field) => selection === 'preset:' + presetReference(field));
  function optionLabel(field: GraphField) {
    const reference = presetReference(field);
    const upstream = candidates
      .filter(
        ({ field: source, binding }) =>
          (binding.kind === 'OUTPUT' || binding.kind === 'INPUT') &&
          (source.referenceName ?? source.exportName ?? source.id) === reference &&
          compatible(source, field),
      )
      .map(
        ({ label, availability }) => label + (availability === 'CONDITIONAL' ? '（按分支）' : ''),
      );
    return (
      field.name + ' · ' + reference + (upstream.length ? ' · 已有来源 ' + upstream.join('、') : '')
    );
  }
  if (!native.length && !allowCustom) return null;
  return (
    <div className="graph-field-pair graph-port-add">
      <Field label={input ? '添加输入' : '添加输出'}>
        <select value={selection} onChange={(event) => setSelection(event.target.value)}>
          <option value="">选择要声明的字段</option>
          {allowCustom && <option value="__custom">自定义字段</option>}
          {!!presets.length && (
            <optgroup label="系统预设变量">
              {presets.map((field) => (
                <option key={presetReference(field)} value={'preset:' + presetReference(field)}>
                  {optionLabel(field)}
                </option>
              ))}
            </optgroup>
          )}
          {!!native.length && (
            <optgroup label="执行动作端口">
              {native.map((field) => (
                <option key={field.id} value={field.id}>
                  {optionLabel(field)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>
      <button
        className="button secondary small"
        type="button"
        disabled={selection !== '__custom' && !current && !selectedPreset}
        onClick={() => {
          const defaultValue = current && input ? nodeFixedInputValue(node, current) : undefined;
          patch({
            ...(current && input && patchInputDefault(node, current.id, undefined)),
            [kind]: [
              ...declared,
              addFunctionField(declared, input, current, defaultValue, selectedPreset),
            ],
          });
          setSelection('');
        }}
      >
        <Plus size={14} /> 添加{input ? '输入' : '输出'}
      </button>
    </div>
  );
}

function FunctionFieldNames({
  field,
  native,
  preset,
  input,
  allowedTypes,
  catalog,
  canEdit,
  patch,
  remove,
}: {
  field: GraphField;
  native: boolean;
  preset?: GraphField;
  input: boolean;
  allowedTypes?: GraphFieldType[];
  catalog?: GraphCatalog;
  canEdit: boolean;
  patch: (value: Partial<GraphField>) => void;
  remove: () => void;
}) {
  const fieldTypes = catalog?.fieldTypes ?? { [field.type]: field.type };
  const invalidReference = !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(field.referenceName ?? '');
  return (
    <>
      <div className="graph-field-pair graph-port-names">
        <Field label="显示名称">
          <input
            readOnly={!canEdit}
            maxLength={100}
            value={field.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>
        <Field
          label="引用名称"
          hint={invalidReference ? '使用英文字母或下划线开头，可包含数字。' : undefined}
        >
          <input
            readOnly={!canEdit}
            aria-invalid={invalidReference}
            maxLength={64}
            placeholder="EXAMPLE_NAME"
            value={field.referenceName ?? field.id}
            onChange={(event) => {
              const referenceName = event.target.value;
              const typedPreset = native
                ? undefined
                : matchingGraphPreset(
                    referenceName,
                    catalog,
                    input,
                    ({ type, multiple }) =>
                      !multiple && (!allowedTypes || allowedTypes.includes(type)),
                  );
              patch({ ...graphPresetTypePatch(field, typedPreset), referenceName });
            }}
          />
        </Field>
      </div>
      {native || preset ? (
        <p className="field-note">
          {preset ? '系统预设 ' + presetReference(preset) : '执行端口'} · {fieldTypes[field.type]}
        </p>
      ) : (
        <Field label="数据类型">
          <select
            disabled={!canEdit}
            value={field.type}
            onChange={(event) =>
              patch({
                type: event.target.value as GraphFieldType,
                defaultValue: undefined,
                artifactType: undefined,
              })
            }
          >
            {Object.entries(fieldTypes)
              .filter(
                ([key]) =>
                  key === field.type ||
                  (allowedTypes
                    ? allowedTypes.includes(key as GraphFieldType)
                    : key !== 'ENVIRONMENT'),
              )
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
        </Field>
      )}
      {canEdit && (
        <button type="button" className="button secondary small graph-port-remove" onClick={remove}>
          <Trash2 size={14} /> 移除声明
        </button>
      )}
    </>
  );
}

function legacyGitInput(node: GraphNode, field: GraphField) {
  if (field.id === 'repository') return node.checkout?.repositoryId ?? node.build?.repositoryId;
  if (field.id === 'fetchMode' && node.checkout?.fullClone !== undefined)
    return node.checkout.fullClone ? 'FULL' : 'LATEST';
  if (field.id !== 'version') return undefined;
  const config = node.checkout ?? node.build;
  if (!config) return undefined;
  if (config.commitSha) return { kind: 'COMMIT', value: config.commitSha };
  if (node.checkout?.tag) return { kind: 'TAG', value: node.checkout.tag };
  if (config.branch) return { kind: 'BRANCH', value: config.branch };
  return undefined;
}

export function nodeFixedInputValue(node: GraphNode, field: GraphField) {
  const explicit =
    graphNodeFamily(node) === 'function' && node.inputs?.find(({ id }) => id === field.id);
  return (
    (explicit ? explicit.defaultValue : undefined) ??
    node.inputDefaults?.[field.id] ??
    legacyGitInput(node, field) ??
    field.defaultValue
  );
}

function patchInputDefault(node: GraphNode, fieldId: string, value: unknown): Partial<GraphNode> {
  const inputDefaults = { ...node.inputDefaults };
  if (value === undefined) delete inputDefaults[fieldId];
  else inputDefaults[fieldId] = value;
  return {
    inputDefaults,
    ...(node.shell?.params?.some(
      ({ id, defaultValue }) => id === fieldId && defaultValue !== undefined,
    ) && {
      shell: {
        ...node.shell,
        params: node.shell.params.map((field) =>
          field.id === fieldId ? { ...field, defaultValue: undefined } : field,
        ),
      },
    }),
    ...(node.checkout &&
      ['repository', 'version', 'fetchMode'].includes(fieldId) && {
        checkout: {
          ...node.checkout,
          ...(fieldId === 'repository' && { repositoryId: undefined }),
          ...(fieldId === 'version' && {
            mode: undefined,
            branch: undefined,
            tag: undefined,
            commitSha: undefined,
          }),
          ...(fieldId === 'fetchMode' && { fullClone: undefined }),
        },
      }),
    ...(node.build &&
      ['repository', 'version'].includes(fieldId) && {
        build: {
          ...node.build,
          ...(fieldId === 'repository' && { repositoryId: undefined }),
          ...(fieldId === 'version' && { branch: undefined, commitSha: undefined }),
        },
      }),
  };
}

function compatible(source: GraphField, input: GraphField) {
  return (
    (source.type === input.type || input.acceptedTypes?.includes(source.type)) &&
    (Boolean(source.multiple) === Boolean(input.multiple) ||
      (input.type === 'ARTIFACT' && input.multiple && !source.multiple)) &&
    (!source.artifactType ||
      ((!input.artifactType || input.artifactType === source.artifactType) &&
        (!input.acceptedArtifactTypes ||
          input.acceptedArtifactTypes.includes(source.artifactType))))
  );
}

export function canCreateStartParameter(field: GraphField) {
  return (
    field.source !== 'CURRENT_RUN' &&
    (!field.multiple || field.type === 'ARTIFACT') &&
    [
      'TEXT',
      'NUMBER',
      'BOOLEAN',
      'REPOSITORY',
      'GIT_REF',
      'GIT_FETCH_MODE',
      'ENVIRONMENT_SET',
      'SERVICE',
      'TARGETS',
      'ARTIFACT',
      'PATH',
      'IMAGE',
      'CREDENTIAL',
    ].includes(field.type)
  );
}

function configuredFallback(
  node: GraphNode,
  field: GraphField,
  start: GraphNode | undefined,
  endpoint?: GraphEndpoint,
) {
  const operation = effectiveNodeType(node);
  if (nodeFixedInputValue(node, field) !== undefined) return '采用节点默认值。';
  if (
    field.id === 'version' &&
    !nodeFixedInputValue(node, field) &&
    (operation === 'CHECKOUT' || operation === 'BUILD')
  )
    return '未指定版本时，预览解析仓库默认分支并固定实际提交。';
  if (field.id === 'service' && endpoint?.serviceId) return '使用执行流关联的服务。';
  if (field.id === 'targets' && node.shell?.serverId) return '节点已指定执行服务器。';
  if (
    field.id === 'path' &&
    node.registerArtifacts?.artifacts?.length &&
    node.registerArtifacts.artifacts.every(({ path, type }) => path || type === 'DOCKER_IMAGE')
  )
    return '使用各产物设置的工作区路径。';
  const scope: Partial<Record<string, GraphFieldType>> = {
    service: 'SERVICE',
    environment: 'ENVIRONMENT',
    targets: 'TARGETS',
  };
  const candidates =
    start?.inputs?.filter((input) => input.type === scope[field.id] && !input.multiple) ?? [];
  if (candidates.length === 1) return `默认来源 · 开始参数 · ${candidates[0]!.name}`;
  return undefined;
}

function matchingChoices(
  candidates: GraphCandidate[],
  field: GraphField,
  canvas?: GraphCanvas,
  catalog?: GraphCatalog,
  endpoint?: GraphEndpoint,
) {
  return candidates.flatMap((source): BindingChoice[] => {
    const { binding } = source;
    const producer =
      binding.kind === 'OUTPUT' ? canvas?.nodes.find(({ id }) => id === binding.nodeId) : undefined;
    if (field.source === 'CURRENT_RUN') {
      if (
        !producer ||
        (!['BUILD', 'REGISTER_ARTIFACT'].includes(effectiveNodeType(producer)) &&
          source.field.source !== 'CURRENT_RUN')
      )
        return [];
    }
    if (field.type === 'RELEASE' && endpoint?.serviceId && producer) {
      const service = endpoint.inputBindings?.[producer.id]?.service;
      const selection =
        effectiveNodeType(producer) === 'FLOW_CALL'
          ? canvas?.endpoints.find(({ startId }) => startId === producer.flowId)?.serviceId
          : service?.kind === 'VALUE'
            ? service.value
            : !service
              ? nodeFixedInputValue(producer, { id: 'service', name: '项目服务', type: 'SERVICE' })
              : undefined;
      const serviceId =
        typeof selection === 'object' && selection !== null && 'serviceId' in selection
          ? selection.serviceId
          : selection;
      if (serviceId !== undefined && serviceId !== endpoint.serviceId) return [];
    }
    const choice = { ...source, typeLabel: catalog?.fieldTypes[source.field.type] };
    if (compatible(source.field, field)) return [choice];
    if (
      field.type !== 'GIT_REF' ||
      field.multiple ||
      source.field.type !== 'TEXT' ||
      source.field.multiple
    )
      return [];
    return (['BRANCH', 'TAG'] as const).map((refKind) => ({
      ...choice,
      label: source.label + (refKind === 'BRANCH' ? ' → 分支' : ' → 标签'),
      binding: { kind: 'AS_GIT_REF', refKind, source: source.binding },
    }));
  });
}

function namedSources(binding: GraphBinding, candidates: GraphCandidate[]): string[] {
  if (binding.kind === 'FIRST_AVAILABLE')
    return binding.sources.flatMap((item) => namedSources(item, candidates));
  if (binding.kind === 'PROJECT_VALUE') return namedSources(binding.source, candidates);
  if (binding.kind === 'AS_GIT_REF') return namedSources(binding.source, candidates);
  const candidate = candidates.find(
    ({ binding: source }) =>
      (source.kind === 'INPUT' && binding.kind === 'INPUT' && source.fieldId === binding.fieldId) ||
      (source.kind === 'OUTPUT' &&
        binding.kind === 'OUTPUT' &&
        source.nodeId === binding.nodeId &&
        source.fieldId === binding.fieldId),
  );
  return candidate ? [candidate.label] : [];
}

export function ExecutionGraphBindings({
  canvas,
  node,
  endpoint,
  flowEdgeIndexes,
  catalog,
  directory,
  project,
  canEdit,
  update,
  section = 'input',
  patchNode,
  createStartParameter,
  repairFieldIds,
}: {
  canvas: GraphCanvas;
  node: GraphNode;
  endpoint?: GraphEndpoint;
  flowEdgeIndexes?: Set<number>;
  catalog?: GraphCatalog;
  directory?: GraphCatalog['flows'];
  project: ProjectDetail;
  canEdit: boolean;
  update: (newEndpoint: GraphEndpoint) => void;
  section?: 'input' | 'output' | 'environment';
  patchNode?: (fields: Partial<GraphNode>) => void;
  createStartParameter?: (field: GraphField) => void;
  repairFieldIds?: ReadonlySet<string>;
}) {
  const operation = effectiveNodeType(node);
  const edges = canvas.edges.filter((_, index) => flowEdgeIndexes?.has(index));
  const start = canvas.nodes.find(({ id }) => id === endpoint?.startId);
  const ancestors = new Set<string>();
  const pending = [node.id];
  for (const id of pending) {
    for (const { from, to } of edges) {
      if (to !== id || ancestors.has(from)) continue;
      ancestors.add(from);
      pending.push(from);
    }
  }
  const isEnd = operation === 'END';
  const functional = graphNodeFamily(node) === 'function';
  const compiled = endpoint && directory?.[endpoint.startId]?.nodes[node.id];
  const script = operation === 'SHELL' || operation === 'CHECK';
  const custom = operation === 'SHELL';
  const fixedContract = functional && !custom && start?.contract === 'PRESET';
  const inputTypes = catalog?.scriptInputTypes ?? scriptInputTypes;
  const outputTypes = catalog?.scriptOutputTypes ?? scriptOutputTypes;
  const nativeInputs = functional ? operationFields(node, 'inputs', canvas, catalog) : [];
  const nativeOutputs = functional ? operationFields(node, 'outputs', canvas, catalog) : [];
  const functionPreset = (field: GraphField, kind: 'inputs' | 'outputs') => {
    const input = kind === 'inputs';
    const ports = input ? nativeInputs : nativeOutputs;
    if (!script || ports.some(({ id }) => id === field.id)) return undefined;
    return matchingGraphPreset(
      field.referenceName,
      catalog,
      input,
      ({ type, multiple }) => !multiple && (input ? inputTypes : outputTypes).includes(type),
    );
  };
  const effectiveDeclaration = (field: GraphField, kind: 'inputs' | 'outputs') => ({
    ...field,
    ...graphPresetTypePatch(field, functionPreset(field, kind)),
  });
  const availableFields = (
    isEnd
      ? (compiled?.outputs ?? node.outputs ?? [])
      : operation === 'SOURCE_REVIEW' && node.approval?.buildNodeId
        ? []
        : (compiled?.inputs ?? moduleFields(node, 'inputs', canvas, catalog))
  ).map((field) => effectiveDeclaration(field, 'inputs'));
  const fields =
    node.shell?.location === 'MANAGER' && ['SHELL', 'CHECK'].includes(operation)
      ? availableFields.filter(({ id }) => id !== 'targets')
      : availableFields;
  const bindings = isEnd ? endpoint?.outputBindings : endpoint?.inputBindings?.[node.id];
  const context = catalog?.contextFields ?? [];
  const fallbackCandidates: GraphCandidate[] = [
    ...(start?.inputs ?? []).map((field) => ({
      field,
      label: '开始 · ' + field.name,
      binding: { kind: 'INPUT' as const, fieldId: field.id },
      referenceName: 'start.' + (field.referenceName ?? field.id),
      availability: 'ALWAYS' as const,
      branches: [],
    })),
    ...context.map((field) => ({
      field,
      label: '运行上下文 · ' + field.name,
      binding: { kind: 'CONTEXT' as const, fieldId: field.id },
      referenceName: 'context.' + (field.referenceName ?? field.id),
      availability: 'ALWAYS' as const,
      branches: [],
    })),
    ...canvas.nodes
      .filter(({ id }) => ancestors.has(id))
      .flatMap((source) =>
        moduleFields(source, 'outputs', canvas, catalog).map((field) => ({
          field,
          label: source.name + ' · ' + field.name,
          binding: { kind: 'OUTPUT' as const, nodeId: source.id, fieldId: field.id },
          referenceName:
            (source.referenceName ?? source.id) + '.' + (field.referenceName ?? field.id),
          availability: 'ALWAYS' as const,
          branches: [],
        })),
      ),
  ];
  const scopedReviews = canvas.nodes.filter(
    (candidate) =>
      effectiveNodeType(candidate) === 'SOURCE_REVIEW' && candidate.approval?.buildNodeId,
  );
  const requiredReview =
    operation === 'BUILD'
      ? scopedReviews.find(
          ({ id, approval }) => ancestors.has(id) && approval?.buildNodeId === node.id,
        )
      : undefined;
  const candidates = (compiled?.candidates ?? fallbackCandidates).filter(
    ({ binding }) =>
      binding.kind !== 'OUTPUT' ||
      binding.fieldId !== 'review' ||
      !scopedReviews.some(
        ({ id, approval }) => id === binding.nodeId && approval?.buildNodeId !== node.id,
      ),
  );
  const outputs = !isEnd
    ? (compiled?.outputs ?? moduleFields(node, 'outputs', canvas, catalog))
    : [];
  const supportsEnvironment = ['BUILD', 'SHELL', 'CHECK'].includes(operation);
  const hasDeclaredInput = (fieldId: string) =>
    functional && node.inputs?.some(({ id }) => id === fieldId);
  const patchDeclaration = (
    kind: 'inputs' | 'outputs',
    fieldId: string,
    patch?: Partial<GraphField>,
  ) =>
    patchNode?.({
      [kind]: (node[kind] ?? []).flatMap((field) => {
        if (field.id !== fieldId) return [field];
        return patch
          ? [
              {
                ...effectiveDeclaration(field, kind),
                ...patch,
                required: true,
                multiple: undefined,
                options: undefined,
              },
            ]
          : [];
      }),
    });
  if (section === 'output') {
    const declared = custom
      ? (node.outputs ?? []).filter((field) => !nativeOutputs.some(({ id }) => id === field.id))
      : [];
    const implicit = outputs.filter((port) => !declared.some(({ id }) => id === port.id));
    return (
      <>
        {canEdit && patchNode && custom && (
          <AddFunctionField
            kind="outputs"
            node={node}
            nativePorts={[]}
            allowCustom
            catalog={catalog}
            patch={patchNode}
          />
        )}
        {declared.map((raw) => {
          const field = effectiveDeclaration(raw, 'outputs');
          const native = nativeOutputs.some(({ id }) => id === field.id);
          return (
            <section
              key={field.id}
              className="graph-inspector-port"
              data-graph-node-field={field.id}
            >
              <FunctionFieldNames
                field={field}
                native={native}
                preset={functionPreset(field, 'outputs')}
                input={false}
                allowedTypes={script ? outputTypes : undefined}
                catalog={catalog}
                canEdit={canEdit}
                patch={(value) => patchDeclaration('outputs', field.id, value)}
                remove={() => patchDeclaration('outputs', field.id)}
              />
              {script && !native && acceptsFixedGraphValue(field) && (
                <GraphFieldValue
                  project={project}
                  field={{ ...field, name: '默认值', required: false }}
                  value={field.defaultValue}
                  disabled={!canEdit}
                  canManageProjectResources={canEdit}
                  repositoryAddress={field.type === 'REPOSITORY'}
                  change={(defaultValue) => patchDeclaration('outputs', field.id, { defaultValue })}
                />
              )}
            </section>
          );
        })}
        {script && declared.some(({ id }) => !nativeOutputs.some((port) => port.id === id)) && (
          <p className="field-note">
            脚本用 <code>{'VEYOPS_OUTPUT={"OUTPUT":"ok"}'}</code> 输出结果，JSON 键使用引用名称。
          </p>
        )}
        {!!implicit.length && (
          <details className="graph-field-card" open={operation === 'CHECKOUT' || undefined}>
            <summary>查看执行结果字段</summary>
            <dl className="graph-field-values">
              {implicit.map((field) => (
                <div key={field.id} data-graph-node-field={field.id}>
                  <dt>{field.name}</dt>
                  <dd>
                    <code>{field.referenceName ?? field.id}</code> ·{' '}
                    {catalog?.fieldTypes[field.type] ?? field.type}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </>
    );
  }
  if (section === 'environment')
    return supportsEnvironment ? (
      <GraphNodeEnvironment
        key={node.id}
        project={project}
        canvas={canvas}
        node={node}
        fields={fields}
        candidates={candidates}
        bindings={endpoint ? (endpoint.environmentBindings?.[node.id] ?? {}) : undefined}
        updateDefaults={(environmentDefaults) => patchNode?.({ environmentDefaults })}
        update={(next) => {
          if (endpoint)
            update({
              ...endpoint,
              environmentBindings: { ...endpoint.environmentBindings, [node.id]: next },
            });
        }}
        canEdit={canEdit}
      />
    ) : (
      <p className="field-note">此操作通过输入端口获取配置，无需额外的进程环境变量。</p>
    );
  if (!fields.length && !functional)
    return patchNode ? <p className="field-note">此操作没有待配置的输入。</p> : null;
  const repositoryValue = fields
    .filter(({ type }) => type === 'REPOSITORY')
    .map((field) => {
      const binding = bindings?.[field.id] ?? compiled?.automaticInputBindings?.[field.id];
      return binding?.kind === 'VALUE'
        ? binding.value
        : binding?.kind === 'INPUT'
          ? start?.inputs?.find(({ id }) => id === binding.fieldId)?.defaultValue
          : nodeFixedInputValue(node, field);
    })
    .find((value) => value !== undefined && value !== '');
  const repositoryScope = {
    repositoryId:
      typeof repositoryValue === 'string'
        ? (project.repositories.find(({ cloneUrl }) => cloneUrl === repositoryValue)?.id ??
          project.repositories.find(({ id }) => id === repositoryValue)?.id)
        : typeof (repositoryValue as { repositoryId?: unknown } | undefined)?.repositoryId ===
            'string'
          ? (repositoryValue as { repositoryId: string }).repositoryId
          : undefined,
  };
  return (
    <section className="graph-fields">
      {!patchNode && <h4>{isEnd ? '最终输出' : '输入'}</h4>}
      {functional && (
        <p className="field-note">
          {fixedContract
            ? '步骤使用开始配置和上游结果。可为当前执行流选择具体来源。'
            : '同名变量可作为候选来源。选择后会把来源保存到当前执行流。'}
          {custom && (
            <>
              {' '}
              脚本可以用 <code>$引用名称</code> 读取已声明的输入。
            </>
          )}
        </p>
      )}
      {canEdit && patchNode && custom && (
        <AddFunctionField
          kind="inputs"
          node={node}
          nativePorts={[]}
          allowCustom
          catalog={catalog}
          candidates={candidates}
          patch={patchNode}
        />
      )}
      {[...fields]
        .sort(
          (left, right) =>
            Number(operation === 'CHECKOUT' && left.id === 'fetchMode') -
              Number(operation === 'CHECKOUT' && right.id === 'fetchMode') ||
            Number(Boolean(hasDeclaredInput(right.id))) -
              Number(Boolean(hasDeclaredInput(left.id))),
        )
        .map((field) => {
          const declared = hasDeclaredInput(field.id);
          const native = nativeInputs.some(({ id }) => id === field.id);
          const review = requiredReview && field.id === 'review' ? requiredReview : undefined;
          const choices = matchingChoices(candidates, field, canvas, catalog, endpoint).filter(
            ({ binding }) =>
              !review ||
              (binding.kind === 'OUTPUT' &&
                binding.nodeId === review.id &&
                binding.fieldId === 'review'),
          );
          const automatic = compiled?.automaticInputBindings?.[field.id];
          const sourceLabels = automatic ? namedSources(automatic, candidates) : [];
          const bound = bindings?.[field.id];
          const possibleSources =
            !bound && !automatic && declared && !review
              ? candidates.filter(
                  ({ field: source, binding }) =>
                    (binding.kind === 'OUTPUT' || binding.kind === 'INPUT') &&
                    (source.referenceName ?? source.exportName ?? source.id) ===
                      field.referenceName &&
                    compatible(source, field),
                )
              : [];
          const typeLabel = catalog?.fieldTypes[field.type] ?? field.type;
          const startResource =
            fixedContract &&
            ['REPOSITORY', 'TARGETS', 'SERVICE', 'GIT_REF', 'ARTIFACT'].includes(field.type);
          const fixed = Boolean(
            patchNode && !review && !startResource && acceptsFixedGraphValue(field),
          );
          const fallback =
            isEnd || review ? undefined : configuredFallback(node, field, start, endpoint);
          const implicitHint = bound
            ? bound.onMissing === 'USE_DEFAULT' ||
              (!bound.onMissing && declared && nodeFixedInputValue(node, field) !== undefined)
              ? '来源缺值时采用节点默认值。'
              : undefined
            : sourceLabels.length
              ? `自动来源 · ${sourceLabels.join('、')}`
              : possibleSources.length
                ? '同名候选来源 · ' + possibleSources.map(({ label }) => label).join('、')
                : fallback;
          const unbound = !bound && !fallback;
          const unique =
            compiled && unbound
              ? choices.find(
                  ({ binding, availability }) =>
                    availability === 'ALWAYS' &&
                    (choices.length === 1 ||
                      (automatic && JSON.stringify(binding) === JSON.stringify(automatic))),
                )
              : undefined;
          const canMakeParameter =
            createStartParameter &&
            start &&
            !isEnd &&
            !review &&
            !startResource &&
            canCreateStartParameter(field) &&
            (repairFieldIds?.has(field.id) ||
              (bound && hasMissingGraphBindingSource(bound, choices)) ||
              (unbound && field.required !== false));
          const changeBinding = (value?: GraphBinding) => {
            if (!endpoint) return;
            const next = { ...bindings };
            if (value) next[field.id] = value;
            else delete next[field.id];
            update(
              isEnd
                ? { ...endpoint, outputBindings: next }
                : { ...endpoint, inputBindings: { ...endpoint.inputBindings, [node.id]: next } },
            );
          };
          const customDefault = declared
            ? node.inputs?.find(({ id }) => id === field.id)?.defaultValue
            : (node.inputDefaults?.[field.id] ?? legacyGitInput(node, field));
          const defaultEditor = fixed && (
            <div className="graph-fields">
              <GraphFieldValue
                field={declared || endpoint ? { ...field, name: '默认值', required: false } : field}
                value={nodeFixedInputValue(node, field)}
                project={project}
                scope={repositoryScope}
                disabled={!canEdit}
                canManageProjectResources={canEdit}
                repositoryAddress={declared || undefined}
                change={(value) =>
                  declared
                    ? patchDeclaration('inputs', field.id, { defaultValue: value })
                    : patchNode?.(patchInputDefault(node, field.id, value))
                }
              />
              {canEdit && field.type !== 'GIT_REF' && customDefault !== undefined && (
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() =>
                    declared
                      ? patchDeclaration('inputs', field.id, { defaultValue: undefined })
                      : patchNode?.(patchInputDefault(node, field.id, undefined))
                  }
                >
                  清除默认值
                </button>
              )}
            </div>
          );
          const port = (
            <section
              key={node.id + ':' + field.id}
              className="graph-inspector-port"
              data-graph-node-field={field.id}
            >
              {declared && custom && !native && (
                <FunctionFieldNames
                  field={field}
                  native={native}
                  preset={functionPreset(field, 'inputs')}
                  input
                  allowedTypes={script ? inputTypes : undefined}
                  catalog={catalog}
                  canEdit={canEdit}
                  patch={(value) => patchDeclaration('inputs', field.id, value)}
                  remove={() => patchDeclaration('inputs', field.id)}
                />
              )}
              {!endpoint && !fixed && (
                <p className="field-note">
                  {field.name}
                  {typeLabel === field.name ? '' : ' · ' + typeLabel} · 连接执行流后可选取来源
                </p>
              )}
              {endpoint && (
                <GraphBindingField
                  field={review ? { ...field, required: true } : field}
                  value={bound}
                  project={project}
                  disabled={!canEdit}
                  choices={choices}
                  directSource={Boolean(review)}
                  nodeDefaults={fixed}
                  referenceLookup={declared || undefined}
                  allowFixedValue={!startResource}
                  allowEnvironmentKey={Boolean(
                    node.branch &&
                    field.id === 'value' &&
                    start?.environmentSet &&
                    start.environmentSet.mode !== 'NONE',
                  )}
                  scope={repositoryScope}
                  canManageProjectResources={canEdit}
                  allowRepositoryDefault={
                    field.id === 'version' && ['CHECKOUT', 'BUILD'].includes(operation)
                  }
                  fallback={implicitHint}
                  change={changeBinding}
                />
              )}
              {endpoint && canEdit && (unique || canMakeParameter) && (
                <div className="graph-field-pair">
                  {unique && (
                    <button
                      type="button"
                      className="button secondary small"
                      title={unique.label}
                      onClick={() => changeBinding(unique.binding)}
                    >
                      采用唯一来源
                    </button>
                  )}
                  {canMakeParameter && (
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => createStartParameter(field)}
                    >
                      <Plus size={14} /> 创建并绑定开始参数
                    </button>
                  )}
                </div>
              )}
              {fixed &&
                (bound ? (
                  <details className="graph-field-card">
                    <summary>节点默认值</summary>
                    {defaultEditor}
                  </details>
                ) : (
                  defaultEditor
                ))}
            </section>
          );
          return operation === 'CHECKOUT' && field.id === 'fetchMode' ? (
            <details
              key={node.id + ':' + field.id}
              className="graph-field-card"
              open={repairFieldIds?.has(field.id) || undefined}
            >
              <summary>高级设置 · 拉取方式</summary>
              {port}
            </details>
          ) : (
            port
          );
        })}
    </section>
  );
}

function GraphNodeEnvironment({
  project,
  canvas,
  node,
  fields,
  candidates,
  bindings,
  updateDefaults,
  update,
  canEdit,
}: {
  project: ProjectDetail;
  canvas: GraphCanvas;
  node: GraphNode;
  fields: GraphField[];
  candidates: GraphCandidate[];
  bindings?: Record<string, GraphBinding>;
  updateDefaults: (defaults: Record<string, string>) => void;
  update: (bindings: Record<string, GraphBinding>) => void;
  canEdit: boolean;
}) {
  const defaults = node.environmentDefaults ?? {};
  const permitsProjection = ['SHELL', 'CHECK'].includes(effectiveNodeType(node));
  const servers = useResource<Pick<Server, 'id' | 'name'>[]>(
    permitsProjection && bindings ? '/servers' : null,
  );
  const projected = permitsProjection
    ? candidates.flatMap((candidate): BindingChoice[] => {
        const { binding: source, field } = candidate;
        if (source.kind !== 'OUTPUT' || field.multiple) return [];
        const producer = canvas.nodes.find(({ id }) => id === source.nodeId);
        const type = producer && effectiveNodeType(producer);
        const projections: (keyof typeof graphProjectionLabels)[] =
          field.type === 'WORKSPACE' && type && ['CHECKOUT', 'SHELL', 'CHECK'].includes(type)
            ? ['WORKSPACE_PATH']
            : field.type === 'ARTIFACT' &&
                type &&
                ['BUILD', 'REGISTER_ARTIFACT', 'SHELL', 'CHECK'].includes(type)
              ? [
                  ...(field.artifactType !== 'DOCKER_IMAGE' ? (['ARTIFACT_PATH'] as const) : []),
                  ...(field.artifactType !== 'FILE' && field.artifactType !== 'DIRECTORY'
                    ? (['IMAGE_NAME', 'IMAGE_ID', 'IMAGE_DIGEST'] as const)
                    : []),
                ]
              : [];
        return projections.map((projection) => ({
          ...candidate,
          label: candidate.label + ' → ' + graphProjectionLabels[projection],
          binding: { kind: 'PROJECT_VALUE', source, projection },
        }));
      })
    : [];
  const sources: GraphCandidate[] = [
    ...fields.map((field): GraphCandidate => ({
      label: '本节点输入 · ' + field.name,
      referenceName: (node.referenceName ?? node.id) + '.' + (field.referenceName ?? field.id),
      field,
      binding: { kind: 'NODE_INPUT', fieldId: field.id },
      availability: 'ALWAYS',
      branches: [],
    })),
    ...candidates,
  ];
  return (
    <div className="graph-fields">
      <section className="graph-fields">
        <h4>节点固定变量</h4>
        {Object.entries(defaults).map(([name, value]) => (
          <div className="graph-field-pair" key={name}>
            <Field label={name}>
              <input
                value={value}
                disabled={!canEdit}
                onChange={(event) => updateDefaults({ ...defaults, [name]: event.target.value })}
              />
            </Field>
            {canEdit && (
              <button
                className="button secondary small"
                type="button"
                aria-label={'移除 ' + name}
                onClick={() => {
                  const next = { ...defaults };
                  delete next[name];
                  updateDefaults(next);
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
        {canEdit && (
          <AddGraphEnvironmentKey
            existing={defaults}
            add={(name) => updateDefaults({ ...defaults, [name]: '' })}
          />
        )}
      </section>
      {bindings && (
        <section className="graph-fields">
          <h4>当前执行流覆盖值</h4>
          <p className="field-note">
            同名变量优先使用执行流绑定，可从本节点输入、上游输出、开始参数或凭据中取值。
          </p>
          {Object.entries(bindings).map(([name, value]) => {
            const field: GraphField = {
              id: name,
              name,
              type: 'TEXT',
              required: false,
              acceptedTypes: ['NUMBER', 'BOOLEAN', 'PATH', 'CREDENTIAL'],
            };
            return (
              <div key={name} className="graph-fields">
                <GraphBindingField
                  field={field}
                  value={value}
                  project={project}
                  choices={[
                    ...matchingChoices(
                      sources.filter(
                        ({ field: sourceField, binding }) =>
                          sourceField.type !== 'CREDENTIAL' || binding.kind === 'NODE_INPUT',
                      ),
                      field,
                    ),
                    ...projected,
                  ]}
                  environment
                  disabled={!canEdit}
                  change={(next) => {
                    const copied = { ...bindings };
                    if (next) copied[name] = next;
                    else delete copied[name];
                    update(copied);
                  }}
                />
                {value.kind === 'PROJECT_VALUE' && value.projection.startsWith('IMAGE_') && (
                  <Field
                    label="实例所在服务器"
                    hint="在管理端读取多台机器的镜像时，请指定其中一台。"
                  >
                    <select
                      disabled={!canEdit}
                      value={value.serverId ?? ''}
                      onChange={(event) =>
                        update({
                          ...bindings,
                          [name]: { ...value, serverId: event.target.value || undefined },
                        })
                      }
                    >
                      <option value="">当前执行位置</option>
                      {value.serverId && !servers.data?.some(({ id }) => id === value.serverId) && (
                        <option value={value.serverId}>当前配置 {value.serverId}</option>
                      )}
                      {servers.data?.map(({ id, name: serverName }) => (
                        <option key={id} value={id}>
                          {serverName}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {value.kind === 'PROJECT_VALUE' && value.projection === 'WORKSPACE_PATH' && (
                  <p className="field-note">请将同一上游工作区绑定到本节点的工作区输入。</p>
                )}
              </div>
            );
          })}
          {canEdit && (
            <AddGraphEnvironmentKey
              existing={bindings}
              add={(name) => update({ ...bindings, [name]: { kind: 'VALUE', value: '' } })}
            />
          )}
        </section>
      )}
    </div>
  );
}

function AddGraphEnvironmentKey({
  existing,
  add,
}: {
  existing: Record<string, unknown>;
  add: (name: string) => void;
}) {
  const [key, setKey] = useState('');
  const valid =
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) &&
    !/^VEYOPS_/i.test(key) &&
    !Object.hasOwn(existing, key) &&
    !['constructor', '__proto__', 'prototype'].includes(key);
  return (
    <div className="graph-field-pair">
      <Field label="变量名">
        <input value={key} maxLength={64} onChange={(event) => setKey(event.target.value)} />
      </Field>
      <button
        type="button"
        className="button secondary small"
        disabled={!valid}
        onClick={() => {
          add(key);
          setKey('');
        }}
      >
        <Plus size={15} /> 添加变量
      </button>
    </div>
  );
}

export function GraphFlowBranches({
  node,
  canvas,
  endpoint,
  update,
  canEdit,
}: {
  node: GraphNode;
  canvas: GraphCanvas;
  endpoint: GraphEndpoint;
  update: (endpoint: GraphEndpoint) => void;
  canEdit: boolean;
}) {
  const edges = canvas.edges.filter(({ from }) => from === node.id);
  if (edges.length < 2 || graphDynamicOutlets(node, edges)) return null;
  const outgoing = edges.map(({ to }) => to);
  const current = endpoint.edgeSelections?.[node.id] ?? [];
  function setSelection(selected: string[]) {
    const selections = { ...endpoint.edgeSelections };
    if (selected.length) selections[node.id] = selected;
    else delete selections[node.id];
    update({ ...endpoint, edgeSelections: selections });
  }
  return (
    <fieldset className="graph-fields" disabled={!canEdit}>
      <legend>此流的普通出线</legend>
      <label className="check-inline">
        <input
          type="checkbox"
          checked={!current.length}
          onChange={(event) => setSelection(event.target.checked ? [] : outgoing)}
        />
        自动纳入通往当前结束的出线
      </label>
      {current.length > 0 &&
        outgoing.map((id) => (
          <label className="check-inline" key={id}>
            <input
              type="checkbox"
              checked={current.includes(id)}
              disabled={current.length === 1 && current.includes(id)}
              onChange={(event) =>
                setSelection(
                  event.target.checked ? [...current, id] : current.filter((to) => to !== id),
                )
              }
            />
            {canvas.nodes.find((item) => item.id === id)?.name ?? id}
          </label>
        ))}
    </fieldset>
  );
}
