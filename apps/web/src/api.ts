import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphEdge } from './pages/execution-graph/execution-graph-definition';

const planIssueCodes = [
  'INPUT',
  'REPOSITORY',
  'BUILD_TARGET',
  'RELEASE_TARGET',
  'ARTIFACT',
  'SOURCE_REVIEW',
  'CONFIGURATION',
] as const;

const graphIssueSections = ['input', 'execution', 'output'] as const;
const graphIssueArtifactFields = [
  'path',
  'pathInput',
  'imageReference',
  'composeFilePath',
  'referenceName',
] as const;

export type GraphIssueLocation = {
  fieldSection?: (typeof graphIssueSections)[number];
  artifactField?: (typeof graphIssueArtifactFields)[number];
};

export function readGraphIssueLocation(
  fieldSection: unknown,
  artifactField: unknown,
): GraphIssueLocation {
  return {
    fieldSection: graphIssueSections.find((section) => section === fieldSection),
    artifactField: graphIssueArtifactFields.find((field) => field === artifactField),
  };
}

export interface ExecutionPlanIssue extends GraphIssueLocation {
  code: (typeof planIssueCodes)[number];
  message: string;
  flowId?: string;
  flowName?: string;
  nodeId?: string;
  nodeName?: string;
  fieldId?: string;
  fieldName?: string;
  sourceNodeId?: string;
  sourceFieldId?: string;
  branchId?: string;
  edge?: GraphEdge;
  repositoryId?: string;
  commitSha?: string;
  parameterId?: string;
  serviceId?: string;
  environmentId?: string;
  targetSource?:
    'RUN_INPUT' | 'NODE' | 'SERVICE_ENVIRONMENT' | 'PROJECT_ENVIRONMENT' | 'LEGACY_TARGET';
}

function readPlanIssue(value: unknown): ExecutionPlanIssue | undefined {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  const code = planIssueCodes.find((candidate) => candidate === row.code);
  if (!code || typeof row.message !== 'string') return;
  const issue: ExecutionPlanIssue = {
    code,
    message: row.message,
    ...readGraphIssueLocation(row.fieldSection, row.artifactField),
  };
  for (const key of [
    'flowId',
    'flowName',
    'nodeId',
    'nodeName',
    'fieldId',
    'fieldName',
    'sourceNodeId',
    'sourceFieldId',
    'branchId',
    'repositoryId',
    'commitSha',
    'parameterId',
    'serviceId',
    'environmentId',
  ] as const) {
    const value = row[key];
    if (typeof value === 'string') issue[key] = value;
  }
  if (row.edge && typeof row.edge === 'object') {
    const { from, to, when } = row.edge as Record<string, unknown>;
    if (
      typeof from === 'string' &&
      typeof to === 'string' &&
      (when === undefined ||
        (typeof when === 'string' &&
          /^(?:TRUE|FALSE|DEFAULT|SUCCESS|PARTIAL_SUCCESS|CASE:[0-9])$/.test(when)))
    ) {
      issue.edge = { from, to, when: when as GraphEdge['when'] };
    }
  }
  const { targetSource } = row;
  if (
    targetSource === 'RUN_INPUT' ||
    targetSource === 'NODE' ||
    targetSource === 'SERVICE_ENVIRONMENT' ||
    targetSource === 'PROJECT_ENVIRONMENT' ||
    targetSource === 'LEGACY_TARGET'
  ) {
    issue.targetSource = targetSource;
  }
  return issue;
}

