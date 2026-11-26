import type { ExecutionPlanIssue, GraphIssueLocation } from '../../../api';
import type { ProjectDetail } from '../../../models';
import type { GraphField, GraphFlow } from '../execution-graph-definition';
import {
  simplifiedModel,
  simplifiedRuntimeInputs,
  simplifiedWorkspaceArtifactField,
} from '../simplified-flow';
import {
  graphDraftSetupHref,
  graphWorkbenchPath,
  type GraphStartLocation,
} from '../graph-workbench-context';
import {
  graphSetupResourceHref,
  type ResourceLocation,
} from '../../projects/project-workspace-route';

export type GraphSetupIssue = GraphIssueLocation &
  Pick<
    ExecutionPlanIssue,
    'flowId' | 'nodeId' | 'fieldId' | 'parameterId' | 'serviceId' | 'environmentId' | 'targetSource'
  > & {
    kind: 'REPOSITORY' | 'BUILD_TARGET' | 'DEPLOY_TARGET' | 'ARTIFACT';
  };

const parameterTypes: Record<GraphSetupIssue['kind'], GraphField['type']> = {
  REPOSITORY: 'REPOSITORY',
  BUILD_TARGET: 'TARGETS',
  DEPLOY_TARGET: 'TARGETS',
  ARTIFACT: 'ARTIFACT',
};

const parameterLabels = {
  REPOSITORY: '选择仓库',
  BUILD_TARGET: '选择构建目标',
  DEPLOY_TARGET: '选择发布目标',
  ARTIFACT: '选择历史制品',
};

export function runParameterFields(flow: GraphFlow) {
  return flow.model === simplifiedModel
    ? simplifiedRuntimeInputs(flow)
    : (flow.nodes.find(({ type }) => type === 'START')?.inputs ?? []);
}

export function ExecutionGraphRepairLinks({
  project,
  flow,
  start,
  issue,
  onFocusParameter,
}: {
  project: ProjectDetail;
  flow: GraphFlow;
  start: GraphStartLocation;
  issue: GraphSetupIssue;
  onFocusParameter?: (fieldId: string) => void;
}) {
  const fields = runParameterFields(flow);
  const parameter = fields.find(
    ({ id, type }) => id === issue.parameterId && type === parameterTypes[issue.kind],
  );
  const back = { ...start, field: parameter?.id ?? start.field };
  const nodeLink = (label: string) =>
    issue.nodeId
      ? {
          label,
          href: graphDraftSetupHref(project.id, back, {
            node: issue.nodeId,
            field: issue.fieldId,
            flow: issue.flowId ?? flow.id,
            fieldSection: issue.fieldSection,
            artifactField: issue.artifactField,
          }),
        }
      : undefined;
  const resourceLink = (label: string, destination: ResourceLocation) => ({
    label,
    href: graphSetupResourceHref(project.id, back, destination),
  });
  const links: { href: string; label: string }[] = [];

  if (issue.kind === 'REPOSITORY' && (parameter || !issue.nodeId || !project.repositories.length)) {
    links.push(resourceLink('登记项目仓库', { resource: 'repositories', panel: 'new' }));
  }
  if (!parameter) {
    const label = {
      REPOSITORY: '编辑仓库绑定',
      BUILD_TARGET: issue.fieldId === 'buildLocation' ? '编辑构建位置' : '编辑构建目标',
      DEPLOY_TARGET: '编辑发布目标绑定',
      ARTIFACT: issue.fieldSection === 'output' ? '编辑产物配置' : '编辑产物绑定',
    }[issue.kind];
    const edit = nodeLink(label);
    if (edit) links.push(edit);
  }
  if (!parameter && !links.length) return null;
  return (
    <span className="heading-actions graph-repair-links">
      {parameter && (
        <ExecutionGraphParameterLink
          projectId={project.id}
          start={start}
          fieldId={parameter.id}
          label={
            parameter.id === simplifiedWorkspaceArtifactField
              ? '重新选择历史目录'
              : parameterLabels[issue.kind]
          }
          onFocus={onFocusParameter}
        />
      )}
      {links.map(({ href, label }) => (
        <a className="button secondary small" key={href} href={href}>
          {label}
        </a>
      ))}
    </span>
  );
}

export function ExecutionGraphParameterLink({
  projectId,
  start,
  fieldId,
  label,
  onFocus,
}: {
  projectId: string;
  start: GraphStartLocation;
  fieldId: string;
  label: string;
  onFocus?: (fieldId: string) => void;
}) {
  return onFocus ? (
    <button className="button secondary small" type="button" onClick={() => onFocus(fieldId)}>
      {label}
    </button>
  ) : (
    <a
      className="button secondary small"
      href={'#' + graphWorkbenchPath(projectId, { ...start, field: fieldId })}
    >
      {label}
    </a>
  );
}
