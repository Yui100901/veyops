import { RefreshCw, Server } from 'lucide-react';
import { useResource } from '../api';
import { ErrorBanner, Loading, Section, Status } from '../components';
import type { ProjectDetail, ServerGroup } from '../models';
import { graphWorkbenchPath } from './graph-workbench-context';
import { projectResourcePath } from './project-workspace-route';
import { serverResourceHref } from './server-resource-route';
import './project-server-inventory.css';

export interface ServiceEnvironmentContext {
  serviceId: string;
  environmentId: string;
}

type ReferenceState = 'CONFIGURED' | 'DRAFT' | 'RUNNABLE' | 'PENDING' | 'HISTORY';

interface ResourceReference {
  resourceId: string;
  resourceType: string;
  sourceKind: string;
  sourceId: string;
  state: ReferenceState;
  serviceId?: string;
  environmentId?: string;
  version?: number;
  flowId?: string;
  flowName?: string;
  nodeId?: string;
  nodeName?: string;
  fieldId?: string;
  triggerId?: string;
  runId?: string;
  taskId?: string;
  viaGroupId?: string;
  viaGroupName?: string;
  viaTargetId?: string;
  viaTargetName?: string;
  serverNameSnapshot?: string;
  hostSnapshot?: string;
  portSnapshot?: number;
  label?: string;
}

interface ServerInventoryEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  status: string;
  active: boolean;
  references: ResourceReference[];
}

interface ResourceInventory {
  servers: ServerInventoryEntry[];
  references: ResourceReference[];
}

const stateLabels: Record<ReferenceState, string> = {
  CONFIGURED: '当前配置',
  DRAFT: '草稿',
  RUNNABLE: '可运行版本',
  PENDING: '待执行或进行中',
  HISTORY: '历史记录',
};

const sourceLabels: Record<string, string> = {
  SERVICE_ENVIRONMENT: '服务环境',
  ENVIRONMENT_DEFAULT: '环境默认目标',
  GRAPH: '执行图',
  TRIGGER: '触发规则',
  RUN: '执行流计划',
  TASK: '任务计划',
  DEPLOYMENT: '部署记录',
};

function endpoint(host: string, port?: number) {
  const address = host.includes(':') ? `[${host}]` : host;
  return port === undefined ? address : `${address}:${port}`;
}

function referenceKey(reference: ResourceReference) {
  return JSON.stringify([
    reference.resourceId,
    reference.sourceKind,
    reference.sourceId,
    reference.state,
    reference.serviceId,
    reference.environmentId,
    reference.version,
    reference.flowId,
    reference.nodeId,
    reference.fieldId,
    reference.triggerId,
    reference.runId,
    reference.taskId,
    reference.viaGroupId,
    reference.viaTargetId,
  ]);
}

function referenceLink(
  projectId: string,
  ref: ResourceReference,
  scope?: ServiceEnvironmentContext,
  view?: string,
) {
  const context = { ...scope, view };
  if (ref.runId)
    return {
      href: '#' + graphWorkbenchPath(projectId, { ...context, run: ref.runId }),
      title: '查看运行',
    };
  if (ref.taskId) return { href: `#/tasks/${encodeURIComponent(ref.taskId)}`, title: '查看任务' };
  if (ref.sourceKind === 'GRAPH' || ref.sourceKind === 'TRIGGER') {
    return {
      href:
        '#' +
        graphWorkbenchPath(projectId, {
          ...context,
          pane: ref.state === 'DRAFT' ? 'draft' : 'published',
          version: ref.version,
          node: ref.nodeId || ref.flowId,
          flow: ref.flowId,
        }),
      title: ref.state === 'DRAFT' ? '查看草稿' : '查看版本',
    };
  }
  if (ref.sourceKind === 'ENVIRONMENT_DEFAULT' && ref.environmentId)
    return {
      href:
        '#' +
        projectResourcePath(projectId, {
          view,
          resource: 'environments',
          environmentId: ref.environmentId,
        }),
      title: '环境默认发布目标',
    };
  if (ref.serviceId && ref.environmentId && !scope) {
    return {
      href:
        '#' +
        projectResourcePath(projectId, {
          view,
          resource: 'services',
          serviceId: ref.serviceId,
          environmentId: ref.environmentId,
          panel: 'servers',
        }),
      title: '服务环境配置',
    };
  }
}

