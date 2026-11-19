import { useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { formatTime, message, post, useResource } from '../api';
import {
  Confirm,
  ErrorBanner,
  Field,
  Loading,
  RefreshButton,
  Section,
  Status,
} from '../components';
import type { DeploymentSelection, ProjectDetail } from '../models';
import type { Artifact, PipelineDefinition } from './Delivery';
import { isDeployableArtifact } from './Delivery';
import {
  DeploymentSelectionPicker,
  hasDeploymentSelection,
  useDeploymentInventory,
} from './DeploymentSelection';
import { RepositoryBrowser } from './RepositoryBrowser';
import { graphKey, isDeliveryNode, orderedNodes } from './execution-graph-definition';
import type { GraphNode, GraphFlow, GraphRun } from './execution-graph-definition';
import { deliveryPath } from './delivery-route';
import type { PipelineNodeSource } from './pipeline-node-definition';

type Inputs = DeploymentSelection & {
  value?: string;
  environmentId?: string;
  commitSha?: string;
  artifactIds?: string[];
};
interface DeliveryPreview {
  nodeId?: string;
  artifactFromNodeId?: string;
  environmentId?: string;
  commitSha?: string;
  serverIds?: string[];
  artifactIds?: string[];
  requireApproval?: boolean;
  serviceId?: string;
  pipelineVersion?: number;
  sourceSnapshot?: (Omit<PipelineNodeSource, 'id'> & { id?: string })[];
}
interface Preview extends DeliveryPreview {
  configurationHash: string;
  version: number;
  flowId: string;
  nodes: { nodeId: string; name: string; type: GraphNode['type']; selected?: boolean }[];
  deliveries?: DeliveryPreview[];
}

function reachableNodes(root: GraphFlow, flows: GraphFlow[], inputs: Inputs) {
  const visitedFlows = new Set<string>();
  const result: GraphNode[] = [];
  const autoArtifacts = new Set<string>();
  function visit(flow: GraphFlow) {
    if (visitedFlows.has(flow.id)) return;
    visitedFlows.add(flow.id);
    const reachable = new Set(
      flow.nodes.filter((node) => node.type === 'START').map((node) => node.id),
    );
    const ancestors = new Map<string, Set<GraphNode>>();
    for (const node of orderedNodes(flow)) {
      if (!reachable.has(node.id)) continue;
      result.push(node);
      if (node.type === 'FLOW_CALL') {
        const child = flows.find((f) => f.id === node.flowId);
        if (child) visit(child);
      }
      const upstreamBuilds = ancestors.get(node.id) ?? new Set<GraphNode>();
      if (
        node.type === 'DEPLOY_ARTIFACT' &&
        [...upstreamBuilds].filter((build) => build.pipelineId === node.pipelineId).length === 1
      )
        autoArtifacts.add(node.id);
      if (node.type === 'BUILD') upstreamBuilds.add(node);
      const source = node.condition?.key ?? node.switch?.key;
      const value = source === 'commitSha' ? inputs.commitSha?.toLowerCase() : (inputs.value ?? '');
      const matches = (expected: string) =>
        value === (source === 'commitSha' ? expected.toLowerCase() : expected);
      const caseIndex = node.switch?.cases.findIndex(matches) ?? -1;
      const branch = node.switch
        ? caseIndex < 0
          ? 'DEFAULT'
          : `CASE:${caseIndex}`
        : node.condition && (matches(node.condition.value) ? 'TRUE' : 'FALSE');
      for (const edge of flow.edges) {
        if (edge.from !== node.id || (edge.when && edge.when !== branch)) continue;
        reachable.add(edge.to);
        ancestors.set(edge.to, new Set([...(ancestors.get(edge.to) ?? []), ...upstreamBuilds]));
      }
    }
  }
  visit(root);
  return { nodes: result, autoArtifacts };
}

export function ExecutionGraphStart({
  project,
  path,
  version,
  flow,
  flows,
  onRun,
}: {
  project: ProjectDetail;
  path: string;
  version: number;
  flow: GraphFlow;
  flows: GraphFlow[];
  onRun: (id: string) => void;
}) {
  const [inputs, setInputs] = useState<Inputs>({});
  const { nodes, autoArtifacts } = reachableNodes(flow, flows, inputs);
  const actions = nodes.filter(isDeliveryNode);
  const needsValue = nodes.some((n) => (n.condition?.key ?? n.switch?.key) === 'input');
  const needsCommit = nodes.some((n) => (n.condition?.key ?? n.switch?.key) === 'commitSha');
  const build = actions.find((n) => n.type === 'BUILD');
  const deployments = actions.filter((n) => n.type === 'DEPLOY_ARTIFACT');
  const historyRequired = deployments.find((n) => !autoArtifacts.has(n.id));
  const deploy = historyRequired ?? deployments[0];
  const autoOnly =
    deployments.length > 1 &&
    new Set(deployments.map((n) => n.pipelineId)).size > 1 &&
    !historyRequired;
  const [manualTargets, setManualTargets] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const key = useRef('');
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = path + '/flows/' + encodeURIComponent(flow.id);
  async function submit() {
    if (active.current) return;
    if (!preview && actions.length && manualTargets && !hasDeploymentSelection(inputs)) {
      setError('请至少选择一台服务器或一个分组。');
      return;
    }
    if (!preview && historyRequired && !inputs.artifactIds?.length) {
      setError('请选择要部署的归档产物。');
      return;
    }
    active.current = true;
    setBusy(true);
    setError('');
    try {
      if (!preview) {
        const checked = await post<Preview>(base + '/preview', {
          version,
          inputs: runtimeInputs(),
        });
        key.current = graphKey('run');
        setPreview(checked);
      } else {
        const run = await post<GraphRun>(base + '/run', {
          version,
          inputs: runtimeInputs(),
          expectedConfigurationHash: preview.configurationHash,
          idempotencyKey: key.current,
        });
        onRun(run.id);
      }
    } catch (err) {
      setError(message(err));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  function runtimeInputs(): Inputs {
    const { value, commitSha, artifactIds, ...deployment } = inputs;
    return {
      ...(needsValue && { value: value ?? '' }),
      ...((build || needsCommit) && commitSha && { commitSha }),
      ...(deploy && !autoOnly && artifactIds?.length && { artifactIds }),
      ...(actions.length && deployment),
    };
  }
  return (
    <form
      className="graph-run-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>{preview ? '确认执行预览' : '运行参数'}</h3>
      <fieldset disabled={busy || Boolean(preview)} hidden={Boolean(preview)}>
        {needsValue && (
          <Field label="运行参数">
            <input
              maxLength={500}
              value={inputs.value ?? ''}
              onChange={(e) =>
                setInputs({ ...inputs, value: e.target.value, artifactIds: undefined })
              }
              placeholder="用于判断路径，可留空"
            />
          </Field>
        )}
        {!actions.length && needsCommit && (
          <CommitInput inputs={inputs} change={setInputs} required />
        )}
        {autoOnly && <p className="field-note">各部署节点使用各自上游构建产物。</p>}
        {actions.length ? (
          <DeliveryInputs
            key={actions.map((n) => n.id).join(',')}
            build={build}
            deploy={autoOnly ? undefined : deploy}
            upstreamArtifacts={Boolean(deploy && !historyRequired)}
            needsCommit={needsCommit}
            multipleBuilds={actions.filter((n) => n.type === 'BUILD').length > 1}
            project={project}
            inputs={inputs}
            change={setInputs}
            override={manualTargets}
            setOverride={setManualTargets}
          />
        ) : !needsValue && !needsCommit ? (
          <p className="field-note">这条执行流可直接运行，无需选择环境和服务器。</p>
        ) : null}
      </fieldset>
      {preview && (
        <div className="graph-review" aria-label="执行预览">
          <strong>
            {flow.name} · v{preview.version}
          </strong>
          <ul className="graph-edge-list">
            {preview.nodes.map((node) => (
              <li key={node.nodeId}>
                {node.name}
                {node.selected === false && <small> · 跳过</small>}
              </li>
            ))}
          </ul>
          {(preview.deliveries ?? (preview.serviceId ? [preview] : [])).map((delivery, i) => (
            <div key={delivery.nodeId ?? i} className="graph-delivery-preview">
              {delivery.serviceId && (
                <p>
                  服务 ·{' '}
                  {project.services.find((s) => s.id === delivery.serviceId)?.name ??
                    delivery.serviceId}{' '}
                  · 流水线 v{delivery.pipelineVersion}
                </p>
              )}
              {delivery.environmentId && (
                <p>
                  环境 ·{' '}
                  {project.environments.find((e) => e.id === delivery.environmentId)?.name ??
                    delivery.environmentId}
                </p>
              )}
              {delivery.commitSha && (
                <p>
                  固定提交 · <code>{delivery.commitSha}</code>
                </p>
              )}
              {delivery.sourceSnapshot && delivery.sourceSnapshot.length > 1 && (
                <ul>
                  {delivery.sourceSnapshot.map((source) => (
                    <li key={source.id ?? source.repositoryId}>
                      {project.repositories.find((r) => r.id === source.repositoryId)?.name ??
                        source.repositoryId}{' '}
                      · {source.branch} <code>{source.commitSha}</code>
                    </li>
                  ))}
                </ul>
              )}
              {delivery.artifactIds?.length ? (
                <p>归档产物 · {delivery.artifactIds.join('、')}</p>
              ) : null}
              {delivery.artifactFromNodeId && <p>归档产物 · 使用上游构建节点的产物</p>}
              {delivery.serverIds?.length ? <TargetNames ids={delivery.serverIds} /> : null}
              {delivery.requireApproval && <p>本次发布需要管理员审批。</p>}
            </div>
          ))}
        </div>
      )}
      <ErrorBanner error={error} />
      <div className="heading-actions">
        {preview && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setPreview(undefined);
              setError('');
            }}
          >
            返回修改参数
          </button>
        )}
        <button type="submit" className="button primary" disabled={busy}>
          <Play size={15} />
          {busy ? '处理中…' : preview ? '确认启动' : '预览运行'}
        </button>
      </div>
    </form>
  );
}

