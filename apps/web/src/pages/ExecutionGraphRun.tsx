import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Play } from 'lucide-react';
import { ApiError, formatTime, message, post, useResource, type ExecutionPlanIssue } from '../api';
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
import { NodeMap } from './ExecutionGraphCanvas';
import { GraphFieldValue, useProjectEnvironmentSets } from './ExecutionGraphFields';
import type { FieldScope } from './ExecutionGraphFields';
import { ConfiguredNodeExecution, showSelectedNode } from './ExecutionGraphNodeDetails';
import {
  ExecutionPlan,
  ExecutionPlanChanges,
  FieldEvidenceList,
  sourceName,
} from './ExecutionGraphPreview';
import type { Preview } from './ExecutionGraphPreview';
import {
  ExecutionGraphParameterLink,
  ExecutionGraphRepairLinks,
  type GraphSetupIssue,
} from './ExecutionGraphRepairLinks';
import { ExecutionGraphStartStatus } from './ExecutionGraphStartStatus';
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
  graphKey,
  graphNodeLabels,
  graphNodeTypeLabel,
  isReleaseNode,
} from './execution-graph-definition';
import type {
  GraphEnvironmentSetSummary,
  GraphBinding,
  GraphField,
  GraphFieldEvidence,
  GraphFlow,
  GraphRun,
} from './execution-graph-definition';
import { deliveryPath, deliveryTabs, type DeliveryScope } from './delivery-route';
import { projectGraphPath, projectResourcePath } from './project-workspace-route';
import { serverResourceHref } from './server-resource-route';
import {
  graphRunHref,
  graphStartReadiness,
  graphWorkbenchPath,
  type GraphDeliveryReturn,
  type GraphWorkbenchScope,
} from './graph-workbench-context';

type Inputs = { parameters: Record<string, unknown> };
type ParameterEdits = Record<string, { schema: string; value: unknown }>;
export type GraphRunDrafts = Map<string, ParameterEdits>;

function parameterSchema(field: GraphField) {
  return JSON.stringify([
    field.type,
    field.multiple,
    field.artifactType,
    field.source,
    field.options,
  ]);
}

function focusRunField(field: HTMLElement | undefined) {
  if (!field) return;
  const input = field.querySelector<HTMLElement>(
    'select:enabled, input:enabled:not([type="hidden"]), textarea:enabled, button:enabled',
  );
  field.scrollIntoView({ block: 'center' });
  (input ?? field).focus({ preventScroll: true });
}

function repairKind(code: ExecutionPlanIssue['code']): GraphSetupIssue['kind'] | undefined {
  if (code === 'RELEASE_TARGET') return 'DEPLOY_TARGET';
  if (code === 'REPOSITORY' || code === 'BUILD_TARGET' || code === 'ARTIFACT') return code;
}

const planIssueLabels: Record<ExecutionPlanIssue['code'], string> = {
  INPUT: '运行参数有待处理',
  REPOSITORY: '仓库有待处理',
  BUILD_TARGET: '构建目标有待处理',
  RELEASE_TARGET: '发布目标有待处理',
  ARTIFACT: '产物有待处理',
  SOURCE_REVIEW: '源码审核有待处理',
  CONFIGURATION: '执行配置有待处理',
};

function serviceReferenceId(value: unknown) {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    'serviceId' in value &&
    typeof value.serviceId === 'string'
  )
    return value.serviceId;
}

function referencesInput(binding: GraphBinding | undefined, id: string): boolean {
  if (binding?.kind === 'INPUT') return binding.fieldId === id;
  return (
    binding?.kind === 'FIRST_AVAILABLE' &&
    binding.sources.some((source) => referencesInput(source, id))
  );
}

function staticBinding(
  binding: GraphBinding | undefined,
  parameters: Record<string, unknown>,
): unknown {
  if (binding?.kind === 'VALUE') return binding.value;
  if (binding?.kind === 'INPUT') return parameters[binding.fieldId];
  return undefined;
}

