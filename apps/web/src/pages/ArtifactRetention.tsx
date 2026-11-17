import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, formatTime, message, post, remove, useResource } from '../api';
import { ErrorBanner, Field, Form, Loading, Modal } from '../components';

interface RetentionPolicy {
  maxBuilds: number;
  maxDays: number;
  inherited: boolean;
}

interface RetentionScope {
  serviceId: string;
  environmentId: string;
}

export function ArtifactRetentionPolicy({
  scope,
  onClose,
}: {
  scope?: RetentionScope;
  onClose: () => void;
}) {
  const path = scope
    ? `/artifact-retention/policy?${new URLSearchParams({ ...scope })}`
    : '/artifact-retention/policy';
  const policy = useResource<RetentionPolicy>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api<RetentionPolicy>(path, {
        method: 'PUT',
        body: JSON.stringify({
          maxBuilds: Number(data.get('maxBuilds')),
          maxDays: Number(data.get('maxDays')),
        }),
      });
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function inherit() {
    setBusy(true);
    setError('');
    try {
      await remove(path);
      await policy.reload();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={scope ? '环境产物保留策略' : '系统产物保留策略'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {policy.data ? (
        <Form
          key={`${policy.data.maxBuilds}:${policy.data.maxDays}:${policy.data.inherited}`}
          onSubmit={save}
          onCancel={onClose}
          busy={busy}
          error={error}
        >
          <div className="form-grid">
            <Field label="保留成功构建数" required>
              <input
                name="maxBuilds"
                type="number"
                min={1}
                max={1000}
                defaultValue={policy.data.maxBuilds}
                required
              />
            </Field>
            <Field label="保留天数" required>
              <input
                name="maxDays"
                type="number"
                min={1}
                max={3650}
                defaultValue={policy.data.maxDays}
                required
              />
            </Field>
          </div>
          <p className="field-note">
            超过任一限制的归档进入清理候选。当前运行版本、回滚基线及已固定产物优先保留。
          </p>
          {scope &&
            (policy.data.inherited ? (
              <p className="field-note">当前继承系统策略。保存后应用于此服务环境。</p>
            ) : (
              <button
                className="button secondary small"
                type="button"
                disabled={busy}
                onClick={inherit}
              >
                恢复继承系统策略
              </button>
            ))}
        </Form>
      ) : (
        <div className="form-body">
          <ErrorBanner error={policy.error} retry={policy.reload} />
          {policy.loading && <Loading />}
        </div>
      )}
    </Modal>
  );
}

interface CleanupCandidate {
  artifactIds: [string, ...string[]];
  createdAt: number;
  sizeBytes: number | null;
}

interface CleanupResult {
  pruned: string[];
  failed: string[];
  skipped: string[];
}

export function ArtifactCleanup({
  onClose,
  onPruned,
}: {
  onClose: () => void;
  onPruned: () => void;
}) {
  const preview = useResource<{ total: number; candidates: CleanupCandidate[] }>(
    '/artifact-retention/preview',
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<CleanupResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function prune(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!selected.length) {
      setError('请勾选需要清理的归档。');
      return;
    }
    setBusy(true);
    setResult(undefined);
    setError('');
    try {
      setResult(
        await post<CleanupResult>('/artifact-retention/prune', {
          artifactIds: selected,
          confirmed: true,
        }),
      );
      setSelected([]);
      onPruned();
      await preview.reload();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const candidates = preview.data?.candidates ?? [];
  return (
    <Modal
      title="清理产物预览"
      description="勾选的归档将在执行时重新检查保护规则。归档清理后保留历史记录。"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <Form
        onSubmit={prune}
        onCancel={onClose}
        busy={busy}
        submit={`清理所选归档（${selected.length}）`}
        error={error}
      >
        <ErrorBanner error={preview.error} retry={preview.reload} />
        {result && (
          <p className="field-note" role="status">
            已清理 {result.pruned.length} 条产物记录，跳过 {result.skipped.length} 条，失败{' '}
            {result.failed.length} 条。
          </p>
        )}
        {preview.loading ? (
          <Loading />
        ) : preview.data && candidates.length > 0 ? (
          <>
            <p className="field-note">
              清理候选 {preview.data.total} 组，本次显示 {candidates.length} 组。
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>产物记录</th>
                    <th>归档时间</th>
                    <th>大小</th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((candidate) => {
                    const id = candidate.artifactIds[0];
                    return (
                      <tr key={id}>
                        <td>
                          <input
                            aria-label={`清理归档 ${id.slice(0, 8)}`}
                            type="checkbox"
                            checked={selected.includes(id)}
                            disabled={busy}
                            onChange={(event) =>
                              setSelected(
                                event.target.checked
                                  ? [...selected, id]
                                  : selected.filter((value) => value !== id),
                              )
                            }
                          />
                        </td>
                        <td className="mono" title={candidate.artifactIds.join('、')}>
                          {id.slice(0, 8)}
                          {candidate.artifactIds.length > 1 &&
                            ` 等 ${candidate.artifactIds.length} 条`}
                        </td>
                        <td>{formatTime(candidate.createdAt)}</td>
                        <td>
                          {candidate.sizeBytes == null
                            ? '—'
                            : `${(candidate.sizeBytes / 1024).toFixed(1)} KiB`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          preview.data && <p className="field-note">暂无可清理的归档。</p>
        )}
      </Form>
    </Modal>
  );
}
