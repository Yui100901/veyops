import type { ProjectDetail } from '../models';
import { moduleFields, nodeFixedInputValue } from './ExecutionGraphBindings';
import { sourceName } from './ExecutionGraphPreview';
import {
  effectiveNodeType,
  graphNodeTypeLabel,
  graphProjectionLabels,
} from './execution-graph-definition';
import type {
  GraphBinding,
  GraphCanvas,
  GraphCatalog,
  GraphField,
  GraphFlow,
  GraphNode,
} from './execution-graph-definition';
import './execution-graph-node-details.css';

export function showSelectedNode(panel: HTMLElement | null) {
  if (panel && panel.getBoundingClientRect().top > window.innerHeight - 140)
    panel.scrollIntoView({ block: 'start' });
}

function fieldValue(value: unknown, type: string | undefined, project: ProjectDetail): string {
  if (value === null || value === undefined) return '未设置';
  if (type === 'CREDENTIAL' || type === 'VARIABLES') return '隐藏';
  if (type === 'GIT_FETCH_MODE') {
    if (value === 'LATEST') return '仅拉取选定提交';
    if (value === 'FULL') return '拉取完整历史';
  }
  if (Array.isArray(value)) return value.map((item) => fieldValue(item, type, project)).join('、');
  if (typeof value === 'object') {
    if (type === 'GIT_REF' && 'kind' in value && 'value' in value) {
      const labels = { BRANCH: '分支', TAG: '标签', COMMIT: '提交' };
      return `${labels[value.kind as keyof typeof labels] ?? 'Git 版本'} · ${String(value.value)}`;
    }
    const key = type === 'REPOSITORY' ? 'repositoryId' : type === 'SERVICE' ? 'serviceId' : '';
    if (key) return fieldValue((value as Record<string, unknown>)[key], type, project);
    return '结构化值';
  }
  if (type === 'REPOSITORY')
    return project.repositories.find(({ id }) => id === value)?.name ?? String(value);
  if (type === 'SERVICE')
    return project.services.find(({ id }) => id === value)?.name ?? String(value);
  if (type === 'ENVIRONMENT')
    return project.environments.find(({ id }) => id === value)?.name ?? String(value);
  return typeof value === 'boolean' ? (value ? '是' : '否') : String(value);
}

function bindingLabel(
  binding: GraphBinding,
  field: GraphField | undefined,
  flow: GraphFlow | undefined,
  node: GraphNode,
  project: ProjectDetail,
): string {
  const start = flow?.nodes.find(({ type }) => type === 'START');
  switch (binding.kind) {
    case 'VALUE':
      return '固定值 · ' + fieldValue(binding.value, field?.type, project);
    case 'INPUT':
      return `开始参数 · ${start?.inputs?.find(({ id }) => id === binding.fieldId)?.name ?? binding.fieldId}`;
    case 'OUTPUT': {
      const producer = flow?.nodes.find(({ id }) => id === binding.nodeId);
      const name = producer?.outputs?.find(({ id }) => id === binding.fieldId)?.name;
      return `上游输出 · ${producer?.name ?? binding.nodeId} / ${name ?? binding.fieldId}`;
    }
    case 'NODE_INPUT':
      return `本节点输入 · ${node.shell?.params?.find(({ id }) => id === binding.fieldId)?.name ?? binding.fieldId}`;
    case 'ENVIRONMENT_KEY':
      return `入口变量集合 · ${binding.key}`;
    case 'CREDENTIAL':
      return '凭据引用 · 隐藏';
    case 'AS_GIT_REF':
      return `${binding.refKind === 'BRANCH' ? '转换为分支' : '转换为标签'} · ${bindingLabel(binding.source, undefined, flow, node, project)}`;
    case 'PROJECT_VALUE':
      return `${bindingLabel(binding.source, undefined, flow, node, project)} → ${graphProjectionLabels[binding.projection]}${binding.serverId ? ' · ' + binding.serverId : ''}`;
    case 'FIRST_AVAILABLE':
      return binding.sources
        .map((source) => bindingLabel(source, field, flow, node, project))
        .join(' → ');
    default:
      return `${sourceName(binding.kind)} · ${binding.fieldId}`;
  }
}

export function ConfiguredNodeExecution({
  node,
  flow,
  graph,
}: {
  node: GraphNode;
  flow?: GraphFlow;
  graph?: readonly GraphFlow[];
}) {
  const type = effectiveNodeType(node);
  const command = node.shell?.command ?? node.build?.buildCommand ?? node.healthCheck?.command;
  return (
    <div className="graph-node-execution-config">
      {node.message && <p>{node.message}</p>}
      {type === 'CHECKOUT' && <p>解析 Git 版本，检出固定提交，输出源码版本和工作区。</p>}
      {node.condition && (
        <p>
          比较{node.condition.key === 'input' ? '节点输入' : '提交 SHA'}是否等于{' '}
          <code>{node.condition.value}</code>。
        </p>
      )}
      {node.switch && <p>匹配项 · {node.switch.cases.join('、')}</p>}
      {type === 'DELAY' && <p>等待 {node.delaySeconds} 秒</p>}
      {(type === 'APPROVAL' || type === 'SOURCE_REVIEW') && (
        <p>管理员审批 · {node.approval?.timeoutSeconds ?? 86400} 秒后超时</p>
      )}
      {node.approval?.releaseNodeId && (
        <p>
          审批范围 ·{' '}
          {flow?.nodes.find(({ id }) => id === node.approval?.releaseNodeId)?.name ??
            node.approval.releaseNodeId}
        </p>
      )}
      {node.shell?.location && (
        <p>执行位置 · {node.shell.location === 'MANAGER' ? '管理端' : '目标端'}</p>
      )}
      {node.shell?.directory && (
        <p>
          工作目录 · <code>{node.shell.directory}</code>
        </p>
      )}
      {node.shell?.timeout !== undefined && <p>超时 · {node.shell.timeout} 秒</p>}
      {node.loadEnvironment?.envFile && (
        <p>
          环境文件 · <code>{node.loadEnvironment.envFile}</code>
        </p>
      )}
      {node.deploy?.method && (
        <p>{node.deploy.method === 'COMPOSE' ? 'Docker Compose 部署' : '文件部署'}</p>
      )}
      {node.deploy?.deployPath && (
        <p>
          发布目录 · <code>{node.deploy.deployPath}</code>
        </p>
      )}
      {node.flowId && (
        <p>子执行流 · {graph?.find(({ id }) => id === node.flowId)?.name ?? node.flowId}</p>
      )}
      {command && <pre>{command}</pre>}
    </div>
  );
}

