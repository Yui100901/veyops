import type { ProjectDetail } from '../../../models';
import type { GraphFlow } from '../execution-graph-definition';
import {
  ExecutionGraphParameterLink,
  ExecutionGraphRepairLinks,
  type GraphSetupIssue,
} from './ExecutionGraphRepairLinks';
import {
  graphStartReadiness,
  type GraphStartLocation,
  type GraphWorkbenchScope,
} from '../graph-workbench-context';
import './graph-start.css';

type Readiness = ReturnType<typeof graphStartReadiness>;

const statusLabels = {
  READY_TO_PREVIEW: '可进入预览',
  NEEDS_INPUT: '待填写参数',
  NEEDS_CONFIGURATION: '待配置',
  CONTEXT_MISMATCH: '当前范围不可用',
} as const;

const resourceLabels = { REPOSITORY: '仓库', SERVICE: '服务', ENVIRONMENT: '环境' };

function scopeReason(
  issue: Extract<Readiness, { status: 'CONTEXT_MISMATCH' }>,
  project: ProjectDetail,
) {
  const service = issue.scopeType === 'service';
  const label = service ? '服务' : '环境';
  const resources = service
    ? [...project.services, ...(project.archivedServices ?? [])]
    : [...project.environments, ...(project.archivedEnvironments ?? [])];
  const current = resources.find(({ id }) => id === issue.contextId)?.name;
  const context = current ? `当前${label}「${current}」` : `当前${label}`;
  switch (issue.reason) {
    case 'FIXED_SCOPE': {
      const fixed = issue.fixedIds?.map((id) => resources.find((item) => item.id === id)?.name);
      const names = fixed
        ?.filter(Boolean)
        .map((name) => `「${name}」`)
        .join('、');
      return `此执行流固定到${names ? `${label}${names}` : `其他${label}`}，无法用于${context}。`;
    }
    case 'OPTION_NOT_ALLOWED':
      return `此执行流声明的${label}可选范围未包含${context}。`;
    case 'AMBIGUOUS_SCOPE':
      return `此执行流的${label}绑定无法从${context}自动确定。`;
    case 'SERVICE_NOT_DECLARED':
      return `此执行流没有关联${context}，也没有可用于预填的服务参数。`;
  }
}

const missingLabels = {
  ARTIFACT: '选择历史制品',
  ENVIRONMENT_SET: '选择变量集合',
  TARGETS: '配置目标',
  REPOSITORY: '选择仓库',
} as const;

export function ExecutionGraphStartStatus({
  readiness,
  flow,
  project,
  repairStart,
  onFocusParameter,
}: {
  readiness: Readiness;
  flow: GraphFlow;
  project: ProjectDetail;
  repairStart?: GraphStartLocation;
  onFocusParameter?: (fieldId: string) => void;
}) {
  const startFields = flow.nodes.find(({ type }) => type === 'START')?.inputs;
  return (
    <div className="execution-start-status" data-status={readiness.status}>
      <span className="tag">{statusLabels[readiness.status]}</span>
      {readiness.status === 'CONTEXT_MISMATCH' ? (
        <p className="field-note">{scopeReason(readiness, project)}</p>
      ) : (
        <>
          {readiness.status === 'NEEDS_CONFIGURATION' &&
            readiness.issues.map((issue) => {
              const location = [
                flow.nodes.find(({ id }) => id === issue.nodeId)?.name,
                issue.fieldName,
              ]
                .filter(Boolean)
                .join(' · ');
              const resource = issue.resourceType && resourceLabels[issue.resourceType];
              const reason =
                issue.reason === 'FIXED_INPUT_MISSING'
                  ? '请在开始节点配置固定输入。'
                  : issue.reason === 'NO_AVAILABLE_OPTIONS'
                    ? resource
                      ? `没有可选的${resource}。`
                      : '没有可选值。'
                    : `引用的${resource ?? '资源'}已不可用。`;
              const field = startFields?.find(({ id }) => id === issue.fieldId && issue.fieldName);
              const setupIssue: GraphSetupIssue | undefined =
                issue.resourceType === 'REPOSITORY'
                  ? {
                      kind: 'REPOSITORY',
                      nodeId: issue.nodeId,
                      fieldId: issue.fieldId,
                      parameterId: field && !field.options ? field.id : undefined,
                    }
                  : undefined;
              return (
                <div className="graph-setup-reason" key={JSON.stringify(issue)}>
                  <p className="field-note">{location ? `「${location}」${reason}` : reason}</p>
                  {repairStart && setupIssue && (
                    <ExecutionGraphRepairLinks
                      project={project}
                      flow={flow}
                      start={repairStart}
                      issue={setupIssue}
                      onFocusParameter={onFocusParameter}
                    />
                  )}
                </div>
              );
            })}
          {readiness.missingFields.map((field) => (
            <div className="graph-setup-reason" key={field.id}>
              <p className="field-note">需要填写「{field.name}」。</p>
              {repairStart && (
                <ExecutionGraphParameterLink
                  projectId={project.id}
                  start={repairStart}
                  fieldId={field.id}
                  label={
                    missingLabels[field.type as keyof typeof missingLabels] ?? `填写${field.name}`
                  }
                  onFocus={onFocusParameter}
                />
              )}
            </div>
          ))}
          {readiness.scopeNotice && (
            <p className="field-note">当前环境无法自动填入，请在运行参数或预览中确认。</p>
          )}
        </>
      )}
    </div>
  );
}

export function ExecutionGraphStartList({
  flows,
  project,
  scope,
  href,
  selectedId,
  version,
  canRepair,
}: {
  flows: GraphFlow[];
  project: ProjectDetail;
  scope: GraphWorkbenchScope;
  href: (flow: GraphFlow) => string;
  selectedId?: string;
  version?: number;
  canRepair?: boolean;
}) {
  if (!flows.length) return <p className="mini-empty">当前版本没有已发布的开始节点。</p>;

  const entries = flows.map((flow) => ({
    flow,
    readiness: graphStartReadiness(flow, scope, project),
  }));
  const matching = entries.filter(({ readiness }) => readiness.status !== 'CONTEXT_MISMATCH');
  const restricted = entries.filter(({ readiness }) => readiness.status === 'CONTEXT_MISMATCH');

  function list(rows: typeof entries) {
    return (
      <ul className="execution-start-list">
        {rows.map(({ flow, readiness }) => (
          <li key={flow.id}>
            {readiness.status === 'CONTEXT_MISMATCH' ? (
              <strong>{flow.name}</strong>
            ) : (
              <a
                className="text-link"
                aria-current={flow.id === selectedId || undefined}
                href={href(flow)}
              >
                {flow.name}
              </a>
            )}
            <ExecutionGraphStartStatus
              readiness={readiness}
              flow={flow}
              project={project}
              repairStart={canRepair ? { ...scope, start: flow.id, version } : undefined}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="execution-start-options">
      {matching.length > 0 && list(matching)}
      {restricted.length > 0 && (
        <details
          open={
            !matching.length || restricted.some(({ flow }) => flow.id === selectedId) || undefined
          }
        >
          <summary>当前范围不可用的开始节点（{restricted.length}）</summary>
          {list(restricted)}
        </details>
      )}
    </div>
  );
}
