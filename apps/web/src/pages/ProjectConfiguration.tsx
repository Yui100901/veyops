import { useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { api, message, navigate, remove } from '../api';
import { Confirm, ErrorBanner, Field, Section } from '../components';
import type { Project, ProjectDetail, User } from '../models';
import { ProjectAISettings } from './AI';
import { EnvironmentVariables } from './EnvironmentVariables';
import { ProjectExecutionSettingsPanel } from './ProjectExecutionSettings';

export function projectBasicsValues(form: FormData) {
  const read = (key: string) => String(form.get(key) ?? '').trim();
  return {
    name: read('name'),
    slug: read('slug'),
    description: read('description'),
    tags: read('tags')
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean),
  };
}

export function ProjectBasicsFields({
  project,
  autoFocus,
}: {
  project?: Project;
  autoFocus?: boolean;
}) {
  return (
    <div className="form-grid">
      <Field label="项目名称" required>
        <input
          name="name"
          required
          autoFocus={autoFocus}
          maxLength={100}
          defaultValue={project?.name}
        />
      </Field>
      <Field label="唯一标识" required hint="使用小写字母、数字和连字符。">
        <input
          name="slug"
          required
          maxLength={63}
          pattern={'[a-z0-9][a-z0-9\\-]{0,62}'}
          defaultValue={project?.slug}
          placeholder="core-platform"
        />
      </Field>
      <Field label="项目描述">
        <textarea
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={project?.description}
        />
      </Field>
      <Field label="标签">
        <input
          name="tags"
          defaultValue={project?.tags.join(', ')}
          placeholder="多个标签使用逗号分隔"
        />
      </Field>
    </div>
  );
}

export function ProjectConfiguration({
  project,
  user,
  onSaved,
  backPath = '/projects',
}: {
  project: ProjectDetail;
  user: User;
  onSaved: () => void | Promise<unknown>;
  backPath?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletionError, setDeletionError] = useState('');
  const { id, name, slug, description, tags } = project;
  const path = `/projects/${encodeURIComponent(id)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || user.role === 'VIEWER') return;
    const payload = projectBasicsValues(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api(path, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProject() {
    if (busy || user.role === 'VIEWER') return;
    setBusy(true);
    setDeletionError('');
    try {
      await remove(path);
      navigate(backPath);
    } catch (err) {
      setDeletionError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-configuration">
      <Section
        title="项目基本信息"
        action={
          user.role !== 'VIEWER' && (
            <button
              className="button secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setDeletionError('');
                setDeleting(true);
              }}
            >
              <Trash2 size={16} aria-hidden="true" /> 删除项目
            </button>
          )
        }
      >
        {user.role === 'VIEWER' ? (
          <div className="section-body">
            {[
              ['项目名称', name],
              ['唯一标识', slug],
              ['项目描述', description],
              ['标签', tags.join('、')],
            ].map(([label, value]) => (
              <div className="setting-row" key={label}>
                <span>{label}</span>
                <strong>{value || '—'}</strong>
              </div>
            ))}
          </div>
        ) : (
          <form
            className="form-body"
            key={JSON.stringify([id, name, slug, description, tags])}
            onSubmit={submit}
            onChange={() => setSaved(false)}
            onReset={() => {
              setSaved(false);
              setError('');
            }}
          >
            <fieldset disabled={busy}>
              <ProjectBasicsFields project={project} />
            </fieldset>
            <ErrorBanner error={error} />
            <div className="heading-actions">
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? '保存中…' : '保存基本信息'}
              </button>
              <button type="reset" className="button secondary" disabled={busy}>
                放弃修改
              </button>
              {saved && <span role="status">基本信息已保存</span>}
            </div>
          </form>
        )}
      </Section>
      <ProjectExecutionSettingsPanel projectId={id} user={user} />
      <Section title="项目公共变量" subtitle="项目各环境自动继承公共变量，并可用同名变量覆盖。">
        <div className="section-body">
          <p className="field-note">
            执行图可使用 <code>VEYOPS_PROJECT_SLUG</code> 和 <code>VEYOPS_PROJECT_ID</code>。
            关联服务的执行流还可使用 <code>VEYOPS_SERVICE_SLUG</code> 和{' '}
            <code>VEYOPS_SERVICE_ID</code>。
          </p>
          <EnvironmentVariables projectId={id} user={user} />
        </div>
      </Section>
      <ProjectAISettings user={user} projectId={id} repositories={project.repositories} />
      {deleting && (
        <Confirm
          title="删除项目"
          description={`将「${name}」从项目列表移除，保留已有任务和部署记录。`}
          onClose={() => !busy && setDeleting(false)}
          onConfirm={deleteProject}
          busy={busy}
          error={deletionError}
          destructive
          label="确认删除项目"
        />
      )}
    </div>
  );
}
