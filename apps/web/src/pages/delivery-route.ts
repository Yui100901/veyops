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
};

export function deliveryPath(projectId: string, tab: DeliveryTab, scope: DeliveryScope = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(scope)) if (value) query.set(key, value);
  return `/projects/${encodeURIComponent(projectId)}/${tab}${query.size ? '?' + query : ''}`;
}
