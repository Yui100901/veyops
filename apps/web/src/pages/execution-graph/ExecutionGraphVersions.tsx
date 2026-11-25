import { useState } from 'react';
import { GitCompareArrows, History } from 'lucide-react';
import { ApiError, message, post, useResource } from '../../api';
import { Confirm, ErrorBanner, Field, Loading } from '../../components';
import type { GraphDocument, GraphFlow, GraphNode } from './execution-graph-definition';
import { branchLabel, graphNodeLabels } from './execution-graph-definition';

interface VersionDefinition {
  version: number;
  definition: GraphDocument['draft'];
}

const nodeProperties: [keyof GraphNode, string][] = [
  ['type', '类型'],
  ['name', '名称'],
  ['start', '开始资源配置'],
  ['finish', '结束留档配置'],
  ['message', '日志'],
  ['condition', '判断条件'],
  ['switch', '匹配项'],
  ['delaySeconds', '等待时间'],
  ['approval', '审批设置'],
  ['inputs', '运行输入'],
  ['outputs', '结果输出'],
  ['build', '构建配置'],
  ['deploy', '部署配置'],
  ['checkout', '拉取配置'],
  ['shell', '脚本配置'],
  ['registerArtifacts', '登记配置'],
  ['loadEnvironment', '环境配置'],
  ['environmentSet', '变量集合引用'],
  ['flowId', '子流'],
  ['position', '位置'],
];

function edgeChanges(old: GraphFlow, current: GraphFlow) {
  const edgeKey = ({ from, to, when }: GraphFlow['edges'][number]) =>
    JSON.stringify([from, to, when]);
  const oldKeys = new Set(old.edges.map(edgeKey));
  const newKeys = new Set(current.edges.map(edgeKey));
  function describe(flow: GraphFlow, edge: GraphFlow['edges'][number]) {
    const from = flow.nodes.find((node) => node.id === edge.from);
    const to = flow.nodes.find((node) => node.id === edge.to);
    const branch = branchLabel(edge.when, from);
    return (
      (from?.name ?? edge.from) +
      (branch ? '（' + branch + '）' : '') +
      ' → ' +
      (to?.name ?? edge.to)
    );
  }
  return [
    ...old.edges
      .filter((edge) => !newKeys.has(edgeKey(edge)))
      .map((edge) => '移除连线 · ' + describe(old, edge)),
    ...current.edges
      .filter((edge) => !oldKeys.has(edgeKey(edge)))
      .map((edge) => '新增连线 · ' + describe(current, edge)),
  ];
}

function compareFlows(before: GraphFlow[], after: GraphFlow[]) {
  const earlier = new Map(before.map((flow) => [flow.id, flow]));
  const later = new Map(after.map((flow) => [flow.id, flow]));
  return [...new Set([...earlier.keys(), ...later.keys()])].flatMap((id) => {
    const old = earlier.get(id);
    const current = later.get(id);
    if (!old && current) return [{ id, title: current.name, notes: ['新增执行流'] }];
    if (old && !current) return [{ id, title: old.name, notes: ['移除执行流'] }];
    if (!old || !current) return [];
    const oldNodes = new Map(old.nodes.map((node) => [node.id, node]));
    const newNodes = new Map(current.nodes.map((node) => [node.id, node]));
    const notes = [
      ...(old.name !== current.name ? ['改名 · ' + old.name + ' → ' + current.name] : []),
      ...(old.serviceId !== current.serviceId ? ['调整关联发布服务'] : []),
      ...(JSON.stringify(old.inputBindings) !== JSON.stringify(current.inputBindings)
        ? ['调整输入绑定']
        : []),
      ...(JSON.stringify(old.outputBindings) !== JSON.stringify(current.outputBindings)
        ? ['调整输出绑定']
        : []),
      ...(JSON.stringify(old.edgeSelections) !== JSON.stringify(current.edgeSelections)
        ? ['调整选线']
        : []),
      ...old.nodes
        .filter((node) => !newNodes.has(node.id))
        .map((node) => '移除节点 · ' + node.name),
      ...current.nodes.flatMap((node) => {
        const previous = oldNodes.get(node.id);
        if (!previous) return ['新增节点 · ' + node.name + ' · ' + graphNodeLabels[node.type]];
        const changed = nodeProperties
          .filter(([key]) => JSON.stringify(previous[key]) !== JSON.stringify(node[key]))
          .map(([, label]) => label);
        return changed.length ? ['修改节点 · ' + node.name + ' · ' + changed.join('、')] : [];
      }),
      ...edgeChanges(old, current),
    ];
    return notes.length ? [{ id, title: current.name, notes }] : [];
  });
}

export function GraphVersionTools({
  path,
  live,
  versions,
  revision,
  canRestore,
  dirty,
  onRestored,
  onConflict,
}: {
  path: string;
  live: VersionDefinition;
  versions: { version: number }[];
  revision: number;
  canRestore: boolean;
  dirty: boolean;
  onRestored: (graph: GraphDocument, version: number) => void;
  onConflict: () => void;
}) {
  const [compare, setCompare] = useState<number>();
  const [restoring, setRestoring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const previous = useResource<VersionDefinition>(compare ? path + '/versions/' + compare : null);
  const changes =
    compare && previous.data?.version === compare
      ? compareFlows(previous.data.definition.flows, live.definition.flows)
      : undefined;
  async function restore() {
    if (busy || !canRestore || dirty) return;
    setBusy(true);
    setError('');
    try {
      const graph = await post<GraphDocument>(path + '/versions/' + live.version + '/restore', {
        expectedRevision: revision,
      });
      setRestoring(false);
      onRestored(graph, live.version);
    } catch (err) {
      setError(message(err));
      if (err instanceof ApiError && err.status === 409) onConflict();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="graph-properties">
      <div className="graph-flow-select">
        <Field label="对比基准版本">
          <select
            value={compare ?? ''}
            onChange={(event) => setCompare(Number(event.target.value) || undefined)}
            disabled={versions.length < 2}
          >
            <option value="">选择对比版本</option>
            {versions
              .filter(({ version }) => version !== live.version)
              .map(({ version }) => (
                <option key={version} value={version}>
                  v{version}
                </option>
              ))}
          </select>
        </Field>
        {canRestore && (
          <button
            type="button"
            className="button secondary"
            disabled={dirty}
            onClick={() => setRestoring(true)}
          >
            <History size={16} /> 恢复到草稿
          </button>
        )}
      </div>
      {canRestore && dirty && <p className="field-note">先保存当前草稿，再恢复发布版本。</p>}
      {compare && (
        <div className="graph-version-diff">
          <h3>
            <GitCompareArrows size={17} /> v{compare} → v{live.version}
          </h3>
          <ErrorBanner error={previous.error} retry={previous.reload} />
          {previous.loading ? (
            <Loading />
          ) : changes?.length ? (
            <ul>
              {changes.map(({ id, title, notes }) => (
                <li key={id}>
                  <strong>{title}</strong>
                  <ul>
                    {notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : (
            changes && <p>两个版本的执行流配置相同。</p>
          )}
        </div>
      )}
      {restoring && (
        <Confirm
          title={`恢复 v${live.version} 到草稿`}
          description="恢复后可继续编辑，再单独发布为新版本。"
          detail={<p>将覆盖当前服务器上的草稿。</p>}
          label="确认恢复草稿"
          busy={busy}
          error={error}
          onClose={() => {
            if (!busy) {
              setRestoring(false);
              setError('');
            }
          }}
          onConfirm={() => void restore()}
        />
      )}
    </div>
  );
}
