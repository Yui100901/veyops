import { useState, type FormEvent } from 'react';
import { ArrowLeft, CirclePlay, Pencil, Plus, Sparkles, Trash2, Workflow } from 'lucide-react';
import { api, formatTime, message, post, remove, useResource } from '../../api';
import { Confirm, Empty, ErrorBanner, Field, Loading, Section } from '../../components';
import type { OperationParameter, ParameterValue, Plan, User } from '../../models';
import { BatchTargetPicker, type TargetSelection } from './BatchTargets';
import { OperationCanvas, type Chain } from './OperationPlanCanvas';
import './operation-plan-workspace.css';

type CanvasPlan = Plan & { chain: Chain };
type PlanVersion = {
  id: string;
  version: number;
  createdAt: number;
  name?: string;
  description?: string;
  osRequirements?: string;
  chain: Chain;
  parameters?: OperationParameter[];
};
type PlanInput = {
  name: string;
  description: string;
  category: string;
  osRequirements: string;
  parameters?: OperationParameter[];
  chain: Chain;
};
type Advice = {
  targets: { serverId: string; name: string; os?: string; manager?: string }[];
  notes?: string;
} & (
  | { kind: 'RECOMMENDATION'; plan: Pick<CanvasPlan, 'id' | 'name'> & { version: number } }
  | { kind: 'DRAFT'; draft: PlanInput }
  | { kind: 'UNAVAILABLE' }
);

function starterPlan(): PlanInput {
  return {
    name: '',
    description: '',
    category: 'CUSTOM',
    osRequirements: '',
    chain: {
      nodes: [
        { id: 'start', type: 'START', name: '开始', x: 30, y: 60 },
        { id: 'command', type: 'COMMAND', name: '执行命令', x: 270, y: 60, command: '' },
        { id: 'end', type: 'END', name: '结束', x: 510, y: 60 },
      ],
      edges: [
        { from: 'start', to: 'command' },
        { from: 'command', to: 'end' },
      ],
    },
  };
}