function TargetNames({ ids }: { ids: string[] }) {
  const servers = useResource<{ id: string; name: string }[]>('/servers');
  return (
    <p>
      目标服务器 · {ids.map((id) => servers.data?.find((s) => s.id === id)?.name ?? id).join('、')}
    </p>
  );
}

function DeliveryInputs({
  build,
  deploy,
  upstreamArtifacts,
  needsCommit,
  multipleBuilds,
  project,
  inputs,
  change,
  override,
  setOverride,
}: {
  build?: GraphNode;
  deploy?: GraphNode;
  upstreamArtifacts: boolean;
  needsCommit: boolean;
  multipleBuilds: boolean;
  project: ProjectDetail;
  inputs: Inputs;
  change: (v: Inputs) => void;
  override: boolean;
  setOverride: (v: boolean) => void;
}) {
  const versions = useResource<{ version: number; definition: PipelineDefinition }[]>(
    build?.pipelineId ? '/pipelines/' + build.pipelineId + '/versions' : null,
  );
  const definition = versions.data?.find((v) => v.version === build?.pipelineVersion)?.definition;
  const primary = definition?.nodes?.[0];
  const branch = primary?.environmentBranches?.[inputs.environmentId ?? ''] || primary?.branch;
  const repo = project.repositories.find((r) => r.id === definition?.repositoryId);
  const inventory = useDeploymentInventory();
  const [browse, setBrowse] = useState(false);
  const environmentId = inputs.environmentId ?? '';
  return (
    <>
      <ErrorBanner error={versions.error} />
      <Field label="运行环境">
        <select
          required
          value={environmentId}
          onChange={(e) =>
            change({ ...inputs, environmentId: e.target.value, artifactIds: undefined })
          }
        >
          <option value="">选择环境</option>
          {project.environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Field>
      {(build || needsCommit) &&
        (branch && !needsCommit && !multipleBuilds ? (
          <p className="field-note">预览将解析 {branch} 的最新提交。</p>
        ) : (
          <>
            <CommitInput
              inputs={inputs}
              change={change}
              required={needsCommit || (!branch && !multipleBuilds)}
            />
            {repo && !multipleBuilds && (
              <>
                <button
                  type="button"
                  className="button secondary compact"
                  onClick={() => setBrowse(!browse)}
                >
                  {browse ? '收起提交列表' : '选择仓库提交'}
                </button>
                {browse && (
                  <RepositoryBrowser
                    projectId={project.id}
                    repository={repo}
                    selectedSha={inputs.commitSha}
                    onSelect={(commit) => {
                      change({ ...inputs, commitSha: commit.sha });
                      setBrowse(false);
                    }}
                  />
                )}
              </>
            )}
          </>
        ))}
      {deploy && environmentId && (
        <>
          {upstreamArtifacts && <p className="field-note">留空时使用上游同一流水线的构建产物。</p>}
          <HistoryArtifacts
            key={environmentId}
            projectId={project.id}
            environmentId={environmentId}
            node={deploy}
            selected={inputs.artifactIds ?? []}
            onSelect={(ids) => change({ ...inputs, artifactIds: ids })}
          />
        </>
      )}
      <Field label="目标来源">
        <select
          value={override ? 'select' : 'env'}
          onChange={(e) => {
            setOverride(e.target.value === 'select');
            change({
              value: inputs.value,
              environmentId,
              commitSha: inputs.commitSha,
              artifactIds: inputs.artifactIds,
            });
          }}
        >
          <option value="env">沿用服务环境目标</option>
          <option value="select">指定服务器或服务器组</option>
        </select>
      </Field>
      {override && (
        <DeploymentSelectionPicker
          projectId={project.id}
          inventory={inventory}
          value={inputs}
          onChange={(v) => change({ ...inputs, ...v })}
        />
      )}
    </>
  );
}

function CommitInput({
  inputs,
  change,
  required,
}: {
  inputs: Inputs;
  change: (v: Inputs) => void;
  required: boolean;
}) {
  return (
    <Field label="提交 SHA">
      <input
        pattern="([a-fA-F0-9]{40}|[a-fA-F0-9]{64})"
        required={required}
        value={inputs.commitSha ?? ''}
        placeholder="输入完整 SHA"
        onChange={(e) => change({ ...inputs, commitSha: e.target.value.trim() })}
      />
    </Field>
  );
}

function HistoryArtifacts({
  projectId,
  environmentId,
  node,
  selected,
  onSelect,
}: {
  projectId: string;
  environmentId: string;
  node: GraphNode;
  selected: string[];
  onSelect: (ids: string[]) => void;
}) {
  const resource = useResource<Artifact[]>(
    `/artifacts?projectId=${projectId}&environmentId=${environmentId}`,
  );
  const artifacts = (resource.data ?? [])
    .filter(isDeployableArtifact)
    .filter((a) => a.pipelineId === node.pipelineId);
  const runId = artifacts.find((a) => selected.includes(a.id))?.pipelineRunId;
  return (
    <fieldset className="graph-artifacts">
      <legend>选择同一次构建的归档产物</legend>
      <ErrorBanner error={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : !artifacts.length ? (
        <p className="field-note">这个环境尚无该流水线可部署的归档。</p>
      ) : (
        artifacts.map((a) => (
          <label className="checkbox-row" key={a.id}>
            <input
              type="checkbox"
              disabled={Boolean(runId && runId !== a.pipelineRunId)}
              checked={selected.includes(a.id)}
              onChange={(e) =>
                onSelect(
                  e.target.checked ? [...selected, a.id] : selected.filter((id) => id !== a.id),
                )
              }
            />
            <span>
              {formatTime(a.createdAt)} · {a.artifactType} · {a.sourceCommit?.slice(0, 12)}
              <small className="cell-detail">
                {a.id}
                {a.serverId && ' · 服务器 ' + a.serverId}
              </small>
            </span>
          </label>
        ))
      )}
    </fieldset>
  );
}

interface RunNode {
  nodeId: string;
  name: string;
  type: string;
  status: string;
  log: string;
  taskId?: string;
  childRunId?: string | null;
  output?: {
    wakeAt?: number;
    expiresAt?: number;
    decision?: 'APPROVE' | 'REJECT';
    decidedAt?: number;
  };
}
interface RunDetail extends GraphRun {
  nodes: RunNode[];
  commitSha?: string;
  artifactIds?: string[];
}

export function ExecutionGraphHistory({
  path,
  projectId,
  canCancel,
  canApprove,
  selected,
  onSelect,
}: {
  path: string;
  projectId: string;
  canCancel: boolean;
  canApprove: boolean;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1);
  const list = useResource<GraphRun[]>(
    path + '/runs' + (before ? '?before=' + encodeURIComponent(before) : ''),
    5000,
  );
  const lastRunId = list.data?.at(-1)?.id;
  return (
    <>
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
          <div className="mini-empty">
            {before ? '没有更早的运行记录。' : '尚无执行流运行记录。'}
          </div>
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
      {selected && (
        <RunDetails
          key={selected}
          path={path + '/runs/' + encodeURIComponent(selected)}
          projectId={projectId}
          canCancel={canCancel}
          canApprove={canApprove}
          onChange={list.reload}
        />
      )}
    </>
  );
}

function RunDetails({
  path,
  projectId,
  canCancel,
  canApprove,
  onChange,
}: {
  path: string;
  projectId: string;
  canCancel: boolean;
  canApprove: boolean;
  onChange: () => void;
}) {
  const run = useResource<RunDetail>(path, 3000);
  const [cancelDialog, setCancelDialog] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const item = run.data;
  const active = ['PENDING', 'QUEUED', 'WAITING', 'RUNNING'].includes(item?.status ?? '');
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
      action={
        canCancel &&
        active && (
          <button
            type="button"
            className="button secondary small"
            onClick={() => setCancelDialog(true)}
          >
            取消运行
          </button>
        )
      }
    >
      <div className="graph-fields">
        <ErrorBanner error={run.error} retry={run.reload} />
        {run.loading ? (
          <Loading />
        ) : (
          item && (
            <>
              <div className="heading-actions">
                <strong>
                  {item.flowName} · 图版本 v{item.version}
                </strong>
                <Status value={item.status} />
              </div>
              <small>
                {formatTime(item.createdAt)} · {item.id}
              </small>
              {item.parentRunId && (
                <a
                  className="text-link"
                  href={`#/projects/${projectId}/execution-graph?run=${item.parentRunId}`}
                >
                  返回父运行
                </a>
              )}
              {item.commitSha && (
                <p>
                  源码提交 · <code>{item.commitSha}</code>
                </p>
              )}
              {item.artifactIds?.length ? (
                <div className="heading-actions">
                  {item.artifactIds.map((id) => (
                    <a
                      key={id}
                      className="text-link"
                      href={'#' + deliveryPath(projectId, 'artifacts', { recordId: id })}
                    >
                      查看产物 {id.slice(0, 8)}
                    </a>
                  ))}
                </div>
              ) : null}
              <ol className="graph-logs">
                {item.nodes.map((n) => (
                  <li key={n.nodeId}>
                    <div className="heading-actions">
                      <strong>{n.name}</strong>
                      <Status value={n.status} />
                    </div>
                    {n.log && <pre>{n.log}</pre>}
                    {n.type === 'DELAY' && n.status === 'WAITING' && n.output?.wakeAt && (
                      <p>计划恢复 · {formatTime(n.output.wakeAt)}</p>
                    )}
                    {n.type === 'APPROVAL' && (
                      <GraphApprovalActions
                        node={n}
                        path={path}
                        canApprove={canApprove}
                        onChange={() => {
                          void run.reload();
                          onChange();
                        }}
                      />
                    )}
                    {n.taskId && (
                      <a className="text-link" href={'#/tasks/' + n.taskId}>
                        查看逐目标任务日志
                      </a>
                    )}
                    {n.childRunId && (
                      <a
                        className="text-link"
                        href={`#/projects/${projectId}/execution-graph?run=${n.childRunId}`}
                      >
                        查看子流运行
                      </a>
                    )}
                  </li>
                ))}
              </ol>
              <a
                className="text-link"
                href={`#/projects/${projectId}/execution-graph?run=${item.id}`}
              >
                本次运行的固定链接
              </a>
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
}: {
  node: RunNode;
  path: string;
  canApprove: boolean;
  onChange: () => void;
}) {
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const waiting = node.status === 'WAITING';
  async function decide() {
    if (!waiting || !decision || busy) return;
    setError('');
    setBusy(true);
    try {
      await post(path + '/nodes/' + encodeURIComponent(node.nodeId) + '/decision', { decision });
      setDecision(undefined);
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
      {waiting && node.output?.expiresAt && <p>审批截止 · {formatTime(node.output.expiresAt)}</p>}
      {node.output?.decision && (
        <p>
          {node.output.decision === 'APPROVE' ? '已批准' : '已拒绝'}
          {node.output.decidedAt ? ' · ' + formatTime(node.output.decidedAt) : ''}
        </p>
      )}
      {canApprove && waiting && (
        <div className="heading-actions">
          <button
            type="button"
            className="button primary small"
            onClick={() => setDecision('APPROVE')}
          >
            批准节点
          </button>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setDecision('REJECT')}
          >
            拒绝节点
          </button>
        </div>
      )}
      {decision && (
        <Confirm
          title={decision === 'APPROVE' ? '批准审批节点' : '拒绝审批节点'}
          description={
            !waiting
              ? '审批已结束。'
              : decision === 'APPROVE'
                ? '批准后恢复当前执行流。'
                : '拒绝后停止当前执行路径。'
          }
          detail={<p>{node.name}</p>}
          label={waiting ? (decision === 'APPROVE' ? '确认批准' : '确认拒绝') : '关闭'}
          destructive={waiting && decision === 'REJECT'}
          busy={busy}
          error={error}
          onClose={() => {
            if (!busy) {
              setDecision(undefined);
              setError('');
            }
          }}
          onConfirm={() => {
            if (waiting) void decide();
            else setDecision(undefined);
          }}
        />
      )}
    </>
  );
}
