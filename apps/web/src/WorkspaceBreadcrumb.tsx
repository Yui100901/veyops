import type { ProjectDetail } from './models';
import { deliveryPath, deliveryTabs } from './pages/delivery/delivery-route';
import {
  graphWorkbenchPath,
  type GraphPane,
} from './pages/execution-graph/graph-workbench-context';
import {
  projectEntries,
  projectEntryPath,
  projectResourcePath,
  projectResources,
  type readProjectWorkspace,
} from './pages/projects/project-workspace-route';
import { workspaceBackLink } from './workspace-navigation';

type Crumb = { label: string; href?: string };

const graphPanes: Record<GraphPane, string> = {
  draft: '草稿',
  published: '发布版本',
  run: '运行执行流',
  history: '运行记录',
};

export function projectBreadcrumbs(
  route: NonNullable<ReturnType<typeof readProjectWorkspace>>,
  project?: ProjectDetail,
): Crumb[] {
  const { id, entry, tab, search, location } = route;
  const { origin, originQuery, serviceId, environmentId } = location;
  const workspace = { origin, originQuery };
  const scope = { ...workspace, serviceId, environmentId };
  const query = new URLSearchParams(search);
  const projectName = project?.id === id ? project.name : '项目工作台';
  const list = workspaceBackLink(workspace);
  const crumbs: Crumb[] = [
    { label: '项目发布', href: list.label === '项目发布' ? list.path : '/projects' },
    { label: projectName, href: projectEntryPath(id, 'resources', workspace) },
    {
      label: projectEntries[entry],
      href: projectEntryPath(id, entry, entry === 'resources' ? workspace : scope),
    },
  ];

  if (entry === 'resources' && location.resource) {
    const resource = location.resource;
    crumbs.push({
      label: resource === 'environments' ? '环境' : projectResources[resource],
      href: projectResourcePath(id, { ...workspace, resource }),
    });
    const item =
      resource === 'services'
        ? project?.services.find(({ id }) => id === serviceId)?.name
        : resource === 'repositories'
          ? project?.repositories.find(({ id }) => id === location.repositoryId)?.name
          : resource === 'environments'
            ? project?.environments.find(({ id }) => id === environmentId)?.name
            : location.environmentSetId
              ? '变量集合详情'
              : undefined;
    if (item) crumbs.push({ label: item });
  }
  if (entry === 'graph') {
    const run = query.get('run');
    const current = query.get('pane');
    const pane = run
      ? 'history'
      : current === 'draft' || current === 'published' || current === 'history'
        ? current
        : 'run';
    if (pane !== 'run' || query.has('start'))
      crumbs.push({ label: graphPanes[pane], href: graphWorkbenchPath(id, { ...scope, pane }) });
    if (run) crumbs.push({ label: '运行详情' });
    else if (pane === 'run' && query.has('start')) crumbs.push({ label: '运行配置' });
    else if (pane === 'published' && /^\d+$/.test(query.get('version') ?? ''))
      crumbs.push({ label: 'v' + query.get('version') });
  }
  if (entry === 'artifacts') {
    crumbs.push({ label: deliveryTabs[tab], href: deliveryPath(id, tab, scope) });
    if (query.has('artifactId') || query.has('recordId')) crumbs.push({ label: '详情' });
  }

  return crumbs;
}

export function WorkspaceBreadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav className="workspace-breadcrumb" aria-label="当前位置">
      <ol>
        <li>
          <a href="#/portal">工作空间</a>
        </li>
        {items.map(({ label, href }, index) => (
          <li key={index}>
            {href && index < items.length - 1 ? (
              <a href={'#' + href}>{label}</a>
            ) : (
              <span aria-current="page">{label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
