import { useExecutionDefaults } from '../projects/settings/useExecutionDefaults';
import { useState } from 'react';
import { Server as ServerIcon } from 'lucide-react';
import { Field, Status } from '../../components';
import type { Server } from '../../models';
export { BatchTargetPicker, useBatchTargetResources } from './CompactTargetPicker';

export interface TargetSelection {
  serverIds?: string[];
  groupIds?: string[];
  deploymentTargetIds?: string[];
  tags?: string[];
  projectIds?: string[];
  environmentIds?: string[];
}

export function useBatchSelection(initial: TargetSelection = {}) {
  const [selection, setSelection] = useState<TargetSelection>(() => ({
    serverIds: initial.serverIds ?? [],
    groupIds: initial.groupIds ?? [],
  }));
  return { selection, setSelection };
}

export interface TargetPreview {
  count: number;
  targets: { id: string; name: string; host: string }[];
  targetHash: string;
}

export interface ExecutionOptions {
  strategy: 'PARALLEL' | 'SEQUENTIAL';
  maxParallel?: number;
  failurePolicy: 'CONTINUE' | 'STOP';
}

export const defaultExecutionOptions: ExecutionOptions = {
  strategy: 'PARALLEL',
  failurePolicy: 'CONTINUE',
};

type NamedTarget = { id: string; name: string };

export function ServerPicker({
  servers,
  selected,
  setSelected,
  disabled,
}: {
  servers: Server[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="server-picker">
      {servers.length ? (
        servers.map((server) => (
          <label
            className={`server-option ${selected.includes(server.id) ? 'selected' : ''}`}
            key={server.id}
          >
            <input
              type="checkbox"
              checked={selected.includes(server.id)}
              disabled={disabled}
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? [...selected, server.id]
                    : selected.filter((id) => id !== server.id),
                )
              }
            />
            <ServerIcon size={17} />
            <span>
              <strong>{server.name}</strong>
              <small>{server.host}</small>
            </span>
            <Status value={server.status} />
          </label>
        ))
      ) : (
        <div className="mini-empty">
          还没有服务器。<a href="#/servers">接入服务器</a>
        </div>
      )}
    </div>
  );
}

export function TargetOptions({
  label,
  options,
  selected,
  onChange,
  disabled,
}: {
  label: string;
  options: NamedTarget[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <details className="version-entry">
      <summary>
        {label} · 已选 {selected.length}
      </summary>
      {options.length ? (
        <div className="batch-option-list">
          {options.map((option) => (
            <label key={option.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option.id]
                      : selected.filter((id) => id !== option.id),
                  )
                }
              />
              {option.name}
            </label>
          ))}
        </div>
      ) : (
        <p className="field-note">暂无可选{label}</p>
      )}
    </details>
  );
}

export function ResolvedTargets({ preview }: { preview: TargetPreview }) {
  return (
    <div className="confirmation-targets">
      {preview.targets.map((target) => (
        <span key={target.id}>
          <ServerIcon size={14} />
          {target.name}
          <small>{target.host}</small>
        </span>
      ))}
    </div>
  );
}

export function BatchStrategy({
  projectId,
  options,
  onChange,
  disabled,
}: {
  projectId?: string;
  options: ExecutionOptions;
  onChange: (options: ExecutionOptions) => void;
  disabled?: boolean;
}) {
  const defaults = useExecutionDefaults(projectId);
  return (
    <div className="form-grid">
      <Field label="执行方式">
        <select
          value={options.strategy}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...options, strategy: event.target.value as ExecutionOptions['strategy'] })
          }
        >
          <option value="PARALLEL">并行执行</option>
          <option value="SEQUENTIAL">顺序执行</option>
        </select>
      </Field>
      <Field
        label="本批同时执行的目标数"
        hint={projectId ? '留空使用项目生效值。' : '留空使用系统默认值。'}
      >
        <input
          type="number"
          min={1}
          max={10}
          value={options.strategy === 'SEQUENTIAL' ? 1 : (options.maxParallel ?? '')}
          placeholder={String(defaults.data?.defaultMaxParallelTargets ?? '')}
          disabled={disabled || options.strategy === 'SEQUENTIAL'}
          onChange={(event) =>
            onChange({
              ...options,
              maxParallel: event.target.value === '' ? undefined : Number(event.target.value),
            })
          }
        />
      </Field>
      <Field label="目标失败后">
        <select
          value={options.failurePolicy}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...options,
              failurePolicy: event.target.value as ExecutionOptions['failurePolicy'],
            })
          }
        >
          <option value="CONTINUE">继续其他目标</option>
          <option value="STOP">停止剩余目标</option>
        </select>
      </Field>
    </div>
  );
}
