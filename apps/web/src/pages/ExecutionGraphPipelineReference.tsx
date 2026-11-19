import { useResource } from '../api';
import { ErrorBanner, Field } from '../components';
import type { ProjectDetail } from '../models';
import type { Pipeline, PipelineDefinition } from './Delivery';
import type { GraphNode } from './execution-graph-definition';
import { deliveryPath } from './delivery-route';

export function PipelineReference({
  project,
  node,
  canEdit,
  onChange,
}: {
  project: ProjectDetail;
  node: GraphNode;
  canEdit: boolean;
  onChange: (fields: Partial<GraphNode>) => void;
}) {
  const pipelines = useResource<Pipeline[]>('/pipelines?projectId=' + project.id);
  const versions = useResource<{ version: number; definition: PipelineDefinition }[]>(
    node.pipelineId ? '/pipelines/' + node.pipelineId + '/versions' : null,
  );
  const selected = versions.data?.find((v) => v.version === node.pipelineVersion);
  return (
    <>
      <ErrorBanner error={pipelines.error || versions.error} />
      <div className="form-grid">
        <Field label="服务流水线">
          <select
            disabled={!canEdit}
            value={node.pipelineId ?? ''}
            onChange={(e) => {
              const p = pipelines.data?.find((v) => v.id === e.target.value);
              onChange({ pipelineId: p?.id, pipelineVersion: p?.currentVersion });
            }}
          >
            <option value="">选择流水线</option>
            {pipelines.data?.map((p) => (
              <option value={p.id} key={p.id}>
                {project.services.find((s) => s.id === p.serviceId)?.name} · {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="固定流水线版本">
          <select
            disabled={!canEdit || !node.pipelineId}
            value={node.pipelineVersion ?? ''}
            onChange={(e) => onChange({ pipelineVersion: Number(e.target.value) })}
          >
            <option value="" disabled>
              选择版本
            </option>
            {versions.data?.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {selected && (
        <p className="field-note">
          仓库{' '}
          {project.repositories.find((r) => r.id === selected.definition.repositoryId)?.name ||
            selected.definition.repositoryId}
          {selected.definition.nodes?.length
            ? ' · ' + selected.definition.nodes.map((n) => n.name).join(' → ')
            : ''}
        </p>
      )}
      <a className="text-link" href={'#' + deliveryPath(project.id, 'pipelines')}>
        管理项目服务流水线
      </a>
    </>
  );
}