function ParameterEditor({
  value,
  onChange,
}: {
  value: OperationParameter[];
  onChange: (value: OperationParameter[]) => void;
}) {
  function patch(index: number, next: Partial<OperationParameter>) {
    onChange(value.map((row, key) => (key === index ? { ...row, ...next } : row)));
  }
  function defaultValue(raw: string, type: OperationParameter['type']): ParameterValue | undefined {
    return raw === ''
      ? undefined
      : type === 'NUMBER'
        ? Number(raw)
        : type === 'BOOLEAN'
          ? raw === 'true'
          : raw;
  }
  return (
    <details className="operation-plan-parameters">
      <summary>运行参数{value.length ? ` · ${value.length} 项` : ''}</summary>
      <p className="field-note">在命令中使用 $VEYOPS_PARAM_参数名。</p>
      {value.map((parameter, index) => (
        <div key={index} className="operation-plan-parameter">
          <Field label="参数名">
            <input
              value={parameter.name}
              maxLength={64}
              placeholder="PACKAGE_NAME"
              onChange={(event) => patch(index, { name: event.target.value })}
            />
          </Field>
          <Field label="类型">
            <select
              value={parameter.type}
              onChange={(event) =>
                patch(index, {
                  type: event.target.value as OperationParameter['type'],
                  defaultValue: undefined,
                })
              }
            >
              <option value="STRING">文本</option>
              <option value="NUMBER">数字</option>
              <option value="BOOLEAN">布尔值</option>
            </select>
          </Field>
          <Field label="默认值">
            {parameter.type === 'BOOLEAN' ? (
              <select
                value={String(parameter.defaultValue ?? '')}
                onChange={(event) =>
                  patch(index, { defaultValue: defaultValue(event.target.value, parameter.type) })
                }
              >
                <option value="">无</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : (
              <input
                type={parameter.type === 'NUMBER' ? 'number' : 'text'}
                value={String(parameter.defaultValue ?? '')}
                onChange={(event) =>
                  patch(index, { defaultValue: defaultValue(event.target.value, parameter.type) })
                }
              />
            )}
          </Field>
          <Field label="说明">
            <input
              value={parameter.description ?? ''}
              maxLength={200}
              onChange={(event) => patch(index, { description: event.target.value })}
            />
          </Field>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={parameter.required ?? false}
              onChange={(event) => patch(index, { required: event.target.checked })}
            />
            必填
          </label>
          <button
            type="button"
            className="icon-button bare"
            aria-label={`删除参数 ${parameter.name || index + 1}`}
            onClick={() => onChange(value.filter((_row, key) => key !== index))}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button compact"
        disabled={value.length >= 32}
        onClick={() => onChange([...value, { name: '', type: 'STRING' }])}
      >
        <Plus size={15} />
        添加参数
      </button>
    </details>
  );
}

function PlanAssistant({
  onDraft,
  onView,
}: {
  onDraft: (draft: PlanInput) => void;
  onView: (id: string, version: number) => void;
}) {
  const [selection, setSelection] = useState<TargetSelection>({});
  const [instructions, setInstructions] = useState('');
  const [advice, setAdvice] = useState<Advice>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function suggest(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setAdvice(undefined);
    try {
      setAdvice(
        await post<Advice>('/operation-plans/ai-assist', {
          serverIds: selection.serverIds,
          groupIds: selection.groupIds,
          instructions: instructions.trim(),
        }),
      );
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="AI 运维方案">
      <form className="operation-plan-assistant" onSubmit={suggest}>
        <BatchTargetPicker
          selection={selection}
          disabled={busy}
          onChange={(next) => {
            setSelection(next);
            setAdvice(undefined);
          }}
        />
        <Field label="运维要求">
          <textarea
            value={instructions}
            disabled={busy}
            onChange={(event) => {
              setInstructions(event.target.value);
              setAdvice(undefined);
            }}
            rows={3}
            maxLength={2000}
            placeholder="在所选服务器上使用系统包管理器安装 Nginx。"
            required
          />
        </Field>
        <div>
          <button
            className="button primary"
            disabled={
              busy ||
              !instructions.trim() ||
              !(selection.serverIds?.length || selection.groupIds?.length)
            }
          >
            <Sparkles size={16} />
            {busy ? '正在检查目标和方案' : '检查目标并获取建议'}
          </button>
        </div>
        <ErrorBanner error={error} />
      </form>
      {advice && (
        <div className="operation-plan-advice">
          <div className="operation-plan-target-facts">
            {advice.targets.map(({ serverId, name, os, manager }) => (
              <span key={serverId}>
                {name} · {os ?? '未知发行版'} · {manager ?? '无已识别包管理器'}
              </span>
            ))}
          </div>
          {advice.notes && <p>{advice.notes}</p>}
          {advice.kind === 'RECOMMENDATION' && (
            <button
              className="button secondary"
              type="button"
              onClick={() => onView(advice.plan.id, advice.plan.version)}
            >
              查看 {advice.plan.name} · v{advice.plan.version}
            </button>
          )}
          {advice.kind === 'DRAFT' && (
            <button
              className="button secondary"
              type="button"
              onClick={() => onDraft(advice.draft)}
            >
              新建方案并审阅草案
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

function PlanEditor({
  initial,
  id,
  onClose,
  onSaved,
}: {
  initial: PlanInput;
  id?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [plan, setPlan] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const payload = { ...plan, name: plan.name.trim() };
    try {
      if (id)
        await api(`/operation-plans/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await post('/operation-plans', payload);
      onSaved();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title={id ? '编辑运维方案' : '新建运维方案'}
      action={
        <button type="button" className="button compact" onClick={onClose}>
          <ArrowLeft size={16} />
          返回方案列表
        </button>
      }
    >
      <form className="operation-plan-form" onSubmit={save}>
        <div className="operation-chain-fields">
          <Field label="方案名称">
            <input
              value={plan.name}
              onChange={(event) => setPlan({ ...plan, name: event.target.value })}
              required
              maxLength={120}
            />
          </Field>
          <Field label="适用系统">
            <input
              value={plan.osRequirements}
              onChange={(event) => setPlan({ ...plan, osRequirements: event.target.value })}
              maxLength={200}
            />
          </Field>
        </div>
        <Field label="说明">
          <textarea
            rows={2}
            value={plan.description}
            onChange={(event) => setPlan({ ...plan, description: event.target.value })}
            maxLength={2000}
          />
        </Field>
        <OperationCanvas
          chain={plan.chain}
          onChange={(chain) => setPlan((previous) => ({ ...previous, chain }))}
        />
        <ParameterEditor
          value={plan.parameters ?? []}
          onChange={(parameters) => setPlan({ ...plan, parameters })}
        />
        <ErrorBanner error={error} />
        <div>
          <button className="button primary" disabled={busy || !plan.name.trim()}>
            {busy ? '保存中' : '保存方案版本'}
          </button>
        </div>
      </form>
    </Section>
  );
}

function PlanViewer({
  plan,
  user,
  initialVersion,
  onClose,
  onEdit,
}: {
  plan: CanvasPlan;
  user: User;
  initialVersion: number;
  onClose: () => void;
  onEdit: () => void;
}) {
  const versions = useResource<PlanVersion[]>(`/operation-plans/${plan.id}/versions`);
  const [version, setVersion] = useState(initialVersion);
  const selected = versions.data?.find((item) => item.version === version);
  const definition = selected ?? (version === plan.currentVersion ? plan : undefined);
  const canEdit = user.role !== 'VIEWER';
  return (
    <Section
      title={definition?.name ?? plan.name}
      action={
        <button className="button compact" onClick={onClose}>
          <ArrowLeft size={16} />
          返回方案列表
        </button>
      }
    >
      <div className="operation-plan-view">
        <div className="operation-plan-view-actions">
          <Field label="方案版本">
            <select value={version} onChange={(event) => setVersion(Number(event.target.value))}>
              {versions.data?.length ? (
                versions.data.map(({ version: value, createdAt }) => (
                  <option key={value} value={value}>
                    v{value} · {formatTime(createdAt)}
                  </option>
                ))
              ) : (
                <option value={version}>v{version}</option>
              )}
            </select>
          </Field>
          {canEdit && plan.enabled !== false && (
            <a
              className="button primary"
              href={`#/operations/tasks?planId=${encodeURIComponent(plan.id)}&version=${version}`}
            >
              <CirclePlay size={16} />
              执行任务
            </a>
          )}
          {canEdit && (
            <button className="button compact" onClick={onEdit}>
              <Pencil size={15} />
              编辑最新版本
            </button>
          )}
        </div>
        <ErrorBanner error={versions.error} retry={versions.reload} />
        {definition ? (
          <>
            {(definition.description || definition.osRequirements) && (
              <div className="operation-plan-description">
                {definition.description && <p>{definition.description}</p>}
                {definition.osRequirements && (
                  <span className="field-note">适用系统 · {definition.osRequirements}</span>
                )}
              </div>
            )}
            <OperationCanvas key={version} chain={definition.chain} />
            {Boolean(definition.parameters?.length) && (
              <p className="field-note">
                运行参数 · {definition.parameters?.map(({ name }) => name).join('、')}
              </p>
            )}
          </>
        ) : versions.loading ? (
          <Loading />
        ) : (
          <Empty title="找不到指定版本" description="请从版本列表中选择可用版本。" />
        )}
      </div>
    </Section>
  );
}

export function OperationPlanWorkspace({ user }: { user: User }) {
  const resource = useResource<CanvasPlan[]>('/operation-plans');
  const [editor, setEditor] = useState<{ start: PlanInput; id?: string }>();
  const [view, setView] = useState<{ id: string; version: number }>();
  const [assistant, setAssistant] = useState(false);
  const [archive, setArchive] = useState<CanvasPlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEdit = user.role !== 'VIEWER';
  const viewing = resource.data?.find(({ id }) => id === view?.id);
  function edit(plan: CanvasPlan) {
    const { id, name, description, category, osRequirements, chain, parameters } = plan;
    setView(undefined);
    setEditor({
      id,
      start: {
        name,
        description,
        category,
        osRequirements: osRequirements ?? '',
        chain,
        parameters,
      },
    });
  }
  async function archivePlan() {
    if (!archive) return;
    setBusy(true);
    setError('');
    try {
      await remove(`/operation-plans/${archive.id}`);
      setArchive(undefined);
      await resource.reload();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }
  if (editor)
    return (
      <PlanEditor
        initial={editor.start}
        id={editor.id}
        onClose={() => setEditor(undefined)}
        onSaved={() => {
          setEditor(undefined);
          void resource.reload();
        }}
      />
    );
  if (view && viewing)
    return (
      <PlanViewer
        plan={viewing}
        user={user}
        initialVersion={view.version}
        onEdit={() => edit(viewing)}
        onClose={() => setView(undefined)}
      />
    );
  return (
    <div className="operation-plan-workspace">
      <ErrorBanner error={resource.error} retry={resource.reload} />
      <Section
        title="运维方案"
        action={
          canEdit && (
            <div className="operation-plan-list-actions">
              <button
                className="button compact"
                onClick={() => setAssistant(!assistant)}
                aria-expanded={assistant}
              >
                <Sparkles size={16} />
                AI 辅助
              </button>
              <button
                className="button secondary"
                onClick={() => setEditor({ start: starterPlan() })}
              >
                <Plus size={16} />
                创建方案
              </button>
            </div>
          )
        }
      >
        {resource.loading ? (
          <Loading />
        ) : !resource.data?.length ? (
          <Empty
            title="暂无运维方案"
            description={canEdit ? '创建方案后可在执行任务中选择使用。' : ''}
          />
        ) : (
          <div className="resource-list operation-plan-list">
            {resource.data.map((plan) => (
              <div key={plan.id}>
                <span className="resource-avatar">
                  <Workflow size={18} />
                </span>
                <div>
                  <strong>{plan.name}</strong>
                  <small>{plan.description || plan.osRequirements}</small>
                </div>
                <span className="tag">
                  {plan.enabled === false ? '已归档' : `v${plan.currentVersion}`}
                </span>
                <span className="row-actions">
                  <button
                    className="button compact"
                    onClick={() => setView({ id: plan.id, version: plan.currentVersion })}
                  >
                    查看执行链
                  </button>
                  {canEdit && (
                    <button
                      className="icon-button bare"
                      aria-label={`编辑 ${plan.name}`}
                      onClick={() => edit(plan)}
                    >
                      <Pencil size={16} />
                    </button>
                  )}
                  {canEdit && plan.enabled !== false && (
                    <button
                      className="icon-button bare"
                      aria-label={`归档 ${plan.name}`}
                      onClick={() => {
                        setError('');
                        setArchive(plan);
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
      {assistant && (
        <PlanAssistant
          onDraft={(start) => {
            setEditor({ start });
            setAssistant(false);
          }}
          onView={(id, version) => setView({ id, version })}
        />
      )}
      {archive && (
        <Confirm
          title="归档运维方案"
          description={`归档「${archive.name}」，保留版本和运行记录。`}
          onClose={() => !busy && setArchive(undefined)}
          onConfirm={archivePlan}
          error={error}
          busy={busy}
          destructive
          label="归档"
        />
      )}
    </div>
  );
}
