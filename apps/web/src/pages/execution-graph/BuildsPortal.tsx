import { useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { ApiError, formatTime, message, navigate, post, useResource } from '../../api';
import { Empty, ErrorBanner, Field, Loading, PageHeader, Section, Status } from '../../components';
import type { User } from '../../models';
import { graphKey } from './execution-graph-definition';
import { graphWorkbenchPath } from './graph-workbench-context';
import './builds-portal.css';

interface Flow {
  id: string;
  name: string;
  serviceId?: string;
  serviceName?: string;
  version?: number;
  hasDraftChanges: boolean;
  triggerKinds: string[];
  latestRun?: { id: string; status: string; createdAt: number };
}

interface ProjectFlows {
  projectId: string;
  projectName: string;
  flows: Flow[];
}

const triggerNames: Record<string, string> = {
  CRON: '定时',
  POLL: '仓库轮询',
  WEBHOOK: 'Webhook',
  UPSTREAM: '上游',
  API: 'API',
};

export function BuildsPortal({ user }: { user: User }) {
  const catalog = useResource<ProjectFlows[]>('/delivery-flows', 15000);
  const projects = catalog.data ?? [];
  const canRun = user.role !== 'VIEWER';
  const [projectId, setProjectId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const active = useRef(false);
  const requestKeys = useRef(new Map<string, string>());
  const narrowed = projects.filter((project) => !projectId || project.projectId === projectId);
  const services = new Map(
    narrowed.flatMap(({ flows }) =>
      flows.flatMap((flow) =>
        flow.serviceId && flow.serviceName ? [[flow.serviceId, flow.serviceName] as const] : [],
      ),
    ),
  );
  const visible = narrowed
    .map((project) => ({
      ...project,
      flows: project.flows.filter(
        (flow) =>
          (!serviceId || serviceId === flow.serviceId) &&
          [flow.name, flow.serviceName, project.projectName].some((value) =>
            value?.toLowerCase().includes(query.trim().toLowerCase()),
          ),
      ),
    }))
    .filter(({ flows }) => flows.length > 0);

  async function start(project: ProjectFlows, flow: Flow) {
    if (!canRun || !flow.version || active.current) return;
    active.current = true;
    const key = [project.projectId, flow.id, flow.version].join('/');
    setBusy(key);
    setError('');
    const idempotencyKey = requestKeys.current.get(key) ?? graphKey('defaults');
    requestKeys.current.set(key, idempotencyKey);
    const runPath = graphWorkbenchPath(project.projectId, { pane: 'run', start: flow.id });
    try {
      const result = await post<
        { outcome: 'STARTED'; runId: string } | { outcome: 'NEEDS_CONFIRMATION' }
      >(
        `/projects/${project.projectId}/execution-graph/flows/${encodeURIComponent(flow.id)}/run-defaults`,
        { version: flow.version, idempotencyKey },
      );
      navigate(
        result.outcome === 'STARTED'
          ? graphWorkbenchPath(project.projectId, { pane: 'history', run: result.runId })
          : runPath,
      );
    } catch (err) {
      if (err instanceof ApiError && err.planIssue?.code === 'INPUT') {
        const field =
          err.planIssue.parameterId ??
          (err.planIssue.nodeId === flow.id ? err.planIssue.fieldId : undefined);
        navigate(graphWorkbenchPath(project.projectId, { pane: 'run', start: flow.id, field }));
      } else {
        setError(message(err));
        if (err instanceof ApiError && err.status === 409) void catalog.reload();
      }
    } finally {
      active.current = false;
      setBusy('');
    }
  }

  return (
    <>
      <PageHeader
        title="构建发布"
        description="运行已发布的执行流，或打开画布修改草稿。"
        action={
          <a className="button secondary" href="#/projects">
            管理项目
          </a>
        }
      />
      <ErrorBanner error={catalog.error || error} retry={catalog.reload} />
      <div className="builds-filters">
        <Field label="查找执行流">
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <Field label="项目">
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setServiceId('');
            }}
          >
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.projectId} value={project.projectId}>
                {project.projectName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="服务">
          <select value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
            <option value="">全部服务</option>
            {[...services].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {catalog.loading && <Loading />}
      {!catalog.loading && !visible.length && (
        <Empty
          title="没有符合条件的执行流"
          description="可调整筛选条件，或在项目的画布中创建执行流。"
        />
      )}
      {visible.map((project) => (
        <Section key={project.projectId} title={project.projectName}>
          <ul className="builds-list">
            {project.flows.map((flow) => (
              <li key={flow.id}>
                <div>
                  <strong>{flow.name}</strong>
                  <div className="builds-flow-meta">
                    {flow.serviceName && <span>{flow.serviceName}</span>}
                    <span>{flow.version ? `已发布 v${flow.version}` : '草稿'}</span>
                    {flow.version && flow.hasDraftChanges && <span>有草稿修改</span>}
                    {flow.triggerKinds.length > 0 && (
                      <span>
                        {flow.triggerKinds.map((kind) => triggerNames[kind] ?? kind).join('、')}
                      </span>
                    )}
                  </div>
                  {flow.latestRun && (
                    <div className="builds-flow-meta">
                      <Status value={flow.latestRun.status} />
                      {formatTime(flow.latestRun.createdAt)}
                    </div>
                  )}
                </div>
                <div className="row-actions">
                  {canRun && (
                    <a
                      className="button secondary"
                      href={
                        '#' +
                        graphWorkbenchPath(project.projectId, {
                          pane: 'draft',
                          start: flow.id,
                          node: flow.id,
                        })
                      }
                    >
                      配置画布
                    </a>
                  )}
                  {canRun && flow.version && (
                    <button
                      type="button"
                      className="button primary"
                      disabled={!!busy}
                      onClick={() => void start(project, flow)}
                    >
                      <Play size={15} />{' '}
                      {busy === [project.projectId, flow.id, flow.version].join('/')
                        ? '正在启动'
                        : '立即运行'}
                    </button>
                  )}
                  {canRun && flow.version && (
                    <a
                      className="button secondary"
                      href={
                        '#' + graphWorkbenchPath(project.projectId, { pane: 'run', start: flow.id })
                      }
                    >
                      带参数运行
                    </a>
                  )}
                  {flow.latestRun && (
                    <a
                      className="button secondary"
                      href={
                        '#' +
                        graphWorkbenchPath(project.projectId, {
                          pane: 'history',
                          run: flow.latestRun.id,
                        })
                      }
                    >
                      历史
                    </a>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ))}
    </>
  );
}
