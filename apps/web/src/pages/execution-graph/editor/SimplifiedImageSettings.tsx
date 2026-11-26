import { Plus, Trash2 } from 'lucide-react';
import { useResource } from '../../../api';
import { ErrorBanner, Field } from '../../../components';
import type { ProjectDetail } from '../../../models';
import { graphKey, type GraphNode } from '../execution-graph-definition';
import {
  isNativeDockerBuild,
  simplifiedSourceDirectory,
  type SimplifiedFinishImage,
} from '../simplified-flow';

export function SimplifiedImageSettings({
  node,
  project,
  flowNodes,
  canEdit,
  patch,
}: {
  node: GraphNode;
  project: ProjectDetail;
  flowNodes: GraphNode[];
  canEdit: boolean;
  patch: (fields: Partial<GraphNode>) => void;
}) {
  const images = node.finish?.images ?? [];
  const nativeBuilds = flowNodes.filter(isNativeDockerBuild);
  const hasNativeBuild = nativeBuilds.length > 0;
  const registries = useResource<{ id: string; name: string }[]>(
    images.some(({ source }) => source === 'REGISTRY') ? '/registries' : null,
  );
  const suggestions = new Map<string, { name: string; label: string }>();
  for (const start of flowNodes.filter(({ type }) => type === 'START')) {
    for (const source of start.start?.sources ?? []) {
      const repo = project.repositories.find(({ id }) => id === source.repositoryId);
      const path = repo && simplifiedSourceDirectory(repo.cloneUrl);
      const name = path?.split('/').at(-1)?.toLowerCase();
      if (name && repo)
        suggestions.set(repo.id + ':' + path, { name, label: `${repo.name} · ./${path}` });
    }
  }
  const change = (next: SimplifiedFinishImage[]) =>
    patch({ finish: { ...node.finish, images: next } });
  const add = (name: string) =>
    change([
      ...images,
      {
        id: graphKey('image'),
        name,
        source: hasNativeBuild ? 'BUILT_IN' : 'WORKSPACE',
        ...(nativeBuilds.length === 1 && { buildNodeId: nativeBuilds[0]!.id }),
      },
    ]);

  return (
    <div className="graph-fields" data-graph-node-field="finish.images">
      <strong>Docker 镜像登记</strong>
      {!images.length && <p className="field-note">当前未选择登记镜像。</p>}
      {images.map((image, index) => {
        const field = `finish.images.${index}`;
        const update = (next: Partial<SimplifiedFinishImage>) =>
          change(images.map((item) => (item.id === image.id ? { ...item, ...next } : item)));
        return (
          <div key={image.id} className="form-grid" data-graph-node-field={field}>
            <Field label="镜像登记名称">
              <input
                data-graph-node-field={field + '.name'}
                value={image.name}
                placeholder="team/api"
                readOnly={!canEdit}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field label="镜像来源">
              <select
                data-graph-node-field={field + '.source'}
                value={image.source}
                disabled={!canEdit}
                onChange={(event) =>
                  update({
                    source: event.target.value as SimplifiedFinishImage['source'],
                    reference: undefined,
                    registryId: undefined,
                    buildNodeId: undefined,
                  })
                }
              >
                {(hasNativeBuild || image.source === 'BUILT_IN') && (
                  <option value="BUILT_IN">内置 Dockerfile 构建</option>
                )}
                <option value="WORKSPACE">本次命令生成</option>
                <option value="REGISTRY">Registry 固定 Digest</option>
              </select>
            </Field>
            {image.source === 'BUILT_IN' && (nativeBuilds.length > 1 || image.buildNodeId) && (
              <Field label="构建节点">
                <select
                  data-graph-node-field={field + '.buildNodeId'}
                  value={
                    image.buildNodeId ?? (nativeBuilds.length === 1 ? nativeBuilds[0]!.id : '')
                  }
                  disabled={!canEdit}
                  onChange={(event) => update({ buildNodeId: event.target.value || undefined })}
                >
                  <option value="">选择生成此镜像的节点</option>
                  {image.buildNodeId &&
                    !nativeBuilds.some(({ id }) => id === image.buildNodeId) && (
                      <option value={image.buildNodeId} disabled>
                        原构建节点不可用
                      </option>
                    )}
                  {nativeBuilds.map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {image.source === 'REGISTRY' && (
              <>
                <Field label="镜像仓库">
                  <select
                    data-graph-node-field={field + '.registryId'}
                    value={image.registryId ?? ''}
                    disabled={!canEdit}
                    onChange={(event) => update({ registryId: event.target.value || undefined })}
                  >
                    <option value="">选择 Registry</option>
                    {registries.data?.map(({ id, name }) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="完整 Digest 引用">
                  <input
                    data-graph-node-field={field + '.reference'}
                    value={image.reference ?? ''}
                    placeholder="registry.example.com/team/api@sha256:…"
                    readOnly={!canEdit}
                    onChange={(event) => update({ reference: event.target.value || undefined })}
                  />
                </Field>
              </>
            )}
            <Field
              label="随产物归档的 Compose 文件（选填）"
              hint="相对本次工作区，用于历史镜像部署。"
            >
              <input
                data-graph-node-field={field + '.composePath'}
                value={image.composePath ?? ''}
                placeholder="api/compose.yaml"
                readOnly={!canEdit}
                onChange={(event) => update({ composePath: event.target.value || undefined })}
              />
            </Field>
            {canEdit && (
              <div>
                <button
                  className="button secondary small"
                  type="button"
                  onClick={() => change(images.filter(({ id }) => id !== image.id))}
                >
                  <Trash2 size={15} /> 移除登记项
                </button>
              </div>
            )}
          </div>
        );
      })}
      {images.some(({ source }) => source === 'WORKSPACE') && (
        <p className="field-note">
          构建命令使用镜像名称和 <code>VEYOPS_IMAGE_TAG</code>，例如{' '}
          <code>{'docker build -t "team/api:$VEYOPS_IMAGE_TAG" .'}</code>。
        </p>
      )}
      <ErrorBanner error={registries.error} retry={registries.reload} />
      {canEdit && images.length < 20 && (
        <div className="heading-actions">
          {suggestions.size > 0 && (
            <select
              aria-label="从源码添加镜像名称"
              value=""
              onChange={(event) => {
                const suggested = suggestions.get(event.target.value);
                if (suggested) add(suggested.name);
              }}
            >
              <option value="">从源码添加镜像名称</option>
              {[...suggestions].map(([key, { name, label }]) => (
                <option key={key} value={key}>
                  {name} · {label}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="button secondary small" onClick={() => add('')}>
            <Plus size={15} /> 添加镜像登记项
          </button>
        </div>
      )}
    </div>
  );
}
