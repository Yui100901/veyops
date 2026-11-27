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
import { api, message, useResource } from '../../api';
import { ErrorBanner, Field, Form, Loading, PageHeader, Section } from '../../components';
import type { SystemRuntimeDefaults, User } from '../../models';
import { InlineEditor, useInlineEditor } from '../../InlineEditor';
import {
  ExecutionSettingsFields,
  executionChanges,
} from '../projects/settings/ProjectExecutionSettings';
import { AISettings } from '../ai/AI';
import { ArtifactCleanup, ArtifactRetentionPolicy } from '../delivery/ArtifactRetention';
import { MonitoringSettings } from '../infrastructure/ServerMonitoring';

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
                单批运维并行目标数
              </span>
              <strong>{value?.defaultMaxParallelTargets ?? '—'}</strong>
            </div>
            <div className="setting-row">
              <span>
                <Workflow size={17} />
                单台服务器任务并发
              </span>
              <strong>{value?.maxConcurrentFlowsPerServer ?? '—'}</strong>
            </div>
            <div className="setting-row">
              <span>
                <HardDrive size={17} /> 目标端工作根目录
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
    const maxConcurrentFlowsPerServer = Number(fields.get('maxConcurrentFlowsPerServer'));
    if (maxConcurrentFlowsPerServer !== settings.maxConcurrentFlowsPerServer)
      changed.maxConcurrentFlowsPerServer = maxConcurrentFlowsPerServer;
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
        <Field
          label="单台服务器任务并发"
          hint="同一服务器的执行流、运维命令和交互会话共用此上限，达到上限后按提交顺序等待。"
        >
          <input
            type="number"
            name="maxConcurrentFlowsPerServer"
            min={1}
            max={10}
            required
            defaultValue={settings.maxConcurrentFlowsPerServer ?? 10}
          />
        </Field>
      </Form>
    </InlineEditor>
  );
}
