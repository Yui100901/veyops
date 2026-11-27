import { useContext, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api, message, post, useResource } from '../../../api';
import { ErrorBanner, Field } from '../../../components';
import type { ProjectDetail, Server, Service } from '../../../models';
import type { GraphFlowExpansion } from '../execution-graph-definition';
import { GraphResourceContext } from '../graph-resource-context';
import type { SimplifiedGitRef } from '../simplified-flow';
import { GraphFieldValue, useProjectEnvironmentSets } from './ExecutionGraphFields';

type ProposedService = Pick<Service, 'id' | 'name' | 'slug' | 'serviceType'> & {
  ports: { port: number; protocol: 'http' | 'https'; file: string }[];
};
type Proposal = GraphFlowExpansion & {
  commitSha: string;
  notes: string[];
  files: string[];
  proposedService?: ProposedService;
};

export function ExecutionGraphAiDraft({
  project,
  canEdit,
  insert,
}: {
  project: ProjectDetail;
  canEdit: boolean;
  insert: (proposal: GraphFlowExpansion) => void;
}) {
  const resources = useContext(GraphResourceContext);
  const [open, setOpen] = useState(false);
  const [repositoryId, setRepository] = useState('');
  const [ref, setRef] = useState<SimplifiedGitRef>();
  const [serviceMode, setServiceMode] = useState('');
  const [environmentSetId, setEnvironmentSet] = useState('');
  const [serverIds, setServers] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');
  const [proposal, setProposal] = useState<Proposal>();
  const [createdService, setCreatedService] = useState<Service>();
  const [includeAddresses, setIncludeAddresses] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const serverResource = useResource<Server[]>(open ? '/servers' : null);
  const environmentSets = useProjectEnvironmentSets(project.id, open);
  const selected = project.repositories.some(({ id }) => id === repositoryId);
  const locked = busy || applying || !canEdit;

  useEffect(() => () => pending.current?.abort(), []);

  function resetProposal() {
    setProposal(undefined);
    setCreatedService(undefined);
    setError('');
  }

  async function propose() {
    if (locked || !selected || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    resetProposal();
    try {
      const result = await api<Proposal>(`/projects/${project.id}/execution-graph/ai-draft`, {
        method: 'POST',
        body: JSON.stringify({
          repositoryId,
          ref,
          environmentSetId: environmentSetId || undefined,
          serverIds,
          serviceId: serviceMode && serviceMode !== 'new' ? serviceMode : undefined,
          suggestService: serviceMode === 'new',
          instructions: instructions.trim() || undefined,
        }),
        signal: controller.signal,
      });
      setProposal(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      pending.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function apply() {
    if (locked || !proposal) return;
    const suggestion = proposal.proposedService;
    let service = createdService;
    setApplying(true);
    setError('');
    try {
      if (suggestion && !service) {
        const { name, slug, serviceType, ports } = suggestion;
        service = await post<Service>(`/projects/${project.id}/services`, {
          name,
          slug,
          serviceType,
          addresses: includeAddresses
            ? serverIds.flatMap((serverId) =>
                ports.map(({ port, protocol }) => ({
                  name: `${serverResource.data?.find(({ id }) => id === serverId)?.name ?? '服务器'} · ${port}`.slice(
                    0,
                    100,
                  ),
                  binding: { serverId, port, protocol },
                })),
              )
            : [],
        });
        setCreatedService(service);
        void resources?.reload();
      }
      const nodes = proposal.canvas.nodes.map((node) => {
        if (!service || !node.start?.release || node.start.release.serviceId !== suggestion?.id)
          return node;
        return {
          ...node,
          start: { ...node.start, release: { ...node.start.release, serviceId: service.id } },
        };
      });
      insert({ startId: proposal.startId, canvas: { ...proposal.canvas, nodes } });
      resetProposal();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setApplying(false);
    }
  }

  return (
    <details className="graph-field-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>AI 辅助编排</summary>
      <div className="graph-fields">
        <div className="form-grid">
          <Field label="项目仓库" required>
            <select
              disabled={locked}
              value={repositoryId}
              onChange={(event) => {
                setRepository(event.target.value);
                setRef(undefined);
                resetProposal();
              }}
            >
              <option value="">选择仓库</option>
              {project.repositories.map(({ id, name }) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          {selected && (
            <GraphFieldValue
              project={project}
              field={{ id: 'git-ref', name: 'Git 版本', type: 'GIT_REF' }}
              value={ref}
              change={(value) => {
                setRef(value as SimplifiedGitRef | undefined);
                resetProposal();
              }}
              disabled={locked}
              scope={{ repositoryId }}
              useRepositoryDefault
            />
          )}
          <Field label="服务关联">
            <select
              disabled={locked}
              value={serviceMode}
              onChange={(event) => {
                setServiceMode(event.target.value);
                resetProposal();
              }}
            >
              <option value="">仅编排构建</option>
              <option value="new">建议新增服务</option>
              {project.services.map(({ id, name }) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="环境变量集（可选）">
            <select
              disabled={locked}
              value={environmentSetId}
              onChange={(event) => {
                setEnvironmentSet(event.target.value);
                resetProposal();
              }}
            >
              <option value="">无</option>
              {environmentSets.data?.map(({ id, name }) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {serverResource.data?.length ? (
          <details>
            <summary>附加服务器信息{serverIds.length ? `（${serverIds.length} 台）` : ''}</summary>
            <p className="field-note">用于编排参考。发布草稿后，运行时仍可独立选择执行目标。</p>
            <div className="form-grid">
              {serverResource.data.map(({ id, name, osType }) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={serverIds.includes(id)}
                    disabled={locked || (serverIds.length >= 20 && !serverIds.includes(id))}
                    onChange={(event) => {
                      setServers(
                        event.target.checked
                          ? [...serverIds, id]
                          : serverIds.filter((item) => item !== id),
                      );
                      resetProposal();
                    }}
                  />{' '}
                  {name}
                  {osType ? ` · ${osType}` : ''}
                </label>
              ))}
            </div>
          </details>
        ) : null}
        <ErrorBanner error={serverResource.error || environmentSets.error} />
        <Field label="编排要求（可选）">
          <textarea
            rows={3}
            maxLength={1500}
            value={instructions}
            disabled={locked}
            onChange={(event) => {
              setInstructions(event.target.value);
              resetProposal();
            }}
          />
        </Field>
        <div className="heading-actions">
          <button
            type="button"
            className="button secondary small"
            disabled={!selected || locked}
            onClick={() => void propose()}
          >
            <Sparkles size={15} aria-hidden="true" />
            {busy ? '正在分析仓库…' : '分析仓库并生成建议'}
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
            {proposal.proposedService && (
              <div className="graph-fields">
                <strong>
                  {createdService ? '已创建服务' : '建议新增服务'} · {proposal.proposedService.name}{' '}
                  · {proposal.proposedService.slug}
                </strong>
                {proposal.proposedService.ports.map(({ port, protocol, file }) => (
                  <p className="field-note" key={`${protocol}:${port}`}>
                    {protocol.toUpperCase()} / {port} · <code>{file}</code>
                  </p>
                ))}
                {serverIds.length > 0 &&
                  proposal.proposedService.ports.length > 0 &&
                  !createdService && (
                    <label>
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={includeAddresses}
                        onChange={(event) => setIncludeAddresses(event.target.checked)}
                      />{' '}
                      使用附加服务器和识别到的端口生成访问地址
                    </label>
                  )}
              </div>
            )}
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
            <div className="heading-actions">
              <button
                type="button"
                className="button primary small"
                disabled={locked}
                onClick={() => void apply()}
              >
                {proposal.proposedService && !createdService ? '创建服务并加入草稿' : '添加到草稿'}
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={locked}
                onClick={resetProposal}
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
