import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowRight,
  Command,
  FileClock,
  FileCode2,
  GitBranch,
  Boxes,
  Network,
  FolderGit2,
  KeyRound,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  LogOut,
  Menu,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import { ApiError, api, message, post, useRoute } from './api';
import { ErrorBanner, Loading } from './components';
import { DashboardPage } from './pages/Dashboard';
import { CredentialsPage, ProjectPage, ProjectsPage, ServersPage } from './pages/Resources';
import { CommandsPage, PlansPage, TaskPage, TasksPage } from './pages/Operations';
import { AuditPage, SystemPage } from './pages/System';
import { AIPage } from './pages/AI';
import { DeliveryRecordsPage, PipelinesPage, RegistriesPage } from './pages/Delivery';
import { DeploymentTargetsPage } from './pages/DeploymentConfig';
import type { User } from './models';

const navigation = [
  {
    label: '工作空间',
    items: [
      { path: '/', name: '概览', icon: LayoutDashboard },
      { path: '/projects', name: '项目管理', icon: FolderGit2 },
      { path: '/servers', name: '服务器', icon: Server },
    ],
  },
  {
    label: '运维与执行',
    items: [
      { path: '/pipelines', name: 'Pipeline', icon: GitBranch },
      { path: '/deployments', name: '交付记录', icon: Boxes },
      { path: '/commands', name: '命令中心', icon: Terminal },
      { path: '/plans', name: '运维方案', icon: FileCode2 },
      { path: '/tasks', name: '任务中心', icon: ListTodo },
      { path: '/ai', name: 'AI 助手', icon: Sparkles },
    ],
  },
  {
    label: '管理',
    items: [
      { path: '/targets', name: '部署目标', icon: Network },
      { path: '/registries', name: '镜像仓库', icon: Boxes },
      { path: '/credentials', name: '凭据中心', icon: KeyRound },
      { path: '/audit', name: '操作审计', icon: FileClock },
      { path: '/settings', name: '系统设置', icon: Settings2 },
    ],
  },
];

function Brand({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className={`brand ${inverse ? 'inverse' : ''}`}>
      <span className="brand-symbol">
        <Command size={24} strokeWidth={2.2} />
      </span>
      <span>
        veyops<span className="brand-dot">.</span>
      </span>
    </span>
  );
}

