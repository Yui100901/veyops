import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  FileCode2,
  ListTodo,
  LoaderCircle,
  Play,
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
  Field,
  Loading,
  Modal,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type { Plan, Server, Task, TaskTarget, User } from '../models';
import { TaskTable } from './Dashboard';

function ServerPicker({
  servers,
  selected,
  setSelected,
  disabled,
}: {
  servers: Server[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="server-picker">
      {servers.length ? (
        servers.map((server) => (
          <label
            className={`server-option ${selected.includes(server.id) ? 'selected' : ''}`}
            key={server.id}
          >
            <input
              type="checkbox"
              checked={selected.includes(server.id)}
              disabled={disabled}
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? [...selected, server.id]
                    : selected.filter((id) => id !== server.id),
                )
              }
            />
            <ServerIcon size={17} />
            <span>
              <strong>{server.name}</strong>
              <small>{server.host}</small>
            </span>
            <Status value={server.status} />
          </label>
        ))
      ) : (
        <div className="mini-empty">
          还没有服务器。<a href="#/servers">接入服务器</a>
        </div>
      )}
    </div>
  );
}

export function CommandsPage({ user }: { user: User }) {
  const servers = useResource<Server[]>('/servers');
  const [selected, setSelected] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [name, setName] = useState('');
  const [timeout, setTimeoutValue] = useState(300);
  const [strategy, setStrategy] = useState('PARALLEL');
  const [maxParallel, setMaxParallel] = useState(3);
  const [failurePolicy, setFailurePolicy] = useState('CONTINUE');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEdit = user.role !== 'VIEWER';
  async function execute() {
    setBusy(true);
    setError('');
    try {
      const task = await post<Task>('/commands/execute', {
        name: name.trim() || '临时命令',
        command,
        serverIds: selected,
        timeout,
        strategy,
        maxParallel: strategy === 'SEQUENTIAL' ? 1 : maxParallel,
        failurePolicy,
        confirmed: true,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  function preview() {
    setError('');
    if (!selected.length) {
      setError('请选择至少一台目标服务器。');
      return;
    }
    if (!command.trim()) {
      setError('请输入需要执行的命令。');
      return;
    }
    setConfirming(true);
  }
  return (
    <>
      <PageHeader
        eyebrow="COMMAND CENTER"
        title="命令中心"
        description="一次输入，多台执行。每一个目标、每一行日志，都清晰可见。"
        action={
          <a href="#/plans" className="button secondary">
            <FileCode2 size={16} />
            运维方案
            <ArrowRight size={15} />
          </a>
        }
      />
      <ErrorBanner
        error={servers.error || (!confirming ? error : '')}
        retry={servers.error ? servers.reload : undefined}
      />
      {!canEdit && (
        <div className="info-strip">
          <ShieldCheck size={18} />
          <p>当前账号为只读角色，可查看执行记录，不能提交服务器命令。</p>
        </div>
      )}
      <div className="command-layout">
        <div>
          <Section
            title="目标服务器"
            subtitle="明确选择执行目标，不会自动选中全部服务器。"
            action={<span className="selected-count">已选择 {selected.length} 台</span>}
          >
            {servers.loading ? (
              <Loading />
            ) : (
              <ServerPicker
                servers={servers.data ?? []}
                selected={selected}
                setSelected={setSelected}
                disabled={!canEdit}
              />
            )}
          </Section>
          <Section title="执行策略" subtitle="同一个父任务内，独立记录每台服务器的结果">
            <div className="form-body">
              <div className="form-grid">
                <Field label="执行方式">
                  <select
                    value={strategy}
                    onChange={(event) => setStrategy(event.target.value)}
                    disabled={!canEdit}
                  >
                    <option value="PARALLEL">并行执行</option>
                    <option value="SEQUENTIAL">顺序执行</option>
                  </select>
                </Field>
                <Field label="最大并发">
                  <input
                    type="number"
                    value={strategy === 'SEQUENTIAL' ? 1 : maxParallel}
                    min={1}
                    max={10}
                    disabled={strategy === 'SEQUENTIAL' || !canEdit}
                    onChange={(event) => setMaxParallel(Number(event.target.value))}
                  />
                </Field>
              </div>
              <div className="form-grid">
                <Field label="单目标超时（秒）">
                  <input
                    type="number"
                    value={timeout}
                    min={1}
                    max={3600}
                    disabled={!canEdit}
                    onChange={(event) => setTimeoutValue(Number(event.target.value))}
                  />
                </Field>
                <Field label="目标失败后">
                  <select
                    value={failurePolicy}
                    onChange={(event) => setFailurePolicy(event.target.value)}
                    disabled={!canEdit}
                  >
                    <option value="CONTINUE">继续其他目标</option>
                    <option value="STOP">停止剩余目标</option>
                  </select>
                </Field>
              </div>
            </div>
          </Section>
        </div>
        <div>
          <Section
            title="Shell 命令"
            subtitle="以服务器配置的 SSH 用户身份执行"
            action={<span className="code-language">SHELL</span>}
          >
            <div className="command-editor">
              <div className="editor-bar">
                <span />
                <span />
                <span />
                <span className="editor-title">远程命令 · SSH</span>
              </div>
              <textarea
                aria-label="Shell 命令"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={!canEdit}
                placeholder={'# 输入单行命令或多行 Shell 脚本\n# 例如：uname -a && uptime'}
                spellCheck={false}
              />
            </div>
            <div className="command-options">
              <Field label="任务名称（可选）">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如 检查服务器运行状态"
                  disabled={!canEdit}
                  maxLength={100}
                />
              </Field>
              <div className="command-submit">
                <span>
                  <ShieldCheck size={16} />
                  执行前需确认命令和目标
                </span>
                <button
                  className="button primary"
                  disabled={!canEdit || !selected.length || !command.trim()}
                  onClick={preview}
                >
                  <Play size={16} />
                  预览并执行
                </button>
              </div>
            </div>
          </Section>
          <div className="command-note">
            <Terminal size={20} />
            <div>
              <strong>命令执行，不是交互式终端</strong>
              <p>
                支持多行 Shell、超时与任务取消。请使用无需交互输入的命令，并在执行前核对权限和目标。
              </p>
            </div>
          </div>
        </div>
      </div>
      {confirming && (
        <Confirm
          title="确认执行远程命令"
          description={`即将在明确选择的 ${selected.length} 台服务器上执行以下命令。请核对所有目标和命令内容。`}
          onClose={() => {
            if (!busy) setConfirming(false);
          }}
          onConfirm={execute}
          label={busy ? '正在提交…' : `确认执行 · ${selected.length} 台服务器`}
          busy={busy}
          error={error}
          detail={
            <>
              <div className="confirmation-targets">
                {(servers.data ?? [])
                  .filter((server) => selected.includes(server.id))
                  .map((server) => (
                    <span key={server.id}>
                      <ServerIcon size={14} />
                      {server.name}
                      <small>{server.host}</small>
                    </span>
                  ))}
              </div>
              <pre className="code-preview">{command}</pre>
              <div className="confirmation-meta">
                <span>{strategy === 'PARALLEL' ? `${maxParallel} 台并发` : '顺序执行'}</span>
                <span>超时 {timeout} 秒</span>
                <span>{failurePolicy === 'CONTINUE' ? '失败继续' : '失败停止'}</span>
              </div>
            </>
          }
        />
      )}
    </>
  );
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
      name: string;
      order: number;
      status: string;
      exitCode: number | null;
    }[]
  >(`/tasks/${id}/steps`, 2000);
  const [confirmCancel, setConfirmCancel] = useState(false);
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
  if (task.loading) return <Loading />;
  if (!task.data)
    return <ErrorBanner error={task.error || '找不到这个任务。'} retry={task.reload} />;
  const value = task.data;
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
                onClick={() => setConfirmCancel(true)}
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
        <span className="tag">{value.type === 'PIPELINE' ? 'Pipeline' : value.type}</span>
        {value.type === 'PIPELINE' && (
          <>
            <a className="text-link" href="#/artifacts">
              构建产物 →
            </a>
            <a className="text-link" href="#/deployments">
              部署记录 →
            </a>
          </>
        )}
      </div>
      {(value.errorSummary || value.errorMessage) && (
        <ErrorBanner error={value.errorSummary || value.errorMessage} />
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
    </>
  );
}

export function PlansPage({ user }: { user: User }) {
  const plans = useResource<Plan[]>('/operation-plans');
  const servers = useResource<Server[]>('/servers');
  const [selectedPlan, setSelectedPlan] = useState<Plan>();
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setSelected([]);
    setConfirming(false);
    setError('');
  }, [selectedPlan?.id]);
  async function run() {
    if (!selectedPlan) return;
    setBusy(true);
    setError('');
    try {
      const task = await post<Task>(`/operation-plans/${selectedPlan.id}/run`, {
        serverIds: selected,
        confirmed: true,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="REUSABLE OPERATIONS"
        title="运维方案"
        description="把重复操作沉淀为版本化步骤，通过统一任务引擎执行。"
        action={
          <a href="#/commands" className="button secondary">
            <Terminal size={16} />
            临时命令
          </a>
        }
      />
      <ErrorBanner error={plans.error} retry={plans.reload} />
      {plans.loading ? (
        <Loading />
      ) : !plans.data?.length ? (
        <div className="panel">
          <Empty
            icon={<FileCode2 size={25} />}
            title="暂无运维方案"
            description="系统初始化后会提供巡检模板，也可通过 API 创建自定义多步骤方案。"
          />
        </div>
      ) : (
        <div className="plans-grid">
          {plans.data.map((plan) => (
            <section className="plan-card" key={plan.id}>
              <div className="plan-card-heading">
                <span className="resource-avatar">
                  <FileCode2 size={22} />
                </span>
                <span className="tag">v{plan.currentVersion ?? plan.version ?? 1}</span>
              </div>
              <h2>{plan.name}</h2>
              <p>{plan.description || '可重复执行的多步骤运维方案。'}</p>
              <ol>
                {plan.steps?.slice(0, 4).map((step, index) => (
                  <li key={index}>
                    <span>{index + 1}</span>
                    {step.name}
                  </li>
                ))}
              </ol>
              <div className="plan-card-footer">
                <span>{plan.steps?.length ?? 0} 个步骤</span>
                <button className="text-button" onClick={() => setSelectedPlan(plan)}>
                  {user.role === 'VIEWER' ? '查看方案' : '查看并运行'}
                  <ChevronRight size={15} />
                </button>
              </div>
            </section>
          ))}
        </div>
      )}
      {selectedPlan && (
        <Modal
          title={selectedPlan.name}
          description={`固定使用当前方案 v${selectedPlan.currentVersion ?? selectedPlan.version ?? 1}，按步骤执行。`}
          onClose={() => {
            if (!busy) setSelectedPlan(undefined);
          }}
          wide
        >
          <div className="form-body">
            <ErrorBanner error={servers.error || error} />
            <div className="plan-steps">
              {selectedPlan.steps?.map((step, index) => (
                <div key={index}>
                  <h3>
                    <span>{index + 1}</span>
                    {step.name}
                  </h3>
                  <pre className="code-preview">{step.command}</pre>
                </div>
              ))}
            </div>
            {!confirming ? (
              <>
                <h3 className="field-title">选择执行目标</h3>
                <ServerPicker
                  servers={servers.data ?? []}
                  selected={selected}
                  setSelected={setSelected}
                  disabled={user.role === 'VIEWER'}
                />
              </>
            ) : (
              <div className="confirmation-summary">
                <CheckCheck size={22} />
                <div>
                  <strong>将对 {selected.length} 台服务器执行此方案</strong>
                  <p>
                    {(servers.data ?? [])
                      .filter((server) => selected.includes(server.id))
                      .map((server) => server.name)
                      .join('、')}
                  </p>
                  <p>请核对以上全部步骤。执行操作可能会修改服务器环境。</p>
                </div>
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              onClick={() => (confirming ? setConfirming(false) : setSelectedPlan(undefined))}
              disabled={busy}
            >
              {confirming ? '返回选择' : '关闭'}
            </button>
            {user.role !== 'VIEWER' && (
              <button
                className="button primary"
                disabled={!selected.length || busy}
                onClick={() => (confirming ? run() : setConfirming(true))}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : confirming ? (
                  <Check size={16} />
                ) : (
                  <Play size={16} />
                )}
                {confirming ? `确认执行 · ${selected.length} 台` : '预览执行目标'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
