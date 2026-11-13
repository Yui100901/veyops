import {
  Check,
  Database,
  FileClock,
  HardDrive,
  LockKeyhole,
  Server,
  Settings2,
  Workflow,
} from 'lucide-react';
import { formatTime, useResource } from '../api';
import { Empty, ErrorBanner, Loading, PageHeader, RefreshButton, Section } from '../components';
import type { Audit, User } from '../models';
import { AISettings } from './AI';

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

type SystemInfo = {
  version?: string;
  database?: string | { client?: string; type?: string };
  databaseClient?: string;
  workerEnabled?: boolean;
  worker?: { enabled?: boolean; concurrency?: number };
  defaultMaxParallelTargets?: number;
  defaultBuildLocation?: string;
  defaultAiPermission?: string;
  dataDir?: string;
  [key: string]: unknown;
};
export function SystemPage({ user }: { user: User }) {
  const resource = useResource<SystemInfo>('/system');
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
        description="查看运行环境，按需连接 AI 模型并设置执行权限。"
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
                后台 Worker
              </span>
              <strong>{worker == null ? '—' : worker ? '已启用' : '已关闭'}</strong>
            </div>
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
                  : (value?.defaultBuildLocation ?? '—')}
              </strong>
            </div>
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
        <p>
          数据库连接、加密主密钥与 Worker 配置由服务端管理。下方 AI
          连接与权限策略可由管理员在线调整。
        </p>
      </div>
      <AISettings user={user} />
    </>
  );
}
