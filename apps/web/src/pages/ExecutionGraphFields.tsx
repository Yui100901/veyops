import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type { Credential, DeploymentSelection, ProjectDetail, Repository } from '../models';
import { DeploymentSelectionPicker, useDeploymentInventory } from './DeploymentSelection';
import type { Artifact } from './Delivery';
import { isDeployableArtifact } from './Delivery';
import { useRepositoryBranches } from './RepositoryBranches';
import { graphKey } from './execution-graph-definition';
import type {
  GraphArtifactType,
  GraphBinding,
  GraphCatalog,
  GraphField,
  GraphFieldType,
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
  return typeof value === 'object' && value && 'id' in value
    ? stringValue(value.id)
    : stringValue(value);
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
      <Field label={kind === 'BRANCH' ? '分支名称' : kind === 'TAG' ? '标签名称' : '完整提交 SHA'}>
        <input
          required={checkRequired && field.required}
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
  if (scope?.environmentId) query.set('environmentId', scope.environmentId);
  const versions = useResource<Artifact[]>('/artifacts?' + query);
  const inventory = useDeploymentInventory();
  const servers = new Set([
    ...(scope?.targets?.serverIds ?? []),
    ...(inventory.groups.data ?? [])
      .filter(({ id }) => scope?.targets?.groupIds?.includes(id))
      .flatMap(({ serverIds }) => serverIds),
  ]);
  const selected = new Set(
    (Array.isArray(value) ? value : [value]).map(referenceId).filter(Boolean),
  );
  const rows = (versions.data ?? [])
    .filter((artifact) => {
      const expected = field.artifactType;
      const actual = artifact.kind ?? artifact.artifactType;
      return (
        isDeployableArtifact(artifact) &&
        (!expected || expected === actual) &&
        (!servers.size || !artifact.serverId || servers.has(artifact.serverId))
      );
    })
    .map((artifact) => ({
      id: artifact.id,
      name: [
        artifact.name ?? (artifact.artifactType === 'DOCKER_IMAGE' ? 'Docker 镜像' : '文件产物'),
        artifact.sourceCommit?.slice(0, 12),
        artifact.graphRunId?.slice(0, 8),
        formatTime(artifact.createdAt),
        inventory.servers.data?.find(({ id }) => id === artifact.serverId)?.name,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
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
            disabled={disabled || versions.loading}
            required={checkRequired && field.required && !latest}
            value={[...selected]}
            onChange={(event) => {
              const choices = Array.from(event.target.selectedOptions, ({ value }) => value);
              change(choices.length ? choices : undefined);
            }}
          >
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
          value={value}
          change={change}
          disabled={disabled || versions.loading}
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
  if (field.type === 'ENVIRONMENT' || field.type === 'SERVICE') {
    const options = field.type === 'ENVIRONMENT' ? project.environments : project.services;
    return (
      <ResourceSelect
        label={field.name}
        options={options}
        value={value}
        change={change}
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
        required={required}
        disabled={disabled}
        value={typeof value === 'number' ? value : stringValue(value)}
        onChange={(event) =>
          change(
            event.target.value
              ? field.type === 'NUMBER'
                ? Number(event.target.value)
                : event.target.value
              : undefined,
          )
        }
      />
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
  const standards = isInput ? catalog?.inputPresets : catalog?.outputPresets;
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
        <details className="graph-field-card" key={field.id}>
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
                  disabled={disabled || (scriptPort && field.type === 'CREDENTIAL')}
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
}

export function GraphBindingField({
  field,
  choices,
  value,
  change,
  project,
  disabled,
  fallback,
}: {
  field: GraphField;
  choices: BindingChoice[];
  value?: GraphBinding;
  change: (value?: GraphBinding) => void;
  project: ProjectDetail;
  disabled?: boolean;
  fallback?: string;
}) {
  const serialized =
    value && value.kind !== 'VALUE' && value.kind !== 'FIRST_AVAILABLE'
      ? JSON.stringify(value)
      : '';
  const selected =
    value?.kind === 'VALUE' || value?.kind === 'FIRST_AVAILABLE' ? value.kind : serialized;
  const unavailable =
    serialized && !choices.some(({ binding }) => JSON.stringify(binding) === serialized);
  return (
    <div className="graph-binding-field" data-graph-field={field.id}>
      <Field
        label={field.name + (field.required ? '（必需）' : '')}
        hint={unavailable ? '源节点或字段已变化，请重新选择来源。' : fallback}
      >
        <select
          value={selected}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            if (next === 'VALUE') change({ kind: 'VALUE', value: '' });
            else if (next === 'FIRST_AVAILABLE') change({ kind: 'FIRST_AVAILABLE', sources: [] });
            else change(choices.find(({ binding }) => JSON.stringify(binding) === next)?.binding);
          }}
        >
          <option value="">{fallback ? '采用默认来源' : '选择数据来源'}</option>
          {unavailable && (
            <option value={serialized} disabled>
              原有来源不可用
            </option>
          )}
          {choices.map(({ binding, label }) => (
            <option key={JSON.stringify(binding)} value={JSON.stringify(binding)}>
              {label}
            </option>
          ))}
          {!['SOURCE', 'WORKSPACE', 'REPORT', 'RELEASE', 'VARIABLES'].includes(field.type) && (
            <option value="VALUE">固定值</option>
          )}
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
          change={(next) => change({ kind: 'VALUE', value: next ?? '' })}
          disabled={disabled}
        />
      )}
      {value?.kind === 'FIRST_AVAILABLE' && (
        <fieldset disabled={disabled}>
          <legend>按出现顺序查找</legend>
          {choices.map(({ binding, label }) => {
            const key = JSON.stringify(binding);
            const checked = value.sources.some((source) => JSON.stringify(source) === key);
            return (
              <label key={key} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    change({
                      kind: 'FIRST_AVAILABLE',
                      sources: event.target.checked
                        ? [...value.sources, binding]
                        : value.sources.filter((source) => JSON.stringify(source) !== key),
                    })
                  }
                />{' '}
                {label}
              </label>
            );
          })}
        </fieldset>
      )}
    </div>
  );
}
