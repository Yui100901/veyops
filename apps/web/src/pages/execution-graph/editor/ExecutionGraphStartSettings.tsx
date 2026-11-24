import { Plus, Trash2 } from 'lucide-react';
import { Field } from '../../../components';
import type { DeploymentSelection, ProjectDetail } from '../../../models';
import { effectiveNodeType, graphKey, isReleaseNode } from '../execution-graph-definition';
import type {
  GraphBinding,
  GraphEndpoint,
  GraphField,
  GraphNode,
} from '../execution-graph-definition';
import { GraphFieldValue } from './ExecutionGraphFields';
import './execution-graph-start-settings.css';

const standardFields = {
  repository: { id: 'repository', name: '项目仓库', type: 'REPOSITORY', required: true },
  gitVersion: { id: 'gitVersion', name: 'Git 版本', type: 'GIT_REF', required: false },
  buildTargets: {
    id: 'buildTargets',
    name: '构建位置',
    type: 'TARGETS',
    required: false,
    purpose: 'BUILD_TARGETS',
  },
  service: { id: 'service', name: '项目服务', type: 'SERVICE', required: true },
  releaseTargets: {
    id: 'releaseTargets',
    name: '发布服务器和分组',
    type: 'TARGETS',
    required: true,
    purpose: 'RELEASE_TARGETS',
  },
  artifact: { id: 'artifact', name: '已登记产物', type: 'ARTIFACT', required: true },
} as const satisfies Record<string, GraphField>;

function isRepositoryField({ id, type }: GraphField) {
  return type === 'REPOSITORY' && (id === 'repository' || id.startsWith('repository-'));
}

export function isStartBusinessField(field: GraphField) {
  const id = field.id;
  return (
    (Object.hasOwn(standardFields, id) &&
      standardFields[id as keyof typeof standardFields].type === field.type) ||
    isRepositoryField(field) ||
    (id.startsWith('gitVersion-') && field.type === 'GIT_REF') ||
    (id.startsWith('service-') && field.type === 'SERVICE') ||
    (id.startsWith('releaseTargets-') && field.type === 'TARGETS') ||
    field.type === 'ENVIRONMENT_SET'
  );
}

function referenceId(value: unknown) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if ('repositoryId' in value && typeof value.repositoryId === 'string')
      return value.repositoryId;
    if ('serviceId' in value && typeof value.serviceId === 'string') return value.serviceId;
  }
}

function bindingUsesInput(binding: GraphBinding, id: string): boolean {
  if (binding.kind === 'INPUT') return binding.fieldId === id;
  if (binding.kind === 'FIRST_AVAILABLE')
    return binding.sources.some((item) => bindingUsesInput(item, id));
  return binding.kind === 'AS_GIT_REF' && bindingUsesInput(binding.source, id);
}

function endpointUsesInput(endpoint: GraphEndpoint, id: string) {
  return [
    ...Object.values(endpoint.inputBindings ?? {}).flatMap((ports) => Object.values(ports)),
    ...Object.values(endpoint.environmentBindings ?? {}).flatMap((bindings) =>
      Object.values(bindings),
    ),
    ...Object.values(endpoint.outputBindings ?? {}),
  ].some((binding) => bindingUsesInput(binding, id));
}

