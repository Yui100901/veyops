import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { formatTime, message, post, useResource, type ExecutionPlanIssue } from '../../../api';
import {
  Confirm,
  ErrorBanner,
  Field,
  Loading,
  RefreshButton,
  Section,
  Status,
} from '../../../components';
import type { ProjectDetail } from '../../../models';
import { NodeMap } from '../editor/ExecutionGraphCanvas';
import { ConfiguredNodeExecution } from '../editor/ExecutionGraphNodeDetails';
import { ExecutionGraphNodeLogs } from './ExecutionGraphNodeLogs';
import { ExecutionGraphStickyCanvas, scrollBelowGraphCanvas } from './ExecutionGraphStickyCanvas';
import { FieldEvidenceList, sourceName } from './ExecutionGraphPreview';
import {
  ExecutionGraphParameterLink,
  ExecutionGraphRepairLinks,
} from './ExecutionGraphRepairLinks';
import {
  artifactOutput,
  GraphRunResults,
  planIssueLabels,
  repairKind,
} from './ExecutionGraphRunEvidence';
import {
  ExecutionGraphReleaseInspection,
  ExecutionGraphReleaseResults,
  ExecutionGraphReviewScope,
  releaseTargetHealthUnknown,
  type ReleaseContext,
  type ReleaseInspection,
  type ReviewScope,
} from './ExecutionGraphReleaseResults';
import {
  graphNodeLabels,
  graphNodeTypeLabel,
  isReleaseNode,
  type GraphEnvironmentSetSummary,
  type GraphFieldEvidence,
  type GraphFlow,
  type GraphRun,
} from '../execution-graph-definition';
import { deliveryPath, deliveryTabs } from '../../delivery/delivery-route';
import { projectEntryPath, projectResourcePath } from '../../projects/project-workspace-route';
import { serverResourceHref } from '../../infrastructure/server-resource-route';
import {
  graphDraftSetupHref,
  graphRunHref,
  graphWorkbenchPath,
  type GraphDeliveryReturn,
  type GraphWorkbenchScope,
} from '../graph-workbench-context';
import './execution-graph-history.css';

interface RunNode {
  nodeId: string;
  name: string;
  type: string;
  status: string;
  log: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  taskId?: string;
  childRunId?: string | null;
  inputs?: GraphFieldEvidence[];
  outputFields?: GraphFieldEvidence[];
  environment?: GraphFieldEvidence[];
  issue?: ExecutionPlanIssue;
  checkout?: {
    versionSource: string;
    requestedVersion?: { kind: 'BRANCH' | 'TAG' | 'COMMIT'; value: string };
    triggerRepositoryId?: string;
    triggerCommitSha?: string;
  };
  targets?: {
    serverId: string;
    serverName?: string;
    status: string;
    exitCode?: number | null;
    errorSummary?: string | null;
    startedAt?: number | null;
    finishedAt?: number | null;
    inspection?: ReleaseInspection;
  }[];
  variableSources?: {
    key: string;
    source: string;
    isSecret: boolean;
    overriddenSources?: string[];
  }[];
  output?: Record<string, unknown> & {
    wakeAt?: number;
    expiresAt?: number;
    decision?: 'APPROVE' | 'REJECT' | 'EXPIRED';
    decidedAt?: number;
    actorId?: string;
    scope?: ReviewScope;
    scopeHash?: string;
  };
}
interface RunDetail extends GraphRun {
  nodes: RunNode[];
  createdBy?: string;
  commitSha?: string;
  artifactIds?: string[];
  definition?: GraphFlow;
  trigger?: Record<string, unknown>;
  environmentSet?: GraphEnvironmentSetSummary | null;
}

function failedRunStatus(status: string) {
  return ['FAILED', 'PARTIAL_FAILED', 'TIMED_OUT', 'NEEDS_ATTENTION'].includes(status);
}

