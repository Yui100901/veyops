import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, formatTime, message, navigate, post, useResource } from '../api';
import { ErrorBanner, Form, Loading, Modal, RefreshButton, Section } from '../components';
import type { DeploymentRecord, ProjectDetail, Server, Task } from '../models';

interface RollbackPreview {
  confirmationHash: string;
  deploymentId: string;
  artifactId: string;
  sourceCommit: string;
  checksum?: string | null;
  imageDigest?: string | null;
  serviceId: string;
  environmentId: string;
  serverId: string;
  deployPath?: string;
  requireApproval?: boolean;
}

export function RollbackRelease({
  record,
  onClose,
}: {
  record: DeploymentRecord;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<RollbackPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const project = useResource<ProjectDetail>(
    record.projectId ? `/projects/${record.projectId}` : null,
  );
  const servers = useResource<Server[]>('/servers');
  const path = `/deployments/${record.id}/rollback`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (!preview) {
        const next = await post<RollbackPreview>(`${path}/preview`);
        setPreview(next);
        return;
      }
      const task = await post<Task>(path, { confirmationHash: preview.confirmationHash });
      onClose();
      navigate(`/tasks/${task.id}`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setPreview(undefined);
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const serviceId = preview?.serviceId ?? record.serviceId;
  const environmentId = preview?.environmentId ?? record.environmentId;
  const serverId = preview?.serverId ?? record.serverId;
  const service = project.data?.services.find((entry) => entry.id === serviceId);
  const environment = project.data?.environments.find((entry) => entry.id === environmentId);
  const server = servers.data?.find((entry) => entry.id === serverId);
  const digest = preview?.imageDigest || preview?.checksum;

  return (
    <Modal
      title="回滚到历史发布"
      description="使用该次发布的产物和配置执行部署。"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Form
        onSubmit={submit}
        onCancel={() => {
          if (!busy) onClose();
        }}
        submit={preview ? (preview.requireApproval ? '提交回滚审批' : '确认回滚') : '预览回滚'}
        busy={busy}
        error={error}
      >
        <div className="deployment-review">
          <span>历史发布</span>
          <code>{preview?.deploymentId || record.id}</code>
          <span>固定 Commit</span>
          <code>{preview?.sourceCommit || record.releaseVersion || '—'}</code>
          <span>服务</span>
          <strong>{service?.name || serviceId}</strong>
          <span>环境</span>
          <strong>{environment?.name || environmentId}</strong>
          <span>目标服务器</span>
          <strong>{server?.name || serverId}</strong>
          <span>部署目录</span>
          <code>{preview?.deployPath || record.deployPath || '—'}</code>
          {preview && (
            <>
              <span>产物</span>
              <code>{preview.artifactId}</code>
              {digest && (
                <>
                  <span>校验 / Digest</span>
                  <code>{digest}</code>
                </>
              )}
            </>
          )}
        </div>
        {preview?.requireApproval && <p className="field-note">管理员批准后开始回滚。</p>}
      </Form>
    </Modal>
  );
}

interface ReleaseApproval {
  id: string;
  name: string;
  serviceId: string | null;
  environmentId: string | null;
  createdAt: number;
  commitSha: string | null;
  serverIds: string[];
  artifactIds: string[];
  rollbackOfDeploymentId?: string | null;
}

export function ReleaseApprovals({ query = '' }: { query?: string }) {
  const approvals = useResource<ReleaseApproval[]>(`/deployments/approvals?${query}`);
  const [selected, setSelected] = useState<ReleaseApproval>();

  return (
    <>
      <Section title="待审批发布" action={<RefreshButton onClick={approvals.reload} />}>
        <ErrorBanner error={approvals.error} retry={approvals.reload} />
        {approvals.loading ? (
          <Loading />
        ) : approvals.data?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>固定 Commit</th>
                  <th>目标</th>
                  <th>提交时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {approvals.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <a className="text-link" href={`#/tasks/${entry.id}`}>
                        {entry.name}
                      </a>
                    </td>
                    <td className="mono" title={entry.commitSha ?? undefined}>
                      {entry.commitSha?.slice(0, 12) || '—'}
                    </td>
                    <td>{entry.serverIds.length} 台</td>
                    <td className="nowrap muted">{formatTime(entry.createdAt)}</td>
                    <td>
                      <button className="button secondary small" onClick={() => setSelected(entry)}>
                        审查发布
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="field-note">暂无待审批发布。</p>
        )}
      </Section>
      {selected && (
        <ReviewRelease
          approval={selected}
          onClose={() => setSelected(undefined)}
          onApproved={(task) => {
            setSelected(undefined);
            void approvals.reload();
            navigate(`/tasks/${task.id}`);
          }}
        />
      )}
    </>
  );
}

function ReviewRelease({
  approval,
  onClose,
  onApproved,
}: {
  approval: ReleaseApproval;
  onClose: () => void;
  onApproved: (task: Task) => void;
}) {
  const servers = useResource<Server[]>('/servers');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onApproved(await post<Task>(`/deployments/approvals/${approval.id}/approve`));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`审批 · ${approval.name}`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Form
        onSubmit={submit}
        onCancel={() => {
          if (!busy) onClose();
        }}
        submit="批准发布"
        busy={busy}
        error={error}
      >
        <div className="deployment-review">
          <span>固定 Commit</span>
          <code>{approval.commitSha || '—'}</code>
          <span>服务</span>
          <code>{approval.serviceId || '—'}</code>
          <span>环境</span>
          <code>{approval.environmentId || '—'}</code>
          <span>目标服务器</span>
          <strong>
            {approval.serverIds
              .map((id) => servers.data?.find((entry) => entry.id === id)?.name || id)
              .join('、')}
          </strong>
          <span>产物</span>
          <code>{approval.artifactIds.join('、')}</code>
          {approval.rollbackOfDeploymentId && (
            <>
              <span>历史发布</span>
              <code>{approval.rollbackOfDeploymentId}</code>
            </>
          )}
        </div>
      </Form>
    </Modal>
  );
}
