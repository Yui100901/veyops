import './project-workspace.css';
import { lazy, Suspense, useRef } from 'react';
import { ArrowLeft, Boxes, FolderGit2, GitFork, Settings2 } from 'lucide-react';
import { useResource } from '../../api';
import { ErrorBanner, Loading, PageHeader } from '../../components';
import type { ProjectDetail, User } from '../../models';
import { workspaceBackLink } from '../../workspace-navigation';
import type { GraphRunDrafts } from '../execution-graph/run/ExecutionGraphRun';
import { ProjectConfiguration } from './settings/ProjectConfiguration';
import { ProjectDelivery } from './delivery/ProjectDelivery';
import { ProjectResources } from './ProjectResources';
import { projectEntries, projectEntryPath, readProjectWorkspace } from './project-workspace-route';

const ProjectExecutionGraph = lazy(() => import('../execution-graph/ProjectExecutionGraph'));
const icons = { resources: FolderGit2, graph: GitFork, artifacts: Boxes, configuration: Settings2 };

export function ProjectWorkspace({
  route,
  user,
}: {
  route: NonNullable<ReturnType<typeof readProjectWorkspace>>;
  user: User;
}) {
  const { id, entry, location, search, tab } = route;
  const graphRunDrafts = useRef<GraphRunDrafts>(new Map());
  const projectResource = useResource<ProjectDetail>(
    `/projects/${id}${entry === 'artifacts' || entry === 'graph' ? '/delivery-context' : ''}`,
  );
  const project = projectResource.data;
  const back = workspaceBackLink(location);
  const scope = {
    origin: location.origin,
    originQuery: location.originQuery,
    serviceId: location.serviceId,
    environmentId: location.environmentId,
  };
  const title = project?.name || '项目工作台';
  return (
    <div className="project-workspace workbench-stack">
      <header className="project-workspace-header workbench-stack">
        <PageHeader
          eyebrow={project?.slug.toUpperCase() ?? '项目'}
          title={title}
          description={project?.description ?? ''}
          action={
            <a href={'#' + back.path} className="button secondary small project-workspace-back">
              <ArrowLeft size={15} aria-hidden="true" /> 返回{back.label}
            </a>
          }
        />
        <nav
          className="resource-section-switcher workbench-tabs project-entry-nav"
          aria-label="项目工作台"
        >
          {(Object.keys(projectEntries) as (keyof typeof projectEntries)[]).map((key) => {
            const Icon = icons[key];
            return (
              <a
                key={key}
                aria-current={key === entry ? 'page' : undefined}
                href={'#' + projectEntryPath(id, key, scope)}
              >
                <Icon size={16} aria-hidden="true" />
                {projectEntries[key]}
              </a>
            );
          })}
        </nav>
      </header>
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
            reloadProject={projectResource.reload}
            runDrafts={graphRunDrafts.current}
            runId={new URLSearchParams(search).get('run') ?? undefined}
            search={search}
          />
        </Suspense>
      ) : entry === 'artifacts' ? (
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
          backPath={back.path}
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
