import { lazy, Suspense, useEffect, useState } from 'react';
import { version as appVersion } from '../../../package.json';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowRight,
  Command,
  FileClock,
  Boxes,
  FolderGit2,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  LoaderCircle,
  LogOut,
  Menu,
  Server,
  Settings2,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import { ApiError, api, message, navigate, post, useRoute } from './api';
import { ErrorBanner, Loading, PageHeader, Section } from './components';
import { AIPage } from './pages/ai/AI';
import { DashboardPage } from './pages/dashboard/Dashboard';
import { CredentialsPage } from './pages/infrastructure/Credentials';
import { ProjectsPage } from './pages/projects/Projects';
import { TaskPage, TasksPage } from './pages/operations/Operations';
import { operationsTabForPath } from './pages/operations/operation-routes';
import { AuditPage } from './pages/settings/Audit';
import { DeliveryRecordsPage } from './pages/delivery/Delivery';
import { RegistriesPage } from './pages/delivery/Registries';
import { LegacyDeliveryLink } from './pages/projects/delivery/ProjectDelivery';
import { readProjectWorkspace } from './pages/projects/project-workspace-route';
import {
  NotificationBell,
  NotificationPage,
  NotificationPreferencesPage,
  NotificationSmtpPage,
} from './pages/notifications/Notifications';
import { userRoleNames } from './models';
import type { User } from './models';

const ServersPage = lazy(() =>
  import('./pages/infrastructure/Servers').then(({ ServersPage }) => ({ default: ServersPage })),
);
const ProjectWorkspace = lazy(() =>
  import('./pages/projects/ProjectWorkspace').then(({ ProjectWorkspace }) => ({
    default: ProjectWorkspace,
  })),
);
const ProjectViewsPage = lazy(() =>
  import('./pages/projects/ProjectViews').then(({ ProjectViewsPage }) => ({
    default: ProjectViewsPage,
  })),
);
const SystemPage = lazy(() =>
  import('./pages/settings/System').then(({ SystemPage }) => ({ default: SystemPage })),
);
const BackupsPage = lazy(() =>
  import('./pages/settings/Backups').then(({ BackupsPage }) => ({ default: BackupsPage })),
);
const UsersPage = lazy(() =>
  import('./pages/settings/Users').then(({ UsersPage }) => ({ default: UsersPage })),
);
const OperationsCenterPage = lazy(() =>
  import('./pages/operations/BatchOperations').then(({ OperationsCenterPage }) => ({
    default: OperationsCenterPage,
  })),
);

const navigation = [
  {
    label: '工作空间',
    items: [
      { path: '/', name: '概览', icon: LayoutDashboard },
      { path: '/projects', name: '项目管理', icon: FolderGit2 },
      { path: '/views', name: '项目视图', icon: LayoutGrid },
      { path: '/servers', name: '服务器', icon: Server },
    ],
  },
  {
    label: '运维与执行',
    items: [
      { path: '/operations', name: '运维中心', icon: Terminal },
      { path: '/tasks', name: '任务中心', icon: ListTodo },
    ],
  },
  {
    label: '管理',
    items: [
      { path: '/registries', name: '镜像仓库', icon: Boxes },
      { path: '/credentials', name: '凭据中心', icon: KeyRound },
      { path: '/audit', name: '操作审计', icon: FileClock },
      { path: '/settings', name: '系统设置', icon: Settings2 },
    ],
  },
];

const routeTitles: Record<string, string> = {
  '/artifacts': '构建产物',
  '/deployments': '交付记录',
  '/settings/users': '用户管理',
  '/settings/backups': '数据备份',
  '/settings/smtp': 'SMTP 发件设置',
  '/account/password': '修改密码',
  '/account/notifications': '通知设置',
  '/ai': 'AI 助手',
  '/notifications': '通知',
};

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

