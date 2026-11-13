import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  FileCode2,
  KeyRound,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  PlugZap,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react';
import { api, formatTime, message, navigate, post, remove, useResource } from '../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  Modal,
  PageHeader,
  Section,
  Status,
} from '../components';
import type { Project, Server, Task, User } from '../models';

interface AIProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  credentialId?: string;
  timeoutSeconds: number;
  enabled: boolean;
  configured: boolean;
  createdAt: number;
}
type AIMode = 'READ_ONLY' | 'CONFIRM' | 'FULL_CONTROL';
interface AIPolicy {
  mode: AIMode;
  projectId?: string;
  serverIds?: string[];
  projectIds?: string[];
  allowedActions?: string[];
  deniedActions?: string[];
  requireConfirmActions?: string[];
}
interface Policies {
  system: AIPolicy;
  projects: AIPolicy[];
}
interface Proposal {
  id: string;
  actionType: string;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  riskLevel: string;
  status: string;
  expiresAt: number;
  taskId?: string;
  createdAt: number;
}
interface Conversation {
  id: string;
  title: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}
interface AIMessage {
  id: string;
  role: string;
  content: unknown;
  createdAt: number;
}
interface Draft {
  type: 'PIPELINE' | 'OPERATION_PLAN';
  definition: Record<string, unknown>;
}
interface ChatResponse {
  conversationId: string;
  message: string;
  proposals: Proposal[];
  tasks: Task[];
  drafts: Draft[];
}
const modes: { value: AIMode; name: string; description: string }[] = [
  { value: 'READ_ONLY', name: '只读', description: '查询资源与状态、分析问题、生成配置草稿。' },
  { value: 'CONFIRM', name: '确认执行', description: '写入和执行操作生成提案，经你确认后执行。' },
  {
    value: 'FULL_CONTROL',
    name: '完全控制',
    description: '只在明确授权范围内执行；未知与高风险操作仍需确认。',
  },
];
const actionLabels: Record<string, string> = {
  execute_command: '执行远程命令',
  inspect_servers: '只读服务器巡检',
  run_pipeline: '构建并部署 Pipeline',
};
const riskLabels: Record<string, string> = {
  LOW: '低风险',
  MEDIUM: '中等风险',
  HIGH: '高风险',
  UNKNOWN: '未知风险，需核对全部操作',
};
function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'content' in value)
    return textContent((value as { content: unknown }).content);
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}