export function ExecutionGraphStartSettings({
  node,
  flowNodes,
  endpoint,
  project,
  canEdit,
  change,
}: {
  node: GraphNode;
  flowNodes: GraphNode[];
  endpoint?: GraphEndpoint;
  project: ProjectDetail;
  canEdit: boolean;
  change: (fields: GraphField[], endpoint?: GraphEndpoint) => void;
}) {
  const fields = node.inputs ?? [];
  const current = (key: keyof typeof standardFields): GraphField => {
    const preset = standardFields[key];
    const existing = fields.find(({ id, type }) => id === preset.id && type === preset.type);
    return existing ? { ...preset, ...existing } : preset;
  };
  const checkoutNodes = flowNodes.filter((step) => effectiveNodeType(step) === 'CHECKOUT');
  const releaseNodes = flowNodes.filter(isReleaseNode);
  const release = releaseNodes[0];
  const needsLocation = flowNodes.some((step) =>
    ['BUILD', 'SHELL', 'CHECK'].includes(effectiveNodeType(step)),
  );
  const hasBuild = flowNodes.some((step) => effectiveNodeType(step) === 'BUILD');
  const primarySource = current('repository');
  const primaryVersion = current('gitVersion');
  const buildTargets = current('buildTargets');
  const primaryService = current('service');
  const primaryRelease = current('releaseTargets');
  const typedArtifact = current('artifact');
  const fixedArtifact =
    !typedArtifact.selection &&
    (typedArtifact.runtimeOverride === false || typedArtifact.defaultValue !== undefined);
  const namedSources = fields.filter(
    (field) => isRepositoryField(field) && field.id !== primarySource.id,
  );
  const namedReleases = fields.filter(
    ({ id, type }) => id.startsWith('service-') && type === 'SERVICE',
  );
  const targetBinding = release ? endpoint?.inputBindings?.[release.id]?.targets : undefined;
  const commonTargetBinding =
    targetBinding?.kind === 'INPUT' && targetBinding.fieldId === 'buildTargets';
  const targetSelection = buildTargets.defaultValue as DeploymentSelection | undefined;
  const singleHost = targetSelection?.serverIds?.length === 1 && !targetSelection.groupIds?.length;
  const artifactBinding = release ? endpoint?.inputBindings?.[release.id]?.artifact : undefined;
  const externalArtifact =
    fields.some(({ id }) => id === 'artifact') ||
    (Boolean(release) &&
      !hasBuild &&
      (!artifactBinding ||
        (artifactBinding.kind === 'INPUT' && artifactBinding.fieldId === 'artifact')));

  function replace(field: GraphField, patch: Partial<GraphField>) {
    const next = { ...field, ...patch };
    const nextEndpoint =
      field.id === 'service' && endpoint && releaseNodes.length === 1
        ? {
            ...endpoint,
            serviceId: next.runtimeOverride === false ? referenceId(next.defaultValue) : undefined,
          }
        : undefined;
    change(
      fields.some(({ id }) => id === field.id)
        ? fields.map((item) => (item.id === field.id ? next : item))
        : [...fields, next],
      nextEndpoint,
    );
  }

  function setDefault(field: GraphField, value: unknown) {
    replace(field, {
      defaultValue: value,
      runtimeOverride: field.runtimeOverride ?? value === undefined,
    });
  }

  function setSharedTarget(share: boolean) {
    if (!endpoint || !release) return;
    const inputBindings = {
      ...endpoint.inputBindings,
      [release.id]: {
        ...endpoint.inputBindings?.[release.id],
        targets: { kind: 'INPUT' as const, fieldId: share ? 'buildTargets' : 'releaseTargets' },
      },
    };
    const next = { ...endpoint, inputBindings };
    const inputs = fields.filter(
      ({ id }) => !share || id !== 'releaseTargets' || endpointUsesInput(next, id),
    );
    if (!share && !inputs.some(({ id }) => id === 'releaseTargets'))
      inputs.push(standardFields.releaseTargets);
    change(inputs, next);
  }

  function addNamed(kind: 'source' | 'release') {
    const key = graphKey('resource');
    if (kind === 'source') {
      change([
        ...fields,
        {
          ...standardFields.repository,
          id: 'repository-' + key,
          name: '源码 ' + (namedSources.length + 2),
        },
        { ...standardFields.gitVersion, id: 'gitVersion-' + key },
      ]);
    } else {
      change([
        ...fields,
        {
          ...standardFields.service,
          id: 'service-' + key,
          name: '发布 ' + (namedReleases.length + 2),
        },
        { ...standardFields.releaseTargets, id: 'releaseTargets-' + key },
      ]);
    }
  }

  function removeNamed(primary: GraphField, secondary: GraphField) {
    change(fields.filter(({ id }) => id !== primary.id && id !== secondary.id));
  }

  function runtimeToggle(field: GraphField) {
    return (
      <label className="checkbox-row">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={field.runtimeOverride !== false}
          onChange={(event) => replace(field, { runtimeOverride: event.target.checked })}
        />
        允许运行时修改{field.name}
      </label>
    );
  }

  function input(field: GraphField, repositoryId?: string) {
    return (
      <div className="graph-start-resource" data-graph-node-field={field.id}>
        <GraphFieldValue
          project={project}
          field={field}
          value={field.defaultValue}
          scope={{ repositoryId }}
          disabled={!canEdit}
          change={(value) => setDefault(field, value)}
        />
        {runtimeToggle(field)}
      </div>
    );
  }

  function source(repository: GraphField, version: GraphField, named = false) {
    const reference = referenceId(repository.defaultValue);
    const registered = project.repositories.find(
      ({ id, cloneUrl }) => id === reference || cloneUrl === reference,
    );
    const currentBranch = registered?.defaultBranch;
    return (
      <section
        className="graph-start-resource-group"
        aria-label={repository.name}
        key={repository.id}
      >
        {named && (
          <Field label="源码名称">
            <input
              maxLength={100}
              readOnly={!canEdit}
              value={repository.name}
              onChange={(event) => replace(repository, { name: event.target.value })}
            />
          </Field>
        )}
        {input(repository)}
        {input(version, registered?.id)}
        <p className="field-note">
          {currentBranch ? '仓库默认分支 · ' + currentBranch : '留空使用仓库默认分支。'}
        </p>
        {canEdit && named && (
          <div>
            <button
              className="button secondary small"
              type="button"
              onClick={() => removeNamed(repository, version)}
            >
              <Trash2 size={14} /> 移除 {repository.name}
            </button>
          </div>
        )}
      </section>
    );
  }

  function releaseSettings(service: GraphField, targets: GraphField, named = false) {
    return (
      <section className="graph-start-resource-group" aria-label={service.name} key={service.id}>
        {named && (
          <Field label="发布组合名称">
            <input
              maxLength={100}
              readOnly={!canEdit}
              value={service.name}
              onChange={(event) => replace(service, { name: event.target.value })}
            />
          </Field>
        )}
        {input(service)}
        {!named && releaseNodes.length === 1 && hasBuild && endpoint && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              disabled={!canEdit || (!singleHost && !commonTargetBinding)}
              checked={commonTargetBinding}
              onChange={(event) => setSharedTarget(event.target.checked)}
            />
            构建与发布同一台服务器
          </label>
        )}
        {!named && commonTargetBinding ? (
          <p className="field-note">发布使用开始节点的构建位置。</p>
        ) : (
          input(targets)
        )}
        {canEdit && named && (
          <div>
            <button
              className="button secondary small"
              type="button"
              onClick={() => removeNamed(service, targets)}
            >
              <Trash2 size={14} /> 移除 {service.name}
            </button>
          </div>
        )}
      </section>
    );
  }

  const showsSource = Boolean(
    checkoutNodes.length || namedSources.length || primarySource.defaultValue,
  );
  const showsBuild = needsLocation || buildTargets.defaultValue !== undefined;
  if (!showsSource && !showsBuild && !releaseNodes.length && !externalArtifact) return null;
  return (
    <section className="graph-properties graph-start-setup" aria-label="任务默认配置">
      <h4>任务默认配置</h4>
      {showsSource && (
        <>
          {source(primarySource, primaryVersion)}
          {namedSources.map((repository) => {
            const id = repository.id.replace(/^repository-/, 'gitVersion-');
            return source(
              repository,
              fields.find((field) => field.id === id) ?? { ...standardFields.gitVersion, id },
              true,
            );
          })}
          {canEdit && (checkoutNodes.length > 1 || namedSources.length > 0) && (
            <div>
              <button
                className="button secondary small"
                type="button"
                onClick={() => addNamed('source')}
              >
                <Plus size={14} /> 添加具名源码
              </button>
            </div>
          )}
        </>
      )}
      {showsBuild && (
        <div className="graph-start-resource-group">
          {input({ ...buildTargets, purpose: 'BUILD_TARGETS' })}
          <p className="field-note">留空采用平台配置的执行位置。</p>
        </div>
      )}
      {hasBuild && !releaseNodes.length && (
        <div className="graph-start-resource-group">
          {input({ ...primaryService, name: '关联服务（可选）', required: false })}
        </div>
      )}
      {releaseNodes.length > 0 && (
        <>
          {releaseSettings(primaryService, primaryRelease)}
          {namedReleases.map((service) => {
            const id = service.id.replace(/^service-/, 'releaseTargets-');
            return releaseSettings(
              service,
              fields.find((field) => field.id === id) ?? { ...standardFields.releaseTargets, id },
              true,
            );
          })}
          {canEdit && (releaseNodes.length > 1 || namedReleases.length > 0) && (
            <div>
              <button
                className="button secondary small"
                type="button"
                onClick={() => addNamed('release')}
              >
                <Plus size={14} /> 添加发布组合
              </button>
            </div>
          )}
        </>
      )}
      {externalArtifact && (
        <div className="graph-start-resource-group">
          <Field label="外部产物来源">
            <select
              disabled={!canEdit}
              value={
                typedArtifact.selection
                  ? 'latest'
                  : fixedArtifact
                    ? 'fixed'
                    : 'provided'
              }
              onChange={(event) => {
                const value = event.target.value;
                replace(typedArtifact, {
                  runtimeOverride: value === 'provided',
                  selection: value === 'latest' ? 'LATEST_COMPATIBLE' : undefined,
                  defaultValue: value === 'fixed' ? typedArtifact.defaultValue : undefined,
                });
              }}
            >
              <option value="provided">手动选择或由上游触发提供</option>
              <option value="fixed">固定已登记产物</option>
              <option value="latest">最新兼容产物</option>
            </select>
          </Field>
          {fixedArtifact && (
            <div className="graph-start-resource" data-graph-node-field="artifact">
              <GraphFieldValue
                project={project}
                field={typedArtifact}
                value={typedArtifact.defaultValue}
                scope={{
                  serviceId: referenceId(primaryService.defaultValue),
                  targets: commonTargetBinding
                    ? targetSelection
                    : (primaryRelease.defaultValue as DeploymentSelection | undefined),
                }}
                disabled={!canEdit}
                change={(value) => setDefault(typedArtifact, value)}
              />
              {typedArtifact.defaultValue !== undefined && runtimeToggle(typedArtifact)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
