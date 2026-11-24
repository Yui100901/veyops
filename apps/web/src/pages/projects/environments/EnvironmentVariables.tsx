import { useRef, useState, type ReactNode } from 'react';
import { Download, Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { ApiError, api, message, post, useResource } from '../../../api';
import { ErrorBanner, Loading } from '../../../components';
import type { User } from '../../../models';
import {
  formatVariables,
  hiddenVariableValue,
  parseVariables,
  variableDraftError,
  type VariableDraft,
} from './environment-dotenv';
import './environment-variables.css';

export type StoredVariable = {
  id: string;
  key: string;
  value: string | null;
  isSecret: boolean;
  description?: string;
  secretSource?: 'VALUE' | 'CREDENTIAL';
};

export type VariableSnapshot<Revision extends string | number = string> = {
  revision: Revision;
  variables: StoredVariable[];
};

export type VariableWrite = {
  key: string;
  isSecret: boolean;
  description: string;
} & ({ value: string } | { credentialId: string } | { keepSecret: true });

function toDraft(rows: StoredVariable[]): VariableDraft[] {
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    value: row.isSecret ? undefined : (row.value ?? ''),
    isSecret: row.isSecret,
    description: row.description ?? '',
    storedKey: row.isSecret ? row.key : undefined,
    secretSource: row.secretSource,
  }));
}

export function EnvironmentVariables({
  projectId,
  environmentId,
  serviceId,
  user,
  editable = true,
}: {
  projectId: string;
  environmentId?: string;
  serviceId?: string;
  user: User;
  editable?: boolean;
}) {
  const projectPath = `/projects/${encodeURIComponent(projectId)}/variables`;
  const path = environmentId
    ? `${serviceId ? `/services/${encodeURIComponent(serviceId)}` : ''}/environments/${encodeURIComponent(environmentId)}/variables`
    : projectPath;
  const local = useResource<VariableSnapshot>(path);
  const projectVariables = useResource<VariableSnapshot>(environmentId ? projectPath : null);
  const environmentVariables = useResource<VariableSnapshot>(
    serviceId && environmentId
      ? `/environments/${encodeURIComponent(environmentId)}/variables`
      : null,
  );
  const inherited = new Map(
    (projectVariables.data?.variables ?? []).map((row) => [
      row.key,
      { ...row, source: '项目公共变量' },
    ]),
  );
  for (const row of environmentVariables.data?.variables ?? [])
    inherited.set(row.key, { ...row, source: '环境变量' });
  return (
    <>
      <ErrorBanner error={local.error} retry={local.reload} />
      {local.loading && <Loading />}
      {local.data && (
        <VariableEditor
          key={path}
          path={path}
          initial={local.data}
          inherited={[...inherited.values()].sort((left, right) =>
            left.key.localeCompare(right.key),
          )}
          user={user}
          editable={editable}
        />
      )}
      <ErrorBanner error={projectVariables.error} retry={projectVariables.reload} />
      <ErrorBanner error={environmentVariables.error} retry={environmentVariables.reload} />
    </>
  );
}