function RunNodeRecovery({
  node,
  flow,
  project,
  scope,
  version,
  nodeHref,
  canRepair,
  canReplan,
}: {
  node: RunNode;
  flow: GraphFlow;
  project: ProjectDetail;
  scope: GraphWorkbenchScope;
  version: number;
  nodeHref: (id: string) => string;
  canRepair: boolean;
  canReplan: boolean;
}) {
  const { issue } = node;
  if (!issue && !failedRunStatus(node.status)) return null;

  const issueKind = issue && repairKind(issue.code);
  const currentFlow = !issue?.flowId || issue.flowId === flow.id;
  const startNode = flow.nodes.find(({ type }) => type === 'START');
  const inputId =
    issue?.parameterId ?? (node.nodeId === startNode?.id ? issue?.fieldId : undefined);
  const field = currentFlow ? startNode?.inputs?.find(({ id }) => id === inputId) : undefined;
  const start = { ...scope, start: flow.id, version, field: field?.id };
  const source = flow.nodes.find(({ id }) => id === issue?.sourceNodeId);
  const missingSource = currentFlow && source?.id !== node.nodeId ? source : undefined;
  const repository = project.repositories.find(({ id }) => id === issue?.repositoryId);
  const artifactRefs = (node.inputs ?? [])
    .filter(({ type, sensitive }) => type === 'ARTIFACT' && !sensitive)
    .flatMap(({ value }) => (Array.isArray(value) ? value : [value]))
    .map(artifactOutput)
    .filter((reference) => reference && !reference.temporary);
  const artifactHref =
    '#' +
    deliveryPath(project.id, 'artifacts', {
      view: scope.view,
      viewSearch: scope.viewSearch,
      ...(artifactRefs.length === 1
        ? { recordId: artifactRefs[0]?.id }
        : {
            serviceId: issue?.serviceId ?? scope.serviceId,
            environmentId: issue?.environmentId ?? scope.environmentId,
          }),
    });

  return (
    <div className="error-banner graph-plan-issue" role="status">
      <AlertCircle size={17} aria-hidden="true" />
      <div>
        <strong>
          {node.status === 'NEEDS_ATTENTION'
            ? '执行结果待核查'
            : issue
              ? planIssueLabels[issue.code]
              : '节点执行异常'}
        </strong>
        {issue && (
          <p>
            {[issue.fieldName ?? issue.fieldId, issue.branchId, issue.message]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        {node.status === 'NEEDS_ATTENTION' && <p>请核查目标的实际状态和已记录的执行结果。</p>}
        <div className="graph-node-actions">
          {missingSource && (
            <a className="button secondary small" href={nodeHref(missingSource.id)}>
              查看来源节点运行 · {missingSource.name}
            </a>
          )}
          {issue?.code === 'REPOSITORY' && (
            <a
              className="button secondary small"
              href={
                '#' +
                projectResourcePath(project.id, {
                  resource: 'repositories',
                  repositoryId: repository?.id,
                  view: scope.view,
                  viewSearch: scope.viewSearch,
                })
              }
            >
              {repository ? `查看仓库 · ${repository.name}` : '查看项目仓库'}
            </a>
          )}
          {issue?.code === 'ARTIFACT' && (
            <a className="button secondary small" href={artifactHref}>
              {artifactRefs.length === 1 ? '查看所选产物' : '查看项目产物'}
            </a>
          )}
          {issue?.code === 'BUILD_TARGET' && (
            <a
              className="button secondary small"
              href={'#' + projectEntryPath(project.id, 'configuration', scope)}
            >
              查看项目执行配置
            </a>
          )}
          {issue?.code === 'RELEASE_TARGET' &&
            project.environments.some(({ id }) => id === issue.environmentId) && (
              <a
                className="button secondary small"
                href={
                  '#' +
                  projectResourcePath(project.id, {
                    resource: 'environments',
                    environmentId: issue.environmentId,
                    panel: 'targets',
                    view: scope.view,
                    viewSearch: scope.viewSearch,
                  })
                }
              >
                查看环境发布目标
              </a>
            )}
          {canRepair && currentFlow && issue && issueKind && (
            <ExecutionGraphRepairLinks
              project={project}
              flow={flow}
              start={start}
              issue={{ ...issue, nodeId: node.nodeId, kind: issueKind, parameterId: field?.id }}
            />
          )}
          {canRepair &&
            currentFlow &&
            issue &&
            !issueKind &&
            (field ? (
              <ExecutionGraphParameterLink
                projectId={project.id}
                start={start}
                fieldId={field.id}
                label="调整运行参数"
              />
            ) : (
              <a
                className="button secondary small"
                href={graphDraftSetupHref(project.id, start, {
                  flow: flow.id,
                  node: node.nodeId,
                  field: issue.fieldId,
                  fieldSection: issue.fieldSection,
                  artifactField: issue.artifactField,
                })}
              >
                定位草稿中的节点配置
              </a>
            ))}
          {canReplan && !field && (
            <a
              className="button secondary small"
              href={'#' + graphWorkbenchPath(project.id, start)}
            >
              打开原版本重新预览
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function needsReleaseInspection(node: RunNode, target: NonNullable<RunNode['targets']>[number]) {
  return (
    (isReleaseNode(node) || node.type === 'HEALTH_CHECK') &&
    (Boolean(target.inspection) ||
      (!['PENDING', 'QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED'].includes(node.status) &&
        (['NEEDS_ATTENTION', 'FAILED', 'TIMED_OUT'].includes(target.status) ||
          (node.type === 'HEALTH_CHECK' &&
            releaseTargetHealthUnknown(node.output?.release, target.serverId)))))
  );
}

export function ExecutionGraphHistory({
  path,
  project,
  canCancel,
  canApprove,
  userId,
  selected,
  selectedNodeId,
  onSelect,
  scope,
  delivery,
}: {
  path: string;
  project: ProjectDetail;
  canCancel: boolean;
  canApprove: boolean;
  userId: string;
  selected?: string;
  selectedNodeId?: string;
  onSelect: (id: string) => void;
  scope: GraphWorkbenchScope;
  delivery?: GraphDeliveryReturn;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const list = useResource<GraphRun[]>(
    path + '/runs' + (before ? '?before=' + encodeURIComponent(before) : ''),
    5000,
  );
  const lastRunId = list.data?.at(-1)?.id;
  if (selected) {
    return (
      <RunDetails
        key={selected}
        path={path + '/runs/' + encodeURIComponent(selected)}
        project={project}
        canCancel={canCancel}
        canApprove={canApprove}
        userId={userId}
        onChange={list.reload}
        scope={scope}
        delivery={delivery}
        selectedNodeId={selectedNodeId}
      />
    );
  }
  return (
    <Section title="执行流运行记录" action={<RefreshButton onClick={list.reload} />}>
      <ErrorBanner error={list.error} retry={list.reload} />
      {list.loading ? (
        <Loading />
      ) : list.data?.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>执行流</th>
                <th>图版本</th>
                <th>运行状态</th>
                <th>启动时间</th>
                <th>查看</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((run) => (
                <tr key={run.id}>
                  <td>{run.flowName}</td>
                  <td>v{run.version}</td>
                  <td>
                    <Status value={run.status} />
                  </td>
                  <td>{formatTime(run.createdAt)}</td>
                  <td>
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => onSelect(run.id)}
                    >
                      查看节点日志
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mini-empty">{before ? '没有更早的运行记录。' : '尚无执行流运行记录。'}</div>
      )}
      {(before || list.data?.length === 100) && (
        <nav className="graph-pagination" aria-label="运行记录翻页">
          <button
            type="button"
            className="button secondary small"
            disabled={!before}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            较新一页
          </button>
          <span role="status">
            第 {cursors.length + 1} 页{list.data?.length ? ` · ${list.data.length} 条` : ''}
          </span>
          <button
            type="button"
            className="button secondary small"
            disabled={
              list.loading || Boolean(list.error) || list.data?.length !== 100 || !lastRunId
            }
            onClick={() => {
              if (lastRunId) setCursors((current) => [...current, lastRunId]);
            }}
          >
            更早一页
          </button>
        </nav>
      )}
    </Section>
  );
}

function RunDetails({
  path,
  project,
  canCancel,
  canApprove,
  userId,
  onChange,
  scope,
  delivery,
  selectedNodeId,
}: {
  path: string;
  project: ProjectDetail;
  canCancel: boolean;
  canApprove: boolean;
  userId: string;
  onChange: () => void;
  scope: GraphWorkbenchScope;
  delivery?: GraphDeliveryReturn;
  selectedNodeId?: string;
}) {
  const projectId = project.id;
  const run = useResource<RunDetail>(path, 3000);
  const [cancelDialog, setCancelDialog] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [nodeSelection, setNodeSelection] = useState<{ linked?: string; nodeId: string }>();
  const overview = useRef<HTMLDivElement>(null);
  const sticky = useRef<HTMLDivElement>(null);
  const nodeDetail = useRef<HTMLElement>(null);
  const item = run.data;
  const definition = item?.definition;
  const requestedNode =
    nodeSelection?.linked === selectedNodeId
      ? (nodeSelection?.nodeId ?? selectedNodeId)
      : selectedNodeId;
  const failures = item?.nodes.filter(({ status }) => failedRunStatus(status)) ?? [];
  const n =
    item?.nodes.find(({ nodeId }) => nodeId === requestedNode) ??
    item?.nodes.find(({ status }) => ['WAITING', 'RUNNING'].includes(status)) ??
    failures[0] ??
    item?.nodes.find(({ type }) => type !== 'START' && type !== 'END') ??
    item?.nodes[0];
  const nodeId = n?.nodeId;
  const reveal = useMemo(() => (nodeId ? { nodeId } : undefined), [nodeId]);
  const nodeDefinition = item?.definition?.nodes.find(({ id }) => id === n?.nodeId);
  const canInspect = canApprove || (canCancel && item?.createdBy === userId);
  const currentRunId = item?.id;
  useEffect(() => {
    if (!currentRunId) return;
    const frame = window.requestAnimationFrame(() => {
      if (selectedNodeId && nodeDetail.current?.id === 'graph-run-node-' + selectedNodeId)
        scrollBelowGraphCanvas(nodeDetail.current, sticky.current);
      else overview.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentRunId, selectedNodeId]);
  const deliveryScope = {
    serviceId: scope.serviceId,
    environmentId: scope.environmentId,
    view: scope.view,
    viewSearch: scope.viewSearch,
  };
  const nodeHref = (node: string) =>
    '#' + graphWorkbenchPath(projectId, { ...scope, ...delivery, run: item?.id, node });
  const releaseContext = {
    projectId,
    deliveryScope,
    returnPath: n ? nodeHref(n.nodeId).slice(1) : '',
    nodeHref,
    nodeName: (id: string) => item?.nodes.find(({ nodeId }) => id === nodeId)?.name,
    repositoryName: (id) => project.repositories.find((repository) => id === repository.id)?.name,
    serviceName: (id) =>
      [...project.services, ...(project.archivedServices ?? [])].find(
        (service) => id === service.id,
      )?.name,
  } satisfies ReleaseContext;
  const returnLink =
    delivery &&
    '#' +
      deliveryPath(projectId, delivery.deliveryTab, {
        ...deliveryScope,
        recordId: delivery.recordId,
        commit: delivery.commit,
        repositoryId: delivery.repositoryId,
        pipelineRunId: delivery.pipelineRunId,
        taskId: delivery.taskId,
      });
  const active = ['PENDING', 'QUEUED', 'WAITING', 'RUNNING'].includes(item?.status ?? '');
  const releaseChecks =
    item?.nodes.flatMap(
      (node) => node.targets?.filter((target) => needsReleaseInspection(node, target)) ?? [],
    ) ?? [];
  function selectNode(nodeId: string) {
    setNodeSelection({ linked: selectedNodeId, nodeId });
    window.requestAnimationFrame(() => scrollBelowGraphCanvas(nodeDetail.current, sticky.current));
  }
  function closeCancel() {
    if (!cancelling) {
      setCancelDialog(false);
      setCancelError('');
    }
  }
  async function cancel() {
    if (cancelling) return;
    setCancelling(true);
    setCancelError('');
    try {
      await post(path + '/cancel', {});
      setCancelDialog(false);
      void run.reload();
      onChange();
    } catch (err) {
      setCancelError(message(err));
      void run.reload();
    } finally {
      setCancelling(false);
    }
  }
  return (
    <Section
      title="运行详情与节点日志"
      className="graph-history-detail"
      action={
        <div className="heading-actions">
          <a
            className="button secondary small"
            href={'#' + graphWorkbenchPath(projectId, { ...scope, ...delivery, pane: 'history' })}
          >
            <ArrowLeft size={15} aria-hidden="true" /> 返回运行记录
          </a>
          {canCancel && active && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => setCancelDialog(true)}
            >
              取消运行
            </button>
          )}
        </div>
      }
    >
      <div className="graph-fields">
        <ErrorBanner error={run.error} retry={run.reload} />
        {run.loading ? (
          <Loading />
        ) : (
          item && (
            <>
              <div className="graph-history-overview" ref={overview}>
                <div className="heading-actions">
                  <h3>{item.flowName}</h3>
                  <Status value={item.status} />
                </div>
                <small>
                  图版本 v{item.version} · {formatTime(item.createdAt)}
                </small>
              </div>
              {returnLink && delivery && (
                <div className="heading-actions">
                  <a className="button secondary small" href={returnLink}>
                    ← 返回{deliveryTabs[delivery.deliveryTab]}
                  </a>
                </div>
              )}
              {item.parentRunId && (
                <a
                  className="text-link"
                  href={graphRunHref(projectId, item.parentRunId, scope, delivery)}
                >
                  返回父运行
                </a>
              )}
              <details className="graph-field-card graph-history-context">
                <summary>运行上下文</summary>
                <div className="graph-history-context-content">
                  <p>
                    运行 ID · <code>{item.id}</code>
                  </p>
                  {item.commitSha && (
                    <p>
                      源码提交 · <code>{item.commitSha}</code>
                    </p>
                  )}
                  {item.environmentSet && (
                    <div>
                      入口变量集合 ·{' '}
                      <a
                        className="text-link"
                        href={
                          '#' +
                          projectResourcePath(projectId, {
                            resource: 'environment-sets',
                            environmentSetId: item.environmentSet.id,
                            view: scope.view,
                          })
                        }
                      >
                        {item.environmentSet.name} · 修订 {item.environmentSet.revision}
                      </a>
                    </div>
                  )}
                  <GraphRunResults
                    values={item.outputs}
                    labels={Object.fromEntries(
                      (
                        item.definition?.nodes.find(({ type }) => type === 'END')?.outputs ?? []
                      ).map(({ id, name }) => [id, name]),
                    )}
                    title="执行流输出"
                    artifactContext={{ projectId, scope: deliveryScope }}
                  />
                  <GraphRunResults values={item.trigger} title="触发信息" />
                  {item.artifactIds?.length || scope.serviceId || scope.environmentId ? (
                    <div className="heading-actions">
                      <a
                        className="button secondary small"
                        href={'#' + deliveryPath(projectId, 'artifacts', deliveryScope)}
                      >
                        查看{scope.serviceId || scope.environmentId ? '此范围的' : '项目'}构建产物
                      </a>
                    </div>
                  ) : null}
                  {item.artifactIds?.length ? (
                    <div className="heading-actions">
                      {item.artifactIds.map((id) => (
                        <a
                          key={id}
                          className="text-link"
                          href={
                            '#' +
                            deliveryPath(projectId, 'artifacts', { ...deliveryScope, recordId: id })
                          }
                        >
                          查看产物 {id.slice(0, 8)}
                        </a>
                      ))}
                    </div>
                  ) : null}
                  <a className="text-link" href={graphRunHref(projectId, item.id, scope, delivery)}>
                    本次运行的固定链接
                  </a>
                </div>
              </details>
              {failures.length > 1 && (
                <nav aria-label="异常节点" className="graph-node-actions">
                  {failures.map((failure) => (
                    <a
                      className="button secondary small"
                      key={failure.nodeId}
                      href={nodeHref(failure.nodeId)}
                      aria-current={n?.nodeId === failure.nodeId ? 'location' : undefined}
                    >
                      {failure.name} <Status value={failure.status} />
                    </a>
                  ))}
                </nav>
              )}
              {n && (
                <div className="graph-history-node-workspace">
                  <ExecutionGraphStickyCanvas
                    containerRef={sticky}
                    controls={
                      <Field label="定位节点">
                        <select
                          value={n.nodeId}
                          onChange={(event) => selectNode(event.target.value)}
                        >
                          {item.nodes.map(({ nodeId, name }) => (
                            <option key={nodeId} value={nodeId}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    }
                    renderCanvas={
                      definition
                        ? (expanded) => (
                            <NodeMap
                              flow={definition}
                              selected={[n.nodeId]}
                              onSelect={selectNode}
                              reveal={expanded ? reveal : undefined}
                            />
                          )
                        : undefined
                    }
                  />
                  <article
                    key={n.nodeId}
                    id={'graph-run-node-' + n.nodeId}
                    ref={nodeDetail}
                    className="graph-node-detail"
                    aria-label="运行节点详情"
                  >
                    <header>
                      <div>
                        <h3 aria-live="polite">{n.name}</h3>
                        <small>
                          {nodeDefinition
                            ? graphNodeTypeLabel(nodeDefinition)
                            : (graphNodeLabels[n.type as keyof typeof graphNodeLabels] ??
                              n.type)}{' '}
                          · v{item.version}
                        </small>
                      </div>
                      <Status value={n.status} />
                    </header>
                    {(n.startedAt != null || n.finishedAt != null) && (
                      <div className="graph-node-actions field-note">
                        {n.startedAt != null && <span>开始 {formatTime(n.startedAt)}</span>}
                        {n.finishedAt != null && <span>结束 {formatTime(n.finishedAt)}</span>}
                      </div>
                    )}
                    <div className="graph-node-actions">
                      <a
                        className="button secondary small"
                        href={
                          '#' +
                          graphWorkbenchPath(projectId, {
                            ...scope,
                            pane: 'published',
                            version: item.version,
                            node: n.nodeId,
                            flow: item.flowId,
                            field: n.issue?.fieldId,
                          })
                        }
                      >
                        查看发布配置
                      </a>
                      {n.taskId && (
                        <a className="button secondary small" href={'#/tasks/' + n.taskId}>
                          查看逐目标任务日志
                        </a>
                      )}
                    </div>
                    {item.definition && (
                      <RunNodeRecovery
                        project={project}
                        node={n}
                        flow={item.definition}
                        scope={scope}
                        version={item.version}
                        nodeHref={nodeHref}
                        canRepair={canCancel}
                        canReplan={
                          canCancel &&
                          failedRunStatus(item.status) &&
                          item.status !== 'NEEDS_ATTENTION' &&
                          releaseChecks.length === 0
                        }
                      />
                    )}
                    <ExecutionGraphNodeLogs
                      key={`${path}/${n.nodeId}`}
                      path={`${path}/nodes/${encodeURIComponent(n.nodeId)}/logs`}
                      status={n.status}
                      legacy={n.log}
                    />
                    <FieldEvidenceList
                      title="节点输入"
                      fields={n.inputs}
                      expanded
                      repositoryName={releaseContext.repositoryName}
                      nameSource={(id) => item.nodes.find(({ nodeId }) => id === nodeId)?.name}
                      linkSource={(source) =>
                        source.nodeId
                          ? '#' +
                            graphWorkbenchPath(projectId, {
                              ...scope,
                              pane: 'published',
                              version: item.version,
                              node: source.nodeId,
                              field: source.fieldId,
                              flow: item.flowId,
                            })
                          : undefined
                      }
                    />
                    {n.checkout && (
                      <p className="field-note">
                        检出版本来源 · {sourceName(n.checkout.versionSource)}
                        {n.checkout.requestedVersion && (
                          <>
                            {' '}
                            · <code>{n.checkout.requestedVersion.value}</code>
                          </>
                        )}
                        {n.checkout.triggerCommitSha && (
                          <>
                            {' '}
                            · 事件提交 <code>{n.checkout.triggerCommitSha}</code>
                          </>
                        )}
                      </p>
                    )}
                    {nodeDefinition && n.type !== 'START' && n.type !== 'END' && (
                      <details className="graph-field-card">
                        <summary>执行配置</summary>
                        <ConfiguredNodeExecution node={nodeDefinition} flow={item.definition} />
                      </details>
                    )}
                    <GraphRunResults
                      values={n.output}
                      omit={[
                        ...(n.output?.scope ? ['scope', 'scopeHash', 'review', 'actorId'] : []),
                        ...(isReleaseNode(n) || n.type === 'HEALTH_CHECK' ? ['release'] : []),
                      ]}
                      title="节点输出"
                      expanded
                      artifactContext={{ projectId, scope: deliveryScope }}
                      labels={Object.fromEntries(
                        (
                          item.definition?.nodes.find(({ id }) => id === n.nodeId)?.outputs ?? []
                        ).map(({ id, name }) => [id, name]),
                      )}
                    />
                    <FieldEvidenceList
                      title="实际注入的环境绑定"
                      fields={n.environment}
                      expanded
                      nameSource={(id) => item.nodes.find(({ nodeId }) => id === nodeId)?.name}
                    />
                    <FieldEvidenceList
                      title="最终输出来源"
                      fields={n.outputFields}
                      expanded
                      repositoryName={releaseContext.repositoryName}
                      nameSource={(id) => item.nodes.find(({ nodeId }) => id === nodeId)?.name}
                      linkSource={(source) =>
                        source.nodeId
                          ? '#' +
                            graphWorkbenchPath(projectId, {
                              ...scope,
                              pane: 'published',
                              version: item.version,
                              node: source.nodeId,
                              field: source.fieldId,
                              flow: item.flowId,
                            })
                          : undefined
                      }
                    />
                    {!!n.variableSources?.length && (
                      <details className="graph-field-card">
                        <summary>环境变量来源 · {n.variableSources.length} 项</summary>
                        <dl className="graph-field-values">
                          {n.variableSources.map(({ key, source, isSecret, overriddenSources }) => (
                            <div key={key}>
                              <dt>
                                <code>{key}</code>
                              </dt>
                              <dd>
                                {sourceName(source)}
                                {isSecret && ' · 敏感引用'}
                                {!!overriddenSources?.length && (
                                  <small>覆盖 {overriddenSources.map(sourceName).join('、')}</small>
                                )}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                    )}
                    {n.type === 'DELAY' && n.status === 'WAITING' && n.output?.wakeAt && (
                      <p>计划恢复 · {formatTime(n.output.wakeAt)}</p>
                    )}
                    {(n.type === 'APPROVAL' || n.type === 'SOURCE_REVIEW') && (
                      <GraphApprovalActions
                        node={n}
                        path={path}
                        canApprove={canApprove}
                        context={releaseContext}
                        onChange={() => {
                          void run.reload();
                          onChange();
                        }}
                      />
                    )}
                    {(isReleaseNode(n) || n.type === 'HEALTH_CHECK') && (
                      <ExecutionGraphReleaseResults
                        value={n.output?.release}
                        type={n.type}
                        context={releaseContext}
                        serverName={(id) =>
                          n.targets?.find(({ serverId }) => id === serverId)?.serverName
                        }
                      />
                    )}
                    {!!n.targets?.length && (
                      <details
                        className="graph-field-card"
                        open={n.targets.some(
                          (target) =>
                            failedRunStatus(target.status) || needsReleaseInspection(n, target),
                        )}
                      >
                        <summary>逐目标执行 · {n.targets.length} 项</summary>
                        <ul className="graph-edge-list graph-run-targets">
                          {n.targets.map((target) => (
                            <li key={target.serverId}>
                              <div>
                                <a
                                  className="text-link"
                                  href={serverResourceHref({
                                    serverId: target.serverId,
                                    projectId,
                                    returnPath: releaseContext.returnPath,
                                  })}
                                >
                                  {target.serverName ?? target.serverId}
                                </a>{' '}
                                <Status value={target.status} />
                                {target.exitCode != null && <small>退出码 {target.exitCode}</small>}
                                {target.startedAt && (
                                  <small>开始 {formatTime(target.startedAt)}</small>
                                )}
                                {target.finishedAt && (
                                  <small>结束 {formatTime(target.finishedAt)}</small>
                                )}
                              </div>
                              {target.errorSummary && (
                                <p className="error-text graph-target-error">
                                  {target.errorSummary}
                                </p>
                              )}
                              {needsReleaseInspection(n, target) && (
                                <ExecutionGraphReleaseInspection
                                  context={releaseContext}
                                  path={`${path}/nodes/${encodeURIComponent(n.nodeId)}/targets/${encodeURIComponent(target.serverId)}/inspect-release`}
                                  latest={target.inspection}
                                  canInspect={canInspect}
                                  replanHref={
                                    canInspect &&
                                    failedRunStatus(item.status) &&
                                    releaseChecks.every(({ inspection }) => inspection?.canReplan)
                                      ? '#' +
                                        graphWorkbenchPath(projectId, {
                                          ...scope,
                                          start: item.flowId,
                                          version: item.version,
                                        })
                                      : undefined
                                  }
                                  onChange={() => void run.reload()}
                                />
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {n.childRunId && (
                      <a
                        className="text-link"
                        href={graphRunHref(projectId, n.childRunId, scope, delivery)}
                      >
                        查看子流运行
                      </a>
                    )}
                  </article>
                </div>
              )}
            </>
          )
        )}
      </div>
      {cancelDialog && item && (
        <Confirm
          title="取消本次执行流运行"
          description={
            active
              ? '等待中的节点将停止，执行中的任务及子流将收到取消请求。'
              : '该运行已结束，可关闭此窗口查看结果。'
          }
          detail={
            <p>
              {item.flowName} · 图版本 v{item.version}
            </p>
          }
          label="确认取消运行"
          busy={cancelling}
          error={cancelError}
          destructive
          onClose={closeCancel}
          onConfirm={() => {
            if (active) void cancel();
            else closeCancel();
          }}
        />
      )}
    </Section>
  );
}

function GraphApprovalActions({
  node,
  path,
  canApprove,
  onChange,
  context,
}: {
  node: RunNode;
  path: string;
  canApprove: boolean;
  onChange: () => void;
  context: ReleaseContext;
}) {
  const [choice, setChoice] = useState<{ decision: 'APPROVE' | 'REJECT'; scopeHash?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const waiting = node.status === 'WAITING';
  const reviewScope = node.output?.scope;
  const scopeHash = node.output?.scopeHash;
  const needsScope = node.type === 'SOURCE_REVIEW' || Boolean(reviewScope || scopeHash);
  const scopeReady = !needsScope || Boolean(reviewScope && scopeHash);
  const current = waiting && scopeReady && choice?.scopeHash === scopeHash;
  const isReview = node.type === 'SOURCE_REVIEW';
  const action = isReview ? '源码审核' : '审批';
  async function decide() {
    if (!current || !choice || busy) return;
    setError('');
    setBusy(true);
    try {
      await post(path + '/nodes/' + encodeURIComponent(node.nodeId) + '/decision', {
        decision: choice.decision,
        expectedScopeHash: choice.scopeHash,
      });
      setChoice(undefined);
      onChange();
    } catch (error) {
      setError(message(error));
      onChange();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {reviewScope && <ExecutionGraphReviewScope review={reviewScope} context={context} />}
      {waiting && node.output?.expiresAt && (
        <p>
          {action}截止 · {formatTime(node.output.expiresAt)}
        </p>
      )}
      {node.output?.decision && (
        <p>
          {node.output.decision === 'APPROVE'
            ? '已批准'
            : node.output.decision === 'REJECT'
              ? '已拒绝'
              : `${action}已超时`}
          {node.output.decidedAt ? ' · ' + formatTime(node.output.decidedAt) : ''}
          {node.output.actorId && (
            <>
              {' '}
              · 操作人 <code>{node.output.actorId}</code>
            </>
          )}
        </p>
      )}
      {canApprove && waiting && (
        <div className="heading-actions">
          <button
            type="button"
            className="button primary small"
            disabled={!scopeReady}
            onClick={() => setChoice({ decision: 'APPROVE', scopeHash })}
          >
            {isReview ? '审核通过' : '批准节点'}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={!scopeReady}
            onClick={() => setChoice({ decision: 'REJECT', scopeHash })}
          >
            拒绝节点
          </button>
        </div>
      )}
      {choice && (
        <Confirm
          title={choice.decision === 'APPROVE' ? `通过${action}` : `拒绝${action}`}
          description={
            !waiting
              ? `${action}已结束。`
              : !current
                ? '确认范围已更新，请关闭窗口以查看最新范围。'
                : choice.decision === 'APPROVE'
                  ? '通过后恢复当前执行流。'
                  : '拒绝后停止当前执行路径。'
          }
          detail={
            current && reviewScope ? (
              <ExecutionGraphReviewScope review={reviewScope} context={context} />
            ) : (
              <p>{node.name}</p>
            )
          }
          label={current ? (choice.decision === 'APPROVE' ? '确认通过' : '确认拒绝') : '关闭'}
          destructive={current && choice.decision === 'REJECT'}
          busy={busy}
          error={error}
          onClose={() => {
            if (!busy) {
              setChoice(undefined);
              setError('');
            }
          }}
          onConfirm={() => {
            if (current) void decide();
            else setChoice(undefined);
          }}
        />
      )}
    </>
  );
}