function artifactFieldScope(
  field: GraphField,
  flow: GraphFlow,
  parameters: Record<string, unknown>,
  general: FieldScope,
): FieldScope {
  if (field.type !== 'ARTIFACT') return general;
  const consumer = flow.nodes.find(
    (node) =>
      isReleaseNode(node) && referencesInput(flow.inputBindings?.[node.id]?.artifact, field.id),
  );
  if (!consumer) return general;
  const bindings = flow.inputBindings?.[consumer.id];
  const targets = staticBinding(bindings?.targets, parameters);
  const serviceId = serviceReferenceId(staticBinding(bindings?.service, parameters));
  return {
    ...general,
    deliveryMethod: consumer.deploy?.method,
    serviceId: serviceId ?? general.serviceId,
    targets:
      (targets && typeof targets === 'object' ? (targets as DeploymentSelection) : undefined) ??
      general.targets,
  };
}

function artifactOutput(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  if ('temporaryArtifactId' in value && typeof value.temporaryArtifactId === 'string')
    return { id: value.temporaryArtifactId, label: '查看临时产物', temporary: true };
  if ('artifactId' in value && typeof value.artifactId === 'string')
    return {
      id: value.artifactId,
      label: 'name' in value && typeof value.name === 'string' ? value.name : '查看产物',
      temporary: false,
    };
  return undefined;
}

function PlanIssueBanner({
  issue,
  flow,
  project,
}: {
  issue: ExecutionPlanIssue;
  flow: GraphFlow;
  project: ProjectDetail;
}) {
  const currentFlow = !issue.flowId || issue.flowId === flow.id;
  const node = currentFlow ? flow.nodes.find(({ id }) => id === issue.nodeId) : undefined;
  const field = node?.inputs?.find(({ id }) => id === issue.fieldId)?.name;
  const location = [
    issue.flowName ?? (issue.flowId ? (currentFlow ? flow.name : issue.flowId) : undefined),
    issue.nodeName ?? node?.name ?? issue.nodeId,
    issue.fieldName ?? field ?? issue.fieldId,
  ]
    .filter(Boolean)
    .join(' / ');
  const repository =
    project.repositories.find(({ id }) => id === issue.repositoryId)?.name ?? issue.repositoryId;
  return (
    <div className="error-banner graph-plan-issue" role="alert">
      <AlertCircle size={17} aria-hidden="true" />
      <div>
        <strong>{planIssueLabels[issue.code]}</strong>
        {location && <p>{location}</p>}
        <p>{issue.message}</p>
        {issue.branchId && <p>分支 · {issue.branchId}</p>}
        {(repository || issue.commitSha) && (
          <p>
            {repository}
            {repository && issue.commitSha && ' · '}
            {issue.commitSha && <code>{issue.commitSha}</code>}
          </p>
        )}
      </div>
    </div>
  );
}

