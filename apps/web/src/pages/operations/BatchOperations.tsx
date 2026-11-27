import { useState, type FormEvent } from 'react';
import { Play } from 'lucide-react';
import { ApiError, formatTime, message, navigate, post, useResource, useRoute } from '../../api';
import { ErrorBanner, Field, Loading, PageHeader, Section } from '../../components';
import type {
  OperationParameter,
  OperationStep,
  ParameterValue,
  Plan,
  Task,
  User,
} from '../../models';
import {
  BatchTargetPicker,
  ResolvedTargets,
  useBatchSelection,
  type TargetPreview,
  type TargetSelection,
} from './BatchTargets';
import { OperationPlanWorkspace } from './OperationPlanWorkspace';
import type { Chain } from './OperationPlanCanvas';
import { OperationSchedulesPage } from './OperationSchedules';
import { TargetedOperationsAI } from './TargetedOperationsAI';
import { TerminalCommands } from './TerminalCommands';
import { operationsTabs, type OperationsTab } from './operation-routes';

interface CommandReuse {
  name: string;
  command: string;
  selection: TargetSelection;
  previousTargetHash?: string;
  previousTargets: TargetPreview['targets'];
}

interface PlanVersion {
  id: string;
  version: number;
  createdAt: number;
  parameters?: OperationParameter[];
  chain?: Chain;
}

interface TaskReview {
  targets: TargetPreview;
  plan?: {
    id: string;
    name: string;
    version: number;
    parameters: Record<string, ParameterValue>;
    steps: Pick<OperationStep, 'name' | 'command'>[];
  };
}

function hasTargets(selection: TargetSelection) {
  return Boolean(selection.serverIds?.length || selection.groupIds?.length);
}

function operationParameters(form: FormData, definitions: OperationParameter[]) {
  const parameters: Record<string, ParameterValue> = {};
  for (const definition of definitions) {
    const value = String(form.get(definition.name) ?? '');
    if (value === '' && definition.type !== 'STRING') continue;
    parameters[definition.name] =
      definition.type === 'BOOLEAN'
        ? value === 'true'
        : definition.type === 'NUMBER'
          ? Number(value)
          : value;
  }
  return parameters;
}

function ParameterField({ parameter }: { parameter: OperationParameter }) {
  const defaultValue = parameter.defaultValue === undefined ? '' : String(parameter.defaultValue);
  return (
    <Field label={parameter.name} hint={parameter.description} required={parameter.required}>
      {parameter.type === 'BOOLEAN' ? (
        <select name={parameter.name} required={parameter.required} defaultValue={defaultValue}>
          <option value="">未指定</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      ) : (
        <input
          name={parameter.name}
          type={parameter.type === 'NUMBER' ? 'number' : 'text'}
          step={parameter.type === 'NUMBER' ? 'any' : undefined}
          defaultValue={defaultValue}
          required={parameter.required}
        />
      )}
    </Field>
  );
}

export function OperationsCenterPage({ tab, user }: { tab: OperationsTab; user: User }) {
  const query = new URLSearchParams(useRoute().split('?')[1]);
  const reuseId = query.get('reuse');
  const planId = query.get('planId') ?? '';
  const reviewVersion = Number(query.get('version')) || undefined;
  const activeTab = tab === 'commands' && reuseId ? 'tasks' : tab;
  return (
    <>
      <PageHeader
        title="运维命令"
        description="在终端执行命令，或提交脚本和运维方案到任务中心。"
        action={
          <a href="#/tasks" className="button secondary">
            查看执行记录
          </a>
        }
      />
      <nav className="record-tabs" aria-label="运维中心">
        {(Object.keys(operationsTabs) as OperationsTab[]).map((key) => (
          <a
            key={key}
            href={`#/operations/${key}`}
            className={key === activeTab ? 'active' : ''}
            aria-current={key === activeTab ? 'page' : undefined}
          >
            {operationsTabs[key]}
          </a>
        ))}
      </nav>
      {activeTab === 'commands' ? (
        <TerminalCommands user={user} />
      ) : activeTab === 'tasks' ? (
        <CommandWorkspace
          key={`${reuseId ?? ''}:${planId}:${reviewVersion ?? ''}`}
          user={user}
          reuseId={reuseId}
          planId={planId}
          reviewVersion={reviewVersion}
        />
      ) : activeTab === 'schedules' ? (
        <OperationSchedulesPage user={user} />
      ) : (
        <OperationPlanWorkspace user={user} />
      )}
    </>
  );
}

