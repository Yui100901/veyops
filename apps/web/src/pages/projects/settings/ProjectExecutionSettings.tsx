import { useState, type FormEvent } from 'react';
import { api, message, useResource } from '../../../api';
import { ErrorBanner, Field, Loading, Section } from '../../../components';
import type {
  ProjectExecutionOverrides,
  ProjectExecutionSettings,
  SystemRuntimeDefaults,
  User,
} from '../../../models';

const labels = {
  defaultBuildLocation: '默认构建位置',
  defaultMaxParallelTargets: '默认目标并发数',
  targetWorkspaceRoot: '目标端工作目录',
  logRetentionDays: '任务日志保留天数',
};
const keys = Object.keys(labels) as (keyof SystemRuntimeDefaults)[];
function settingValue(key: keyof SystemRuntimeDefaults, value: string | number) {
  if (key === 'defaultBuildLocation') return value === 'TARGET' ? '目标服务器' : '管理端隔离环境';
  if (key === 'logRetentionDays') return value === 0 ? '一直保留' : value + ' 天';
  if (key === 'defaultMaxParallelTargets') return value + ' 台';
  return String(value);
}

export function ExecutionSettingsFields({
  values,
  system,
}: {
  values: ProjectExecutionOverrides;
  system?: SystemRuntimeDefaults;
}) {
  const placeholder = (key: keyof SystemRuntimeDefaults) =>
    system ? '继承系统 · ' + settingValue(key, system[key]) : undefined;
  return (
    <div className="form-grid">
      <Field label={labels.defaultBuildLocation} hint="执行流未指定构建位置时使用。">
        <select
          name="defaultBuildLocation"
          defaultValue={values.defaultBuildLocation ?? ''}
          required={!system}
        >
          {system && <option value="">{placeholder('defaultBuildLocation')}</option>}
          <option value="TARGET">目标服务器</option>
          <option value="MANAGER">管理端隔离环境</option>
        </select>
      </Field>
      <Field
        label={labels.defaultMaxParallelTargets}
        hint="未显式指定并发数时，同时执行的目标服务器数量，范围 1–10 台。"
      >
        <input
          type="number"
          name="defaultMaxParallelTargets"
          min={1}
          max={10}
          required={!system}
          defaultValue={values.defaultMaxParallelTargets ?? ''}
          placeholder={placeholder('defaultMaxParallelTargets')}
        />
      </Field>
      <Field
        label={labels.targetWorkspaceRoot}
        hint="在目标服务器上构建时，将在此目录下创建任务工作区。使用绝对路径或以 ~/ 开头的子目录。"
      >
        <input
          name="targetWorkspaceRoot"
          maxLength={512}
          required={!system}
          defaultValue={values.targetWorkspaceRoot ?? ''}
          placeholder={placeholder('targetWorkspaceRoot')}
        />
      </Field>
      <Field
        label={labels.logRetentionDays}
        hint="已结束任务的日志按此天数清理。填 0 表示一直保留，产物由保留策略管理。"
      >
        <input
          type="number"
          name="logRetentionDays"
          min={0}
          max={3650}
          required={!system}
          defaultValue={values.logRetentionDays ?? ''}
          placeholder={placeholder('logRetentionDays')}
        />
      </Field>
    </div>
  );
}

export function executionChanges(form: FormData, initial: ProjectExecutionOverrides) {
  const changed: Record<string, string | number | null> = {};
  for (const key of keys) {
    const field = String(form.get(key) ?? '').trim();
    const value = !field
      ? null
      : key === 'defaultMaxParallelTargets' || key === 'logRetentionDays'
        ? Number(field)
        : field;
    if (value !== (initial[key] ?? null)) changed[key] = value;
  }
  return changed;
}

export function ProjectExecutionSettingsPanel({
  projectId,
  user,
}: {
  projectId: string;
  user: User;
}) {
  const path = '/projects/' + encodeURIComponent(projectId) + '/execution-settings';
  const resource = useResource<ProjectExecutionSettings>(path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const settings = resource.data;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || busy) return;
    const changed = executionChanges(new FormData(event.currentTarget), settings.overrides);
    setBusy(true);
    setError('');
    try {
      if (Object.keys(changed).length)
        await api(path, { method: 'PATCH', body: JSON.stringify(changed) });
      await resource.reload();
      setSaved(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="项目执行设置"
      subtitle={
        user.role === 'ADMIN'
          ? '留空或选择继承，将使用系统当前的设置。'
          : '可以查看当前生效值，管理员可修改项目设置。'
      }
    >
      <ErrorBanner error={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : (
        settings &&
        (user.role === 'ADMIN' ? (
          <form
            onSubmit={submit}
            onChange={() => setSaved(false)}
            className="form-body"
            key={JSON.stringify(settings.overrides)}
          >
            <ExecutionSettingsFields values={settings.overrides} system={settings.system} />
            <ErrorBanner error={error} />
            <div className="heading-actions">
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? '保存中…' : '保存项目设置'}
              </button>
              <button
                type="reset"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  setSaved(false);
                  setError('');
                }}
              >
                放弃修改
              </button>
              {saved && <span role="status">设置已保存</span>}
            </div>
          </form>
        ) : (
          keys.map((key) => (
            <div key={key} className="setting-row">
              <span>{labels[key]}</span>
              <strong>{settingValue(key, settings.effective[key])}</strong>
              <span className="tag">
                {settings.overrides[key] == null ? '继承系统' : '项目设置'}
              </span>
            </div>
          ))
        ))
      )}
    </Section>
  );
}
