import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { message, post, useResource } from '../api';
import { ErrorBanner } from '../components';
import type { Repository } from '../models';

interface RepositoryBranch {
  name: string;
  sha: string;
}
interface RepositoryBranches {
  defaultBranch: string | null;
  branches: RepositoryBranch[];
  syncedAt: number | null;
  error: string | null;
  status: Repository['branchSyncStatus'];
}
export function repositoryBranchLabel(repository: Repository) {
  if (repository.branchSyncStatus === 'PENDING') return '待同步';
  if (repository.branchSyncStatus === 'ERROR') return '同步失败';
  const head = repository.defaultBranch || `${repository.branchCount} 个分支`;
  return repository.branchSyncStatus === 'STALE' ? `${head} · 已过期` : head;
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function useRepositoryBranches(path: string | null, onSynced?: () => void) {
  const branches = useResource<RepositoryBranches>(path ? `${path}/branch-cache` : null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const currentPath = useRef(path);
  useEffect(() => {
    currentPath.current = path;
    setSyncError('');
    setSyncing(false);
    return () => {
      currentPath.current = null;
    };
  }, [path]);
  const refresh = async () => {
    if (!path) return;
    setSyncing(true);
    setSyncError('');
    try {
      await post(`${path}/branch-cache/refresh`);
      if (path !== currentPath.current) return;
      await branches.reload();
      onSynced?.();
    } catch (err) {
      if (path === currentPath.current) setSyncError(message(err));
    } finally {
      if (path === currentPath.current) setSyncing(false);
    }
  };
  return { ...branches, refresh, syncing, syncError };
}

export function BranchSyncControls({
  branches,
}: {
  branches: ReturnType<typeof useRepositoryBranches>;
}) {
  const { syncError, syncing, refresh } = branches;
  return (
    <>
      <ErrorBanner error={branches.error} retry={branches.reload} />
      <ErrorBanner error={syncError || branches.data?.error || ''} />
      {branches.data && (
        <div className="repository-detail-actions">
          <span className="field-note">
            {branches.data.syncedAt
              ? `上次成功同步 ${dateFormat.format(new Date(branches.data.syncedAt))}`
              : '尚无已同步的分支'}
            {branches.data.status === 'STALE' && ' · 已过期，请刷新'}
          </span>
          <button
            className="button secondary small"
            type="button"
            disabled={syncing}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
            {syncing ? '正在同步…' : '刷新分支'}
          </button>
        </div>
      )}
    </>
  );
}
