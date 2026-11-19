import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Archive,
  Check,
  Database,
  FileClock,
  HardDrive,
  LockKeyhole,
  Mail,
  Pencil,
  Server,
  Settings2,
  Users,
  Workflow,
} from 'lucide-react';
import { api, formatTime, message, useResource } from '../api';
import {
  Empty,
  ErrorBanner,
  Form,
  Loading,
  PageHeader,
  RefreshButton,
  Section,
} from '../components';
import type { Audit, SystemRuntimeDefaults, User } from '../models';
import { InlineEditor, useInlineEditor } from '../InlineEditor';
import { ExecutionSettingsFields, executionChanges } from './ProjectExecutionSettings';
import { AISettings } from './AI';
import { ArtifactCleanup, ArtifactRetentionPolicy } from './ArtifactRetention';
import { MonitoringSettings } from './ServerMonitoring';

export function AuditPage() {
  const resource = useResource<Audit[]>('/audit');
  return (
    <>
      <PageHeader
        eyebrow="TRACEABILITY"
        title="操作审计"
        description="记录资源变更和执行行为，让关键操作可以追溯。"
        action={<RefreshButton onClick={resource.reload} />}
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      <Section title="审计记录" subtitle="按最近操作时间排序">
        {resource.loading ? (
          <Loading />
        ) : !resource.data?.length ? (
          <Empty
            icon={<FileClock size={25} />}
            title="暂无审计记录"
            description="资源创建、变更与命令执行等操作会记录在这里。"
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>操作</th>
                  <th>资源类型</th>
                  <th>资源标识</th>
                  <th>操作者</th>
                  <th>发生时间</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="table-name">
                        <span className="tiny-icon">
                          <FileClock size={15} />
                        </span>
                        {item.action}
                      </span>
                    </td>
                    <td>
                      <span className="tag">{item.resourceType || '—'}</span>
                    </td>
                    <td className="mono muted truncate" title={item.resourceId}>
                      {item.resourceId || '—'}
                    </td>
                    <td
                      className="mono muted truncate"
                      title={item.username || item.userId || item.actorId}
                    >
                      {item.username || item.userId || item.actorId || '系统'}
                    </td>
                    <td className="muted nowrap">{formatTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}

type SystemInfo = Partial<SystemRuntimeDefaults> & {
  version?: string;
  database?: string | { client?: string; type?: string };
  databaseClient?: string;
  workerEnabled?: boolean;
  worker?: { enabled?: boolean; concurrency?: number };
  defaultAiPermission?: string;
  dataDir?: string;
  [key: string]: unknown;
};
export function SystemPage({ user }: { user: User }) {
  const resource = useResource<SystemInfo>('/system');
  const [editing, setEditing] = useInlineEditor<true>();
  const [editingRetention, setEditingRetention] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  const value = resource.data;
  const db =
    typeof value?.database === 'string'
      ? value.database
      : (value?.database?.client ?? value?.database?.type ?? value?.databaseClient);
  const worker = value?.workerEnabled ?? value?.worker?.enabled;
  return (
    <>
      <PageHeader
        eyebrow="WORKSPACE SETTINGS"
        title="系统设置"
        description="查看运行环境，管理执行默认值、日志保留、数据备份和 AI 权限。"
        action={
          user.role === 'ADMIN' && (
            <>
              <a className="button secondary" href="#/settings/users">
                <Users size={16} /> 用户管理
              </a>
              <a className="button secondary" href="#/settings/backups">
                <Archive size={16} /> 备份管理
              </a>
              <a className="button secondary" href="#/settings/smtp">
                <Mail size={16} /> SMTP 发件设置
              </a>
            </>
          )
        }
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      {editing && value && (
        <RuntimeDefaultsEditor
          settings={value}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void resource.reload();
          }}
        />
      )}
      {resource.loading ? (
        <Loading />
      ) : (
        <div className="settings-grid">
          <Section title="运行环境" subtitle="配置通过服务端环境变量管理">
            <div className="setting-row">
              <span>
                <Settings2 size={17} />
                应用版本
              </span>
              <strong>{value?.version ?? '—'}</strong>
            </div>
            <div className="setting-row">
              <span>
                <Database size={17} />
                数据库
              </span>
              <strong>{db ? db.toUpperCase() : '—'}</strong>
            </div>
            <div className="setting-row">
              <span>
                <Workflow size={17} />
                当前 API 进程的 Worker
              </span>
              <strong>{worker == null ? '—' : worker ? '已启用' : '已关闭'}</strong>
            </div>
          </Section>
          <Section
            title="执行与日志"
            action={
              user.role === 'ADMIN' &&
              value && (
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setEditing(true)}
                >
                  <Pencil size={14} /> 编辑运行设置
                </button>
              )
            }
          >
            <div className="setting-row">
              <span>
                <Server size={17} />
                默认目标并发
              </span>
              <strong>{value?.defaultMaxParallelTargets ?? '—'}</strong>
            </div>
            <div className="setting-row">
              <span>
                <HardDrive size={17} />
                默认构建位置
              </span>
              <strong>
                {value?.defaultBuildLocation === 'TARGET'
                  ? '目标服务器'
                  : value?.defaultBuildLocation === 'MANAGER'
                    ? '管理端隔离环境'
                    : '—'}
              </strong>
            </div>
            <div className="setting-row">
              <span>
                <HardDrive size={17} /> 目标端工作目录
              </span>
              <strong className="mono">{value?.targetWorkspaceRoot ?? '—'}</strong>
            </div>
            <div className="setting-row">
              <span>
                <FileClock size={17} />
                任务日志保留
              </span>
              <strong>
                {value?.logRetentionDays === 0
                  ? '一直保留'
                  : value?.logRetentionDays
                    ? `${value.logRetentionDays} 天`
                    : '—'}
              </strong>
            </div>
            {user.role === 'ADMIN' && (
              <div className="setting-row">
                <span>
                  <Archive size={17} /> 构建产物保留
                </span>
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setEditingRetention(true)}
                >
                  保留策略
                </button>
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => setCleanup(true)}
                >
                  全局清理预览
                </button>
              </div>
            )}
          </Section>
          <MonitoringSettings user={user} />
          <Section title="安全基础" subtitle="资源访问与执行的安全机制">
            <div className="security-feature">
              <span>
                <Check size={16} />
              </span>
              <div>
                <strong>凭据加密</strong>
                <p>AES-256-GCM，主密钥与数据库分离。</p>
              </div>
            </div>
            <div className="security-feature">
              <span>
                <Check size={16} />
              </span>
              <div>
                <strong>严格主机验证</strong>
                <p>连接前验证 SSH 主机指纹。</p>
              </div>
            </div>
            <div className="security-feature">
              <span>
                <Check size={16} />
              </span>
              <div>
                <strong>按角色授权</strong>
                <p>管理员、操作员与只读用户。</p>
              </div>
            </div>
            <div className="security-feature">
              <span>
                <Check size={16} />
              </span>
              <div>
                <strong>明确执行目标</strong>
                <p>命令与方案必须确认后提交。</p>
              </div>
            </div>
          </Section>
        </div>
      )}
      <div className="info-strip">
        <LockKeyhole size={18} />
        <p>数据库连接、加密主密钥与 Worker 进程由服务端配置。</p>
      </div>
      <AISettings user={user} />
      {editingRetention && <ArtifactRetentionPolicy onClose={() => setEditingRetention(false)} />}
      {cleanup && <ArtifactCleanup onClose={() => setCleanup(false)} onPruned={resource.reload} />}
    </>
  );
}

function RuntimeDefaultsEditor({
  settings,
  onClose,
  onSaved,
}: {
  settings: Partial<SystemRuntimeDefaults>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const changed = executionChanges(fields, settings);
    setSaving(true);
    setError('');
    try {
      await api('/system', {
        method: 'PATCH',
        body: JSON.stringify(changed),
      });
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <InlineEditor title="编辑运行设置" busy={saving} onClose={onClose}>
      <Form onSubmit={save} onCancel={onClose} busy={saving} error={error}>
        <ExecutionSettingsFields values={settings} />
      </Form>
    </InlineEditor>
  );
}
