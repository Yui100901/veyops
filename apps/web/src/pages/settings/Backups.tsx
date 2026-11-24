import { useState } from 'react';
import { Archive, ArrowLeft, Check, Download, Info, LoaderCircle, Plus } from 'lucide-react';
import { api, message, post, useResource } from '../../api';
import { Empty, ErrorBanner, Loading, PageHeader, RefreshButton, Section } from '../../components';
import type { User } from '../../models';

type BackupSummary = {
  id: string;
  createdAt: string;
  databaseClient: 'sqlite' | 'postgres';
  fileCount: number;
};

type BackupOperation = { type: 'create' } | { type: 'verify'; id: string };

const backupTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function BackupsPage({ user }: { user: User }) {
  if (user.role === 'ADMIN') return <BackupManagement />;
  return (
    <>
      <PageHeader title="数据备份" description="仅管理员可以访问备份管理。" />
      <SettingsLink />
    </>
  );
}

function SettingsLink() {
  return (
    <a className="button secondary" href="#/settings">
      <ArrowLeft size={16} /> 返回系统设置
    </a>
  );
}

function BackupManagement() {
  const backups = useResource<BackupSummary[]>('/backups');
  const [operation, setOperation] = useState<BackupOperation>();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const creating = operation?.type === 'create';

  async function run(next: BackupOperation) {
    if (operation) return;
    setOperation(next);
    setNotice('');
    setError('');
    try {
      const result =
        next.type === 'create'
          ? await api<BackupSummary>('/backups', { method: 'POST' })
          : await post<BackupSummary>(`/backups/${encodeURIComponent(next.id)}/verify`);
      setNotice(next.type === 'create' ? `已创建备份 ${result.id}。` : `校验通过 · ${result.id}`);
      if (next.type === 'create') await backups.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setOperation(undefined);
    }
  }

  return (
    <>
      <PageHeader
        title="数据备份"
        description="创建数据库快照，管理本实例保存的备份。"
        action={
          <>
            <SettingsLink />
            <button
              className="button primary"
              type="button"
              disabled={Boolean(operation)}
              onClick={() => void run({ type: 'create' })}
            >
              {creating ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
              {creating ? '正在创建…' : '创建在线备份'}
            </button>
          </>
        }
      />
      <div className="info-strip">
        <Info size={18} />
        <p>
          在线备份先保存数据库快照，再收集日志、产物和配置。需要让数据库和文件处于同一维护时点时，请使用离线备份命令。
        </p>
      </div>
      <ErrorBanner error={backups.error} retry={backups.reload} />
      <ErrorBanner error={error} />
      {notice && (
        <p className="success-notice backup-notice" role="status">
          <Check size={16} /> {notice}
        </p>
      )}
      <Section
        title="备份列表"
        action={<RefreshButton onClick={backups.reload} />}
        className="backup-panel"
      >
        {backups.loading ? (
          <Loading />
        ) : backups.data?.length ? (
          <ul className="backup-list">
            {backups.data.map((backup) => {
              const verifying = operation?.type === 'verify' && operation.id === backup.id;
              return (
                <li className="backup-list-row" key={backup.id}>
                  <div className="backup-name">
                    <span className="resource-avatar">
                      <Archive size={17} />
                    </span>
                    <div>
                      <strong className="mono">{backup.id}</strong>
                      <div className="backup-meta">
                        <span>
                          {backup.databaseClient === 'postgres' ? 'PostgreSQL' : 'SQLite'}
                        </span>
                        <time dateTime={backup.createdAt}>
                          {backupTime.format(new Date(backup.createdAt))}
                        </time>
                        <span>{backup.fileCount} 个文件</span>
                      </div>
                    </div>
                  </div>
                  <div className="row-actions">
                    <button
                      className="button secondary small"
                      type="button"
                      disabled={Boolean(operation)}
                      onClick={() => void run({ type: 'verify', id: backup.id })}
                    >
                      {verifying ? '正在校验…' : '校验'}
                    </button>
                    <a
                      className="button secondary small"
                      href={`/api/v1/backups/${encodeURIComponent(backup.id)}/download`}
                      download
                    >
                      <Download size={14} /> 下载
                    </a>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          !backups.error && (
            <Empty
              icon={<Archive size={24} />}
              title="暂无备份"
              description="创建在线备份后，可在此校验文件完整性并下载。"
            />
          )
        )}
      </Section>
      <BackupRestore />
    </>
  );
}

function BackupRestore() {
  return (
    <Section title="离线恢复" subtitle="将备份还原到独立实例" className="backup-panel">
      <div className="backup-restore-body">
        <ol>
          <li>校验并下载备份，解压到独立目录。单独保管创建备份时使用的加密主密钥。</li>
          <li>
            配置空数据目录、同类型的空数据库和原 <code>ENCRYPTION_KEY</code>，保持目标 API 和 Worker
            停止。PostgreSQL 的目标 schema 名称须与源相同。
          </li>
          <li>
            执行恢复命令，以 <code>WORKER_ENABLED=false</code>{' '}
            启动目标。检查历史任务、日志和产物后，再按需启动 Worker。
          </li>
        </ol>
        <details>
          <summary>查看维护命令</summary>
          <p>
            原生安装时，在项目根目录应用目标环境配置，并将 <code>/srv/backups/veyops-restore</code>{' '}
            替换为解压后的备份目录。
          </p>
          <pre className="code-preview">
            <code>
              node apps/api/dist/core/database/backup-cli.js restore /srv/backups/veyops-restore
            </code>
          </pre>
          <p>Compose 安装使用独立的项目名和数据卷，目标配置写在 restore.env 中。</p>
          <pre className="code-preview">
            <code>{`docker compose -p veyops-restore --env-file restore.env run --rm --no-deps \\
  -v /srv/backups:/backup:ro veyops \\
  node apps/api/dist/core/database/backup-cli.js restore /backup/veyops-restore`}</code>
          </pre>
          <p>
            创建同一维护时点的完整备份时，等待执行任务结束并停止源 API 和 Worker，使用{' '}
            <code>backup-cli.js create &lt;备份目录&gt;</code>。仓库中的 <code>docs/BACKUP.md</code>{' '}
            提供两种安装方式的完整步骤。
          </p>
        </details>
      </div>
    </Section>
  );
}
