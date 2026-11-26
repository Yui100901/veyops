import { useState } from 'react';
import type { ProjectDetail } from '../../../models';
import {
  effectiveNodeType,
  isReleaseNode,
  type GraphCanvas,
  type GraphNode,
} from '../execution-graph-definition';
import {
  producesWorkspace,
  simplifiedSourceDirectory,
  type SimplifiedRelease,
  type SimplifiedStart,
} from '../simplified-flow';
import { pathHighlight } from './execution-graph-draft-impact';

type Change = {
  id: string;
  title: string;
  overwrite: boolean;
  apply: (node: GraphNode) => GraphNode;
};

export function SimplifiedEntryCopy({
  canvas,
  source,
  project,
  onChange,
}: {
  canvas: GraphCanvas;
  source: GraphNode;
  project: ProjectDetail;
  onChange: (next: GraphCanvas) => void;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState('');
  const start = source.start ?? {};
  const sourcePath = pathHighlight(canvas, source.id);
  const mainNodes = canvas.nodes.filter(({ id }) => sourcePath?.nodes.has(id));
  const releaseAction = mainNodes.find(isReleaseNode);
  const sharedBuild = mainNodes.find((node) => effectiveNodeType(node) === 'BUILD');
  if (!releaseAction || !sharedBuild) return null;

  const release = start.release ?? {};
  const buildTarget = start.execution?.serverId
    ? { serverIds: [start.execution.serverId] }
    : start.execution?.groupId
      ? { groupIds: [start.execution.groupId] }
      : undefined;
  const targets = release.reuseExecutionServer ? buildTarget : release.targets;
  const compose = release.compose;
  const composeSource = start.sources?.find(({ id }) => id === compose?.sourceId);
  const composeRepo = project.repositories.find(({ id }) => id === composeSource?.repositoryId);
  const composeDirectory =
    composeRepo && simplifiedSourceDirectory(composeRepo.cloneUrl, composeSource?.parentDirectory);
  const composePath =
    compose?.path &&
    (compose.sourceId ? composeDirectory && `${composeDirectory}/${compose.path}` : compose.path);
  const destinations = canvas.endpoints.flatMap(({ startId, endId }) => {
    if (startId === source.id) return [];
    const entry = canvas.nodes.find(({ id }) => id === startId);
    const end = canvas.nodes.find(({ id }) => id === endId);
    const path = pathHighlight(canvas, startId)?.nodes;
    if (!entry || !path) return [];
    const nodes = canvas.nodes.filter(({ id }) => path.has(id));
    const builds = path.has(sharedBuild.id) && !nodes.some(isReleaseNode);
    const deploys = path.has(releaseAction.id) && !nodes.some(producesWorkspace);
    if (!builds && !deploys) return [];

    const draft = entry.start ?? {};
    const changes: Change[] = [];
    const add = (key: string, title: string, overwrite: boolean, patch: Partial<SimplifiedStart>) =>
      changes.push({
        id: entry.id + ':' + key,
        title,
        overwrite,
        apply: (node) => ({ ...node, start: { ...node.start, ...structuredClone(patch) } }),
      });
    const addRelease = (
      key: string,
      title: string,
      overwrite: boolean,
      patch: Partial<SimplifiedRelease>,
    ) =>
      changes.push({
        id: entry.id + ':' + key,
        title,
        overwrite,
        apply: (node) => ({
          ...node,
          start: { ...node.start, release: { ...node.start?.release, ...structuredClone(patch) } },
        }),
      });
    if (builds && start.sources?.some(({ repositoryId }) => repositoryId))
      add(
        'sources',
        '仓库、版本、检出父目录及变量文件',
        Boolean(draft.sources?.some(({ repositoryId }) => repositoryId)),
        {
          sources: start.sources.map((source) => ({
            ...source,
            allowRefOverride: draft.sources?.find(({ id }) => id === source.id)?.allowRefOverride,
          })),
          dotenv: start.dotenv,
        },
      );
    if (builds && start.execution)
      add(
        'execution',
        '执行位置',
        Boolean(
          draft.execution &&
          (draft.execution.location !== 'INHERIT' ||
            draft.execution.serverId ||
            draft.execution.groupId),
        ),
        { execution: start.execution },
      );
    if (start.environmentSetId)
      add('environmentSet', '项目变量集合', Boolean(draft.environmentSetId), {
        environmentSetId: start.environmentSetId,
      });
    if (start.variables?.length)
      add('variables', '流程变量和凭据引用', Boolean(draft.variables?.length), {
        variables: start.variables.map((variable) => ({
          ...variable,
          allowOverride: draft.variables?.find(({ key }) => key === variable.key)?.allowOverride,
        })),
      });
    if (release.serviceId && release.serviceId !== draft.release?.serviceId)
      addRelease(
        'service',
        draft.release?.artifactId ? '项目服务（清除旧服务的固定产物）' : '项目服务',
        Boolean(draft.release?.serviceId),
        {
          serviceId: release.serviceId,
          artifactId: undefined,
        },
      );
    if (deploys && (targets?.serverIds?.length || targets?.groupIds?.length))
      addRelease(
        'targets',
        release.reuseExecutionServer ? '发布目标（来自执行服务器或分组）' : '发布服务器和分组',
        Boolean(
          draft.release?.targets?.serverIds?.length ||
          draft.release?.targets?.groupIds?.length ||
          draft.release?.reuseExecutionServer,
        ),
        { targets, reuseExecutionServer: undefined },
      );
    if (deploys && releaseAction.deploy?.method !== 'COMPOSE' && release.contentPath !== undefined)
      addRelease(
        'contentPath',
        '发布内容子路径 · ' + release.contentPath,
        Boolean(draft.release?.contentPath && draft.release.contentPath !== release.contentPath),
        { contentPath: release.contentPath },
      );
    const images = end?.finish?.images ?? [];
    const image =
      images.find(({ id }) => id === release.imageId) ??
      (images.length === 1 ? images[0] : undefined);
    if (builds && end && image && composePath && image.composePath !== composePath)
      changes.push({
        id: end.id + ':compose',
        title: '构建结束归档 Compose 文件 · ' + composePath,
        overwrite: Boolean(image.composePath),
        apply: (node) => ({
          ...node,
          finish: {
            ...node.finish,
            images: node.finish?.images?.map((item) =>
              item.id === image.id ? { ...item, composePath } : item,
            ),
          },
        }),
      });
    return changes.length ? [{ entry, end, changes }] : [];
  });
  if (!destinations.length) return null;
  const included = (item: Change) => selected[item.id] ?? !item.overwrite;
  return (
    <details className="graph-field-card">
      <summary>复制配置到其他入口</summary>
      <p className="field-note">来源 · {source.name}。选择要写入的字段，已有配置默认保留。</p>
      {destinations.map(({ entry, changes }) => (
        <fieldset key={entry.id} className="graph-fields">
          <legend>目标 · {entry.name}</legend>
          {changes.map((item) => (
            <label key={item.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={included(item)}
                onChange={(event) => {
                  setNotice('');
                  setSelected({ ...selected, [item.id]: event.target.checked });
                }}
              />
              {item.title}
              {item.overwrite ? '（覆盖已有配置）' : ''}
            </label>
          ))}
        </fieldset>
      ))}
      <div className="heading-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={!destinations.some(({ changes }) => changes.some(included))}
          onClick={() => {
            const nodes = canvas.nodes.map((node) =>
              destinations.reduce((value, { entry, end, changes }) => {
                if (node.id !== entry.id && node.id !== end?.id) return value;
                return changes.reduce(
                  (next, item) =>
                    included(item) && item.id.startsWith(node.id + ':') ? item.apply(next) : next,
                  value,
                );
              }, node),
            );
            onChange({ ...canvas, nodes });
            setSelected({});
            setNotice('已复制到草稿，保存前可撤销。');
          }}
        >
          复制选中的配置
        </button>
        {notice && <span role="status">{notice}</span>}
      </div>
    </details>
  );
}
