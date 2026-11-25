const originFilters = {
  portal: ['q', 'tag', 'abnormal', 'projectId', 'serviceId'],
  projects: ['q'],
  servers: ['serverId', 'groupId'],
} as const;

type Origin = keyof typeof originFilters;

export type EntryOrigin = { origin?: Origin; originQuery?: string };

// Match the UUID variants accepted by the portal API.
const portalScopeId =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

function originParams(section: Origin, search?: string) {
  const source = new URLSearchParams(search);
  const target = new URLSearchParams();
  for (const key of originFilters[section]) {
    const value = source.get(key)?.trim();
    if (!value) continue;
    if (key === 'abnormal' && value !== 'true') continue;
    if ((key === 'projectId' || key === 'serviceId') && !portalScopeId.test(value)) continue;
    if ((key === 'serverId' || key === 'groupId') && !/^[\w-]{1,64}$/.test(value)) continue;
    target.set(key, value.slice(0, key === 'tag' ? 64 : 160));
  }
  return target;
}

export function portalFilterParams(search?: string) {
  return originParams('portal', search);
}

export function workspaceOrigin(origin: string | null | undefined, search?: string): EntryOrigin {
  if (!origin || !Object.hasOwn(originFilters, origin)) return {};
  const section = origin as Origin;
  const target = originParams(section, search);
  return { origin: section, originQuery: target.size ? target.toString() : undefined };
}

export function readWorkspaceOrigin(params: URLSearchParams) {
  return workspaceOrigin(params.get('origin'), params.get('originQuery') ?? undefined);
}

export function workspaceBackLink(location: {
  origin?: string | null;
  originQuery?: string | null;
}) {
  const { origin = 'projects', originQuery } = workspaceOrigin(
    location.origin,
    location.originQuery ?? undefined,
  );
  const labels = { portal: '服务门户', projects: '项目发布', servers: '服务器' };
  return { path: '/' + origin + (originQuery ? '?' + originQuery : ''), label: labels[origin] };
}
