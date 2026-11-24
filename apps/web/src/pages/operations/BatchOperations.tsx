import { operationsTabs, type OperationsTab } from './operation-routes';
import { InlineEditor, useInlineEditor } from '../../InlineEditor';
import { useState } from 'react';
import { ContextAIButton } from '../ai/AI';
import type { FormEvent, ReactNode } from 'react';
import { FileCode2, Pencil, Play, Plus, Terminal, Trash2 } from 'lucide-react';
import { ApiError, api, formatTime, message, navigate, post, remove, useResource } from '../../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  PageHeader,
  Section,
} from '../../components';
import type {
  OperationParameter,
  OperationStep,
  ParameterValue,
  Plan,
  Task,
  User,
} from '../../models';
import {
  BatchStrategy,
  BatchTargetPicker,
  defaultExecutionOptions,
  ResolvedTargets,
  useBatchSelection,
} from './BatchTargets';
import type { ExecutionOptions, TargetPreview, TargetSelection } from './BatchTargets';
import { OperationSchedulesPage } from './OperationSchedules';

interface CommandTemplate {
  id: string;
  name: string;
  description: string;
  command: string;
  timeout: number;
  currentVersion: number;
  parameters?: OperationParameter[];
  enabled?: boolean;
}

interface PlanVersion {
  id: string;
  version: number;
  createdAt: number;
  parameters?: OperationParameter[];
  steps: OperationStep[];
  preChecks?: OperationStep[];
  postChecks?: OperationStep[];
  osRequirements?: string;
}

type TemplateVersion = Pick<
  CommandTemplate,
  'id' | 'name' | 'description' | 'command' | 'timeout' | 'parameters'
> & {
  version: number;
  createdAt: number;
};

const planSteps = [
  { key: 'preChecks', label: '前置检查', limit: 15 },
  { key: 'steps', label: '执行步骤', limit: 50 },
  { key: 'postChecks', label: '执行后验证', limit: 15 },
] as const;

function hasTargets(selection: TargetSelection) {
  return Object.values(selection).some((entries: string[]) => entries.length > 0);
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
  return (
    <>
      <PageHeader
        title="运维中心"
        description="选择服务器和执行范围，预览命令或方案，并在任务中心查看逐台执行结果。"
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
            className={key === tab ? 'active' : ''}
            aria-current={key === tab ? 'page' : undefined}
          >
            {operationsTabs[key]}
          </a>
        ))}
      </nav>
      {tab === 'commands' ? (
        <CommandsPage user={user} />
      ) : tab === 'schedules' ? (
        <OperationSchedulesPage user={user} />
      ) : (
        <ReusableOperations key={tab} mode={tab} user={user} />
      )}
    </>
  );
}

