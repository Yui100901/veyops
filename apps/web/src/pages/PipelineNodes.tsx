import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useResource } from '../api';
import { BranchSyncControls, useRepositoryBranches } from './RepositoryBranches';
import { ErrorBanner, Field } from '../components';
import type { Credential, ProjectDetail } from '../models';
import { PipelineNodeGraph, pipelineNodeLabels, type PipelineNodeType } from './PipelineNodeGraph';
import {
  commandTypes,
  newNode,
  ordered,
  type NodeVariable,
  type PipelineNode,
} from './pipeline-node-definition';

const types = Object.keys(pipelineNodeLabels) as PipelineNodeType[];
const environmentSuffixes: Record<string, string[]> = {
  DEVELOPMENT: ['dev', 'development'],
  TESTING: ['test', 'testing'],
  STAGING: ['stage', 'staging'],
  PRODUCTION: ['prod', 'production'],
};

function move(nodes: PipelineNode[], from: number, to: number) {
  const reordered = [...nodes];
  [reordered[from], reordered[to]] = [reordered[to]!, reordered[from]!];
  return reordered;
}

export default function PipelineNodesEditor({
  nodes,
  project,
  primaryRepositoryId,
  onChange,
}: {
  nodes: PipelineNode[];
  project?: ProjectDetail;
  primaryRepositoryId: string;
  onChange: (nodes: PipelineNode[]) => void;
}) {
  const [selectedId, setSelectedId] = useState(nodes[0]?.id);
  const [newType, setNewType] = useState<PipelineNodeType>('TEST');
  const index = Math.max(
    0,
    nodes.findIndex(({ id }) => id === selectedId),
  );
  const node = nodes[index];
  const available = types.filter(
    (type) => !['PACKAGE', 'DEPLOY'].includes(type) || !nodes.some((node) => node.type === type),
  );
  const typeToAdd = available.includes(newType) ? newType : 'TEST';
  const canMove = (offset: number) =>
    index > 0 &&
    index + offset > 0 &&
    index + offset < nodes.length &&
    ordered(move(nodes, index, index + offset));
  function addNode() {
    const next = newNode(typeToAdd);
    let before = nodes.length;
    if (typeToAdd === 'CHECKOUT') {
      before = nodes.filter(({ type }) => type === 'CHECKOUT').length;
      if (before > 0) next.directory = `source-${before + 1}`;
    } else if (typeToAdd !== 'DEPLOY') {
      const after = nodes.findIndex(
        ({ type }) => type === 'DEPLOY' || (typeToAdd !== 'PACKAGE' && type === 'PACKAGE'),
      );
      if (after !== -1) before = after;
    }
    onChange([...nodes.slice(0, before), next, ...nodes.slice(before)]);
    setSelectedId(next.id);
  }
  function patch(changes: Partial<PipelineNode>) {
    onChange(nodes.map((entry, i) => (i === index ? { ...entry, ...changes } : entry)));
  }
  return (
    <section className="pipeline-nodes-editor" aria-label="流水线节点编辑器">
      <PipelineNodeGraph items={nodes} selectedId={node?.id} onSelect={setSelectedId} />
      <div className="pipeline-node-add">
        <Field label="节点类型">
          <select
            value={typeToAdd}
            onChange={(event) => setNewType(event.target.value as PipelineNodeType)}
          >
            {available.map((type) => (
              <option key={type} value={type}>
                {pipelineNodeLabels[type]}
              </option>
            ))}
          </select>
        </Field>
        <button
          className="button secondary small"
          type="button"
          onClick={addNode}
          disabled={nodes.length >= 40}
        >
          <Plus size={18} /> 添加节点
        </button>
      </div>
      {node && (
        <div className="pipeline-node-editor-panel">
          <div className="pipeline-node-editor-header">
            <h4>{pipelineNodeLabels[node.type]}</h4>
            <div className="pipeline-node-editor-actions">
              <button
                className="button secondary icon-button"
                type="button"
                aria-label="前移节点"
                title="前移节点"
                disabled={!canMove(-1)}
                onClick={() => onChange(move(nodes, index, index - 1))}
              >
                <ArrowUp size={18} />
              </button>
              <button
                className="button secondary icon-button"
                type="button"
                aria-label="后移节点"
                title="后移节点"
                disabled={!canMove(1)}
                onClick={() => onChange(move(nodes, index, index + 1))}
              >
                <ArrowDown size={18} />
              </button>
              {index > 0 && (
                <button
                  className="button secondary icon-button danger-text"
                  type="button"
                  aria-label="移除节点"
                  title="移除节点"
                  onClick={() => {
                    onChange(nodes.filter(({ id }) => id !== node.id));
                    setSelectedId(nodes[index - 1]?.id);
                  }}
                >
                  <Trash2 size={18} />
                </button>
              )}
            </div>
          </div>
          <Field label="节点名称" required>
            <input
              value={node.name}
              onChange={(event) => patch({ name: event.target.value })}
              maxLength={120}
              required
            />
          </Field>
          {node.type === 'CHECKOUT' && (
            <CheckoutNodeFields
              key={node.id}
              node={node}
              primary={index === 0}
              primaryRepositoryId={primaryRepositoryId}
              project={project}
              onChange={patch}
            />
          )}
          {node.type === 'ENVIRONMENT' && (
            <EnvironmentNodeFields
              key={node.id}
              node={node}
              sources={nodes.filter(({ type }) => type === 'CHECKOUT')}
              primaryRepositoryId={primaryRepositoryId}
              project={project}
              onChange={patch}
            />
          )}
          {commandTypes.includes(node.type) && (
            <>
              <div className="form-grid">
                <Field label="工作目录" hint="相对于工作区。留空使用流水线的仓库子目录。">
                  <input
                    value={node.directory ?? ''}
                    onChange={(event) => patch({ directory: event.target.value || undefined })}
                    maxLength={300}
                  />
                </Field>
                <Field label="超时（秒）" hint="默认 900 秒。">
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    value={node.timeout ?? ''}
                    onChange={(event) =>
                      patch({
                        timeout: event.target.value === '' ? undefined : Number(event.target.value),
                      })
                    }
                  />
                </Field>
              </div>
              <Field
                label="Shell 命令"
                hint="可使用 VEYOPS_PROJECT_NAME 和 VEYOPS_SERVICE_NAME。"
                required
              >
                <textarea
                  className="mono"
                  rows={3}
                  required
                  value={node.command ?? ''}
                  onChange={(event) => patch({ command: event.target.value })}
                />
              </Field>
            </>
          )}
          {node.type === 'PACKAGE' && (
            <p className="field-note">使用下方的产物配置进行归档和校验。</p>
          )}
          {node.type === 'DEPLOY' && (
            <p className="field-note">
              仅在「构建并部署」模式运行。产物校验通过后创建独立部署任务，遵循服务环境的发布审批策略。
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function repositoryPath(projectId?: string, repositoryId?: string) {
  return projectId && repositoryId
    ? `/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repositoryId)}`
    : null;
}

function CheckoutNodeFields({
  node,
  primary,
  primaryRepositoryId,
  project,
  onChange,
}: {
  node: PipelineNode;
  primary: boolean;
  primaryRepositoryId: string;
  project?: ProjectDetail;
  onChange: (changes: Partial<PipelineNode>) => void;
}) {
  const listId = useId();
  const selectedRepository = node.repositoryId || primaryRepositoryId;
  const primaryName = project?.repositories.find(({ id }) => id === primaryRepositoryId)?.name;
  const path = repositoryPath(project?.id, selectedRepository);
  const branches = useRepositoryBranches(path);
  return (
    <>
      <div className="form-grid">
        <Field label="源码仓库">
          <select
            disabled={primary}
            value={
              primary || node.repositoryId === primaryRepositoryId ? '' : (node.repositoryId ?? '')
            }
            onChange={(event) =>
              onChange({
                repositoryId: event.target.value || undefined,
                branch: undefined,
                environmentBranches: undefined,
              })
            }
          >
            <option value="">主仓库{primaryName && ` · ${primaryName}`}</option>
            {project?.repositories
              .filter(({ id }) => id !== primaryRepositoryId)
              .map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
          </select>
        </Field>
        <Field
          label="检出目录"
          hint={primary ? '主仓库位于工作区根目录。' : '相对于工作区，使用独立目录。'}
        >
          <input
            readOnly={primary}
            value={primary ? '.' : (node.directory ?? '')}
            onChange={(event) => onChange({ directory: event.target.value || undefined })}
            maxLength={300}
            required
          />
        </Field>
      </div>
      <BranchSyncControls branches={branches} />
      <datalist id={listId}>
        {branches.data?.branches.map(({ name }) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <Field
        label="分支"
        hint={
          selectedRepository === primaryRepositoryId
            ? '留空沿用运行时选择的固定提交。'
            : '用于预览时锁定提交，可为环境单独覆盖。'
        }
      >
        <input
          list={listId}
          autoComplete="off"
          value={node.branch ?? ''}
          onChange={(event) => onChange({ branch: event.target.value || undefined })}
          maxLength={255}
        />
      </Field>
      {project?.environments.length ? (
        <details className="advanced-options pipeline-node-overrides">
          <summary>
            按环境覆盖分支
            {Object.keys(node.environmentBranches ?? {}).length
              ? ` · ${Object.keys(node.environmentBranches ?? {}).length} 个`
              : ''}
          </summary>
          <div className="form-grid">
            {project.environments.map(({ id, name }) => (
              <Field key={id} label={name}>
                <input
                  list={listId}
                  value={node.environmentBranches?.[id] ?? ''}
                  placeholder="继承节点分支"
                  autoComplete="off"
                  maxLength={255}
                  onChange={(event) => {
                    const next = { ...node.environmentBranches };
                    if (event.target.value) next[id] = event.target.value;
                    else delete next[id];
                    onChange({ environmentBranches: Object.keys(next).length ? next : undefined });
                  }}
                />
              </Field>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}

function EnvironmentNodeFields({
  node,
  sources,
  primaryRepositoryId,
  project,
  onChange,
}: {
  node: PipelineNode;
  sources: PipelineNode[];
  primaryRepositoryId: string;
  project?: ProjectDetail;
  onChange: (changes: Partial<PipelineNode>) => void;
}) {
  const variables = node.variables ?? [];
  const credentials = useResource<Credential[]>(
    variables.some(({ value }) => value === undefined) ? '/credentials' : null,
  );
  const [browseFiles, setBrowseFiles] = useState(false);
  function setVariable(index: number, variable: NodeVariable) {
    onChange({ variables: variables.map((entry, i) => (i === index ? variable : entry)) });
  }
  return (
    <>
      <p className="field-note">变量可供后续构建节点使用。敏感值请选择凭据引用。</p>
      <div className="form-grid">
        <Field label="工作目录" hint="相对于工作区，留空使用根目录。">
          <input
            value={node.directory ?? ''}
            onChange={(event) => onChange({ directory: event.target.value || undefined })}
            maxLength={300}
          />
        </Field>
        <Field label="环境文件" hint="相对于工作目录，例如 .env.test。">
          <input
            className="mono"
            value={node.envFile ?? ''}
            onChange={(event) => onChange({ envFile: event.target.value || undefined })}
            maxLength={300}
          />
        </Field>
      </div>
      <button
        className="text-button"
        type="button"
        aria-expanded={browseFiles}
        onClick={() => setBrowseFiles(!browseFiles)}
      >
        {browseFiles ? '收起仓库环境文件' : '从仓库选择环境文件'}
      </button>
      {browseFiles && (
        <EnvironmentFilePicker
          sources={sources}
          primaryRepositoryId={primaryRepositoryId}
          project={project}
          onSelect={(directory, envFile) => {
            onChange({ directory, envFile });
            setBrowseFiles(false);
          }}
        />
      )}
      <ErrorBanner error={credentials.error} retry={credentials.reload} />
      {variables.map((variable, index) => {
        const secret = variable.value === undefined;
        return (
          <div className="pipeline-node-variable" key={index}>
            <Field label="变量名" required>
              <input
                className="mono"
                value={variable.key}
                onChange={(event) => setVariable(index, { ...variable, key: event.target.value })}
                maxLength={128}
                pattern="[A-Za-z_][A-Za-z0-9_]{0,127}"
                required
              />
            </Field>
            <Field label="来源">
              <select
                value={secret ? 'secret' : 'value'}
                onChange={(event) =>
                  setVariable(index, {
                    key: variable.key,
                    ...(event.target.value === 'secret' ? { credentialId: '' } : { value: '' }),
                  })
                }
              >
                <option value="value">普通值</option>
                <option value="secret">凭据引用</option>
              </select>
            </Field>
            {secret ? (
              <Field label="凭据" required>
                <select
                  value={variable.credentialId ?? ''}
                  required
                  onChange={(event) =>
                    setVariable(index, { ...variable, credentialId: event.target.value })
                  }
                >
                  <option value="">{credentials.loading ? '正在读取凭据…' : '选择凭据'}</option>
                  {variable.credentialId &&
                    !credentials.data?.some(
                      ({ id, status }) => id === variable.credentialId && status === 'ACTIVE',
                    ) && <option value={variable.credentialId}>已选凭据</option>}
                  {credentials.data
                    ?.filter(({ status }) => status === 'ACTIVE')
                    .map(({ id, name }) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                </select>
              </Field>
            ) : (
              <Field label="值">
                <input
                  value={variable.value}
                  onChange={(event) =>
                    setVariable(index, { ...variable, value: event.target.value })
                  }
                />
              </Field>
            )}
            <button
              className="button secondary icon-button danger-text"
              type="button"
              aria-label={`移除变量 ${index + 1}`}
              onClick={() => onChange({ variables: variables.filter((_, i) => i !== index) })}
            >
              <Trash2 size={18} />
            </button>
          </div>
        );
      })}
      <button
        className="button secondary small"
        type="button"
        onClick={() => onChange({ variables: [...variables, { key: '', value: '' }] })}
      >
        <Plus size={18} /> 添加变量
      </button>
    </>
  );
}

function EnvironmentFilePicker({
  sources,
  primaryRepositoryId,
  project,
  onSelect,
}: {
  sources: PipelineNode[];
  primaryRepositoryId: string;
  project?: ProjectDetail;
  onSelect: (directory: string, envFile: string) => void;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '');
  const [environmentId, setEnvironmentId] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');
  const source = sources.find(({ id }) => id === sourceId);
  const path = repositoryPath(project?.id, source?.repositoryId || primaryRepositoryId);
  const branches = useRepositoryBranches(path);
  const preferredBranch = source?.environmentBranches?.[environmentId] || source?.branch;
  const branch = preferredBranch || selectedBranch;
  const commitSha = branches.data?.branches.find(({ name }) => name === branch)?.sha;
  const files = useResource<{ files: { path: string; keys: string[] }[] }>(
    path && commitSha
      ? `${path}/environment-files?commitSha=${encodeURIComponent(commitSha)}`
      : null,
  );
  const environment = project?.environments.find(({ id }) => id === environmentId);
  const expectedFiles = new Set(
    environment
      ? [environment.slug, ...(environmentSuffixes[environment.environmentType] ?? [])].map(
          (suffix) => `.env.${suffix}`,
        )
      : [],
  );
  const sortedFiles = [...(files.data?.files ?? [])].sort(
    (a, b) =>
      Number(expectedFiles.has(b.path.split('/').at(-1) ?? '')) -
      Number(expectedFiles.has(a.path.split('/').at(-1) ?? '')),
  );
  return (
    <div className="pipeline-node-file-picker">
      <div className="form-grid">
        <Field label="源码节点">
          <select
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setSelectedBranch('');
            }}
          >
            {sources.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="预览环境">
          <select
            value={environmentId}
            onChange={(event) => {
              setEnvironmentId(event.target.value);
              setSelectedBranch('');
            }}
          >
            <option value="">节点默认配置</option>
            {project?.environments.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!preferredBranch && (
        <Field label="检查哪个分支">
          <select value={branch} onChange={(event) => setSelectedBranch(event.target.value)}>
            <option value="">选择分支</option>
            {branches.data?.branches.map(({ name }) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <BranchSyncControls branches={branches} />
      <ErrorBanner error={files.error} retry={files.reload} />
      {branch && branches.loading && <p className="field-note">正在读取分支…</p>}
      {branch && !branches.loading && !branches.error && !commitSha && (
        <p className="field-note">找不到分支 {branch}。可手动填写环境文件路径。</p>
      )}
      {commitSha && files.loading && <p className="field-note">正在检查 {branch} 上的环境文件…</p>}
      {files.data && sortedFiles.length === 0 && (
        <p className="field-note">此提交未找到可选的环境文件。</p>
      )}
      {sortedFiles.map(({ path, keys }) => (
        <div className="pipeline-node-file" key={path}>
          <div>
            <code>{path}</code>
            {keys.length > 0 && <small>{keys.join('、')}</small>}
          </div>
          <button
            className="button secondary small"
            type="button"
            onClick={() => onSelect(source?.directory || '.', path)}
          >
            使用此文件
          </button>
        </div>
      ))}
    </div>
  );
}