export function VariableEditor<Revision extends string | number = string>({
  path,
  initial,
  inherited,
  user,
  metadata,
  persistence,
  editable = true,
  credentialOptions,
}: {
  path: string;
  initial: VariableSnapshot<Revision>;
  inherited?: (StoredVariable & { source: string })[];
  user: User;
  metadata?: (busy: boolean) => ReactNode;
  persistence?: {
    save: (revision: Revision, variables: VariableWrite[]) => Promise<VariableSnapshot<Revision>>;
    reload: () => Promise<VariableSnapshot<Revision>>;
    discard: () => void;
    conflict?: ReactNode;
    saveLabel?: string;
  };
  editable?: boolean;
  credentialOptions?: ReadonlyArray<{ id: string; name: string }>;
}) {
  const [revision, setRevision] = useState(initial.revision);
  const [baseline, setBaseline] = useState(() => toDraft(initial.variables));
  const [rows, setRows] = useState(baseline);
  const [mode, setMode] = useState<'table' | 'text'>('table');
  const [text, setText] = useState('');
  const [rowSecrets, setRowSecrets] = useState(new Map<string, string>());
  const [textSecrets, setTextSecrets] = useState<Map<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const rowNumber = useRef(0);
  const canEdit = user.role !== 'VIEWER' && editable;
  const canReveal = user.role === 'ADMIN' && editable && !!path;

  function edit(next: VariableDraft[]) {
    setRows(next);
    setError('');
    setSaved(false);
  }

  function update(row: VariableDraft, changes: Partial<VariableDraft>) {
    if (rowSecrets.has(row.id)) setRowSecrets((current) => withoutSecret(current, row.id));
    edit(rows.map((item) => (item.id === row.id ? { ...item, ...changes } : item)));
  }

  function readDraft() {
    const parsed = mode === 'text' ? parseVariables(text, rows) : rows;
    const issue = variableDraftError(parsed);
    if (issue) throw new Error(issue);
    return parsed;
  }

  function switchMode(next: 'table' | 'text') {
    if (next === mode) return;
    try {
      const parsed = readDraft();
      setRows(parsed);
      setText(next === 'text' ? formatVariables(parsed) : '');
      setMode(next);
      setRowSecrets(new Map());
      setTextSecrets(null);
      setError('');
    } catch (err) {
      setError(message(err));
    }
  }

  function clearDraft(next: VariableDraft[]) {
    setRows(next);
    setText(mode === 'text' ? formatVariables(next) : '');
    setRowSecrets(new Map());
    setTextSecrets(null);
    setError('');
  }

  function applySnapshot(snapshot: VariableSnapshot<Revision>) {
    const next = toDraft(snapshot.variables);
    setRevision(snapshot.revision);
    setBaseline(next);
    clearDraft(next);
    setConflict(false);
  }

  async function reloadVariables() {
    setBusy(true);
    try {
      applySnapshot(
        await (persistence ? persistence.reload() : api<VariableSnapshot<Revision>>(path)),
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setError('');
    setSaved(false);
    let submitted: VariableDraft[] | undefined;
    try {
      submitted = readDraft();
      const variables = submitted.map<VariableWrite>(
        ({ key, value, isSecret, description, credentialId }) => {
          const source = credentialId
            ? { credentialId }
            : value === undefined
              ? { keepSecret: true as const }
              : { value };
          return { key, isSecret, description, ...source };
        },
      );
      setBusy(true);
      applySnapshot(
        await (persistence
          ? persistence.save(revision, variables)
          : api<VariableSnapshot<Revision>>(path, {
              method: 'PUT',
              body: JSON.stringify({ expectedRevision: revision, variables }),
            })),
      );
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict(true);
      else {
        const fields = err instanceof ApiError ? err.details?.fieldErrors : undefined;
        const first = Array.isArray(fields)
          ? (fields[0] as { path?: unknown[]; message?: string } | undefined)
          : undefined;
        const row = first?.path?.[0] === 'variables' ? first.path[1] : undefined;
        if (typeof row === 'number' && submitted) {
          setMode('table');
          setRows(submitted);
          setError(`第 ${row + 1} 行 · ${first?.message ?? message(err)}`);
        } else setError(message(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function readSecret(key: string) {
    const result = await post<{ value: string }>(`${path}/${encodeURIComponent(key)}/reveal`);
    return result.value;
  }

  async function toggleRowSecret(row: VariableDraft) {
    if (rowSecrets.has(row.id)) {
      setRowSecrets((current) => withoutSecret(current, row.id));
      return;
    }
    setError('');
    setBusy(true);
    try {
      const value = row.value ?? (await readSecret(row.key));
      setRowSecrets((current) => new Map(current).set(row.id, value));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleTextSecrets() {
    if (textSecrets) {
      setTextSecrets(null);
      return;
    }
    setError('');
    try {
      const parsed = readDraft();
      setBusy(true);
      const entries = await Promise.all(
        parsed
          .filter(
            (row) =>
              row.isSecret &&
              row.value === undefined &&
              row.storedKey === row.key &&
              !row.credentialId,
          )
          .map(async ({ key }) => [key, await readSecret(key)] as const),
      );
      setRows(parsed);
      setText(formatVariables(parsed));
      setTextSecrets(new Map(entries));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    try {
      const content = formatVariables(readDraft(), textSecrets ?? undefined);
      const url = URL.createObjectURL(
        new Blob([`${content}\n`], { type: 'text/plain;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = '.env';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setError('');
    } catch (err) {
      setError(message(err));
    }
  }

  let effective = rows;
  if (mode === 'text') {
    try {
      effective = parseVariables(text, rows);
    } catch {
      // Keep the previous counts while an assignment is being typed.
    }
  }
  const localKeys = new Set(effective.map(({ key }) => key));
  const secretCount = effective.filter(({ isSecret }) => isSecret).length;

  return (
    <div className="environment-variables form-body">
      {metadata?.(busy)}
      <div className="environment-variable-header">
        <div className="heading-actions" role="group" aria-label="环境变量编辑模式">
          <button
            type="button"
            className={`button small ${mode === 'table' ? 'primary' : 'secondary'}`}
            aria-pressed={mode === 'table'}
            disabled={busy}
            onClick={() => switchMode('table')}
          >
            表格编辑
          </button>
          <button
            type="button"
            className={`button small ${mode === 'text' ? 'primary' : 'secondary'}`}
            aria-pressed={mode === 'text'}
            disabled={busy}
            onClick={() => switchMode('text')}
          >
            .env 文本编辑
          </button>
        </div>
        <span className="muted">
          共 {effective.length} 个变量 · {secretCount} 个敏感变量
        </span>
      </div>
      {mode === 'table' ? (
        <>
          {rows.length ? (
            <div className="table-scroll">
              <table className="environment-variable-table">
                <thead>
                  <tr>
                    <th scope="col">变量名</th>
                    <th scope="col">值</th>
                    <th scope="col">类型</th>
                    <th scope="col">描述</th>
                    {(canEdit || canReveal) && <th scope="col">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, index) => {
                    const name = row.key || `第 ${index + 1} 行`;
                    const revealed = rowSecrets.get(row.id);
                    const hasStoredValue =
                      row.isSecret && row.key === row.storedKey && !row.credentialId;
                    const showReveal = row.isSecret && (canReveal || row.value !== undefined);
                    return (
                      <tr key={row.id}>
                        <td>
                          {canEdit ? (
                            <input
                              aria-label={`变量名 ${name}`}
                              className="environment-variable-code"
                              value={row.key}
                              placeholder="KEY"
                              maxLength={128}
                              spellCheck={false}
                              disabled={busy}
                              onChange={(event) => update(row, { key: event.target.value })}
                            />
                          ) : (
                            <code>{row.key}</code>
                          )}
                        </td>
                        <td>
                          {canEdit ? (
                            row.isSecret ? (
                              <input
                                type="password"
                                autoComplete="new-password"
                                aria-label={`变量值 ${name}`}
                                placeholder={hasStoredValue ? hiddenVariableValue : '输入敏感值'}
                                maxLength={65_536}
                                value={row.value ?? ''}
                                disabled={busy || !!row.credentialId}
                                onChange={(event) => update(row, { value: event.target.value })}
                              />
                            ) : (
                              <textarea
                                rows={1}
                                aria-label={`变量值 ${name}`}
                                placeholder={row.storedKey ? '输入新值' : 'VALUE'}
                                maxLength={65_536}
                                value={row.value ?? ''}
                                spellCheck={false}
                                disabled={busy}
                                onChange={(event) => update(row, { value: event.target.value })}
                              />
                            )
                          ) : (
                            <code>{row.isSecret ? hiddenVariableValue : row.value || '—'}</code>
                          )}
                          {revealed !== undefined && (
                            <textarea
                              className="environment-variable-code"
                              rows={1}
                              aria-label={`已显示的敏感值 ${name}`}
                              value={revealed}
                              readOnly
                              spellCheck={false}
                            />
                          )}
                          {row.isSecret &&
                            row.secretSource === 'CREDENTIAL' &&
                            hasStoredValue &&
                            row.value === undefined && <span className="muted">凭据引用</span>}
                          {row.isSecret && !!credentialOptions?.length && (
                            <select
                              aria-label={`变量凭据 ${name}`}
                              value={row.credentialId ?? ''}
                              disabled={busy || !canEdit}
                              onChange={(event) =>
                                update(row, {
                                  credentialId: event.target.value || undefined,
                                  value: event.target.value ? undefined : row.value,
                                })
                              }
                            >
                              <option value="">使用输入值或保留原值</option>
                              {credentialOptions.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.name}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td>
                          {canEdit ? (
                            <select
                              aria-label={`变量类型 ${name}`}
                              value={row.isSecret ? 'secret' : 'plain'}
                              disabled={busy}
                              onChange={(event) => {
                                const isSecret = event.target.value === 'secret';
                                update(row, {
                                  isSecret,
                                  credentialId: isSecret ? row.credentialId : undefined,
                                  value: isSecret && row.value === '' ? undefined : row.value,
                                });
                              }}
                            >
                              <option value="plain">普通</option>
                              <option value="secret">敏感</option>
                            </select>
                          ) : (
                            <span className="tag">{row.isSecret ? '敏感' : '普通'}</span>
                          )}
                        </td>
                        <td>
                          {canEdit ? (
                            <input
                              aria-label={`变量描述 ${name}`}
                              placeholder="可选"
                              maxLength={1_000}
                              value={row.description}
                              disabled={busy}
                              onChange={(event) => update(row, { description: event.target.value })}
                            />
                          ) : (
                            row.description || '—'
                          )}
                        </td>
                        {(canEdit || canReveal) && (
                          <td>
                            <div className="heading-actions">
                              {showReveal && (hasStoredValue || row.value !== undefined) && (
                                <button
                                  type="button"
                                  className="icon-button bare muted"
                                  title={revealed === undefined ? '显示敏感值' : '隐藏敏感值'}
                                  aria-label={`${revealed === undefined ? '显示' : '隐藏'}敏感值 ${name}`}
                                  disabled={busy}
                                  onClick={() => void toggleRowSecret(row)}
                                >
                                  {revealed === undefined ? (
                                    <Eye size={16} />
                                  ) : (
                                    <EyeOff size={16} />
                                  )}
                                </button>
                              )}
                              {canEdit && (
                                <button
                                  type="button"
                                  className="icon-button bare muted"
                                  title="删除变量"
                                  aria-label={`删除变量 ${name}`}
                                  disabled={busy}
                                  onClick={() => {
                                    setRowSecrets((current) => withoutSecret(current, row.id));
                                    edit(rows.filter((item) => item.id !== row.id));
                                  }}
                                >
                                  <Trash2 size={16} />
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">这里还没有定义变量。</p>
          )}
          {canEdit && (
            <button
              type="button"
              className="button secondary small"
              disabled={busy || rows.length >= 100}
              onClick={() =>
                edit([
                  ...rows,
                  {
                    id: `new-${rowNumber.current++}`,
                    key: '',
                    value: '',
                    isSecret: false,
                    description: '',
                  },
                ])
              }
            >
              <Plus size={16} /> 添加变量
            </button>
          )}
        </>
      ) : (
        <>
          <p className="muted">
            用 <code>KEY=VALUE</code> 定义变量，可在敏感变量上方添加 <code># @secret KEY</code>。
            保留掩码可沿用原值。其他注释仅用于文本输入，描述在表格中维护。
          </p>
          <textarea
            aria-label={textSecrets ? '.env 敏感值预览' : '.env 文本'}
            className="environment-variable-text environment-variable-code"
            rows={10}
            spellCheck={false}
            autoComplete="off"
            readOnly={!canEdit || textSecrets !== null}
            disabled={busy}
            value={textSecrets ? formatVariables(effective, textSecrets) : text}
            placeholder="ENV=test"
            onChange={(event) => {
              setText(event.target.value);
              setError('');
              setSaved(false);
            }}
          />
          <div className="heading-actions">
            {canReveal && secretCount > 0 && (
              <button
                type="button"
                className="button secondary small"
                disabled={busy}
                onClick={() => void toggleTextSecrets()}
              >
                {textSecrets ? <EyeOff size={16} /> : <Eye size={16} />}
                {textSecrets ? '隐藏敏感值' : '显示敏感值'}
              </button>
            )}
            <button
              type="button"
              className="button secondary small"
              disabled={busy}
              onClick={download}
            >
              <Download size={16} />
              {textSecrets
                ? '导出 .env（含敏感值）'
                : secretCount > 0
                  ? '导出 .env（隐藏敏感值）'
                  : '导出 .env'}
            </button>
          </div>
        </>
      )}
      <ErrorBanner error={error} />
      {conflict && <ErrorBanner error="变量已在其他页面更新，当前草稿已保留。" />}
      {conflict && persistence?.conflict}
      {canEdit && (
        <div className="heading-actions environment-variable-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || conflict}
            onClick={() => void save()}
          >
            {persistence?.saveLabel ?? '保存变量'}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setSaved(false);
              if (conflict) void reloadVariables();
              else {
                persistence?.discard();
                clearDraft(baseline);
              }
            }}
          >
            {conflict ? '放弃草稿并加载最新变量' : '放弃修改'}
          </button>
          {saved && <span role="status">变量已保存</span>}
        </div>
      )}
      {!!inherited?.length && (
        <div className="environment-variable-inheritance">
          <h3>继承的变量</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">变量名</th>
                  <th scope="col">值</th>
                  <th scope="col">来源</th>
                </tr>
              </thead>
              <tbody>
                {inherited.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <code>{row.key}</code>
                    </td>
                    <td>
                      <code>{row.isSecret ? hiddenVariableValue : row.value || '—'}</code>
                    </td>
                    <td>
                      <span className="tag">
                        {localKeys.has(row.key) ? `已覆盖 · ${row.source}` : row.source}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function withoutSecret(current: Map<string, string>, key: string) {
  const next = new Map(current);
  next.delete(key);
  return next;
}
