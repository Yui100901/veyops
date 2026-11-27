import { useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import { message, post } from '../../api';
import { ErrorBanner, Field, Section } from '../../components';
import type { TaskTarget } from '../../models';

export function InteractiveCommandInput({
  taskId,
  targets,
}: {
  taskId: string;
  targets: TaskTarget[];
}) {
  const [selection, setSelection] = useState('all');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const running = targets.filter(({ status }) => status === 'RUNNING');
  const destination = running.filter(({ id }) => selection === 'all' || selection === id);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !input || !destination.length) return;
    setBusy(true);
    setError('');
    setSent('');
    try {
      const receipt = await post<{ targetIds: string[] }>(`/commands/${taskId}/input`, {
        input,
        targetIds: destination.map(({ id }) => id),
      });
      setInput('');
      setSent(`已向 ${receipt.targetIds.length} 台服务器提交输入`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="交互输入" subtitle="输入只发送至已启动的 SSH 会话。执行输出会留在任务日志中。">
      <form onSubmit={send} className="form-body">
        <Field label="接收目标">
          <select
            value={selection}
            onChange={(event) => setSelection(event.target.value)}
            disabled={busy}
          >
            <option value="all">全部运行中的目标（{running.length}）</option>
            {targets.map(({ id, serverName, status }) => (
              <option key={id} value={id} disabled={status !== 'RUNNING'}>
                {serverName}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="命令或提示响应"
          hint="发送时补上换行。使用控制台的取消任务操作结束尚在运行的会话。"
        >
          <textarea
            rows={3}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={4096}
            spellCheck={false}
            disabled={busy}
          />
        </Field>
        <ErrorBanner error={error} />
        {sent && (
          <p className="field-note" role="status">
            {sent}
          </p>
        )}
        <div className="row-actions">
          <button className="button primary" disabled={busy || !input || !destination.length}>
            <Send size={16} /> {busy ? '正在提交…' : '发送输入'}
          </button>
        </div>
      </form>
    </Section>
  );
}