function Results({
  values,
  labels = {},
  omit = [],
  title,
  expanded,
  artifactContext,
}: {
  values?: Record<string, unknown>;
  labels?: Record<string, string>;
  omit?: string[];
  title: string;
  expanded?: boolean;
  artifactContext?: { projectId: string; scope: DeliveryScope };
}) {
  const rows = Object.entries(values ?? {}).filter(
    ([name]) =>
      ![
        ...omit,
        'decision',
        'wakeAt',
        'expiresAt',
        'decidedAt',
        'secretVariables',
        'secretCredentialNonces',
        'variables',
      ].includes(name),
  );
  if (!rows.length) return null;
  return (
    <details className="graph-field-card" open={expanded}>
      <summary>{title}</summary>
      <dl className="graph-field-values">
        {rows.map(([name, value]) => {
          const references = (Array.isArray(value) ? value : [value]).map(artifactOutput);
          return (
            <div key={name}>
              <dt>{labels[name] ?? name}</dt>
              <dd>
                {artifactContext && references.length > 0 && references.every(Boolean) ? (
                  <div className="heading-actions">
                    {references.map(
                      (reference, index) =>
                        reference && (
                          <a
                            className="button secondary small"
                            key={reference.id + ':' + index}
                            href={
                              '#' +
                              deliveryPath(artifactContext.projectId, 'artifacts', {
                                ...artifactContext.scope,
                                recordId: reference.id,
                              })
                            }
                          >
                            {reference.label}
                            {reference.temporary && <span className="tag">临时</span>}
                          </a>
                        ),
                    )}
                  </div>
                ) : typeof value === 'object' ? (
                  <pre>{JSON.stringify(value, null, 2)}</pre>
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </details>
  );
}

export function ExecutionGraphStart({
  project,
  path,
  version,
  flow,
  initialInputs,
  workbenchScope,
  drafts,
  focusFieldId,
  onRun,
}: {
  project: ProjectDetail;
  path: string;
  version: number;
  flow: GraphFlow;
  initialInputs?: Record<string, string>;
  workbenchScope: GraphWorkbenchScope;
  drafts?: GraphRunDrafts;
  focusFieldId?: string;
  onRun: (id: string) => void;
}) {
  const startNode = flow.nodes.find(({ type }) => type === 'START');
  const setConfiguration = startNode?.environmentSet;
  const fixedSetId =
    setConfiguration?.mode === 'FIXED' ? setConfiguration.environmentSetId : undefined;
  const fixedSets = useProjectEnvironmentSets(project.id, !!fixedSetId);
  const fixedSet = fixedSets.data?.find(({ id }) => id === fixedSetId);
  const fields = startNode?.inputs ?? [];
  const draftKey = JSON.stringify([
    flow.id,
    workbenchScope.serviceId,
    workbenchScope.environmentId,
  ]);
  const [edits, setEdits] = useState<ParameterEdits>(() => drafts?.get(draftKey) ?? {});
  const parameters: Record<string, unknown> = {
    ...Object.fromEntries(
      fields.map((field) => {
        const edit = Object.hasOwn(edits, field.id) ? edits[field.id] : undefined;
        return [
          field.id,
          edit?.schema === parameterSchema(field) ? edit.value : field.defaultValue,
        ];
      }),
    ),
    ...initialInputs,
  };
  const readiness = graphStartReadiness(flow, workbenchScope, project, parameters);
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const scopedValue = (type: NonNullable<(typeof fields)[number]>['type']) => {
    const candidates = fields.filter((field) => field.type === type && !field.multiple);
    const field =
      candidates.find(({ id }) => initialInputs && Object.hasOwn(initialInputs, id)) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    return field ? parameters[field.id] : undefined;
  };
  const scope: FieldScope = {
    repositoryId: scopedValue('REPOSITORY') as string | undefined,
    environmentId: scopedValue('ENVIRONMENT') as string | undefined,
    serviceId: flow.serviceId ?? serviceReferenceId(scopedValue('SERVICE')),
    targets: scopedValue('TARGETS') as DeploymentSelection | undefined,
  };
  const [preview, setPreview] = useState<Preview>();
  const [revision, setRevision] = useState<{ previous: Preview; sections: string[] }>();
  const key = useRef('');
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [planIssue, setPlanIssue] = useState<ExecutionPlanIssue>();
  const issueParameter =
    planIssue && (!planIssue.flowId || planIssue.flowId === flow.id)
      ? (planIssue.parameterId ??
        (planIssue.nodeId === startNode?.id ? planIssue.fieldId : undefined))
      : undefined;
  const issueKind = planIssue && repairKind(planIssue.code);
  const runLocation = { ...workbenchScope, start: flow.id, version, field: focusFieldId };
  useEffect(() => {
    if (!focusFieldId) return;
    setPreview(undefined);
    setRevision(undefined);
    const frame = window.requestAnimationFrame(() =>
      focusRunField(fieldRefs.current.get(focusFieldId)),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [focusFieldId]);
  const base = path + '/flows/' + encodeURIComponent(flow.id);
  async function submit() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    setPlanIssue(undefined);
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
          expectedPlanSections: preview.planSections,
          idempotencyKey: key.current,
        });
        drafts?.delete(draftKey);
        onRun(run.id);
      }
    } catch (err) {
      const apiError = err instanceof ApiError ? err : undefined;
      if (apiError?.planIssue) {
        setPlanIssue(apiError.planIssue);
        setPreview(undefined);
        setRevision(undefined);
      } else {
        setError(message(err));
        if (preview && apiError && [400, 409].includes(apiError.status)) {
          setRevision({ previous: preview, sections: apiError.changes });
          setPreview(undefined);
        }
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  function runtimeInputs(): Inputs {
    return {
      parameters: Object.fromEntries(
        fields.flatMap((field) => {
          const value = parameters[field.id];
          if (value === undefined) return [];
          const serviceValue = (item: unknown) =>
            typeof item === 'string' ? { serviceId: item } : item;
          const serialized =
            field.type === 'SERVICE'
              ? Array.isArray(value)
                ? value.map(serviceValue)
                : serviceValue(value)
              : value;
          return [[field.id, serialized]];
        }),
      ),
    };
  }
  function updateParameter(field: GraphField, value: unknown) {
    const next = {
      ...(drafts?.get(draftKey) ?? edits),
      [field.id]: { schema: parameterSchema(field), value },
    };
    if (field.type === 'SERVICE') {
      for (const candidate of fields) {
        if (candidate.type === 'ARTIFACT') {
          next[candidate.id] = { schema: parameterSchema(candidate), value: undefined };
        }
      }
    }
    drafts?.set(draftKey, next);
    setEdits(next);
    if (planIssue) {
      setPlanIssue(undefined);
      setError('');
    }
  }
  function openParameter(fieldId: string) {
    setPreview(undefined);
    setRevision(undefined);
    window.requestAnimationFrame(() => focusRunField(fieldRefs.current.get(fieldId)));
  }
  return (
    <form
      className="graph-run-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>{preview ? '确认执行预览' : revision ? '预览已失效' : '运行参数'}</h3>
      {!preview && !revision && (
        <ExecutionGraphStartStatus
          readiness={readiness}
          flow={flow}
          project={project}
          repairStart={runLocation}
          onFocusParameter={openParameter}
        />
      )}
      {initialInputs && Object.keys(initialInputs).length > 0 && (
        <p className="field-note">已填入当前入口传来的参数。</p>
      )}
      <fieldset
        disabled={busy || Boolean(preview || revision)}
        hidden={Boolean(preview || revision)}
      >
        {fixedSetId && (
          <p className="field-note">
            固定变量集合 ·{' '}
            <a
              className="text-link"
              href={
                '#' +
                projectResourcePath(project.id, {
                  resource: 'environment-sets',
                  environmentSetId: fixedSetId,
                  view: workbenchScope.view,
                })
              }
            >
              {fixedSet?.name ?? (fixedSets.loading ? '正在读取集合' : '集合不可用')}
            </a>
          </p>
        )}
        {fields.length ? (
          fields.map((field) => (
            <div
              key={field.id}
              className="graph-run-field"
              tabIndex={-1}
              ref={(element) => {
                if (element) fieldRefs.current.set(field.id, element);
                else fieldRefs.current.delete(field.id);
              }}
            >
              <GraphFieldValue
                field={field}
                project={project}
                scope={artifactFieldScope(field, flow, parameters, scope)}
                disabled={Boolean(initialInputs && Object.hasOwn(initialInputs, field.id))}
                checkRequired
                canRegisterRepository
                value={parameters[field.id]}
                change={(value) => updateParameter(field, value)}
              />
            </div>
          ))
        ) : (
          <p className="field-note">此执行流没有运行输入。</p>
        )}
      </fieldset>
      {revision && (
        <ExecutionPlanChanges
          previous={revision.previous}
          current={preview}
          sections={revision.sections}
          project={project}
        />
      )}
      {preview && (
        <div className="graph-review" aria-label="执行预览">
          <strong>
            {flow.name} · v{preview.version}
          </strong>
          <ul className="graph-edge-list">
            {preview.nodes.map((node) => (
              <li key={node.nodeId}>
                {node.name}
                {node.selected !== false &&
                  (node.type === 'APPROVAL' || node.type === 'SOURCE_REVIEW') && (
                    <small> · {graphNodeLabels[node.type]}</small>
                  )}
                {node.selected === false && <small> · 跳过</small>}
              </li>
            ))}
          </ul>
          <Results
            values={Object.fromEntries(
              fields
                .filter(
                  ({ type, id }) =>
                    !['VARIABLES', 'CREDENTIAL'].includes(type) &&
                    preview.parameters?.[id] !== undefined,
                )
                .map(({ id }) => [id, preview.parameters?.[id]]),
            )}
            labels={Object.fromEntries(fields.map(({ id, name }) => [id, name]))}
            title="已固定的运行输入"
          />
          <ExecutionPlan
            preview={preview}
            project={project}
            view={workbenchScope.view}
            returnPath={projectGraphPath(project.id, {
              ...workbenchScope,
              start: flow.id,
              pane: 'run',
            })}
          />
        </div>
      )}
      {planIssue ? (
        <PlanIssueBanner issue={planIssue} flow={flow} project={project} />
      ) : (
        <ErrorBanner error={error} />
      )}
      {planIssue && issueKind && (
        <ExecutionGraphRepairLinks
          project={project}
          flow={flow}
          start={runLocation}
          issue={{
            ...planIssue,
            kind: issueKind,
            parameterId: issueParameter,
            serviceId: planIssue.serviceId ?? scope.serviceId,
            environmentId: planIssue.environmentId ?? scope.environmentId,
          }}
          onFocusParameter={openParameter}
        />
      )}
      {planIssue?.code === 'INPUT' &&
        issueParameter &&
        fields.some(({ id }) => id === issueParameter) && (
          <ExecutionGraphParameterLink
            projectId={project.id}
            start={runLocation}
            fieldId={issueParameter}
            label="查看运行参数"
            onFocus={openParameter}
          />
        )}
      <div className="heading-actions">
        {(preview || revision) && (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => {
              setPreview(undefined);
              setRevision(undefined);
              setError('');
              setPlanIssue(undefined);
            }}
          >
            返回修改参数
          </button>
        )}
        <button type="submit" className="button primary" disabled={busy}>
          <Play size={15} />
          {busy ? '处理中…' : preview ? '确认启动' : revision ? '重新预览' : '预览运行'}
        </button>
      </div>
    </form>
  );
}

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
          project={project}
          canCancel={canCancel}
          canApprove={canApprove}
          userId={userId}
          onChange={list.reload}
          scope={scope}
          delivery={delivery}
          selectedNodeId={selectedNodeId}
        />
      )}
    </>
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
  const nodeDetail = useRef<HTMLElement>(null);
  const item = run.data;
  const requestedNode =
    nodeSelection?.linked === selectedNodeId
      ? (nodeSelection?.nodeId ?? selectedNodeId)
      : selectedNodeId;
  const n =
    item?.nodes.find(({ nodeId }) => nodeId === requestedNode) ??
    item?.nodes.find(({ status }) => ['WAITING', 'RUNNING'].includes(status)) ??
    item?.nodes.find(({ status }) => ['FAILED', 'NEEDS_ATTENTION', 'TIMED_OUT'].includes(status)) ??
    item?.nodes[0];
  const nodeDefinition = item?.definition?.nodes.find(({ id }) => id === n?.nodeId);
  const canInspect = canApprove || (canCancel && item?.createdBy === userId);
  const currentRunId = item?.id;
  useEffect(() => {
    if (!currentRunId) return;
    const linked = selectedNodeId && document.getElementById('graph-run-node-' + selectedNodeId);
    (linked || overview.current)?.scrollIntoView({ block: 'nearest' });
  }, [currentRunId, selectedNodeId]);
  const deliveryScope = {
    serviceId: scope.serviceId,
    environmentId: scope.environmentId,
    view: scope.view,
    viewSearch: scope.viewSearch,
  };
  const releaseContext = {
    projectId,
    deliveryScope,
    returnPath: item ? graphRunHref(projectId, item.id, scope, delivery).slice(1) : '',
    nodeHref: (node: string) =>
      '#' +
      graphWorkbenchPath(projectId, {
        ...scope,
        ...delivery,
        pane: 'history',
        run: item?.id,
        node,
      }),
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
  function selectNode(nodeId: string) {
    setNodeSelection({ linked: selectedNodeId, nodeId });
    window.requestAnimationFrame(() => showSelectedNode(nodeDetail.current));
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
              <div className="heading-actions" ref={overview}>
                <strong>
                  {item.flowName} · 图版本 v{item.version}
                </strong>
                <Status value={item.status} />
              </div>
              <small>
                {formatTime(item.createdAt)} · {item.id}
              </small>
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
              <Results
                values={item.outputs}
                labels={Object.fromEntries(
                  (item.definition?.nodes.find(({ type }) => type === 'END')?.outputs ?? []).map(
                    ({ id, name }) => [id, name],
                  ),
                )}
                title="执行流输出"
                artifactContext={{ projectId, scope: deliveryScope }}
              />
              <Results values={item.trigger} title="触发信息" />
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
              {n && (
                <div className="graph-node-layout">
                  <div className="graph-node-location">
                    <Field label="定位节点">
                      <select value={n.nodeId} onChange={(event) => selectNode(event.target.value)}>
                        {item.nodes.map(({ nodeId, name }) => (
                          <option key={nodeId} value={nodeId}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="graph-node-layout-inner">
                    {item.definition ? (
                      <NodeMap flow={item.definition} selected={[n.nodeId]} onSelect={selectNode} />
                    ) : null}
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
                      {n.issue && (
                        <div role="status" className="error-banner">
                          <span>
                            {[
                              n.issue.fieldName ?? n.issue.fieldId,
                              n.issue.branchId,
                              n.issue.message,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          {n.issue.sourceNodeId && (
                            <a
                              className="text-link"
                              href={
                                '#' +
                                graphWorkbenchPath(projectId, {
                                  ...scope,
                                  pane: 'published',
                                  version: item.version,
                                  node: n.issue.sourceNodeId,
                                  field: n.issue.sourceFieldId,
                                  flow: item.flowId,
                                })
                              }
                            >
                              查看来源节点
                            </a>
                          )}
                        </div>
                      )}
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
                      <Results
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
                            {n.variableSources.map(
                              ({ key, source, isSecret, overriddenSources }) => (
                                <div key={key}>
                                  <dt>
                                    <code>{key}</code>
                                  </dt>
                                  <dd>
                                    {sourceName(source)}
                                    {isSecret && ' · 敏感引用'}
                                    {!!overriddenSources?.length && (
                                      <small>
                                        覆盖 {overriddenSources.map(sourceName).join('、')}
                                      </small>
                                    )}
                                  </dd>
                                </div>
                              ),
                            )}
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
                          open={n.targets.some((target) => needsReleaseInspection(n, target))}
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
                                      returnPath: graphRunHref(
                                        projectId,
                                        item.id,
                                        scope,
                                        delivery,
                                      ).slice(1),
                                    })}
                                  >
                                    {target.serverName ?? target.serverId}
                                  </a>{' '}
                                  <Status value={target.status} />
                                  {target.exitCode != null && (
                                    <small>退出码 {target.exitCode}</small>
                                  )}
                                  {target.startedAt && (
                                    <small>开始 {formatTime(target.startedAt)}</small>
                                  )}
                                  {target.finishedAt && (
                                    <small>结束 {formatTime(target.finishedAt)}</small>
                                  )}
                                </div>
                                {needsReleaseInspection(n, target) && (
                                  <ExecutionGraphReleaseInspection
                                    context={releaseContext}
                                    path={`${path}/nodes/${encodeURIComponent(n.nodeId)}/targets/${encodeURIComponent(target.serverId)}/inspect-release`}
                                    latest={target.inspection}
                                    canInspect={canInspect}
                                    replanHref={
                                      canInspect
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
                      {n.log ? (
                        <details className="graph-field-card" open>
                          <summary>节点日志</summary>
                          <pre>{n.log}</pre>
                        </details>
                      ) : (
                        <p className="field-note">此节点暂无日志。</p>
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
                </div>
              )}
              <a className="text-link" href={graphRunHref(projectId, item.id, scope, delivery)}>
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
