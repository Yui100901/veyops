import { lazy, Suspense, useEffect, useRef, useState, type Ref } from 'react';
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
import {
  activeTask,
  formatTime,
  message,
  navigate,
  post,
  useResource,
  useTaskLogs,
} from '../../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Loading,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../../components';
import type { Task, TaskTarget, User } from '../../models';
import { TaskTable, taskTypeLabel } from './TaskTable';
import { deliveryPath, deliveryTaskReturn, readDeliveryScope } from '../delivery/delivery-route';
import { ContextAIButton } from '../ai/AI';
import { FailureHandling } from '../delivery/FailureHandling';
import { RunArtifacts } from '../delivery/Delivery';
import type { DeliveryLogSelection, DeliveryTaskStep } from '../delivery/DeliveryTaskStages';

const DeliveryTaskStages = lazy(() => import('../delivery/DeliveryTaskStages'));

function renderTaskLog(
  content: string,
  steps: DeliveryTaskStep[] | undefined,
  stepId: string | undefined,
  selection: Ref<HTMLElement>,
) {
  const nodeSteps = new Set(
    steps?.filter((step) => step.key.startsWith('node:')).map((step) => step.id),
  );
  const segments = content.split(/\[node:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\] /g);
  return segments.flatMap((segment, index) => {
    if (index % 2) return nodeSteps.has(segment) ? [] : [`[node:${segment}] `];
    if (!stepId || segments[index - 1] !== stepId) return [segment];
    const lineBreak = segment.indexOf('\n');
    const end = lineBreak === -1 ? segment.length : lineBreak;
    return [
      <mark className="delivery-task-log-marker" key={stepId} ref={selection}>
        {segment.slice(0, end)}
      </mark>,
      segment.slice(end),
    ];
  });
}

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
        action={
          <>
            <a className="button secondary" href="#/operations/schedules">
              <Clock3 size={16} /> 定时运维
            </a>
            <RefreshButton onClick={resource.reload} />
          </>
        }
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
            description="从运维中心提交命令，或运行一个可复用的运维方案。"
            action={
              <a className="button primary" href="#/operations">
                <Terminal size={16} />
                打开运维中心
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

export function TaskPage({ id, user, search }: { id: string; user: User; search?: string }) {
  const task = useResource<Task>(`/tasks/${id}`, 2000);
  const targets = useResource<TaskTarget[]>(`/tasks/${id}/targets`, 2000);
  const logs = useTaskLogs(id);
  const steps = useResource<DeliveryTaskStep[]>(`/tasks/${id}/steps`, 2000);
  const logPanel = useRef<HTMLPreElement>(null);
  const logMarker = useRef<HTMLElement>(null);
  const [logSelection, setLogSelection] = useState<DeliveryLogSelection>();
  const [resultsOpen, setResultsOpen] = useState(true);
  const [wrapLogs, setWrapLogs] = useState(true);
  const selectedStepId = logSelection?.step.id;
  const selectedLogPresent =
    !!selectedStepId && logs.data.content.includes(`[node:${selectedStepId}] `);
  useEffect(() => {
    if (selectedLogPresent) logMarker.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedStepId, selectedLogPresent]);
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
  const scope = readDeliveryScope(new URLSearchParams(search));
  const deliveryScope = {
    serviceId: value.serviceId,
    environmentId: value.environmentId,
    view: scope.view,
  };
  const returnToDelivery = value.projectId && deliveryTaskReturn(value.projectId, search);
  const analysis = value.result?.aiAnalysis;
  const failed = ['FAILED', 'PARTIAL_FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'].includes(
    value.status,
  );
  const canInspectFailure = Boolean(
    value.projectId || user.role === 'ADMIN' || value.createdBy === user.id,
  );
  const failedPhase = analysis?.status === 'SUCCESS' && analysis.failedPhase;
  const nodeTypes = new Map(
    value.pipelineGraph?.nodes.map((node) => [`node:${node.id}`, node.type]),
  );
  const failedStep =
    failedPhase &&
    steps.data?.find(
      (step) =>
        (nodeTypes.get(step.key) ?? step.key.split(':')[0]) === failedPhase &&
        ['FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'].includes(step.status),
    );
  return (
    <>
      <a
        href={
          returnToDelivery
            ? '#' + returnToDelivery
            : value.type === 'PIPELINE' && value.projectId
              ? '#' + `/projects/${value.projectId}/execution-graph?pane=history`
              : '#/tasks'
        }
        className="back-link"
      >
        <ArrowLeft size={14} />
        {returnToDelivery
          ? '返回交付记录'
          : value.type === 'PIPELINE' && value.projectId
            ? '返回项目执行记录'
            : '返回任务中心'}
      </a>
      <PageHeader
        eyebrow="TASK DETAILS"
        title={value.name}
        description={`任务 ID · ${id}`}
        action={
          <>
            {value.approvalStatus === 'PENDING' ? (
              <span className="tag">待审批</span>
            ) : (
              <Status value={value.status} />
            )}
            {value.canReuseCommand &&
              (user.role === 'ADMIN' ||
                (user.role === 'OPERATOR' && value.createdBy === user.id)) && (
                <a className="button secondary" href={`#/operations/commands?reuse=${id}`}>
                  沿用目标和命令
                </a>
              )}
            {failed && canInspectFailure && (
              <ContextAIButton
                user={user}
                projectId={value.projectId ?? undefined}
                context={{ kind: 'TASK', taskId: id }}
                objectName={value.name}
              />
            )}
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
        <span className="tag">{taskTypeLabel(value)}</span>
        {value.type === 'PIPELINE' && (
          <>
            {(value.executionMode !== 'DEPLOY_ARTIFACT' || value.sourceBuildTaskId) && (
              <a
                className="text-link"
                href={
                  value.projectId
                    ? '#' +
                      deliveryPath(value.projectId, 'artifacts', {
                        ...deliveryScope,
                        taskId: value.sourceBuildTaskId || value.id,
                      })
                    : '#/artifacts'
                }
              >
                构建产物 →
              </a>
            )}
            {value.executionMode !== 'BUILD_ONLY' && (
              <a
                className="text-link"
                href={
                  value.projectId
                    ? '#' +
                      deliveryPath(value.projectId, 'deployments', {
                        ...deliveryScope,
                        taskId: value.deploymentTaskId || value.id,
                      })
                    : '#/deployments'
                }
              >
                部署记录 →
              </a>
            )}
          </>
        )}
        {value.sourceBuildTaskId && (
          <a className="text-link" href={`#/tasks/${value.sourceBuildTaskId}`}>
            来源构建任务 →
          </a>
        )}
        {value.deploymentTaskId && (
          <a className="text-link" href={`#/tasks/${value.deploymentTaskId}`}>
            关联部署任务 →
          </a>
        )}
      </div>
      {value.approvalStatus === 'PENDING' && (
        <p className="field-note">
          此发布在管理员批准后开始执行。
          {user.role === 'ADMIN' && (
            <a
              className="text-link"
              href={
                value.projectId
                  ? '#' +
                    deliveryPath(value.projectId, 'approvals', {
                      ...deliveryScope,
                      recordId: value.id,
                    })
                  : '#/deployments'
              }
            >
              查看待审批发布 →
            </a>
          )}
        </p>
      )}
      {(value.errorSummary || value.errorMessage) && (
        <ErrorBanner error={value.errorSummary || value.errorMessage} />
      )}
      {value.deploymentSkippedReason && (
        <p className="field-note">已跳过部署 · {value.deploymentSkippedReason}</p>
      )}
      {value.pipelineGraph && (
        <Suspense fallback={<Loading />}>
          <DeliveryTaskStages
            task={value}
            graph={value.pipelineGraph}
            targets={targets.data ?? []}
            steps={steps.data}
            stepsError={steps.error}
            retrySteps={steps.reload}
            selectedStepId={selectedStepId}
            onLog={(selection) => {
              setLogSelection(selection);
              logPanel.current?.focus();
              if (selectedStepId === selection.step.id)
                logMarker.current?.scrollIntoView({ block: 'nearest' });
            }}
          />
        </Suspense>
      )}
      {value.pipelineRunId && value.executionMode !== 'DEPLOY_ARTIFACT' && (
        <RunArtifacts
          key={value.pipelineRunId}
          runId={value.pipelineRunId}
          polling={activeTask(value.status)}
        />
      )}
      {value.type === 'PIPELINE' && value.serviceId && value.environmentId && failed && (
        <FailureHandling
          user={user}
          serviceId={value.serviceId}
          environmentId={value.environmentId}
          taskId={id}
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
        <Section
          title="目标执行结果"
          subtitle={targets.data ? `共 ${targets.data.length} 台服务器` : undefined}
          action={
            <button
              type="button"
              className="button small secondary"
              aria-controls="task-target-results"
              aria-expanded={resultsOpen}
              onClick={() => setResultsOpen(!resultsOpen)}
            >
              {resultsOpen ? '收起结果' : '展开结果'}
            </button>
          }
        >
          <div id="task-target-results" hidden={!resultsOpen}>
            <ErrorBanner error={targets.error} />
            {targets.loading ? (
              <Loading />
            ) : !targets.data?.length ? (
              <p className="mini-empty">当前任务没有远程目标。</p>
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
          </div>
        </Section>
        <Section
          title="执行日志"
          subtitle={activeTask(value.status) ? '每 2 秒同步任务日志' : '查看保存的任务执行日志'}
          action={
            <div className="row-actions">
              <button
                type="button"
                className="button small secondary"
                aria-pressed={wrapLogs}
                onClick={() => setWrapLogs(!wrapLogs)}
              >
                自动换行
              </button>
              <RefreshButton onClick={logs.reload} />
            </div>
          }
          className="logs-panel"
        >
          <ErrorBanner error={logs.error} />
          {logSelection && (
            <p className="delivery-task-log-selection" id="delivery-log-selection" role="status">
              选中节点 · {logSelection.targetName} / {logSelection.step.name}
              {' · '}
              {selectedLogPresent ? '已定位到节点开始处' : '查看当前保留的任务日志'}
            </p>
          )}
          <pre
            className={`task-logs${wrapLogs ? '' : ' task-logs-nowrap'}`}
            aria-label="执行日志"
            aria-describedby={logSelection ? 'delivery-log-selection' : undefined}
            ref={logPanel}
            tabIndex={0}
          >
            {logs.data.content
              ? value.pipelineGraph
                ? renderTaskLog(logs.data.content, steps.data, selectedStepId, logMarker)
                : logs.data.content
              : activeTask(value.status)
                ? '等待 Worker 输出日志…'
                : '这个任务暂无日志。'}
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
                  <tr
                    key={step.id}
                    className={
                      selectedStepId === step.id ? 'delivery-task-selected-step' : undefined
                    }
                  >
                    <td>
                      {step.serverId === 'manager' ||
                      (step.key.startsWith('node:') &&
                        value.deliveryStage === 'BUILD' &&
                        value.pipelineGraph?.buildLocation === 'MANAGER')
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
