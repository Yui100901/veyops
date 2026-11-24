import { useState, type FormEvent } from 'react';
import { api, message, post, useResource } from '../../../api';
import { ErrorBanner, Field, Form, Modal } from '../../../components';
import { InlineEditor } from '../../../InlineEditor';
import type { Credential, Repository, User } from '../../../models';

export function ProjectRepositoryEditor({
  projectId,
  role,
  repository,
  initialUrl,
  modal = false,
  onClose,
  onSaved,
}: {
  projectId: string;
  role: User['role'];
  repository?: Repository;
  initialUrl?: string;
  modal?: boolean;
  onClose: () => void;
  onSaved: (repository: Repository) => void | Promise<void>;
}) {
  const canChooseCredential = role === 'ADMIN';
  const credentials = useResource<Credential[]>(canChooseCredential ? '/credentials' : null);
  const gitCredentials = credentials.data?.filter(
    ({ type, status }) => (type === 'GIT_TOKEN' || type === 'GIT_PASSWORD') && status === 'ACTIVE',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (modal) event.stopPropagation();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const payload = {
      name: text('name'),
      description: text('description'),
      cloneUrl: text('cloneUrl'),
      provider: text('provider'),
      ...(canChooseCredential && { credentialId: text('credentialId') || null }),
    };
    setBusy(true);
    setError('');
    const path = `/projects/${projectId}/repositories`;
    try {
      const saved = repository
        ? await api<Repository>(`${path}/${repository.id}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          })
        : await post<Repository>(path, payload);
      await onSaved(saved);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
  const Editor = modal ? Modal : InlineEditor;
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Editor title={repository ? '编辑仓库' : '添加仓库'} onClose={close} {...(!modal && { busy })}>
      <Form
        onSubmit={save}
        error={error}
        busy={busy}
        submit={repository ? '保存' : '添加仓库'}
        onCancel={close}
      >
        <Field label="名称" required>
          <input name="name" required autoFocus defaultValue={repository?.name} maxLength={100} />
        </Field>
        <Field label="Git 仓库地址" required hint="使用仓库的 HTTP(S) 克隆地址。">
          <input
            name="cloneUrl"
            placeholder="https://github.com/team/repository.git"
            type="url"
            pattern="https?://.+"
            defaultValue={repository?.cloneUrl ?? initialUrl}
            required
          />
        </Field>
        {canChooseCredential && (
          <>
            <Field label="Git 认证凭据（可选）">
              <select name="credentialId" defaultValue={repository?.credentialId ?? ''}>
                <option value="">公开仓库，无需认证</option>
                {repository?.credentialId &&
                  !gitCredentials?.some(({ id }) => id === repository.credentialId) && (
                    <option value={repository.credentialId}>保留当前凭据</option>
                  )}
                {gitCredentials?.map(({ id, name }) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <ErrorBanner error={credentials.error} retry={credentials.reload} />
          </>
        )}
        <Field label="代码托管平台">
          <select name="provider" defaultValue={repository?.provider ?? 'CUSTOM'}>
            <option value="CUSTOM">自建或其他</option>
            <option value="GITHUB">GitHub</option>
            <option value="GITLAB">GitLab</option>
            <option value="GITEA">Gitea</option>
            <option value="BITBUCKET">Bitbucket</option>
          </select>
        </Field>
        <Field label="说明">
          <textarea
            name="description"
            defaultValue={repository?.description}
            maxLength={2000}
            rows={2}
          />
        </Field>
        <p className="field-note">保存后会读取远端默认分支、分支列表和最新提交。</p>
      </Form>
    </Editor>
  );
}
