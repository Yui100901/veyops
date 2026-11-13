import { useState } from 'react';
import { Server as ServerIcon } from 'lucide-react';
import { useResource } from '../api';
import { ErrorBanner, Field, Loading, Status } from '../components';
import type { Environment, ProjectDetail, Server, ServerGroup } from '../models';

export interface TargetSelection {
  serverIds?: string[];
  groupIds?: string[];
  deploymentTargetIds?: string[];
  tags?: string[];
  projectIds?: string[];
  environmentIds?: string[];
}

export interface TargetPreview {
  count: number;
  targets: { id: string; name: string; host: string }[];
  targetHash: string;
}

export interface ExecutionOptions {
  strategy: 'PARALLEL' | 'SEQUENTIAL';
  maxParallel: number;
  failurePolicy: 'CONTINUE' | 'STOP';
}

export const defaultExecutionOptions: ExecutionOptions = {
  strategy: 'PARALLEL',
  maxParallel: 3,
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

function TargetOptions({
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

function EnvironmentTargetOptions({
  projects,
  selected,
  onChange,
  disabled,
}: {
  projects: NamedTarget[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <details className="version-entry">
      <summary>环境 · 已选 {selected.length}</summary>
      {projects.length ? (
        projects.map((project) => (
          <ProjectEnvironmentOptions
            key={project.id}
            project={project}
            selected={selected}
            onChange={onChange}
            disabled={disabled}
          />
        ))
      ) : (
        <p className="field-note">暂无可选项目环境</p>
      )}
    </details>
  );
}

function ProjectEnvironmentOptions({
  project,
  selected,
  onChange,
  disabled,
}: {
  project: NamedTarget;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const [path, setPath] = useState<string | null>(null);
  const detail = useResource<ProjectDetail>(path);
  const environments: Environment[] = detail.data?.environments ?? [];
  return (
    <div>
      <button
        type="button"
        className="text-button"
        onClick={() => setPath(path ? null : `/projects/${project.id}`)}
        aria-expanded={Boolean(path)}
      >
        {project.name}
      </button>
      {path &&
        (detail.loading ? (
          <Loading />
        ) : detail.error ? (
          <ErrorBanner error={detail.error} retry={detail.reload} />
        ) : (
          <TargetOptions
            label="项目环境"
            options={environments}
            selected={selected.filter((id) => environments.some((item) => item.id === id))}
            disabled={disabled}
            onChange={(ids) =>
              onChange([
                ...selected.filter((id) => !environments.some((item) => item.id === id)),
                ...ids,
              ])
            }
          />
        ))}
    </div>
  );
}

export function BatchTargetPicker({
  selection,
  onChange,
  disabled,
}: {
  selection: TargetSelection;
  onChange: (selection: TargetSelection) => void;
  disabled?: boolean;
}) {
  const servers = useResource<Server[]>('/servers');
  const groups = useResource<ServerGroup[]>('/server-groups');
  const deployments = useResource<NamedTarget[]>('/deployment-targets');
  const projects = useResource<NamedTarget[]>('/projects');
  const tagOptions = [...new Set(servers.data?.flatMap((server) => server.tags))].sort();
  const optionSets = [
    { key: 'groupIds', label: '服务器分组', options: groups.data ?? [] },
    {
      key: 'tags',
      label: '服务器标签',
      options: tagOptions.map((tag) => ({ id: tag, name: tag })),
    },
    { key: 'projectIds', label: '项目', options: projects.data ?? [] },
    { key: 'deploymentTargetIds', label: '部署目标', options: deployments.data ?? [] },
  ] as const;
  return (
    <>
      <ErrorBanner error={servers.error || groups.error || deployments.error || projects.error} />
      {servers.loading ? (
        <Loading />
      ) : (
        <ServerPicker
          servers={servers.data ?? []}
          selected={selection.serverIds ?? []}
          disabled={disabled}
          setSelected={(serverIds) => onChange({ ...selection, serverIds })}
        />
      )}
      <div className="batch-selector-options">
        {optionSets.map(({ key, label, options }) => (
          <TargetOptions
            key={key}
            label={label}
            options={options}
            selected={selection[key] ?? []}
            disabled={disabled}
            onChange={(ids) => onChange({ ...selection, [key]: ids })}
          />
        ))}
        <EnvironmentTargetOptions
          projects={projects.data ?? []}
          selected={selection.environmentIds ?? []}
          disabled={disabled}
          onChange={(environmentIds) => onChange({ ...selection, environmentIds })}
        />
      </div>
    </>
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
  options,
  onChange,
  disabled,
}: {
  options: ExecutionOptions;
  onChange: (options: ExecutionOptions) => void;
  disabled?: boolean;
}) {
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
      <Field label="最大并发">
        <input
          type="number"
          min={1}
          max={10}
          value={options.strategy === 'SEQUENTIAL' ? 1 : options.maxParallel}
          disabled={disabled || options.strategy === 'SEQUENTIAL'}
          onChange={(event) => onChange({ ...options, maxParallel: Number(event.target.value) })}
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
