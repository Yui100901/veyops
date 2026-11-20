import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, formatTime, message, post, useResource } from '../api';
import { ErrorBanner, Field, Form, Loading } from '../components';
import type { User } from '../models';

type Source = 'ARCHIVE' | 'SERVICE_ENVIRONMENT';
type Revision = {
  id: string;
  version: number;
  source: Source;
  path?: string;
  checksum?: string;
  createdAt: number;
};
type History = { revision: number; versions: Revision[] };
const starter = 'services:\n  app:\n    image: ${VEYOPS_IMAGE}\n';

export function ComposeTemplates({
  serviceId,
  environmentId,
  user,
}: {
  serviceId: string;
  environmentId: string;
  user: User;
}) {
  const path = `/services/${serviceId}/environments/${environmentId}/compose-templates`;
  const history = useResource<History>(path);
  const [draft, setDraft] = useState<{ revision: number; source: Source; content: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canEdit = user.role !== 'VIEWER';
  const current = history.data?.versions[0];

  async function edit(source: Source, template?: Revision) {
    if (!history.data) return;
    const revision = history.data.revision;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const content =
        source === 'ARCHIVE'
          ? ''
          : template
            ? (await api<{ content: string }>(`${path}/${template.id}`)).content
            : starter;
      setDraft({ revision, source, content });
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const saved = await post<Revision>(path, {
        expectedVersion: draft.revision,
        source: draft.source,
        ...(draft.source === 'SERVICE_ENVIRONMENT' && { content: draft.content }),
      });
      setDraft(undefined);
      setNotice(`版本 ${saved.version} 已生效。`);
      await history.reload();
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof ApiError && cause.status === 409) await history.reload();
    } finally {
      setBusy(false);
    }
  }

  if (history.loading) return <Loading />;
  if (history.error) return <ErrorBanner error={history.error} retry={history.reload} />;
  const changed = draft && draft.revision !== history.data?.revision;
  return (
    <div className="form-body">
      <div className="deployment-review">
        <span>生效来源</span>
        <strong>
          {current?.source === 'SERVICE_ENVIRONMENT'
            ? `服务环境模板 v${current.version}`
            : '构建产物中的 Compose 文件'}
        </strong>
        {current?.checksum && (
          <>
            <span>模板摘要</span>
            <code>{current.checksum}</code>
          </>
        )}
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && !draft && <ErrorBanner error={error} />}
      {canEdit && !draft && (
        <div className="row-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() =>
              void edit(
                'SERVICE_ENVIRONMENT',
                current?.source === 'SERVICE_ENVIRONMENT' ? current : undefined,
              )
            }
          >
            {current?.source === 'SERVICE_ENVIRONMENT' ? '编辑模板' : '创建服务环境模板'}
          </button>
          {current?.source === 'SERVICE_ENVIRONMENT' && (
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => void edit('ARCHIVE')}
            >
              改用产物归档
            </button>
          )}
        </div>
      )}
      {draft && (
        <Form
          onSubmit={save}
          onCancel={() => {
            setDraft(undefined);
            setError('');
          }}
          submit={draft.source === 'ARCHIVE' ? '确认改用产物归档' : '保存并启用模板'}
          busy={busy}
          submitDisabled={Boolean(changed)}
          error={error}
        >
          {changed && (
            <p className="field-note">
              生效版本已变化。请保留需要的内容，取消后从版本列表重新打开。
            </p>
          )}
          {draft.source === 'SERVICE_ENVIRONMENT' ? (
            <Field
              label="compose.yaml"
              hint="使用 ${VEYOPS_IMAGE} 引用发布镜像，通过环境变量引用敏感值。"
            >
              <textarea
                className="mono"
                rows={12}
                value={draft.content}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                spellCheck={false}
                required
              />
            </Field>
          ) : (
            <p className="field-note">后续发布将使用所选镜像产物归档中的 Compose 文件。</p>
          )}
        </Form>
      )}
      {Boolean(history.data?.versions.length) && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>版本</th>
                <th>来源</th>
                <th>摘要</th>
                <th>生效时间</th>
                {canEdit && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {history.data?.versions.map((revision) => (
                <tr key={revision.id}>
                  <td>v{revision.version}</td>
                  <td>{revision.source === 'SERVICE_ENVIRONMENT' ? revision.path : '产物归档'}</td>
                  <td>
                    <code title={revision.checksum}>{revision.checksum?.slice(0, 12) || '—'}</code>
                  </td>
                  <td>{formatTime(revision.createdAt)}</td>
                  {canEdit && (
                    <td>
                      {revision.id !== current?.id && revision.source === 'SERVICE_ENVIRONMENT' && (
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={busy || Boolean(draft)}
                          onClick={() => void edit('SERVICE_ENVIRONMENT', revision)}
                        >
                          加载为新版本
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
