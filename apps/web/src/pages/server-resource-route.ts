type ServerResourceLocation = {
  serverId?: string;
  groupId?: string;
  panel?: 'metrics';
  projectId?: string;
  returnPath?: string;
};

function projectReturn(projectId?: string, path?: string) {
  if (!projectId || !path) return undefined;
  const match =
    /^\/projects\/([\w-]+)(?:\/(?:execution-graph|artifacts|delivery|configuration))?(?:\?[^#]*)?$/.exec(
      path,
    );
  return match?.[1] === projectId ? path : undefined;
}

export function readServerResourceLocation(search?: string): ServerResourceLocation {
  const params = new URLSearchParams(search);
  const projectId = params.get('projectId') || undefined;
  return {
    serverId: params.get('serverId') || undefined,
    groupId: params.get('groupId') || undefined,
    panel: params.get('panel') === 'metrics' ? 'metrics' : undefined,
    projectId,
    returnPath: projectReturn(projectId, params.get('returnPath') || undefined),
  };
}

export function serverResourceHref(location: ServerResourceLocation) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    ...location,
    returnPath: projectReturn(location.projectId, location.returnPath),
  })) {
    if (value) params.set(key, value);
  }
  return `#/servers${params.size ? '?' + params : ''}`;
}
