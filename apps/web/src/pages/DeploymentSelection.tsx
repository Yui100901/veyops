import { useState } from 'react';
import { Network } from 'lucide-react';
import { useResource } from '../api';
import { ErrorBanner, Field, Loading } from '../components';
import type { DeploymentSelection, Server, ServerGroup } from '../models';
import { BatchStrategy, ServerPicker, defaultExecutionOptions } from './BatchTargets';
import './deployment-selection.css';

export function useDeploymentInventory(enabled = true) {
  const servers = useResource<Server[]>(enabled ? '/servers' : null);
  const groups = useResource<ServerGroup[]>(enabled ? '/server-groups' : null);
  return { servers, groups };
}

export function deploymentSelection(value?: DeploymentSelection | null): DeploymentSelection {
  return {
    serverIds: value?.serverIds ?? [],
    groupIds: value?.groupIds ?? [],
    strategy: value?.strategy,
    maxParallel: value?.maxParallel,
    failurePolicy: value?.failurePolicy,
  };
}

export function hasDeploymentSelection(value: DeploymentSelection) {
  return Boolean(value.serverIds?.length || value.groupIds?.length);
}

export function selectedDeploymentServers(selection: DeploymentSelection, groups: ServerGroup[]) {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  return Array.from(
    new Set([
      ...(selection.serverIds ?? []),
      ...(selection.groupIds ?? []).flatMap((id) => groupById.get(id)?.serverIds ?? []),
    ]),
  );
}

type Inventory = ReturnType<typeof useDeploymentInventory>;

export function DeploymentSelectionPicker({
  projectId,
  inventory,
  value,
  onChange,
  disabled,
}: {
  projectId?: string;
  inventory: Inventory;
  value: DeploymentSelection;
  onChange: (value: DeploymentSelection) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const { servers, groups } = inventory;
  const serverList = servers.data ?? [];
  const groupList = groups.data ?? [];
  const serverIds = value.serverIds ?? [];
  const groupIds = value.groupIds ?? [];
  const serverNames = new Map(serverList.map(({ id, name }) => [id, name]));
  const groupNames = new Map(groupList.map(({ id, name }) => [id, name]));
  const term = search.trim().toLowerCase();
  const foundServers = serverList.filter((server) =>
    [server.name, server.host, ...server.tags].some((text) => text.toLowerCase().includes(term)),
  );
  const foundGroups = groupList.filter((group) =>
    [group.name, ...group.serverIds.map((id) => serverNames.get(id) ?? '')].some((text) =>
      text.toLowerCase().includes(term),
    ),
  );
  const unavailableServers =
    !servers.loading && !servers.error ? serverIds.filter((id) => !serverNames.has(id)) : [];
  const unavailableGroups =
    !groups.loading && !groups.error ? groupIds.filter((id) => !groupNames.has(id)) : [];
  const selectedServers = selectedDeploymentServers(value, groupList);
  return (
    <fieldset className="deployment-source-picker" disabled={disabled}>
      <legend>选择服务器或服务器分组</legend>
      <Field label="搜索服务器与分组">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="输入名称、主机地址或标签"
        />
      </Field>
      <div className="deployment-source-columns">
        <section aria-label="服务器">
          <h3>
            服务器 <span>已选 {serverIds.length} 台</span>
          </h3>
          <ErrorBanner error={servers.error} retry={servers.reload} />
          {servers.loading ? (
            <Loading />
          ) : foundServers.length ? (
            <ServerPicker
              servers={foundServers}
              selected={serverIds}
              setSelected={(ids) => onChange({ ...value, serverIds: ids })}
              disabled={disabled}
            />
          ) : (
            !servers.error && (
              <p className="muted">
                {term && serverList.length ? (
                  '没有匹配的服务器。'
                ) : (
                  <>
                    还没有服务器。 <a href="#/servers">添加服务器</a>
                  </>
                )}
              </p>
            )
          )}
        </section>
        <section aria-label="服务器分组">
          <h3>
            服务器分组 <span>已选 {groupIds.length} 组</span>
          </h3>
          <ErrorBanner error={groups.error} retry={groups.reload} />
          {groups.loading ? (
            <Loading />
          ) : foundGroups.length ? (
            <div className="server-picker">
              {foundGroups.map((group) => (
                <label
                  className={`server-option ${groupIds.includes(group.id) ? 'selected' : ''}`}
                  key={group.id}
                >
                  <input
                    type="checkbox"
                    checked={groupIds.includes(group.id)}
                    onChange={(event) =>
                      onChange({
                        ...value,
                        groupIds: event.target.checked
                          ? [...groupIds, group.id]
                          : groupIds.filter((id) => id !== group.id),
                      })
                    }
                  />
                  <Network size={18} />
                  <span>
                    <strong>{group.name}</strong>
                    <small>
                      {group.serverIds.map((id) => serverNames.get(id) ?? id).join('、') ||
                        '暂无成员'}
                    </small>
                  </span>
                  <span className="tag">{group.serverIds.length} 台</span>
                </label>
              ))}
            </div>
          ) : (
            !groups.error && (
              <p className="muted">
                {term && groupList.length ? (
                  '没有匹配的服务器分组。'
                ) : (
                  <>
                    还没有分组。 <a href="#/servers">管理服务器分组</a>
                  </>
                )}
              </p>
            )
          )}
        </section>
      </div>
      {(unavailableServers.length > 0 || unavailableGroups.length > 0) && (
        <div className="deployment-source-selection" role="status">
          <p>有已选服务器或分组不可用，请检查后重新选择。</p>
          <button
            className="button secondary small"
            type="button"
            onClick={() =>
              onChange({
                ...value,
                serverIds: serverIds.filter((id) => !unavailableServers.includes(id)),
                groupIds: groupIds.filter((id) => !unavailableGroups.includes(id)),
              })
            }
          >
            清除不可用项
          </button>
        </div>
      )}
      <div className="deployment-source-selection" role="status">
        <strong>当前成员 · {selectedServers.length} 台</strong>
        {selectedServers.length > 0 && (
          <p>{selectedServers.map((id) => serverNames.get(id) ?? id).join('、')}</p>
        )}
      </div>
      <details className="advanced-options">
        <summary>执行策略</summary>
        {value.strategy === 'SEQUENTIAL' && (
          <p className="field-note">
            先按勾选顺序执行单台服务器，再执行分组成员。重复成员只执行一次。
          </p>
        )}
        <BatchStrategy
          projectId={projectId}
          disabled={disabled}
          options={{
            strategy: value.strategy ?? defaultExecutionOptions.strategy,
            maxParallel: value.maxParallel,
            failurePolicy: value.failurePolicy ?? defaultExecutionOptions.failurePolicy,
          }}
          onChange={(options) => onChange({ ...value, ...options })}
        />
      </details>
    </fieldset>
  );
}
