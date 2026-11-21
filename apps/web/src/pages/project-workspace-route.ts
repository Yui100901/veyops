import { deliveryPath, deliveryTabs, type DeliveryTab } from './delivery-route';
import {
  graphResourcePanel,
  graphWorkbenchPath,
  type GraphPane,
  type GraphStartLocation,
} from './graph-workbench-context';

export const projectEntries = {
  resources: '项目资源',
  graph: '执行图',
  delivery: '交付记录',
  configuration: '项目配置',
} as const;

export const projectResources = {
  repositories: '仓库',
  services: '服务',
  environments: '环境',
  servers: '服务器与分组',
  relations: '访问地址与项目依赖',
} as const;

type Entry = keyof typeof projectEntries;
export type ResourceKind = keyof typeof projectResources;
export type ProjectScope = { serviceId?: string; environmentId?: string; view?: string };
export type GraphResourceReturn = {
  graphPane?: GraphPane;
  graphVersion?: string;
  graphNode?: string;
  graphFlow?: string;
  graphStart?: string;
  graphField?: string;
  graphServiceId?: string;
  graphEnvironmentId?: string;
  graphResourcePanel?: string;
};
export type ResourceLocation = ProjectScope &
  GraphResourceReturn & {
    resource?: ResourceKind;
    repositoryId?: string;
    serverId?: string;
    groupId?: string;
    panel?: string;
  };

export function projectResourcePath(id: string, location: ResourceLocation = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(location)) if (value) params.set(key, value);
  return `/projects/${encodeURIComponent(id)}${params.size ? '?' + params : ''}`;
}

export function graphSetupResourceHref(
  id: string,
  origin: GraphStartLocation,
  destination: Pick<
    ResourceLocation,
    'resource' | 'repositoryId' | 'serviceId' | 'environmentId' | 'panel'
  >,
) {
  return (
    '#' +
    projectResourcePath(id, {
      ...destination,
      view: origin.view,
      graphPane: 'run',
      graphVersion: origin.version?.toString(),
      graphStart: origin.start,
      graphField: origin.field,
      graphServiceId: origin.serviceId,
      graphEnvironmentId: origin.environmentId,
      graphResourcePanel: origin.resourcePanel,
    })
  );
}

export function graphResourceReturnHref(id: string, context: GraphResourceReturn, view?: string) {
  const version = Number(context.graphVersion);
  return (
    '#' +
    graphWorkbenchPath(id, {
      view,
      pane: context.graphPane,
      version: Number.isSafeInteger(version) && version > 0 ? version : undefined,
      node: context.graphNode,
      flow: context.graphFlow,
      start: context.graphPane === 'run' ? (context.graphStart ?? context.graphFlow) : undefined,
      field: context.graphField,
      serviceId: context.graphServiceId,
      environmentId: context.graphEnvironmentId,
      resourcePanel: graphResourcePanel(context.graphResourcePanel),
    })
  );
}

export function projectGraphPath(
  id: string,
  location: ProjectScope & { start?: string; run?: string; pane?: string } = {},
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(location)) if (value) params.set(key, value);
  return `/projects/${encodeURIComponent(id)}/execution-graph${params.size ? '?' + params : ''}`;
}

export function readProjectWorkspace(path: string, search?: string) {
  const match = /^\/projects\/([\w-]+)(?:\/([\w-]+))?$/.exec(path);
  if (!match) return;
  const [, id, section] = match;
  const params = new URLSearchParams(search);
  const rawView = params.get('view') ?? '';
  const scope: ProjectScope = {
    view: /^(all|production|testing|abnormal|[a-f0-9-]{36})$/.test(rawView) ? rawView : undefined,
    serviceId: params.get('serviceId') || undefined,
    environmentId: params.get('environmentId') || undefined,
  };
  const rawResource = params.get('resource') ?? '';
  const legacyConfig = params.get('section') === 'deployment';
  const graphPane = params.get('graphPane');
  const location: ResourceLocation = {
    ...scope,
    resource: Object.hasOwn(projectResources, rawResource)
      ? (rawResource as ResourceKind)
      : legacyConfig
        ? 'services'
        : undefined,
    repositoryId: params.get('repositoryId') || undefined,
    serverId: params.get('serverId') || undefined,
    groupId: params.get('groupId') || undefined,
    panel: params.get('panel') || (legacyConfig && scope.environmentId ? 'settings' : undefined),
    graphPane:
      graphPane === 'draft' || graphPane === 'published' || graphPane === 'run'
        ? graphPane
        : undefined,
    graphVersion: params.get('graphVersion') || undefined,
    graphNode: params.get('graphNode') || undefined,
    graphFlow: params.get('graphFlow') || undefined,
    graphStart: params.get('graphStart') || undefined,
    graphField: params.get('graphField') || undefined,
    graphServiceId: params.get('graphServiceId') || undefined,
    graphEnvironmentId: params.get('graphEnvironmentId') || undefined,
    graphResourcePanel: params.get('graphResourcePanel') || undefined,
  };
  let entry: Entry = 'resources';
  let tab: DeliveryTab = 'artifacts';
  if (section === 'execution-graph') entry = 'graph';
  else if (section === 'configuration') entry = 'configuration';
  else if (section === 'delivery' || (section && Object.hasOwn(deliveryTabs, section))) {
    entry = 'delivery';
    const selected = section === 'delivery' ? params.get('tab') || '' : section;
    if (Object.hasOwn(deliveryTabs, selected)) tab = selected as DeliveryTab;
  } else if (section && section !== 'resources') return;
  return { id, entry, tab, search, location };
}

export function projectEntryPath(id: string, entry: Entry, scope: ProjectScope) {
  if (entry === 'graph') return projectGraphPath(id, scope);
  if (entry === 'delivery') return deliveryPath(id, 'artifacts', scope);
  if (entry === 'configuration')
    return `/projects/${encodeURIComponent(id)}/configuration${scope.view ? '?view=' + scope.view : ''}`;
  return projectResourcePath(id, {
    ...scope,
    resource: scope.serviceId ? 'services' : scope.environmentId ? 'environments' : undefined,
  });
}
