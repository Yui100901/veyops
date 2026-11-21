import type { ExecutionPlanIssue } from '../api';
import type { ProjectDetail } from '../models';
import type { GraphField, GraphFlow } from './execution-graph-definition';
import {
  graphDraftSetupHref,
  graphWorkbenchPath,
  type GraphStartLocation,
} from './graph-workbench-context';
import { graphSetupResourceHref, type ResourceLocation } from './project-workspace-route';

export type GraphSetupIssue = Pick<
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
  BUILD_TARGET: '选择构建服务器',
  DEPLOY_TARGET: '选择发布目标',
  ARTIFACT: '选择历史制品',
};

function runFields(flow: GraphFlow) {
  return flow.nodes.find(({ type }) => type === 'START')?.inputs ?? [];
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
  const fields = runFields(flow);
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
          }),
        }
      : undefined;
  const resourceLink = (label: string, destination: ResourceLocation) => ({
    label,
    href: graphSetupResourceHref(project.id, back, destination),
  });
  const links: { href: string; label: string }[] = [];

  if (issue.kind === 'DEPLOY_TARGET' && issue.targetSource !== 'NODE') {
    const serviceId = issue.serviceId ?? start.serviceId ?? flow.serviceId;
    const environmentId = issue.environmentId ?? start.environmentId;
    const environment = project.environments.find(({ id }) => id === environmentId);
    const service = project.services.find(({ id }) => id === serviceId);
    if (environment && service) {
      links.push(
        resourceLink('配置服务环境发布目标', {
          resource: 'services',
          serviceId: service.id,
          environmentId: environment.id,
          panel: 'settings',
        }),
      );
    }
    if (environment) {
      const inherited = resourceLink('配置环境默认发布目标', {
        resource: 'environments',
        environmentId: environment.id,
        panel: 'targets',
      });
      if (issue.targetSource === 'PROJECT_ENVIRONMENT') links.unshift(inherited);
      else links.push(inherited);
    }
  }
  if (issue.kind === 'REPOSITORY' && (parameter || !issue.nodeId || !project.repositories.length)) {
    links.push(resourceLink('登记项目仓库', { resource: 'repositories', panel: 'new' }));
  }
  if (!parameter && (issue.kind !== 'DEPLOY_TARGET' || !links.length)) {
    const label = {
      REPOSITORY: '编辑仓库绑定',
      BUILD_TARGET: '编辑构建目标',
      DEPLOY_TARGET: '编辑发布目标绑定',
      ARTIFACT: '编辑产物绑定',
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
          label={parameterLabels[issue.kind]}
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
