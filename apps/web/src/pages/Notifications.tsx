import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, Bell, Check, Mail, RefreshCw, Settings2 } from 'lucide-react';
import { api, formatTime, message, post, useResource } from '../api';
import {
  Empty,
  ErrorBanner,
  Field,
  Loading,
  PageHeader,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type { Credential, Project, User } from '../models';

const notificationsPath = '/notifications';
const unreadChanged = 'veyops:notifications-read';
const levelNames = { NORMAL: '普通', WARNING: '告警', FAILURE: '失败' } as const;
const stageNames = { BUILD: '构建', DEPLOY: '部署', ROLLBACK: '回滚' } as const;
const mailLabels: Record<string, { label: string; tone: string }> = {
  PENDING: { label: '待投递', tone: 'amber' },
  SENDING: { label: '投递中', tone: 'amber' },
  SENT: { label: '已发送', tone: 'green' },
  SKIPPED: { label: '已跳过', tone: 'gray' },
  FAILED: { label: '发送失败', tone: 'red' },
  NEEDS_ATTENTION: { label: '投递结果待核查', tone: 'amber' },
};
type Level = keyof typeof levelNames;
type Stage = keyof typeof stageNames;

interface Notice {
  id: string;
  taskId: string | null;
  projectId: string;
  projectName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  environmentId: string | null;
  environmentName: string | null;
  stage: Stage;
  level: Level;
  status: string;
  summary: {
    success: number;
    failed: number;
    skipped: number;
    needsAttention: number;
    deploymentSkipped: boolean;
    releases: string[];
  };
  readAt: number | null;
  createdAt: number;
  mailStatus: string | null;
}

interface Preferences {
  email: string | null;
  emailEnabled: boolean;
  minimumLevel: Level;
  verifiedAt: number | null;
}

interface Subscription {
  projectId: string;
  stage: Stage;
}

interface SmtpSettings {
  host: string;
  port: number;
  security: 'TLS' | 'STARTTLS' | 'NONE';
  fromEmail: string;
  credentialId: string | null;
  baseUrl: string;
}

function put<T>(path: string, data: unknown) {
  return api<T>(path, { method: 'PUT', body: JSON.stringify(data) });
}

export function NotificationBell({ active }: { active: boolean }) {
  const { data, reload } = useResource<{ unreadCount: number }>(
    notificationsPath + '/unread-count',
    15000,
  );
  useEffect(() => {
    const update = () => {
      void reload();
    };
    window.addEventListener(unreadChanged, update);
    return () => window.removeEventListener(unreadChanged, update);
  }, [reload]);
  const count = data?.unreadCount ?? 0;
  const label = count ? '通知，' + count + ' 条未读' : '通知';
  return (
    <a
      className="icon-button bare notification-bell"
      href="#/notifications"
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
    >
      <Bell size={19} />
      {count > 0 && (
        <span className="notification-count" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </a>
  );
}

function LevelBadge({ level }: { level: Level }) {
  const color = { NORMAL: 'gray', WARNING: 'amber', FAILURE: 'red' }[level];
  return (
    <span className={'status ' + color}>
      <span />
      {levelNames[level]}
    </span>
  );
}

export function NotificationPage() {
  const [level, setLevel] = useState('');
  const [project, setProject] = useState('');
  const [unread, setUnread] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const query = new URLSearchParams();
  if (level) query.set('level', level);
  if (project) query.set('projectId', project);
  if (unread) query.set('unread', unread);
  const notifications = useResource<{ items: Notice[]; unreadCount: number }>(
    notificationsPath + (query.size ? '?' + query.toString() : ''),
    10000,
  );
  const projects = useResource<Project[]>('/projects');
  const unreadCount = notifications.data?.unreadCount ?? 0;
  async function markRead(id?: string) {
    setBusy(true);
    setError('');
    try {
      await api(notificationsPath + (id ? '/' + id + '/read' : '/read-all'), { method: 'PATCH' });
      await notifications.reload();
      window.dispatchEvent(new Event(unreadChanged));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        title="通知"
        description="查看构建、部署和回滚的结果。"
        action={
          <>
            <a className="button secondary" href="#/account/notifications">
              <Settings2 size={16} />
              通知设置
            </a>
            <RefreshButton onClick={notifications.reload} />
          </>
        }
      />
      <ErrorBanner
        error={notifications.error || projects.error || error}
        retry={notifications.error ? notifications.reload : undefined}
      />
      <Section
        title="站内通知"
        subtitle={unreadCount ? unreadCount + ' 条未读' : '没有未读通知'}
        action={
          <button
            className="button secondary small"
            type="button"
            disabled={busy || unreadCount === 0}
            onClick={() => void markRead()}
          >
            <Check size={15} />
            全部标为已读
          </button>
        }
      >
        <div className="notification-filters form-grid">
          <Field label="项目">
            <select value={project} onChange={(event) => setProject(event.target.value)}>
              <option value="">所有项目</option>
              {projects.data?.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="等级">
            <select value={level} onChange={(event) => setLevel(event.target.value)}>
              <option value="">所有等级</option>
              {Object.entries(levelNames).map(([id, label]) => (
                <option value={id} key={id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="阅读状态">
            <select value={unread} onChange={(event) => setUnread(event.target.value)}>
              <option value="">全部</option>
              <option value="true">未读</option>
              <option value="false">已读</option>
            </select>
          </Field>
        </div>
        {notifications.loading ? (
          <Loading />
        ) : !notifications.data?.items.length ? (
          <Empty
            title="暂无匹配的通知"
            description="调整筛选条件，或等待新的交付结果。"
            icon={<Bell size={24} />}
          />
        ) : (
          <ul className="delivery-notices">
            {notifications.data.items.map((notice) => {
              const summary = notice.summary;
              const mail = notice.mailStatus ? mailLabels[notice.mailStatus] : undefined;
              return (
                <li key={notice.id} className={notice.readAt ? '' : 'is-unread'}>
                  <div className="delivery-notice-top">
                    <div className="delivery-notice-labels">
                      {!notice.readAt && (
                        <span className="notice-unread-dot" title="未读" aria-label="未读" />
                      )}
                      <h3>{stageNames[notice.stage]}</h3>
                      <LevelBadge level={notice.level} />
                      <Status value={notice.status} />
                    </div>
                    <time dateTime={new Date(notice.createdAt).toISOString()}>
                      {formatTime(notice.createdAt)}
                    </time>
                  </div>
                  <p>
                    {[notice.projectName, notice.serviceName, notice.environmentName]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </p>
                  <p>
                    成功 {summary.success} · 失败 {summary.failed} · 跳过 {summary.skipped} · 待核查{' '}
                    {summary.needsAttention}
                  </p>
                  {summary.deploymentSkipped && <p>构建阶段结束，部署未开始，当前发布未变更。</p>}
                  {summary.releases.length > 0 && (
                    <p>恢复版本 {summary.releases.join('、')}</p>
                  )}
                  {mail && (
                    <p>
                      邮件投递{' '}
                      <span className={'status ' + mail.tone}>
                        <span />
                        {mail.label}
                      </span>
                    </p>
                  )}
                  <div className="schedule-actions">
                    {notice.taskId && (
                      <a className="text-link" href={'#/tasks/' + notice.taskId}>
                        查看任务
                      </a>
                    )}
                    {!notice.readAt && (
                      <button
                        className="button secondary small"
                        type="button"
                        onClick={() => void markRead(notice.id)}
                        disabled={busy}
                      >
                        标为已读
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </>
  );
}

function EmailPreferences({ value, reload }: { value: Preferences; reload: () => Promise<void> }) {
  const [email, setEmail] = useState(value.email ?? '');
  const [enabled, setEnabled] = useState(value.emailEnabled);
  const [minimum, setMinimum] = useState(value.minimumLevel);
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const savedEmail = value.email === email.trim();
  const verified = savedEmail && !!value.verifiedAt;
  async function change(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setFeedback('');
    setError('');
    try {
      await action();
      await reload();
      setFeedback(success);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextEnabled = verified && enabled;
    await change(async () => {
      const saved = await put<Preferences>(notificationsPath + '/preferences', {
        email: email.trim() || null,
        minimumLevel: minimum,
        emailEnabled: nextEnabled,
      });
      setEmail(saved.email ?? '');
      setEnabled(saved.emailEnabled);
    }, '邮件通知设置已保存。');
  }
  return (
    <Section title="邮件通知">
      <div className="form-body">
        <form className="notification-settings-form" onSubmit={(event) => void save(event)}>
          <Field label="收件邮箱" hint="保存新的邮箱地址后，需要重新验证。">
            <input
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="最低接收等级">
            <select value={minimum} onChange={(event) => setMinimum(event.target.value as Level)}>
              <option value="NORMAL">普通及以上</option>
              <option value="WARNING">告警及以上</option>
              <option value="FAILURE">仅失败</option>
            </select>
          </Field>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={verified && enabled}
              disabled={!verified || busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            接收邮件通知
          </label>
          <div className="schedule-actions">
            <button className="button primary" type="submit" disabled={busy}>
              保存设置
            </button>
            {verified && (
              <span className="status green">
                <span />
                邮箱已验证
              </span>
            )}
          </div>
        </form>
        {!verified && !!value.email && savedEmail && (
          <form
            className="notification-settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void change(async () => {
                await post(notificationsPath + '/email/verify-confirm', { code: code.trim() });
                setCode('');
              }, '邮箱验证成功，可以启用邮件通知。');
            }}
          >
            <Field label="邮件验证码">
              <input
                name="code"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            <div className="schedule-actions">
              <button
                className="button secondary"
                type="button"
                disabled={busy}
                onClick={() =>
                  void change(
                    () => post(notificationsPath + '/email/verify-request'),
                    '已请求发送验证码，请检查收件箱。',
                  )
                }
              >
                发送验证码
              </button>
              <button className="button primary" type="submit" disabled={busy || !code.trim()}>
                验证邮箱
              </button>
            </div>
          </form>
        )}
        <ErrorBanner error={error} />
        {feedback && (
          <p className="field-note" role="status">
            {feedback}
          </p>
        )}
      </div>
    </Section>
  );
}

function ProjectSubscriptions({
  subscriptions,
  projects,
  reload,
}: {
  subscriptions: Subscription[];
  projects: Project[];
  reload: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(
    () => new Set(subscriptions.map((item) => item.projectId + ':' + item.stage)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const stages = Object.keys(stageNames) as Stage[];
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const subscriptions = projects.flatMap(({ id }) =>
        stages
          .filter((stage) => selected.has(id + ':' + stage))
          .map((stage) => ({ projectId: id, stage })),
      );
      await put(notificationsPath + '/subscriptions', { subscriptions });
      await reload();
      setSaved(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="项目订阅" subtitle="按项目选择接收的自动执行通知。">
      {!projects.length ? (
        <Empty title="暂无可订阅的项目" description="有读取权限的项目会显示在这里。" />
      ) : (
        <form onSubmit={(event) => void save(event)} className="form-body">
          <div className="table-scroll notification-subscriptions">
            <table>
              <thead>
                <tr>
                  <th>项目</th>
                  {stages.map((stage) => (
                    <th key={stage} scope="col">
                      {stageNames[stage]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <th scope="row">{project.name}</th>
                    {stages.map((stage) => {
                      const key = project.id + ':' + stage;
                      return (
                        <td key={stage}>
                          <input
                            type="checkbox"
                            aria-label={project.name + ' ' + stageNames[stage]}
                            checked={selected.has(key)}
                            onChange={(event) => {
                              const next = new Set(selected);
                              if (event.target.checked) next.add(key);
                              else next.delete(key);
                              setSelected(next);
                              setSaved(false);
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBanner error={error} />
          {saved && (
            <p className="field-note" role="status">
              项目订阅已保存。
            </p>
          )}
          <div>
            <button className="button primary" type="submit" disabled={busy}>
              保存订阅
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}

export function NotificationPreferencesPage() {
  const preferences = useResource<Preferences>(notificationsPath + '/preferences');
  const subscriptions = useResource<{ subscriptions: Subscription[] }>(
    notificationsPath + '/subscriptions',
  );
  const projects = useResource<Project[]>('/projects');
  return (
    <>
      <PageHeader
        title="通知设置"
        description="管理个人收件邮箱、邮件等级及项目订阅。"
        action={
          <a className="button secondary" href="#/notifications">
            <ArrowLeft size={16} />
            通知
          </a>
        }
      />
      <ErrorBanner error={preferences.error || subscriptions.error || projects.error} />
      {preferences.loading || subscriptions.loading || projects.loading ? (
        <Loading />
      ) : (
        <div className="settings-grid">
          {preferences.data && (
            <EmailPreferences value={preferences.data} reload={preferences.reload} />
          )}
          {subscriptions.data && projects.data && (
            <ProjectSubscriptions
              subscriptions={subscriptions.data.subscriptions}
              projects={projects.data}
              reload={subscriptions.reload}
            />
          )}
        </div>
      )}
    </>
  );
}

function SmtpForm({
  settings,
  reload,
}: {
  settings: SmtpSettings | null;
  reload: () => Promise<void>;
}) {
  const credentials = useResource<Credential[]>('/credentials');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  async function change(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      await action();
      setFeedback(success);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void change(async () => {
      await put(notificationsPath + '/smtp', {
        host: String(data.get('host')).trim(),
        port: Number(data.get('port')),
        security: data.get('security'),
        fromEmail: String(data.get('fromEmail')).trim(),
        credentialId: data.get('credentialId') || null,
        baseUrl: String(data.get('baseUrl')).trim(),
      });
      await reload();
    }, 'SMTP 设置已保存。');
  }
  const applicable =
    credentials.data?.filter((item) =>
      ['USERNAME_PASSWORD', 'CUSTOM_SECRET'].includes(item.type),
    ) ?? [];
  return (
    <Section title="SMTP 发件账户">
      <form className="form-body" onSubmit={save}>
        <div className="form-grid">
          <Field label="SMTP 主机" required>
            <input
              name="host"
              required
              defaultValue={settings?.host}
              placeholder="smtp.example.com"
            />
          </Field>
          <Field label="端口" required>
            <input
              name="port"
              type="number"
              min={1}
              max={65535}
              required
              defaultValue={settings?.port ?? 587}
            />
          </Field>
          <Field label="连接方式">
            <select name="security" defaultValue={settings?.security ?? 'STARTTLS'}>
              <option value="STARTTLS">STARTTLS</option>
              <option value="TLS">TLS</option>
              <option value="NONE">无加密</option>
            </select>
          </Field>
          <Field label="发件邮箱" required>
            <input name="fromEmail" type="email" required defaultValue={settings?.fromEmail} />
          </Field>
          <Field label="认证凭据" hint="使用凭据中心的用户名和密码。">
            <select
              name="credentialId"
              defaultValue={settings?.credentialId ?? ''}
              aria-busy={credentials.loading}
            >
              <option value="">无需认证</option>
              {settings?.credentialId &&
                !applicable.some((item) => item.id === settings.credentialId) && (
                  <option value={settings.credentialId}>已配置的凭据</option>
                )}
              {applicable.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="工作台地址" hint="用于邮件中的任务详情链接。" required>
            <input
              name="baseUrl"
              type="url"
              required
              defaultValue={settings?.baseUrl ?? window.location.origin}
            />
          </Field>
        </div>
        <ErrorBanner error={credentials.error || error} />
        {feedback && (
          <p className="field-note" role="status">
            {feedback}
          </p>
        )}
        <div className="schedule-actions">
          <button className="button primary" type="submit" disabled={busy}>
            保存 SMTP 设置
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={busy || !settings}
            onClick={() =>
              void change(
                () => post(notificationsPath + '/smtp/test'),
                '已保存的 SMTP 设置通过连接测试。',
              )
            }
          >
            <RefreshCw size={16} />
            测试连接
          </button>
        </div>
      </form>
    </Section>
  );
}

export function NotificationSmtpPage({ user }: { user: User }) {
  const canManage = user.role === 'ADMIN';
  const settings = useResource<SmtpSettings | null>(canManage ? notificationsPath + '/smtp' : null);
  return (
    <>
      <PageHeader
        title="SMTP 发件设置"
        description="为邮件通知和邮箱验证配置发件账户。"
        action={
          <a className="button secondary" href="#/settings">
            <ArrowLeft size={16} />
            系统设置
          </a>
        }
      />
      {!canManage ? (
        <Empty
          title="需要管理员权限"
          description="请让管理员配置 SMTP 发件账户。"
          icon={<Mail size={22} />}
        />
      ) : (
        <>
          <ErrorBanner error={settings.error} retry={settings.reload} />
          {settings.loading ? (
            <Loading />
          ) : (
            settings.data !== undefined && (
              <SmtpForm settings={settings.data} reload={settings.reload} />
            )
          )}
        </>
      )}
    </>
  );
}
