import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Field } from '../components';
import type { ProjectDetail } from '../models';
import {
  acceptsFixedGraphValue,
  GraphBindingField,
  GraphFieldValue,
  hasMissingGraphBindingSource,
} from './ExecutionGraphFields';
import type { BindingChoice } from './ExecutionGraphFields';
import { effectiveNodeType, graphKey, graphNodeFamily } from './execution-graph-definition';
import type {
  GraphBinding,
  GraphCanvas,
  GraphCandidate,
  GraphCatalog,
  GraphEndpoint,
  GraphField,
  GraphFieldType,
  GraphNode,
} from './execution-graph-definition';

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
        ? { ...port, ...custom, defaultValue: custom.defaultValue ?? port.defaultValue }
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
  if (operation === 'SHELL' || operation === 'CHECK')
    return [...standard, ...(kind === 'inputs' ? (node.shell?.params ?? []) : [])];
  if (kind === 'outputs' && (operation === 'BUILD' || operation === 'REGISTER_ARTIFACT')) {
    const artifacts =
      operation === 'BUILD' ? node.build?.artifacts : node.registerArtifacts?.artifacts;
    return [
      ...standard,
      ...(artifacts ?? [])
        .filter(({ name }) => name && name !== 'artifacts')
        .map(({ name, type, required }): GraphField => ({
          id: name,
          name,
          type: 'ARTIFACT',
          multiple: true,
          artifactType: type,
          required: required !== false,
        })),
    ];
  }
  return standard;
}

const suggestedPortReferences: Record<string, string> = {
  repository: 'GIT_REPOSITORY_NAME',
  version: 'GIT_VERSION',
  fetchMode: 'GIT_FETCH_MODE',
  commitSha: 'GIT_COMMIT_SHA',
  repositoryId: 'GIT_REPOSITORY_NAME',
  path: 'ARTIFACT_DIR',
};

export function suggestedGraphPortReference(id: string) {
  return (
    suggestedPortReferences[id] ??
    id
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replaceAll('-', '_')
      .toUpperCase()
  );
}

function addFunctionField(
  fields: GraphField[],
  input: boolean,
  port?: GraphField,
  defaultValue?: unknown,
): GraphField {
  const id = port?.id ?? graphKey('field');
  const prefix = port ? suggestedGraphPortReference(id) : input ? 'INPUT' : 'OUTPUT';
  let referenceName = prefix;
  for (let i = 2; fields.some((field) => field.referenceName === referenceName); i++)
    referenceName = prefix + '_' + i;
  return {
    id,
    name: port?.name ?? (input ? '自定义输入' : '自定义输出'),
    referenceName,
    type: port?.type ?? 'TEXT',
    required: true,
    ...(port?.artifactType && { artifactType: port.artifactType }),
    ...(input && defaultValue !== undefined && { defaultValue }),
  };
}

