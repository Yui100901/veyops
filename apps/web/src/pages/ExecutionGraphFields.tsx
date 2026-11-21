import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type { Credential, DeploymentSelection, ProjectDetail, Repository } from '../models';
import { DeploymentSelectionPicker, useDeploymentInventory } from './DeploymentSelection';
import {
  artifactInstanceId,
  artifactKindLabel,
  artifactLogicalId,
  isDeployableArtifact,
  type Artifact,
  type ArtifactRef,
} from './Delivery';
import { useRepositoryBranches } from './RepositoryBranches';
import { graphKey } from './execution-graph-definition';
import type { EnvironmentSetSummary } from './ProjectEnvironmentSets';
import type {
  GraphArtifactType,
  GraphBinding,
  GraphCatalog,
  GraphField,
  GraphFieldType,
  GraphMissingPolicy,
} from './execution-graph-definition';

export const artifactTypes: { value: GraphArtifactType; label: string }[] = [
  { value: 'FILE', label: '文件' },
  { value: 'DIRECTORY', label: '目录' },
  { value: 'DOCKER_IMAGE', label: 'Docker 镜像' },
];

export type FieldScope = {
  repositoryId?: string;
  environmentId?: string;
  serviceId?: string;
  targets?: DeploymentSelection;
};

interface ValueProps {
  project: ProjectDetail;
  field: GraphField;
  value: unknown;
  change: (value: unknown) => void;
  disabled?: boolean;
  scope?: FieldScope;
  canRegisterRepository?: boolean;
  checkRequired?: boolean;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function referenceId(value: unknown) {
  if (value && typeof value === 'object') {
    if ('serviceId' in value) return stringValue(value.serviceId);
    if ('artifactId' in value) return stringValue(value.artifactId);
    if ('id' in value) return stringValue(value.id);
  }
  return stringValue(value);
}

function ResourceSelect({
  label,
  options,
  value,
  change,
  disabled,
  required,
  empty = '请选择',
}: {
  label: string;
  options: { id: string; name: string }[];
  value: unknown;
  change: (value: string | undefined) => void;
  disabled?: boolean;
  required?: boolean;
  empty?: string;
}) {
  const selected = referenceId(value);
  return (
    <Field label={label}>
      <select
        aria-label={label}
        required={required}
        disabled={disabled}
        value={selected}
        onChange={(event) => change(event.target.value || undefined)}
      >
        <option value="">{empty}</option>
        {selected && !options.some(({ id }) => id === selected) && (
          <option value={selected} disabled>
            原有引用不可用
          </option>
        )}
        {options.map(({ id, name }) => (
          <option value={id} key={id}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function RepositoryValue({
  project,
  field,
  value,
  change,
  disabled,
  canRegisterRepository,
  checkRequired,
}: ValueProps) {
  const [url, setUrl] = useState('');
  const [added, setAdded] = useState<Repository[]>([]);
  const [registration, setRegistration] = useState(false);
  const [name, setName] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const credentials = useResource<Credential[]>(registration ? '/credentials' : null);
  const repositories = [
    ...project.repositories,
    ...added.filter(({ id }) => !project.repositories.some((repo) => repo.id === id)),
  ];
  const normalize = (address: string) =>
    address
      .trim()
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
  const match = repositories.find((repo) => normalize(repo.cloneUrl) === normalize(url));
  async function register() {
    setError('');
    setBusy(true);
    try {
      const repo = await post<Repository>('/projects/' + project.id + '/repositories', {
        name: name.trim(),
        cloneUrl: url.trim(),
        ...(credentialId && { credentialId }),
      });
      setAdded([...added, repo]);
      change(repo.id);
      setUrl('');
      setRegistration(false);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ResourceSelect
        label={field.name}
        options={repositories}
        value={value}
        change={change}
        disabled={disabled || busy}
        required={checkRequired && field.required}
      />
      {!disabled && (
        <div className="graph-variable-actions">
          <Field label="按仓库地址匹配">
            <input
              inputMode="url"
              placeholder="https://git.example.org/team/project.git"
              value={url}
              onChange={(event) => {
                const entered = event.target.value;
                setUrl(entered);
                const hit = repositories.find(
                  (repo) => normalize(repo.cloneUrl) === normalize(entered),
                );
                if (hit) change(hit.id);
              }}
            />
          </Field>
          {url.trim() &&
            !match &&
            canRegisterRepository &&
            (!registration ? (
              <button
                type="button"
                className="button secondary small"
                onClick={() => setRegistration(true)}
              >
                <Plus size={14} /> 登记仓库并选用
              </button>
            ) : (
              <>
                <Field label="仓库名称">
                  <input
                    value={name}
                    maxLength={100}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <ResourceSelect
                  label="仓库凭据（可选）"
                  options={credentials.data ?? []}
                  value={credentialId}
                  change={(id) => setCredentialId(id ?? '')}
                  empty="公开仓库"
                />
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy || !name.trim() || !/^https?:\/\/\S+$/i.test(url.trim())}
                  onClick={() => void register()}
                >
                  保存并选用
                </button>
                <ErrorBanner error={error || credentials.error} />
              </>
            ))}
        </div>
      )}
    </>
  );
}

function GitVersionValue({
  project,
  field,
  value,
  change,
  disabled,
  scope,
  checkRequired,
}: ValueProps) {
  const current = value as { kind?: string; value?: string } | undefined;
  const kind = current?.kind ?? 'BRANCH';
  const list = useId();
  const branches = useRepositoryBranches(
    scope?.repositoryId ? '/projects/' + project.id + '/repositories/' + scope.repositoryId : null,
  );
  return (
    <div className="graph-fields">
      <div className="graph-field-pair">
        <Field label={field.name}>
          <select
            value={kind}
            disabled={disabled}
            onChange={(event) => change({ kind: event.target.value, value: '' })}
          >
            <option value="BRANCH">分支</option>
            <option value="TAG">标签</option>
            <option value="COMMIT">提交 SHA</option>
          </select>
        </Field>
        <Field
          label={kind === 'BRANCH' ? '分支名称' : kind === 'TAG' ? '标签名称' : '完整提交 SHA'}
        >
          <input
            required={checkRequired && (field.required || value !== undefined)}
            disabled={disabled}
            value={current?.value ?? ''}
            list={kind === 'BRANCH' ? list : undefined}
            pattern={kind === 'COMMIT' ? '(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})' : undefined}
            onChange={(event) => change({ kind, value: event.target.value })}
          />
          <datalist id={list}>
            {branches.data?.branches.map(({ name }) => (
              <option value={name} key={name} />
            ))}
          </datalist>
        </Field>
      </div>
      {!field.required && value !== undefined && !disabled && (
        <button type="button" className="button secondary small" onClick={() => change(undefined)}>
          清除版本
        </button>
      )}
    </div>
  );
}

function ArtifactValue({
  project,
  field,
  value,
  change,
  disabled,
  scope,
  checkRequired,
}: ValueProps) {
  const query = new URLSearchParams({ projectId: project.id });
  if (scope?.serviceId) query.set('serviceId', scope.serviceId);
  if (field.artifactType) query.set('kind', field.artifactType);
  const versions = useResource<Artifact[]>('/artifacts?' + query);
  const inventory = useDeploymentInventory();
  const servers = new Set([
    ...(scope?.targets?.serverIds ?? []),
    ...(inventory.groups.data ?? [])
      .filter(({ id }) => scope?.targets?.groupIds?.includes(id))
      .flatMap(({ serverIds }) => serverIds),
  ]);
  const pendingTargets = !!scope?.targets?.groupIds?.length && inventory.groups.loading;
  const selected = (Array.isArray(value) ? value : [value])
    .map((item) => {
      const id = referenceId(item);
      return id && item && typeof item === 'object' && 'instanceId' in item && item.instanceId
        ? id + ':' + stringValue(item.instanceId)
        : id;
    })
    .filter(Boolean);
  const groups = new Map<string, Artifact[]>();
  const serverNames = new Map((inventory.servers.data ?? []).map(({ id, name }) => [id, name]));
  const targetOf = (artifact: Artifact) => artifact.serverId ?? artifact.physical?.serverId;
  for (const artifact of versions.data ?? []) {
    const server = targetOf(artifact);
    if (
      !isDeployableArtifact(artifact) ||
      (field.artifactType && field.artifactType !== (artifact.kind ?? artifact.artifactType)) ||
      (scope?.serviceId && artifact.serviceId !== scope.serviceId) ||
      (server && servers.size > 0 && !servers.has(server))
    )
      continue;
    const id = artifactLogicalId(artifact);
    const group = groups.get(id);
    if (group) group.push(artifact);
    else groups.set(id, [artifact]);
  }
  const selectable = new Map<string, { name: string; ref: ArtifactRef }>();
  for (const [artifactId, instances] of groups) {
    const artifact = instances[0]!;
    const title = [
      artifact.name ?? artifactKindLabel(artifact.kind ?? artifact.artifactType),
      artifact.sourceCommit?.slice(0, 12),
      formatTime(artifact.createdAt),
    ]
      .filter(Boolean)
      .join(' · ');
    const selectableInstances = instances.filter(
      (instance) =>
        targetOf(instance) ||
        !servers.size ||
        instance.downloadAvailable ||
        instance.physical?.location === 'REGISTRY' ||
        instance.storageType === 'REGISTRY_IMAGE',
    );
    const compatible =
      !servers.size ||
      selectableInstances.some((item) => !targetOf(item)) ||
      [...servers].every((server) => selectableInstances.some((item) => targetOf(item) === server));
    if (selectableInstances.length && compatible)
      selectable.set(artifactId, {
        name: title + ' · ' + selectableInstances.length + ' 个实例',
        ref: { artifactId },
      });
    if (
      (!compatible && field.multiple) ||
      (!field.multiple && selectableInstances.length > 1 && servers.size <= 1)
    )
      for (const instance of selectableInstances) {
        const instanceId = artifactInstanceId(instance);
        const server = targetOf(instance);
        selectable.set(artifactId + ':' + instanceId, {
          name: title + ' · ' + (server ? (serverNames.get(server) ?? server) : '管理端'),
          ref: { artifactId, instanceId },
        });
      }
  }
  const rows = [...selectable].map(([id, { name }]) => ({ id, name }));
  const stale = selected.filter((id) => !selectable.has(id));
  const latest = field.selection === 'LATEST_COMPATIBLE';
  return (
    <>
      {field.multiple ? (
        <Field
          label={field.name}
          hint={latest ? '不选择时，预览会锁定最新兼容产物。' : '可按目标选择一组产物。'}
        >
          <select
            multiple
            size={Math.min(5, Math.max(2, rows.length))}
            aria-label={field.name}
            disabled={disabled || versions.loading || pendingTargets}
            required={checkRequired && field.required && !latest}
            value={selected}
            onChange={(event) => {
              const choices = Array.from(
                event.target.selectedOptions,
                ({ value }) => selectable.get(value)?.ref,
              ).filter((option): option is ArtifactRef => !!option);
              change(choices.length ? choices : undefined);
            }}
          >
            {stale.map((id) => (
              <option key={id} value={id} disabled>
                已选产物不可用
              </option>
            ))}
            {rows.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <ResourceSelect
          label={field.name}
          options={rows}
          value={selected[0]}
          change={(id) => change(id ? selectable.get(id)?.ref : undefined)}
          disabled={disabled || versions.loading || pendingTargets}
          required={checkRequired && field.required && !latest}
          empty={latest ? '使用最新兼容产物' : '选择已有产物'}
        />
      )}
      {!versions.loading && !rows.length && <p className="field-note">没有匹配的可用产物。</p>}
      <ErrorBanner error={versions.error} retry={versions.reload} />
    </>
  );
}

function TargetsValue({ project, field, value, change, disabled }: ValueProps) {
  const inventory = useDeploymentInventory();
  return (
    <>
      <strong>{field.name}</strong>
      <DeploymentSelectionPicker
        projectId={project.id}
        inventory={inventory}
        value={(value ?? {}) as DeploymentSelection}
        onChange={change}
        disabled={disabled}
      />
    </>
  );
}

function CredentialsValue({ field, value, change, disabled, checkRequired }: ValueProps) {
  const credentials = useResource<Credential[]>('/credentials');
  return (
    <>
      <ResourceSelect
        label={field.name}
        options={credentials.data ?? []}
        value={value}
        change={change}
        disabled={disabled}
        required={checkRequired && field.required}
        empty="选择凭据引用"
      />
      <ErrorBanner error={credentials.error} retry={credentials.reload} />
    </>
  );
}

export function useProjectEnvironmentSets(projectId: string, active = true) {
  return useResource<EnvironmentSetSummary[]>(
    active ? `/projects/${encodeURIComponent(projectId)}/environment-sets` : null,
  );
}

function EnvironmentSetValue({
  project,
  field,
  value,
  disabled,
  checkRequired,
  change,
}: ValueProps) {
  const sets = useProjectEnvironmentSets(project.id);
  const options = (sets.data ?? []).filter(
    ({ id }) => !field.options || field.options.includes(id),
  );
  return (
    <>
      <ResourceSelect
        label={field.name}
        options={options}
        value={value}
        change={change}
        disabled={disabled || sets.loading}
        required={checkRequired && field.required}
        empty={field.required ? '选择变量集合' : '不使用变量集合'}
      />
      <ErrorBanner error={sets.error} retry={sets.reload} />
    </>
  );
}

export function GraphFieldValue(props: ValueProps) {
  const { project, field, value, change, disabled, checkRequired } = props;
  const required = checkRequired && field.required;
  if (field.multiple && field.type !== 'ARTIFACT') {
    const values = Array.isArray(value) ? value : [];
    return (
      <fieldset className="graph-fields" disabled={disabled}>
        <legend>{field.name}</legend>
        {values.map((item, index) => (
          <div key={index} className="graph-field-pair">
            <GraphFieldValue
              {...props}
              field={{ ...field, name: '第 ' + (index + 1) + ' 项', multiple: false }}
              value={item}
              change={(next) => change(values.map((current, i) => (i === index ? next : current)))}
            />
            <button
              type="button"
              className="button secondary small"
              aria-label={'移除第 ' + (index + 1) + ' 项'}
              onClick={() => change(values.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button secondary small"
          onClick={() => change([...values, field.type === 'BOOLEAN' ? false : ''])}
        >
          <Plus size={14} /> 添加一项
        </button>
      </fieldset>
    );
  }
  if (field.type === 'REPOSITORY') return <RepositoryValue {...props} />;
  if (field.type === 'GIT_REF') return <GitVersionValue {...props} />;
  if (field.type === 'ARTIFACT') return <ArtifactValue {...props} />;
  if (field.type === 'TARGETS') return <TargetsValue {...props} />;
  if (field.type === 'CREDENTIAL') return <CredentialsValue {...props} />;
  if (field.type === 'ENVIRONMENT_SET') return <EnvironmentSetValue {...props} />;
  if (field.type === 'ENVIRONMENT' || field.type === 'SERVICE') {
    const options = (field.type === 'ENVIRONMENT' ? project.environments : project.services).filter(
      ({ id }) => !field.options || field.options.includes(id),
    );
    return (
      <ResourceSelect
        label={field.name}
        options={options}
        value={value}
        change={(id) => change(id && field.type === 'SERVICE' ? { serviceId: id } : id)}
        disabled={disabled}
        required={required}
      />
    );
  }
  if (field.type === 'BOOLEAN' || field.options?.length) {
    const choices = field.options?.length ? field.options : [true, false];
    return (
      <Field label={field.name}>
        <select
          aria-label={field.name}
          disabled={disabled}
          required={required}
          value={value === undefined ? '' : JSON.stringify(value)}
          onChange={(event) =>
            change(choices.find((item) => JSON.stringify(item) === event.target.value))
          }
        >
          <option value="">请选择</option>
          {choices.map((item) => (
            <option value={JSON.stringify(item)} key={JSON.stringify(item)}>
              {typeof item === 'boolean' ? (item ? '是' : '否') : String(item)}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  return (
    <Field label={field.name}>
      <input
        aria-label={field.name}
        type={field.type === 'NUMBER' ? 'number' : 'text'}
        step={field.type === 'NUMBER' ? 'any' : undefined}
        placeholder={field.type === 'PATH' ? '相对工作区路径' : undefined}
        required={required && (field.type !== 'TEXT' || value !== '')}
        disabled={disabled}
        value={typeof value === 'number' ? value : stringValue(value)}
        onChange={(event) =>
          change(
            event.target.value
              ? field.type === 'NUMBER'
                ? Number(event.target.value)
                : event.target.value
              : field.type === 'TEXT'
                ? ''
                : undefined,
          )
        }
      />
      {field.type === 'TEXT' && !disabled && value === undefined && (
        <button type="button" className="button secondary small" onClick={() => change('')}>
          使用空字符串
        </button>
      )}
    </Field>
  );
}

export function GraphFieldEditor({
  type,
  fields,
  catalog,
  project,
  disabled,
  change,
  title,
  scriptPort,
}: {
  type: 'input' | 'output';
  fields: GraphField[];
  catalog?: GraphCatalog;
  project: ProjectDetail;
  disabled?: boolean;
  change: (fields: GraphField[]) => void;
  title?: string;
  scriptPort?: boolean;
}) {
  const [preset, setPreset] = useState('');
  const [portId, setPortId] = useState('');
  const isInput = type === 'input';
  const standards = (isInput ? catalog?.inputPresets : catalog?.outputPresets)?.filter(
    (field) => field.type !== 'ENVIRONMENT',
  );
  const fieldTypes = catalog?.fieldTypes;
  const scriptTypes = isInput
    ? ['TEXT', 'NUMBER', 'BOOLEAN', 'PATH', 'CREDENTIAL']
    : ['TEXT', 'NUMBER', 'BOOLEAN'];
  const validPortId =
    /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(portId) &&
    (!isInput || !/^VEYOPS_/i.test(portId)) &&
    !fields.some(({ id }) => id === portId);
  function add() {
    if (scriptPort && !validPortId) return;
    const standard = standards?.find(({ id }) => id === preset);
    if (!standard && preset !== 'custom') return;
    const id = scriptPort
      ? portId
      : standard && !fields.some((field) => field.id === standard.id)
        ? standard.id
        : graphKey('field');
    change([
      ...fields,
      standard
        ? { ...standard, id }
        : {
            id,
            name: scriptPort ? portId : '自定义' + (isInput ? '输入' : '输出'),
            type: 'TEXT',
            required: false,
          },
    ]);
    setPortId('');
  }
  function patch(id: string, value: Partial<GraphField>) {
    change(fields.map((row) => (row.id === id ? { ...row, ...value } : row)));
  }
  return (
    <section className="graph-fields">
      <h4>{title ?? (isInput ? '运行输入' : '结束输出')}</h4>
      {fields.map((field) => (
        <details className="graph-field-card" data-graph-field={field.id} key={field.id}>
          <summary>
            {field.name}{' '}
            <small>
              {' '}
              · {fieldTypes?.[field.type] ?? field.type}
              {field.multiple ? ' · 多值' : ''}
            </small>
          </summary>
          <div className="graph-fields">
            {scriptPort && <code>{field.id}</code>}
            <Field label="显示名称">
              <input
                disabled={disabled}
                maxLength={100}
                value={field.name}
                onChange={(event) => patch(field.id, { name: event.target.value })}
              />
            </Field>
            <Field label="引用名" hint="留空沿用字段 ID。改名后原有绑定仍有效。">
              <input
                disabled={disabled}
                maxLength={64}
                value={field.referenceName ?? ''}
                onChange={(event) =>
                  patch(field.id, { referenceName: event.target.value || undefined })
                }
              />
            </Field>
            {scriptPort && (
              <Field label={isInput ? '进程变量名' : '结果 JSON 键'} hint="留空沿用字段 ID。">
                <input
                  disabled={disabled}
                  maxLength={64}
                  value={field.exportName ?? ''}
                  onChange={(event) =>
                    patch(field.id, { exportName: event.target.value || undefined })
                  }
                />
              </Field>
            )}
            <Field label="数据类型">
              <select
                disabled={disabled}
                value={field.type}
                onChange={(event) =>
                  patch(field.id, {
                    type: event.target.value as GraphFieldType,
                    defaultValue: undefined,
                    artifactType: undefined,
                    selection: undefined,
                    source: undefined,
                    options: undefined,
                    multiple: undefined,
                  })
                }
              >
                {Object.entries(fieldTypes ?? { [field.type]: field.type })
                  .filter(([id]) => id !== 'ENVIRONMENT' || field.type === 'ENVIRONMENT')
                  .filter(([id]) => !scriptPort || scriptTypes.includes(id))
                  .map(([id, label]) => (
                    <option value={id} key={id}>
                      {label}
                    </option>
                  ))}
              </select>
            </Field>
            <div className="graph-field-pair">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={!!field.required}
                  onChange={(event) => patch(field.id, { required: event.target.checked })}
                />{' '}
                必填
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  disabled={
                    disabled ||
                    field.type === 'ENVIRONMENT_SET' ||
                    (scriptPort && field.type === 'CREDENTIAL')
                  }
                  checked={!!field.multiple}
                  onChange={(event) =>
                    patch(field.id, { multiple: event.target.checked, defaultValue: undefined })
                  }
                />{' '}
                允许多值
              </label>
            </div>
            {['TEXT', 'NUMBER'].includes(field.type) && (
              <Field label="可选值" hint="每行一个，留空不限定。">
                <textarea
                  disabled={disabled}
                  rows={3}
                  key={field.type}
                  defaultValue={field.options?.join('\n') ?? ''}
                  onBlur={(event) => {
                    const entries = event.target.value
                      .split('\n')
                      .map((item) => item.trim())
                      .filter(Boolean);
                    const options = entries.map((item) =>
                      field.type === 'NUMBER' ? Number(item) : item,
                    );
                    if (
                      options.some((item) => typeof item === 'number' && !Number.isFinite(item))
                    ) {
                      event.target.setCustomValidity('数值选项须为有限数字。');
                      event.target.reportValidity();
                      return;
                    }
                    event.target.setCustomValidity('');
                    patch(field.id, {
                      options: options.length ? [...new Set(options)] : undefined,
                    });
                  }}
                />
              </Field>
            )}
            {field.type === 'ARTIFACT' && (
              <Field label="产物类型">
                <select
                  disabled={disabled}
                  value={field.artifactType ?? ''}
                  onChange={(event) =>
                    patch(field.id, {
                      artifactType: (event.target.value || undefined) as
                        GraphArtifactType | undefined,
                    })
                  }
                >
                  <option value="">任意类型</option>
                  {artifactTypes.map(({ value, label }) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {field.type === 'ARTIFACT' && isInput && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={field.selection === 'LATEST_COMPATIBLE'}
                  onChange={(event) =>
                    patch(field.id, {
                      selection: event.target.checked ? 'LATEST_COMPATIBLE' : undefined,
                    })
                  }
                />{' '}
                自动选择最新兼容产物
              </label>
            )}
            {isInput &&
              [
                'TEXT',
                'NUMBER',
                'BOOLEAN',
                'PATH',
                'IMAGE',
                'REPOSITORY',
                'GIT_REF',
                'ENVIRONMENT',
                'ENVIRONMENT_SET',
                'SERVICE',
                'TARGETS',
                'CREDENTIAL',
                'ARTIFACT',
              ].includes(field.type) && (
                <GraphFieldValue
                  project={project}
                  field={{ ...field, name: '默认值', required: false }}
                  value={field.defaultValue}
                  disabled={disabled}
                  change={(defaultValue) => patch(field.id, { defaultValue })}
                />
              )}
            {!disabled && (
              <button
                className="button secondary small"
                type="button"
                onClick={() => change(fields.filter(({ id }) => id !== field.id))}
              >
                <Trash2 size={14} /> 移除此字段
              </button>
            )}
          </div>
        </details>
      ))}
      {!disabled && (
        <div className="graph-field-pair">
          {scriptPort ? (
            <Field label="稳定标识">
              <input
                value={portId}
                maxLength={64}
                placeholder={isInput ? 'PORT' : 'REPORT_CODE'}
                onChange={(event) => {
                  setPortId(event.target.value);
                  setPreset('custom');
                }}
              />
            </Field>
          ) : (
            <select
              aria-label={isInput ? '选择输入字段' : '选择输出字段'}
              value={preset}
              onChange={(event) => setPreset(event.target.value)}
            >
              <option value="">选择字段</option>
              <option value="custom">自定义字段</option>
              {standards?.map(({ id, name }) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <button
            className="button secondary small"
            type="button"
            disabled={scriptPort ? !validPortId : !preset}
            onClick={add}
          >
            <Plus size={14} /> 添加{isInput ? '输入' : '输出'}
          </button>
        </div>
      )}
    </section>
  );
}

export interface BindingChoice {
  label: string;
  binding: GraphBinding;
  referenceName?: string;
  availability?: 'ALWAYS' | 'CONDITIONAL';
  branches?: string[];
}

function bindingKey(binding: GraphBinding): string {
  switch (binding.kind) {
    case 'INPUT':
    case 'CONTEXT':
    case 'NODE_INPUT':
      return JSON.stringify([binding.kind, binding.fieldId]);
    case 'OUTPUT':
      return JSON.stringify([binding.kind, binding.nodeId, binding.fieldId]);
    case 'AS_GIT_REF':
      return JSON.stringify([binding.kind, binding.refKind, bindingKey(binding.source)]);
    default:
      return binding.kind;
  }
}

function choiceLabel(choice: BindingChoice) {
  return [
    choice.label,
    choice.referenceName,
    choice.availability === 'CONDITIONAL'
      ? choice.branches?.length
        ? choice.branches.join('、')
        : '视分支而定'
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

const missingPolicies: Record<GraphMissingPolicy, string> = {
  ERROR: '报错并停止该节点',
  OMIT: '省略该项',
  USE_DEFAULT: '采用字段默认值',
  REPOSITORY_DEFAULT: '采用仓库默认分支',
};

export function GraphBindingField({
  field,
  choices,
  value,
  change,
  project,
  disabled,
  fallback,
  scope,
  environment,
  canRegisterRepository,
  allowRepositoryDefault,
}: {
  field: GraphField;
  choices: BindingChoice[];
  value?: GraphBinding;
  change: (value?: GraphBinding) => void;
  project: ProjectDetail;
  disabled?: boolean;
  fallback?: string;
  scope?: FieldScope;
  environment?: boolean;
  canRegisterRepository?: boolean;
  allowRepositoryDefault?: boolean;
}) {
  const [search, setSearch] = useState('');
  const selected = value ? bindingKey(value) : '';
  const special = ['VALUE', 'FIRST_AVAILABLE', 'ENVIRONMENT_KEY', 'CREDENTIAL'];
  const unavailable =
    selected &&
    !special.includes(selected) &&
    !choices.some(({ binding }) => bindingKey(binding) === selected);
  const query = search.trim().toLocaleLowerCase();
  const visible = choices.filter(
    (choice) =>
      !query ||
      bindingKey(choice.binding) === selected ||
      choiceLabel(choice).toLocaleLowerCase().includes(query),
  );
  const policies: GraphMissingPolicy[] = [
    'ERROR',
    ...(!field.required ? ['OMIT' as const] : []),
    ...(field.defaultValue !== undefined ? ['USE_DEFAULT' as const] : []),
    ...(allowRepositoryDefault ? ['REPOSITORY_DEFAULT' as const] : []),
  ];
  const update = (next?: GraphBinding) =>
    change(next && value?.onMissing ? { ...next, onMissing: value.onMissing } : next);
  return (
    <div className="graph-binding-field" data-graph-field={field.id}>
      {choices.length > 3 && (
        <input
          type="search"
          aria-label={'搜索' + field.name + '的来源'}
          placeholder="按名称或节点、字段 ID 搜索"
          value={search}
          disabled={disabled}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}
      <Field
        label={field.name + (field.required ? '（必需）' : '')}
        hint={unavailable ? '源节点或字段已变化，请重新选择来源。' : fallback}
      >
        <select
          value={selected}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'VALUE') update({ kind: 'VALUE', value: field.defaultValue ?? '' });
            else if (next === 'FIRST_AVAILABLE') update({ kind: 'FIRST_AVAILABLE', sources: [] });
            else if (next === 'ENVIRONMENT_KEY') update({ kind: 'ENVIRONMENT_KEY', key: '' });
            else if (next === 'CREDENTIAL') update({ kind: 'CREDENTIAL', credentialId: '' });
            else update(choices.find(({ binding }) => bindingKey(binding) === next)?.binding);
          }}
        >
          <option value="">{fallback ? '采用默认来源' : '选择数据来源'}</option>
          {unavailable && (
            <option value={selected} disabled>
              原有来源不可用
            </option>
          )}
          {visible.map((choice) => (
            <option key={bindingKey(choice.binding)} value={bindingKey(choice.binding)}>
              {choiceLabel(choice)}
            </option>
          ))}
          {!['SOURCE', 'WORKSPACE', 'REPORT', 'RELEASE', 'VARIABLES'].includes(field.type) && (
            <option value="VALUE">固定值</option>
          )}
          {environment && <option value="ENVIRONMENT_KEY">入口变量集合中的键</option>}
          {environment && <option value="CREDENTIAL">凭据引用</option>}
          {(choices.length > 1 || value?.kind === 'FIRST_AVAILABLE') && (
            <option value="FIRST_AVAILABLE">按分支取第一个可用来源</option>
          )}
        </select>
      </Field>
      {value?.kind === 'VALUE' && (
        <GraphFieldValue
          project={project}
          field={{ ...field, name: '固定值' }}
          value={value.value}
          change={(next) =>
            update(
              next === undefined && field.type === 'GIT_REF'
                ? undefined
                : { kind: 'VALUE', value: next ?? '' },
            )
          }
          disabled={disabled}
          scope={scope}
          canRegisterRepository={canRegisterRepository}
        />
      )}
      {value?.kind === 'ENVIRONMENT_KEY' && (
        <Field label="集合变量键">
          <input
            value={value.key}
            disabled={disabled}
            onChange={(event) => update({ ...value, key: event.target.value })}
          />
        </Field>
      )}
      {value?.kind === 'CREDENTIAL' && (
        <GraphFieldValue
          project={project}
          field={{ ...field, name: '凭据引用', type: 'CREDENTIAL' }}
          value={value.credentialId}
          change={(next) => update({ kind: 'CREDENTIAL', credentialId: stringValue(next) })}
          disabled={disabled}
        />
      )}
      {value?.kind === 'FIRST_AVAILABLE' && (
        <fieldset disabled={disabled}>
          <legend>候选优先顺序</legend>
          <ol className="graph-edge-list">
            {value.sources.map((source, index) => {
              const key = bindingKey(source);
              const choice = choices.find(({ binding }) => bindingKey(binding) === key);
              return (
                <li key={key}>
                  <span>{choice ? choiceLabel(choice) : '来源已失效'}</span>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={index === 0}
                    onClick={() => {
                      const sources = [...value.sources];
                      [sources[index - 1], sources[index]] = [sources[index]!, sources[index - 1]!];
                      update({ ...value, sources });
                    }}
                  >
                    上移
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    onClick={() =>
                      update({ ...value, sources: value.sources.filter((_, i) => i !== index) })
                    }
                  >
                    移除
                  </button>
                </li>
              );
            })}
          </ol>
          <select
            aria-label="添加后备来源"
            value=""
            onChange={(event) => {
              const source = choices.find(
                ({ binding }) => bindingKey(binding) === event.target.value,
              );
              if (source) update({ ...value, sources: [...value.sources, source.binding] });
            }}
          >
            <option value="">添加后备来源</option>
            {visible
              .filter(
                ({ binding }) =>
                  !value.sources.some((source) => bindingKey(source) === bindingKey(binding)),
              )
              .map((choice) => (
                <option key={bindingKey(choice.binding)} value={bindingKey(choice.binding)}>
                  {choiceLabel(choice)}
                </option>
              ))}
          </select>
        </fieldset>
      )}
      {value && (
        <Field label="来源缺失时">
          <select
            disabled={disabled}
            value={value.onMissing ?? ''}
            onChange={(event) =>
              change({
                ...value,
                onMissing: (event.target.value || undefined) as GraphMissingPolicy | undefined,
              })
            }
          >
            <option value="">采用端口默认规则</option>
            {value.onMissing && !policies.includes(value.onMissing) && (
              <option value={value.onMissing} disabled>
                原缺值规则不可用
              </option>
            )}
            {policies.map((policy) => (
              <option key={policy} value={policy}>
                {missingPolicies[policy]}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}
