import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let body: { data?: T; error?: { message?: string }; message?: string };
  try {
    body = await response.json();
  } catch {
    throw new ApiError('服务返回了无法识别的响应，请检查后端是否正常运行。', response.status);
  }
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/'))
      window.dispatchEvent(new Event('veyops:session-expired'));
    throw new ApiError(
      body.error?.message ?? body.message ?? `请求失败（${response.status}）`,
      response.status,
    );
  }
  return body.data as T;
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
export function remove(path: string) {
  return api<unknown>(path, { method: 'DELETE' });
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

export function useResource<T>(path: string | null, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  const reload = useCallback(async () => {
    if (!path) {
      setLoading(false);
      return;
    }
    const request = ++version.current;
    try {
      const value = await api<T>(path);
      if (request === version.current) {
        setData(value);
        setError('');
      }
    } catch (err) {
      if (request === version.current) setError(message(err));
    } finally {
      if (request === version.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setData(undefined);
    setError('');
    setLoading(true);
    void reload();
    const timer = interval
      ? window.setInterval(() => {
          if (!document.hidden) void reload();
        }, interval)
      : undefined;
    return () => {
      ++version.current;
      window.clearInterval(timer);
    };
  }, [reload, interval]);
  return { data, error, loading, reload };
}

export function navigate(path: string) {
  window.location.hash = path;
}
export function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const update = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

/** Read file logs by byte offset, rather than repeatedly fetching only the first chunk. */
export function useTaskLogs(id: string) {
  const [data, setData] = useState({ content: '', nextOffset: 0, truncated: false });
  const [error, setError] = useState('');
  const cursor = useRef(0);
  const epoch = useRef(0);
  const pending = useRef(false);
  const reload = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    const current = epoch.current;
    try {
      let content = '';
      let nextCursor = cursor.current;
      for (let i = 0; i < 8; i++) {
        const result = await api<{ content: string; nextOffset: number }>(
          `/tasks/${id}/logs?offset=${nextCursor}`,
        );
        if (current !== epoch.current) return;
        if (result.nextOffset <= nextCursor) break;
        nextCursor = result.nextOffset;
        content += result.content;
        if (!result.content) break;
      }
      if (current === epoch.current) {
        // Commit the cursor with the visible content. A later chunk failing must not lose earlier chunks.
        cursor.current = nextCursor;
        setError('');
        setData((previous) => {
          const combined = previous.content + content;
          return {
            content: combined.slice(-2_000_000),
            nextOffset: nextCursor,
            truncated: previous.truncated || combined.length > 2_000_000,
          };
        });
      }
    } catch (err) {
      if (current === epoch.current) setError(message(err));
    } finally {
      if (current === epoch.current) pending.current = false;
    }
  }, [id]);
  useEffect(() => {
    epoch.current++;
    cursor.current = 0;
    pending.current = false;
    setData({ content: '', nextOffset: 0, truncated: false });
    void reload();
    const timer = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, 2000);
    return () => {
      epoch.current++;
      window.clearInterval(timer);
    };
  }, [reload]);
  return { data, error, reload };
}

export function formatTime(value?: number | null) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(Number(value)))
    : '—';
}
export function activeTask(status: string) {
  return ['PENDING', 'RUNNING', 'CANCEL_REQUESTED'].includes(status);
}
