import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Field } from '../../../components';
import type { DeploymentSelection, ProjectDetail } from '../../../models';
import { effectiveNodeType, graphKey, isReleaseNode } from '../execution-graph-definition';
import type {
  GraphBinding,
  GraphEndpoint,
  GraphField,
  GraphNode,
  GraphStartGroup,
} from '../execution-graph-definition';
import { GraphFieldValue } from './ExecutionGraphFields';
import {
  getGraphStartGroups,
  graphResourceId,
  graphStartGroupFields,
  selectedGraphStartGroup,
  type GraphStartGroupKind,
} from './graph-start-groups';
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

function bindingUsesInput(binding: GraphBinding, id: string): boolean {
  if (binding.kind === 'INPUT') return binding.fieldId === id;
  if (binding.kind === 'FIRST_AVAILABLE')
    return binding.sources.some((item) => bindingUsesInput(item, id));
  return binding.kind === 'AS_GIT_REF' && bindingUsesInput(binding.source, id);
}

export function ExecutionGraphStartSettings({
  node,
  flowNodes,
  endpoint,
  project,
  canEdit,
  change,
  selectStep,
}: {
  node: GraphNode;
  flowNodes: GraphNode[];
  endpoint?: GraphEndpoint;
  project: ProjectDetail;
  canEdit: boolean;
  change: (
    fields: GraphField[],
    endpoint?: GraphEndpoint,
    patch?: Pick<GraphNode, 'sameHostRelease'>,
  ) => void;
  selectStep?: (nodeId: string) => void;
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
  const buildTargets = current('buildTargets');
  const primaryService = current('service');
  const primaryRelease = current('releaseTargets');
  const typedArtifact = current('artifact');
  const fixedArtifact =
    !typedArtifact.selection &&
    (typedArtifact.runtimeOverride === false || typedArtifact.defaultValue !== undefined);
  const sources = groups('source', current('repository'), current('gitVersion'));
  const releases = groups('release', primaryService, primaryRelease);
  const usesLegacySharedTarget = releaseNodes.some(({ id }) => {
    const binding = endpoint?.inputBindings?.[id]?.targets;
    return binding?.kind === 'INPUT' && binding.fieldId === 'buildTargets';
  });
  const commonTargetBinding =
    releases.length === 1 && (node.sameHostRelease || usesLegacySharedTarget);
  const targetSelection = buildTargets.defaultValue as DeploymentSelection | undefined;
  const singleHost = targetSelection?.serverIds?.length === 1 && !targetSelection.groupIds?.length;
  const artifactBinding = release ? endpoint?.inputBindings?.[release.id]?.artifact : undefined;
  const externalArtifact =
    fields.some(({ id }) => id === 'artifact') ||
    (Boolean(release) &&
      !hasBuild &&
      (!artifactBinding ||
        (artifactBinding.kind === 'INPUT' && artifactBinding.fieldId === 'artifact')));

  function groups(kind: GraphStartGroupKind, primary: GraphField, companion: GraphField) {
    const found = getGraphStartGroups(node, kind);
    return found.length ? found : [{ id: primary.id, label: primary.name, primary, companion }];
  }

  function replace(field: GraphField, patch: Partial<GraphField>, pair?: GraphField) {
    const next = {
      ...field,
      name: fields.find(({ id }) => id === field.id)?.name ?? field.name,
      ...patch,
    };
    const nextEndpoint =
      field.type === 'SERVICE' && endpoint?.serviceId
        ? { ...endpoint, serviceId: undefined }
        : undefined;
    const nextFields = fields.some(({ id }) => id === field.id)
      ? fields.map((item) => (item.id === field.id ? next : item))
      : [...fields, next];
    if (pair && !nextFields.some(({ id }) => id === pair.id)) nextFields.push(pair);
    change(nextFields, nextEndpoint);
  }

  function setDefault(field: GraphField, value: unknown, pair?: GraphField) {
    replace(
      field,
      {
        defaultValue: value,
        runtimeOverride: field.runtimeOverride ?? value === undefined,
      },
      pair,
    );
  }

  function sharedTargetTransition(share: boolean) {
    if (!endpoint) return { inputs: fields, endpoint };
    const inputBindings = { ...endpoint.inputBindings };
    for (const { id } of releaseNodes) {
      const bindings = inputBindings[id];
      if (!bindings?.targets) continue;
      const { targets } = bindings;
      if (share || (targets.kind === 'INPUT' && targets.fieldId === 'buildTargets')) {
        inputBindings[id] = { ...bindings };
        delete inputBindings[id].targets;
      }
    }
    const group = releases[0];
    const targets = group.companion ?? groupCompanion(group, 'release');
    const usedElsewhere = [
      ...Object.values(inputBindings).flatMap(Object.values),
      ...Object.values(endpoint.environmentBindings ?? {}).flatMap(Object.values),
      ...Object.values(endpoint.outputBindings ?? {}),
    ].some((binding) => bindingUsesInput(binding, targets.id));
    const inputs =
      share && !usedElsewhere ? fields.filter(({ id }) => id !== targets.id) : [...fields];
    if (!inputs.some(({ id }) => id === group.primary.id)) inputs.push(group.primary);
    if (!share && releases.length === 1) {
      const index = inputs.findIndex(({ id }) => id === targets.id);
      const separate = { ...targets, defaultValue: buildTargets.defaultValue };
      if (index < 0) inputs.push(separate);
      else inputs[index] = separate;
    }
    return { inputs, endpoint: { ...endpoint, inputBindings, serviceId: undefined } };
  }

  function setSharedTarget(share: boolean) {
    const next = sharedTargetTransition(share);
    change(next.inputs, next.endpoint, { sameHostRelease: share || undefined });
  }

  function groupCompanion(group: GraphStartGroup, kind: GraphStartGroupKind): GraphField {
    const { primary, companion } = graphStartGroupFields[kind];
    const suffix = group.id.startsWith(primary + '-') ? group.id.slice(primary.length) : '';
    return {
      ...standardFields[companion],
      id: companion + suffix,
    };
  }

  function addNamed(kind: 'source' | 'release') {
    const key = graphKey('resource');
    const config = graphStartGroupFields[kind];
    const currentGroups = kind === 'source' ? sources : releases;
    const first = currentGroups[0];
    const separate = kind === 'release' && commonTargetBinding;
    const next = separate ? sharedTargetTransition(false) : { inputs: [...fields], endpoint };
    const firstCompanion = first.companion ?? groupCompanion(first, kind);
    for (const field of [first.primary, firstCompanion])
      if (!next.inputs.some(({ id }) => id === field.id)) next.inputs.push(field);
    change(
      [
        ...next.inputs,
        {
          ...standardFields[config.primary],
          id: config.primary + '-' + key,
          name: config.label + ' ' + (currentGroups.length + 1),
        },
        { ...standardFields[config.companion], id: config.companion + '-' + key },
      ],
      kind === 'release' && next.endpoint ? { ...next.endpoint, serviceId: undefined } : undefined,
      separate ? { sameHostRelease: undefined } : undefined,
    );
  }

  function groupUsers(group: GraphStartGroup, kind: GraphStartGroupKind) {
    if (!endpoint) return [];
    const ids = [group.primary.id, group.companion?.id];
    const usesGroup = (bindings?: Record<string, GraphBinding>) =>
      Object.values(bindings ?? {}).some((binding) =>
        ids.some((id) => id !== undefined && bindingUsesInput(binding, id)),
      );
    const selected = (step: GraphNode) => {
      const bindings = endpoint.inputBindings?.[step.id];
      const operation = effectiveNodeType(step);
      const typeMatches =
        kind === 'source'
          ? operation === 'CHECKOUT' ||
            (operation === 'BUILD' && !bindings?.workspace && !checkoutNodes.length)
          : isReleaseNode(step);
      return (
        typeMatches &&
        selectedGraphStartGroup(kind, kind === 'source' ? sources : releases, bindings)?.id ===
          group.id
      );
    };
    return flowNodes.filter(
      (step) =>
        selected(step) ||
        usesGroup(endpoint.inputBindings?.[step.id]) ||
        usesGroup(endpoint.environmentBindings?.[step.id]) ||
        (step.id === endpoint.endId && usesGroup(endpoint.outputBindings)),
    );
  }

  function moveGroup(group: GraphStartGroup, before: GraphStartGroup) {
    const from = fields.findIndex(({ id }) => id === group.id);
    const to = fields.findIndex(({ id }) => id === before.id);
    if (from === -1 || to === -1) return;
    const reordered = [...fields];
    const [field] = reordered.splice(from, 1);
    reordered.splice(to, 0, field);
    change(reordered);
  }

  function groupActions(
    group: GraphStartGroup,
    kind: GraphStartGroupKind,
    list: GraphStartGroup[],
  ) {
    if (!canEdit || list.length < 2) return null;
    const index = list.findIndex(({ id }) => id === group.id);
    const previous = list[index - 1];
    const next = list[index + 1];
    const users = groupUsers(group, kind);
    return (
      <>
        {users.length > 0 && (
          <div className="graph-start-group-users">
            <p className="field-note">移除前，请先在执行流「{node.name}」中更新以下节点的来源。</p>
            <div className="row-actions">
              {users.map((step) =>
                selectStep ? (
                  <button
                    type="button"
                    className="button secondary small"
                    key={step.id}
                    onClick={() => selectStep(step.id)}
                  >
                    {step.name}
                  </button>
                ) : (
                  <span key={step.id}>{step.name}</span>
                ),
              )}
            </div>
          </div>
        )}
        <div className="row-actions">
          <button
            className="button secondary small"
            type="button"
            disabled={!previous}
            onClick={() => previous && moveGroup(group, previous)}
          >
            <ArrowUp size={14} /> 上移
          </button>
          <button
            className="button secondary small"
            type="button"
            disabled={!next}
            onClick={() => next && moveGroup(group, next)}
          >
            <ArrowDown size={14} /> 下移
          </button>
          <button
            className="button secondary small"
            type="button"
            disabled={users.length > 0}
            onClick={() =>
              change(fields.filter(({ id }) => id !== group.id && id !== group.companion?.id))
            }
          >
            <Trash2 size={14} /> 移除 {group.label}
          </button>
        </div>
      </>
    );
  }

  function runtimeToggle(field: GraphField, companion?: GraphField) {
    return (
      <label className="checkbox-row">
        <input
          type="checkbox"
          disabled={!canEdit}
          checked={field.runtimeOverride !== false}
          onChange={(event) => replace(field, { runtimeOverride: event.target.checked }, companion)}
        />
        允许运行时修改{field.name}
      </label>
    );
  }

  function input(field: GraphField, repositoryId?: string, companion?: GraphField) {
    return (
      <div className="graph-start-resource" data-graph-node-field={field.id}>
        <GraphFieldValue
          project={project}
          field={field}
          value={field.defaultValue}
          scope={{ repositoryId }}
          disabled={!canEdit}
          change={(value) => setDefault(field, value, companion)}
        />
        {runtimeToggle(field, companion)}
      </div>
    );
  }

  function source(group: GraphStartGroup) {
    const repository = group.primary;
    const version = group.companion ?? groupCompanion(group, 'source');
    const reference = graphResourceId(repository.defaultValue);
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
        {(sources.length > 1 || repository.id !== 'repository') && (
          <Field label="源码名称">
            <input
              maxLength={100}
              readOnly={!canEdit}
              value={repository.name}
              onChange={(event) => replace(repository, { name: event.target.value }, version)}
            />
          </Field>
        )}
        {input({ ...repository, name: '项目仓库' }, undefined, version)}
        {input(version, registered?.id, repository)}
        <p className="field-note">
          {currentBranch ? '仓库默认分支 · ' + currentBranch : '留空使用仓库默认分支。'}
        </p>
        {groupActions(group, 'source', sources)}
      </section>
    );
  }

  function releaseSettings(group: GraphStartGroup) {
    const service = group.primary;
    const targets = group.companion ?? groupCompanion(group, 'release');
    return (
      <section className="graph-start-resource-group" aria-label={service.name} key={service.id}>
        {(releases.length > 1 || service.id !== 'service') && (
          <Field label="发布组合名称">
            <input
              maxLength={100}
              readOnly={!canEdit}
              value={service.name}
              onChange={(event) => replace(service, { name: event.target.value }, targets)}
            />
          </Field>
        )}
        {input(
          { ...service, name: '项目服务' },
          undefined,
          commonTargetBinding ? undefined : targets,
        )}
        {releases.length === 1 && hasBuild && endpoint && node.contract === 'PRESET' && (
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
        {commonTargetBinding ? (
          <p className="field-note">发布使用开始节点的构建位置。</p>
        ) : (
          input(targets, undefined, service)
        )}
        {groupActions(group, 'release', releases)}
      </section>
    );
  }

  const showsSource = Boolean(
    checkoutNodes.length ||
    (hasBuild && !checkoutNodes.length) ||
    fields.some((field) => isRepositoryField(field)),
  );
  const showsBuild = needsLocation || buildTargets.defaultValue !== undefined;
  if (!showsSource && !showsBuild && !releaseNodes.length && !externalArtifact) return null;
  return (
    <section className="graph-properties graph-start-setup" aria-label="任务默认配置">
      <h4>任务默认配置</h4>
      {showsSource && (
        <>
          {sources.map(source)}
          {canEdit && (
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
          {releases.length > 1 && (node.sameHostRelease || usesLegacySharedTarget) && (
            <div className="graph-repair">
              <p className="field-note">同机发布要求唯一的发布组合。请为每组单独设置目标。</p>
              {canEdit && (
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setSharedTarget(false)}
                >
                  清除旧的同机配置
                </button>
              )}
            </div>
          )}
          {releases.map(releaseSettings)}
          {canEdit && (
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
              value={typedArtifact.selection ? 'latest' : fixedArtifact ? 'fixed' : 'provided'}
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
                  serviceId:
                    releases.length === 1
                      ? graphResourceId(releases[0].primary.defaultValue)
                      : undefined,
                  targets: commonTargetBinding
                    ? targetSelection
                    : releases.length === 1
                      ? (releases[0].companion?.defaultValue as DeploymentSelection | undefined)
                      : undefined,
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
