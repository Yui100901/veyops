import { useContext, useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { formatTime, useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type {
  Credential,
  DeploymentSelection,
  ProjectDetail,
  Repository,
  Service,
} from '../models';
import { DeploymentSelectionPicker, useDeploymentInventory } from './DeploymentSelection';
import {
  artifactInstanceId,
  artifactKindLabel,
  artifactLogicalId,
  isDeployableArtifact,
  type Artifact,
  type ArtifactRef,
} from './Delivery';
import { BranchSyncControls, useRepositoryBranches } from './RepositoryBranches';
import { GraphResourceDialog } from './GraphResourceDialog';
import { GraphResourceContext } from './graph-resource-context';
import { graphPresetTypePatch, matchingGraphPreset, presetReference } from './graph-field-presets';
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
  deliveryMethod?: 'FILE' | 'COMPOSE';
};

interface ValueProps {
  project: ProjectDetail;
  field: GraphField;
  value: unknown;
  change: (value: unknown) => void;
  disabled?: boolean;
  scope?: FieldScope;
  canManageProjectResources?: boolean;
  checkRequired?: boolean;
  repositoryAddress?: boolean;
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

function ProjectResourceValue({
  project,
  field,
  value,
  change,
  disabled,
  canManageProjectResources,
  checkRequired,
  repositoryAddress,
}: ValueProps) {
  const context = useContext(GraphResourceContext);
  const [open, setOpen] = useState(false);
  const [addedRepository, setAddedRepository] = useState<Repository>();
  const [addedService, setAddedService] = useState<Service>();
  const repositories =
    addedRepository && !project.repositories.some(({ id }) => id === addedRepository.id)
      ? [...project.repositories, addedRepository]
      : project.repositories;
  const services =
    addedService && !project.services.some(({ id }) => id === addedService.id)
      ? [...project.services, addedService]
      : project.services;
  const repository = field.type === 'REPOSITORY';
  const options = (repository ? repositories : services).filter(
    ({ id }) => !field.options || field.options.includes(id),
  );
  const selected = referenceId(value);
  const addressKey = (url: string) =>
    url
      .trim()
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
  const matchingAddresses = repository
    ? repositories.filter(({ cloneUrl }) => addressKey(cloneUrl) === addressKey(selected))
    : [];
  const byAddress = matchingAddresses.length === 1 ? matchingAddresses[0] : undefined;
  const canCreate =
    canManageProjectResources &&
    context &&
    !disabled &&
    context.role !== 'VIEWER' &&
    !project.archived &&
    !field.options?.length;

  function setRepository(item: Repository) {
    change(repositoryAddress ? item.cloneUrl : item.id);
  }

  return (
    <>
      <ResourceSelect
        label={field.name}
        options={options}
        value={byAddress ? byAddress.id : selected}
        change={(id) => {
          if (repository) {
            const item = repositories.find((repo) => repo.id === id);
            if (item) setRepository(item);
            else change(undefined);
          } else change(id ? { serviceId: id } : undefined);
        }}
        disabled={disabled}
        required={checkRequired && field.required}
        empty={repository ? '选择项目仓库' : '选择项目服务'}
      />
      {canCreate && (
        <button
          type="button"
          className="button secondary small graph-resource-add"
          onClick={() => setOpen(true)}
        >
          <Plus size={14} aria-hidden="true" /> {repository ? '添加项目仓库' : '添加项目服务'}
        </button>
      )}
      {canCreate &&
        open &&
        (repository ? (
          <GraphResourceDialog
            kind="repository"
            project={project}
            role={context.role}
            onClose={() => setOpen(false)}
            onSaved={(item) => {
              setAddedRepository(item);
              setRepository(item);
              setOpen(false);
              void context.reload();
            }}
          />
        ) : (
          <GraphResourceDialog
            kind="service"
            project={project}
            role={context.role}
            onClose={() => setOpen(false)}
            onSaved={(item) => {
              setAddedService(item);
              change({ serviceId: item.id });
              setOpen(false);
              void context.reload();
            }}
          />
        ))}
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
  const repositoryPath = scope?.repositoryId
    ? '/projects/' + project.id + '/repositories/' + scope.repositoryId
    : null;
  const branches = useRepositoryBranches(kind === 'BRANCH' ? repositoryPath : null);
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
      {repositoryPath && kind === 'BRANCH' && !disabled && (
        <BranchSyncControls branches={branches} />
      )}
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
  const requestedKind =
    field.artifactType ?? (scope?.deliveryMethod === 'COMPOSE' ? 'DOCKER_IMAGE' : undefined);
  if (requestedKind) query.set('kind', requestedKind);
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
  const isRegistry = (artifact: Artifact) =>
    artifact.physical?.location === 'REGISTRY' || artifact.storageType === 'REGISTRY_IMAGE';
  const targetOf = (artifact: Artifact) =>
    isRegistry(artifact) ? undefined : (artifact.serverId ?? artifact.physical?.serverId);
  for (const artifact of versions.data ?? []) {
    const server = targetOf(artifact);
    const kind = artifact.kind ?? artifact.artifactType;
    if (
      !isDeployableArtifact(artifact) ||
      (requestedKind && requestedKind !== kind) ||
      (field.acceptedArtifactTypes && !field.acceptedArtifactTypes.some((type) => type === kind)) ||
      (scope?.deliveryMethod === 'FILE' && kind === 'DOCKER_IMAGE') ||
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
        targetOf(instance) || !servers.size || instance.downloadAvailable || isRegistry(instance),
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
        const location = isRegistry(instance)
          ? '镜像仓库'
          : server
            ? (serverNames.get(server) ?? server)
            : '管理端';
        selectable.set(artifactId + ':' + instanceId, {
          name: title + ' · ' + location,
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
  if (field.type === 'REPOSITORY' || field.type === 'SERVICE')
    return <ProjectResourceValue {...props} />;
  if (field.type === 'GIT_REF') return <GitVersionValue {...props} />;
  if (field.type === 'ARTIFACT') return <ArtifactValue {...props} />;
  if (field.type === 'TARGETS') return <TargetsValue {...props} />;
  if (field.type === 'CREDENTIAL') return <CredentialsValue {...props} />;
  if (field.type === 'ENVIRONMENT_SET') return <EnvironmentSetValue {...props} />;
  if (field.type === 'ENVIRONMENT') {
    const options = project.environments.filter(
      ({ id }) => !field.options || field.options.includes(id),
    );
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
  if (field.type === 'BOOLEAN' || field.type === 'GIT_FETCH_MODE' || field.options?.length) {
    const choices =
      field.type === 'GIT_FETCH_MODE' ? ['LATEST', 'FULL'] : (field.options ?? [true, false]);
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
              {field.type === 'GIT_FETCH_MODE'
                ? item === 'FULL'
                  ? '拉取完整历史'
                  : '只拉取选定提交（浅拉取）'
                : typeof item === 'boolean'
                  ? item
                    ? '是'
                    : '否'
                  : String(item)}
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
}: {
  type: 'input' | 'output';
  fields: GraphField[];
  catalog?: GraphCatalog;
  project: ProjectDetail;
  disabled?: boolean;
  change: (fields: GraphField[]) => void;
  title?: string;
}) {
  const [preset, setPreset] = useState('');
  const isInput = type === 'input';
  const standards = isInput ? catalog?.inputPresets : catalog?.outputPresets;
  const fieldTypes = catalog?.fieldTypes;
  const editorFields = fields.map((field) => ({
    ...field,
    ...graphPresetTypePatch(field, matchingGraphPreset(field.referenceName, catalog, isInput)),
  }));
  function add() {
    const standard = standards?.find(({ id }) => id === preset);
    if (!standard && preset !== 'custom') return;
    const id =
      standard && !fields.some((field) => field.id === standard.id)
        ? standard.id
        : graphKey('field');
    const base = standard ? presetReference(standard) : isInput ? 'INPUT' : 'OUTPUT';
    let referenceName = base;
    for (
      let i = 2;
      fields.some((field) => (field.referenceName ?? field.id) === referenceName);
      i++
    )
      referenceName = base + '_' + i;
    change([
      ...fields,
      {
        ...(standard ?? {
          name: '自定义' + (isInput ? '输入' : '输出'),
          type: 'TEXT' as const,
          required: true,
        }),
        id,
        referenceName,
      },
    ]);
    setPreset('');
  }
  function patch(id: string, value: Partial<GraphField>) {
    change(
      fields.map((row) => {
        if (row.id !== id) return row;
        const reference = Object.hasOwn(value, 'referenceName')
          ? value.referenceName
          : row.referenceName;
        const standard = matchingGraphPreset(reference, catalog, isInput);
        return { ...row, ...graphPresetTypePatch(row, standard), ...value };
      }),
    );
  }
  return (
    <section className="graph-fields">
      <h4>{title ?? (isInput ? '运行输入' : '结束输出')}</h4>
      {editorFields.map((field) => (
        <details className="graph-field-card" data-graph-field={field.id} key={field.id}>
          <summary>
            {field.name}{' '}
            <small>
              {' '}
              · {fieldTypes?.[field.type] ?? field.type}
              {field.required === false ? ' · 选填' : ' · 必填'}
              {field.multiple ? ' · 多值' : ' · 单值'}
              {field.source === 'CURRENT_RUN' && ' · 本次运行产出'}
            </small>
          </summary>
          <div className="graph-fields">
            <Field label="显示名称">
              <input
                disabled={disabled}
                maxLength={100}
                value={field.name}
                onChange={(event) => patch(field.id, { name: event.target.value })}
              />
            </Field>
            <Field label="引用名称" hint="建议使用大写英文与下划线。改名后原有绑定仍有效。">
              <input
                disabled={disabled}
                maxLength={64}
                value={field.referenceName ?? ''}
                onChange={(event) =>
                  patch(field.id, { referenceName: event.target.value || undefined })
                }
              />
            </Field>
            <Field label="数据类型">
              <select
                disabled={
                  disabled || Boolean(matchingGraphPreset(field.referenceName, catalog, isInput))
                }
                value={field.type}
                onChange={(event) =>
                  patch(field.id, {
                    type: event.target.value as GraphFieldType,
                    required: true,
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
                  .filter(([id]) => isInput || id !== 'CREDENTIAL')
                  .map(([id, label]) => (
                    <option value={id} key={id}>
                      {label}
                    </option>
                  ))}
              </select>
            </Field>
            {!!field.options?.length && (
              <p className="field-note">可用值 {field.options.length} 项</p>
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
                  onChange={(event) => {
                    const selection = event.target.checked ? 'LATEST_COMPATIBLE' : undefined;
                    patch(field.id, { selection, ...(selection && { defaultValue: undefined }) });
                  }}
                />{' '}
                自动选择最新兼容产物
              </label>
            )}
            {isInput &&
              !field.selection &&
              [
                'TEXT',
                'NUMBER',
                'BOOLEAN',
                'PATH',
                'IMAGE',
                'REPOSITORY',
                'GIT_REF',
                'GIT_FETCH_MODE',
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
                  canManageProjectResources={!disabled}
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
          <Field label={isInput ? '添加输入' : '添加输出'}>
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
          </Field>
          <button className="button secondary small" type="button" disabled={!preset} onClick={add}>
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
  typeLabel?: string;
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
    case 'PROJECT_VALUE':
      return JSON.stringify([binding.kind, binding.projection, bindingKey(binding.source)]);
    default:
      return binding.kind;
  }
}

function choiceLabel(choice: BindingChoice) {
  return [
    choice.label,
    choice.referenceName,
    choice.typeLabel,
    choice.availability === 'CONDITIONAL'
      ? choice.branches?.length
        ? choice.branches.join('、')
        : '视分支而定'
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function hasMissingGraphBindingSource(
  value: GraphBinding,
  choices: BindingChoice[],
  directSource = false,
): boolean {
  if (value.kind === 'FIRST_AVAILABLE' && !directSource)
    return (
      !value.sources.length ||
      value.sources.some((source) => hasMissingGraphBindingSource(source, choices))
    );
  if (!directSource && ['VALUE', 'ENVIRONMENT_KEY', 'CREDENTIAL'].includes(value.kind))
    return false;
  return !choices.some(({ binding }) => bindingKey(binding) === bindingKey(value));
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
  canManageProjectResources,
  allowRepositoryDefault,
  directSource,
  nodeDefaults,
  referenceLookup,
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
  canManageProjectResources?: boolean;
  allowRepositoryDefault?: boolean;
  directSource?: boolean;
  nodeDefaults?: boolean;
  referenceLookup?: boolean;
}) {
  const [search, setSearch] = useState('');
  const selected = value ? bindingKey(value) : '';
  const special = ['VALUE', 'FIRST_AVAILABLE', 'ENVIRONMENT_KEY', 'CREDENTIAL'];
  const missingSource = value && hasMissingGraphBindingSource(value, choices, directSource);
  const unavailable = missingSource && (directSource || !special.includes(selected));
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
  const incompatibleMissing = directSource && value?.onMissing && value.onMissing !== 'ERROR';
  const update = (next?: GraphBinding) =>
    change(
      next && value?.onMissing && !directSource ? { ...next, onMissing: value.onMissing } : next,
    );
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
        hint={missingSource ? '源节点或字段已变化，请重新选择来源。' : fallback}
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
          <option value="">
            {referenceLookup
              ? '同名上游，缺值时用默认值'
              : nodeDefaults
                ? '当前执行流不覆盖'
                : fallback
                  ? '采用默认来源'
                  : '选择数据来源'}
          </option>
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
          {(value?.kind === 'VALUE' || acceptsFixedGraphValue(field)) && (
            <option value="VALUE">当前执行流固定值</option>
          )}
          {environment && <option value="ENVIRONMENT_KEY">入口变量集合中的键</option>}
          {environment && <option value="CREDENTIAL">凭据引用</option>}
          {!directSource && (choices.length > 1 || value?.kind === 'FIRST_AVAILABLE') && (
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
              next === undefined &&
                [
                  'REPOSITORY',
                  'SERVICE',
                  'ENVIRONMENT',
                  'ENVIRONMENT_SET',
                  'TARGETS',
                  'ARTIFACT',
                  'CREDENTIAL',
                  'GIT_REF',
                  'GIT_FETCH_MODE',
                ].includes(field.type)
                ? undefined
                : { kind: 'VALUE', value: next ?? '' },
            )
          }
          disabled={disabled}
          scope={scope}
          canManageProjectResources={canManageProjectResources}
          repositoryAddress={referenceLookup}
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
      {!directSource && value?.kind === 'FIRST_AVAILABLE' && (
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
      {value && (!directSource || incompatibleMissing) && (
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

export function acceptsFixedGraphValue(field: GraphField) {
  return (
    field.source !== 'CURRENT_RUN' &&
    !['SOURCE', 'WORKSPACE', 'REPORT', 'RELEASE', 'REVIEW', 'VARIABLES'].includes(field.type)
  );
}
