import { lazy, Suspense } from 'react';
import { Boxes, FolderGit2, GitFork, Settings2 } from 'lucide-react';
import { useResource } from '../api';
import { ErrorBanner, Loading, PageHeader } from '../components';
import type { ProjectDetail, User } from '../models';
import { ProjectConfiguration } from './ProjectConfiguration';
import { ProjectDelivery } from './ProjectDelivery';
import { ProjectResources } from './ProjectResources';
import { projectEntries, projectEntryPath, readProjectWorkspace } from './project-workspace-route';

const ProjectExecutionGraph = lazy(() => import('./ProjectExecutionGraph'));
const icons = { resources: FolderGit2, graph: GitFork, delivery: Boxes, configuration: Settings2 };

export function ProjectWorkspace({
  route,
  user,
}: {
  route: NonNullable<ReturnType<typeof readProjectWorkspace>>;
  user: User;
}) {
  const { id, entry, location, search, tab } = route;
  const projectResource = useResource<ProjectDetail>(
    `/projects/${id}${entry === 'delivery' || entry === 'graph' ? '/delivery-context' : ''}`,
  );
  const project = projectResource.data;
  const backPath = location.view ? `/views/${location.view}` : '/projects';
  const scope = {
    view: location.view,
    serviceId: location.serviceId,
    environmentId: location.environmentId,
  };
  const title = project?.name || '项目工作台';
  return (
    <div className="project-workspace">
      <a href={'#' + backPath} className="back-link">
        {location.view ? '← 返回项目视图' : '← 返回项目列表'}
      </a>
      <PageHeader
        eyebrow={project?.slug.toUpperCase() ?? '项目'}
        title={title}
        description={project?.description ?? ''}
      />
      <nav className="resource-section-switcher project-entry-nav" aria-label="项目工作台">
        {(Object.keys(projectEntries) as (keyof typeof projectEntries)[]).map((key) => {
          const Icon = icons[key];
          return (
            <a
              key={key}
              aria-current={key === entry ? 'page' : undefined}
              href={'#' + projectEntryPath(id, key, scope)}
            >
              <Icon size={17} aria-hidden="true" />
              {projectEntries[key]}
            </a>
          );
        })}
      </nav>
      <ErrorBanner error={projectResource.error} retry={projectResource.reload} />
      {!project ? (
        projectResource.loading && <Loading />
      ) : entry === 'graph' ? (
        <Suspense fallback={<Loading />}>
          <ProjectExecutionGraph
            key={id}
            id={id}
            user={user}
            embedded
            project={project}
            runId={new URLSearchParams(search).get('run') ?? undefined}
            search={search}
          />
        </Suspense>
      ) : entry === 'delivery' ? (
        <ProjectDelivery
          key={tab + ':' + (search ?? '')}
          id={id}
          user={user}
          embedded
          project={project}
          tab={tab}
          search={search}
        />
      ) : entry === 'configuration' ? (
        <ProjectConfiguration
          project={project}
          user={user}
          onSaved={projectResource.reload}
          backPath={backPath}
        />
      ) : (
        <ProjectResources
          key={search ?? ''}
          project={project}
          user={user}
          location={location}
          reload={projectResource.reload}
        />
      )}
    </div>
  );
}
