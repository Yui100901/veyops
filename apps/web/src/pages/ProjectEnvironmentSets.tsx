import { useState } from 'react';
import { Archive, Plus } from 'lucide-react';
import { ApiError, api, message, navigate, post, useResource } from '../api';
import { Empty, ErrorBanner, Loading, Section } from '../components';
import type { User } from '../models';
import { VariableEditor, type VariableSnapshot, type VariableWrite } from './EnvironmentVariables';
import { hiddenVariableValue } from './environment-dotenv';
import { projectResourcePath } from './project-workspace-route';

export type EnvironmentSetSummary = {
  id: string;
  name: string;
  description: string;
  revision: number;
  archivedAt: number | null;
};

type EnvironmentSet = EnvironmentSetSummary & VariableSnapshot<number>;
type CredentialOption = { id: string; name: string; type: string };

export function ProjectEnvironmentSets({
  projectId,
  environmentSetId,
  view,
  viewSearch,
  user,
  projectArchived = false,
}: {
  projectId: string;
  environmentSetId?: string;
  view?: string;
  viewSearch?: string;
  user: User;
  projectArchived?: boolean;
}) {
  const listPath = `/projects/${encodeURIComponent(projectId)}/environment-sets`;
  const list = useResource<EnvironmentSetSummary[]>(listPath);
  const canEdit = !projectArchived && user.role !== 'VIEWER';
  const isNew = environmentSetId === 'new' && canEdit;
  const selected = environmentSetId && environmentSetId !== 'new' ? environmentSetId : undefined;
  const selectedPath = selected ? `${listPath}/${encodeURIComponent(selected)}` : null;
  const details = useResource<EnvironmentSet>(selectedPath);
  const inherited = useResource<VariableSnapshot>(
    `/projects/${encodeURIComponent(projectId)}/variables`,
  );
  const credentials = useResource<CredentialOption[]>(
    user.role === 'ADMIN' && (selected || isNew) ? `${listPath}/credential-options` : null,
  );
  const resourcePath = (id?: string) =>
    projectResourcePath(projectId, {
      resource: 'environment-sets',
      environmentSetId: id,
      view,
      viewSearch,
    });
  const initial: EnvironmentSet | undefined = isNew
    ? { id: '', name: '', description: '', archivedAt: null, revision: 0, variables: [] }
    : details.data?.id === selected
      ? details.data
      : undefined;

  return (
    <Section
      title="变量集合"
      action={
        canEdit &&
        !isNew && (
          <a className="button secondary small" href={`#${resourcePath('new')}`}>
            <Plus size={16} /> 新建变量集合
          </a>
        )
      }
    >
      <ErrorBanner error={list.error} retry={list.reload} />
      {list.loading && <Loading />}
      {!!list.data?.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">集合</th>
                <th scope="col">说明</th>
                <th scope="col">修订</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((item) => (
                <tr key={item.id}>
                  <td>
                    <a
                      className="button secondary small"
                      href={`#${resourcePath(item.id)}`}
                      aria-current={selected === item.id ? 'page' : undefined}
                    >
                      {item.name}
                    </a>
                  </td>
                  <td>{item.description || '—'}</td>
                  <td>{item.revision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data?.length === 0 && !initial && (
        <Empty title="暂无变量集合" description="创建命名变量集合后，可在执行图的开始节点引用。" />
      )}
      <ErrorBanner error={selected ? details.error : undefined} retry={details.reload} />
      {selected && details.loading && <Loading />}
      {initial && (
        <EnvironmentSetEditor
          key={`${projectId}:${initial.id || 'new'}`}
          initial={initial}
          path={listPath}
          user={user}
          projectArchived={projectArchived}
          inherited={(inherited.data?.variables ?? []).map((row) => ({
            ...row,
            source: '项目公共变量',
          }))}
          credentials={credentials.data}
          onChanged={(id) => {
            void list.reload();
            if (id !== selected) navigate(resourcePath(id));
          }}
        />
      )}
      {initial && <ErrorBanner error={inherited.error} retry={inherited.reload} />}
      {initial && <ErrorBanner error={credentials.error} retry={credentials.reload} />}
    </Section>
  );
}

function EnvironmentSetEditor({
  initial,
  path,
  user,
  inherited,
  credentials,
  projectArchived,
  onChanged,
}: {
  initial: EnvironmentSet;
  path: string;
  user: User;
  inherited: (EnvironmentSet['variables'][number] & { source: string })[];
  credentials?: CredentialOption[];
  projectArchived: boolean;
  onChanged: (id?: string) => void;
}) {
  const [baseline, setBaseline] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [latest, setLatest] = useState<EnvironmentSet>();
  const [archiveState, setArchiveState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [archiveError, setArchiveError] = useState('');
  const [editorVersion, setEditorVersion] = useState(0);
  const detailPath = initial.id ? `${path}/${encodeURIComponent(initial.id)}` : '';
  const canEdit = user.role !== 'VIEWER' && !projectArchived && baseline.archivedAt === null;

  function resetFields(value: EnvironmentSet) {
    setBaseline(value);
    setName(value.name);
    setDescription(value.description);
    setLatest(undefined);
    setArchiveError('');
  }

  async function save(expectedRevision: number, variables: VariableWrite[]) {
    const fields = { name: name.trim(), description, variables };
    if (!fields.name) throw new Error('请输入变量集合名称。');
    try {
      const saved = await (initial.id
        ? api<EnvironmentSet>(detailPath, {
            method: 'PATCH',
            body: JSON.stringify({ ...fields, expectedRevision }),
          })
        : post<EnvironmentSet>(path, fields));
      resetFields(saved);
      onChanged(saved.id);
      return saved;
    } catch (error) {
      if (detailPath && error instanceof ApiError && error.status === 409) {
        const current = await api<EnvironmentSet>(detailPath).catch(() => undefined);
        setLatest(current);
      }
      throw error;
    }
  }

  async function archive() {
    setArchiveState('busy');
    setArchiveError('');
    try {
      await api(detailPath, {
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: baseline.revision }),
      });
      onChanged();
    } catch (error) {
      setArchiveError(message(error));
      if (error instanceof ApiError && error.status === 409)
        setLatest(await api<EnvironmentSet>(detailPath).catch(() => undefined));
    } finally {
      setArchiveState('idle');
    }
  }

  const comparison = latest && <EnvironmentSetComparison baseline={baseline} latest={latest} />;
  return (
    <VariableEditor
      key={editorVersion}
      initial={baseline}
      path={detailPath ? `${detailPath}/variables` : ''}
      user={user}
      editable={!projectArchived && baseline.archivedAt === null}
      inherited={inherited}
      credentialOptions={canEdit && user.role === 'ADMIN' ? credentials : undefined}
      metadata={(busy) => (
        <div className="environment-set-fields">
          <h3>{initial.id ? baseline.name : '新建变量集合'}</h3>
          {baseline.archivedAt !== null && <span className="tag">已归档</span>}
          <label>
            名称
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              disabled={busy || archiveState === 'busy'}
              readOnly={!canEdit}
              required
            />
          </label>
          <label>
            说明
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2000}
              rows={2}
              disabled={busy || archiveState === 'busy'}
              readOnly={!canEdit}
            />
          </label>
          {!!initial.id && canEdit && (
            <div className="heading-actions">
              {archiveState === 'idle' ? (
                <button
                  type="button"
                  className="button secondary small"
                  disabled={busy}
                  onClick={() => setArchiveState('confirm')}
                >
                  <Archive size={16} /> 归档集合
                </button>
              ) : (
                <>
                  <span className="muted">
                    归档后新运行无法使用此集合。已确认的运行保留原快照。
                  </span>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={busy || archiveState === 'busy'}
                    onClick={() => void archive()}
                  >
                    确认归档
                  </button>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={archiveState === 'busy'}
                    onClick={() => setArchiveState('idle')}
                  >
                    取消
                  </button>
                </>
              )}
            </div>
          )}
          <ErrorBanner error={archiveError} />
          {archiveError && comparison}
          {archiveError && latest && (
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={() => {
                resetFields(latest);
                setEditorVersion((version) => version + 1);
              }}
            >
              放弃草稿并加载当前修订
            </button>
          )}
        </div>
      )}
      persistence={{
        save,
        async reload() {
          const current = await api<EnvironmentSet>(detailPath);
          resetFields(current);
          return current;
        },
        discard: () => resetFields(baseline),
        conflict: comparison,
        saveLabel: '保存变量集合',
      }}
    />
  );
}

function EnvironmentSetComparison({
  baseline,
  latest,
}: {
  baseline: EnvironmentSet;
  latest: EnvironmentSet;
}) {
  const current = new Map(latest.variables.map((variable) => [variable.key, variable]));
  const previous = new Map(baseline.variables.map((variable) => [variable.key, variable]));
  const value = (item?: EnvironmentSet['variables'][number]) =>
    item ? (item.isSecret ? hiddenVariableValue : item.value || '（空值）') : '—';
  const keys = [...new Set([...previous.keys(), ...current.keys()])].sort();
  return (
    <details className="environment-variable-inheritance">
      <summary>
        比较原修订 {baseline.revision} 与当前修订 {latest.revision}
      </summary>
      <p>
        名称：{baseline.name} → {latest.name}
      </p>
      <p>
        说明：{baseline.description || '—'} → {latest.description || '—'}
      </p>
      {!!keys.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">变量</th>
                <th scope="col">原修订</th>
                <th scope="col">当前修订</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key}>
                  <td>
                    <code>{key}</code>
                  </td>
                  <td>{value(previous.get(key))}</td>
                  <td>{value(current.get(key))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
