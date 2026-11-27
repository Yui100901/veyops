import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
  PanelLeftClose,
  PanelLeftOpen,
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
import { TaskPage, TasksPage } from './pages/operations/Operations';
import { operationsTabForPath, operationsTabs } from './pages/operations/operation-routes';
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
import type { ProjectDetail, User } from './models';
import { projectBreadcrumbs, WorkspaceBreadcrumb } from './WorkspaceBreadcrumb';

const ServersPage = lazy(() =>
  import('./pages/infrastructure/Servers').then(({ ServersPage }) => ({ default: ServersPage })),
);
const ProjectsPage = lazy(() =>
  import('./pages/projects/Projects').then(({ ProjectsPage }) => ({ default: ProjectsPage })),
);
const ProjectWorkspace = lazy(() =>
  import('./pages/projects/ProjectWorkspace').then(({ ProjectWorkspace }) => ({
    default: ProjectWorkspace,
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
const ExecutionFlowTask = lazy(() => import('./pages/operations/ExecutionFlowTask'));
const ServicePortal = lazy(() =>
  import('./pages/projects/ServicePortal').then(({ ServicePortal }) => ({
    default: ServicePortal,
  })),
);
const navigation = [
  { path: '/portal', name: '服务门户', icon: LayoutGrid },
  { path: '/projects', name: '项目发布', icon: FolderGit2 },
  { path: '/operations', name: '运维命令', icon: Terminal },
  { path: '/tasks', name: '任务中心', icon: ListTodo },
  { path: '/servers', name: '服务器', icon: Server },
  { path: '/platform', name: '平台管理', icon: Settings2 },
];
const sidebarPreference = 'veyops:sidebar-collapsed';

const platformPages = [
  { path: '/overview', name: '平台概览', icon: LayoutDashboard },
  { path: '/credentials', name: '凭据中心', icon: KeyRound },
  { path: '/registries', name: '镜像仓库', icon: Boxes },
  { path: '/audit', name: '操作审计', icon: FileClock },
  { path: '/settings', name: '系统设置', icon: Settings2 },
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

function Redirect({ path }: { path: string }) {
  useEffect(() => {
    window.location.replace('#' + path);
  }, [path]);
  return <Loading />;
}

function PlatformNavigation({ selected }: { selected: string }) {
  return (
    <nav className="resource-section-switcher platform-page-nav" aria-label="平台管理">
      {platformPages.map(({ path, name, icon: Icon }) => (
        <a key={path} href={'#' + path} aria-current={path === selected ? 'page' : undefined}>
          <Icon size={17} aria-hidden="true" /> {name}
        </a>
      ))}
    </nav>
  );
}

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(sidebarPreference) === 'true',
  );
  const [navTooltip, setNavTooltip] = useState<{ name: string; left: number; top: number }>();
  const [loggingOut, setLoggingOut] = useState(false);
  const [breadcrumbProject, setBreadcrumbProject] = useState<ProjectDetail>();
  const route = useRoute();
  const [routePath, routeSearch] = route.split('?', 2);
  const [, routeRoot, routeId, routeSection] = routePath.split('/');
  const params = new URLSearchParams(routeSearch);
  const projectRoute = readProjectWorkspace(routePath, routeSearch);
  const flowTaskRoute = /^\/tasks\/flows\/([^/]+)\/([^/]+)$/.exec(routePath);
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
    setNavTooltip(undefined);
    window.scrollTo(0, 0);
  }, [route]);
  function toggleSidebar() {
    const collapsed = !sidebarCollapsed;
    setSidebarCollapsed(collapsed);
    setNavTooltip(undefined);
    localStorage.setItem(sidebarPreference, String(collapsed));
  }
  function showNavigationLabel(name: string, link: HTMLAnchorElement) {
    if (!sidebarCollapsed) return;
    const { right, top, height } = link.getBoundingClientRect();
    setNavTooltip({ name, left: right + 12, top: top + height / 2 });
  }
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
  const platformPage =
    routePath === '/platform'
      ? platformPages[0]
      : platformPages.find(({ path }) => routePath === path || routePath.startsWith(path + '/'));
  const navigationPath = platformPage
    ? '/platform'
    : operationsTab
      ? '/operations'
      : routePath === '/'
        ? '/portal'
        : routePath === '/targets'
          ? '/servers'
          : routePath;
  const current = navigation.find(
    (item) => navigationPath === item.path || navigationPath.startsWith(item.path + '/'),
  );
  const pageTitle =
    routeTitles[routePath] ??
    (operationsTab ? operationsTabs[operationsTab] : undefined) ??
    platformPage?.name ??
    (flowTaskRoute
      ? '执行流详情'
      : routeRoot === 'tasks' && routeId
        ? '任务详情'
        : current?.name) ??
    '页面';
  const breadcrumb = projectRoute
    ? projectBreadcrumbs(
        projectRoute,
        breadcrumbProject?.id === projectRoute.id ? breadcrumbProject : undefined,
      )
    : [
        ...(current && current.name !== pageTitle
          ? [{ label: current.name, href: current.path }]
          : []),
        ...(platformPage && platformPage.name !== pageTitle
          ? [{ label: platformPage.name, href: platformPage.path }]
          : []),
        { label: pageTitle },
      ];
  let page;
  if (routePath === '/' || routePath === '/portal')
    page = <ServicePortal key={route} search={routeSearch} />;
  else if (routePath === '/builds')
    page = <Redirect path={'/projects' + (routeSearch ? '?' + routeSearch : '')} />;
  else if (routePath === '/platform' || routePath === '/overview') page = <DashboardPage />;
  else if (routePath === '/servers' || routePath === '/targets')
    page = <ServersPage user={user} search={routeSearch} />;
  else if (routePath === '/credentials') page = <CredentialsPage user={user} />;
  else if (routePath === '/projects') page = <ProjectsPage user={user} search={routeSearch} />;
  else if (projectRoute)
    page = (
      <ProjectWorkspace
        key={projectRoute.id}
        route={projectRoute}
        user={user}
        onProject={setBreadcrumbProject}
      />
    );
  else if (routePath === '/views' || routePath.startsWith('/views/'))
    page = (
      <Redirect path={routePath === '/views/abnormal' ? '/portal?abnormal=true' : '/portal'} />
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
  else if (routePath === '/registries') page = <RegistriesPage user={user} />;
  else if (operationsTab) page = <OperationsCenterPage tab={operationsTab} user={user} />;
  else if (routePath === '/tasks') page = <TasksPage />;
  else if (flowTaskRoute)
    page = (
      <ExecutionFlowTask
        key={routePath}
        projectId={flowTaskRoute[1]!}
        runId={flowTaskRoute[2]!}
        nodeId={params.get('node') ?? undefined}
        user={user}
      />
    );
  else if (route.startsWith('/tasks/'))
    page = <TaskPage key={route} id={routePath.slice(7)} user={user} search={routeSearch} />;
  else if (routePath === '/audit') page = <AuditPage />;
  else if (routePath === '/settings') page = <SystemPage user={user} />;
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
    <div className={'app-shell' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}>
      {menu && (
        <button className="sidebar-backdrop" aria-label="关闭菜单" onClick={() => setMenu(false)} />
      )}
      <aside id="workspace-sidebar" className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="sidebar-heading">
          <a href="#/" className="brand-link" aria-label="veyops 首页">
            <Brand inverse />
          </a>
          <button
            type="button"
            className="sidebar-collapse-button"
            aria-controls="workspace-sidebar"
            aria-expanded={!sidebarCollapsed}
            aria-label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            title={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            onClick={toggleSidebar}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <div className="workspace-switch">
          <span className="workspace-avatar">V</span>
          <span>
            <strong>默认工作空间</strong>
            <small>个人 / 单团队</small>
          </span>
        </div>
        <nav className="nav-group" aria-label="主导航" onScroll={() => setNavTooltip(undefined)}>
          {navigation.map((item) => (
            <a
              href={`#${item.path}`}
              key={item.path}
              className={item === current ? 'active' : ''}
              aria-label={item.name}
              aria-current={item === current ? 'page' : undefined}
              onPointerEnter={(event) => showNavigationLabel(item.name, event.currentTarget)}
              onPointerLeave={() => setNavTooltip(undefined)}
              onFocus={(event) => showNavigationLabel(item.name, event.currentTarget)}
              onBlur={() => setNavTooltip(undefined)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setNavTooltip(undefined);
              }}
            >
              <item.icon size={18} aria-hidden="true" />
              <span>{item.name}</span>
            </a>
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
      {navTooltip &&
        createPortal(
          <div
            className="sidebar-nav-tooltip"
            role="tooltip"
            style={{ left: navTooltip.left, top: navTooltip.top }}
          >
            {navTooltip.name}
          </div>,
          document.body,
        )}
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-path">
            <button
              className="mobile-menu icon-button bare"
              aria-label={menu ? '关闭菜单' : '打开菜单'}
              aria-controls="workspace-sidebar"
              aria-expanded={menu}
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={20} /> : <Menu size={20} />}
            </button>
            <WorkspaceBreadcrumb items={breadcrumb} />
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
          {platformPage && <PlatformNavigation selected={platformPage.path} />}
          <Suspense fallback={<Loading />}>{page}</Suspense>
        </main>
      </div>
    </div>
  );
}
