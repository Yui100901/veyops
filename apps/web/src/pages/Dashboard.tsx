import {
  ArrowRight,
  Box,
  Check,
  CircleDashed,
  Command,
  FolderGit2,
  KeyRound,
  Layers3,
  ListTodo,
  Plus,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { formatTime, useResource } from '../api';
import { CardLink, ErrorBanner, Loading, PageHeader, Section, Status } from '../components';
import type { Dashboard, Task } from '../models';

export function TaskTable({ tasks }: { tasks: Task[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>任务名称</th>
            <th>类型</th>
            <th>状态</th>
            <th>创建时间</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td>
                <a href={`#/tasks/${task.id}`} className="table-name">
                  <span className="tiny-icon">
                    <Terminal size={15} />
                  </span>
                  {task.name}
                </a>
              </td>
              <td>
                <span className="muted">
                  {(
                    {
                      COMMAND: '临时命令',
                      OPERATION_PLAN: '运维方案',
                      PIPELINE: 'Pipeline',
                    } as Record<string, string>
                  )[task.type] ?? task.type}
                </span>
              </td>
              <td>
                <Status value={task.status} />
              </td>
              <td className="muted nowrap">{formatTime(task.createdAt)}</td>
              <td>
                <a
                  href={`#/tasks/${task.id}`}
                  className="row-link"
                  aria-label={`查看任务 ${task.name}`}
                >
                  <ArrowRight size={16} />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const { data, error, loading, reload } = useResource<Dashboard>('/dashboard', 10000);
  if (loading) return <Loading />;
  const hasServers = (data?.servers.total ?? 0) > 0;
  const hasProjects = (data?.projects ?? 0) > 0;
  const stats = [
    {
      label: '服务器',
      value: data?.servers.total ?? '—',
      icon: Server,
      detail: `${data?.servers.online ?? 0} 台最近连接正常`,
      link: '/servers',
      color: 'teal',
    },
    {
      label: '项目',
      value: data?.projects ?? '—',
      icon: FolderGit2,
      detail: '代码、服务与环境的组织中心',
      link: '/projects',
      color: 'blue',
    },
    {
      label: '运行中任务',
      value: data?.activeTasks ?? '—',
      icon: Layers3,
      detail: '统一执行引擎持续处理',
      link: '/tasks',
      color: 'amber',
    },
    {
      label: '累计任务',
      value: data?.totalTasks ?? '—',
      icon: ListTodo,
      detail: '每次操作均可追溯',
      link: '/tasks',
      color: 'violet',
    },
  ];
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE OVERVIEW"
        title="工作空间概览"
        description="连接你的基础设施，让每一次运维都有迹可循。"
        action={
          <a className="button primary" href="#/servers">
            <Plus size={17} />
            接入服务器
          </a>
        }
      />
      <ErrorBanner error={error} retry={reload} />
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
        <div className="dashboard-content">
          <Section
            title="快速开始"
            subtitle="从资源接入到批量执行，建立你的运维工作流"
            action={<span className="pill">起步指南</span>}
          >
            <div className="onboarding">
              <a href="#/credentials" className="onboarding-item">
                <span className="step-number">
                  <KeyRound size={18} />
                </span>
                <div>
                  <strong>创建安全凭据</strong>
                  <p>集中管理 SSH 密码和私钥，加密保存。</p>
                </div>
                <ArrowRight size={17} />
              </a>
              <a href="#/servers" className="onboarding-item">
                <span className={`step-number ${hasServers ? 'done' : ''}`}>
                  {hasServers ? <Check size={18} /> : <Server size={18} />}
                </span>
                <div>
                  <strong>接入服务器</strong>
                  <p>验证主机指纹，建立可信 SSH 连接。</p>
                </div>
                {hasServers ? <span className="done-label">已接入</span> : <ArrowRight size={17} />}
              </a>
              <a href="#/commands" className="onboarding-item">
                <span className="step-number">
                  <Terminal size={18} />
                </span>
                <div>
                  <strong>执行第一次运维任务</strong>
                  <p>明确目标、确认命令，实时追踪每台服务器。</p>
                </div>
                <ArrowRight size={17} />
              </a>
            </div>
          </Section>
          <Section
            title="最近任务"
            subtitle="统一查看命令与运维方案的执行记录"
            action={<CardLink href="/tasks">全部任务</CardLink>}
          >
            {data?.recentTasks.length ? (
              <TaskTable tasks={data.recentTasks} />
            ) : (
              <div className="compact-empty">
                <div className="empty-line-icon">
                  <CircleDashed size={28} />
                </div>
                <strong>一切准备就绪</strong>
                <p>提交第一条命令后，执行记录将显示在这里。</p>
                <a href="#/commands" className="text-link">
                  前往命令中心
                  <ArrowRight size={14} />
                </a>
              </div>
            )}
          </Section>
        </div>
        <aside className="dashboard-aside">
          <section className="dark-card">
            <span className="dark-card-icon">
              <Command size={23} />
            </span>
            <div className="eyebrow">ONE WORKSPACE. ALL OPERATIONS.</div>
            <h2>
              把繁琐的运维
              <br />
              变成清晰的流程。
            </h2>
            <p>通过同一个执行引擎，管理多台服务器、批量命令与可复用的运维方案。</p>
            <a href="#/plans">
              探索运维方案
              <ArrowRight size={16} />
            </a>
            <div className="dark-card-art">
              <span />
              <span />
              <span />
              <Box size={65} />
            </div>
          </section>
          <Section title="工作空间状态">
            <div className="workspace-check">
              <span>
                <ShieldCheck size={17} />
                凭据保护
              </span>
              <span className="small-tag">AES-256-GCM</span>
            </div>
            <div className="workspace-check">
              <span>
                <Server size={17} />
                服务器状态
              </span>
              <span>{data?.servers.unknown ?? 0} 台未检测</span>
            </div>
            <div className="workspace-check">
              <span>
                <FolderGit2 size={17} />
                项目接入
              </span>
              <span>{hasProjects ? `${data?.projects} 个项目` : '等待创建'}</span>
            </div>
          </Section>
          <a href="#/ai" className="ai-teaser">
            <Sparkles size={20} />
            <div>
              <strong>AI 运维助手</strong>
              <span>查询资源、生成草稿与确认执行</span>
            </div>
            <ArrowRight size={16} />
          </a>
        </aside>
      </div>
      <p className="footnote">服务器状态表示最近一次连接检测结果；此版本不提供持续实时监控。</p>
    </>
  );
}
