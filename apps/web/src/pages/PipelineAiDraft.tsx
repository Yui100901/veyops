import { useId, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { message, post } from '../api';
import { ErrorBanner, Field } from '../components';
import type { PipelineDefinition } from './Delivery';
import { useRepositoryBranches } from './RepositoryBranches';
import type { PipelineNode } from './pipeline-node-definition';

const settingLabels = {
  buildImage: '隔离构建镜像',
  outputPath: '产物目录',
  dockerfilePath: 'Dockerfile 路径',
  imageRepository: '镜像仓库名称',
  composeFilePath: 'Compose 文件',
  deployPath: '部署目录',
  startCommand: '启动命令',
  healthCheckCommand: '健康检查命令',
} as const;
const missingLabels: Record<string, string> = {
  ...settingLabels,
  registryId: 'Registry',
  repoPath: '仓库子目录',
};
type DraftFields = Partial<Pick<PipelineDefinition, keyof typeof settingLabels>> & {
  nodes: PipelineNode[];
};
interface DraftResult {
  source: { path: string; commitSha: string };
  draft: { name: string; definition: DraftFields };
  evidencePaths: string[];
  missingFields: string[];
  notes: string[];
}
type Preferences = Pick<PipelineDefinition, 'buildLocation' | 'artifactType'> & {
  defaultMode: 'BUILD_ONLY' | 'DEPLOY';
};

export function PipelineAiDraft({
  projectId,
  serviceId,
  repositoryId,
  repoPath,
  initialBranch,
  currentNodes,
  pipeline,
  onApply,
  onUndo,
}: {
  projectId: string;
  serviceId: string;
  repositoryId: string;
  repoPath: string;
  initialBranch?: string;
  currentNodes?: PipelineNode[];
  pipeline?: Preferences;
  onApply: (name: string, fields: DraftFields) => void;
  onUndo?: () => void;
}) {
  const id = useId();
  const [branch, setBranch] = useState(initialBranch || '');
  const [commitSha, setCommitSha] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [result, setResult] = useState<DraftResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const branches = useRepositoryBranches(
    sourceOpen && projectId && repositoryId
      ? `/projects/${projectId}/repositories/${repositoryId}`
      : null,
  );
  const ready = Boolean(projectId && serviceId && repositoryId && repoPath.trim() && pipeline);
  function resetPreview() {
    setResult(undefined);
    setError('');
  }
  async function generate() {
    if (!ready || busy) return;
    resetPreview();
    if (commitSha.trim() && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commitSha.trim())) {
      setError('请填写完整的 Git 提交 SHA，或清空以分析分支最新提交。');
      return;
    }
    setBusy(true);
    try {
      const response = await post<DraftResult>('/ai/repository-analysis', {
        projectId,
        serviceId,
        repositoryId,
        repoPath: repoPath.trim(),
        pipeline,
        branch: branch.trim() || undefined,
        commitSha: commitSha.trim() || undefined,
      });
      if (!response.draft.definition.nodes?.length) throw new Error('AI 没有生成节点，请重试。');
      setResult(response);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const proposed = result?.draft.definition;
  const settings = (Object.keys(settingLabels) as (keyof typeof settingLabels)[]).flatMap((key) =>
    proposed?.[key] ? [[key, proposed[key]] as const] : [],
  );
  return (
    <section className="pipeline-ai-draft" aria-label="AI 流水线草稿">
      <div className="pipeline-nodes-heading">
        <h3>AI 流水线草稿</h3>
        <button
          type="button"
          className="button secondary small"
          onClick={() => void generate()}
          disabled={!ready || busy}
        >
          <Sparkles size={17} />
          {busy ? '正在分析仓库…' : result ? '重新生成草稿' : 'AI 生成节点'}
        </button>
      </div>
      <p className="field-note">
        {ready
          ? '根据仓库中的代码和部署说明生成节点，审核后可填入当前流程。'
          : '选择项目、服务、主仓库及构建方式后即可生成草稿。'}
      </p>
      <details onToggle={(event) => setSourceOpen(event.currentTarget.open)}>
        <summary>
          分析来源 ·{' '}
          {commitSha.trim() ? commitSha.trim().slice(0, 12) : branch.trim() || '仓库默认分支'}
        </summary>
        <div className="form-grid">
          <Field label="源码分支" hint="留空使用远程默认分支。">
            <input
              value={branch}
              disabled={busy}
              list={id}
              placeholder="默认分支"
              onChange={(e) => {
                setBranch(e.target.value);
                resetPreview();
              }}
            />
          </Field>
          <datalist id={id}>
            {branches.data?.branches.map(({ name }) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <Field label="分析指定提交" hint="留空使用分支最新提交。固定提交仅用于此次分析。">
            <input
              value={commitSha}
              disabled={busy}
              className="mono"
              placeholder="完整 Git SHA（可选）"
              onChange={(e) => {
                setCommitSha(e.target.value);
                resetPreview();
              }}
            />
          </Field>
        </div>
      </details>
      <ErrorBanner error={error} />
      {onUndo && !result && (
        <div className="row-actions">
          <p className="field-note" role="status">
            草稿已填入，可继续编辑后保存。
          </p>
          <button type="button" className="button secondary small" onClick={onUndo}>
            撤销采用
          </button>
        </div>
      )}
      {result && proposed && (
        <div className="pipeline-ai-preview">
          <h4>审核生成的流程</h4>
          <p className="field-note">
            依据 {result.evidencePaths.join('、')} · 提交 <code>{result.source.commitSha}</code>
          </p>
          <ol>
            {proposed.nodes.map((node) => (
              <li key={node.id}>
                <strong>{node.name}</strong>
                {node.branch && <span> · {node.branch}</span>}
                {node.command && <pre>{node.command}</pre>}
              </li>
            ))}
          </ol>
          {settings.length > 0 && (
            <dl>
              {settings.map(([key, value]) => (
                <div key={key}>
                  <dt>{settingLabels[key]}</dt>
                  <dd>
                    <code>{value}</code>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {result.missingFields.length > 0 && (
            <p>
              请核对或补充 {result.missingFields.map((key) => missingLabels[key] || key).join('、')}
            </p>
          )}
          {result.notes.length > 0 && (
            <ul>
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p className="field-note">
            {currentNodes?.length
              ? `采用后将替换当前 ${currentNodes.length} 个节点（${currentNodes.map((node) => node.name).join('、')}）。`
              : '采用后将把原有流程改为以上节点。'}
            预览中的构建和部署参数也会填入表单。
          </p>
          <div className="row-actions">
            <button
              type="button"
              className="button primary small"
              onClick={() => {
                onApply(result.draft.name, {
                  ...Object.fromEntries(settings),
                  nodes: proposed.nodes,
                });
                setResult(undefined);
              }}
            >
              采用草稿
            </button>
            <button type="button" className="button secondary small" onClick={resetPreview}>
              放弃草稿
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