function AuthLayout({ children }: { children: ReactNode }) {
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
          {children}
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

function AuthPage({
  updatedUsername,
  onAuthenticated,
}: {
  updatedUsername?: string;
  onAuthenticated: (user: User) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError('');
    try {
      const user = await post<User>('/auth/login', {
        username: String(values.get('username')),
        password: String(values.get('password')),
      });
      form.reset();
      onAuthenticated(user);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout>
      <h2>登录工作空间</h2>
      {updatedUsername && <p role="status">密码已更新，请使用新密码登录。</p>}
      <form onSubmit={submit}>
        <label className="field">
          <span>用户名</span>
          <input
            name="username"
            required
            autoFocus={!updatedUsername}
            autoComplete="username"
            minLength={2}
            maxLength={64}
            defaultValue={updatedUsername}
            placeholder="例如 root"
          />
        </label>
        <label className="field">
          <span>密码</span>
          <input
            name="password"
            type="password"
            required
            autoFocus={!!updatedUsername}
            autoComplete="current-password"
            maxLength={256}
          />
        </label>
        {!updatedUsername && (
          <p className="auth-hint">
            首次登录使用管理员账号 <code>root</code>
            。使用启动时配置的密码，或在服务启动日志中查看自动生成的初始密码。
          </p>
        )}
        <ErrorBanner error={error} />
        <button className="button primary auth-submit" type="submit" disabled={busy}>
          {busy ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <>
              <span>登录</span>
              <ArrowRight size={17} />
            </>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}

function ChangePasswordPage({
  user,
  onChanged,
  onSkipped,
  onLogout,
  loggingOut,
  logoutError,
}: {
  user: User;
  onChanged: () => void;
  onSkipped: () => void;
  onLogout: () => void;
  loggingOut: boolean;
  logoutError: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const required = user.mustChangePassword;
  const initial = required || user.passwordChangeRecommended;
  async function skip() {
    setBusy(true);
    setError('');
    try {
      await post('/auth/dismiss-password-reminder');
      onSkipped();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const newPassword = String(values.get('newPassword'));
    const currentPassword = String(values.get('currentPassword'));
    if (newPassword !== values.get('confirmation')) {
      setError('两次输入的新密码不一致。');
      form.querySelector<HTMLInputElement>('[name="confirmation"]')?.focus();
      return;
    }
    if (newPassword === currentPassword) {
      setError('新密码必须与当前密码不同。');
      form.querySelector<HTMLInputElement>('[name="newPassword"]')?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post('/auth/change-password', { currentPassword, newPassword });
      form.reset();
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const form = (
    <form onSubmit={submit} className={initial ? undefined : 'form-body'}>
      <input name="username" value={user.username} autoComplete="username" type="hidden" />
      <label className="field">
        <span>当前密码</span>
        <input
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          maxLength={256}
        />
      </label>
      <label className="field">
        <span>新密码</span>
        <input
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={256}
          aria-describedby="new-password-hint"
        />
        <small id="new-password-hint">至少 12 个字符。</small>
      </label>
      <label className="field">
        <span>确认新密码</span>
        <input
          name="confirmation"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={256}
        />
      </label>
      <ErrorBanner error={error || (initial ? logoutError : '')} />
      <button
        className={initial ? 'button primary auth-submit' : 'button primary'}
        type="submit"
        disabled={busy || loggingOut}
      >
        {busy ? (
          <LoaderCircle size={18} className="spin" />
        ) : (
          <>
            <span>更新密码</span>
            <ArrowRight size={17} />
          </>
        )}
      </button>
    </form>
  );
  if (!initial) {
    return (
      <>
        <PageHeader
          title="修改密码"
          description={`更新 ${user.username} 的登录密码。保存后，所有会话会退出登录。`}
          action={
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => navigate('/')}
            >
              返回概览
            </button>
          }
        />
        <Section title="登录密码" className="account-password-panel">
          {form}
        </Section>
      </>
    );
  }
  return (
    <AuthLayout>
      <h2>更新初始密码</h2>
      <p>
        {required
          ? `账号 ${user.username} 需要设置新密码才能进入工作空间。`
          : `建议为账号 ${user.username} 设置新密码。也可跳过，之后在账户设置中修改。`}
      </p>
      {form}
      <div className="auth-actions">
        {!required && (
          <button
            type="button"
            className="button secondary"
            onClick={() => void skip()}
            disabled={busy || loggingOut}
          >
            跳过并进入工作台
          </button>
        )}
        <button
          type="button"
          className="text-button"
          onClick={onLogout}
          disabled={busy || loggingOut}
        >
          <LogOut size={15} />
          退出登录
        </button>
      </div>
    </AuthLayout>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [updatedUsername, setUpdatedUsername] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const route = useRoute();
  const [routePath, routeSearch] = route.split('?', 2);
  const [, routeRoot, routeId, routeSection] = routePath.split('/');
  const params = new URLSearchParams(routeSearch);
  const projectRoute = readProjectWorkspace(routePath, routeSearch);
  async function boot() {
    setLoading(true);
    setError('');
    try {
      setUser(await api<User>('/auth/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null);
      else setError(message(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void boot();
    const expire = () => {
      setUser(null);
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
      if (err instanceof ApiError && err.status === 401) setUser(null);
      else setError(message(err));
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
        updatedUsername={updatedUsername}
        onAuthenticated={(value) => {
          setUpdatedUsername(undefined);
          setUser(value);
        }}
      />
    );
  const changePassword = (
    <ChangePasswordPage
      user={user}
      onChanged={() => {
        if (routePath === '/account/password') navigate('/');
        setUpdatedUsername(user.username);
        setError('');
        setUser(null);
      }}
      onSkipped={() => {
        if (routePath === '/account/password') navigate('/');
        setUser({ ...user, passwordChangeRecommended: false });
      }}
      onLogout={() => void logout()}
      loggingOut={loggingOut}
      logoutError={error}
    />
  );
  if (user.mustChangePassword || user.passwordChangeRecommended) return changePassword;
  const operationsTab = operationsTabForPath(routePath);
  const navigationPath = operationsTab ? '/operations' : routePath;
  const current = navigation
    .flatMap((group) => group.items)
    .find((item) => navigationPath === item.path || navigationPath.startsWith(item.path + '/'));
  let page;
  if (route === '/') page = <DashboardPage />;
  else if (routePath === '/servers' || routePath === '/targets')
    page = <ServersPage user={user} search={routeSearch} />;
  else if (route === '/credentials') page = <CredentialsPage user={user} />;
  else if (route === '/projects') page = <ProjectsPage user={user} />;
  else if (projectRoute)
    page = <ProjectWorkspace key={projectRoute.id} route={projectRoute} user={user} />;
  else if (routePath === '/views' || routePath.startsWith('/views/'))
    page = (
      <ProjectViewsPage user={user} id={routePath.slice(7) || undefined} search={routeSearch} />
    );
  else if (
    (routeRoot === 'artifacts' || routeRoot === 'deployments') &&
    !routeSection &&
    (routeId ||
      ['recordId', 'projectId', 'artifactId', 'deploymentId', 'pipelineRunId', 'taskId'].some(
        (key) => params.has(key),
      ))
  )
    page = <LegacyDeliveryLink key={route} tab={routeRoot} search={routeSearch} id={routeId} />;
  else if (routePath === '/artifacts')
    page = <DeliveryRecordsPage key={route} type="artifacts" user={user} />;
  else if (routePath === '/deployments')
    page = <DeliveryRecordsPage key={route} type="deployments" user={user} />;
  else if (route === '/registries') page = <RegistriesPage user={user} />;
  else if (operationsTab) page = <OperationsCenterPage tab={operationsTab} user={user} />;
  else if (route === '/tasks') page = <TasksPage />;
  else if (route.startsWith('/tasks/'))
    page = <TaskPage key={route} id={routePath.slice(7)} user={user} search={routeSearch} />;
  else if (route === '/audit') page = <AuditPage />;
  else if (route === '/settings') page = <SystemPage user={user} />;
  else if (routePath === '/settings/backups') page = <BackupsPage user={user} />;
  else if (routePath === '/settings/users') page = <UsersPage user={user} />;
  else if (routePath === '/settings/smtp') page = <NotificationSmtpPage user={user} />;
  else if (routePath === '/notifications') page = <NotificationPage />;
  else if (routePath === '/account/notifications') page = <NotificationPreferencesPage />;
  else if (routePath === '/account/password') page = changePassword;
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
      <aside id="workspace-sidebar" className={`sidebar ${menu ? 'open' : ''}`}>
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
                  className={item === current ? 'active' : ''}
                  aria-current={item === current ? 'page' : undefined}
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
            本地运维工作台<span>v{appVersion}</span>
          </div>
          <div className="user-card">
            <span className="user-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <div>
              <strong>{user.username}</strong>
              <small>{userRoleNames[user.role]}</small>
            </div>
            <a
              className="account-action"
              href="#/account/password"
              aria-label="修改密码"
              aria-current={routePath === '/account/password' ? 'page' : undefined}
              title="修改密码"
            >
              <KeyRound size={16} />
            </a>
            <button
              onClick={logout}
              disabled={loggingOut}
              className="account-action"
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
              aria-controls="workspace-sidebar"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span className="topbar-workspace">工作空间</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{routeTitles[routePath] ?? current?.name ?? '页面'}</strong>
          </div>
          <div className="topbar-right">
            <NotificationBell key={user.id} active={routePath === '/notifications'} />
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
          <Suspense fallback={<Loading />}>{page}</Suspense>
        </main>
      </div>
    </div>
  );
}
