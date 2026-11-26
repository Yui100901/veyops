import { Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useResource } from '../../../api';
import { Field } from '../../../components';
import type { DeploymentSelection, ProjectDetail, ProjectExecutionSettings } from '../../../models';
import { effectiveNodeType, graphKey, isReleaseNode } from '../execution-graph-definition';
import type { GraphField, GraphNode } from '../execution-graph-definition';
import {
  isSimplifiedAction,
  producesWorkspace,
  simplifiedNodeGroups,
  simplifiedNodeLabel,
  simplifiedReleaseKinds,
  simplifiedSourceDirectory,
  type SimplifiedAction,
  type SimplifiedFinish,
  type SimplifiedGitRef,
  type SimplifiedSource,
  type SimplifiedStart,
} from '../simplified-flow';
import { GraphFieldValue, referenceId } from './ExecutionGraphFields';
import { SimplifiedImageSettings } from './SimplifiedImageSettings';

type NodeSettings = {
  node: GraphNode;
  project: ProjectDetail;
  canEdit: boolean;
  patch: (fields: Partial<GraphNode>) => void;
};

export function SimplifiedText({
  id,
  label,
  value,
  placeholder,
  canEdit,
  change,
  multiline,
  hint,
}: {
  id: string;
  label: string;
  value?: string;
  placeholder?: string;
  canEdit: boolean;
  change: (value: string | undefined) => void;
  multiline?: boolean;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      {multiline ? (
        <textarea
          data-graph-node-field={id}
          rows={4}
          value={value ?? ''}
          placeholder={placeholder}
          readOnly={!canEdit}
          onChange={(event) => change(event.target.value || undefined)}
        />
      ) : (
        <input
          data-graph-node-field={id}
          value={value ?? ''}
          placeholder={placeholder}
          readOnly={!canEdit}
          onChange={(event) => change(event.target.value || undefined)}
        />
      )}
    </Field>
  );
}

function Check({
  label,
  value,
  canEdit,
  change,
  id,
}: {
  label: string;
  value?: boolean;
  canEdit: boolean;
  change: (checked: boolean) => void;
  id?: string;
}) {
  return (
    <label className="checkbox-row">
      <input
        data-graph-node-field={id}
        type="checkbox"
        checked={value ?? false}
        disabled={!canEdit}
        onChange={(event) => change(event.target.checked)}
      />
      {label}
    </label>
  );
}

const variableCredentialTypes = ['API_KEY', 'API_SECRET', 'CUSTOM_SECRET', 'USERNAME_PASSWORD'];

