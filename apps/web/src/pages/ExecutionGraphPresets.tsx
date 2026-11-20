import { Plus, Trash2 } from 'lucide-react';
import { useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type { ProjectDetail } from '../models';
import { useRepositoryBranches, BranchSyncControls } from './RepositoryBranches';
import { artifactTypes } from './ExecutionGraphFields';
import type {
  FlowBuildDefinition,
  FlowDeployDefinition,
  GraphArtifactOutput,
  GraphNode,
} from './execution-graph-definition';

export const graphTemplates: { name: string; nodes: GraphNode['type'][] }[] = [
  { name: '构建并部署', nodes: ['BUILD', 'DEPLOY_ARTIFACT'] },
  { name: '仅构建', nodes: ['BUILD'] },
  { name: '仅部署', nodes: ['DEPLOY_ARTIFACT'] },
  { name: '审批后执行脚本', nodes: ['APPROVAL', 'SHELL'] },
];

export function BuildFields({
  project,
  value,
  canEdit,
  change,
}: {
  project: ProjectDetail;
  value: FlowBuildDefinition;
  canEdit: boolean;
  change: (value: FlowBuildDefinition) => void;
}) {
  const repositoryId = value.repositoryId ?? '';
  const repo = project.repositories.find((item) => item.id === repositoryId);
  const branches = useRepositoryBranches(
    repo ? `/projects/${project.id}/repositories/${repo.id}` : null,
  );
  const registries = useResource<{ id: string; name: string }[]>(
    value.artifactType === 'DOCKER_IMAGE' ||
      value.artifacts?.some(({ type }) => type === 'DOCKER_IMAGE')
      ? '/registries'
      : null,
  );
  function patch(fields: Partial<FlowBuildDefinition>) {
    change({ ...value, ...fields });
  }
  return (
    <div className="form-grid graph-preset-fields">
      <Field label="构建仓库">
        <select
          disabled={!canEdit}
          value={repositoryId}
          onChange={(event) =>
            patch({
              repositoryId: event.target.value || undefined,
              branch: undefined,
              commitSha: undefined,
            })
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
      {repo && (
        <Field label="构建分支" hint="留空使用远程默认分支。固定提交优先，可留空。">
          <select
            disabled={!canEdit || branches.loading}
            value={value.branch ?? ''}
            onChange={(event) =>
              patch({ branch: event.target.value || undefined, commitSha: undefined })
            }
          >
            <option value="">远程默认分支</option>
            {value.branch && !branches.data?.branches.some(({ name }) => name === value.branch) && (
              <option value={value.branch}>{value.branch}</option>
            )}
            {branches.data?.branches.map(({ name }) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          {canEdit && <BranchSyncControls branches={branches} />}
        </Field>
      )}
      <Text
        label="固定提交 SHA"
        value={value.commitSha}
        canEdit={canEdit}
        onChange={(commitSha) => patch({ commitSha, ...(commitSha && { branch: undefined }) })}
      />
      <Field label="构建位置">
        <select
          disabled={!canEdit}
          value={value.buildLocation ?? ''}
          onChange={(e) =>
            patch({
              buildLocation: (e.target.value || undefined) as FlowBuildDefinition['buildLocation'],
            })
          }
        >
          <option value="">项目默认设置</option>
          <option value="TARGET">目标服务器</option>
          <option value="MANAGER">管理端隔离构建</option>
        </select>
      </Field>
      <Field label="默认产物类型">
        <select
          disabled={!canEdit}
          value={value.artifactType ?? 'FILE'}
          onChange={(e) =>
            patch({ artifactType: e.target.value as FlowBuildDefinition['artifactType'] })
          }
        >
          <option value="FILE">文件归档</option>
          <option value="DOCKER_IMAGE">Docker 镜像</option>
        </select>
      </Field>
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
        multiline
        value={value.buildCommand}
        canEdit={canEdit}
        onChange={(buildCommand) => patch({ buildCommand })}
      />
      {(value.artifactType ?? 'FILE') === 'FILE' ? (
        <Text
          label="归档目录"
          placeholder="dist"
          value={value.outputPath}
          canEdit={canEdit}
          onChange={(outputPath) => patch({ outputPath })}
        />
      ) : (
        <>
          <Text
            label="Dockerfile 路径"
            placeholder="Dockerfile"
            value={value.dockerfilePath}
            canEdit={canEdit}
            onChange={(dockerfilePath) => patch({ dockerfilePath })}
          />
          <Text
            label="镜像仓库"
            value={value.imageRepository}
            canEdit={canEdit}
            onChange={(imageRepository) => patch({ imageRepository })}
          />
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
        onChange={(artifacts) => patch({ artifacts })}
      />
    </div>
  );
}

export function DeployFields({
  value,
  canEdit,
  change,
}: {
  value: FlowDeployDefinition;
  canEdit: boolean;
  change: (value: FlowDeployDefinition) => void;
}) {
  return (
    <details className="advanced-options">
      <summary>默认部署配置</summary>
      <p className="field-note">服务环境可以单独配置发布路径、命令和健康检查。</p>
      <div className="form-grid graph-preset-fields">
        <Text
          label="发布路径"
          value={value.deployPath}
          canEdit={canEdit}
          onChange={(deployPath) => change({ ...value, deployPath })}
        />
        <Text
          label="Compose 配置路径"
          value={value.composeFilePath}
          canEdit={canEdit}
          onChange={(composeFilePath) => change({ ...value, composeFilePath })}
        />
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
        <Text
          label="健康检查命令"
          multiline
          value={value.healthCheckCommand}
          canEdit={canEdit}
          onChange={(healthCheckCommand) => change({ ...value, healthCheckCommand })}
        />
      </div>
    </details>
  );
}

export function ArtifactOutputEditor({
  value,
  canEdit,
  onChange,
}: {
  value: GraphArtifactOutput[];
  canEdit: boolean;
  onChange: (artifacts: GraphArtifactOutput[]) => void;
}) {
  function patch(index: number, fields: Partial<GraphArtifactOutput>) {
    onChange(value.map((output, i) => (i === index ? { ...output, ...fields } : output)));
  }
  return (
    <fieldset className="graph-fields">
      <legend>具名产物</legend>
      {value.map((output, index) => (
        <details className="graph-field-card" key={index}>
          <summary>{output.name || '未命名产物'}</summary>
          <div className="graph-fields">
            <Field label="产物名称">
              <input
                value={output.name}
                disabled={!canEdit}
                maxLength={100}
                onChange={(event) => patch(index, { name: event.target.value })}
              />
            </Field>
            <Field label="来源类型">
              <select
                value={output.type}
                disabled={!canEdit}
                onChange={(event) =>
                  patch(index, {
                    type: event.target.value as GraphArtifactOutput['type'],
                    path: undefined,
                    imageReference: undefined,
                  })
                }
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
                <Text
                  label="镜像引用"
                  value={output.imageReference}
                  canEdit={canEdit}
                  onChange={(imageReference) => patch(index, { imageReference })}
                />
                <Text
                  label="Compose 配置路径（可选）"
                  value={output.composeFilePath}
                  canEdit={canEdit}
                  onChange={(composeFilePath) => patch(index, { composeFilePath })}
                />
              </>
            ) : (
              <Text
                label="工作区相对路径"
                value={output.path}
                canEdit={canEdit}
                onChange={(path) => patch(index, { path })}
              />
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
            onChange([...value, { name: 'artifact-' + i, type: 'DIRECTORY', required: true }]);
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
  value,
  canEdit,
  multiline,
  placeholder,
  onChange,
}: {
  label: string;
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
  };
  return (
    <Field label={label}>
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
