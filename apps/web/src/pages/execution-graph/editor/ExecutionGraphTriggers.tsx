import { useState } from 'react';
import { Play, Plus } from 'lucide-react';
import { api, message, useResource } from '../../../api';
import { ErrorBanner, Loading, RefreshButton, Status } from '../../../components';
import type { ProjectDetail } from '../../../models';
import { ExecutionGraphTriggerDetails } from './ExecutionGraphTriggerDetails';
import { ExecutionGraphTriggerEditor } from './ExecutionGraphTriggerEditor';
import {
  triggerChoice,
  triggerChoices,
  triggerDate,
  triggerRequest,
  triggerSourceName,
  type TriggerFlow,
  type TriggerPreflight,
  type TriggerRule,
} from './graph-trigger-model';
import './execution-graph-triggers.css';

export function ExecutionGraphTriggers({
  path,
  project,
  startId,
  latestVersion,
  flows,
  canManage,
  canInvoke,
  manualHref,
  onPrepareDraft,
  issueHref,
  onRun,
}: {
  path: string;
  project: ProjectDetail;
  startId: string;
  latestVersion: number | null;
  flows: TriggerFlow[];
  canManage: boolean;
  canInvoke: boolean;
  manualHref?: string;
  onPrepareDraft?: () => Promise<number>;
  issueHref?: (issue: NonNullable<TriggerPreflight['issue']>) => string;
  onRun: (id: string) => void;
}) {
  const rulesPath = path + '/triggers';
  const rules = useResource<TriggerRule[]>(rulesPath, 8000);
  const [editing, setEditing] = useState<TriggerRule | 'create'>();
  const [selected, setSelected] = useState<string>();
  const [saved, setSaved] = useState<TriggerRule>();
  const [error, setError] = useState('');
  const [pausing, setPausing] = useState<string>();
  const scopedRules = rules.data?.filter(({ flowId }) => flowId === startId) ?? [];
  const displayed =
    saved && !scopedRules.some(({ id }) => id === saved.id) ? [...scopedRules, saved] : scopedRules;
  const rule = displayed.find(({ id }) => id === selected);

  async function pause(rule: TriggerRule) {
    if (pausing) return;
    setPausing(rule.id);
    setError('');
    try {
      await api<TriggerRule>(rulesPath + '/' + rule.id, {
        method: 'PATCH',
        body: JSON.stringify(triggerRequest(rule, false)),
      });
      await rules.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setPausing(undefined);
    }
  }

  function choose(id: string) {
    setSelected(selected === id ? undefined : id);
    if (saved?.secret) setSaved({ ...saved, secret: undefined });
  }

  return (
    <section className="graph-start-rules graph-properties" aria-label="触发器管理">
      <div className="heading-actions">
        <h4>触发器管理</h4>
        <div className="heading-actions">
          <RefreshButton onClick={rules.reload} />
          {canManage && !editing && (
            <button
              type="button"
              className="button primary small"
              onClick={() => setEditing('create')}
            >
              <Plus size={16} /> 添加触发规则
            </button>
          )}
        </div>
      </div>
      <div className="graph-trigger-manual">
        <div>
          <strong>手动运行</strong>
          <small className="cell-detail">
            {latestVersion ? '当前发布版 v' + latestVersion : '发布可运行的执行流后可手动运行。'}
          </small>
        </div>
        {canInvoke && latestVersion && manualHref && (
          <a className="button secondary small" href={manualHref}>
            <Play size={15} /> 前往运行
          </a>
        )}
      </div>
      <ErrorBanner error={rules.error || error} />
      {!latestVersion && canManage && (
        <p className="field-note">可以先保存触发规则草稿。发布执行流后再预检并启用。</p>
      )}
      {editing && canManage && (
        <ExecutionGraphTriggerEditor
          key={editing === 'create' ? 'create' : editing.id}
          path={rulesPath}
          project={project}
          startId={startId}
          latestVersion={latestVersion}
          rule={editing === 'create' ? undefined : editing}
          flows={flows}
          issueHref={issueHref}
          onPrepareDraft={onPrepareDraft}
          onCancel={() => setEditing(undefined)}
          onSaved={(next) => {
            setSaved(next);
            setSelected(next.id);
            setEditing(undefined);
            void rules.reload();
          }}
        />
      )}
      {rules.loading ? (
        <Loading />
      ) : displayed.length > 0 ? (
        <ul className="graph-start-rule-list">
          {displayed.map((item) => (
            <li key={item.id} className="graph-properties">
              <div className="heading-actions">
                <strong>{item.name}</strong>
                <Status value={item.enabled ? 'ACTIVE' : 'DISABLED'} />
              </div>
              <small className="cell-detail">
                {triggerChoices[triggerChoice(item)]}
                {item.enabled && item.version ? ' · 跟随当前发布版 v' + item.version : ''}
              </small>
              {(item.resolvedRepositoryId || item.repositoryId) && (
                <small className="cell-detail">
                  {triggerSourceName(project, item.resolvedRepositoryId || item.repositoryId)}
                  {item.resolvedRef || item.ref ? ' · ' + (item.resolvedRef || item.ref) : ''}
                </small>
              )}
              {item.nextAt && (
                <small className="cell-detail">
                  {triggerChoice(item) === 'POLL' ? '下次检查' : '下次运行'} ·{' '}
                  {triggerDate(item.nextAt, item.timeZone ?? undefined)}
                  {item.timeZone ? ' · ' + item.timeZone : ''}
                </small>
              )}
              {item.observation?.lastCheckedAt && (
                <small className="cell-detail">
                  最近检查 ·{' '}
                  {triggerDate(item.observation.lastCheckedAt, item.timeZone ?? undefined)}
                  {item.observation.commitSha && (
                    <>
                      {' '}
                      · <code>{item.observation.commitSha}</code>
                    </>
                  )}
                </small>
              )}
              {item.observation?.error && <ErrorBanner error={item.observation.error} />}
              <div className="heading-actions">
                <button
                  type="button"
                  className="button secondary small"
                  aria-expanded={selected === item.id}
                  onClick={() => choose(item.id)}
                >
                  {selected === item.id ? '收起事件' : '接收设置与事件'}
                </button>
                {canManage && (
                  <>
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => setEditing(item)}
                    >
                      {item.enabled ? '编辑' : '配置与启用'}
                    </button>
                    {item.enabled && (
                      <button
                        type="button"
                        className="button secondary small"
                        disabled={Boolean(pausing)}
                        onClick={() => void pause(item)}
                      >
                        {pausing === item.id ? '暂停中…' : '暂停'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        !editing && <div className="mini-empty">此开始节点尚无自动触发规则。</div>
      )}
      {rule && (
        <ExecutionGraphTriggerDetails
          key={rule.id + ':' + rule.kind + ':' + (rule.webhookProtocol ?? '')}
          path={rulesPath + '/' + rule.id}
          rule={rule}
          project={project}
          initialSecret={saved?.id === rule.id ? saved.secret : undefined}
          canManage={canManage}
          canInvoke={canInvoke}
          onRun={onRun}
          onChanged={() => void rules.reload()}
        />
      )}
    </section>
  );
}