function ReferenceList({
  project,
  references,
  scope,
  view,
}: {
  project: ProjectDetail;
  references: ResourceReference[];
  scope?: ServiceEnvironmentContext;
  view?: string;
}) {
  return (
    <ul className="project-server-references">
      {references.map((ref) => {
        const labels = [
          sourceLabels[ref.sourceKind] ?? '资源引用',
          project.services.find(({ id }) => id === ref.serviceId)?.name,
          project.environments.find(({ id }) => id === ref.environmentId)?.name,
          ref.version ? `v${ref.version}` : undefined,
          ref.flowName ?? ref.flowId,
          ref.nodeName ?? ref.nodeId,
          ref.fieldId,
        ].filter(Boolean);
        const membership = [
          ref.viaGroupId ? `分组 ${ref.viaGroupName || ref.viaGroupId}` : undefined,
          ref.viaTargetId ? `旧目标 ${ref.viaTargetName || ref.viaTargetId}` : undefined,
          !ref.viaGroupId &&
          !ref.viaTargetId &&
          (ref.sourceKind === 'SERVICE_ENVIRONMENT' || ref.sourceKind === 'ENVIRONMENT_DEFAULT')
            ? '直接选择服务器'
            : undefined,
        ].filter(Boolean);
        const destination = referenceLink(project.id, ref, scope, view);
        const snapshot = [
          ref.serverNameSnapshot,
          ref.hostSnapshot ? endpoint(ref.hostSnapshot, ref.portSnapshot) : undefined,
        ].filter(Boolean);
        return (
          <li key={referenceKey(ref)}>
            <div className="project-server-source">
              <span className="tag">{stateLabels[ref.state] ?? ref.state}</span>
              <span>{labels.join(' · ')}</span>
              {destination && (
                <a className="text-link" href={destination.href}>
                  {destination.title}
                </a>
              )}
            </div>
            {membership.length > 0 ? <small>{membership.join(' · ')}</small> : null}
            {snapshot.length > 0 ? <small>当次目标 {snapshot.join(' · ')}</small> : null}
            {ref.label && !labels.includes(ref.label) ? <small>{ref.label}</small> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ProjectServerInventory({
  project,
  scope,
  view,
  serverId,
  groupId,
}: {
  project: ProjectDetail;
  scope?: ServiceEnvironmentContext;
  view?: string;
  serverId?: string;
  groupId?: string;
}) {
  const data = useResource<ResourceInventory>(
    `/projects/${encodeURIComponent(project.id)}/resource-references`,
  );
  const groups = useResource<ServerGroup[]>(scope ? null : '/server-groups');
  const referencedGroups = new Set(
    data.data?.references
      .filter(({ resourceType, state }) => resourceType === 'SERVER_GROUP' && state !== 'HISTORY')
      .map(({ resourceId }) => resourceId),
  );
  const inScope = (ref: ResourceReference) =>
    (!serverId || ref.resourceId === serverId) &&
    (!groupId || ref.viaGroupId === groupId) &&
    (!scope ||
      (ref.environmentId === scope.environmentId &&
        (ref.serviceId === scope.serviceId || ref.sourceKind === 'ENVIRONMENT_DEFAULT')));
  const servers = (data.data?.servers ?? []).flatMap((server) => {
    const matching = server.references.filter(inScope);
    const current = matching.filter(({ state }) => state !== 'HISTORY');
    return current.length
      ? [{ ...server, current, history: matching.filter(({ state }) => state === 'HISTORY') }]
      : [];
  });
  const historical = (data.data?.references ?? []).filter(
    (ref) => ref.resourceType === 'SERVER' && ref.state === 'HISTORY' && inScope(ref),
  );
  const currentIds = new Set(servers.map(({ id }) => id));
  const historicalOnly = historical.filter(({ resourceId }) => !currentIds.has(resourceId));
  const actions = (
    <div className="heading-actions">
      <a className="text-link" href="#/servers">
        管理服务器与分组
      </a>
      <button
        className="button secondary small"
        type="button"
        onClick={() => void data.reload()}
        disabled={data.loading}
      >
        <RefreshCw aria-hidden="true" size={14} /> 刷新
      </button>
    </div>
  );
  const content = (
    <div className="project-server-inventory">
      <ErrorBanner error={data.error} retry={data.reload} />
      {data.loading ? (
        <Loading />
      ) : (
        data.data && (
          <>
            {!scope && !serverId && (
              <div className="project-resource-links">
                {groups.data
                  ?.filter(({ id }) => referencedGroups.has(id) && (!groupId || id === groupId))
                  .map((group) => (
                    <a
                      className="button secondary small"
                      key={group.id}
                      href={serverResourceHref({
                        groupId: group.id,
                        projectId: project.id,
                        returnPath: window.location.hash.slice(1),
                      })}
                    >
                      {group.name} <span className="tag">{group.serverIds.length} 台</span>
                    </a>
                  ))}
              </div>
            )}
            {(serverId || groupId) && (
              <a className="text-link" href="#/servers">
                查看平台服务器
              </a>
            )}
            {!servers.length && (
              <p className="mini-empty">
                {scope ? '这个服务环境暂无当前服务器引用。' : '这个项目暂无当前服务器引用。'}
              </p>
            )}
            {servers.map(({ id, name, host, port, status, active, current, history }) => (
              <details
                className="project-server-entry"
                key={id}
                open={servers.length === 1 ? true : undefined}
              >
                <summary>
                  <Server aria-hidden="true" size={16} />
                  <strong>{name}</strong>
                  <small>{endpoint(host, port)}</small>
                  <Status value={active === false ? 'DISABLED' : status} />
                  <span className="tag">{current.length} 项来源</span>
                </summary>
                <ReferenceList project={project} references={current} scope={scope} view={view} />
                {!!history.length && (
                  <details className="project-server-history">
                    <summary>{history.length} 项历史引用</summary>
                    <ReferenceList
                      project={project}
                      references={history}
                      scope={scope}
                      view={view}
                    />
                  </details>
                )}
              </details>
            ))}
            {historicalOnly.length > 0 && (
              <details className="project-server-entry">
                <summary>仅历史运行引用的服务器</summary>
                <ReferenceList
                  project={project}
                  references={historicalOnly}
                  scope={scope}
                  view={view}
                />
              </details>
            )}
            {historical.length > 0 && (
              <a
                className="text-link"
                href={'#' + graphWorkbenchPath(project.id, { view, ...scope, pane: 'history' })}
              >
                在运行记录查看历史目标
              </a>
            )}
          </>
        )
      )}
    </div>
  );
  return scope ? (
    <div className="form-body">
      {actions}
      {content}
    </div>
  ) : (
    <Section title="项目服务器" action={actions}>
      {content}
    </Section>
  );
}
