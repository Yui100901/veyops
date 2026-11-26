import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Play } from 'lucide-react';
import { ApiError, message, post, useResource, type ExecutionPlanIssue } from '../../../api';
import { ErrorBanner, Field } from '../../../components';
import type { ProjectDetail, ProjectExecutionSettings } from '../../../models';
import {
  GraphFieldValue,
  useProjectEnvironmentSets,
  type FieldScope,
} from '../editor/ExecutionGraphFields';
import { ExecutionPlan, ExecutionPlanChanges, type Preview } from './ExecutionGraphPreview';
import {
  ExecutionGraphParameterLink,
  ExecutionGraphRepairLinks,
  runParameterFields,
} from './ExecutionGraphRepairLinks';
import { GraphRunResults, planIssueLabels, repairKind } from './ExecutionGraphRunEvidence';
import { ExecutionGraphStartStatus } from './ExecutionGraphStartStatus';
import { WorkspaceHistoryInput } from './WorkspaceHistoryInput';
import {
  branchLabel,
  graphKey,
  graphNodeLabels,
  isReleaseNode,
} from '../execution-graph-definition';
import type { GraphField, GraphFlow, GraphRun } from '../execution-graph-definition';
import { projectGraphPath, projectResourcePath } from '../../projects/project-workspace-route';
import { graphStartReadiness, type GraphWorkbenchScope } from '../graph-workbench-context';
import {
  simplifiedConditionField,
  simplifiedRuntimeInputs,
  simplifiedWorkspaceArtifactField,
} from '../simplified-flow';

export { ExecutionGraphHistory } from './ExecutionGraphHistory';

