import { useId } from 'react';
import { formatTime, useResource } from '../../../api';
import { ErrorBanner, Field } from '../../../components';
import { artifactInstanceId, type Artifact } from '../../delivery/Delivery';

type WorkspaceCandidate = Artifact & { workspaceReusable?: boolean };

export function WorkspaceHistoryInput({
  projectId,
  value,
  change,
}: {
  projectId: string;
  value: unknown;
  change: (id: string | undefined) => void;
}) {
  const query = new URLSearchParams({ projectId, kind: 'DIRECTORY' });
  const candidates = useResource<WorkspaceCandidate[]>('/artifacts?' + query);
  const noteId = useId();
  const options = (candidates.data ?? []).filter(({ workspaceReusable }) => workspaceReusable);
  const selected = options.find((item) => artifactInstanceId(item) === value);
  const selectedSize = selected?.sizeBytes ?? selected?.physical?.sizeBytes;
  const missing = !options.length;
  return (
    <>
      <Field label="历史目录">
        <select
          aria-describedby={noteId}
          value={selected ? artifactInstanceId(selected) : ''}
          required
          onChange={(event) => change(event.target.value || undefined)}
        >
          <option value="">{candidates.loading ? '正在读取目录…' : '选择历史目录'}</option>
          {options.map((item) => (
            <option value={artifactInstanceId(item)} key={artifactInstanceId(item)}>
              {[
                item.name ?? '执行目录',
                [item.graphFlowName, item.graphRunId?.slice(0, 8)].filter(Boolean).join(' '),
                formatTime(item.createdAt),
                item.sourceCommit?.slice(0, 12),
              ]
                .filter(Boolean)
                .join(' · ')}
            </option>
          ))}
        </select>
      </Field>
      <div id={noteId} className="workspace-history-note field-note">
        {!candidates.loading && missing && !candidates.error && (
          <p>当前项目没有可用的历史目录。请先完成一次构建并保留执行目录。</p>
        )}
        {!candidates.loading && !missing && typeof value === 'string' && !selected && (
          <p>原先选择的目录已不可用，请重新选择。</p>
        )}
        {selected && (
          <p>
            {selected.downloadAvailable
              ? '已归档'
              : '服务器目录 · ' + (selected.serverName ?? selected.serverId ?? '目标端')}
            {selectedSize != null && ` · ${(selectedSize / 1024).toFixed(1)} KiB`}
            {selected.sources?.length
              ? ' · ' + selected.sources.map(({ commitSha }) => commitSha.slice(0, 12)).join('、')
              : ''}
          </p>
        )}
      </div>
      <ErrorBanner error={candidates.error} retry={candidates.reload} />
    </>
  );
}
