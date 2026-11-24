import type { DeploymentSelection, ProjectDetail } from '../../../models';
import { useDeploymentInventory } from '../../delivery/DeploymentSelection';
import type {
  GraphBinding,
  GraphField,
  GraphNode,
  GraphStartGroup,
} from '../execution-graph-definition';

export const graphStartGroupFields = {
  source: {
    primary: 'repository',
    companion: 'gitVersion',
    primaryType: 'REPOSITORY',
    companionType: 'GIT_REF',
    input: 'repository',
    pairedInput: 'version',
    label: '源码',
  },
  release: {
    primary: 'service',
    companion: 'releaseTargets',
    primaryType: 'SERVICE',
    companionType: 'TARGETS',
    input: 'service',
    pairedInput: 'targets',
    label: '发布组合',
  },
} as const;

export type GraphStartGroupKind = keyof typeof graphStartGroupFields;
export type GraphTargetNames = {
  servers: ReadonlyMap<string, string>;
  groups: ReadonlyMap<string, string>;
};

export function useGraphTargetNames(enabled: boolean): GraphTargetNames {
  const { servers, groups } = useDeploymentInventory(enabled);
  return {
    servers: new Map(servers.data?.map(({ id, name }) => [id, name])),
    groups: new Map(groups.data?.map(({ id, name }) => [id, name])),
  };
}

export function graphResourceId(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if ('repositoryId' in value && typeof value.repositoryId === 'string')
      return value.repositoryId;
    if ('serviceId' in value && typeof value.serviceId === 'string') return value.serviceId;
  }
}

export function getGraphStartGroups(
  start: GraphNode | undefined,
  kind: GraphStartGroupKind,
  catalog?: GraphStartGroup[],
): GraphStartGroup[] {
  if (catalog) return catalog;
  const config = graphStartGroupFields[kind];
  const fields = start?.inputs ?? [];
  const primaries = fields.filter(({ type, multiple }) => type === config.primaryType && !multiple);
  return primaries.flatMap((primary) => {
    const canonical = primary.id === config.primary || primary.id.startsWith(config.primary + '-');
    if (!canonical && primaries.length > 1) return [];
    const companionId =
      config.companion + (canonical ? primary.id.slice(config.primary.length) : '');
    const expected = fields.find(({ id }) => id === companionId);
    let companion =
      expected?.type === config.companionType && !expected.multiple ? expected : undefined;
    if (!expected && primaries.length === 1 && companionId === config.companion) {
      const legacy = fields.filter(
        ({ type, purpose, id, multiple }) =>
          type === config.companionType &&
          !multiple &&
          !id.startsWith(config.companion + '-') &&
          (kind === 'source' || purpose === 'RELEASE_TARGETS'),
      );
      if (legacy.length === 1) companion = legacy[0];
    }
    return [{ id: primary.id, label: primary.name, primary, companion }];
  });
}

export function isGraphSharedReleaseTarget(
  kind: GraphStartGroupKind,
  groups: GraphStartGroup[],
  binding?: GraphBinding,
) {
  return (
    kind === 'release' &&
    groups.length === 1 &&
    binding?.kind === 'INPUT' &&
    binding.fieldId === 'buildTargets'
  );
}

export function selectedGraphStartGroup(
  kind: GraphStartGroupKind,
  groups: GraphStartGroup[],
  bindings?: Record<string, GraphBinding>,
) {
  const config = graphStartGroupFields[kind];
  const binding = bindings?.[config.input];
  const companion = bindings?.[config.pairedInput];
  const group = binding
    ? groups.find(({ id }) => binding.kind === 'INPUT' && id === binding.fieldId)
    : groups.length === 1
      ? groups[0]
      : undefined;
  if (binding?.onMissing !== undefined && binding.onMissing !== 'ERROR') return undefined;
  if (
    companion &&
    ((!(companion.kind === 'INPUT' && companion.fieldId === group?.companion?.id) &&
      !isGraphSharedReleaseTarget(kind, groups, companion)) ||
      (companion.onMissing !== undefined &&
        companion.onMissing !== 'ERROR' &&
        !(kind === 'source' && companion.onMissing === 'REPOSITORY_DEFAULT')))
  )
    return undefined;
  return group;
}

export function graphStartGroupCompanion(
  start: GraphNode | undefined,
  kind: GraphStartGroupKind,
  groups: GraphStartGroup[],
  group: GraphStartGroup,
  binding?: GraphBinding,
) {
  const sameHost =
    (kind === 'release' && groups.length === 1 && start?.sameHostRelease) ||
    isGraphSharedReleaseTarget(kind, groups, binding);
  return sameHost
    ? start?.inputs?.find(({ id, type }) => id === 'buildTargets' && type === 'TARGETS')
    : group.companion;
}

function sourceDetails(
  primary: GraphField,
  companion: GraphField | undefined,
  project: ProjectDetail,
) {
  const value = graphResourceId(primary.defaultValue);
  const repository = project.repositories.find(
    ({ id, cloneUrl }) => id === value || cloneUrl === value,
  );
  const version = companion?.defaultValue as { kind?: string; value?: string } | undefined;
  const versionName =
    version?.value && version.kind
      ? (version.kind === 'TAG' ? 'Tag ' : version.kind === 'COMMIT' ? 'SHA ' : '分支 ') +
        version.value
      : version !== undefined
        ? '版本待填写'
        : repository?.defaultBranch
          ? '默认分支 ' + repository.defaultBranch
          : '仓库默认分支';
  return [repository?.name ?? (value ? '仓库不可用' : '待选仓库'), versionName];
}

function releaseDetails(
  primary: GraphField,
  companion: GraphField | undefined,
  project: ProjectDetail,
  targetNames?: GraphTargetNames,
) {
  const serviceId = graphResourceId(primary.defaultValue);
  const service = project.services.find(({ id }) => id === serviceId);
  const targets = companion?.defaultValue as DeploymentSelection | undefined;
  const names = [
    ...(targets?.serverIds ?? []).map((id) => targetNames?.servers.get(id) ?? id),
    ...(targets?.groupIds ?? []).map((id) => (targetNames?.groups.get(id) ?? id) + '（分组）'),
  ];
  return [
    service?.name ?? (serviceId ? '服务不可用' : '待选服务'),
    names.length ? names.join('、') : '待选发布目标',
  ];
}

export function graphStartGroupDetails(
  kind: GraphStartGroupKind,
  group: GraphStartGroup,
  project: ProjectDetail,
  targetNames?: GraphTargetNames,
) {
  return kind === 'source'
    ? sourceDetails(group.primary, group.companion, project)
    : releaseDetails(group.primary, group.companion, project, targetNames);
}
