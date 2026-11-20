export const deliveryTabs = {
  artifacts: '构建产物',
  deployments: '部署与回滚',
  approvals: '待审批发布',
} as const;

export type DeliveryTab = keyof typeof deliveryTabs;
export type DeliveryScope = {
  serviceId?: string | null;
  environmentId?: string | null;
  commit?: string | null;
  recordId?: string | null;
  pipelineRunId?: string | null;
  taskId?: string | null;
  repositoryId?: string | null;
  view?: string | null;
};

export function readDeliveryScope(params: URLSearchParams): DeliveryScope {
  return {
    serviceId: params.get('serviceId'),
    environmentId: params.get('environmentId'),
    commit: params.get('commit'),
    recordId: params.get('recordId'),
    pipelineRunId: params.get('pipelineRunId'),
    taskId: params.get('taskId'),
    repositoryId: params.get('repositoryId'),
    view: params.get('view'),
  };
}

export function deliveryPath(projectId: string, tab: DeliveryTab, scope: DeliveryScope = {}) {
  const query = new URLSearchParams({ tab });
  for (const [key, value] of Object.entries(scope)) if (value) query.set(key, value);
  return `/projects/${encodeURIComponent(projectId)}/delivery?${query}`;
}

function deliveryReturnParams(tab: DeliveryTab, scope: DeliveryScope) {
  const query = new URLSearchParams({ deliveryTab: tab });
  for (const [key, value] of Object.entries(scope)) if (value) query.set(key, value);
  return query;
}

export function deliveryTaskPath(taskId: string, tab: DeliveryTab, scope: DeliveryScope = {}) {
  const query = deliveryReturnParams(tab, scope);
  return `/tasks/${encodeURIComponent(taskId)}?${query}`;
}

export function deliveryGraphRunPath(
  projectId: string,
  runId: string,
  tab: DeliveryTab,
  scope: DeliveryScope,
) {
  const query = deliveryReturnParams(tab, scope);
  query.set('run', runId);
  return `/projects/${encodeURIComponent(projectId)}/execution-graph?${query}`;
}

export function deliveryTaskReturn(projectId: string, search?: string) {
  const params = new URLSearchParams(search);
  const tab = params.get('deliveryTab');
  if (tab && Object.hasOwn(deliveryTabs, tab))
    return deliveryPath(projectId, tab as DeliveryTab, readDeliveryScope(params));
}