export function SimplifiedStartSettings({
  node,
  project,
  canEdit,
  flowNodes,
  patch,
}: NodeSettings & { flowNodes: GraphNode[] }) {
  const start = node.start ?? {};
  const patchStart = (next: Partial<SimplifiedStart>) => patch({ start: { ...start, ...next } });
  const sources = start.sources ?? [];
  const execution = start.execution ?? { location: 'INHERIT' };
  const release = start.release ?? {};
  const releaseAction = flowNodes.find(isReleaseNode);
  const rollback = releaseAction && effectiveNodeType(releaseAction) === 'ROLLBACK_ARTIFACT';
  const producesFiles = flowNodes.some(producesWorkspace);
  const hasCheckout = flowNodes.some((item) => effectiveNodeType(item) === 'CHECKOUT');
  const hasWorkspace = producesFiles || !releaseAction;
  const [sourceChoice, setSourceChoice] = useState<'FIXED'>();
  const artifactMode =
    rollback || release.artifactId
      ? 'FIXED'
      : release.useUpstreamArtifact
        ? 'UPSTREAM'
        : release.artifactSource === 'RUN_PARAMETER'
          ? 'RUN_PARAMETER'
          : (sourceChoice ?? (producesFiles ? 'CURRENT' : 'FIXED'));
  const staleRelease =
    !releaseAction &&
    Object.entries(release).some(([field, value]) => field !== 'serviceId' && value);
  const savesArtifact = flowNodes.some(
    (item) =>
      ['CHECKOUT', 'BUILD', 'CHECK', 'SHELL'].includes(effectiveNodeType(item)) ||
      item.finish?.images?.length,
  );
  const composeRelease = releaseAction?.deploy?.method === 'COMPOSE';
  const images = flowNodes.find(({ type }) => type === 'END')?.finish?.images ?? [];
  const historical = artifactMode !== 'CURRENT';
  const runtime = useResource<ProjectExecutionSettings>(
    hasWorkspace && execution.location !== 'MANAGER'
      ? '/projects/' + project.id + '/execution-settings'
      : null,
  );
  const effectiveLocation =
    execution.location === 'INHERIT'
      ? runtime.data?.effective.defaultBuildLocation
      : execution.location;
  const variables = start.variables ?? [];

  function updateSources(next: SimplifiedSource[]) {
    patchStart({
      sources: next,
      ...(start.dotenv &&
        !next.some(({ id }) => id === start.dotenv?.sourceId) && { dotenv: undefined }),
      ...(release.compose?.sourceId &&
        !next.some(({ id }) => id === release.compose?.sourceId) && {
          release: { ...release, compose: undefined },
        }),
    });
  }
  function sourceChange(id: string, config: Partial<SimplifiedSource>) {
    updateSources(sources.map((source) => (source.id === id ? { ...source, ...config } : source)));
  }
  function changeRelease(next: Partial<typeof release>) {
    patchStart({ release: { ...release, ...next } });
  }
  function control(
    id: string,
    name: string,
    kind: GraphField['type'],
    value: unknown,
    change: (value: unknown) => void,
    options?: Partial<GraphField>,
  ) {
    return (
      <div className="graph-fields" data-graph-node-field={id}>
        <GraphFieldValue
          project={project}
          field={{ id, name, type: kind, required: false, ...options }}
          value={value}
          change={(next) => change(kind === 'SERVICE' ? referenceId(next) || undefined : next)}
          disabled={!canEdit}
          compactTargets
        />
      </div>
    );
  }
  const locationTarget = {
    ...(execution.serverId && { serverIds: [execution.serverId] }),
    ...(execution.groupId && { groupIds: [execution.groupId] }),
  };
  const selectedTargets =
    !canEdit && 'reuseExecutionServer' in release && release.reuseExecutionServer
      ? locationTarget
      : release.targets;
  const targetControl = () =>
    control('start.release.targets', '发布服务器／分组', 'TARGETS', selectedTargets, (value) =>
      changeRelease({ targets: value as DeploymentSelection | undefined }),
    );
  const projectWorkspace =
    effectiveLocation === 'TARGET'
      ? (runtime.data?.effective.targetWorkspaceRoot ?? '~/.veyops/workspace').replace(/\/+$/, '') +
        '/' +
        project.slug
      : effectiveLocation === 'MANAGER'
        ? 'flow-workspaces/' + project.slug
        : undefined;
  return (
    <>
      {hasWorkspace ? (
        <div className="graph-fields" data-graph-node-field="start.execution">
          <div className="graph-location-grid">
            <Field
              label="执行位置"
              hint={
                execution.location === 'INHERIT' && effectiveLocation
                  ? '当前生效 · ' + (effectiveLocation === 'TARGET' ? '目标端' : '管理端')
                  : undefined
              }
            >
              <select
                data-graph-node-field="start.execution.location"
                value={execution.location}
                disabled={!canEdit}
                onChange={(event) => {
                  const location = event.target.value as typeof execution.location;
                  patchStart({
                    execution: location === 'MANAGER' ? { location } : { ...execution, location },
                  });
                }}
              >
                <option value="INHERIT">沿用项目设置</option>
                <option value="MANAGER">管理端</option>
                <option value="TARGET">目标端</option>
              </select>
            </Field>
            {effectiveLocation === 'TARGET' && (
              <div data-graph-node-field="start.execution.serverId">
                {control(
                  'start.execution.groupId',
                  '执行服务器／分组',
                  'TARGETS',
                  locationTarget,
                  (value) => {
                    const selected = value as DeploymentSelection | undefined;
                    patchStart({
                      execution: {
                        location: execution.location,
                        serverId: selected?.serverIds?.[0],
                        groupId: selected?.groupIds?.[0],
                      },
                    });
                  },
                  { purpose: 'BUILD_TARGETS', required: true },
                )}
              </div>
            )}
          </div>
          {projectWorkspace && (
            <p className="field-note graph-workspace-path">
              工作区 · <code>{projectWorkspace}/&lt;执行 ID&gt;</code>
            </p>
          )}
        </div>
      ) : (
        targetControl()
      )}
      {(hasCheckout || sources.length > 0) && (
        <fieldset
          className="graph-fields graph-source-settings"
          data-graph-node-field="start.sources"
        >
          <legend>源码</legend>
          {hasCheckout && !sources.length && !releaseAction && (
            <p className="field-note">未配置源码时，手动运行需选择同项目的历史目录。</p>
          )}
          {sources.map((source, index) => {
            const sourcePath = 'start.sources.' + source.id + '.';
            const repo = project.repositories.find(({ id }) => source.repositoryId === id);
            const legacy = !canEdit
              ? (source as SimplifiedSource & {
                  parentDirectory?: string;
                  allowRefOverride?: boolean;
                })
              : undefined;
            const directory = repo && simplifiedSourceDirectory(repo.cloneUrl);
            return (
              <div className="graph-field-card graph-source-card" key={source.id}>
                <div className="graph-source-fields">
                  {control(
                    sourcePath + 'repositoryId',
                    '项目仓库',
                    'REPOSITORY',
                    source.repositoryId,
                    (value) =>
                      sourceChange(source.id, {
                        repositoryId: value as string | undefined,
                        ref: undefined,
                      }),
                  )}
                  <div data-graph-node-field={sourcePath + 'ref'}>
                    <GraphFieldValue
                      project={project}
                      field={{ id: source.id, name: 'Git 版本', type: 'GIT_REF', required: false }}
                      value={source.ref}
                      change={(value) =>
                        sourceChange(source.id, { ref: value as SimplifiedGitRef | undefined })
                      }
                      disabled={!canEdit}
                      scope={{ repositoryId: source.repositoryId }}
                      useRepositoryDefault
                    />
                  </div>
                </div>
                {(directory || legacy?.allowRefOverride || canEdit) && (
                  <div className="graph-source-footer">
                    <div className="graph-source-meta">
                      {directory && (
                        <span className="field-note graph-workspace-path">
                          源码目录 ·{' '}
                          <code>
                            ./
                            {legacy?.parentDirectory && legacy.parentDirectory !== '.'
                              ? `${legacy.parentDirectory}/`
                              : ''}
                            {directory}
                          </code>
                        </span>
                      )}
                      {legacy?.allowRefOverride && (
                        <span className="field-note">此发布版本允许运行时更换 Git 版本。</span>
                      )}
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        className="button secondary small"
                        aria-label={'移除源码 ' + (repo?.name ?? index + 1)}
                        onClick={() => updateSources(sources.filter(({ id }) => id !== source.id))}
                      >
                        <Trash2 size={14} aria-hidden="true" /> 移除源码
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {canEdit && hasCheckout && sources.length < 12 && (
            <button
              type="button"
              className="button secondary small graph-source-add"
              onClick={() => updateSources([...sources, { id: graphKey('source') }])}
            >
              <Plus size={14} aria-hidden="true" /> 添加源码
            </button>
          )}
        </fieldset>
      )}
      {staleRelease && (
        <div className="graph-field-card" data-graph-node-field="start.release">
          <p className="field-note">
            这条执行流已没有受管发布动作。请清除发布专用配置后再发布执行图。
          </p>
          {canEdit && (
            <button
              type="button"
              className="button secondary small"
              onClick={() =>
                patchStart({
                  release: release.serviceId ? { serviceId: release.serviceId } : undefined,
                })
              }
            >
              清除发布配置
            </button>
          )}
        </div>
      )}
      {!releaseAction &&
        (savesArtifact || release.serviceId) &&
        control(
          'start.release.serviceId',
          '产物归属服务（可选）',
          'SERVICE',
          release.serviceId,
          (value) => changeRelease({ serviceId: value as string | undefined }),
        )}
      {releaseAction && (
        <fieldset className="graph-fields" data-graph-node-field="start.release">
          <legend>发布设置</legend>
          {control('start.release.serviceId', '项目服务', 'SERVICE', release.serviceId, (value) =>
            changeRelease({ serviceId: value as string | undefined, artifactId: undefined }),
          )}
          {hasWorkspace && targetControl()}
          {!canEdit &&
            'contentPath' in release &&
            typeof release.contentPath === 'string' &&
            release.contentPath !== '.' && (
              <p className="field-note graph-workspace-path">
                此发布版本使用子路径 · <code>{release.contentPath}</code>
              </p>
            )}
          {composeRelease && (
            <div className="form-grid" data-graph-node-field="start.release.compose">
              {!historical && (
                <Field label="本次发布镜像" hint="镜像登记项由本流的结束节点配置。">
                  <select
                    data-graph-node-field="start.release.imageId"
                    value={release.imageId ?? (images.length === 1 ? images[0]?.id : '')}
                    disabled={!canEdit}
                    onChange={(event) =>
                      changeRelease({ imageId: event.target.value || undefined })
                    }
                  >
                    <option value="">选择镜像登记项</option>
                    {release.imageId && !images.some(({ id }) => id === release.imageId) && (
                      <option value={release.imageId} disabled>
                        原登记项已移除
                      </option>
                    )}
                    {images.map(({ id, name }) => (
                      <option key={id} value={id}>
                        {name || '未命名镜像'}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label="Compose 配置来源">
                <select
                  data-graph-node-field="start.release.compose.sourceId"
                  disabled={!canEdit}
                  value={release.compose ? (release.compose.sourceId ?? '__workspace__') : ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    changeRelease({
                      compose: value
                        ? {
                            sourceId: value === '__workspace__' ? undefined : value,
                            path: release.compose?.path ?? '',
                          }
                        : undefined,
                    });
                  }}
                >
                  <option value="">
                    {historical ? '沿用随产物保存的配置' : '请选择 Compose 配置来源'}
                  </option>
                  <option value="__workspace__" disabled={historical}>
                    本次工作区
                  </option>
                  {sources.map((source, index) => (
                    <option key={source.id} value={source.id}>
                      {project.repositories.find(({ id }) => id === source.repositoryId)?.name ??
                        '源码 ' + (index + 1)}
                      {' · 固定提交'}
                    </option>
                  ))}
                </select>
              </Field>
              {release.compose && (
                <SimplifiedText
                  id="start.release.compose.path"
                  label={
                    release.compose.sourceId
                      ? '仓库内 Compose 相对路径'
                      : '工作区内 Compose 相对路径'
                  }
                  value={release.compose.path}
                  placeholder="compose.yaml"
                  canEdit={canEdit}
                  change={(path) =>
                    changeRelease({ compose: { ...release.compose, path: path ?? '' } })
                  }
                />
              )}
            </div>
          )}
          <details className="graph-field-card" open={historical ? true : undefined}>
            <summary>交付产物来源</summary>
            <div className="graph-fields" data-graph-node-field="start.release.artifactId">
              {!rollback && (
                <Field label="产物来源">
                  <select
                    value={artifactMode}
                    data-graph-node-field="start.release.artifactSource"
                    disabled={!canEdit}
                    onChange={(event) => {
                      const mode = event.target.value;
                      setSourceChoice(mode === 'FIXED' ? 'FIXED' : undefined);
                      changeRelease({
                        artifactSource: mode === 'RUN_PARAMETER' ? 'RUN_PARAMETER' : undefined,
                        artifactId: undefined,
                        useUpstreamArtifact: mode === 'UPSTREAM' || undefined,
                        upstreamArtifactName: undefined,
                        ...(mode === 'RUN_PARAMETER' && { allowArtifactOverride: undefined }),
                        ...(mode !== 'CURRENT' && {
                          imageId: undefined,
                          ...(!release.compose?.sourceId && { compose: undefined }),
                        }),
                      });
                    }}
                  >
                    {producesFiles && <option value="CURRENT">本次构建产物</option>}
                    <option value="RUN_PARAMETER">运行时选择已有产物</option>
                    <option value="FIXED">固定已有产物</option>
                    <option value="UPSTREAM">上游成功运行的产物</option>
                  </select>
                </Field>
              )}
              {artifactMode === 'RUN_PARAMETER' && (
                <p className="field-note">
                  运行此执行流时必须选择同一服务的产物。自动交付可使用上游产物模式。
                </p>
              )}
              {release.useUpstreamArtifact && (
                <SimplifiedText
                  id="start.release.upstreamArtifactName"
                  label="上游产物登记名称"
                  value={release.upstreamArtifactName}
                  placeholder={composeRelease ? 'team/api' : 'workspace'}
                  hint="上游登记多件同类型产物时，填写要使用的名称。"
                  canEdit={canEdit}
                  change={(upstreamArtifactName) => changeRelease({ upstreamArtifactName })}
                />
              )}
              {artifactMode === 'FIXED' && (
                <GraphFieldValue
                  project={project}
                  field={{
                    id: 'artifactId',
                    name: rollback ? '曾成功发布的产物实例' : '已登记产物实例',
                    type: 'ARTIFACT',
                    required: true,
                    acceptedArtifactTypes: simplifiedReleaseKinds(releaseAction?.deploy?.method),
                  }}
                  value={release.artifactId}
                  change={(value) =>
                    changeRelease({
                      artifactId: value as string | undefined,
                      artifactSource: undefined,
                      useUpstreamArtifact: undefined,
                      ...(typeof value === 'string' &&
                        !release.compose?.sourceId && { compose: undefined }),
                      ...(typeof value === 'string' && { imageId: undefined }),
                    })
                  }
                  disabled={!canEdit}
                  artifactInstancesOnly
                  scope={{
                    serviceId: release.serviceId,
                    deliveryMethod: releaseAction?.deploy?.method,
                    targets: selectedTargets,
                  }}
                />
              )}
              {artifactMode !== 'RUN_PARAMETER' && (
                <Check
                  id="start.release.allowArtifactOverride"
                  label="允许运行时选择历史产物"
                  value={release.allowArtifactOverride}
                  canEdit={canEdit}
                  change={(allowArtifactOverride) => changeRelease({ allowArtifactOverride })}
                />
              )}
            </div>
          </details>
        </fieldset>
      )}
      <fieldset className="graph-fields">
        <legend>环境变量</legend>
        {control(
          'start.environmentSetId',
          '项目变量集合',
          'ENVIRONMENT_SET',
          start.environmentSetId,
          (value) => patchStart({ environmentSetId: value as string | undefined }),
        )}
        <details className="graph-field-card">
          <summary>流程变量与 dotenv</summary>
          <div className="graph-fields" data-graph-node-field="start.variables">
            {variables.map((variable, index) => {
              const fieldId = 'start.variables.' + variable.key;
              const update = (next: Partial<typeof variable>) =>
                patchStart({
                  variables: variables.map((item, i) =>
                    i === index ? { ...item, ...next } : item,
                  ),
                });
              return (
                <div
                  className="graph-fields graph-field-card"
                  key={index}
                  data-graph-node-field={fieldId}
                >
                  <div className="form-grid">
                    <SimplifiedText
                      id={fieldId + '.key'}
                      label="变量名"
                      placeholder="BUILD_PROFILE"
                      value={variable.key}
                      canEdit={canEdit}
                      change={(key) => update({ key: key ?? '' })}
                    />
                    {variable.value === undefined ? (
                      <GraphFieldValue
                        project={project}
                        field={{
                          id: fieldId,
                          name: '敏感变量凭据',
                          type: 'CREDENTIAL',
                          required: false,
                        }}
                        credentialTypes={variableCredentialTypes}
                        value={variable.credentialId}
                        change={(value) => update({ credentialId: value as string | undefined })}
                        disabled={!canEdit}
                      />
                    ) : (
                      <SimplifiedText
                        id={fieldId + '.value'}
                        label="变量值"
                        value={variable.value}
                        canEdit={canEdit}
                        change={(value) => update({ value: value ?? '' })}
                      />
                    )}
                  </div>
                  <div className="heading-actions">
                    <Check
                      label="使用敏感凭据"
                      value={variable.value === undefined}
                      canEdit={canEdit}
                      change={(secret) =>
                        update({
                          value: secret ? undefined : '',
                          credentialId: undefined,
                          allowOverride: false,
                        })
                      }
                    />
                    {variable.value !== undefined && (
                      <Check
                        label="允许运行时覆盖"
                        value={variable.allowOverride}
                        canEdit={canEdit}
                        change={(allowOverride) => update({ allowOverride })}
                      />
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() =>
                          patchStart({ variables: variables.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2 size={14} /> 移除变量
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {canEdit && (
              <div className="heading-actions">
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => patchStart({ variables: [...variables, { key: '', value: '' }] })}
                >
                  <Plus size={14} /> 添加变量
                </button>
              </div>
            )}
            {sources.length > 0 && (
              <div className="form-grid" data-graph-node-field="start.dotenv">
                <Field label="dotenv 来源（可选）">
                  <select
                    data-graph-node-field="start.dotenv.sourceId"
                    value={start.dotenv?.sourceId ?? ''}
                    disabled={!canEdit}
                    onChange={(event) =>
                      patchStart({
                        dotenv: event.target.value
                          ? { sourceId: event.target.value, path: start.dotenv?.path ?? '' }
                          : undefined,
                      })
                    }
                  >
                    <option value="">不加载文件</option>
                    {sources.map((source, index) => (
                      <option key={source.id} value={source.id}>
                        {project.repositories.find(({ id }) => id === source.repositoryId)?.name ??
                          '源码 ' + (index + 1)}
                      </option>
                    ))}
                  </select>
                </Field>
                {start.dotenv && (
                  <SimplifiedText
                    id="start.dotenv.path"
                    label="仓库内相对路径"
                    placeholder=".env.test"
                    canEdit={canEdit}
                    value={start.dotenv.path}
                    change={(path) =>
                      patchStart({ dotenv: { sourceId: start.dotenv!.sourceId, path: path ?? '' } })
                    }
                  />
                )}
              </div>
            )}
          </div>
        </details>
      </fieldset>
    </>
  );
}

export function SimplifiedEndSettings({
  node,
  project,
  canEdit,
  patch,
  flowNodes,
  hasReleaseOnAllFlows = flowNodes.some(isReleaseNode),
  sharedFlows = [],
}: NodeSettings & {
  flowNodes: GraphNode[];
  hasReleaseOnAllFlows?: boolean;
  sharedFlows?: string[];
}) {
  const finish = node.finish ?? {};
  const saveWorkspace = finish.saveWorkspace !== false;
  const startRelease = flowNodes.find((item) => item.type === 'START')?.start?.release;
  const hasWorkspace = flowNodes.some(producesWorkspace);
  const requiresFileSnapshot =
    !startRelease?.artifactId &&
    startRelease?.artifactSource !== 'RUN_PARAMETER' &&
    !startRelease?.useUpstreamArtifact &&
    flowNodes.some(
      (item) => effectiveNodeType(item) === 'DEPLOY_ARTIFACT' && item.deploy?.method !== 'COMPOSE',
    );
  const change = (next: Partial<SimplifiedFinish>) => patch({ finish: { ...finish, ...next } });
  return (
    <fieldset className="graph-fields" data-graph-node-field="finish">
      <legend>交付结果</legend>
      {hasWorkspace && (
        <>
          <Check
            label="保留整个执行目录"
            id="finish.saveWorkspace"
            value={saveWorkspace}
            canEdit={canEdit}
            change={(saveWorkspace) => change({ saveWorkspace })}
          />
          {(saveWorkspace || requiresFileSnapshot) && (
            <div className="form-grid">
              {saveWorkspace ? (
                <Field label="保留范围">
                  <select
                    value={finish.retention ?? 'PERSISTENT'}
                    disabled={!canEdit}
                    data-graph-node-field="finish.retention"
                    onChange={(event) =>
                      change({ retention: event.target.value as SimplifiedFinish['retention'] })
                    }
                  >
                    <option value="PERSISTENT">登记并可历史重发</option>
                    <option value="RUN">仅供本次运行</option>
                  </select>
                </Field>
              ) : (
                <p className="field-note">本次文件发布所需的执行目录会作为临时产物保留。</p>
              )}
            </div>
          )}
          <SimplifiedImageSettings
            node={node}
            canEdit={canEdit}
            project={project}
            flowNodes={flowNodes}
            patch={patch}
          />
        </>
      )}
      {hasReleaseOnAllFlows ? (
        <Field
          label="发布结果核对"
          hint={sharedFlows.length > 1 ? sharedFlows.join('、') + '共用此设置。' : undefined}
        >
          <select
            data-graph-node-field="finish.requireRelease"
            disabled={!canEdit}
            value={finish.requireRelease ?? ''}
            onChange={(event) =>
              change({
                requireRelease: (event.target.value ||
                  undefined) as SimplifiedFinish['requireRelease'],
              })
            }
          >
            <option value="">汇总动作状态</option>
            <option value="ACTIVATED">所有目标均已激活</option>
            <option value="HEALTHY">所有目标均已激活且健康</option>
          </select>
        </Field>
      ) : finish.requireRelease ? (
        <div className="graph-field-card" data-graph-node-field="finish.requireRelease">
          <p className="field-note">
            此结束节点对应的执行流中存在未配置受管发布的流程。请清除发布结果核对后再发布执行图。
          </p>
          {canEdit && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => change({ requireRelease: undefined })}
            >
              清除发布结果核对
            </button>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}

function WorkingDirectory({
  id,
  project,
  sources,
  value,
  canEdit,
  change,
}: Pick<NodeSettings, 'project' | 'canEdit'> & {
  id: string;
  sources: SimplifiedSource[];
  value?: string;
  change: (value: string | undefined) => void;
}) {
  const listId = useId();
  const options = new Set<string>();
  for (const source of sources) {
    const repo = project.repositories.find(({ id }) => id === source.repositoryId);
    const directory = repo && simplifiedSourceDirectory(repo.cloneUrl);
    if (directory) options.add(directory);
  }
  const hint =
    value &&
    value !== '.' &&
    options.size > 0 &&
    ![...options.keys()].some((path) => {
      const configured = value.replace(/^\.\//, '').replace(/\/$/, '');
      return configured === path || configured.startsWith(path + '/');
    });
  return (
    <Field
      label="工作目录"
      hint={
        hint
          ? '此路径不属于当前源码目录。请确认它由上一步生成，或重新选择。'
          : '相对本次工作区。可选择源码目录并填写子目录，留空使用根目录。'
      }
    >
      <input
        data-graph-node-field={id}
        list={listId}
        value={value ?? ''}
        placeholder="."
        readOnly={!canEdit}
        onChange={(event) => change(event.target.value || undefined)}
      />
      <datalist id={listId}>
        <option value="." label="工作区根" />
        {[...options].map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
    </Field>
  );
}

export function SimplifiedActionSettings({
  node,
  project,
  canEdit,
  patch,
  sources,
  selectOperation,
}: NodeSettings & {
  sources: SimplifiedSource[];
  selectOperation?: (operation: SimplifiedAction) => void;
}) {
  const operation = effectiveNodeType(node);
  const shell = node.shell ?? {};
  const build = node.build ?? {};
  const deploy = node.deploy ?? {};
  const text = (
    id: string,
    label: string,
    value: string | undefined,
    change: (value: string | undefined) => void,
    multiline = false,
    placeholder?: string,
  ) => (
    <SimplifiedText
      id={id}
      label={label}
      value={value}
      canEdit={canEdit}
      change={change}
      multiline={multiline}
      placeholder={placeholder}
    />
  );
  const timeout = (
    id: string,
    value: number | undefined,
    change: (value: number | undefined) => void,
    max = 7200,
    label = '超时（秒）',
  ) => (
    <Field label={label}>
      <input
        data-graph-node-field={id}
        type="number"
        min={1}
        max={max}
        value={value ?? ''}
        readOnly={!canEdit}
        onChange={(event) => change(event.target.value ? Number(event.target.value) : undefined)}
      />
    </Field>
  );
  return (
    <div className="graph-inspector-panel graph-fields">
      <div className="graph-fields">
        <p className="graph-action-name">
          <span className="field-note">执行动作</span>
          <strong>{simplifiedNodeLabel(operation)}</strong>
        </p>
        {canEdit && selectOperation && (
          <details key={node.id + ':' + operation} className="graph-field-card">
            <summary>更换动作</summary>
            <Field label="选择新动作">
              <select
                data-graph-node-field="operation"
                value=""
                onChange={(event) => {
                  const action = event.target.value as GraphNode['type'];
                  if (isSimplifiedAction(action) && action !== operation) selectOperation(action);
                }}
              >
                <option value="" disabled>
                  请选择动作
                </option>
                {simplifiedNodeGroups.map(({ name, types }) => {
                  const choices = types.filter(
                    (type) => isSimplifiedAction(type) && type !== operation,
                  );
                  return choices.length ? (
                    <optgroup key={name} label={name}>
                      {choices.map((type) => (
                        <option key={type} value={type}>
                          {simplifiedNodeLabel(type)}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </select>
            </Field>
          </details>
        )}
      </div>
      {operation === 'CHECKOUT' && (
        <>
          <p className="field-note">按开始节点配置拉取。</p>
          <Check
            id="checkout.fullClone"
            label="拉取完整 Git 历史"
            value={node.checkout?.fullClone}
            canEdit={canEdit}
            change={(fullClone) => patch({ checkout: { fullClone } })}
          />
        </>
      )}
      {(operation === 'SHELL' || operation === 'CHECK') && (
        <>
          {text(
            'shell.command',
            '命令',
            shell.command,
            (command) => patch({ shell: { ...shell, command } }),
            true,
          )}
          <div className="form-grid">
            <WorkingDirectory
              id="shell.directory"
              project={project}
              sources={sources}
              canEdit={canEdit}
              value={shell.directory}
              change={(directory) => patch({ shell: { ...shell, directory } })}
            />
            {timeout('shell.timeout', shell.timeout, (timeout) =>
              patch({ shell: { ...shell, timeout } }),
            )}
          </div>
        </>
      )}
      {operation === 'BUILD' && (
        <>
          <div className="form-grid">
            <WorkingDirectory
              id="build.repoPath"
              project={project}
              sources={sources}
              canEdit={canEdit}
              value={build.repoPath}
              change={(repoPath) => patch({ build: { ...build, repoPath } })}
            />
            {text('build.buildImage', '构建环境镜像（可选）', build.buildImage, (buildImage) =>
              patch({ build: { ...build, buildImage } }),
            )}
            {timeout('build.timeout', build.timeout, (timeout) =>
              patch({ build: { ...build, timeout } }),
            )}
          </div>
          <Check
            id="build.dockerfilePath"
            label="使用 Dockerfile 构建镜像"
            value={build.dockerfilePath !== undefined}
            canEdit={canEdit}
            change={(enabled) =>
              patch({ build: { ...build, dockerfilePath: enabled ? 'Dockerfile' : undefined } })
            }
          />
          {build.dockerfilePath !== undefined &&
            text(
              'build.dockerfilePath',
              'Dockerfile 路径',
              build.dockerfilePath,
              (dockerfilePath) =>
                patch({ build: { ...build, dockerfilePath: dockerfilePath ?? '' } }),
              false,
              'Dockerfile',
            )}
          {text(
            'build.installCommand',
            '安装命令',
            build.installCommand,
            (installCommand) => patch({ build: { ...build, installCommand } }),
            true,
          )}
          {text(
            'build.buildCommand',
            '构建命令',
            build.buildCommand,
            (buildCommand) => patch({ build: { ...build, buildCommand } }),
            true,
          )}
        </>
      )}
      {(operation === 'DEPLOY_ARTIFACT' || operation === 'ROLLBACK_ARTIFACT') && (
        <>
          <p className="field-note">服务、目标和产物来源在开始节点配置。</p>
          <Field label="发布方式">
            <select
              data-graph-node-field="deploy.method"
              value={deploy.method ?? 'FILE'}
              disabled={!canEdit}
              onChange={(event) =>
                patch({
                  deploy:
                    event.target.value === 'COMPOSE'
                      ? { method: 'COMPOSE' }
                      : { ...deploy, method: 'FILE' },
                })
              }
            >
              <option value="FILE">文件发布</option>
              <option value="COMPOSE">Docker Compose</option>
            </select>
          </Field>
          {deploy.method !== 'COMPOSE' &&
            text(
              'deploy.stopCommand',
              '停用旧版本命令（可选）',
              deploy.stopCommand,
              (stopCommand) => patch({ deploy: { ...deploy, stopCommand } }),
              true,
            )}
          {deploy.method !== 'COMPOSE' &&
            text(
              'deploy.startCommand',
              '启动新版本命令（可选）',
              deploy.startCommand,
              (startCommand) => patch({ deploy: { ...deploy, startCommand } }),
              true,
            )}
        </>
      )}
      {operation === 'HEALTH_CHECK' && (
        <>
          {text(
            'healthCheck.command',
            '健康检查命令',
            node.healthCheck?.command,
            (command) => patch({ healthCheck: { ...node.healthCheck, command } }),
            true,
          )}
          {timeout(
            'healthCheck.timeoutSeconds',
            node.healthCheck?.timeoutSeconds,
            (timeoutSeconds) => patch({ healthCheck: { ...node.healthCheck, timeoutSeconds } }),
            180,
          )}
        </>
      )}
      {(operation === 'APPROVAL' || operation === 'SOURCE_REVIEW') &&
        timeout(
          'approval.timeoutSeconds',
          node.approval?.timeoutSeconds,
          (timeoutSeconds) => patch({ approval: { ...node.approval, timeoutSeconds } }),
          604800,
        )}
      {operation === 'DELAY' &&
        timeout(
          'delaySeconds',
          node.delaySeconds,
          (delaySeconds) => patch({ delaySeconds }),
          86400,
          '等待（秒）',
        )}
    </div>
  );
}
