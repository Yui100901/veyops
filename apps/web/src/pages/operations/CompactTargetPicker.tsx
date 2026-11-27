import { useState } from 'react';
import { ChevronDown, Layers, Server as ServerIcon } from 'lucide-react';
import { useResource } from '../../api';
import { ErrorBanner, Loading } from '../../components';
import type { Server, ServerGroup } from '../../models';
import type { TargetSelection } from './BatchTargets';
import './operation-workspace.css';

export function useBatchTargetResources(enabled = true) {
  const servers = useResource<Server[]>(enabled ? '/servers' : null);
  const groups = useResource<ServerGroup[]>(enabled ? '/server-groups' : null);
  return { servers, groups };
}

function CompactTargetMenu({
  label,
  icon: Icon,
  options,
  selected,
  partial = new Set(),
  onToggle,
  disabled,
}: {
  label: '服务器' | '服务器分组';
  icon: typeof ServerIcon;
  options: { id: string; name: string; hint: string }[];
  selected: Set<string>;
  partial?: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const unavailable = [...selected]
    .filter((id) => !options.some((option) => option.id === id))
    .map((id) => ({ id, name: `已不在清单中的目标 ${id.slice(0, 8)}`, hint: '' }));
  const matches = [...options, ...unavailable].filter(({ name, hint }) =>
    `${name} ${hint}`.toLowerCase().includes(keyword),
  );
  return (
    <details className="ops-target-menu">
      <summary>
        <Icon size={16} aria-hidden="true" />
        <span>{label}</span>
        <small>已选 {selected.size}</small>
        <ChevronDown size={15} className="ops-target-menu-chevron" aria-hidden="true" />
      </summary>
      <div className="ops-target-menu-body">
        {options.length > 6 && (
          <input
            type="search"
            aria-label={`搜索${label}`}
            placeholder={`搜索${label}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <div className="ops-target-menu-options">
          {matches.map(({ id, name, hint }) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={selected.has(id)}
                ref={(input) => {
                  if (input) input.indeterminate = partial.has(id);
                }}
                disabled={disabled}
                onChange={(event) => onToggle(id, event.target.checked)}
              />
              <span>{name}</span>
              {hint && <small>{hint}</small>}
            </label>
          ))}
          {!matches.length && (
            <p className="field-note">
              {options.length ? '没有匹配项' : `暂无可选${label}`}
              {!options.length && label === '服务器' && (
                <>
                  {' · '}
                  <a href="#/servers">接入服务器</a>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

export function resolveSelectedServerIds(selection: TargetSelection, groups: ServerGroup[]) {
  const ids = new Set(selection.serverIds);
  const selectedGroups = new Set(selection.groupIds);
  for (const group of groups) {
    if (selectedGroups.has(group.id)) for (const id of group.serverIds) ids.add(id);
  }
  return ids;
}

export function BatchTargetPicker({
  selection,
  onChange,
  disabled,
  resources,
}: {
  selection: TargetSelection;
  onChange: (selection: TargetSelection) => void;
  disabled?: boolean;
  resources?: ReturnType<typeof useBatchTargetResources>;
}) {
  const fetched = useBatchTargetResources(!resources);
  const { servers, groups } = resources ?? fetched;
  const groupList = groups.data ?? [];
  const serversSelected = resolveSelectedServerIds(selection, groupList);
  const explicitGroups = new Set(selection.groupIds);
  const groupsSelected = new Set(explicitGroups);
  const groupsPartial = new Set<string>();
  for (const { id, serverIds } of groupList) {
    if (serverIds.length && serverIds.every((serverId) => serversSelected.has(serverId)))
      groupsSelected.add(id);
    else if (!groupsSelected.has(id) && serverIds.some((serverId) => serversSelected.has(serverId)))
      groupsPartial.add(id);
  }

  function update(ids: string[], checked: boolean, groupId?: string) {
    const nextServers = new Set(serversSelected);
    const nextGroups = new Set(explicitGroups);
    if (groupId !== undefined) {
      if (checked) nextGroups.add(groupId);
      else nextGroups.delete(groupId);
    }
    for (const id of ids) {
      if (checked) nextServers.add(id);
      else nextServers.delete(id);
    }
    // A group can only remain an explicit target while every member is selected.
    // Keep the remaining members as individual targets when breaking a group selection.
    for (const group of groupList) {
      if (!nextGroups.has(group.id)) continue;
      if (group.serverIds.some((id) => !nextServers.has(id))) nextGroups.delete(group.id);
    }
    const covered = resolveSelectedServerIds({ groupIds: [...nextGroups] }, groupList);
    onChange({
      ...selection,
      serverIds: [...nextServers].filter((id) => !covered.has(id)),
      groupIds: [...nextGroups],
    });
  }
  return (
    <>
      <ErrorBanner error={servers.error} retry={servers.reload} />
      <ErrorBanner error={groups.error} retry={groups.reload} />
      {servers.loading || groups.loading ? (
        <Loading />
      ) : (
        <div className="ops-target-picker">
          <CompactTargetMenu
            label="服务器"
            icon={ServerIcon}
            options={(servers.data ?? []).map(({ id, name, host }) => ({ id, name, hint: host }))}
            selected={serversSelected}
            disabled={disabled}
            onToggle={(id, checked) => update([id], checked)}
          />
          <CompactTargetMenu
            label="服务器分组"
            icon={Layers}
            options={(groups.data ?? []).map(({ id, name, serverIds }) => ({
              id,
              name,
              hint: `${serverIds.length} 台`,
            }))}
            selected={groupsSelected}
            partial={groupsPartial}
            disabled={disabled}
            onToggle={(id, checked) =>
              update(groupList.find((group) => group.id === id)?.serverIds ?? [], checked, id)
            }
          />
        </div>
      )}
    </>
  );
}