type Inputs = { parameters: Record<string, unknown>; value?: string };
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
  const field =
    runParameterFields(flow).find(({ id }) => id === issue.parameterId)?.name ??
    node?.inputs?.find(({ id }) => id === issue.fieldId)?.name;
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
  const start = startNode?.start;
  const fixedSetId = start?.environmentSetId;
  const fixedSets = useProjectEnvironmentSets(project.id, !!fixedSetId);
  const fixedSet = fixedSets.data?.find(({ id }) => id === fixedSetId);
  const fields = simplifiedRuntimeInputs(flow);
  const workspaceField = fields.find(({ id }) => id === simplifiedWorkspaceArtifactField);
  const entryFields = fields.filter(({ id }) => id !== simplifiedWorkspaceArtifactField);
  const configuredLocation = start?.execution?.location ?? 'INHERIT';
  const projectExecution = useResource<ProjectExecutionSettings>(
    workspaceField && configuredLocation === 'INHERIT'
      ? '/projects/' + project.id + '/execution-settings'
      : null,
  );
  const location =
    configuredLocation === 'INHERIT'
      ? projectExecution.data?.effective.defaultBuildLocation
      : configuredLocation;
  const runtimePresets = Object.fromEntries(
    fields.flatMap(({ id }) =>
      initialInputs && Object.hasOwn(initialInputs, id) ? [[id, initialInputs[id]]] : [],
    ),
  );
  const draftKey = JSON.stringify([
    flow.id,
    flow.model,
    workbenchScope.serviceId,
    workbenchScope.environmentId,
  ]);
  const [edits, setEdits] = useState<ParameterEdits>(() => drafts?.get(draftKey) ?? {});
  const parameters: Record<string, unknown> = {
    ...Object.fromEntries(
      fields.map((field) => {
        const edit = edits[field.id];
        return [
          field.id,
          edit?.schema === parameterSchema(field) ? edit.value : field.defaultValue,
        ];
      }),
    ),
    ...runtimePresets,
  };
  const [workspaceMode, setWorkspaceMode] = useState<'NEW' | 'HISTORICAL'>(() =>
    focusFieldId === simplifiedWorkspaceArtifactField ||
    parameters[simplifiedWorkspaceArtifactField]
      ? 'HISTORICAL'
      : 'NEW',
  );
  const historicalWorkspace = Boolean(
    workspaceField && (workspaceField.required || workspaceMode === 'HISTORICAL'),
  );
  const readiness = graphStartReadiness(flow, workbenchScope, project, parameters, {
    historicalWorkspace,
  });
  const fieldRefs = useRef(new Map<string, HTMLElement>());
  const scope: FieldScope = {
    serviceId: start?.release?.serviceId,
    targets: start?.release?.targets,
    deliveryMethod: flow.nodes.find(isReleaseNode)?.deploy?.method,
  };
  const [preview, setPreview] = useState<Preview>();
  const [revision, setRevision] = useState<{ previous: Preview; sections: string[] }>();
  const key = useRef('');
  const defaultsKey = useRef<{ version: number; value: string } | undefined>(undefined);
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
    if (focusFieldId === simplifiedWorkspaceArtifactField) setWorkspaceMode('HISTORICAL');
    setPreview(undefined);
    setRevision(undefined);
    const frame = window.requestAnimationFrame(() =>
      focusRunField(fieldRefs.current.get(focusFieldId)),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [focusFieldId]);
  const base = path + '/flows/' + encodeURIComponent(flow.id);
  const useDefaults =
    !historicalWorkspace &&
    !start?.release?.useUpstreamArtifact &&
    start?.release?.artifactSource !== 'RUN_PARAMETER' &&
    !preview &&
    !revision &&
    !Object.keys(edits).length &&
    !Object.keys(initialInputs ?? {}).length;
  async function runDefaults() {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    setPlanIssue(undefined);
    if (defaultsKey.current?.version !== version)
      defaultsKey.current = { version, value: graphKey('defaults') };
    try {
      const result = await post<
        { outcome: 'STARTED'; runId: string } | { outcome: 'NEEDS_CONFIRMATION'; reason: string }
      >(base + '/run-defaults', { version, idempotencyKey: defaultsKey.current.value });
      if (result.outcome === 'STARTED') {
        onRun(result.runId);
      } else {
        const checked = await post<Preview>(base + '/preview', {
          version,
          inputs: runtimeInputs(),
        });
        key.current = graphKey('run');
        setPreview(checked);
      }
    } catch (err) {
      if (err instanceof ApiError && err.planIssue) {
        setPlanIssue(err.planIssue);
        const field =
          err.planIssue.parameterId ??
          (err.planIssue.nodeId === startNode?.id ? err.planIssue.fieldId : undefined);
        if (field) window.requestAnimationFrame(() => focusRunField(fieldRefs.current.get(field)));
      } else {
        setError(message(err));
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
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
    const condition = parameters[simplifiedConditionField];
    return {
      value: typeof condition === 'string' && condition !== '' ? condition : undefined,
      parameters: Object.fromEntries(
        fields.flatMap((field) => {
          const edit = edits[field.id];
          if (field.id === simplifiedConditionField) return [];
          if (field.id === simplifiedWorkspaceArtifactField && !historicalWorkspace) return [];
          if (!Object.hasOwn(runtimePresets, field.id) && edit?.schema !== parameterSchema(field))
            return [];
          const value = parameters[field.id];
          return value === undefined || (value === '' && field.type !== 'TEXT')
            ? []
            : [[field.id, value]];
        }),
      ),
    };
  }
  function updateParameter(field: GraphField, value: unknown) {
    const next = { ...(drafts?.get(draftKey) ?? edits) };
    if (value === undefined) delete next[field.id];
    else next[field.id] = { schema: parameterSchema(field), value };
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
    if (fieldId === simplifiedWorkspaceArtifactField) setWorkspaceMode('HISTORICAL');
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
      {Object.keys(runtimePresets).length > 0 && (
        <p className="field-note">已填入当前入口传来的参数。</p>
      )}
      {start?.release?.useUpstreamArtifact && !start.release.allowArtifactOverride && (
        <p className="field-note">此流使用上游产物，通过配置的上游触发器运行。</p>
      )}
      <fieldset
        disabled={busy || Boolean(preview || revision)}
        hidden={Boolean(preview || revision)}
      >
        {workspaceField && (
          <div className="workspace-history-setup">
            <div className="workspace-history-heading">
              <strong>执行位置</strong>
              <span className="field-note">
                {location === 'TARGET'
                  ? '目标端'
                  : location === 'MANAGER'
                    ? '管理端'
                    : '沿用项目设置'}
              </span>
            </div>
            {!workspaceField.required && (
              <Field label="工作区来源">
                <select
                  value={workspaceMode}
                  onChange={(event) => {
                    const mode = event.target.value === 'NEW' ? 'NEW' : 'HISTORICAL';
                    setWorkspaceMode(mode);
                    if (mode === 'NEW') updateParameter(workspaceField, undefined);
                  }}
                >
                  <option value="NEW">使用新工作区</option>
                  <option value="HISTORICAL">使用历史目录</option>
                </select>
              </Field>
            )}
            {historicalWorkspace && (
              <div
                className="graph-run-field workspace-history-picker"
                tabIndex={-1}
                ref={(element) => {
                  if (element) fieldRefs.current.set(workspaceField.id, element);
                  else fieldRefs.current.delete(workspaceField.id);
                }}
              >
                <WorkspaceHistoryInput
                  projectId={project.id}
                  value={parameters[workspaceField.id]}
                  change={(id) => updateParameter(workspaceField, id)}
                />
              </div>
            )}
          </div>
        )}
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
                  origin: workbenchScope.origin,
                  originQuery: workbenchScope.originQuery,
                })
              }
            >
              {fixedSet?.name ?? (fixedSets.loading ? '正在读取集合' : '集合不可用')}
            </a>
          </p>
        )}
        {fields.length ? (
          entryFields.map((field) => (
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
                scope={scope}
                disabled={Object.hasOwn(runtimePresets, field.id)}
                checkRequired
                canManageProjectResources
                artifactInstancesOnly
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
                {node.conditional && <small> · 视分支结果执行</small>}
              </li>
            ))}
          </ul>
          {Boolean(preview.routing?.length) && (
            <details className="graph-field-card">
              <summary>执行路线</summary>
              <ul className="graph-edge-list">
                {preview.routing?.map(({ from, to, when, status }) => {
                  const source = flow.nodes.find(({ id }) => id === from);
                  const target = flow.nodes.find(({ id }) => id === to);
                  const labels = {
                    CERTAIN: '纳入',
                    POSSIBLE: '待分支决定',
                    EXCLUDED: '本次跳过',
                    OUTSIDE_FLOW: '流外',
                  };
                  return (
                    <li key={JSON.stringify([from, to, when])}>
                      {source?.name ?? from} → {target?.name ?? to}
                      {when && <small> · {branchLabel(when, source)}</small>}
                      <small> · {labels[status]}</small>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          <GraphRunResults
            values={Object.fromEntries(
              fields
                .filter(
                  ({ type, id }) =>
                    !['VARIABLES', 'CREDENTIAL'].includes(type) &&
                    id !== simplifiedWorkspaceArtifactField &&
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
            origin={workbenchScope.origin}
            originQuery={workbenchScope.originQuery}
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
        {useDefaults && (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void runDefaults()}
          >
            <Play size={15} /> 按默认配置立即运行
          </button>
        )}
        <button
          type="submit"
          className={`button ${useDefaults ? 'secondary' : 'primary'}`}
          disabled={
            busy ||
            (!preview && historicalWorkspace && !parameters[simplifiedWorkspaceArtifactField]) ||
            Boolean(start?.release?.useUpstreamArtifact && !start.release.allowArtifactOverride)
          }
        >
          <Play size={15} />
          {busy ? '处理中…' : preview ? '确认启动' : revision ? '重新预览' : '预览运行'}
        </button>
      </div>
    </form>
  );
}
