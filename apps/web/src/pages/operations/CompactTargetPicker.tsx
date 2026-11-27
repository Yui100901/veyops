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
  onChange,
  disabled,
}: {
  label: '服务器' | '服务器分组';
  icon: typeof ServerIcon;
  options: { id: string; name: string; hint: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const unavailable = selected
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
        <small>已选 {selected.length}</small>
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
                checked={selected.includes(id)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, id]
                      : selected.filter((value) => value !== id),
                  )
                }
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
  function update(key: 'serverIds' | 'groupIds', values: string[]) {
    onChange({
      serverIds: selection.serverIds ?? [],
      groupIds: selection.groupIds ?? [],
      [key]: values,
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
            selected={selection.serverIds ?? []}
            disabled={disabled}
            onChange={(values) => update('serverIds', values)}
          />
          <CompactTargetMenu
            label="服务器分组"
            icon={Layers}
            options={(groups.data ?? []).map(({ id, name, serverIds }) => ({
              id,
              name,
              hint: `${serverIds.length} 台`,
            }))}
            selected={selection.groupIds ?? []}
            disabled={disabled}
            onChange={(values) => update('groupIds', values)}
          />
        </div>
      )}
    </>
  );
}