export function AISettings({ user }: { user: User }) {
  const providers = useResource<AIProvider[]>('/ai/providers');
  const policies = useResource<Policies>('/ai/policies');
  const projects = useResource<Project[]>('/projects');
  const servers = useResource<Server[]>('/servers');
  const [editing, setEditing] = useState<Partial<AIProvider>>();
  const [deleting, setDeleting] = useState<AIProvider>();
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const admin = user.role === 'ADMIN';
  async function testProvider(p: AIProvider) {
    setBusyId(p.id);
    setError('');
    setNotice('');
    try {
      const r = await post<{ success?: boolean; message?: string }>(`/ai/providers/${p.id}/test`);
      setNotice(r.message || (r.success === false ? `${p.name} 连接失败` : `${p.name} 连接成功`));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId('');
    }
  }
  async function toggle(p: AIProvider) {
    setBusyId(p.id);
    setError('');
    try {
      await api(`/ai/providers/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !p.enabled }),
      });
      void providers.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId('');
    }
  }
  async function deleteProvider() {
    if (!deleting) return;
    setBusyId(deleting.id);
    setError('');
    try {
      await remove(`/ai/providers/${deleting.id}`);
      setDeleting(undefined);
      void providers.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusyId('');
    }
  }
  return (
    <div className="ai-settings" id="ai-settings">
      <Section
        title="AI 模型连接（可选）"
        subtitle="兼容 OpenAI Chat Completions 协议；不配置 AI 也可使用全部手工运维功能。"
        action={
          admin && (
            <button className="button primary small" onClick={() => setEditing({})}>
              <Plus size={15} />
              添加 Provider
            </button>
          )
        }
      >
        <div className="section-body">
          <ErrorBanner error={providers.error || error} />
          {notice && (
            <div className="success-notice" role="status">
              <Check size={16} />
              {notice}
            </div>
          )}
          {providers.loading ? (
            <Loading />
          ) : !providers.data?.length ? (
            <Empty
              icon={<PlugZap size={25} />}
              title="尚未配置 AI"
              description={
                admin
                  ? '按需添加兼容服务的 Base URL、模型和 API Key。密钥将加密保存。'
                  : '请联系管理员配置兼容的模型服务，手工运维不受影响。'
              }
            />
          ) : (
            <div className="provider-list">
              {providers.data.map((p) => (
                <div className="provider-card" key={p.id}>
                  <div className="provider-main">
                    <span className="resource-avatar">
                      <Bot size={22} />
                    </span>
                    <div>
                      <strong>{p.name}</strong>
                      <small>
                        {p.model} · {p.baseUrl}
                      </small>
                    </div>
                    <Status value={p.enabled ? 'ACTIVE' : 'DISABLED'} />
                  </div>
                  <div className="provider-card-meta">
                    <span>
                      <KeyRound size={13} />
                      {p.configured ? '已安全配置密钥' : '未配置密钥'}
                    </span>
                    <span>超时 {p.timeoutSeconds} 秒</span>
                  </div>
                  {admin && (
                    <div className="provider-actions">
                      <button
                        className="text-button"
                        disabled={!!busyId || !p.configured}
                        onClick={() => testProvider(p)}
                      >
                        <PlugZap size={14} />
                        {busyId === p.id ? '处理中…' : '测试连接'}
                      </button>
                      <button
                        className="text-button"
                        disabled={!!busyId}
                        onClick={() => setEditing(p)}
                      >
                        <Pencil size={14} />
                        编辑
                      </button>
                      <button className="text-button" disabled={!!busyId} onClick={() => toggle(p)}>
                        {p.enabled ? '禁用' : '启用'}
                      </button>
                      <button
                        className="text-button danger-text"
                        aria-label={`删除 ${p.name}`}
                        disabled={!!busyId}
                        onClick={() => {
                          setError('');
                          setDeleting(p);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="field-note">
            对话可选择 Provider；未指定时使用可用的默认连接。API Key 不会在列表、对话或日志中回显。
          </p>
        </div>
      </Section>
      <PolicyEditor
        user={user}
        policies={policies.data}
        error={policies.error}
        projects={projects.data || []}
        servers={servers.data || []}
        onSaved={policies.reload}
      />
      {editing && (
        <ProviderEditor
          provider={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void providers.reload();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="删除 AI Provider"
          description={`确认移除“${deleting.name}”的连接配置？历史对话会保留。`}
          onClose={() => setDeleting(undefined)}
          onConfirm={deleteProvider}
          busy={!!busyId}
          error={error}
          destructive
        />
      )}
    </div>
  );
}
function ProviderEditor({
  provider,
  onClose,
  onSaved,
}: {
  provider: Partial<AIProvider>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api(`/ai/providers${provider.id ? `/${provider.id}` : ''}`, {
        method: provider.id ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name: f.get('name'),
          baseUrl: f.get('baseUrl'),
          model: f.get('model'),
          apiKey: f.get('apiKey') || undefined,
          timeoutSeconds: Number(f.get('timeoutSeconds')),
          enabled: f.get('enabled') === 'on',
        }),
      });
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={provider.id ? '编辑 AI Provider' : '添加 AI Provider'}
      description="配置兼容 OpenAI 的服务地址与模型。密钥仅用于服务端请求，并加密存储。"
      onClose={onClose}
    >
      <Form onSubmit={save} onCancel={onClose} error={error} busy={busy}>
        <Field label="名称" required>
          <input
            name="name"
            defaultValue={provider.name}
            required
            maxLength={100}
            autoFocus
            placeholder="例如 DeepSeek"
          />
        </Field>
        <Field
          label="Base URL"
          required
          hint="填写服务根地址或带 /v1 的地址，不含 /chat/completions。"
        >
          <input
            name="baseUrl"
            type="url"
            required
            defaultValue={provider.baseUrl}
            placeholder="https://api.deepseek.com"
          />
        </Field>
        <Field label="模型名称" required hint="以模型服务实际支持的名称为准。">
          <input name="model" required defaultValue={provider.model} placeholder="deepseek-flash" />
        </Field>
        <Field
          label={provider.id ? '更换 API Key（留空保留）' : 'API Key'}
          required={!provider.id}
          hint="保存后不再显示；修改连接地址时，请核对密钥接收方。"
        >
          <input
            type="password"
            name="apiKey"
            required={!provider.id}
            autoComplete="new-password"
            placeholder={provider.id ? '已保存的密钥不会回显' : '输入 API Key'}
          />
        </Field>
        <Field label="请求超时（秒）">
          <input
            name="timeoutSeconds"
            type="number"
            min={5}
            max={180}
            defaultValue={provider.timeoutSeconds || 60}
            required
          />
        </Field>
        <label className="checkbox-row">
          <input name="enabled" type="checkbox" defaultChecked={provider.enabled ?? true} />
          启用此连接
        </label>
      </Form>
    </Modal>
  );
}
function PolicyEditor({
  user,
  policies,
  error,
  projects,
  servers,
  onSaved,
}: {
  user: User;
  policies?: Policies;
  error?: string;
  projects: Project[];
  servers: Server[];
  onSaved: () => void;
}) {
  const [scope, setScope] = useState('');
  const [mode, setMode] = useState<AIMode>('CONFIRM');
  const [ids, setIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [restrictServers, setRestrictServers] = useState(false);
  const [restrictProjects, setRestrictProjects] = useState(false);
  const [denied, setDenied] = useState('');
  const [allowed, setAllowed] = useState('');
  const [restrictActions, setRestrictActions] = useState(false);
  const [required, setRequired] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const p = scope ? policies?.projects.find((p) => p.projectId === scope) : policies?.system;
    setMode(p?.mode || policies?.system.mode || 'CONFIRM');
    setIds(p?.serverIds || []);
    setProjectIds(p?.projectIds || []);
    setRestrictServers(p?.serverIds !== undefined);
    setRestrictProjects(p?.projectIds !== undefined);
    setDenied(p?.deniedActions?.join(', ') || '');
    setAllowed(p?.allowedActions?.join(', ') || '');
    setRestrictActions(p?.allowedActions !== undefined);
    setRequired(p?.requireConfirmActions?.join(', ') || '');
    setSaved(false);
  }, [policies, scope]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (mode === 'FULL_CONTROL' && !ids.length) {
      setSaveError('完全控制模式必须明确选择服务器授权范围');
      return;
    }
    setBusy(true);
    setSaveError('');
    setSaved(false);
    try {
      await api('/ai/policies', {
        method: 'PATCH',
        body: JSON.stringify({
          mode,
          projectId: scope || undefined,
          serverIds: restrictServers || mode === 'FULL_CONTROL' ? ids : undefined,
          projectIds: restrictProjects ? projectIds : undefined,
          allowedActions: restrictActions
            ? allowed
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
          deniedActions: denied
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          requireConfirmActions: required
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setSaveError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="AI 执行权限"
      subtitle="AI 始终继承发起用户的角色权限。系统禁止与强制确认规则优先于项目配置。"
    >
      <form className="section-body" onSubmit={save}>
        <ErrorBanner error={error || saveError} />
        <fieldset disabled={user.role !== 'ADMIN' || busy}>
          <Field label="策略作用范围">
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">系统默认策略</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · 项目覆盖
                </option>
              ))}
            </select>
          </Field>
          <div className="ai-mode-options">
            {modes.map((m) => (
              <label
                className={`ai-mode-option ${mode === m.value ? 'selected' : ''}`}
                key={m.value}
              >
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  checked={mode === m.value}
                  onChange={() => setMode(m.value)}
                />
                <strong>{m.name}</strong>
                <small>{m.description}</small>
              </label>
            ))}
          </div>
          <div className="form-grid">
            <div>
              <h3 className="field-title">允许的服务器范围</h3>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={restrictServers || mode === 'FULL_CONTROL'}
                  disabled={mode === 'FULL_CONTROL'}
                  onChange={(e) => setRestrictServers(e.target.checked)}
                />
                限定为选中的服务器
              </label>
              <div className="scope-options">
                {servers.length ? (
                  servers.map((s) => (
                    <label className="checkbox-row" key={s.id}>
                      <input
                        type="checkbox"
                        disabled={!restrictServers && mode !== 'FULL_CONTROL'}
                        checked={ids.includes(s.id)}
                        onChange={(e) =>
                          setIds(
                            e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id),
                          )
                        }
                      />
                      {s.name}
                      <small>{s.host}</small>
                    </label>
                  ))
                ) : (
                  <p className="muted">先接入服务器，再授予 AI 执行权限。</p>
                )}
              </div>
            </div>
            <div>
              <h3 className="field-title">允许的项目范围</h3>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={restrictProjects}
                  onChange={(e) => setRestrictProjects(e.target.checked)}
                />
                限定为选中的项目
              </label>
              <div className="scope-options">
                {projects.map((p) => (
                  <label className="checkbox-row" key={p.id}>
                    <input
                      type="checkbox"
                      disabled={!restrictProjects}
                      checked={projectIds.includes(p.id)}
                      onChange={(e) =>
                        setProjectIds(
                          e.target.checked
                            ? [...projectIds, p.id]
                            : projectIds.filter((id) => id !== p.id),
                        )
                      }
                    />
                    {p.name}
                  </label>
                ))}
                {!projects.length && <p className="muted">暂无项目。</p>}
              </div>
            </div>
          </div>
          <details className="advanced-options">
            <summary>操作规则</summary>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={restrictActions}
                onChange={(e) => setRestrictActions(e.target.checked)}
              />
              仅允许指定的执行类别
            </label>
            {restrictActions && (
              <Field label="允许的执行类别" hint="逗号分隔；启用限定但留空会拒绝所有执行。">
                <input
                  value={allowed}
                  onChange={(e) => setAllowed(e.target.value)}
                  placeholder="inspect_servers, execute_command, run_pipeline"
                />
              </Field>
            )}
            <Field label="禁止的操作类别" hint="使用逗号分隔类别名称。">
              <input
                value={denied}
                onChange={(e) => setDenied(e.target.value)}
                placeholder="例如 execute_command, run_pipeline"
              />
            </Field>
            <Field label="强制确认的操作类别" hint="系统级规则不会被项目策略覆盖。">
              <input
                value={required}
                onChange={(e) => setRequired(e.target.value)}
                placeholder="例如 execute_command"
              />
            </Field>
          </details>
        </fieldset>
        <p className="field-note">
          未限定范围时仍受用户角色与全局规则限制；开启限定但未选择资源会拒绝该类操作。完全控制必须明确授权服务器。
        </p>
        {user.role === 'ADMIN' && (
          <div className="inline-form-footer">
            {saved && (
              <span className="success-text">
                <Check size={15} />
                策略已保存
              </span>
            )}
            <button className="button primary" disabled={busy} type="submit">
              {busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
              保存权限策略
            </button>
          </div>
        )}
      </form>
    </Section>
  );
}

export function AIPage({ user }: { user: User }) {
  const servers = useResource<Server[]>('/servers');
  const providers = useResource<AIProvider[]>('/ai/providers');
  const conversations = useResource<Conversation[]>('/ai/conversations');
  const projects = useResource<Project[]>('/projects');
  const proposals = useResource<Proposal[]>('/ai/proposals', 5000);
  const policies = useResource<Policies>('/ai/policies');
  const [conversationId, setConversationId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [optimistic, setOptimistic] = useState<AIMessage[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [proposal, setProposal] = useState<Proposal>();
  const [proposalBusy, setProposalBusy] = useState(false);
  const [proposalError, setProposalError] = useState('');
  const messages = useResource<AIMessage[]>(
    conversationId ? `/ai/conversations/${conversationId}/messages` : null,
  );
  const bottom = useRef<HTMLDivElement>(null);
  const available = providers.data?.filter((p) => p.enabled && p.configured) || [];
  const currentPolicy = projectId
    ? policies.data?.projects.find((p) => p.projectId === projectId) || policies.data?.system
    : policies.data?.system;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.data, optimistic, busy]);
  function selectConversation(c: Conversation) {
    if (busy) return;
    setConversationId(c.id);
    setProjectId(c.projectId || '');
    setOptimistic([]);
    setDrafts([]);
    setTasks([]);
    setError('');
  }
  function newConversation() {
    if (busy) return;
    setConversationId('');
    setOptimistic([]);
    setDrafts([]);
    setTasks([]);
    setError('');
  }
  async function chat(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const prompt = input.trim();
    setInput('');
    setError('');
    setBusy(true);
    setOptimistic([{ id: 'pending-user', role: 'USER', content: prompt, createdAt: Date.now() }]);
    try {
      const result = await post<ChatResponse>('/ai/chat', {
        message: prompt,
        conversationId: conversationId || undefined,
        projectId: projectId || undefined,
        providerId: providerId || undefined,
      });
      setConversationId(result.conversationId);
      setDrafts(result.drafts || []);
      setTasks(result.tasks || []);
      setOptimistic([]);
      void conversations.reload();
      void proposals.reload();
      if (result.conversationId === conversationId) await messages.reload();
    } catch (err) {
      setError(message(err));
      setOptimistic([]);
      setInput(prompt);
    } finally {
      setBusy(false);
    }
  }
  async function decide(approve: boolean) {
    if (!proposal) return;
    setProposalBusy(true);
    setProposalError('');
    try {
      const r = await post<{ proposal: Proposal; task?: Task }>(
        `/ai/proposals/${proposal.id}/${approve ? 'confirm' : 'reject'}`,
      );
      if (r.task) setTasks((v) => [...v, r.task!]);
      setProposal(undefined);
      void proposals.reload();
      if (conversationId) void messages.reload();
    } catch (err) {
      setProposalError(message(err));
    } finally {
      setProposalBusy(false);
    }
  }
  const pending = (proposals.data || []).filter(
    (p) => p.status === 'PENDING' && p.expiresAt > Date.now(),
  );
  return (
    <>
      <PageHeader
        eyebrow="INTELLIGENT OPERATIONS"
        title="AI 运维助手"
        description="基于可信业务工具分析资源、生成配置，在明确权限范围内辅助执行。"
        action={
          <a href="#/settings" className="button secondary">
            <Settings2 size={16} />
            模型与权限配置
          </a>
        }
      />
      <ErrorBanner error={providers.error || conversations.error || policies.error} />
      {!providers.loading && !available.length ? (
        <div className="panel">
          <Empty
            icon={<PlugZap size={29} />}
            title="按需连接你的 AI 服务"
            description="AI 是可选能力。配置兼容 OpenAI 的 Base URL、API Key 和模型后，即可开始对话；手工运维功能始终可用。"
            action={
              <a className="button primary" href="#/settings">
                前往配置
              </a>
            }
          />
        </div>
      ) : (
        <div className="ai-workspace">
          <aside className="panel conversation-sidebar">
            <button className="button secondary" onClick={newConversation} disabled={busy}>
              <MessageSquarePlus size={16} />
              新建对话
            </button>
            <div className="conversation-list">
              {conversations.data?.map((c) => (
                <button
                  className={conversationId === c.id ? 'active' : ''}
                  key={c.id}
                  onClick={() => selectConversation(c)}
                  disabled={busy}
                >
                  <span>{c.title}</span>
                  <small>{formatTime(c.updatedAt)}</small>
                </button>
              ))}
              {!conversations.data?.length && <p className="muted">你的对话会保存在这里。</p>}
            </div>
            <div className="ai-permission-chip">
              <ShieldCheck size={16} />
              <div>
                <strong>
                  {modes.find((m) => m.value === (currentPolicy?.mode || 'CONFIRM'))?.name}
                </strong>
                <small>
                  {user.role === 'VIEWER'
                    ? '当前用户仅可查看与分析'
                    : '所有操作仍受资源范围与风险策略约束'}
                </small>
              </div>
            </div>
          </aside>
          <section className="panel chat-panel">
            <div className="chat-toolbar">
              <Field label="模型连接">
                <select
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  disabled={busy || !!conversationId}
                >
                  <option value="">默认可用连接</option>
                  {available.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name} · {p.model}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="项目上下文">
                <select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={busy || !!conversationId}
                >
                  <option value="">全局资源</option>
                  {projects.data?.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="chat-history" aria-live="polite">
              {messages.loading && conversationId ? (
                <Loading />
              ) : !messages.data?.length && !optimistic.length ? (
                <div className="chat-welcome">
                  <span className="ai-orb">
                    <Sparkles size={28} />
                  </span>
                  <h2>从一个运维问题开始</h2>
                  <p>查询服务器、分析任务失败原因，或描述你想构建的部署流程。</p>
                  <div className="prompt-suggestions">
                    {[
                      '列出当前服务器并总结最近连接状态',
                      '帮我生成 Node.js 项目的文件部署 Pipeline 草稿',
                      '查看最近失败的任务，给出排查建议',
                    ].map((s) => (
                      <button key={s} onClick={() => setInput(s)}>
                        {s}
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {[...(messages.data || []), ...optimistic].map((m) => (
                    <div
                      className={`chat-message ${m.role.toUpperCase() === 'USER' ? 'user' : 'assistant'}`}
                      key={m.id}
                    >
                      <span className="message-avatar">
                        {m.role.toUpperCase() === 'USER' ? (
                          <UserRound size={17} />
                        ) : (
                          <Bot size={18} />
                        )}
                      </span>
                      <div>
                        <span className="message-label">
                          {m.role.toUpperCase() === 'USER'
                            ? '你'
                            : m.role.toUpperCase() === 'TOOL'
                              ? '工具执行结果'
                              : 'AI 助手'}
                        </span>
                        {m.role.toUpperCase() === 'TOOL' ? (
                          <details className="tool-result">
                            <summary>查看工具返回内容</summary>
                            <pre>{textContent(m.content)}</pre>
                          </details>
                        ) : (
                          <div className="message-content">{textContent(m.content)}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
              {busy && (
                <div className="chat-thinking">
                  <LoaderCircle size={16} className="spin" />
                  正在分析并调用获准的工具…
                </div>
              )}
              {drafts.map((d, i) => (
                <div className="ai-draft-card" key={i}>
                  <div>
                    <FileCode2 size={18} />
                    <strong>{d.type === 'PIPELINE' ? 'Pipeline 草稿' : '运维方案草稿'}</strong>
                  </div>
                  <details>
                    <summary>预览配置</summary>
                    <pre className="code-preview">{JSON.stringify(d.definition, null, 2)}</pre>
                  </details>
                  {d.type === 'PIPELINE' ? (
                    <button
                      className="button secondary small"
                      onClick={() => {
                        sessionStorage.setItem(
                          'veyops:pipeline-draft',
                          JSON.stringify(
                            'definition' in d.definition
                              ? d.definition
                              : {
                                  name: 'AI Pipeline 草稿',
                                  projectId: projectId || undefined,
                                  definition: d.definition,
                                },
                          ),
                        );
                        navigate('/pipelines');
                      }}
                    >
                      在 Pipeline 编辑器中完善
                    </button>
                  ) : (
                    <button
                      className="button secondary small"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(JSON.stringify(d.definition, null, 2))
                          .catch(() => setError('无法复制，请展开预览后手动复制。'));
                      }}
                    >
                      复制方案草稿
                    </button>
                  )}
                </div>
              ))}
              {tasks.map((t) => (
                <a className="ai-task-result" key={t.id} href={`#/tasks/${t.id}`}>
                  <Check size={16} />
                  <span>
                    {t.name || '已创建执行任务'}
                    <small>{t.id}</small>
                  </span>
                  <ChevronRight size={16} />
                </a>
              ))}
              <div ref={bottom} />
            </div>
            <form className="chat-composer" onSubmit={chat}>
              <ErrorBanner error={error || messages.error} />
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="描述你的运维问题或需要生成的配置…"
                aria-label="发送给 AI 的消息"
                required
                maxLength={12000}
                rows={3}
                disabled={busy}
              />
              <div>
                <small>请勿在对话中粘贴密码或 API Key；需要执行的操作会按策略生成提案。</small>
                <button
                  className="button primary"
                  type="submit"
                  disabled={busy || !input.trim() || !available.length}
                >
                  {busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}发送
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {pending.length > 0 && (
        <Section
          title={`等待确认的操作 · ${pending.length}`}
          subtitle="核对目标、命令与风险后确认；拒绝或过期的提案不会执行。"
        >
          <div className="proposal-list">
            {pending.map((p) => (
              <div className="proposal-row" key={p.id}>
                <ShieldCheck size={21} />
                <div>
                  <strong>{actionLabels[p.actionType] || p.actionType}</strong>
                  <small>
                    {riskLabels[p.riskLevel] || p.riskLevel} · 有效至 {formatTime(p.expiresAt)}
                  </small>
                </div>
                <button
                  className="button secondary small"
                  onClick={() => {
                    setProposalError('');
                    setProposal(p);
                  }}
                >
                  预览操作
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}
      {proposal && (
        <Modal
          title="确认 AI 操作提案"
          description="执行前服务端会重新检查当前用户、最新权限策略和资源范围。"
          onClose={() => {
            if (!proposalBusy) setProposal(undefined);
          }}
          wide
        >
          <div className="form-body">
            <div className="confirmation-summary">
              <ShieldCheck size={23} />
              <div>
                <strong>
                  {actionLabels[proposal.actionType] || proposal.actionType} ·{' '}
                  {riskLabels[proposal.riskLevel] || proposal.riskLevel}
                </strong>
                <p>有效至 {formatTime(proposal.expiresAt)}</p>
              </div>
            </div>
            <ProposalPreview proposal={proposal} servers={servers.data || []} />
            <ErrorBanner error={proposalError} />
          </div>
          <div className="modal-footer">
            <button
              className="button secondary"
              disabled={proposalBusy}
              onClick={() => decide(false)}
            >
              拒绝操作
            </button>
            <button
              className="button primary"
              disabled={proposalBusy || user.role === 'VIEWER' || proposal.expiresAt <= Date.now()}
              onClick={() => decide(true)}
            >
              {proposalBusy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
              确认并执行
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ProposalPreview({ proposal, servers }: { proposal: Proposal; servers: Server[] }) {
  const preview = proposal.preview || proposal.payload;
  const targets = Array.isArray(preview.targets)
    ? (preview.targets as { id?: string; name?: string; host?: string }[])
    : Array.isArray(preview.serverIds)
      ? (preview.serverIds as string[]).map((id) => {
          const server = servers.find((s) => s.id === id);
          return { id, name: server?.name, host: server?.host };
        })
      : [];
  const definition =
    preview.definition && typeof preview.definition === 'object'
      ? (preview.definition as Record<string, unknown>)
      : undefined;
  return (
    <>
      {!!targets.length && (
        <div className="scope-options">
          {targets.map((t, i) => (
            <p className="checkbox-row" key={t.id || i}>
              <ShieldCheck size={14} />
              <strong>{t.name || t.id}</strong>
              <small>{t.host}</small>
            </p>
          ))}
        </div>
      )}
      {typeof preview.command === 'string' && (
        <>
          <h3 className="field-title">即将执行的命令</h3>
          <pre className="code-preview">{preview.command}</pre>
        </>
      )}
      {proposal.actionType === 'run_pipeline' && (
        <div className="deployment-review">
          <span>固定 Commit</span>
          <code>{String(preview.commitSha || '')}</code>
          <span>Pipeline 版本</span>
          <strong>v{String(preview.version || '')}</strong>
          <span>部署目录</span>
          <code>{String(definition?.deployPath || '')}</code>
        </div>
      )}
      <details
        className="advanced-options"
        open={!targets.length && typeof preview.command !== 'string'}
      >
        <summary>完整操作预览</summary>
        <pre className="code-preview proposal-preview">{JSON.stringify(preview, null, 2)}</pre>
      </details>
    </>
  );
}
