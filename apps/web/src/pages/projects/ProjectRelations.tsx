import { InlineEditor, useInlineEditor } from '../../InlineEditor';
import { useState, type FormEvent } from 'react';
import { Network, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, message, post, remove, useResource } from '../../api';
import { Confirm, ErrorBanner, Field, Form, Section } from '../../components';
import type { Project, ProjectDependency, ProjectDetail, User } from '../../models';

export function ProjectRelations({
  project,
  user,
  reload,
}: {
  project: ProjectDetail;
  user: User;
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useInlineEditor<ProjectDependency | 'new'>();
  const [deleting, setDeleting] = useState<ProjectDependency>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = user.role !== 'VIEWER' && !project.archived;

  async function deleteDependency() {
    if (!deleting) return;
    setError('');
    setBusy(true);
    try {
      await remove(`/projects/${project.id}/dependencies/${deleting.id}`);
      setDeleting(undefined);
      await reload();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {editing && (
        <DependencyEditor
          key={editing === 'new' ? 'new' : editing.id}
          project={project}
          dependency={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void reload();
          }}
        />
      )}
      <Section
        title="项目依赖"
        action={
          canEdit && (
            <button
              className="button secondary small"
              type="button"
              onClick={() => setEditing('new')}
            >
              <Plus size={15} /> 添加依赖
            </button>
          )
        }
      >
        {project.dependencies?.length ? (
          <div className="resource-list">
            {project.dependencies.map((item) => (
              <div key={item.id}>
                <span className="resource-avatar">
                  <Network size={17} />
                </span>
                <div>
                  <a href={`#/projects/${item.dependsOnProjectId}`} className="text-link">
                    {item.projectName}
                  </a>
                  {item.description && <small>{item.description}</small>}
                </div>
                <span className="tag">
                  {item.dependencyType === 'DEPLOYMENT' ? '部署依赖' : '运行依赖'}
                </span>
                {canEdit && (
                  <span className="row-actions">
                    <button
                      type="button"
                      className="button secondary small"
                      aria-label={`编辑依赖 ${item.projectName}`}
                      onClick={() => setEditing(item)}
                    >
                      <Pencil size={15} /> 编辑
                    </button>
                    <button
                      type="button"
                      className="icon-button bare muted"
                      aria-label={`删除依赖 ${item.projectName}`}
                      onClick={() => {
                        setError('');
                        setDeleting(item);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="mini-empty">暂无项目依赖</p>
        )}
      </Section>
      <Section title="依赖此项目的项目">
        {project.dependents?.length ? (
          <div className="resource-list">
            {project.dependents.map((item) => (
              <div key={item.id}>
                <span className="resource-avatar">
                  <Network size={17} />
                </span>
                <div>
                  <a href={`#/projects/${item.projectId}`} className="text-link">
                    {item.projectName}
                  </a>
                  {item.description && <small>{item.description}</small>}
                </div>
                <span className="tag">
                  {item.dependencyType === 'DEPLOYMENT' ? '部署依赖' : '运行依赖'}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="mini-empty">暂无其他项目依赖此项目。</p>
        )}
      </Section>
      {deleting && (
        <Confirm
          title="删除项目依赖"
          description={`移除对「${deleting.projectName}」的依赖。`}
          onClose={() => !busy && setDeleting(undefined)}
          onConfirm={deleteDependency}
          busy={busy}
          error={error}
          destructive
          label="删除"
        />
      )}
    </>
  );
}

function DependencyEditor({
  project,
  dependency,
  onClose,
  onSaved,
}: {
  project: ProjectDetail;
  dependency?: ProjectDependency;
  onClose: () => void;
  onSaved: () => void;
}) {
  const projects = useResource<Project[]>('/projects');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body = {
      description: String(data.get('description')).trim(),
      dependsOnProjectId: data.get('dependsOnProjectId'),
      dependencyType: data.get('dependencyType'),
    };
    setError('');
    setBusy(true);
    try {
      const path = `/projects/${project.id}/dependencies`;
      if (dependency)
        await api(`${path}/${dependency.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      else await post(path, body);
      onSaved();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <InlineEditor
      busy={busy}
      title={dependency ? '编辑项目依赖' : '添加项目依赖'}
      onClose={onClose}
    >
      <Form onSubmit={save} error={error} busy={busy} onCancel={onClose}>
        <ErrorBanner error={projects.error} retry={projects.reload} />
        <Field label="依赖项目" required>
          <select
            name="dependsOnProjectId"
            defaultValue={dependency?.dependsOnProjectId ?? ''}
            required
          >
            <option value="">选择项目</option>
            {projects.data
              ?.filter(({ id }) => id !== project.id)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            {dependency &&
              !projects.data?.some(({ id }) => id === dependency.dependsOnProjectId) && (
                <option value={dependency.dependsOnProjectId}>{dependency.projectName}</option>
              )}
          </select>
        </Field>
        <Field label="依赖类型">
          <select name="dependencyType" defaultValue={dependency?.dependencyType ?? 'RUNTIME'}>
            <option value="RUNTIME">运行依赖</option>
            <option value="DEPLOYMENT">部署依赖</option>
          </select>
        </Field>
        <Field label="说明">
          <textarea
            name="description"
            defaultValue={dependency?.description}
            maxLength={2000}
            rows={2}
          />
        </Field>
      </Form>
    </InlineEditor>
  );
}
