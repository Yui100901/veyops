import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Archive,
  Check,
  Database,
  FileClock,
  HardDrive,
  LockKeyhole,
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
  Field,
  Form,
  Loading,
  Modal,
  PageHeader,
  RefreshButton,
  Section,
} from '../components';
import type { Audit, SystemRuntimeDefaults, User } from '../models';
import { AISettings } from './AI';
import { ArtifactRetentionPolicy } from './ArtifactRetention';

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
  const [editing, setEditing] = useState(false);
  const [editingRetention, setEditingRetention] = useState(false);
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
            </>
          )
        }
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
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
              </div>
            )}
          </Section>
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
      {editing && value && (
        <RuntimeDefaultsEditor
          settings={value}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void resource.reload();
          }}
        />
      )}
      {editingRetention && <ArtifactRetentionPolicy onClose={() => setEditingRetention(false)} />}
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
  const initialBuildLocation = settings.defaultBuildLocation ?? 'TARGET';
  const initialParallel = settings.defaultMaxParallelTargets ?? 3;
  const initialRetention = settings.logRetentionDays ?? 0;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const defaultBuildLocation = fields.get('defaultBuildLocation');
    const defaultMaxParallelTargets = Number(fields.get('defaultMaxParallelTargets'));
    const logRetentionDays = Number(fields.get('logRetentionDays'));
    setSaving(true);
    setError('');
    try {
      await api('/system', {
        method: 'PATCH',
        body: JSON.stringify({
          ...(defaultBuildLocation !== initialBuildLocation && { defaultBuildLocation }),
          ...(defaultMaxParallelTargets !== initialParallel && { defaultMaxParallelTargets }),
          ...(logRetentionDays !== initialRetention && { logRetentionDays }),
        }),
      });
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title="编辑运行设置"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <Form onSubmit={save} onCancel={onClose} busy={saving} error={error}>
        <Field label="默认构建位置">
          <select name="defaultBuildLocation" defaultValue={initialBuildLocation}>
            <option value="TARGET">目标服务器</option>
            <option value="MANAGER">管理端隔离环境</option>
          </select>
        </Field>
        <Field label="默认目标并发" hint="适用于未指定并发数的任务和新部署目标。">
          <input
            name="defaultMaxParallelTargets"
            type="number"
            min={1}
            max={10}
            required
            defaultValue={initialParallel}
          />
        </Field>
        <Field label="任务日志保留天数" hint="超过期限的已结束任务日志会定期清理。填 0 一直保留。">
          <input
            name="logRetentionDays"
            type="number"
            min={0}
            max={3650}
            required
            defaultValue={initialRetention}
          />
        </Field>
      </Form>
    </Modal>
  );
}
