import { Plus } from 'lucide-react';
import { useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type { ProjectDetail } from '../models';
import { useRepositoryBranches, BranchSyncControls } from './RepositoryBranches';
import { flowPresetLabels } from './execution-graph-definition';
import type {
  FlowBuildDefinition,
  FlowDelivery,
  FlowDeployDefinition,
  FlowPreset,
  GraphNode,
} from './execution-graph-definition';

const presetNodes: Record<FlowPreset, GraphNode['type'][]> = {
  CUSTOM: [],
  BUILD: ['BUILD'],
  DEPLOY: ['DEPLOY_ARTIFACT'],
  BUILD_DEPLOY: ['BUILD', 'DEPLOY_ARTIFACT'],
  VERIFY: ['SHELL'],
  MAINTENANCE: ['APPROVAL', 'SHELL'],
  RELEASE_REVIEW: ['APPROVAL', 'LOG'],
};

export function StartDeliveryFields({
  project,
  value,
  canEdit,
  change,
  insert,
}: {
  project: ProjectDetail;
  value?: FlowDelivery;
  canEdit: boolean;
  change: (value?: FlowDelivery) => void;
  insert?: (nodes: GraphNode['type'][]) => void;
}) {
  const kind = value?.kind ?? 'CUSTOM';
  const hasBuild = kind === 'BUILD' || kind === 'BUILD_DEPLOY';
  const hasDeploy = kind === 'DEPLOY' || kind === 'BUILD_DEPLOY';
  return (
    <>
      <Field label="执行流预设">
        <select
          value={kind}
          disabled={!canEdit}
          onChange={(event) => {
            const next = event.target.value as FlowPreset;
            const builds = next === 'BUILD' || next === 'BUILD_DEPLOY';
            const deploys = next === 'DEPLOY' || next === 'BUILD_DEPLOY';
            change({
              kind: next,
              serviceId:
                value?.serviceId ??
                ((builds || deploys) && project.services.length === 1
                  ? project.services[0]!.id
                  : undefined),
              ...(builds && { build: value?.build }),
              ...(deploys && { deploy: value?.deploy }),
            });
          }}
        >
          {Object.entries(flowPresetLabels).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={hasBuild || hasDeploy ? '关联服务' : '关联服务（可选）'}>
        <select
          value={value?.serviceId ?? ''}
          disabled={!canEdit}
          onChange={(event) =>
            change({ ...value, kind, serviceId: event.target.value || undefined })
          }
        >
          <option value="">{hasBuild || hasDeploy ? '选择项目服务' : '无关联服务'}</option>
          {project.services.map((service) => (
            <option value={service.id} key={service.id}>
              {service.name}
            </option>
          ))}
        </select>
      </Field>
      {hasBuild && (
        <BuildFields
          project={project}
          value={value?.build ?? {}}
          canEdit={canEdit}
          change={(build) => change({ ...value, kind, build })}
        />
      )}
      {hasDeploy && (
        <DeployFields
          value={value?.deploy ?? {}}
          canEdit={canEdit}
          change={(deploy) => change({ ...value, kind, deploy })}
        />
      )}
      {canEdit && insert && presetNodes[kind].length > 0 && (
        <button
          type="button"
          className="button secondary small"
          onClick={() => insert(presetNodes[kind])}
        >
          <Plus size={15} /> 插入预设节点
        </button>
      )}
    </>
  );
}

function BuildFields({
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
    value.artifactType === 'DOCKER_IMAGE' ? '/registries' : null,
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
      <Field label="产物类型">
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
    </div>
  );
}

function DeployFields({
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
