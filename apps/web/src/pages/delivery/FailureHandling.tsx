import { useState, type FormEvent } from 'react';
import { api, formatTime, message, post, useResource } from '../../api';
import { ErrorBanner, Field, Loading, Modal, Section } from '../../components';
import type { User } from '../../models';
import { ProposalPreview, type Proposal } from '../ai/AI';

const components = { docker: 'Docker', compose: 'Docker Compose', node: 'Node.js', nginx: 'Nginx' };
const statuses = {
  PENDING: '等待诊断',
  DIAGNOSING: '诊断中',
  ADVICE: '已给出建议',
  AWAITING_APPROVAL: '等待步骤审批',
  REPAIRING: '正在修复',
  VERIFIED: '已验证修复',
  MANUAL: '需人工处理',
};
type Settings = { enabled: boolean; component: keyof typeof components | null };
type Incident = {
  taskId: string;
  status: keyof typeof statuses;
  summary: string;
  findings: { code: string; suggestion: string }[];
  proposalId: string | null;
  repairTaskId: string | null;
  createdAt: number;
  updatedAt: number;
  canApprove: boolean;
  canReject?: boolean;
};

export function FailureHandling({
  user,
  serviceId,
  environmentId,
  taskId,
}: {
  user: User;
  serviceId: string;
  environmentId: string;
  taskId?: string;
}) {
  const path = `/ai/services/${serviceId}/environments/${environmentId}/failure-handling`;
  const resource = useResource<Settings & { incidents: Incident[] }>(
    taskId ? `${path}?taskId=${encodeURIComponent(taskId)}` : path,
    5000,
  );
  const [draft, setDraft] = useState<Settings>();
  const [reviewId, setReviewId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const value = draft ?? resource.data;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy || user.role !== 'ADMIN') return;
    setBusy(true);
    setError('');
    try {
      await api(path, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: draft.enabled, component: draft.component }),
      });
      await resource.reload();
      setDraft(undefined);
      setSaved(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const incidents = resource.data?.incidents.filter((item) => !taskId || item.taskId === taskId);
  return (
    <Section title="AI 故障处理">
      <div className="section-body">
        <ErrorBanner error={error || resource.error} retry={resource.reload} />
        {resource.loading && <Loading />}
        {value && !taskId && (
          <form onSubmit={save} onChange={() => setSaved(false)}>
            <fieldset disabled={user.role !== 'ADMIN' || busy}>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={value.enabled}
                  onChange={(event) =>
                    setDraft({ enabled: event.target.checked, component: value.component })
                  }
                />
                构建或部署失败后自动诊断
              </label>
              <Field
                label="允许修复的组件"
                hint="每次故障最多执行一个匹配的内置修复步骤，并遵循当前项目的 AI 权限。"
              >
                <select
                  value={value.component ?? ''}
                  disabled={!value.enabled}
                  onChange={(event) =>
                    setDraft({
                      enabled: value.enabled,
                      component: (event.target.value as keyof typeof components) || null,
                    })
                  }
                >
                  <option value="">仅诊断并给出建议</option>
                  {Object.entries(components).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
              {user.role === 'ADMIN' && (
                <button className="button secondary small" disabled={!draft || busy}>
                  保存故障处理设置
                </button>
              )}
              {saved && (
                <span className="success-text" role="status">
                  已保存
                </span>
              )}
            </fieldset>
          </form>
        )}
        {incidents &&
          (incidents.length ? (
            incidents.map((item) => (
              <article key={item.taskId} className="ai-draft-card">
                <div>
                  <strong>{statuses[item.status] ?? item.status}</strong>
                  <small>{formatTime(item.updatedAt)}</small>
                </div>
                {item.summary && <p>{item.summary}</p>}
                {!!item.findings.length && (
                  <ul>
                    {item.findings.map((finding, index) => (
                      <li key={index}>
                        {finding.suggestion} <code>{finding.code}</code>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="row-actions">
                  {!taskId && (
                    <a className="text-link" href={`#/tasks/${item.taskId}`}>
                      查看失败任务
                    </a>
                  )}
                  {item.repairTaskId && (
                    <a className="text-link" href={`#/tasks/${item.repairTaskId}`}>
                      修复任务与验证日志
                    </a>
                  )}
                  {(item.canReject || (item.canApprove && user.role !== 'VIEWER')) &&
                    item.status === 'AWAITING_APPROVAL' &&
                    item.proposalId && (
                      <button
                        type="button"
                        className="button secondary small"
                        onClick={() => setReviewId(item.proposalId!)}
                      >
                        审阅修复步骤
                      </button>
                    )}
                </div>
              </article>
            ))
          ) : (
            <p className="field-note">
              {taskId ? '该任务暂无自动诊断记录。' : '此服务环境暂无故障处理记录。'}
            </p>
          ))}
      </div>
      {reviewId && (
        <RepairApproval
          id={reviewId}
          canApprove={
            user.role !== 'VIEWER' &&
            Boolean(incidents?.find((item) => item.proposalId === reviewId)?.canApprove)
          }
          onClose={() => setReviewId('')}
          onDecided={() => {
            setReviewId('');
            void resource.reload();
          }}
        />
      )}
    </Section>
  );
}

function RepairApproval({
  id,
  canApprove,
  onClose,
  onDecided,
}: {
  id: string;
  canApprove: boolean;
  onClose: () => void;
  onDecided: () => void;
}) {
  const proposals = useResource<Proposal[]>('/ai/proposals', 5000);
  const proposal = proposals.data?.find((item) => item.id === id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = proposal?.status === 'PENDING' && proposal.expiresAt > Date.now();
  async function decide(action: 'confirm' | 'reject') {
    if (!pending || busy || (action === 'confirm' && (!canApprove || proposal?.scopeRevoked)))
      return;
    setBusy(true);
    setError('');
    try {
      await post(`/ai/proposals/${id}/${action}`);
      onDecided();
    } catch (err) {
      setError(message(err));
      await proposals.reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="审阅修复步骤"
      wide
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="form-body">
        <ErrorBanner error={error || proposals.error} retry={proposals.reload} />
        {proposals.loading && <Loading />}
        {proposal && (
          <>
            <p className="field-note">此步骤有效至 {formatTime(proposal.expiresAt)}</p>
            <ProposalPreview proposal={proposal} servers={[]} />
          </>
        )}
        {proposals.data && !pending && <p className="field-note">该提案已不可审批。</p>}
      </div>
      <div className="modal-footer">
        <button
          className="button secondary"
          disabled={busy || !pending}
          onClick={() => void decide('reject')}
        >
          拒绝此步骤
        </button>
        <button
          className="button primary"
          disabled={busy || !pending || !canApprove || proposal?.scopeRevoked}
          onClick={() => void decide('confirm')}
        >
          批准此步骤
        </button>
      </div>
    </Modal>
  );
}
