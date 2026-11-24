import { deliveryPath, deliveryTabs, type DeliveryTab } from '../delivery/delivery-route';
import {
  graphResourcePanel,
  graphWorkbenchPath,
  type GraphPane,
  type GraphStartLocation,
} from '../execution-graph/graph-workbench-context';

export const projectEntries = {
  resources: '项目资源',
  graph: '执行图',
  artifacts: '产物',
  configuration: '项目配置',
} as const;

export const projectResources = {
  repositories: '仓库',
  services: '服务',
  'environment-sets': '变量集合',
  relations: '项目依赖',
} as const;

type Entry = keyof typeof projectEntries;
export type ResourceKind = keyof typeof projectResources | 'environments';
export type ProjectScope = {
  serviceId?: string;
  environmentId?: string;
  view?: string;
  viewSearch?: string;
};
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
    environmentSetId?: string;
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
    'resource' | 'repositoryId' | 'serviceId' | 'environmentId' | 'environmentSetId' | 'panel'
  >,
) {
  return (
    '#' +
    projectResourcePath(id, {
      ...destination,
      view: origin.view,
      viewSearch: origin.viewSearch,
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

export function graphResourceReturnHref(
  id: string,
  context: GraphResourceReturn,
  view?: string,
  viewSearch?: string,
) {
  const version = Number(context.graphVersion);
  return (
    '#' +
    graphWorkbenchPath(id, {
      view,
      viewSearch,
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
  const viewSearch = new URLSearchParams(params.get('viewSearch') ?? '');
  for (const [key, value] of [...viewSearch]) {
    if (!['serviceId', 'serverId', 'groupId'].includes(key) || !/^[\w-]+$/.test(value))
      viewSearch.delete(key);
  }
  const scope: ProjectScope = {
    view: /^(all|production|testing|abnormal|[a-f0-9-]{36})$/.test(rawView) ? rawView : undefined,
    serviceId: params.get('serviceId') || undefined,
    environmentId: params.get('environmentId') || undefined,
    viewSearch: viewSearch.size ? viewSearch.toString() : undefined,
  };
  const rawResource = params.get('resource') ?? '';
  const legacyConfig = params.get('section') === 'deployment';
  const graphPane = params.get('graphPane');
  const location: ResourceLocation = {
    ...scope,
    resource:
      rawResource === 'environments' || Object.hasOwn(projectResources, rawResource)
        ? (rawResource as ResourceKind)
        : legacyConfig
          ? 'services'
          : undefined,
    repositoryId: params.get('repositoryId') || undefined,
    environmentSetId: params.get('environmentSetId') || undefined,
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
    entry = 'artifacts';
    const selected = section === 'delivery' ? params.get('tab') || '' : section;
    if (Object.hasOwn(deliveryTabs, selected)) tab = selected as DeliveryTab;
  } else if (section && section !== 'resources') return;
  return { id, entry, tab, search, location };
}

export function projectEntryPath(id: string, entry: Entry, scope: ProjectScope) {
  if (entry === 'graph') return projectGraphPath(id, scope);
  if (entry === 'artifacts') return deliveryPath(id, 'artifacts', scope);
  if (entry === 'configuration') {
    const params = new URLSearchParams();
    if (scope.view) params.set('view', scope.view);
    if (scope.viewSearch) params.set('viewSearch', scope.viewSearch);
    return `/projects/${encodeURIComponent(id)}/configuration${params.size ? '?' + params : ''}`;
  }
  return projectResourcePath(id, {
    ...scope,
    resource: scope.serviceId ? 'services' : undefined,
  });
}
