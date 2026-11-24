import { useEffect, useState } from 'react';
import { api, message, useResource } from '../../api';
import { ErrorBanner, Field, Section } from '../../components';
import type { Server } from '../../models';

const routeLabels = { chat: '助手对话', repository: '仓库分析', diagnosis: '任务诊断' };
type Purpose = keyof typeof routeLabels;
type Routes = Partial<Record<Purpose, string>>;
type Provider = { id: string; name: string; model: string; enabled: boolean; configured: boolean };

export function ModelRouting({ providers, admin }: { providers: Provider[]; admin: boolean }) {
  const routes = useResource<Routes>('/ai/routing');
  const [selected, setSelected] = useState<Routes>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (routes.data) setSelected(routes.data);
  }, [routes.data]);
  return (
    <Section title="模型路由" subtitle="按用途选择默认连接。对话中手动选择的模型优先。">
      <form
        className="section-body"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          setSaved(false);
          try {
            await api('/ai/routing', { method: 'PUT', body: JSON.stringify(selected) });
            await routes.reload();
            setSaved(true);
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <ErrorBanner error={error || routes.error} />
        <fieldset disabled={!admin || !routes.data || busy}>
          <div className="form-grid">
            {(Object.keys(routeLabels) as Purpose[]).map((purpose) => (
              <Field key={purpose} label={routeLabels[purpose]}>
                <select
                  value={selected[purpose] ?? ''}
                  onChange={(event) => {
                    setSelected({ ...selected, [purpose]: event.target.value || undefined });
                    setSaved(false);
                  }}
                >
                  <option value="">第一个可用连接</option>
                  {selected[purpose] && !providers.some((p) => p.id === selected[purpose]) && (
                    <option value={selected[purpose]} disabled>
                      已移除的连接
                    </option>
                  )}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!p.enabled || !p.configured}>
                      {p.name} · {p.model}
                      {!p.enabled || !p.configured ? '（不可用）' : ''}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
          {admin && (
            <button className="button primary small" type="submit">
              保存模型路由
            </button>
          )}
          {saved && <span role="status"> 已保存</span>}
        </fieldset>
      </form>
    </Section>
  );
}

const writeActions = {
  initialize_component: '初始化组件',
  execute_command: '执行命令',
  run_execution_flow: '启动已发布执行流',
  publish_source_branch: '提交评审分支',
  open_pull_request: '创建 PR',
};
type Action = keyof typeof writeActions;
export interface ActionRule {
  action: Action;
  effect: 'CONFIRM' | 'DENY';
  role?: 'OPERATOR' | 'ADMIN';
  serverId?: string;
  minimumTargets?: number;
}

export function ActionRules({
  rules,
  onChange,
  servers,
}: {
  rules: ActionRule[];
  onChange: (rules: ActionRule[]) => void;
  servers: Server[];
}) {
  function update(index: number, fields: Partial<ActionRule>) {
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...fields } : rule)));
  }
  return (
    <div>
      <h3 className="field-title">按条件限制写操作</h3>
      {rules.map((rule, index) => (
        <div className="form-grid" key={index}>
          <Field label="操作">
            <select
              value={rule.action}
              onChange={(event) => {
                const action = event.target.value as Action;
                update(index, {
                  action,
                  ...(isRepositoryAction(action) && {
                    serverId: undefined,
                    minimumTargets: undefined,
                  }),
                });
              }}
            >
              {Object.entries(writeActions).map(([key, label]) => (
                <option value={key} key={key}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="执行角色">
            <select
              value={rule.role ?? ''}
              onChange={(event) =>
                update(index, { role: (event.target.value as ActionRule['role']) || undefined })
              }
            >
              <option value="">全部</option>
              <option value="ADMIN">管理员</option>
              <option value="OPERATOR">运维人员</option>
            </select>
          </Field>
          {!isRepositoryAction(rule.action) && (
            <>
              <Field label="目标包含">
                <select
                  value={rule.serverId ?? ''}
                  onChange={(event) => update(index, { serverId: event.target.value || undefined })}
                >
                  <option value="">任意服务器</option>
                  {rule.serverId && !servers.some((s) => s.id === rule.serverId) && (
                    <option value={rule.serverId}>已移除的服务器</option>
                  )}
                  {servers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="至少几台目标">
                <input
                  type="number"
                  min="1"
                  max="100"
                  placeholder="不限"
                  value={rule.minimumTargets ?? ''}
                  onChange={(event) =>
                    update(index, {
                      minimumTargets: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </Field>
            </>
          )}
          <Field label="匹配时">
            <select
              value={rule.effect}
              onChange={(event) =>
                update(index, { effect: event.target.value as ActionRule['effect'] })
              }
            >
              <option value="CONFIRM">要求确认</option>
              <option value="DENY">禁止执行</option>
            </select>
          </Field>
          <button
            className="button secondary small"
            type="button"
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
          >
            删除此规则
          </button>
        </div>
      ))}
      <button
        className="button secondary small"
        type="button"
        disabled={rules.length >= 32}
        onClick={() => onChange([...rules, { action: 'initialize_component', effect: 'CONFIRM' }])}
      >
        添加条件规则
      </button>
    </div>
  );
}
function isRepositoryAction(action: Action) {
  return action === 'open_pull_request' || action === 'publish_source_branch';
}
