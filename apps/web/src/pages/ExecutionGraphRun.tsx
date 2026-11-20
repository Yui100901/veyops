import { useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { formatTime, message, post, useResource } from '../api';
import { Confirm, ErrorBanner, Loading, RefreshButton, Section, Status } from '../components';
import type { DeploymentSelection, ProjectDetail } from '../models';
import { GraphFieldValue } from './ExecutionGraphFields';
import type { FieldScope } from './ExecutionGraphFields';
import { graphKey } from './execution-graph-definition';
import type { GraphNode, GraphFlow, GraphRun } from './execution-graph-definition';
import { deliveryPath } from './delivery-route';

type Inputs = { parameters: Record<string, unknown> };
interface DeliveryPreview {
  nodeId?: string;
  artifactFromNodeId?: string;
  environmentId?: string;
  commitSha?: string;
  serverIds?: string[];
  artifactIds?: string[];
  requireApproval?: boolean;
  requireCodeReview?: boolean;
  possibleArtifacts?: {
    nodeId?: string;
    fieldId?: string;
    commitSha: string;
    artifactIds: string[];
  }[];
  serviceId?: string;
  sourceSnapshot?: {
    id?: string;
    repositoryId: string;
    branch?: string;
    tag?: string;
    commitSha: string;
  }[];
}
interface Preview extends DeliveryPreview {
  configurationHash: string;
  version: number;
  flowId: string;
  parameters?: Record<string, unknown>;
  nodes: { nodeId: string; name: string; type: GraphNode['type']; selected?: boolean }[];
  deliveries?: DeliveryPreview[];
  checkouts?: {
    nodeId: string;
    flowId: string;
    repositoryId: string;
    branch?: string;
    tag?: string;
    commitSha: string;
    fullClone: boolean;
  }[];
  scripts?: {
    nodeId: string;
    flowId: string;
    serverId: string;
    serverName: string;
    environmentId?: string;
    serviceId?: string;
  }[];
}

function Results({
  values,
  labels = {},
  title,
}: {
  values?: Record<string, unknown>;
  labels?: Record<string, string>;
  title: string;
}) {
  const rows = Object.entries(values ?? {}).filter(
    ([name]) =>
      !['decision', 'wakeAt', 'expiresAt', 'decidedAt', 'secretVariables', 'variables'].includes(
        name,
      ),
  );
  if (!rows.length) return null;
  return (
    <details className="graph-field-card">
      <summary>{title}</summary>
      <dl className="graph-field-values">
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{labels[name] ?? name}</dt>
            <dd>
              {typeof value === 'object' ? (
                <pre>{JSON.stringify(value, null, 2)}</pre>
              ) : (
                String(value)
              )}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function ExecutionGraphStart({
  project,
  path,
  version,
  flow,
  onRun,
}: {
  project: ProjectDetail;
  path: string;
  version: number;
  flow: GraphFlow;
  onRun: (id: string) => void;
}) {
  const fields = flow.nodes.find(({ type }) => type === 'START')?.inputs ?? [];
  const [parameters, setParameters] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      fields
        .filter((field) => field.defaultValue !== undefined)
        .map((field) => [field.id, field.defaultValue]),
    ),
  );
  const scopedValue = (type: NonNullable<(typeof fields)[number]>['type']) =>
    parameters[fields.find((field) => field.type === type && !field.multiple)?.id ?? ''];
  const scope: FieldScope = {
    repositoryId: scopedValue('REPOSITORY') as string | undefined,
    environmentId: scopedValue('ENVIRONMENT') as string | undefined,
    serviceId: (scopedValue('SERVICE') as string | undefined) ?? flow.serviceId,
    targets: scopedValue('TARGETS') as DeploymentSelection | undefined,
  };
  const [preview, setPreview] = useState<Preview>();
  const key = useRef('');
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = path + '/flows/' + encodeURIComponent(flow.id);
  async function submit() {
    if (active.current) return;
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
    return {
      parameters: Object.fromEntries(
        Object.entries(parameters).filter(([, value]) => value !== undefined),
      ),
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
        {fields.length ? (
          fields.map((field) => (
            <GraphFieldValue
              key={field.id}
              field={field}
              project={project}
              scope={scope}
              checkRequired
              canRegisterRepository
              value={parameters[field.id]}
              change={(value) =>
                setParameters((current) => {
                  const next = { ...current, [field.id]: value };
                  if (['ENVIRONMENT', 'SERVICE', 'TARGETS'].includes(field.type)) {
                    for (const candidate of fields)
                      if (candidate.type === 'ARTIFACT') delete next[candidate.id];
                  }
                  return next;
                })
              }
            />
          ))
        ) : (
          <p className="field-note">此执行流没有运行输入。</p>
        )}
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
          <Results
            values={preview.parameters}
            labels={Object.fromEntries(fields.map(({ id, name }) => [id, name]))}
            title="已固定的运行输入"
          />
          {preview.checkouts?.map((checkout, index) => (
            <div key={`${checkout.nodeId}:${index}`} className="graph-delivery-preview">
              <p>
                {project.repositories.find(({ id }) => id === checkout.repositoryId)?.name ??
                  checkout.repositoryId}
                {checkout.branch && ' · ' + checkout.branch}
                {checkout.tag && ' · 标签 ' + checkout.tag}
                {' · '}
                {checkout.fullClone ? '完整历史' : '浅拉取'}
              </p>
              <p>
                源码固定提交 · <code>{checkout.commitSha}</code>
              </p>
            </div>
          ))}
          {preview.scripts?.map((script, index) => (
            <p
              key={`${script.flowId}:${script.nodeId}:${index}`}
              className="graph-delivery-preview"
            >
              脚本位置 · {script.serverName || script.serverId || '管理端工作区'}
              {' · '}
              {project.environments.find((env) => env.id === script.environmentId)?.name ??
                '项目公共变量'}
              {script.serviceId &&
                ` · ${project.services.find((service) => service.id === script.serviceId)?.name ?? script.serviceId}`}
            </p>
          ))}
          {(preview.deliveries ?? (preview.serviceId ? [preview] : [])).map((delivery, i) => (
            <div key={`${delivery.nodeId}:${i}`} className="graph-delivery-preview">
              {delivery.serviceId && (
                <p>
                  服务 ·{' '}
                  {project.services.find((s) => s.id === delivery.serviceId)?.name ??
                    delivery.serviceId}
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
                      · {source.branch ?? source.tag} <code>{source.commitSha}</code>
                    </li>
                  ))}
                </ul>
              )}
              {delivery.artifactIds?.length ? (
                <p>归档产物 · {delivery.artifactIds.join('、')}</p>
              ) : null}
              {delivery.possibleArtifacts?.length ? (
                <ul aria-label="可能使用的产物来源">
                  {delivery.possibleArtifacts.map((candidate, index) => (
                    <li key={index}>
                      {candidate.nodeId
                        ? `${preview.nodes.find((node) => node.nodeId === candidate.nodeId)?.name ?? candidate.nodeId} · ${candidate.fieldId ?? '产物'}`
                        : candidate.artifactIds.join('、')}{' '}
                      <code>{candidate.commitSha}</code>
                    </li>
                  ))}
                </ul>
              ) : delivery.artifactFromNodeId ? (
                <p>归档产物 · 使用本次运行产生的产物</p>
              ) : null}
              {delivery.serverIds?.length ? <TargetNames ids={delivery.serverIds} /> : null}
              {delivery.requireApproval && <p>本次发布需要管理员审批。</p>}
              {delivery.requireCodeReview && <p>已核对产物提交的代码审核记录。</p>}
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

interface RunNode {
  nodeId: string;
  name: string;
  type: string;
  status: string;
  log: string;
  taskId?: string;
  childRunId?: string | null;
  output?: Record<string, unknown> & {
    wakeAt?: number;
    expiresAt?: number;
    decision?: 'APPROVE' | 'REJECT' | 'EXPIRED';
    decidedAt?: number;
  };
}
interface RunDetail extends GraphRun {
  nodes: RunNode[];
  commitSha?: string;
  artifactIds?: string[];
  definition?: GraphFlow;
  trigger?: Record<string, unknown>;
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
              <Results
                values={item.outputs}
                labels={Object.fromEntries(
                  (item.definition?.nodes.find(({ type }) => type === 'END')?.outputs ?? []).map(
                    ({ id, name }) => [id, name],
                  ),
                )}
                title="执行流输出"
              />
              <Results values={item.trigger} title="触发信息" />
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
                    <Results values={n.output} title="节点输出" />
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
          {node.output.decision === 'APPROVE'
            ? '已批准'
            : node.output.decision === 'REJECT'
              ? '已拒绝'
              : '审批已超时'}
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
