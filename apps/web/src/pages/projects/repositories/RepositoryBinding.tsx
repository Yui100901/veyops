import { InlineEditor } from '../../../InlineEditor';
import { useEffect, useState, type FormEvent } from 'react';
import { Check } from 'lucide-react';
import { api, message, useResource } from '../../../api';
import { ErrorBanner, Field, Form } from '../../../components';
import type { ProjectDetail } from '../../../models';

export function RepositoryBinding({
  project,
  serviceId,
  onClose,
}: {
  project: ProjectDetail;
  serviceId: string;
  onClose: () => void;
}) {
  const existing = useResource<{ repositoryId: string; repoPath: string; isPrimary: boolean }[]>(
    `/services/${serviceId}/repositories`,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (existing.data) {
      const ordered = [...existing.data].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      setSelected(ordered.map((r) => r.repositoryId));
      setPaths(Object.fromEntries(ordered.map((r) => [r.repositoryId, r.repoPath])));
    }
  }, [existing.data]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/services/${serviceId}/repositories`, {
        method: 'PUT',
        body: JSON.stringify({
          repositories: selected.map((id, i) => ({
            repositoryId: id,
            repoPath: paths[id] || '.',
            isPrimary: i === 0,
          })),
        }),
      });
      onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor
      busy={busy}
      title="设置服务仓库关联"
      description="保存将替换该服务的仓库关联。第一个选中的仓库作为主仓库。"
      onClose={onClose}
    >
      <Form
        onSubmit={save}
        onCancel={onClose}
        error={error}
        busy={busy || existing.loading || !!existing.error}
      >
        <ErrorBanner error={existing.error} retry={existing.reload} />
        {project.repositories.map((r) => (
          <div className="repository-binding" key={r.id}>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id),
                  )
                }
              />
              {r.name}
              {selected[0] === r.id && (
                <span className="tag">
                  <Check size={11} />
                  主仓库
                </span>
              )}
            </label>
            {selected.includes(r.id) && (
              <Field label={`${r.name} 子目录`}>
                <input
                  value={paths[r.id] || '.'}
                  onChange={(e) => setPaths((v) => ({ ...v, [r.id]: e.target.value }))}
                />
              </Field>
            )}
          </div>
        ))}
        {!project.repositories.length && <p className="muted">请先在项目中添加仓库。</p>}
      </Form>
    </InlineEditor>
  );
}
