import type { ProjectDetail } from '../models';
import type { FlowBindings, GraphField, GraphNode } from './execution-graph-definition';
import type { GraphPane, GraphWorkbenchScope } from './graph-workbench-context';
import { projectResourcePath } from './project-workspace-route';

export function ExecutionGraphResourceLinks({
  node,
  start,
  flow,
  flowId,
  version,
  pane,
  project,
  scope,
}: {
  node: GraphNode;
  start?: GraphNode;
  flow?: FlowBindings;
  flowId?: string;
  version?: number;
  pane: GraphPane;
  project: ProjectDetail;
  scope: GraphWorkbenchScope;
}) {
  const context = {
    view: scope.view,
    graphPane: pane,
    graphVersion: version === undefined ? undefined : String(version),
    graphNode: node.id,
    graphFlow: flowId,
    graphServiceId: scope.serviceId,
    graphEnvironmentId: scope.environmentId,
    graphResourcePanel: scope.resourcePanel,
  };
  type Resource = 'repositories' | 'services' | 'environments' | 'servers';
  const links = new Map<string, { href: string; label: string }>();
  function add(resource: Resource, value: unknown) {
    const id = typeof value === 'string' ? value : undefined;
    if (!id) return;
    const label =
      resource === 'servers'
        ? '服务器及来源'
        : project[resource].find((item) => item.id === id)?.name;
    if (!label) return;
    const location = {
      ...context,
      resource,
      repositoryId: resource === 'repositories' ? id : undefined,
      serviceId: resource === 'services' ? id : undefined,
      environmentId: resource === 'environments' ? id : undefined,
      serverId: resource === 'servers' ? id : undefined,
    };
    links.set(`${resource}:${id}`, {
      href: '#' + projectResourcePath(project.id, location),
      label,
    });
  }
  const relationFields = {
    REPOSITORY: 'repositories',
    SERVICE: 'services',
    ENVIRONMENT: 'environments',
  } as const;
  const ports = {
    repository: 'REPOSITORY',
    service: 'SERVICE',
    environment: 'ENVIRONMENT',
  } as const;
  function addField(field: GraphField) {
    const resource = relationFields[field.type as keyof typeof relationFields];
    if (!resource) return;
    const values = Array.isArray(field.defaultValue) ? field.defaultValue : [field.defaultValue];
    for (const value of values) add(resource, value);
  }
  add('repositories', node.checkout?.repositoryId ?? node.build?.repositoryId);
  add('servers', node.shell?.serverId);
  if (node.type === 'START') {
    add('services', flow?.serviceId);
    for (const field of node.inputs ?? []) addField(field);
  }
  const bindings = flow?.inputBindings?.[node.id];
  for (const [port, type] of Object.entries(ports)) {
    const binding = bindings?.[port];
    if (binding?.kind === 'VALUE') add(relationFields[type], binding.value);
    if (binding?.kind === 'INPUT') {
      const field = start?.inputs?.find(({ id }) => id === binding.fieldId);
      if (field?.type === type) addField(field);
    }
  }
  if (!links.size) return null;
  return (
    <div className="heading-actions" aria-label="节点关联资源">
      {[...links].map(([key, { href, label }]) => (
        <a className="button secondary small" key={key} href={href}>
          查看{label}
        </a>
      ))}
    </div>
  );
}