function AddFunctionField({
  kind,
  node,
  nativePorts,
  allowCustom,
  patch,
}: {
  kind: 'inputs' | 'outputs';
  node: GraphNode;
  nativePorts: GraphField[];
  allowCustom: boolean;
  patch: (fields: Partial<GraphNode>) => void;
}) {
  const input = kind === 'inputs';
  const [selection, setSelection] = useState('');
  const declared = node[kind] ?? [];
  const native = nativePorts.filter(
    (port) => !port.multiple && !declared.some(({ id }) => id === port.id),
  );
  const current = native.find(({ id }) => id === selection);
  if (!native.length && !allowCustom) return null;
  return (
    <div className="graph-field-pair graph-port-add">
      <Field label={input ? '添加输入' : '添加输出'}>
        <select value={selection} onChange={(event) => setSelection(event.target.value)}>
          <option value="">选择要声明的字段</option>
          {allowCustom && <option value="__custom">自定义字段</option>}
          {native.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      <button
        className="button secondary small"
        type="button"
        disabled={selection !== '__custom' && !current}
        onClick={() => {
          const defaultValue = current && input ? nodeFixedInputValue(node, current) : undefined;
          patch({
            ...(current && input && patchInputDefault(node, current.id, undefined)),
            [kind]: [...declared, addFunctionField(declared, input, current, defaultValue)],
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
  allowedTypes,
  catalog,
  canEdit,
  patch,
  remove,
}: {
  field: GraphField;
  native: boolean;
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
            onChange={(event) => patch({ referenceName: event.target.value })}
          />
        </Field>
      </div>
      {native ? (
        <p className="field-note">执行端口 · {fieldTypes[field.type]}</p>
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
    (!input.artifactType || !source.artifactType || input.artifactType === source.artifactType)
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
  const availableFields = isEnd
    ? (compiled?.outputs ?? node.outputs ?? [])
    : operation === 'SOURCE_REVIEW' && node.approval?.buildNodeId
      ? []
      : (compiled?.inputs ?? moduleFields(node, 'inputs', canvas, catalog));
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
  const script = operation === 'SHELL' || operation === 'CHECK';
  const nativeInputs = functional ? operationFields(node, 'inputs', canvas, catalog) : [];
  const nativeOutputs = functional ? operationFields(node, 'outputs', canvas, catalog) : [];
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
          ? [{ ...field, ...patch, required: true, multiple: undefined, options: undefined }]
          : [];
      }),
    });
  if (section === 'output') {
    const declared = functional ? (node.outputs ?? []) : [];
    const implicit = outputs.filter((port) => !declared.some(({ id }) => id === port.id));
    return (
      <>
        {canEdit && patchNode && functional && (
          <AddFunctionField
            kind="outputs"
            node={node}
            nativePorts={nativeOutputs}
            allowCustom={script}
            patch={patchNode}
          />
        )}
        {declared.map((field) => {
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
                allowedTypes={
                  script
                    ? ['TEXT', 'NUMBER', 'BOOLEAN', 'GIT_FETCH_MODE', 'PATH', 'REPOSITORY']
                    : undefined
                }
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
          <details className="graph-field-card">
            <summary>查看执行结果字段</summary>
            <dl className="graph-field-values">
              {implicit.map((field) => (
                <div key={field.id}>
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
  const repository = bindings?.repository;
  const repositoryValue =
    repository?.kind === 'VALUE'
      ? repository.value
      : repository?.kind === 'INPUT'
        ? start?.inputs?.find(({ id }) => id === repository.fieldId)?.defaultValue
        : !repository
          ? (node.inputs?.find(({ id }) => id === 'repository')?.defaultValue ??
            node.inputDefaults?.repository ??
            node.checkout?.repositoryId ??
            node.build?.repositoryId)
          : undefined;
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
          每个声明输入读取一个值。优先使用同名上游变量，缺值时使用默认值。
          {script && (
            <>
              {' '}
              脚本可以用 <code>$引用名称</code> 读取已声明的输入。
            </>
          )}
        </p>
      )}
      {canEdit && patchNode && functional && (
        <AddFunctionField
          kind="inputs"
          node={node}
          nativePorts={nativeInputs.filter((port) => fields.some(({ id }) => id === port.id))}
          allowCustom={script}
          patch={patchNode}
        />
      )}
      {[...fields]
        .sort(
          (left, right) =>
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
          const typeLabel = catalog?.fieldTypes[field.type] ?? field.type;
          const fixed = Boolean(patchNode && !review && acceptsFixedGraphValue(field));
          const bound = bindings?.[field.id];
          const fallback =
            isEnd || review ? undefined : configuredFallback(node, field, start, endpoint);
          const implicitHint = bound
            ? bound.onMissing === 'USE_DEFAULT' ||
              (!bound.onMissing && declared && nodeFixedInputValue(node, field) !== undefined)
              ? '来源缺值时采用节点默认值。'
              : undefined
            : sourceLabels.length
              ? `同名来源 · ${sourceLabels.join('、')}${automatic?.onMissing === 'USE_DEFAULT' ? ' · 缺值时采用默认值' : ''}`
              : fallback;
          const unbound = !bound && !automatic && !fallback;
          const unique =
            compiled && unbound && choices.length === 1 && choices[0]?.availability === 'ALWAYS'
              ? choices[0]
              : undefined;
          const canMakeParameter =
            createStartParameter &&
            start &&
            !isEnd &&
            !review &&
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
                canRegisterRepository={canEdit}
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
          return (
            <section
              key={node.id + ':' + field.id}
              className="graph-inspector-port"
              data-graph-node-field={field.id}
            >
              {declared && (
                <FunctionFieldNames
                  field={field}
                  native={native}
                  allowedTypes={
                    script
                      ? ['TEXT', 'NUMBER', 'BOOLEAN', 'GIT_FETCH_MODE', 'PATH', 'CREDENTIAL']
                      : undefined
                  }
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
                  scope={repositoryScope}
                  canRegisterRepository={canEdit}
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
        })}
    </section>
  );
}

function GraphNodeEnvironment({
  project,
  node,
  fields,
  candidates,
  bindings,
  updateDefaults,
  update,
  canEdit,
}: {
  project: ProjectDetail;
  node: GraphNode;
  fields: GraphField[];
  candidates: GraphCandidate[];
  bindings?: Record<string, GraphBinding>;
  updateDefaults: (defaults: Record<string, string>) => void;
  update: (bindings: Record<string, GraphBinding>) => void;
  canEdit: boolean;
}) {
  const defaults = node.environmentDefaults ?? {};
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
              <GraphBindingField
                key={name}
                field={field}
                value={value}
                project={project}
                choices={matchingChoices(
                  sources.filter(
                    ({ field: sourceField, binding }) =>
                      sourceField.type !== 'CREDENTIAL' || binding.kind === 'NODE_INPUT',
                  ),
                  field,
                )}
                environment
                disabled={!canEdit}
                change={(next) => {
                  const copied = { ...bindings };
                  if (next) copied[name] = next;
                  else delete copied[name];
                  update(copied);
                }}
              />
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
  outgoing,
  canvas,
  endpoint,
  update,
  canEdit,
}: {
  node: GraphNode;
  outgoing: string[];
  canvas: GraphCanvas;
  endpoint: GraphEndpoint;
  update: (endpoint: GraphEndpoint) => void;
  canEdit: boolean;
}) {
  if (outgoing.length < 2 || ['CONDITION', 'SWITCH', 'PARALLEL'].includes(effectiveNodeType(node)))
    return null;
  const current = endpoint.edgeSelections?.[node.id] ?? [];
  return (
    <Field label="此流的下一节点" hint="有多条线路通往同一个结束节点时，须明确选择。">
      <select
        disabled={!canEdit}
        value={current[0] ?? ''}
        onChange={(event) => {
          const selections = { ...endpoint.edgeSelections };
          if (event.target.value) selections[node.id] = [event.target.value];
          else delete selections[node.id];
          update({ ...endpoint, edgeSelections: selections });
        }}
      >
        <option value="">未选择分支</option>
        {outgoing.map((id) => (
          <option value={id} key={id}>
            {canvas.nodes.find((item) => item.id === id)?.name ?? id}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function GraphTemplatePicker({
  templates,
  add,
}: {
  templates: { name: string; nodes: GraphNode['type'][] }[];
  add: (types: GraphNode['type'][]) => void;
}) {
  const [selected, select] = useState('');
  return (
    <div className="graph-field-pair">
      <select
        aria-label="选择快捷模板"
        value={selected}
        onChange={(event) => select(event.target.value)}
      >
        <option value="">选择快捷模板</option>
        {templates.map(({ name }) => (
          <option value={name} key={name}>
            {name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="button secondary small"
        disabled={!selected}
        onClick={() => {
          const template = templates.find(({ name }) => name === selected);
          if (template) add(template.nodes);
        }}
      >
        插入模板
      </button>
    </div>
  );
}
