import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../../api';
import { ErrorBanner, Field } from '../../../components';
import type { ProjectDetail } from '../../../models';
import type { GraphFlowExpansion, GraphNode } from '../execution-graph-definition';

type Proposal = GraphFlowExpansion & { commitSha: string; notes: string[]; files: string[] };

export function ExecutionGraphAiDraft({
  project,
  node,
  canEdit,
  insert,
}: {
  project: ProjectDetail;
  node: GraphNode;
  canEdit: boolean;
  insert: (proposal: GraphFlowExpansion) => void;
}) {
  const [sourceId, selectSource] = useState('');
  const [instructions, setInstructions] = useState('');
  const [result, setResult] = useState<{ proposal: Proposal; sourceKey: string }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const sources = (node.start?.sources ?? []).filter(({ repositoryId }) =>
    project.repositories.some(({ id }) => id === repositoryId),
  );
  const source = sources.find(({ id }) => id === sourceId) ?? sources[0];
  const serviceId = node.start?.release?.serviceId;
  const sourceKey = JSON.stringify([source, serviceId]);
  const proposal = result?.sourceKey === sourceKey ? result.proposal : undefined;

  useEffect(() => () => pending.current?.abort(), []);

  async function propose() {
    if (!canEdit || !source?.repositoryId || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const proposal = await api<Proposal>(`/projects/${project.id}/execution-graph/ai-draft`, {
        method: 'POST',
        body: JSON.stringify({
          repositoryId: source.repositoryId,
          ref: source.ref,
          serviceId,
          instructions: instructions.trim() || undefined,
        }),
        signal: controller.signal,
      });
      setResult({ proposal, sourceKey });
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '分析失败');
    } finally {
      pending.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function apply() {
    if (!canEdit || !proposal) return;
    const current = node.start;
    try {
      insert({
        startId: proposal.startId,
        canvas: {
          ...proposal.canvas,
          nodes: proposal.canvas.nodes.map((item) => {
            if (item.id !== proposal.startId || !item.start) return item;
            const dotenv = current?.dotenv;
            const proposedSource = item.start.sources?.[0];
            return {
              ...item,
              start: {
                ...item.start,
                execution: current?.execution,
                environmentSetId: current?.environmentSetId,
                variables: current?.variables,
                ...(dotenv &&
                  proposedSource &&
                  dotenv.sourceId === source?.id && {
                    dotenv: { ...dotenv, sourceId: proposedSource.id },
                  }),
              },
            };
          }),
        },
      });
      setResult(undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法添加执行流');
    }
  }

  return (
    <details className="graph-field-card">
      <summary>AI 辅助构建执行图</summary>
      <div className="graph-fields">
        {!source && <p className="field-note">请先在此开始节点选择一个项目仓库。</p>}
        {sources.length > 1 && (
          <Field label="分析仓库">
            <select
              disabled={busy || !canEdit}
              value={source?.id}
              onChange={(event) => selectSource(event.target.value)}
            >
              {sources.map(({ id, repositoryId, ref }) => (
                <option key={id} value={id}>
                  {project.repositories.find((repo) => repo.id === repositoryId)?.name}
                  {ref && ` · ${ref.value}`}
                </option>
              ))}
            </select>
          </Field>
        )}
        {source && (
          <Field label="补充构建要求（可选）">
            <textarea
              rows={3}
              maxLength={1500}
              value={instructions}
              disabled={busy || !canEdit}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Field>
        )}
        <div className="heading-actions">
          <button
            type="button"
            className="button secondary small"
            disabled={!source || !canEdit || busy}
            onClick={() => void propose()}
          >
            <Sparkles size={15} aria-hidden="true" />
            {busy ? '正在读取仓库并生成…' : '分析仓库并生成建议'}
          </button>
        </div>
        <ErrorBanner error={error} />
        {proposal && (
          <div className="graph-fields graph-field-card">
            <p className="field-note">
              分析提交 <code>{proposal.commitSha}</code>
            </p>
            <details>
              <summary>读取的仓库文件</summary>
              <ul>
                {proposal.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </details>
            <ul className="graph-ai-steps">
              {proposal.canvas.nodes.map(({ id, name, build, shell, deploy, healthCheck }) => (
                <li key={id}>
                  <strong>{name}</strong>
                  {(build?.repoPath || shell?.directory) && (
                    <div>
                      <code>{build?.repoPath ?? shell?.directory}</code>
                    </div>
                  )}
                  {[
                    build?.installCommand,
                    build?.buildCommand,
                    build?.dockerfilePath,
                    shell?.command,
                    deploy?.stopCommand,
                    deploy?.startCommand,
                    healthCheck?.command,
                  ]
                    .filter(Boolean)
                    .map((command, index) => (
                      <pre key={index}>
                        <code>{command}</code>
                      </pre>
                    ))}
                </li>
              ))}
            </ul>
            {proposal.notes.map((note, index) => (
              <p className="field-note" key={index}>
                {note}
              </p>
            ))}
            <p className="field-note">核对命令和仓库版本后，可将建议加入为一条新执行流。</p>
            <div className="heading-actions">
              <button
                type="button"
                className="button primary small"
                disabled={!canEdit}
                onClick={apply}
              >
                添加到草稿
              </button>
              <button
                type="button"
                className="button secondary small"
                onClick={() => setResult(undefined)}
              >
                放弃建议
              </button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
