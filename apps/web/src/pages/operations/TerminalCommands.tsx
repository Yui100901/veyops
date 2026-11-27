import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Eye, EyeOff, Square, Terminal } from 'lucide-react';
import { activeTask, ApiError, message, post, useResource, useTaskLogs } from '../../api';
import { ErrorBanner, Status } from '../../components';
import type { Server, Task, TaskTarget, User } from '../../models';
import { BatchTargetPicker, useBatchTargetResources } from './BatchTargets';
import type { TargetPreview, TargetSelection } from './BatchTargets';
import { resolveSelectedServerIds } from './CompactTargetPicker';
import { TargetedOperationsAI } from './TargetedOperationsAI';
import './terminal-commands.css';

const shellTimeout = 3600;
const maxParallelSessions = 10;

type Target = Pick<Server, 'id' | 'name' | 'host'>;
type Prompt = { input: string; masked: boolean };
type Session = { taskId: string; targets: Target[] };
type InitialInput = Prompt & { taskId: string; serverIds: string[] };

function TerminalInput({
  label,
  disabled,
  multiline = false,
  onRun,
}: {
  label: string;
  disabled: boolean;
  multiline?: boolean;
  onRun: (prompt: Prompt) => Promise<boolean>;
}) {
  const [input, setInput] = useState('');
  const [masked, setMasked] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || busy || !input.trim()) return;
    setBusy(true);
    try {
      if (await onRun({ input, masked })) {
        setInput('');
        setMasked(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={multiline ? 'terminal-input terminal-input-multiline' : 'terminal-input'}
      onSubmit={submit}
    >
      <span aria-hidden="true">❯</span>
      {multiline && !masked ? (
        <textarea
          aria-label={label}
          placeholder="输入命令，回车发送，Shift+Enter 换行"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
          rows={4}
          autoCapitalize="off"
          spellCheck={false}
          maxLength={4095}
          readOnly={busy}
          disabled={disabled}
        />
      ) : (
        <input
          type={masked ? 'password' : 'text'}
          aria-label={label}
          placeholder={masked ? '输入隐藏内容，回车发送' : '输入命令，回车执行'}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          }}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={4095}
          readOnly={busy}
          disabled={disabled}
        />
      )}
      <button
        type="button"
        className="terminal-input-action"
        aria-label={masked ? '显示输入' : '隐藏本地输入及回显'}
        aria-pressed={masked}
        title={
          input.includes('\n') ? '隐藏输入适用于单行' : masked ? '显示输入' : '隐藏本地输入及回显'
        }
        disabled={disabled || busy || input.includes('\n')}
        onClick={() => setMasked(!masked)}
      >
        {masked ? <Eye size={16} /> : <EyeOff size={16} />}
      </button>
      <button
        className="terminal-input-action"
        aria-label="发送命令"
        title="发送命令"
        disabled={disabled || busy || !input.trim()}
      >
        <ArrowRight size={17} />
      </button>
    </form>
  );
}

function TerminalPane({
  server,
  taskId,
  target,
  echo,
  disabled,
  onRun,
}: {
  server: Target;
  taskId?: string;
  target?: TaskTarget;
  echo?: string;
  disabled: boolean;
  onRun: (prompt: Prompt) => Promise<boolean>;
}) {
  const output = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const logs = useTaskLogs(taskId && target ? taskId : null, {
    targetId: target?.id,
    interval: target && activeTask(target.status) ? 1000 : 0,
  });
  const content = logs.data.content.replace(/\r\n?/g, '\n');
  useEffect(() => {
    const element = output.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [content]);

  return (
    <article className="terminal-pane" aria-label={`${server.name} 终端`}>
      <header className="terminal-pane-header">
        <Terminal size={16} aria-hidden="true" />
        <strong title={server.name}>{server.name}</strong>
        <small title={server.host}>{server.host}</small>
        <span className="terminal-pane-status">
          {target ? <Status value={target.status} /> : taskId ? '连接中' : '未连接'}
        </span>
      </header>
      <pre
        tabIndex={0}
        aria-label={`${server.name} 命令输出`}
        ref={output}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
        }}
      >
        {content ||
          target?.errorSummary ||
          logs.error ||
          (target?.status === 'PENDING'
            ? '等待服务器执行槽。'
            : taskId
              ? '等待 SSH 输出。'
              : '等待命令。')}
      </pre>
      <div className="terminal-echo">
        <span>回显</span>
        <code dir="ltr">{echo ?? '—'}</code>
      </div>
      {logs.error && content && (
        <small className="terminal-log-note" role="status">
          {logs.error}
        </small>
      )}
      <TerminalInput label={`${server.name} 命令输入`} disabled={disabled} onRun={onRun} />
    </article>
  );
}

