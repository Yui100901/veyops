import { InlineEditor, useInlineEditor } from '../../InlineEditor';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, FolderGit2, Plus, Search } from 'lucide-react';
import { message, post, useResource } from '../../api';
import { ProjectBasicsFields, projectBasicsValues } from './settings/ProjectConfiguration';
import { ProjectAccessLinks, type ProjectAccessLink } from './ProjectAccessLinks';
import { projectResourcePath } from './project-workspace-route';
import { Empty, ErrorBanner, Form, Loading, PageHeader } from '../../components';
import type { Project, User } from '../../models';
import { submittedForm } from '../../form-data';

function ProjectEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    const payload = projectBasicsValues(submittedForm(event));
    setBusy(true);
    setError('');
    try {
      await post('/projects', payload);
      onSaved();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <InlineEditor title="创建项目" onClose={onClose} busy={busy}>
      <Form onSubmit={save} error={error} busy={busy} submit="创建项目" onCancel={onClose}>
        <ProjectBasicsFields autoFocus />
      </Form>
    </InlineEditor>
  );
}

export function ProjectsPage({ user }: { user: User }) {
  const resource = useResource<(Project & { addresses: ProjectAccessLink[] })[]>(
    '/projects?include=addresses',
  );
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useInlineEditor<true>();
  const list = (resource.data ?? []).filter((project) =>
    `${project.name} ${project.slug}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="PROJECT WORKSPACE"
        title="项目管理"
        description="以项目组织代码仓库、应用服务与变量集合。"
        action={
          user.role !== 'VIEWER' && (
            <button
              className="button primary"
              disabled={creating}
              onClick={() => setCreating(true)}
            >
              <Plus size={17} />
              创建项目
            </button>
          )
        }
      />
      <ErrorBanner error={resource.error} retry={resource.reload} />
      {creating && (
        <ProjectEditor
          onClose={() => setCreating(undefined)}
          onSaved={() => {
            setCreating(undefined);
            void resource.reload();
          }}
        />
      )}
      <div className="project-toolbar">
        <span>{resource.data?.length ?? 0} 个项目</span>
        <div className="search-input">
          <Search size={16} />
          <input
            aria-label="搜索项目"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索项目"
          />
        </div>
      </div>
      {resource.loading ? (
        <Loading />
      ) : !resource.data?.length ? (
        <div className="panel">
          <Empty
            icon={<FolderGit2 size={25} />}
            title="让项目成为运维的组织中心"
            description="创建项目后，可添加仓库、服务和变量集合。"
            action={
              user.role !== 'VIEWER' && (
                <button
                  className="button primary"
                  disabled={creating}
                  onClick={() => setCreating(true)}
                >
                  <Plus size={16} />
                  创建项目
                </button>
              )
            }
          />
        </div>
      ) : !list.length ? (
        <Empty title="没有匹配的项目" description="尝试其他项目名称或标识。" />
      ) : (
        <div className="project-grid project-catalog">
          {list.map((project) => (
            <article key={project.id} className="project-card">
              <div className="project-card-top">
                <span className="project-avatar" aria-hidden="true">
                  <FolderGit2 size={23} />
                </span>
                <div>
                  <h2>{project.name}</h2>
                  <span className="project-slug mono">{project.slug}</span>
                </div>
              </div>
              {project.description && <p>{project.description}</p>}
              {project.tags.length > 0 && (
                <div className="tags">
                  {project.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <ProjectAccessLinks
                addresses={project.addresses ?? []}
                serviceHref={(serviceId) =>
                  '#' + projectResourcePath(project.id, { resource: 'services', serviceId })
                }
              />
              <div className="project-card-footer">
                <span>{project.serviceCount ?? 0} 个服务</span>
                <span>{project.environmentSetCount ?? 0} 个变量集合</span>
                <a
                  href={`#/projects/${encodeURIComponent(project.id)}`}
                  className="button secondary small"
                  aria-label={`查看项目：${project.name}`}
                >
                  项目详情 <ArrowRight size={15} aria-hidden="true" />
                </a>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
