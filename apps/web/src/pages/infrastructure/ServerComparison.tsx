import { InlineEditor } from '../../InlineEditor';
import { useState } from 'react';
import { post, formatTime, message } from '../../api';
import { Empty, ErrorBanner, Field } from '../../components';
import type { Server } from '../../models';

interface Source {
  id: string;
  name: string;
  collectedAt: number | null;
  status: 'OK' | 'UNAVAILABLE';
}
interface Comparison {
  baseline: Source;
  comparison: Source;
  rows: {
    key: string;
    label: string;
    baseline: string | null;
    comparison: string | null;
    status: 'EQUAL' | 'DIFFERENT' | 'UNKNOWN';
  }[];
}
export function ServerComparison({ servers, onClose }: { servers: Server[]; onClose: () => void }) {
  const [baseline, setBaseline] = useState(servers[0]?.id ?? '');
  const [comparison, setComparison] = useState(servers[1]?.id ?? '');
  const [result, setResult] = useState<Comparison>();
  const [different, setDifferent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function compare() {
    setBusy(true);
    setResult(undefined);
    setError('');
    try {
      setResult(
        await post<Comparison>('/servers/configuration/compare', {
          baselineId: baseline,
          comparisonId: comparison,
        }),
      );
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const visible = result?.rows.filter((row) => !different || row.status !== 'EQUAL');
  return (
    <InlineEditor
      title="服务器配置对比"
      description="通过 SSH 读取两台服务器当前的配置。"
      onClose={onClose}
      wide
    >
      <div className="form-body">
        <div className="form-grid">
          <Field label="基准服务器">
            <select
              value={baseline}
              disabled={busy}
              onChange={(e) => {
                setBaseline(e.target.value);
                if (e.target.value === comparison) setComparison(baseline);
                setResult(undefined);
                setError('');
              }}
            >
              {servers.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name} · {s.host}
                </option>
              ))}
            </select>
          </Field>
          <Field label="对比服务器">
            <select
              value={comparison}
              disabled={busy}
              onChange={(e) => {
                setComparison(e.target.value);
                setResult(undefined);
                setError('');
              }}
            >
              {servers
                .filter((s) => s.id !== baseline)
                .map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name} · {s.host}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <div className="monitor-toolbar">
          <button
            type="button"
            className="button primary small"
            disabled={busy || !comparison || !baseline || baseline === comparison}
            onClick={compare}
          >
            {busy ? '正在读取配置…' : '对比当前配置'}
          </button>
          {result && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={different}
                onChange={(e) => setDifferent(e.target.checked)}
              />
              仅显示差异和未知项
            </label>
          )}
        </div>
        <ErrorBanner error={error} />
        {result && (
          <>
            <div className="task-meta">
              {[result.baseline, result.comparison].map((source) => (
                <span key={source.id}>
                  {source.name} ·{' '}
                  {source.status === 'OK' ? formatTime(source.collectedAt) : '采集失败，配置未知'}
                </span>
              ))}
            </div>
            {visible?.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>配置项</th>
                      <th>{result.baseline.name}</th>
                      <th>{result.comparison.name}</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => (
                      <tr key={row.key}>
                        <th scope="row">{row.label}</th>
                        <td className="monitor-config-value">{row.baseline ?? '未知'}</td>
                        <td className="monitor-config-value">{row.comparison ?? '未知'}</td>
                        <td>
                          <span
                            className={row.status === 'DIFFERENT' ? 'monitor-different' : 'muted'}
                          >
                            {{ DIFFERENT: '不同', EQUAL: '相同', UNKNOWN: '未知' }[row.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="没有配置差异" description="两台服务器的已对比配置相同。" />
            )}
          </>
        )}
      </div>
    </InlineEditor>
  );
}
