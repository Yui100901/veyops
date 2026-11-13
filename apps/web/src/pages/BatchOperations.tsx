import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { FileCode2, Pencil, Play, Plus, Terminal, Trash2 } from 'lucide-react';
import { api, formatTime, message, navigate, post, remove, useResource } from '../api';
import {
  Confirm,
  Empty,
  ErrorBanner,
  Field,
  Form,
  Loading,
  Modal,
  PageHeader,
  Section,
} from '../components';
import type {
  OperationParameter,
  OperationStep,
  ParameterValue,
  Plan,
  Task,
  User,
} from '../models';
import {
  BatchStrategy,
  BatchTargetPicker,
  defaultExecutionOptions,
  ResolvedTargets,
} from './BatchTargets';
import type { TargetPreview, TargetSelection } from './BatchTargets';

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

export function CommandsPage({ user }: { user: User }) {
  const [selection, setSelection] = useState<TargetSelection>({});
  const [command, setCommand] = useState('');
  const [name, setName] = useState('');
  const [timeout, setTimeoutValue] = useState(300);
  const [options, setOptions] = useState(defaultExecutionOptions);
  const [preview, setPreview] = useState<TargetPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canEdit = user.role !== 'VIEWER';

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
    if (!preview) return;
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
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="COMMAND CENTER"
        title="命令中心"
        description="选择服务器或资源范围，查看每台服务器的执行结果和日志。"
        action={
          <a href="#/plans" className="button secondary">
            <FileCode2 size={16} />
            运维方案
          </a>
        }
      />
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
              <BatchStrategy options={options} onChange={setOptions} disabled={!canEdit || busy} />
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
        <Section title="临时命令" subtitle="以服务器配置的 SSH 用户身份执行">
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
      <ReusableOperations mode="templates" user={user} />
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

export function PlansPage({ user }: { user: User }) {
  return (
    <>
      <PageHeader
        eyebrow="REUSABLE OPERATIONS"
        title="运维方案"
        description="保存可复用的多步骤方案，并按固定版本执行。"
        action={
          <a href="#/commands" className="button secondary">
            <Terminal size={16} />
            命令中心
          </a>
        }
      />
      <ReusableOperations mode="plans" user={user} />
    </>
  );
}

function ReusableOperations({ mode, user }: { mode: 'plans' | 'templates'; user: User }) {
  const isPlan = mode === 'plans';
  const label = isPlan ? '运维方案' : '命令模板';
  const endpoint = isPlan ? '/operation-plans' : '/command-templates';
  const resource = useResource<(Plan | CommandTemplate)[]>(endpoint);
  const [editing, setEditing] = useState<Plan | CommandTemplate | 'new'>();
  const [viewing, setViewing] = useState<Plan | CommandTemplate>();
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
  endpoint,
  entry,
  canRun,
  onClose,
}: {
  endpoint: string;
  entry: Plan | CommandTemplate;
  canRun: boolean;
  onClose: () => void;
}) {
  const base = `${endpoint}/${entry.id}`;
  const history = useResource<(PlanVersion | TemplateVersion)[]>(`${base}/versions`);
  const [versionNumber, setVersionNumber] = useState(entry.currentVersion);
  const [selection, setSelection] = useState<TargetSelection>({});
  const [options, setOptions] = useState(defaultExecutionOptions);
  const [review, setReview] = useState<{
    preview: TargetPreview;
    parameters: Record<string, ParameterValue>;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const version = history.data?.find((item) => item.version === versionNumber);
  const definitions = version?.parameters ?? [];

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!version) return;
    const parameters = operationParameters(new FormData(event.currentTarget), definitions);
    setBusy(true);
    setError('');
    try {
      const preview = await post<TargetPreview>('/commands/preview', selection);
      setReview({ preview, parameters });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!review) return;
    setBusy(true);
    setError('');
    try {
      const task = await post<Task>(`${base}/run`, {
        ...selection,
        ...options,
        maxParallel: options.strategy === 'SEQUENTIAL' ? 1 : options.maxParallel,
        parameters: review.parameters,
        version: versionNumber,
        expectedTargetHash: review.preview.targetHash,
        confirmed: true,
      });
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={entry.name} wide onClose={() => !busy && onClose()}>
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
    </Modal>
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
    <Modal title={`${entry ? '编辑' : '创建'}${label}`} wide onClose={() => !busy && onClose()}>
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
    </Modal>
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