function CommandWorkspace({
  user,
  reuseId,
  planId,
  reviewVersion,
}: {
  user: User;
  reuseId: string | null;
  planId: string;
  reviewVersion?: number;
}) {
  const reusable = useResource<CommandReuse>(
    reuseId && user.role !== 'VIEWER'
      ? `/tasks/${encodeURIComponent(reuseId)}/command-reuse`
      : null,
  );
  if (reuseId && reusable.loading) return <Loading />;
  return (
    <>
      <ErrorBanner error={reusable.error} retry={reusable.reload} />
      <CommandTaskPage
        user={user}
        reuse={reusable.data ?? undefined}
        initialPlanId={planId}
        initialVersion={reviewVersion}
      />
    </>
  );
}

function CommandTaskPage({
  user,
  reuse,
  initialPlanId,
  initialVersion,
}: {
  user: User;
  reuse?: CommandReuse;
  initialPlanId: string;
  initialVersion?: number;
}) {
  const source = reuse?.selection;
  const previousSelector = Boolean(
    source?.deploymentTargetIds?.length ||
    source?.tags?.length ||
    source?.projectIds?.length ||
    source?.environmentIds?.length,
  );
  const { selection, setSelection } = useBatchSelection(
    previousSelector ? { serverIds: reuse?.previousTargets.map(({ id }) => id) } : source,
  );
  const [command, setCommand] = useState(reuse?.command ?? '');
  const [name, setName] = useState(reuse?.name ?? '');
  const [planId, setPlanId] = useState(initialPlanId);
  const [versionNumber, setVersionNumber] = useState(initialVersion);
  const [review, setReview] = useState<TaskReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastPreview, setLastPreview] = useState<Pick<TargetPreview, 'targets' | 'targetHash'>>();
  const canEdit = user.role !== 'VIEWER';
  const plans = useResource<Plan[]>(canEdit ? '/operation-plans' : null);
  const availablePlans = (plans.data ?? []).filter((plan) => plan.enabled !== false);
  const plan = availablePlans.find(({ id }) => id === planId);
  const planEndpoint = plan ? `/operation-plans/${encodeURIComponent(plan.id)}` : null;
  const versions = useResource<PlanVersion[]>(planEndpoint ? `${planEndpoint}/versions` : null);
  const version = versions.data?.find(
    (item) => item.version === (versionNumber ?? plan?.currentVersion),
  );
  const preview = review?.targets;
  const editing = canEdit && !busy && !review;
  const ready =
    editing && hasTargets(selection) && (planId ? Boolean(version) : Boolean(command.trim()));
  const comparison =
    lastPreview ??
    (reuse && { targets: reuse.previousTargets, targetHash: reuse.previousTargetHash });
  const added =
    preview?.targets.filter(
      (target) => comparison && !comparison.targets.some(({ id }) => target.id === id),
    ) ?? [];
  const removed =
    comparison?.targets.filter(
      (target) => preview && !preview.targets.some(({ id }) => target.id === id),
    ) ?? [];
  const changed =
    preview?.targets.filter((target) =>
      comparison?.targets.some(
        ({ id, host, name }) => id === target.id && (host !== target.host || name !== target.name),
      ),
    ) ?? [];

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    const executionPlan =
      plan && version
        ? {
            id: plan.id,
            name: plan.name,
            version: version.version,
            parameters: operationParameters(
              new FormData(event.currentTarget),
              version.parameters ?? [],
            ),
            steps:
              version.chain?.nodes.flatMap(({ type, name, command }) =>
                type === 'COMMAND' && command ? [{ name, command }] : [],
              ) ?? [],
          }
        : undefined;
    setBusy(true);
    setError('');
    try {
      setReview({
        targets: await post<TargetPreview>('/commands/preview', selection),
        plan: executionPlan,
      });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!review || !canEdit || busy) return;
    setBusy(true);
    setError('');
    try {
      const confirmed = {
        ...selection,
        expectedTargetHash: review.targets.targetHash,
        confirmed: true,
      };
      const task = review.plan
        ? await post<Task>(`/operation-plans/${encodeURIComponent(review.plan.id)}/run`, {
            ...confirmed,
            version: review.plan.version,
            parameters: review.plan.parameters,
          })
        : await post<Task>('/commands/execute', {
            ...confirmed,
            name: name.trim() || '执行命令任务',
            command,
          });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      if (err instanceof ApiError && [400, 409].includes(err.status)) {
        setLastPreview(review.targets);
        setReview(undefined);
      }
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorBanner error={plans.error} retry={plans.reload} />
      <form className="command-layout" onSubmit={prepare}>
        <div>
          <Section title="执行目标" body="compact">
            <BatchTargetPicker selection={selection} onChange={setSelection} disabled={!editing} />
          </Section>
        </div>
        <Section title="执行任务" className="operations-task-command">
          <div className="command-options">
            {canEdit && (
              <Field label="任务内容">
                <select
                  value={planId}
                  disabled={!editing}
                  onChange={(event) => {
                    setPlanId(event.target.value);
                    setVersionNumber(undefined);
                    setError('');
                  }}
                >
                  <option value="">编写 Shell 命令</option>
                  {planId && !plan && <option value={planId}>运维方案不可用</option>}
                  {availablePlans.map(({ id, name: label }) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {planId ? (
              <fieldset disabled={!editing} className="task-plan-fields">
                <ErrorBanner error={versions.error} retry={versions.reload} />
                {versions.loading && <Loading />}
                {!!versions.data?.length && (
                  <Field label="执行版本">
                    <select
                      value={version?.version ?? ''}
                      onChange={(event) => setVersionNumber(Number(event.target.value))}
                    >
                      {!version && (
                        <option value="" disabled>
                          请选择版本
                        </option>
                      )}
                      {versions.data.map((item) => (
                        <option key={item.id} value={item.version}>
                          v{item.version} · {formatTime(item.createdAt)}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {!!version?.parameters?.length && (
                  <div className="form-grid" key={version.id}>
                    {version.parameters.map((parameter) => (
                      <ParameterField key={parameter.name} parameter={parameter} />
                    ))}
                  </div>
                )}
              </fieldset>
            ) : (
              <>
                <div className="command-editor">
                  <textarea
                    aria-label="Shell 命令"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    disabled={!editing}
                    maxLength={65536}
                    spellCheck={false}
                    rows={4}
                    required
                    placeholder="uname -a && uptime"
                  />
                </div>
                <Field label="任务名称（可选）">
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={100}
                    disabled={!editing}
                  />
                </Field>
              </>
            )}
            <ErrorBanner error={preview ? '' : error} />
            {!review && (
              <div className="row-actions">
                <button className="button primary" disabled={!ready}>
                  <Play size={16} />
                  预览并执行
                </button>
              </div>
            )}
          </div>
        </Section>
      </form>
      {review && preview && (
        <Section
          title="确认执行目标"
          subtitle={
            review.plan
              ? `将在 ${preview.count} 台服务器上运行 ${review.plan.name} · v${review.plan.version}`
              : `将在 ${preview.count} 台服务器上运行上方命令`
          }
        >
          <div className="form-body">
            <ResolvedTargets preview={preview} />
            {review.plan?.steps.map(({ name: stepName, command: shell }, index) => (
              <details className="version-entry" key={index}>
                <summary>{stepName}</summary>
                <pre className="schedule-command">{shell}</pre>
              </details>
            ))}
            {(added.length > 0 ||
              removed.length > 0 ||
              changed.length > 0 ||
              (comparison?.targetHash && comparison.targetHash !== preview.targetHash)) && (
              <div role="status" className="command-target-changes">
                <strong>执行目标与上次确认的范围有变化</strong>
                {!!added.length && <p>新增 {added.map(({ name: label }) => label).join('、')}</p>}
                {!!removed.length && (
                  <p>移除 {removed.map(({ name: label }) => label).join('、')}</p>
                )}
                {!!changed.length && (
                  <p>地址或名称变化 {changed.map(({ name: label }) => label).join('、')}</p>
                )}
                {!added.length && !removed.length && !changed.length && (
                  <p>请复核目标的 SSH 配置。</p>
                )}
              </div>
            )}
            <ErrorBanner error={error} />
            <div className="row-actions">
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setReview(undefined);
                  setError('');
                }}
              >
                返回编辑
              </button>
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() => void execute()}
              >
                确认执行
              </button>
            </div>
          </div>
        </Section>
      )}
      {canEdit && !planId && (
        <TargetedOperationsAI
          key={JSON.stringify(selection)}
          user={user}
          selection={selection}
          disabled={!editing || !hasTargets(selection)}
        />
      )}
    </>
  );
}