function CommandsPage({ user }: { user: User }) {
  const { selection, setSelection, projectId, environmentProjects } = useBatchSelection();
  const [command, setCommand] = useState('');
  const [name, setName] = useState('');
  const [timeout, setTimeoutValue] = useState(300);
  const [options, setOptions] = useState(defaultExecutionOptions);
  const [preview, setPreview] = useState<TargetPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEdit = user.role !== 'VIEWER';
  const plans = useResource<Plan[]>(canEdit ? '/operation-plans' : null);
  const availablePlans = (plans.data ?? []).filter((plan) => plan.enabled !== false);
  const [reference, setReference] = useInlineEditor<Plan>();

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || busy || preview) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await post<TargetPreview>('/commands/preview', selection));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!preview || !canEdit || busy) return;
    setBusy(true);
    setError('');
    try {
      const task = await post<Task>('/commands/execute', {
        ...selection,
        ...options,
        maxParallel: options.strategy === 'SEQUENTIAL' ? 1 : options.maxParallel,
        name: name.trim() || '临时命令',
        command,
        timeout,
        expectedTargetHash: preview.targetHash,
        confirmed: true,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      if (err instanceof ApiError && [400, 409].includes(err.status)) setPreview(undefined);
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ErrorBanner error={plans.error} retry={plans.reload} />
      <div hidden={Boolean(reference)}>
        <form className="command-layout" onSubmit={prepare}>
          <div>
            <Section title="执行目标" subtitle="可组合多种条件，预览会合并重复的服务器。">
              <BatchTargetPicker
                selection={selection}
                onChange={setSelection}
                disabled={!canEdit || busy}
              />
            </Section>
            <Section title="执行策略">
              <div className="form-body">
                <BatchStrategy
                  projectId={projectId}
                  options={options}
                  onChange={setOptions}
                  disabled={!canEdit || busy}
                />
                <Field label="单目标超时（秒）">
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    value={timeout}
                    required
                    disabled={!canEdit || busy}
                    onChange={(event) => setTimeoutValue(Number(event.target.value))}
                  />
                </Field>
              </div>
            </Section>
          </div>
          <Section
            title="临时命令"
            subtitle="以服务器配置的 SSH 用户身份执行"
            action={
              canEdit && (
                <select
                  className="button secondary"
                  aria-label="引用运维方案"
                  value=""
                  disabled={busy || !availablePlans.length}
                  onChange={(event) =>
                    setReference(availablePlans.find((plan) => plan.id === event.target.value))
                  }
                >
                  <option value="">
                    {plans.loading || availablePlans.length ? '引用运维方案…' : '暂无可引用的方案'}
                  </option>
                  {availablePlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
                </select>
              )
            }
          >
            <div className="command-editor">
              <textarea
                aria-label="Shell 命令"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={!canEdit || busy}
                maxLength={65536}
                spellCheck={false}
                required
                placeholder="uname -a && uptime"
              />
            </div>
            <div className="command-options">
              <Field label="任务名称（可选）">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={100}
                  disabled={!canEdit || busy}
                />
              </Field>
              <ErrorBanner error={preview ? '' : error} />
              <div className="row-actions">
                <button
                  className="button primary"
                  disabled={!canEdit || busy || !hasTargets(selection) || !command.trim()}
                >
                  <Play size={16} />
                  预览并执行
                </button>
              </div>
            </div>
          </Section>
        </form>
      </div>
      {reference && (
        <OperationRun
          user={user}
          endpoint="/operation-plans"
          entry={reference}
          canRun={canEdit}
          initialSelection={selection}
          initialEnvironmentProjects={environmentProjects}
          initialOptions={options}
          onClose={() => setReference(undefined)}
        />
      )}
      {preview && (
        <Confirm
          title="确认执行远程命令"
          description={`将在 ${preview.count} 台服务器上执行以下命令。`}
          detail={
            <>
              <ResolvedTargets preview={preview} />
              <pre className="code-preview">{command}</pre>
            </>
          }
          label="确认执行"
          busy={busy}
          error={error}
          onClose={() => {
            if (!busy) {
              setPreview(undefined);
              setError('');
            }
          }}
          onConfirm={execute}
        />
      )}
    </>
  );
}

function ReusableOperations({ mode, user }: { mode: 'plans' | 'templates'; user: User }) {
  const isPlan = mode === 'plans';
  const label = isPlan ? '运维方案' : '命令模板';
  const endpoint = isPlan ? '/operation-plans' : '/command-templates';
  const resource = useResource<(Plan | CommandTemplate)[]>(endpoint);
  const [editing, setEditing] = useInlineEditor<Plan | CommandTemplate | 'new'>();
  const [viewing, setViewing] = useInlineEditor<Plan | CommandTemplate>();
  const [deleting, setDeleting] = useState<Plan | CommandTemplate>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEdit = user.role !== 'VIEWER';

  async function archive() {
    if (!deleting) return;
    setBusy(true);
    setError('');
    try {
      await remove(`${endpoint}/${deleting.id}`);
      setDeleting(undefined);
      await resource.reload();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ErrorBanner error={resource.error} retry={resource.reload} />
      <div hidden={Boolean(editing || viewing)}>
        <Section
          title={label}
          action={
            canEdit && (
              <button className="button secondary" onClick={() => setEditing('new')}>
                <Plus size={16} />
                创建{label}
              </button>
            )
          }
        >
          {resource.loading ? (
            <Loading />
          ) : !resource.data?.length ? (
            <Empty
              title={`暂无${label}`}
              description={canEdit ? `创建${label}后即可保存版本并批量执行。` : ''}
            />
          ) : (
            <div className="resource-list">
              {resource.data.map((entry) => (
                <div key={entry.id}>
                  <span className="resource-avatar">
                    {isPlan ? <FileCode2 size={18} /> : <Terminal size={18} />}
                  </span>
                  <div>
                    <strong>{entry.name}</strong>
                    <small>{entry.description}</small>
                  </div>
                  <span className="tag">v{entry.currentVersion}</span>
                  <span className="row-actions">
                    <button className="button compact" onClick={() => setViewing(entry)}>
                      {canEdit && entry.enabled !== false ? '查看并运行' : '查看版本'}
                    </button>
                    {canEdit && (
                      <>
                        <button
                          className="icon-button bare muted"
                          aria-label={`编辑${entry.name}`}
                          onClick={() => setEditing(entry)}
                        >
                          <Pencil size={15} />
                        </button>
                        {entry.enabled !== false && (
                          <button
                            className="icon-button bare muted"
                            aria-label={`归档${entry.name}`}
                            onClick={() => {
                              setError('');
                              setDeleting(entry);
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
      {editing && (
        <DefinitionEditor
          endpoint={endpoint}
          label={label}
          isPlan={isPlan}
          entry={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSave={() => {
            setEditing(undefined);
            void resource.reload();
          }}
        />
      )}
      {viewing && (
        <OperationRun
          user={user}
          endpoint={endpoint}
          entry={viewing}
          canRun={canEdit && viewing.enabled !== false}
          onClose={() => setViewing(undefined)}
        />
      )}
      {deleting && (
        <Confirm
          title={`归档${label}`}
          description={`归档「${deleting.name}」，保留历史版本和任务记录。`}
          onClose={() => !busy && setDeleting(undefined)}
          onConfirm={archive}
          busy={busy}
          error={error}
          destructive
          label="归档"
        />
      )}
    </>
  );
}

function OperationRun({
  user,
  endpoint,
  entry,
  canRun,
  initialSelection = {},
  initialEnvironmentProjects,
  initialOptions = defaultExecutionOptions,
  onClose,
}: {
  endpoint: string;
  entry: Plan | CommandTemplate;
  canRun: boolean;
  user: User;
  initialSelection?: TargetSelection;
  initialEnvironmentProjects?: Record<string, string>;
  initialOptions?: ExecutionOptions;
  onClose: () => void;
}) {
  const base = `${endpoint}/${entry.id}`;
  const history = useResource<(PlanVersion | TemplateVersion)[]>(`${base}/versions`);
  const [versionNumber, setVersionNumber] = useState(entry.currentVersion);
  const { selection, setSelection, projectId } = useBatchSelection(
    initialSelection,
    initialEnvironmentProjects,
  );
  const [options, setOptions] = useState(initialOptions);
  const [review, setReview] = useState<{
    preview: TargetPreview;
    parameters: Record<string, ParameterValue>;
    version: number;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const version = history.data?.find((item) => item.version === versionNumber);
  const definitions = version?.parameters ?? [];

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canRun || !version || busy || review) return;
    const parameters = operationParameters(new FormData(event.currentTarget), definitions);
    setBusy(true);
    setError('');
    try {
      const preview = await post<TargetPreview>('/commands/preview', selection);
      setReview({ preview, parameters, version: version.version });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!review || !canRun || busy) return;
    setBusy(true);
    setError('');
    try {
      const task = await post<Task>(`${base}/run`, {
        ...selection,
        ...options,
        maxParallel: options.strategy === 'SEQUENTIAL' ? 1 : options.maxParallel,
        parameters: review.parameters,
        version: review.version,
        expectedTargetHash: review.preview.targetHash,
        confirmed: true,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      if (err instanceof ApiError && [400, 409].includes(err.status)) setReview(undefined);
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <InlineEditor title={entry.name} wide busy={busy} onClose={onClose}>
      <form onSubmit={prepare}>
        <div className="form-body">
          <ErrorBanner
            error={history.error || error}
            retry={history.error ? history.reload : undefined}
          />
          {history.loading && <Loading />}
          {!!history.data?.length && (
            <Field label="执行版本">
              <select
                value={versionNumber}
                disabled={busy || Boolean(review)}
                onChange={(event) => setVersionNumber(Number(event.target.value))}
              >
                {history.data.map((item) => (
                  <option key={item.id} value={item.version}>
                    v{item.version}
                    {item.version === entry.currentVersion ? '（当前）' : ''} ·{' '}
                    {formatTime(item.createdAt)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {version && <VersionDefinition version={version} />}
          {version && endpoint === '/operation-plans' && (
            <ContextAIButton
              user={user}
              objectName={entry.name}
              context={{
                kind: 'OPERATION_PLAN',
                operationPlanId: entry.id,
                version: versionNumber,
              }}
              label={`AI 运维方案 · v${versionNumber}`}
            />
          )}
          {canRun && version && (
            <>
              <div key={versionNumber} hidden={Boolean(review)}>
                {definitions.length > 0 && (
                  <div className="form-grid">
                    {definitions.map((parameter) => (
                      <ParameterField key={parameter.name} parameter={parameter} />
                    ))}
                  </div>
                )}
                <h3 className="field-title">执行目标</h3>
                <BatchTargetPicker
                  selection={selection}
                  onChange={setSelection}
                  disabled={busy || Boolean(review)}
                />
                <h3 className="field-title">执行策略</h3>
                <BatchStrategy
                  projectId={projectId}
                  options={options}
                  onChange={setOptions}
                  disabled={busy || Boolean(review)}
                />
              </div>
              {review && (
                <>
                  <h3 className="field-title">已解析 {review.preview.count} 台服务器</h3>
                  <ResolvedTargets preview={review.preview} />
                  {definitions.map(({ name, defaultValue }) => (
                    <p className="field-note" key={name}>
                      {name} · {String(review.parameters[name] ?? defaultValue ?? '未指定')}
                    </p>
                  ))}
                </>
              )}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => (review ? setReview(undefined) : onClose())}
          >
            {review ? '返回选择' : '关闭'}
          </button>
          {canRun &&
            version &&
            (review ? (
              <button type="button" className="button primary" disabled={busy} onClick={run}>
                确认执行 · {review.preview.count} 台
              </button>
            ) : (
              <button
                type="submit"
                className="button primary"
                disabled={busy || !hasTargets(selection)}
              >
                预览执行目标
              </button>
            ))}
        </div>
      </form>
    </InlineEditor>
  );
}

function VersionDefinition({ version }: { version: PlanVersion | TemplateVersion }) {
  if ('command' in version)
    return (
      <>
        <p className="field-note">
          {version.name} · 超时 {version.timeout} 秒
        </p>
        <pre className="code-preview">{version.command}</pre>
      </>
    );
  const steps = planSteps.map(
    ({ key, label }) =>
      !!version[key]?.length && (
        <div className="plan-steps" key={key}>
          <h3 className="field-title">{label}</h3>
          {version[key].map((step, index) => (
            <div key={index}>
              <strong>
                {index + 1}. {step.name}
              </strong>
              <pre className="code-preview">{step.command}</pre>
            </div>
          ))}
        </div>
      ),
  );
  return (
    <>
      {version.osRequirements && <p className="field-note">适用系统 · {version.osRequirements}</p>}
      {steps}
    </>
  );
}

function DefinitionEditor({
  endpoint,
  label,
  isPlan,
  entry,
  onClose,
  onSave,
}: {
  endpoint: string;
  label: string;
  isPlan: boolean;
  entry?: Plan | CommandTemplate;
  onClose: () => void;
  onSave: () => void;
}) {
  const plan = entry && 'steps' in entry ? entry : undefined;
  const template = entry && 'command' in entry ? entry : undefined;
  const [parameters, setParameters] = useState(entry?.parameters ?? []);
  const [steps, setSteps] = useState({
    steps: plan?.steps ?? [{ name: '', command: '' }],
    preChecks: plan?.preChecks ?? [],
    postChecks: plan?.postChecks ?? [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      name: String(data.get('name')).trim(),
      description: String(data.get('description')).trim(),
      parameters,
      ...(isPlan
        ? {
            ...steps,
            category: String(data.get('category')).trim(),
            osRequirements: String(data.get('osRequirements')).trim(),
          }
        : {
            command: String(data.get('command')),
            timeout: Number(data.get('timeout')),
          }),
    };
    setBusy(true);
    setError('');
    try {
      if (entry)
        await api(`${endpoint}/${entry.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await post(endpoint, body);
      onSave();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor title={`${entry ? '编辑' : '创建'}${label}`} wide busy={busy} onClose={onClose}>
      <Form
        onSubmit={save}
        busy={busy}
        error={error}
        onCancel={onClose}
        submit={entry ? '保存为新版本' : '创建'}
      >
        <Field label="名称" required>
          <input name="name" maxLength={120} defaultValue={entry?.name} required autoFocus />
        </Field>
        <Field label="说明">
          <textarea
            name="description"
            maxLength={2000}
            defaultValue={entry?.description}
            rows={2}
          />
        </Field>
        {isPlan ? (
          <div className="form-grid">
            <Field label="分类">
              <input name="category" maxLength={100} defaultValue={plan?.category ?? 'CUSTOM'} />
            </Field>
            <Field label="适用系统">
              <input name="osRequirements" maxLength={200} defaultValue={plan?.osRequirements} />
            </Field>
          </div>
        ) : (
          <>
            <Field label="Shell 命令" required>
              <textarea
                name="command"
                className="mono"
                maxLength={65536}
                defaultValue={template?.command}
                rows={5}
                spellCheck={false}
                required
              />
            </Field>
            <Field label="单目标超时（秒）" required>
              <input
                name="timeout"
                type="number"
                min={1}
                max={3600}
                defaultValue={template?.timeout ?? 300}
                required
              />
            </Field>
          </>
        )}
        <ParameterEditor items={parameters} onChange={setParameters} />
        {isPlan &&
          planSteps.map(({ key, label: stepLabel, limit }) => (
            <StepEditor
              key={key}
              label={stepLabel}
              limit={limit}
              items={steps[key]}
              main={key === 'steps'}
              onChange={(items) => setSteps({ ...steps, [key]: items })}
            />
          ))}
      </Form>
    </InlineEditor>
  );
}

function EditorGroup({
  label,
  add,
  disabled,
  children,
}: {
  label: string;
  add: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <div className="batch-editor-group">
      <div className="batch-editor-heading">
        <h3 className="field-title">{label}</h3>
        <button className="button secondary small" type="button" onClick={add} disabled={disabled}>
          <Plus size={14} />
          添加
        </button>
      </div>
      {children}
    </div>
  );
}

function StepEditor({
  label,
  limit,
  items,
  main,
  onChange,
}: {
  label: string;
  limit: number;
  items: OperationStep[];
  main: boolean;
  onChange: (items: OperationStep[]) => void;
}) {
  function update(index: number, step: OperationStep) {
    onChange(items.map((item, position) => (position === index ? step : item)));
  }
  function move(index: number, offset: number) {
    const ordered = [...items];
    [ordered[index], ordered[index + offset]] = [ordered[index + offset], ordered[index]];
    onChange(ordered);
  }
  return (
    <EditorGroup
      label={label}
      add={() => onChange([...items, { name: '', command: '' }])}
      disabled={items.length >= limit}
    >
      {items.map((step, index) => (
        <fieldset className="batch-editor-item" key={index}>
          <legend>
            {label} {index + 1}
          </legend>
          <Field label="名称" required>
            <input
              value={step.name}
              maxLength={120}
              required
              onChange={(event) => update(index, { ...step, name: event.target.value })}
            />
          </Field>
          <Field label="Shell 命令" required>
            <textarea
              className="mono"
              rows={3}
              value={step.command}
              maxLength={65536}
              required
              spellCheck={false}
              onChange={(event) => update(index, { ...step, command: event.target.value })}
            />
          </Field>
          <div className="form-grid">
            <Field label="超时（秒）">
              <input
                type="number"
                min={1}
                max={3600}
                value={step.timeout ?? ''}
                onChange={(event) =>
                  update(index, {
                    ...step,
                    timeout: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
              />
            </Field>
            {main && (
              <Field label="此步骤失败后">
                <select
                  value={step.failurePolicy ?? 'STOP'}
                  onChange={(event) =>
                    update(index, {
                      ...step,
                      failurePolicy: event.target.value as OperationStep['failurePolicy'],
                    })
                  }
                >
                  <option value="STOP">停止此服务器的后续步骤</option>
                  <option value="CONTINUE">继续后续步骤</option>
                </select>
              </Field>
            )}
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="button compact"
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              上移
            </button>
            <button
              type="button"
              className="button compact"
              disabled={index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              下移
            </button>
            <button
              type="button"
              className="text-button danger-text"
              disabled={main && items.length === 1}
              onClick={() => onChange(items.filter((_, position) => position !== index))}
            >
              移除
            </button>
          </div>
        </fieldset>
      ))}
    </EditorGroup>
  );
}

function ParameterEditor({
  items,
  onChange,
}: {
  items: OperationParameter[];
  onChange: (items: OperationParameter[]) => void;
}) {
  function update(index: number, parameter: OperationParameter) {
    onChange(items.map((item, position) => (position === index ? parameter : item)));
  }
  return (
    <EditorGroup
      label="参数"
      add={() => onChange([...items, { name: '', type: 'STRING' }])}
      disabled={items.length >= 32}
    >
      {items.length > 0 && (
        <p className="field-note">
          在 Shell 中通过 <code>"$VEYOPS_PARAM_NAME"</code> 引用名为 <code>NAME</code> 的参数。
        </p>
      )}
      {items.map((parameter, index) => (
        <fieldset className="batch-editor-item" key={index}>
          <legend>参数 {index + 1}</legend>
          <div className="form-grid">
            <Field label="参数名" required>
              <input
                value={parameter.name}
                pattern="[A-Z][A-Z0-9_]{0,63}"
                placeholder="NODE_VERSION"
                required
                onChange={(event) => update(index, { ...parameter, name: event.target.value })}
              />
            </Field>
            <Field label="参数类型">
              <select
                value={parameter.type}
                onChange={(event) =>
                  update(index, {
                    ...parameter,
                    type: event.target.value as OperationParameter['type'],
                    defaultValue: undefined,
                  })
                }
              >
                <option value="STRING">文本</option>
                <option value="NUMBER">数字</option>
                <option value="BOOLEAN">是或否</option>
              </select>
            </Field>
          </div>
          <div className="form-grid">
            <Field label="默认值">
              {parameter.type === 'BOOLEAN' ? (
                <select
                  value={parameter.defaultValue === undefined ? '' : String(parameter.defaultValue)}
                  onChange={(event) =>
                    update(index, {
                      ...parameter,
                      defaultValue:
                        event.target.value === '' ? undefined : event.target.value === 'true',
                    })
                  }
                >
                  <option value="">无</option>
                  <option value="true">是</option>
                  <option value="false">否</option>
                </select>
              ) : (
                <input
                  type={parameter.type === 'NUMBER' ? 'number' : 'text'}
                  step={parameter.type === 'NUMBER' ? 'any' : undefined}
                  value={parameter.defaultValue === undefined ? '' : String(parameter.defaultValue)}
                  onChange={(event) => {
                    const value = event.target.value;
                    update(index, {
                      ...parameter,
                      defaultValue:
                        value === ''
                          ? undefined
                          : parameter.type === 'NUMBER'
                            ? Number(value)
                            : value,
                    });
                  }}
                />
              )}
            </Field>
            <Field label="参数说明">
              <input
                value={parameter.description ?? ''}
                maxLength={300}
                onChange={(event) =>
                  update(index, { ...parameter, description: event.target.value })
                }
              />
            </Field>
          </div>
          <div className="row-actions">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={parameter.required ?? false}
                onChange={(event) =>
                  update(index, { ...parameter, required: event.target.checked })
                }
              />
              必填
            </label>
            <button
              type="button"
              className="text-button danger-text"
              onClick={() => onChange(items.filter((_, position) => position !== index))}
            >
              移除
            </button>
          </div>
        </fieldset>
      ))}
    </EditorGroup>
  );
}
