import { useState } from 'react';
import { Field } from '../components';
import type { ProjectDetail } from '../models';
import { GraphBindingField } from './ExecutionGraphFields';
import type { BindingChoice } from './ExecutionGraphFields';
import type {
  GraphCanvas,
  GraphCandidate,
  GraphCatalog,
  GraphEndpoint,
  GraphField,
  GraphNode,
} from './execution-graph-definition';

function moduleFields(
  node: GraphNode,
  kind: 'inputs' | 'outputs',
  canvas: GraphCanvas,
  catalog?: GraphCatalog,
): GraphField[] {
  if (node.type === 'FLOW_CALL') {
    const flow = canvas.endpoints.find(({ startId }) => startId === node.flowId);
    return (
      canvas.nodes.find(({ id }) => id === (kind === 'inputs' ? flow?.startId : flow?.endId))?.[
        kind
      ] ?? []
    );
  }
  const standard = catalog?.modules[node.type]?.[kind] ?? [];
  if (node.type === 'BUILD' && kind === 'inputs')
    return [
      ...standard,
      ...(node.build?.dependencies ?? []).map((alias): GraphField => ({
        id: 'dependency_' + alias,
        name: '源码依赖 · ' + alias,
        type: 'WORKSPACE',
        required: true,
      })),
    ];
  if (node.type === 'SHELL' || node.type === 'CHECK')
    return [
      ...standard,
      ...(kind === 'inputs' ? (node.shell?.params ?? []) : (node.outputs ?? [])),
    ];
  if (kind === 'outputs' && (node.type === 'BUILD' || node.type === 'REGISTER_ARTIFACT')) {
    const artifacts =
      node.type === 'BUILD' ? node.build?.artifacts : node.registerArtifacts?.artifacts;
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

function compatible(source: GraphField, input: GraphField) {
  return (
    (source.type === input.type || input.acceptedTypes?.includes(source.type)) &&
    (input.type === 'ARTIFACT' || Boolean(source.multiple) === Boolean(input.multiple)) &&
    (!input.artifactType || !source.artifactType || input.artifactType === source.artifactType)
  );
}

function configuredFallback(
  node: GraphNode,
  field: GraphField,
  start: GraphNode | undefined,
  endpoint: GraphEndpoint,
) {
  const config = node.checkout ?? node.build;
  if (field.id === 'repository' && config?.repositoryId) return '使用节点已有的仓库值。';
  if (field.id === 'version' && (node.type === 'CHECKOUT' || node.type === 'BUILD'))
    return '未指定版本时，预览解析仓库默认分支并固定实际提交。';
  if (field.id === 'service' && endpoint.serviceId) return '使用执行流关联的服务。';
  if (field.id === 'targets' && node.shell?.serverId) return '节点已指定执行服务器。';
  if (
    field.id === 'path' &&
    node.registerArtifacts?.artifacts?.every(({ path, type }) => path || type === 'DOCKER_IMAGE')
  )
    return '使用各产物设置的工作区路径。';
  const scope = ['service', 'environment', 'targets'];
  const candidates = start?.inputs?.filter((input) => compatible(input, field)) ?? [];
  if (scope.includes(field.id) && candidates.length === 1)
    return '采用此流唯一类型匹配的开始输入。';
  return undefined;
}

function matchingChoices(candidates: GraphCandidate[], field: GraphField) {
  return candidates.flatMap((source): BindingChoice[] => {
    if (field.source === 'CURRENT_RUN' && source.binding.kind !== 'OUTPUT') return [];
    if (compatible(source.field, field)) return [source];
    if (
      field.type !== 'GIT_REF' ||
      field.multiple ||
      source.field.type !== 'TEXT' ||
      source.field.multiple
    )
      return [];
    return (['BRANCH', 'TAG'] as const).map((refKind) => ({
      ...source,
      label: source.label + (refKind === 'BRANCH' ? ' → 分支' : ' → 标签'),
      binding: { kind: 'AS_GIT_REF', refKind, source: source.binding },
    }));
  });
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
}: {
  canvas: GraphCanvas;
  node: GraphNode;
  endpoint: GraphEndpoint;
  flowEdgeIndexes: Set<number>;
  catalog?: GraphCatalog;
  directory?: GraphCatalog['flows'];
  project: ProjectDetail;
  canEdit: boolean;
  update: (newEndpoint: GraphEndpoint) => void;
}) {
  const edges = canvas.edges.filter((_, index) => flowEdgeIndexes.has(index));
  const start = canvas.nodes.find(({ id }) => id === endpoint.startId);
  const ancestors = new Set<string>();
  const pending = [node.id];
  for (const id of pending) {
    for (const { from, to } of edges) {
      if (to !== id || ancestors.has(from)) continue;
      ancestors.add(from);
      pending.push(from);
    }
  }
  const isEnd = node.type === 'END';
  const compiled = directory?.[endpoint.startId]?.nodes[node.id];
  const fields = isEnd
    ? (compiled?.outputs ?? node.outputs ?? [])
    : node.type === 'SOURCE_REVIEW' && node.approval?.buildNodeId
      ? []
      : (compiled?.inputs ?? moduleFields(node, 'inputs', canvas, catalog));
  const bindings = isEnd ? endpoint.outputBindings : endpoint.inputBindings?.[node.id];
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
    ({ type, approval }) => type === 'SOURCE_REVIEW' && approval?.buildNodeId,
  );
  const requiredReview =
    node.type === 'BUILD'
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
  const supportsEnvironment =
    node.type === 'BUILD' || node.type === 'SHELL' || node.type === 'CHECK';
  if (!fields.length && !supportsEnvironment && !outputs.length) return null;
  const repository = bindings?.repository;
  const repositoryValue =
    repository?.kind === 'VALUE'
      ? repository.value
      : repository?.kind === 'INPUT'
        ? start?.inputs?.find(({ id }) => id === repository.fieldId)?.defaultValue
        : !repository
          ? (node.checkout?.repositoryId ?? node.build?.repositoryId)
          : undefined;
  return (
    <section className="graph-fields">
      {!!fields.length && <h4>{isEnd ? '最终输出' : '输入'}</h4>}
      {fields.map((field) => {
        const review = requiredReview && field.id === 'review' ? requiredReview : undefined;
        const choices = matchingChoices(candidates, field);
        return (
          <GraphBindingField
            key={node.id + ':' + field.id}
            field={review ? { ...field, required: true } : field}
            value={bindings?.[field.id]}
            project={project}
            disabled={!canEdit}
            choices={
              review
                ? choices.filter(
                    ({ binding }) => binding.kind === 'OUTPUT' && binding.nodeId === review.id,
                  )
                : choices
            }
            directSource={Boolean(review)}
            scope={{
              repositoryId: typeof repositoryValue === 'string' ? repositoryValue : undefined,
            }}
            canRegisterRepository={canEdit}
            allowRepositoryDefault={
              field.id === 'version' && (node.type === 'CHECKOUT' || node.type === 'BUILD')
            }
            fallback={isEnd ? undefined : configuredFallback(node, field, start, endpoint)}
            change={(value) => {
              const next = { ...bindings };
              if (value) next[field.id] = value;
              else delete next[field.id];
              update(
                isEnd
                  ? { ...endpoint, outputBindings: next }
                  : { ...endpoint, inputBindings: { ...endpoint.inputBindings, [node.id]: next } },
              );
            }}
          />
        );
      })}
      {!!outputs.length && (
        <details className="graph-field-card">
          <summary>输出接口 · {outputs.length} 项</summary>
          <dl className="graph-field-values">
            {outputs.map((field) => (
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
      {supportsEnvironment && (
        <GraphNodeEnvironment
          key={node.id}
          project={project}
          node={node}
          fields={fields}
          candidates={candidates}
          bindings={endpoint.environmentBindings?.[node.id] ?? {}}
          update={(next) =>
            update({
              ...endpoint,
              environmentBindings: { ...endpoint.environmentBindings, [node.id]: next },
            })
          }
          canEdit={canEdit}
        />
      )}
    </section>
  );
}

function GraphNodeEnvironment({
  project,
  node,
  fields,
  candidates,
  bindings,
  update,
  canEdit,
}: {
  project: ProjectDetail;
  node: GraphNode;
  fields: GraphField[];
  candidates: GraphCandidate[];
  bindings: Record<string, import('./execution-graph-definition').GraphBinding>;
  update: (bindings: Record<string, import('./execution-graph-definition').GraphBinding>) => void;
  canEdit: boolean;
}) {
  const [key, setKey] = useState('');
  const valid =
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) &&
    !/^VEYOPS_/i.test(key) &&
    !Object.hasOwn(bindings, key) &&
    !['constructor', '__proto__', 'prototype'].includes(key);
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
    <details className="graph-field-card" open={Object.keys(bindings).length > 0 || undefined}>
      <summary>环境变量</summary>
      <div className="graph-fields">
        {node.type === 'BUILD' && (
          <p className="field-note">
            此处的绑定只生效于当前执行流的构建节点，可将检出的提交传为 GIT_SHA。
          </p>
        )}
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
          <div className="graph-field-pair">
            <Field label="变量名">
              <input value={key} maxLength={64} onChange={(event) => setKey(event.target.value)} />
            </Field>
            <button
              type="button"
              className="button secondary small"
              disabled={!valid}
              onClick={() => {
                update({ ...bindings, [key]: { kind: 'VALUE', value: '' } });
                setKey('');
              }}
            >
              添加环境变量
            </button>
          </div>
        )}
      </div>
    </details>
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
  if (outgoing.length < 2 || ['CONDITION', 'SWITCH', 'PARALLEL'].includes(node.type)) return null;
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
