import { useState } from 'react';
import { Field } from '../components';
import type { ProjectDetail } from '../models';
import { GraphBindingField } from './ExecutionGraphFields';
import type { BindingChoice } from './ExecutionGraphFields';
import type {
  GraphCanvas,
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
  if (field.id === 'repository' && config?.repositoryId) return '节点已指定项目仓库。';
  if (field.id === 'version' && config?.repositoryId) return '节点已指定 Git 版本规则。';
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

export function ExecutionGraphBindings({
  canvas,
  node,
  endpoint,
  flowEdgeIndexes,
  catalog,
  project,
  canEdit,
  update,
}: {
  canvas: GraphCanvas;
  node: GraphNode;
  endpoint: GraphEndpoint;
  flowEdgeIndexes: Set<number>;
  catalog?: GraphCatalog;
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
  const fields = isEnd ? (node.outputs ?? []) : moduleFields(node, 'inputs', canvas, catalog);
  const bindings = isEnd ? endpoint.outputBindings : endpoint.inputBindings?.[node.id];
  const context = catalog?.contextFields ?? [];
  const candidates = [
    ...(start?.inputs ?? []).map((field) => ({
      field,
      label: '开始 · ' + field.name,
      binding: { kind: 'INPUT' as const, fieldId: field.id },
    })),
    ...context.map((field) => ({
      field,
      label: '运行上下文 · ' + field.name,
      binding: { kind: 'CONTEXT' as const, fieldId: field.id },
    })),
    ...canvas.nodes
      .filter(({ id }) => ancestors.has(id))
      .flatMap((source) =>
        moduleFields(source, 'outputs', canvas, catalog).map((field) => ({
          field,
          label: source.name + ' · ' + field.name,
          binding: { kind: 'OUTPUT' as const, nodeId: source.id, fieldId: field.id },
        })),
      ),
  ];
  if (!fields.length) return null;
  return (
    <section className="graph-fields">
      <h4>{isEnd ? '本流输出绑定' : '本流输入绑定'}</h4>
      {fields.map((field) => {
        const choices: BindingChoice[] = candidates.filter((source) => {
          if (isEnd && field.source === 'CURRENT_RUN' && source.binding.kind !== 'OUTPUT')
            return false;
          return compatible(source.field, field);
        });
        return (
          <GraphBindingField
            key={field.id}
            field={field}
            value={bindings?.[field.id]}
            project={project}
            disabled={!canEdit}
            choices={choices}
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
    </section>
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
