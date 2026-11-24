import { Plus, Trash2 } from 'lucide-react';
import { useResource } from '../../../api';
import { ErrorBanner, Field } from '../../../components';
import type { ProjectDetail } from '../../../models';
import { artifactTypes } from './ExecutionGraphFields';
import { graphKey } from '../execution-graph-definition';
import { primaryBuildArtifact } from './graph-presets';
import type {
  FlowBuildDefinition,
  FlowDeployDefinition,
  GraphArtifactOutput,
  GraphArtifactType,
} from '../execution-graph-definition';
import type { GraphIssueLocation } from '../../../api';

export function BuildFields({
  section,
  value,
  canEdit,
  change,
  useStartDefaults,
}: {
  section: 'input' | 'execution' | 'output';
  value: FlowBuildDefinition;
  canEdit: boolean;
  useStartDefaults?: boolean;
  change: (value: FlowBuildDefinition) => void;
}) {
  const hasNamedOutputs = !!value.artifacts?.length;
  const buildsImage = hasNamedOutputs
    ? value.artifacts!.some(({ type }) => type === 'DOCKER_IMAGE')
    : value.artifactType === 'DOCKER_IMAGE';
  const registries = useResource<{ id: string; name: string }[]>(
    section === 'output' && buildsImage ? '/registries' : null,
  );
  function patch(fields: Partial<FlowBuildDefinition>) {
    change({ ...value, ...fields });
  }
  if (section === 'input')
    return (
      <Field
        label="额外源码工作区"
        hint="用逗号分隔小写别名，保存后在所属执行流绑定输入。构建命令可访问 VEYOPS_GRAPH_DEPENDENCY_ROOT 下对应的目录。"
      >
        <input
          key={value.dependencies?.join(',') || ''}
          defaultValue={value.dependencies?.join(', ') || ''}
          placeholder="例如 frontend, schemas"
          maxLength={280}
          disabled={!canEdit}
          onBlur={(event) => {
            const dependencies = event.target.value.split(/[,，\s]+/).filter(Boolean);
            if (dependencies.join(',') !== (value.dependencies ?? []).join(','))
              patch({ dependencies: dependencies.length ? dependencies : undefined });
          }}
        />
      </Field>
    );
  if (section === 'output')
    return (
      <div className="form-grid graph-preset-fields">
        {!hasNamedOutputs && (
          <>
            <Field label="默认产物类型">
              <select
                disabled={!canEdit}
                value={value.artifactType ?? 'FILE'}
                onChange={(event) => {
                  const type = event.target.value as GraphArtifactType;
                  if (type === 'DIRECTORY') {
                    patch({ artifacts: [primaryBuildArtifact(type)] });
                  } else {
                    patch({ artifactType: type });
                  }
                }}
              >
                <option value="FILE">文件归档</option>
                <option value="DIRECTORY">目录</option>
                <option value="DOCKER_IMAGE">Docker 镜像</option>
              </select>
            </Field>
            {buildsImage ? (
              <Text
                label="镜像仓库"
                value={value.imageRepository}
                canEdit={canEdit}
                onChange={(imageRepository) => patch({ imageRepository })}
              />
            ) : (
              <Text
                label="归档目录"
                placeholder="dist"
                value={value.outputPath}
                canEdit={canEdit}
                onChange={(outputPath) => patch({ outputPath })}
              />
            )}
          </>
        )}
        {buildsImage && (
          <>
            <Field label="镜像 Registry">
              <select
                disabled={!canEdit}
                value={value.registryId ?? ''}
                onChange={(e) => patch({ registryId: e.target.value || undefined })}
              >
                <option value="">未配置</option>
                {registries.data?.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <ErrorBanner error={registries.error} />
          </>
        )}
        <ArtifactOutputEditor
          value={value.artifacts ?? []}
          canEdit={canEdit}
          build
          onChange={(artifacts) => patch({ artifacts })}
        />
      </div>
    );
  return (
    <div className="form-grid graph-preset-fields">
      {useStartDefaults ? (
        <p className="field-note">构建位置在开始节点设置。</p>
      ) : (
        <Field label="构建位置">
          <select
            disabled={!canEdit}
            value={value.buildLocation ?? ''}
            onChange={(e) =>
              patch({
                buildLocation: (e.target.value ||
                  undefined) as FlowBuildDefinition['buildLocation'],
              })
            }
          >
            <option value="">项目默认设置</option>
            <option value="TARGET">目标服务器</option>
            <option value="MANAGER">管理端隔离构建</option>
          </select>
        </Field>
      )}
      <Text
        label="源码目录"
        placeholder="."
        value={value.repoPath}
        canEdit={canEdit}
        onChange={(repoPath) => patch({ repoPath })}
      />
      {value.buildLocation !== 'TARGET' && (
        <Text
          label="构建环境镜像"
          value={value.buildImage}
          canEdit={canEdit}
          onChange={(buildImage) => patch({ buildImage })}
        />
      )}
      <Text
        label="安装命令"
        multiline
        value={value.installCommand}
        canEdit={canEdit}
        onChange={(installCommand) => patch({ installCommand })}
      />
      <Text
        label="构建命令"
        fieldId="buildCommand"
        multiline
        value={value.buildCommand}
        canEdit={canEdit}
        onChange={(buildCommand) => patch({ buildCommand })}
      />
      {buildsImage && (
        <Text
          label="Dockerfile 路径"
          fieldId="dockerfilePath"
          placeholder="Dockerfile"
          value={value.dockerfilePath}
          canEdit={canEdit}
          onChange={(dockerfilePath) => patch({ dockerfilePath })}
        />
      )}
    </div>
  );
}

export function DeployFields({
  project,
  value,
  canEdit,
  change,
}: {
  project: ProjectDetail;
  value: FlowDeployDefinition;
  canEdit: boolean;
  change: (value: FlowDeployDefinition) => void;
}) {
  const template = value.composeSource;
  const repositoryFile = template?.kind === 'REPOSITORY_FILE' ? template : undefined;
  function patchRepositoryFile(patch: Partial<NonNullable<typeof repositoryFile>>) {
    if (repositoryFile) change({ ...value, composeSource: { ...repositoryFile, ...patch } });
  }
  return (
    <fieldset className="graph-fields">
      <legend>部署配置</legend>
      <div className="form-grid graph-preset-fields">
        <Field label="发布方式">
          <select
            data-graph-node-field="method"
            disabled={!canEdit}
            value={value.method ?? ''}
            onChange={(event) => {
              const method = event.target.value as FlowDeployDefinition['method'];
              change({
                ...value,
                method: method || undefined,
                composeSource:
                  method === 'COMPOSE' ? (template ?? { kind: 'ARTIFACT' }) : undefined,
              });
            }}
          >
            <option value="">从产物类型确定</option>
            <option value="FILE">文件或目录</option>
            <option value="COMPOSE">Docker Compose</option>
          </select>
        </Field>
        <Text
          label="发布路径"
          fieldId="deployPath"
          placeholder="目标主机上的绝对路径"
          value={value.deployPath}
          canEdit={canEdit}
          onChange={(deployPath) => change({ ...value, deployPath })}
        />
        {value.method !== 'FILE' && (
          <Field label="Compose 模板来源" hint="Compose 发布会锁定模板摘要。">
            <select
              data-graph-node-field="composeSource"
              disabled={!canEdit}
              value={template?.kind ?? ''}
              onChange={(event) =>
                change({
                  ...value,
                  composeSource:
                    event.target.value === 'REPOSITORY_FILE'
                      ? {
                          kind: 'REPOSITORY_FILE',
                          repositoryId:
                            project.repositories.length === 1 ? project.repositories[0].id : '',
                          commitSha: '',
                          path: value.composeFilePath ?? 'compose.yaml',
                        }
                      : event.target.value === 'ARTIFACT'
                        ? { kind: 'ARTIFACT' }
                        : undefined,
                })
              }
            >
              <option value="">默认使用产物自带模板</option>
              <option value="ARTIFACT">产物自带模板</option>
              <option value="REPOSITORY_FILE">固定提交中的仓库文件</option>
            </select>
          </Field>
        )}
        {repositoryFile && (
          <>
            <Field label="模板仓库">
              <select
                disabled={!canEdit}
                value={repositoryFile.repositoryId}
                onChange={(event) =>
                  patchRepositoryFile({ repositoryId: event.target.value, commitSha: '' })
                }
              >
                <option value="">选择仓库</option>
                {project.repositories.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Text
              label="模板提交 SHA"
              fieldId="composeCommitSha"
              value={repositoryFile.commitSha}
              placeholder="完整提交 SHA"
              canEdit={canEdit}
              onChange={(commitSha) => patchRepositoryFile({ commitSha: commitSha ?? '' })}
            />
            <Text
              label="模板文件相对路径"
              fieldId="composeFilePath"
              value={repositoryFile.path}
              placeholder="compose.yaml"
              canEdit={canEdit}
              onChange={(path) => patchRepositoryFile({ path: path ?? '' })}
            />
          </>
        )}
        <Text
          label="启动命令"
          multiline
          value={value.startCommand}
          canEdit={canEdit}
          onChange={(startCommand) => change({ ...value, startCommand })}
        />
        <Text
          label="停止命令"
          multiline
          value={value.stopCommand}
          canEdit={canEdit}
          onChange={(stopCommand) => change({ ...value, stopCommand })}
        />
      </div>
    </fieldset>
  );
}

export function ArtifactOutputEditor({
  value,
  canEdit,
  build = false,
  pathInputs = [],
  onChange,
}: {
  value: GraphArtifactOutput[];
  canEdit: boolean;
  build?: boolean;
  pathInputs?: { id: string; name: string }[];
  onChange: (artifacts: GraphArtifactOutput[]) => void;
}) {
  function patch(index: number, fields: Partial<GraphArtifactOutput>) {
    onChange(value.map((output, i) => (i === index ? { ...output, ...fields } : output)));
  }
  return (
    <fieldset className="graph-fields">
      <legend>具名产物</legend>
      {value.map((output, index) => (
        <details
          className="graph-field-card"
          key={output.id ?? output.name}
          data-graph-field={output.id ?? output.name}
        >
          <summary>{output.name || '未命名产物'}</summary>
          <div className="graph-fields">
            <Field label="产物名称">
              <input
                value={output.name}
                disabled={!canEdit}
                maxLength={100}
                onChange={(event) =>
                  patch(index, { id: output.id ?? output.name, name: event.target.value })
                }
              />
            </Field>
            <Field label="引用名称" hint={'稳定端口 ID · ' + (output.id ?? output.name)}>
              <input
                data-graph-artifact-field="referenceName"
                value={output.referenceName ?? ''}
                disabled={!canEdit}
                maxLength={64}
                onChange={(event) =>
                  patch(index, { referenceName: event.target.value || undefined })
                }
              />
            </Field>
            <Field label="来源类型">
              <select
                value={output.type}
                disabled={!canEdit}
                onChange={(event) => {
                  const type = event.target.value as GraphArtifactType;
                  if (build && output.id === 'primaryArtifact') {
                    const previous = primaryBuildArtifact(output.type);
                    const next = primaryBuildArtifact(type);
                    patch(index, {
                      type,
                      path: next.path,
                      pathInput: undefined,
                      imageReference: undefined,
                      name: output.name === previous.name ? next.name : output.name,
                      referenceName:
                        output.referenceName === previous.referenceName
                          ? next.referenceName
                          : output.referenceName,
                    });
                  } else {
                    patch(index, {
                      type,
                      path: undefined,
                      pathInput: undefined,
                      imageReference: undefined,
                    });
                  }
                }}
              >
                {artifactTypes.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {output.type === 'DOCKER_IMAGE' ? (
              <>
                {build && (
                  <Text
                    label="Dockerfile 路径"
                    artifactField="path"
                    placeholder="Dockerfile"
                    value={output.path}
                    canEdit={canEdit}
                    onChange={(path) => patch(index, { path })}
                  />
                )}
                <Text
                  label={build ? '构建镜像名称（可选）' : '镜像引用'}
                  artifactField="imageReference"
                  value={output.imageReference}
                  canEdit={canEdit}
                  onChange={(imageReference) => patch(index, { imageReference })}
                />
                <Text
                  label="Compose 配置路径（可选）"
                  artifactField="composeFilePath"
                  value={output.composeFilePath}
                  canEdit={canEdit}
                  onChange={(composeFilePath) => patch(index, { composeFilePath })}
                />
              </>
            ) : (
              <>
                {(pathInputs.length > 0 || output.pathInput) && (
                  <Field label="路径来源">
                    <select
                      data-graph-artifact-field="pathInput"
                      value={output.pathInput ?? ''}
                      disabled={!canEdit}
                      onChange={(event) =>
                        patch(index, { pathInput: event.target.value || undefined })
                      }
                    >
                      <option value="">填写相对路径</option>
                      {output.pathInput &&
                        !pathInputs.some(({ id }) => id === output.pathInput) && (
                          <option value={output.pathInput} disabled>
                            已失效的路径输入
                          </option>
                        )}
                      {pathInputs.map(({ id, name }) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Text
                  label={output.pathInput ? '备用相对路径' : '工作区相对路径'}
                  artifactField="path"
                  hint={build ? '相对构建工作目录。发布执行图时必填。' : undefined}
                  required={build}
                  placeholder={output.type === 'DIRECTORY' ? 'dist/' : 'dist/app.tar.gz'}
                  value={output.path}
                  canEdit={canEdit}
                  onChange={(path) => patch(index, { path })}
                />
              </>
            )}
            <label className="checkbox-row">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={output.required !== false}
                onChange={(event) => patch(index, { required: event.target.checked })}
              />{' '}
              必需产物
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={output.persist !== false}
                onChange={(event) =>
                  patch(index, { persist: event.target.checked ? undefined : false })
                }
              />
              登记供后续运行使用
            </label>
            {output.persist === false && (
              <p className="field-note">临时产物可在本次运行和子流中使用。</p>
            )}
            {canEdit && (
              <button
                type="button"
                className="button secondary small"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} /> 移除产物
              </button>
            )}
          </div>
        </details>
      ))}
      {canEdit && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            let i = value.length + 1;
            while (value.some(({ name }) => name === 'artifact-' + i)) i++;
            onChange([
              ...value,
              { id: graphKey('artifact'), name: '产物 ' + i, type: 'DIRECTORY', required: true },
            ]);
          }}
        >
          <Plus size={14} /> 添加产物
        </button>
      )}
    </fieldset>
  );
}

function Text({
  label,
  fieldId,
  artifactField,
  hint,
  required,
  value,
  canEdit,
  multiline,
  placeholder,
  onChange,
}: {
  label: string;
  fieldId?: string;
  artifactField?: GraphIssueLocation['artifactField'];
  hint?: string;
  required?: boolean;
  value?: string;
  canEdit: boolean;
  multiline?: boolean;
  placeholder?: string;
  onChange: (value?: string) => void;
}) {
  const shared = {
    value: value ?? '',
    readOnly: !canEdit,
    placeholder,
    'data-graph-node-field': fieldId,
    'data-graph-artifact-field': artifactField,
  };
  return (
    <Field label={label} hint={hint} required={required}>
      {multiline ? (
        <textarea
          {...shared}
          rows={2}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      ) : (
        <input {...shared} onChange={(event) => onChange(event.target.value || undefined)} />
      )}
    </Field>
  );
}
