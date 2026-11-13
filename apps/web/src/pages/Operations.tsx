import { useState } from 'react';
import {
  ArrowLeft,
  Clock3,
  ListTodo,
  RotateCcw,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Square,
  Terminal,
} from 'lucide-react';
import { activeTask, formatTime, message, navigate, post, useResource, useTaskLogs } from '../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Loading,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type { Task, TaskTarget, User } from '../models';
import { TaskTable } from './Dashboard';
import { RunArtifacts } from './Delivery';

export { CommandsPage, PlansPage } from './BatchOperations';
export function TasksPage() {
  const resource = useResource<Task[]>('/tasks', 3000);
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const list = (resource.data ?? []).filter(
    (task) =>
      (filter === 'ALL' ||
        (filter === 'ACTIVE'
          ? activeTask(task.status)
          : filter === 'FAILED'
            ? ['FAILED', 'PARTIAL_FAILED', 'NEEDS_ATTENTION', 'TIMED_OUT'].includes(task.status)
            : task.status === filter)) &&
      task.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="EXECUTION HISTORY"
        title="任务中心"
        description="统一追踪执行进度，保留每一台服务器的独立结果。"
        action={<RefreshButton onClick={resource.reload} />}
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      <Section
        title="执行任务"
        subtitle={`共 ${resource.data?.length ?? 0} 项任务`}
        action={
          <div className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索任务"
              placeholder="搜索任务名称"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        }
      >
        <div className="filter-tabs">
          {[
            ['ALL', '全部任务'],
            ['ACTIVE', '执行中'],
            ['SUCCESS', '成功'],
            ['FAILED', '需要关注'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {resource.loading ? (
          <Loading />
        ) : !resource.data?.length ? (
          <Empty
            icon={<ListTodo size={25} />}
            title="还没有执行任务"
            description="从命令中心提交命令，或运行一个可复用的运维方案。"
            action={
              <a className="button primary" href="#/commands">
                <Terminal size={16} />
                打开命令中心
              </a>
            }
          />
        ) : !list.length ? (
          <Empty title="没有匹配的任务" description="调整筛选条件以查看其他执行记录。" />
        ) : (
          <TaskTable tasks={list} />
        )}
      </Section>
    </>
  );
}

export function TaskPage({ id, user }: { id: string; user: User }) {
  const task = useResource<Task>(`/tasks/${id}`, 2000);
  const targets = useResource<TaskTarget[]>(`/tasks/${id}/targets`, 2000);
  const logs = useTaskLogs(id);
  const steps = useResource<
    {
      id: string;
      serverId: string;
      key: string;
      name: string;
      order: number;
      status: string;
      exitCode: number | null;
    }[]
  >(`/tasks/${id}/steps`, 2000);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [retryTarget, setRetryTarget] = useState<TaskTarget>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function cancel() {
    setBusy(true);
    setError('');
    try {
      await post(`/tasks/${id}/cancel`);
      setConfirmCancel(false);
      await task.reload();
      await targets.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    if (!retryTarget) return;
    setBusy(true);
    setError('');
    try {
      const task = await post<Task>(`/tasks/${id}/targets/${retryTarget.id}/retry`, {
        confirmed: true,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  if (task.loading) return <Loading />;
  if (!task.data)
    return <ErrorBanner error={task.error || '找不到这个任务。'} retry={task.reload} />;
  const value = task.data;
  const analysis = value.result?.aiAnalysis;
  const failedPhase = analysis?.status === 'SUCCESS' && analysis.failedPhase;
  const failedStep =
    failedPhase &&
    steps.data?.find(
      (step) =>
        step.key.split(':')[0] === failedPhase &&
        ['FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'].includes(step.status),
    );
  return (
    <>
      <a href="#/tasks" className="back-link">
        <ArrowLeft size={14} />
        返回任务中心
      </a>
      <PageHeader
        eyebrow="TASK DETAILS"
        title={value.name}
        description={`任务 ID · ${id}`}
        action={
          <>
            <Status value={value.status} />
            {activeTask(value.status) && user.role !== 'VIEWER' && (
              <button
                className="button secondary"
                onClick={() => {
                  setError('');
                  setConfirmCancel(true);
                }}
                disabled={value.status === 'CANCEL_REQUESTED'}
              >
                <Square size={14} />
                取消任务
              </button>
            )}
          </>
        }
      />
      <ErrorBanner error={task.error} retry={task.reload} />
      <div className="task-meta">
        <span>
          <Clock3 size={16} />
          创建于 {formatTime(value.createdAt)}
        </span>
        <span>开始 {formatTime(value.startedAt)}</span>
        <span>完成 {formatTime(value.finishedAt)}</span>
        <span className="tag">
          {value.type === 'PIPELINE'
            ? value.executionMode === 'BUILD_ONLY'
              ? 'Pipeline · 仅构建'
              : 'Pipeline · 构建并部署'
            : value.type}
        </span>
        {value.type === 'PIPELINE' && (
          <>
            <a className="text-link" href="#/artifacts">
              构建产物 →
            </a>
            {value.executionMode !== 'BUILD_ONLY' && (
              <a className="text-link" href="#/deployments">
                部署记录 →
              </a>
            )}
          </>
        )}
      </div>
      {(value.errorSummary || value.errorMessage) && (
        <ErrorBanner error={value.errorSummary || value.errorMessage} />
      )}
      {value.pipelineRunId && (
        <RunArtifacts
          key={value.pipelineRunId}
          runId={value.pipelineRunId}
          polling={activeTask(value.status)}
        />
      )}
      {analysis && (
        <Section title="AI 构建分析" subtitle="根据任务状态、执行阶段和退出码生成">
          {analysis.status === 'UNAVAILABLE' ? (
            <p className="field-note">AI 分析暂不可用。可查看下方的执行结果和日志。</p>
          ) : (
            <>
              <p>{analysis.summary}</p>
              {failedStep && <p className="field-note">失败阶段 · {failedStep.name}</p>}
              {analysis.nextActions.length > 0 && (
                <ul>
                  {analysis.nextActions.map((action, index) => (
                    <li key={index}>{action}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Section>
      )}
      <div className="task-layout">
        <Section title="目标执行结果" subtitle="每台服务器独立记录状态和退出码">
          <ErrorBanner error={targets.error} />
          {targets.loading ? (
            <Loading />
          ) : (
            <div className="target-results">
              {targets.data?.map((target) => (
                <div key={target.id} className="target-result">
                  <div className="target-result-main">
                    <span className="resource-avatar">
                      <ServerIcon size={18} />
                    </span>
                    <div>
                      <strong>{target.serverName}</strong>
                      <small>{target.host}</small>
                    </div>
                    <Status value={target.status} />
                  </div>
                  {target.exitCode != null && (
                    <p>
                      退出码 <code>{target.exitCode}</code>
                    </p>
                  )}
                  {target.errorSummary && <p className="error-text">{target.errorSummary}</p>}
                  {user.role !== 'VIEWER' && target.canRetry && (
                    <button
                      className="text-button"
                      onClick={() => {
                        setError('');
                        setRetryTarget(target);
                      }}
                    >
                      <RotateCcw size={14} />
                      重试此目标
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section
          title="执行日志"
          subtitle={activeTask(value.status) ? '每 2 秒同步任务日志' : '查看保存的任务执行日志'}
          action={<RefreshButton onClick={logs.reload} />}
          className="logs-panel"
        >
          <ErrorBanner error={logs.error} />
          <pre className="task-logs" aria-label="执行日志">
            {logs.data?.content ||
              (activeTask(value.status) ? '等待 Worker 输出日志…' : '这个任务暂无日志。')}
          </pre>
        </Section>
      </div>
      {steps.data && steps.data.length > 0 && (
        <Section title="步骤执行记录" subtitle="每个目标独立追踪步骤状态与退出码">
          <ErrorBanner error={steps.error} />
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>执行位置</th>
                  <th>步骤</th>
                  <th>状态</th>
                  <th>退出码</th>
                </tr>
              </thead>
              <tbody>
                {steps.data.map((step) => (
                  <tr key={step.id}>
                    <td>
                      {step.serverId === 'manager'
                        ? '管理端'
                        : targets.data?.find((t) => t.serverId === step.serverId)?.serverName ||
                          step.serverId}
                    </td>
                    <td>
                      {step.order + 1}. {step.name}
                    </td>
                    <td>
                      <Status value={step.status} />
                    </td>
                    <td className="mono">{step.exitCode ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
      {logs.data.truncated && (
        <p className="field-note">
          界面保留最新约 200 万字符日志；完整日志保存在服务端，支持按字节偏移读取。
        </p>
      )}
      {value.status === 'NEEDS_ATTENTION' && (
        <div className="info-strip">
          <ShieldCheck size={18} />
          <p>任务执行曾中断，远程操作可能已经生效。请先检查目标服务器，再决定是否重新提交命令。</p>
        </div>
      )}
      {confirmCancel && (
        <Confirm
          title="请求取消任务？"
          description="平台会停止后续目标并尝试终止正在执行的 SSH 命令。已完成的远程操作不会撤销。"
          onClose={() => setConfirmCancel(false)}
          onConfirm={cancel}
          busy={busy}
          error={error}
          label="确认取消"
        />
      )}
      {retryTarget && (
        <Confirm
          title="重试此目标"
          description={`将在 ${retryTarget.serverName}（${retryTarget.host}）上使用原任务配置重新执行。请先检查该目标是否已产生需要保留的变更。`}
          onClose={() => !busy && setRetryTarget(undefined)}
          onConfirm={retry}
          busy={busy}
          error={error}
          label="确认重试"
        />
      )}
    </>
  );
}