export class ApiError extends Error {
  status: number;
  changes: string[];
  readonly planIssue?: ExecutionPlanIssue;
  readonly details?: Record<string, unknown>;
  constructor(
    message: string,
    status: number,
    changes: string[] = [],
    planIssue?: ExecutionPlanIssue,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.changes = changes;
    this.planIssue = planIssue;
    this.details = details;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let body: {
    data?: T;
    error?: { message?: string; changes?: unknown; planIssue?: unknown; details?: unknown };
    message?: string;
  };
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
      Array.isArray(body.error?.changes)
        ? body.error.changes.filter((change): change is string => typeof change === 'string')
        : [],
      readPlanIssue(body.error?.planIssue),
      body.error?.details &&
        typeof body.error.details === 'object' &&
        !Array.isArray(body.error.details)
        ? (body.error.details as Record<string, unknown>)
        : undefined,
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

export type RouteTransition = {
  proceed: () => void;
  cancel: () => void;
};

let routeBlocker: ((transition: RouteTransition | null) => void) | undefined;

export function useRouteBlocker(active: boolean, onTransition: typeof routeBlocker) {
  useEffect(() => {
    if (!active || !onTransition) return;
    routeBlocker = onTransition;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      if (routeBlocker === onTransition) routeBlocker = undefined;
      window.removeEventListener('beforeunload', warn);
    };
  }, [active, onTransition]);
}

function currentRoute() {
  return window.location.hash.slice(1) || '/';
}

function routePosition(fallback: number): number {
  const state = window.history.state;
  if (Number.isSafeInteger(state?.veyopsRoutePosition)) return state.veyopsRoutePosition;
  window.history.replaceState({ ...state, veyopsRoutePosition: fallback }, '');
  return fallback;
}

export function useRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    let current = currentRoute();
    let position = routePosition(0);
    let browserPosition = position;
    const update = () => {
      const next = currentRoute();
      // A blocked traversal leaves the original entry in place so cancelling can restore it.
      const destination = (browserPosition = routePosition(browserPosition + 1));
      const commit = () => {
        current = next;
        position = destination;
        setRoute(next);
      };
      if (!routeBlocker || current === next) {
        routeBlocker?.(null);
        commit();
        return;
      }
      const stillPending = () =>
        currentRoute() === next && window.history.state?.veyopsRoutePosition === destination;
      routeBlocker({
        proceed: () => {
          if (stillPending()) commit();
        },
        cancel: () => {
          if (stillPending()) window.history.go(position - destination);
        },
      });
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

/** Read file logs by byte offset, rather than repeatedly fetching only the first chunk. */
export function useTaskLogs(
  id: string | null,
  { targetId, interval = 2000 }: { targetId?: string; interval?: number } = {},
) {
  const path =
    id &&
    `/tasks/${encodeURIComponent(id)}${targetId ? `/targets/${encodeURIComponent(targetId)}` : ''}/logs`;
  const [data, setData] = useState({ content: '', nextOffset: 0, truncated: false });
  const [error, setError] = useState('');
  const cursor = useRef(0);
  const epoch = useRef(0);
  const pending = useRef<Promise<void>>();
  const reload = useCallback(() => {
    if (!path) return;
    if (pending.current) return pending.current;
    const current = epoch.current;
    const work = (async () => {
      try {
        let content = '';
        let nextCursor = cursor.current;
        for (let i = 0; i < 8; i++) {
          const result = await api<{ content: string; nextOffset: number }>(
            `${path}?offset=${nextCursor}`,
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
      }
    })().finally(() => {
      if (pending.current === work) pending.current = undefined;
    });
    pending.current = work;
    return work;
  }, [path]);
  useEffect(() => {
    epoch.current++;
    cursor.current = 0;
    pending.current = undefined;
    setData({ content: '', nextOffset: 0, truncated: false });
    setError('');
    void reload();
    return () => {
      epoch.current++;
    };
  }, [reload]);
  useEffect(() => {
    if (!path) return;
    if (!interval) {
      let current = true;
      // The last poll may have read before the terminal process flushed its final output.
      void Promise.resolve(pending.current).then(() => {
        if (current) return reload();
      });
      return () => {
        current = false;
      };
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, interval);
    return () => window.clearInterval(timer);
  }, [interval, path, reload]);
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
