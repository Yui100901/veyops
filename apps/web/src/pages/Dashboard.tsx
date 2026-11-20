import { Activity, ArrowRight, FolderGit2, Server, Terminal, TriangleAlert } from 'lucide-react';
import { formatTime, useResource } from '../api';
import {
  CardLink,
  ErrorBanner,
  Loading,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type { Dashboard, DashboardDeployment, Task } from '../models';

const taskTypeNames: Record<string, string> = {
  COMMAND: '临时命令',
  OPERATION_PLAN: '运维方案',
  PIPELINE: '构建与部署',
  GRAPH_CHECKOUT: '执行图源码拉取',
};

export function taskTypeLabel(task: Task) {
  if (task.executionMode === 'DEPLOY_ARTIFACT') return '产物部署';
  if (task.type !== 'PIPELINE') return taskTypeNames[task.type] ?? task.type;
  if (task.deliveryStage === 'BUILD' && task.deployAfterBuild) return '构建阶段';
  if (task.executionMode === 'BUILD_ONLY') return '构建';
  return '构建并部署';
}

export function TaskTable({ tasks, compact = false }: { tasks: Task[]; compact?: boolean }) {
  return (
    <div className="table-scroll">
      <table className={compact ? 'dashboard-task-compact' : undefined}>
        <thead>
          <tr>
            <th scope="col">任务名称</th>
            {!compact && <th scope="col">类型</th>}
            <th scope="col">状态</th>
            {!compact && <th scope="col">创建时间</th>}
            {!compact && <th />}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const type = taskTypeLabel(task);
            return (
              <tr key={task.id}>
                <td>
                  <a href={`#/tasks/${task.id}`} className="table-name">
                    {!compact && (
                      <span className="tiny-icon">
                        <Terminal size={15} />
                      </span>
                    )}
                    {task.name}
                  </a>
                  {compact && (
                    <small className="cell-sub">
                      {type} · {formatTime(task.finishedAt ?? task.createdAt)}
                    </small>
                  )}
                </td>
                {!compact && (
                  <td>
                    <span className="muted">{type}</span>
                  </td>
                )}
                <td>
                  {task.approvalStatus === 'PENDING' ? (
                    <span className="tag">待审批</span>
                  ) : (
                    <Status value={task.status} />
                  )}
                </td>
                {!compact && <td className="muted nowrap">{formatTime(task.createdAt)}</td>}
                {!compact && (
                  <td>
                    <a
                      href={`#/tasks/${task.id}`}
                      className="row-link"
                      aria-label={`查看任务 ${task.name}`}
                    >
                      <ArrowRight size={16} />
                    </a>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const healthNames: Record<string, string> = {
  HEALTHY: '健康检查通过',
  FAILED: '健康检查失败',
  UNKNOWN: '健康状态未知',
  NOT_CHECKED: '未执行健康检查',
};

function DeploymentTable({ rows }: { rows: DashboardDeployment[] }) {
  return (
    <div className="table-scroll">
      <table className="dashboard-deployment-table">
        <thead>
          <tr>
            <th scope="col">项目与服务</th>
            <th scope="col">部署目标</th>
            <th scope="col">部署状态</th>
            <th scope="col">时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <a className="table-name" href={`#/tasks/${row.taskId}`}>
                  {row.serviceName}
                </a>
                <a className="text-link cell-sub" href={`#/projects/${row.projectId}`}>
                  {row.projectName}
                </a>
              </td>
              <td>
                {row.environmentName}
                <small className="cell-sub">{row.serverName}</small>
              </td>
              <td>
                <Status value={row.status} />
                <small className="cell-sub">
                  {healthNames[row.healthStatus ?? 'UNKNOWN'] ?? healthNames.UNKNOWN}
                </small>
              </td>
              <td className="muted">
                {formatTime(row.startedAt ?? row.createdAt)}
                {row.releaseVersion && (
                  <small className="cell-sub mono" title={row.releaseVersion}>
                    {row.releaseVersion.slice(0, 12)}
                  </small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DashboardSummary({ data }: { data: Dashboard }) {
  const stats = [
    {
      label: '服务器',
      value: data.servers.total,
      icon: Server,
      detail: `${data.servers.online} 台最近连接正常`,
      link: '/servers',
      color: 'teal',
    },
    {
      label: '项目',
      value: data.projects,
      icon: FolderGit2,
      detail: `${data.services.total} 个服务`,
      link: '/projects',
      color: 'blue',
    },
    {
      label: '运行中服务',
      value: data.services.running,
      icon: Activity,
      detail: '最近部署成功且健康',
      link: '/deployments',
      color: 'teal',
    },
    {
      label: '异常服务',
      value: data.services.abnormal,
      icon: TriangleAlert,
      detail: '查看异常项目',
      link: '/views/abnormal',
      color: 'red',
    },
  ];
  return (
    <>
      <div className="stats-grid">
        {stats.map((stat) => (
          <a className="stat-card" key={stat.label} href={`#${stat.link}`}>
            <div className="stat-top">
              <span>{stat.label}</span>
              <span className={`stat-icon ${stat.color}`}>
                <stat.icon size={19} />
              </span>
            </div>
            <strong>{stat.value}</strong>
            <p>
              {stat.detail}
              <ArrowRight size={13} />
            </p>
          </a>
        ))}
      </div>
      <div className="dashboard-main">
        <Section
          title="最近部署"
          subtitle="依据最近发布与健康检查"
          action={<CardLink href="/deployments">全部部署</CardLink>}
        >
          {data.recentDeployments.length ? (
            <DeploymentTable rows={data.recentDeployments} />
          ) : (
            <p className="mini-empty">暂无部署记录</p>
          )}
        </Section>
        <Section title="失败任务" subtitle="失败、超时及待检查的执行">
          {data.recentFailedTasks.length ? (
            <TaskTable tasks={data.recentFailedTasks} compact />
          ) : (
            <p className="mini-empty">暂无失败任务</p>
          )}
        </Section>
        <Section
          className="dashboard-wide"
          title="最近任务"
          subtitle={`累计 ${data.totalTasks} 项 · ${data.activeTasks} 项待执行或处理中`}
          action={<CardLink href="/tasks">全部任务</CardLink>}
        >
          {data.recentTasks.length ? (
            <TaskTable tasks={data.recentTasks} />
          ) : (
            <p className="mini-empty">暂无任务记录</p>
          )}
        </Section>
        {(!data.servers.total || !data.projects) && (
          <Section className="dashboard-wide" title="快速开始">
            <div className="dashboard-onboarding">
              {!data.servers.total && <CardLink href="/servers">接入服务器</CardLink>}
              {!data.projects && <CardLink href="/projects">新建项目</CardLink>}
            </div>
          </Section>
        )}
      </div>
      <p className="footnote">服务器和服务状态依据最近记录更新。</p>
    </>
  );
}

export function DashboardPage() {
  const { data, error, loading, reload } = useResource<Dashboard>('/dashboard', 10000);
  return (
    <>
      <PageHeader
        title="工作空间概览"
        description="查看服务器连接、服务健康和近期执行。"
        action={<RefreshButton onClick={reload} />}
      />
      <ErrorBanner error={error} retry={reload} />
      {loading && <Loading />}
      {data && <DashboardSummary data={data} />}
    </>
  );
}