export function PublishedNodeDetails({
  node,
  flow,
  definition,
  catalog,
  project,
}: {
  node: GraphNode;
  flow?: GraphFlow;
  definition: { canvas?: GraphCanvas; flows: GraphFlow[] };
  catalog?: GraphCatalog;
  project: ProjectDetail;
}) {
  const canvas = definition.canvas ?? {
    nodes: definition.flows.flatMap(({ nodes }) => nodes),
    edges: definition.flows.flatMap(({ edges }) => edges),
    endpoints: definition.flows.flatMap((item) => {
      const start = item.nodes.find(({ type }) => type === 'START');
      const end = item.nodes.find(({ type }) => type === 'END');
      return start && end ? [{ startId: start.id, endId: end.id }] : [];
    }),
    templates: [],
  };
  const type = effectiveNodeType(node);
  const inputs =
    type === 'START' ? (node.inputs ?? []) : moduleFields(node, 'inputs', canvas, catalog);
  const outputs =
    type === 'END' ? (node.outputs ?? []) : moduleFields(node, 'outputs', canvas, catalog);
  const env = { ...node.environmentDefaults, ...flow?.environmentBindings?.[node.id] };
  const bindings = flow?.inputBindings?.[node.id];
  function inputSetting(field: GraphField) {
    const binding = bindings?.[field.id];
    if (binding) return bindingLabel(binding, field, flow, node, project);
    const fixed = nodeFixedInputValue(node, field) ?? field.defaultValue;
    if (fixed != null) return '默认 · ' + fieldValue(fixed, field.type, project);
    if (type === 'CHECKOUT' && field.id === 'fetchMode')
      return (
        '默认 · ' +
        fieldValue(node.checkout?.fullClone ? 'FULL' : 'LATEST', 'GIT_FETCH_MODE', project)
      );
    if (type === 'CHECKOUT' && field.id === 'version') return '默认 · 仓库默认分支';
    if (type === 'START') return field.required ? '运行时必填' : '运行时可填写';
    return field.required ? '运行时需要值' : '未设置绑定';
  }
  return (
    <>
      {type !== 'END' && (
        <section className="graph-node-detail-section">
          <h4>{type === 'START' ? '运行参数' : '输入'}</h4>
          {inputs.length ? (
            <dl className="graph-node-settings">
              {inputs.map((field) => (
                <div key={field.id}>
                  <dt>
                    {field.name} <small>{catalog?.fieldTypes[field.type] ?? field.type}</small>
                  </dt>
                  <dd>{inputSetting(field)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="field-note">此节点没有声明输入。</p>
          )}
        </section>
      )}
      {type !== 'START' && type !== 'END' && (
        <section className="graph-node-detail-section">
          <h4>执行</h4>
          <p>{graphNodeTypeLabel(node)}</p>
          <ConfiguredNodeExecution node={node} flow={flow} graph={definition.flows} />
        </section>
      )}
      {type !== 'START' && type !== 'CONDITION' && type !== 'SWITCH' && (
        <section className="graph-node-detail-section">
          <h4>{type === 'END' ? '执行流输出' : '输出'}</h4>
          {outputs.length ? (
            <dl className="graph-node-settings">
              {outputs.map((field) => {
                const binding = type === 'END' ? flow?.outputBindings?.[field.id] : undefined;
                return (
                  <div key={field.id}>
                    <dt>{field.name}</dt>
                    <dd>
                      {binding
                        ? bindingLabel(binding, field, flow, node, project)
                        : (catalog?.fieldTypes[field.type] ?? field.type)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : (
            <p className="field-note">此节点没有声明输出。</p>
          )}
        </section>
      )}
      {type !== 'END' && type !== 'CONDITION' && type !== 'SWITCH' && (
        <section className="graph-node-detail-section">
          <h4>环境变量</h4>
          {type === 'START' && node.environmentSet?.mode === 'INPUT' && (
            <p>入口变量集合由运行参数选择。</p>
          )}
          {type === 'START' && node.environmentSet?.mode === 'FIXED' && (
            <p>此入口绑定了变量集合。</p>
          )}
          {Object.keys(env).length ? (
            <dl className="graph-node-settings">
              {Object.entries(env).map(([key, binding]) => (
                <div key={key}>
                  <dt>
                    <code>{key}</code>
                  </dt>
                  <dd>
                    {typeof binding === 'string' || binding.kind === 'VALUE'
                      ? '节点固定值'
                      : bindingLabel(binding, undefined, flow, node, project)}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="field-note">此节点没有额外的环境变量绑定。</p>
          )}
        </section>
      )}
    </>
  );
}