function AuthPage({
  initialized,
  onAuthenticated,
}: {
  initialized: boolean;
  onAuthenticated: (user: User) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await post(`/auth/${initialized ? 'login' : 'setup'}`, {
        username: String(form.get('username')),
        password: String(form.get('password')),
      });
      const user = await api<User>('/auth/me');
      onAuthenticated(user);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <Brand inverse />
        <div className="auth-story-content">
          <span className="auth-kicker">
            <span />
            你的基础设施，井然有序
          </span>
          <h1>
            让运维，
            <br />
            回归简单。
          </h1>
          <p>
            服务器、项目与每一次执行。
            <br />
            一个工作空间，连接你的全部运维流程。
          </p>
          <div className="auth-flow">
            <div>
              <Server size={21} />
              <span>连接资源</span>
            </div>
            <i />
            <div>
              <Terminal size={21} />
              <span>统一执行</span>
            </div>
            <i />
            <div>
              <ShieldCheck size={21} />
              <span>全程可溯</span>
            </div>
          </div>
        </div>
        <span className="auth-footer">LIGHTWEIGHT INFRASTRUCTURE WORKSPACE</span>
        <div className="auth-decoration">
          <span />
          <span />
          <span />
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-wrap">
          <span className="eyebrow">{initialized ? 'WELCOME BACK' : 'WELCOME TO VEYOPS'}</span>
          <h2>{initialized ? '欢迎回来' : '创建你的工作空间'}</h2>
          <p>
            {initialized
              ? '登录，继续管理你的基础设施。'
              : '先创建管理员账号，开始接入你的第一台服务器。'}
          </p>
          <form onSubmit={submit}>
            <label className="field">
              <span>用户名</span>
              <input
                name="username"
                required
                autoFocus
                autoComplete="username"
                minLength={2}
                maxLength={64}
                placeholder="输入用户名"
              />
            </label>
            <label className="field">
              <span>{initialized ? '密码' : '设置管理员密码'}</span>
              <input
                name="password"
                type="password"
                required
                autoComplete={initialized ? 'current-password' : 'new-password'}
                minLength={initialized ? 1 : 12}
                maxLength={256}
                placeholder={initialized ? '输入密码' : '至少 12 个字符'}
              />
            </label>
            {!initialized && (
              <p className="auth-hint">管理员可管理凭据、服务器与系统配置。请妥善保存密码。</p>
            )}
            <ErrorBanner error={error} />
            <button className="button primary auth-submit" type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle size={18} className="spin" />
              ) : (
                <>
                  {initialized ? '登录工作空间' : '创建管理员并开始'}
                  <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <div className="auth-trust">
            <ShieldCheck size={16} />
            本地部署 · 安全凭据 · 按角色授权
          </div>
        </div>
        <span className="auth-copyright">veyops · 智能运维工作台</span>
      </main>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [initialized, setInitialized] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const route = useRoute();
  async function boot() {
    setLoading(true);
    setError('');
    try {
      const status = await api<{ initialized: boolean }>('/auth/status');
      setInitialized(status.initialized);
      if (status.initialized) {
        try {
          setUser(await api<User>('/auth/me'));
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 401) throw err;
        }
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void boot();
    const expire = () => {
      setUser(null);
      setInitialized(true);
    };
    window.addEventListener('veyops:session-expired', expire);
    return () => window.removeEventListener('veyops:session-expired', expire);
  }, []);
  useEffect(() => {
    setMenu(false);
    window.scrollTo(0, 0);
  }, [route]);
  async function logout() {
    setLoggingOut(true);
    setError('');
    try {
      await post('/auth/logout');
      setUser(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoggingOut(false);
    }
  }
  if (loading)
    return (
      <div className="boot-page">
        <Brand />
        <Loading />
      </div>
    );
  if (error && !user)
    return (
      <div className="boot-page">
        <Brand />
        <ErrorBanner error={error} retry={boot} />
      </div>
    );
  if (!user)
    return (
      <AuthPage
        initialized={initialized}
        onAuthenticated={(value) => {
          setUser(value);
          setInitialized(true);
        }}
      />
    );
  const current = navigation
    .flatMap((group) => group.items)
    .find((item) => (item.path === '/' ? route === '/' : route.startsWith(item.path)));
  let page;
  if (route === '/') page = <DashboardPage />;
  else if (route === '/servers') page = <ServersPage user={user} />;
  else if (route === '/credentials') page = <CredentialsPage user={user} />;
  else if (route === '/projects') page = <ProjectsPage user={user} />;
  else if (route.startsWith('/projects/'))
    page = <ProjectPage key={route} id={route.slice(10)} user={user} />;
  else if (route === '/pipelines') page = <PipelinesPage user={user} />;
  else if (route === '/artifacts') page = <DeliveryRecordsPage type="artifacts" />;
  else if (route === '/deployments') page = <DeliveryRecordsPage type="deployments" />;
  else if (route === '/targets') page = <DeploymentTargetsPage user={user} />;
  else if (route === '/registries') page = <RegistriesPage user={user} />;
  else if (route === '/commands') page = <CommandsPage user={user} />;
  else if (route === '/plans') page = <PlansPage user={user} />;
  else if (route === '/tasks') page = <TasksPage />;
  else if (route.startsWith('/tasks/'))
    page = <TaskPage key={route} id={route.slice(7)} user={user} />;
  else if (route === '/audit') page = <AuditPage />;
  else if (route === '/settings') page = <SystemPage user={user} />;
  else if (route === '/ai') page = <AIPage user={user} />;
  else
    page = (
      <div className="panel not-found">
        <h1>页面不存在</h1>
        <a className="button primary" href="#/">
          返回概览
        </a>
      </div>
    );
  return (
    <div className="app-shell">
      {menu && (
        <button className="sidebar-backdrop" aria-label="关闭菜单" onClick={() => setMenu(false)} />
      )}
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <a href="#/" className="brand-link" aria-label="veyops 首页">
          <Brand inverse />
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">V</span>
          <span>
            <strong>默认工作空间</strong>
            <small>个人 / 单团队</small>
          </span>
        </div>
        <nav aria-label="主导航">
          {navigation.map((group) => (
            <div className="nav-group" key={group.label}>
              <div className="nav-label">{group.label}</div>
              {group.items.map((item) => (
                <a
                  href={`#${item.path}`}
                  key={item.path}
                  className={
                    (item.path === '/' ? route === '/' : route.startsWith(item.path))
                      ? 'active'
                      : ''
                  }
                  aria-current={
                    (item.path === '/' ? route === '/' : route.startsWith(item.path))
                      ? 'page'
                      : undefined
                  }
                >
                  <item.icon size={18} />
                  <span>{item.name}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-label">
            <span />
            本地运维工作台<span>v0.2.0</span>
          </div>
          <div className="user-card">
            <span className="user-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{user.username}</strong>
              <small>
                {{ ADMIN: '管理员', OPERATOR: '操作员', VIEWER: '只读用户' }[user.role]}
              </small>
            </div>
            <button
              onClick={logout}
              disabled={loggingOut}
              className="logout-button"
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="mobile-menu icon-button bare"
              aria-label={menu ? '关闭菜单' : '打开菜单'}
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span className="topbar-workspace">工作空间</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{route === '/artifacts' ? '构建产物' : (current?.name ?? '页面')}</strong>
          </div>
          <div className="topbar-right">
            <span className="secure-indicator">
              <ShieldCheck size={14} />
              安全会话
            </span>
            <span className="topbar-date">
              {new Intl.DateTimeFormat('zh-CN', {
                month: 'long',
                day: 'numeric',
                weekday: 'short',
              }).format(new Date())}
            </span>
          </div>
        </header>
        <main className="main-content">
          <ErrorBanner error={error} />
          {page}
        </main>
      </div>
    </div>
  );
}
