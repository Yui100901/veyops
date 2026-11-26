import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, message } from '../../../api';
import { ErrorBanner } from '../../../components';

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

export function ExecutionGraphNodeLogs({
  path,
  status,
  legacy,
  deferUntilVisible = false,
}: {
  path: string;
  status: string;
  legacy: string;
  deferUntilVisible?: boolean;
}) {
  const [log, setLog] = useState<NodeLog>();
  const heading = useId();
  const section = useRef<HTMLElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [inViewport, setInViewport] = useState(false);
  const canLoad = !deferUntilVisible || inViewport;
  const latest = useRef<NodeLog | undefined>(undefined);
  const request = useRef<AbortController | undefined>(undefined);
  const active = activeStates.has(status);
  useEffect(() => {
    if (!deferUntilVisible || !section.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setInViewport(Boolean(entry?.isIntersecting)),
      { rootMargin: '180px 0px' },
    );
    observer.observe(section.current);
    return () => observer.disconnect();
  }, [deferUntilVisible]);
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
    if (!canLoad) return;
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
  }, [active, canLoad, reload]);

  const summary = log?.summary ?? legacy;
  const content = log?.source === 'TASK' ? log.content : log?.content || summary;
  const currentStatus = log?.status ?? status;
  return (
    <section className="graph-history-node-logs" aria-labelledby={heading} ref={section}>
      <header className="graph-history-logs-header">
        <h4 id={heading}>节点日志</h4>
        <button
          className="button secondary small"
          type="button"
          disabled={loading && canLoad}
          onClick={() => void reload()}
        >
          {log?.more ? '继续读取日志' : '刷新节点日志'}
        </button>
      </header>
      <ErrorBanner error={error} />
      {log?.source === 'TASK' && summary && summary !== content && (
        <p className="field-note">{summary}</p>
      )}
      {content ? (
        <pre className="task-logs" aria-label="节点日志" tabIndex={0}>
          {content}
        </pre>
      ) : (
        <p className="graph-history-node-log-state" role="status">
          {!canLoad && !log
            ? '滚动至此自动读取日志。'
            : loading
              ? '正在读取节点日志…'
              : activeStates.has(currentStatus)
                ? '等待节点输出日志…'
                : '此节点暂无日志。'}
        </p>
      )}
      {log?.truncated && <p className="field-note">日志较长，当前显示最近读取的内容。</p>}
    </section>
  );
}