export function TerminalCommands({ user }: { user: User }) {
  const canRun = user.role !== 'VIEWER';
  const resources = useBatchTargetResources();
  const [selection, setSelection] = useState<TargetSelection>({});
  const [session, setSession] = useState<Session>();
  const [initial, setInitial] = useState<InitialInput>();
  const [echoes, setEchoes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const initialSending = useRef(false);
  const submitting = useRef(false);
  const task = useResource<Task>(session ? `/tasks/${session.taskId}` : null, 1000);
  const active = Boolean(session && (!task.data || activeTask(task.data.status)));
  const targets = useResource<TaskTarget[]>(
    session ? `/tasks/${session.taskId}/targets` : null,
    active ? 1000 : 0,
  );
  const selectedIds = resolveSelectedServerIds(selection, resources.groups.data ?? []);
  const selected = (resources.servers.data ?? []).filter(({ id }) => selectedIds.has(id));
  const displayed = active && session ? session.targets : selected;
  const ready = (targets.data ?? []).filter(
    ({ status, serverId }) => status === 'RUNNING' && !initial?.serverIds.includes(serverId),
  );

  useEffect(() => {
    if (!initial || initialSending.current || closing || !targets.data) return;
    const waiting = targets.data.filter(({ serverId }) => initial.serverIds.includes(serverId));
    const runnable = waiting.filter(({ status }) => status === 'RUNNING');
    const ended = waiting.filter(({ status }) => !activeTask(status));
    function finish(handled: string[]) {
      setInitial((current) => {
        if (!current || current.taskId !== initial?.taskId) return current;
        const serverIds = current.serverIds.filter((id) => !handled.includes(id));
        return serverIds.length ? { ...current, serverIds } : undefined;
      });
    }
    if (ended.length) {
      setError(`会话结束，无法发送命令：${ended.map(({ serverName }) => serverName).join('、')}`);
      finish(ended.map(({ serverId }) => serverId));
    }
    if (!runnable.length) return;
    initialSending.current = true;
    void post<{ targetIds: string[] }>(`/commands/${initial.taskId}/input`, {
      input: initial.input,
      targetIds: runnable.map(({ id }) => id),
    })
      .then(({ targetIds }) => {
        const accepted = runnable.filter(({ id }) => targetIds.includes(id));
        setEchoes((current) => ({
          ...current,
          ...Object.fromEntries(
            accepted.map(({ serverId }) => [serverId, initial.masked ? '••••••' : initial.input]),
          ),
        }));
        finish(accepted.map(({ serverId }) => serverId));
      })
      .catch((cause) => {
        // Input is only retried after a definite server-side rejection before enqueue.
        if (cause instanceof ApiError && cause.status === 409) return;
        setError(message(cause));
        finish(runnable.map(({ serverId }) => serverId));
      })
      .finally(() => {
        initialSending.current = false;
      });
  }, [closing, initial, targets.data]);

  async function run(prompt: Prompt, serverId?: string) {
    if (!canRun || !displayed.length || closing || submitting.current) return false;
    const encoder = new TextEncoder();
    if (prompt.input.split('\n').some((line) => encoder.encode(line).length > 4095)) {
      setError('每行命令不能超过 4095 字节');
      return false;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (session && active) {
        const destination = ready.filter((target) => !serverId || target.serverId === serverId);
        if (!destination.length) return false;
        const { targetIds } = await post<{ targetIds: string[] }>(
          `/commands/${session.taskId}/input`,
          {
            input: prompt.input,
            targetIds: destination.map(({ id }) => id),
          },
        );
        setEchoes((current) => ({
          ...current,
          ...Object.fromEntries(
            destination
              .filter(({ id }) => targetIds.includes(id))
              .map(({ serverId: id }) => [id, prompt.masked ? '••••••' : prompt.input]),
          ),
        }));
        return true;
      }
      const preview = await post<TargetPreview>('/commands/preview', selection);
      if (
        preview.targets.length !== selected.length ||
        preview.targets.some(
          ({ id, host, name }) =>
            !selected.some(
              (server) => server.id === id && server.host === host && server.name === name,
            ),
        )
      ) {
        await Promise.all([resources.servers.reload(), resources.groups.reload()]);
        setError('服务器或分组成员已变化，请核对执行目标后再运行。');
        return false;
      }
      const next = await post<Task>('/commands/execute', {
        ...selection,
        name: '执行命令 · 交互会话',
        command: '/bin/sh -i',
        interactive: true,
        timeout: shellTimeout,
        strategy: 'PARALLEL',
        maxParallel: maxParallelSessions,
        failurePolicy: 'CONTINUE',
        expectedTargetHash: preview.targetHash,
        confirmed: true,
      });
      setEchoes({});
      setSession({ taskId: next.id, targets: preview.targets });
      setInitial({
        ...prompt,
        taskId: next.id,
        serverIds: serverId ? [serverId] : preview.targets.map(({ id }) => id),
      });
      return true;
    } catch (cause) {
      setError(message(cause));
      if (session) void targets.reload();
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function close() {
    if (!session || closing) return;
    setClosing(true);
    setInitial(undefined);
    setError('');
    try {
      await post(`/tasks/${session.taskId}/cancel`);
      await Promise.all([task.reload(), targets.reload()]);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setClosing(false);
    }
  }

  const locked = busy || closing || !canRun;
  return (
    <div className="terminal-workspace">
      <section className="panel terminal-targets" aria-label="执行目标">
        <BatchTargetPicker
          selection={selection}
          onChange={setSelection}
          disabled={locked || active}
          resources={resources}
        />
      </section>
      <TargetedOperationsAI
        user={user}
        selection={selection}
        disabled={!canRun || !selected.length}
      />
      <ErrorBanner error={error || task.error || targets.error} />
      {displayed.length > 0 && (
        <>
          <div className="terminal-session-bar">
            <div className="terminal-broadcast">
              <header>
                <Terminal size={16} aria-hidden="true" />
                {active ? `广播 · ${ready.length} 台就绪` : `广播 · ${displayed.length} 台`}
              </header>
              <TerminalInput
                label="广播命令"
                multiline
                disabled={locked || (active && !ready.length)}
                onRun={(prompt) => run(prompt)}
              />
            </div>
            {session && (
              <a className="button secondary small" href={`#/tasks/${session.taskId}`}>
                会话记录
              </a>
            )}
            {active && (
              <button
                className="button secondary small"
                type="button"
                onClick={() => void close()}
                disabled={busy || closing || !canRun || task.data?.status === 'CANCEL_REQUESTED'}
              >
                <Square size={14} />{' '}
                {closing || task.data?.status === 'CANCEL_REQUESTED' ? '正在结束' : '结束会话'}
              </button>
            )}
          </div>
          {displayed.length > maxParallelSessions && (
            <p className="field-note">
              超过 {maxParallelSessions} 台时，其余会话在本批有空位后启动。
            </p>
          )}
          <div className="terminal-grid">
            {displayed.map((server) => (
              <TerminalPane
                key={server.id}
                server={server}
                taskId={
                  session?.targets.some(({ id }) => id === server.id) ? session.taskId : undefined
                }
                target={targets.data?.find(({ serverId }) => serverId === server.id)}
                echo={echoes[server.id]}
                disabled={
                  locked || (active && !ready.some(({ serverId }) => serverId === server.id))
                }
                onRun={(prompt) => run(prompt, server.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
