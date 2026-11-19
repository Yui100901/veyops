import { InlineEditor, useInlineEditor } from '../InlineEditor';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import { api, formatTime, message, post, remove, useResource } from '../api';
import {
  Confirm,
  ErrorBanner,
  Field,
  Form,
  Loading,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type { DeploymentSummary, Server, ServerDetail, ServerGroup } from '../models';
import { ServerPicker } from './BatchTargets';
import { ServerMonitoring } from './ServerMonitoring';
import type { MonitorRow } from './monitoring-data';

export function ServerGroups({
  servers,
  canEdit,
  serversLoading,
}: {
  servers: Server[];
  canEdit: boolean;
  serversLoading: boolean;
}) {
  const groups = useResource<ServerGroup[]>('/server-groups');
  const [editing, setEditing] = useInlineEditor<ServerGroup | 'new'>();
  const [deleting, setDeleting] = useState<ServerGroup>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function deleteGroup() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/server-groups/${deleting.id}`);
      setDeleting(undefined);
      await groups.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div hidden={Boolean(editing)}>
        <Section
          title="服务器分组"
          action={
            <>
              <RefreshButton onClick={groups.reload} />
              {canEdit && (
                <button className="button primary" onClick={() => setEditing('new')}>
                  <Plus size={18} />
                  创建分组
                </button>
              )}
            </>
          }
        >
          <ErrorBanner error={groups.error} retry={groups.reload} />
          {groups.loading ? (
            <Loading />
          ) : !groups.data?.length ? (
            <p className="mini-empty">暂无服务器分组</p>
          ) : (
            <div className="resource-list">
              {groups.data.map((group) => (
                <div key={group.id}>
                  <span className="resource-avatar">
                    <Users size={18} />
                  </span>
                  <div>
                    <strong>{group.name}</strong>
                    {group.description && <small>{group.description}</small>}
                    <div className="tags">
                      {group.serverIds.map((id) => (
                        <span className="tag" key={id}>
                          {servers.find((server) => server.id === id)?.name ?? id}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="tag">{group.serverIds.length} 台</span>
                  {canEdit && (
                    <span className="row-actions">
                      <button
                        className="icon-button bare muted"
                        aria-label={`编辑分组 ${group.name}`}
                        onClick={() => setEditing(group)}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-button bare muted"
                        aria-label={`删除分组 ${group.name}`}
                        onClick={() => {
                          setError('');
                          setDeleting(group);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
      {editing && (
        <GroupEditor
          group={editing === 'new' ? undefined : editing}
          servers={servers}
          serversLoading={serversLoading}
          onClose={() => setEditing(undefined)}
          onSave={() => {
            setEditing(undefined);
            void groups.reload();
          }}
        />
      )}
      {deleting && (
        <Confirm
          title="删除服务器分组"
          description={`删除「${deleting.name}」及其成员关联。`}
          onClose={() => !busy && setDeleting(undefined)}
          onConfirm={deleteGroup}
          busy={busy}
          error={error}
          label="删除分组"
          destructive
        />
      )}
    </>
  );
}

function GroupEditor({
  group,
  servers,
  serversLoading,
  onClose,
  onSave,
}: {
  group?: ServerGroup;
  servers: Server[];
  serversLoading: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const [selected, setSelected] = useState(group?.serverIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      name: String(form.get('name')).trim(),
      description: String(form.get('description')).trim(),
      serverIds: selected,
    };
    setBusy(true);
    setError('');
    try {
      if (group)
        await api(`/server-groups/${group.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await post('/server-groups', body);
      onSave();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor
      busy={busy}
      title={group ? '编辑服务器分组' : '创建服务器分组'}
      onClose={() => !busy && onClose()}
    >
      <Form onSubmit={save} busy={busy} error={error} onCancel={onClose}>
        <Field label="名称" required>
          <input name="name" defaultValue={group?.name} maxLength={100} required autoFocus />
        </Field>
        <Field label="说明">
          <textarea
            name="description"
            defaultValue={group?.description}
            maxLength={2000}
            rows={2}
          />
        </Field>
        <h3 className="field-title">分组成员</h3>
        {serversLoading ? (
          <Loading />
        ) : (
          <ServerPicker
            servers={servers}
            selected={selected}
            setSelected={setSelected}
            disabled={busy}
          />
        )}
      </Form>
    </InlineEditor>
  );
}

export function DeploymentHistory({
  rows,
  resolveName,
}: {
  rows: DeploymentSummary[];
  resolveName?: (row: DeploymentSummary) => string;
}) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>部署</th>
            <th>状态</th>
            <th>健康检查</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <a className="text-link" href={`#/tasks/${row.taskId}`}>
                  {resolveName?.(row) || '查看任务'}
                </a>
                <small className="cell-sub mono" title={row.releaseVersion}>
                  {row.releaseVersion?.slice(0, 12)}
                </small>
              </td>
              <td>
                <Status value={row.status} />
              </td>
              <td>
                <Status value={row.healthStatus} />
              </td>
              <td>{formatTime(row.finishedAt ?? row.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="mini-empty">暂无部署记录</p>
  );
}

export function ServerOverview({
  server,
  onClose,
  initialMetrics,
  monitorRow,
  canEdit,
  onMonitorChange,
}: {
  server: Server;
  onClose: () => void;
  initialMetrics: boolean;
  monitorRow?: MonitorRow;
  canEdit: boolean;
  onMonitorChange: () => void;
}) {
  const detail = useResource<ServerDetail>(`/servers/${server.id}`);
  const entry = detail.data;
  const [metrics, setMetrics] = useState(initialMetrics);
  return (
    <InlineEditor
      title={server.name}
      description={`${server.username}@${server.host}:${server.port}`}
      onClose={onClose}
      wide
    >
      <div className="form-body">
        <nav className="resource-section-switcher" aria-label="服务器详情">
          <button type="button" aria-pressed={!metrics} onClick={() => setMetrics(false)}>
            概览
          </button>
          <button type="button" aria-pressed={metrics} onClick={() => setMetrics(true)}>
            资源监控
          </button>
        </nav>
        {metrics ? (
          <ServerMonitoring
            id={server.id}
            canEdit={canEdit}
            onChange={onMonitorChange}
            summary={monitorRow}
          />
        ) : (
          <>
            <ErrorBanner error={detail.error} retry={detail.reload} />
            {detail.loading ? (
              <Loading />
            ) : (
              entry && (
                <>
                  <div className="task-meta">
                    <Status value={entry.status} />
                    <span>{entry.osType || '操作系统待检测'}</span>
                    <span>最近检测 {formatTime(entry.lastCheckedAt)}</span>
                  </div>
                  {entry.description && <p>{entry.description}</p>}
                  <div className="tags">
                    {(entry.groups ?? []).map((group) => (
                      <span className="tag" key={group.id}>
                        {group.name}
                      </span>
                    ))}
                    {(entry.projects ?? []).map((project) => (
                      <a className="text-link" key={project.id} href={`#/projects/${project.id}`}>
                        {project.name}
                      </a>
                    ))}
                  </div>
                  <h3 className="field-title">连接检测</h3>
                  {entry.probeHistory?.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>时间</th>
                            <th>状态</th>
                            <th>系统与资源</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entry.probeHistory.map((probe) => (
                            <tr key={probe.id}>
                              <td>{formatTime(probe.checkedAt)}</td>
                              <td>
                                <Status value={probe.status} />
                              </td>
                              <td>
                                {probe.osType ?? '—'}
                                {probe.metrics && (
                                  <small className="cell-sub">
                                    负载 {probe.metrics.loadAverage} · 内存可用{' '}
                                    {Math.round(probe.metrics.memoryAvailableKb / 1024)} MiB ·
                                    磁盘可用 {Math.round(probe.metrics.diskAvailableKb / 1024)} MiB
                                  </small>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mini-empty">暂无检测记录</p>
                  )}
                  <h3 className="field-title">最近命令与运维</h3>
                  {entry.recentCommands?.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>任务</th>
                            <th>状态</th>
                            <th>退出码</th>
                            <th>时间</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entry.recentCommands.map((command) => (
                            <tr key={command.id}>
                              <td>
                                <a className="text-link" href={`#/tasks/${command.taskId}`}>
                                  {command.name}
                                </a>
                              </td>
                              <td>
                                <Status value={command.status} />
                              </td>
                              <td>{command.exitCode ?? '—'}</td>
                              <td>{formatTime(command.finishedAt ?? command.startedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="mini-empty">暂无命令记录</p>
                  )}
                  <h3 className="field-title">最近部署</h3>
                  <DeploymentHistory rows={entry.recentDeployments ?? []} />
                </>
              )
            )}
          </>
        )}
      </div>
    </InlineEditor>
  );
}
