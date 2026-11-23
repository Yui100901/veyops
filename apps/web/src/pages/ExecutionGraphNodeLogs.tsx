import { useCallback, useEffect, useRef, useState } from 'react';
import { api, message } from '../api';
import { ErrorBanner } from '../components';

interface NodeLogPage {
  source: 'TASK' | 'NODE';
  status: string;
  summary: string;
  content: string;
  nextOffset: number;
}

type NodeLog = NodeLogPage & { more: boolean; truncated: boolean };
const activeStates = new Set(['PENDING', 'QUEUED', 'WAITING', 'RUNNING', 'CANCEL_REQUESTED']);
const maxDisplayedCharacters = 2_000_000;

function NodeLogContent({
  path,
  status,
  legacy,
}: {
  path: string;
  status: string;
  legacy: string;
}) {
  const [log, setLog] = useState<NodeLog>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const latest = useRef<NodeLog | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const active = activeStates.has(status);
  const reload = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const read = (offset: number) =>
        api<NodeLogPage>(`${path}?offset=${offset}`, { signal: controller.signal });
      const previous = latest.current;
      let offset = previous?.source === 'TASK' ? previous.nextOffset : 0;
      let page = await read(offset);
      let content = previous?.source === 'TASK' ? previous.content : '';
      let truncated = previous?.truncated ?? false;
      if (offset && (page.source !== 'TASK' || page.nextOffset < offset)) {
        offset = 0;
        content = '';
        truncated = false;
        page = await read(0);
      }
      let more = false;
      if (page.source === 'TASK') {
        for (
          let count = 1;
          page.source === 'TASK' && page.content && page.nextOffset > offset;
          count++
        ) {
          content += page.content;
          offset = page.nextOffset;
          if (count === 8) {
            more = true;
            break;
          }
          page = await read(offset);
        }
      }
      if (page.source === 'NODE') {
        content = page.content || page.summary;
        truncated = false;
      }
      if (controller.signal.aborted) return;
      const next = {
        ...page,
        content: content.slice(-maxDisplayedCharacters),
        more,
        truncated: truncated || content.length > maxDisplayedCharacters,
      };
      latest.current = next;
      setLog(next);
      setError('');
    } catch (err) {
      if (!controller.signal.aborted) setError(message(err));
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setLoading(false);
      }
    }
  }, [path]);
  useEffect(() => {
    void reload();
    const interval = active
      ? window.setInterval(() => {
          if (!document.hidden) void reload();
        }, 2000)
      : undefined;
    return () => {
      request.current?.abort();
      request.current = undefined;
      window.clearInterval(interval);
    };
  }, [active, reload]);

  const summary = log?.summary ?? legacy;
  const content = log?.source === 'TASK' ? log.content : log?.content || summary;
  const currentStatus = log?.status ?? status;
  return (
    <div className="graph-fields">
      <div className="graph-node-actions">
        <button
          className="button secondary small"
          type="button"
          disabled={loading}
          onClick={() => void reload()}
        >
          {log?.more ? '继续读取日志' : '刷新节点日志'}
        </button>
      </div>
      <ErrorBanner error={error} />
      {log?.source === 'TASK' && summary && summary !== content && (
        <p className="field-note">{summary}</p>
      )}
      {content ? (
        <pre className="task-logs" aria-label="节点日志" tabIndex={0}>
          {content}
        </pre>
      ) : (
        <p className="field-note" role="status">
          {loading
            ? '正在读取节点日志…'
            : activeStates.has(currentStatus)
              ? '等待节点输出日志…'
              : '此节点暂无日志。'}
        </p>
      )}
      {log?.truncated && <p className="field-note">日志较长，当前显示最近读取的内容。</p>}
    </div>
  );
}

export function ExecutionGraphNodeLogs({
  path,
  status,
  legacy,
}: {
  path: string;
  status: string;
  legacy: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="graph-field-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>节点日志 · 自动收集</summary>
      {open && <NodeLogContent key={path} path={path} status={status} legacy={legacy} />}
    </details>
  );
}
