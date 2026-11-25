import { ErrorBanner, Section } from '../../../components';
import type { Environment, ProjectDetail, User } from '../../../models';
import { useDeploymentInventory } from '../../delivery/DeploymentSelection';
import { EnvironmentVariables } from './EnvironmentVariables';
import {
  projectGraphPath,
  projectResourcePath,
  type GraphResourceReturn,
} from '../project-workspace-route';

const panels = { file: '环境文件', variables: '环境变量', targets: '默认发布目标' };

export function ProjectEnvironment({
  project,
  environment,
  user,
  origin,
  originQuery,
  panel,
  graphBack,
}: {
  project: ProjectDetail;
  environment: Environment;
  user: User;
  origin?: string;
  originQuery?: string;
  panel?: string;
  graphBack: GraphResourceReturn;
}) {
  const active = panel === 'variables' || panel === 'targets' ? panel : 'file';
  const inventory = useDeploymentInventory(active === 'targets');
  const path = (tab: string) =>
    '#' +
    projectResourcePath(project.id, {
      ...graphBack,
      origin,
      originQuery,
      resource: 'environments',
      environmentId: environment.id,
      panel: tab,
    });
  const servers = environment.defaultTargetSelection?.serverIds ?? [];
  const groups = environment.defaultTargetSelection?.groupIds ?? [];
  return (
    <>
      <Section title={environment.name} subtitle={environment.description || environment.slug}>
        <p className="field-note">此页面保留历史环境配置。新的发布目标和环境文件在执行图中维护。</p>
        <nav className="resource-section-switcher" aria-label="历史环境详情">
          {Object.entries(panels).map(([key, label]) => (
            <a key={key} href={path(key)} aria-current={active === key ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <div className="row-actions">
          <a
            className="button secondary small"
            href={'#' + projectGraphPath(project.id, { origin, originQuery })}
          >
            打开执行图
          </a>
          <a
            className="button secondary small"
            href={
              '#' +
              projectResourcePath(project.id, { resource: 'environment-sets', origin, originQuery })
            }
          >
            查看变量集合
          </a>
        </div>
      </Section>
      {active === 'variables' && (
        <Section title="历史环境变量">
          <EnvironmentVariables
            projectId={project.id}
            environmentId={environment.id}
            user={user}
            editable={false}
          />
        </Section>
      )}
      {active === 'file' && (
        <Section title="历史仓库环境文件">
          {environment.repositoryEnvFile ? (
            <code>{environment.repositoryEnvFile}</code>
          ) : (
            <p className="muted">未指定环境文件。</p>
          )}
        </Section>
      )}
      {active === 'targets' && (
        <Section title="历史默认发布目标">
          <ErrorBanner error={inventory.servers.error} retry={inventory.servers.reload} />
          <ErrorBanner error={inventory.groups.error} retry={inventory.groups.reload} />
          {servers.length || groups.length ? (
            <ul>
              {servers.map((id) => (
                <li key={'server-' + id}>
                  服务器 · {inventory.servers.data?.find((server) => server.id === id)?.name ?? id}
                </li>
              ))}
              {groups.map((id) => (
                <li key={'group-' + id}>
                  分组 · {inventory.groups.data?.find((group) => group.id === id)?.name ?? id}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">未设置默认发布目标。</p>
          )}
        </Section>
      )}
    </>
  );
}
