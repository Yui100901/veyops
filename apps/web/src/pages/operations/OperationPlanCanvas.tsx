import { useId, useRef, useState, type PointerEvent } from 'react';
import { CirclePlay, GitBranch, Plus, Terminal, Trash2, Workflow } from 'lucide-react';
import { ErrorBanner, Field } from '../../components';

type NodeType = 'START' | 'COMMAND' | 'CONDITION' | 'END';
type Fact = 'OS' | 'PACKAGE_MANAGER';
type ChainNode = {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  command?: string;
  timeout?: number;
  failurePolicy?: 'STOP' | 'CONTINUE';
  fact?: Fact;
};
type ChainEdge = { from: string; to: string; when?: string };
export type Chain = { nodes: ChainNode[]; edges: ChainEdge[] };

const nodeTypes = {
  START: { label: '开始', icon: CirclePlay },
  COMMAND: { label: '命令', icon: Terminal },
  CONDITION: { label: '条件', icon: GitBranch },
  END: { label: '结束', icon: Workflow },
};
const packageManagers = ['apt-get', 'dnf', 'yum', 'zypper', 'apk', 'pacman'];
const nodeWidth = 168;
const nodeHeight = 62;

function chainPath(from: ChainNode, to: ChainNode) {
  const right = to.x >= from.x;
  const startX = from.x + (right ? nodeWidth : 0);
  const endX = to.x + (right ? 0 : nodeWidth);
  const startY = from.y + nodeHeight / 2;
  const endY = to.y + nodeHeight / 2;
  const bend = Math.max(24, Math.abs(startX - endX) / 2) * (right ? 1 : -1);
  return {
    path: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2,
    labelY: (startY + endY) / 2 - 9,
  };
}

export function OperationCanvas({
  chain,
  onChange,
}: {
  chain: Chain;
  onChange?: (chain: Chain) => void;
}) {
  const [selected, setSelected] = useState(
    chain.nodes.find(({ type }) => type === 'COMMAND')?.id ?? '',
  );
  const [connecting, setConnecting] = useState(false);
  const [target, setTarget] = useState('');
  const [branch, setBranch] = useState('');
  const [error, setError] = useState('');
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    moved: boolean;
  }>(undefined);
  const arrow = `${useId().replaceAll(':', '')}-operation-arrow`;
  const current = chain.nodes.find(({ id }) => id === selected);
  const nodeMap = new Map(chain.nodes.map((node) => [node.id, node]));
  const width = Math.max(740, ...chain.nodes.map(({ x }) => x + nodeWidth + 34));
  const height = Math.max(214, ...chain.nodes.map(({ y }) => y + nodeHeight + 30));

  function select(id: string) {
    setSelected(id);
    setConnecting(false);
    setTarget('');
    setBranch('');
    setError('');
  }

  function add(type: Exclude<NodeType, 'START'>) {
    if (chain.nodes.length >= 82) return;
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const x = current ? Math.min(current.x + 45, 19800) : 30;
    const y = Math.min(height - 20, 19800);
    onChange?.({
      ...chain,
      nodes: [
        ...chain.nodes,
        {
          id,
          type,
          name: type === 'COMMAND' ? '执行命令' : type === 'CONDITION' ? '判断目标系统' : '结束',
          x,
          y,
          ...(type === 'COMMAND' && { command: '' }),
          ...(type === 'CONDITION' && { fact: 'PACKAGE_MANAGER' as const }),
        },
      ],
    });
    select(id);
  }

  function patchNode(id: string, patch: Partial<ChainNode>) {
    onChange?.({
      ...chain,
      nodes: chain.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    });
  }

  function addLink(to: string) {
    if (
      !current ||
      current.type === 'END' ||
      !to ||
      to === current.id ||
      nodeMap.get(to)?.type === 'START'
    )
      return;
    const when =
      current.type === 'CONDITION' ? branch.trim().toLowerCase() || undefined : undefined;
    if (chain.edges.some((edge) => edge.from === current.id && edge.when === when)) {
      setError(
        current.type === 'CONDITION'
          ? '这个分支已有连线，请先删除原连线。'
          : '当前节点已有出线，请先删除原连线。',
      );
      return;
    }
    onChange?.({ ...chain, edges: [...chain.edges, { from: current.id, to, when }] });
    setTarget('');
    setBranch('');
    setError('');
    setConnecting(false);
  }

  function pointerDown(event: PointerEvent<HTMLButtonElement>, node: ChainNode) {
    if (!onChange || event.button !== 0 || connecting) return;
    drag.current = {
      id: node.id,
      x: node.x,
      y: node.y,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const point = drag.current;
    if (!point) return;
    const dx = event.clientX - point.clientX;
    const dy = event.clientY - point.clientY;
    if (!point.moved && Math.hypot(dx, dy) < 4) return;
    point.moved = true;
    patchNode(point.id, {
      x: Math.min(20_000, Math.max(8, point.x + dx)),
      y: Math.min(20_000, Math.max(8, point.y + dy)),
    });
  }

  return (
    <div className="operation-chain">
      {onChange && (
        <div className="operation-chain-tools" aria-label="画布工具">
          <button type="button" className="button compact" onClick={() => add('COMMAND')}>
            <Plus size={15} /> 命令节点
          </button>
          <button type="button" className="button compact" onClick={() => add('CONDITION')}>
            <Plus size={15} /> 条件节点
          </button>
          <button type="button" className="button compact" onClick={() => add('END')}>
            <Plus size={15} /> 结束节点
          </button>
          <span className="field-note">拖动节点调整位置，选择节点后配置命令或连线。</span>
        </div>
      )}
      <div className="operation-chain-scroll" aria-label="运维执行链画布">
        <div
          className={`operation-chain-canvas ${connecting ? 'connecting' : ''}`}
          style={{ width, height }}
        >
          <svg aria-hidden="true" width={width} height={height}>
            <defs>
              <marker id={arrow} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M 0 0 L 7 3.5 L 0 7 z" />
              </marker>
            </defs>
            {chain.edges.map((edge, index) => {
              const from = nodeMap.get(edge.from);
              const to = nodeMap.get(edge.to);
              if (!from || !to) return null;
              const { path, labelX, labelY } = chainPath(from, to);
              return (
                <g
                  key={`${edge.from}-${edge.to}-${index}`}
                  className={from.type === 'CONDITION' ? 'conditional' : ''}
                >
                  <path d={path} markerEnd={`url(#${arrow})`} />
                  {from.type === 'CONDITION' && (
                    <text x={labelX} y={labelY} textAnchor="middle">
                      {edge.when ?? '默认'}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {chain.nodes.map((node) => {
            const { icon: Icon, label } = nodeTypes[node.type];
            return (
              <button
                key={node.id}
                type="button"
                className={`operation-chain-node ${node.type.toLowerCase()}`}
                style={{ left: node.x, top: node.y, width: nodeWidth, height: nodeHeight }}
                aria-pressed={selected === node.id}
                onPointerDown={(event) => pointerDown(event, node)}
                onPointerMove={pointerMove}
                onPointerCancel={() => {
                  drag.current = undefined;
                }}
                onClick={() => {
                  const moved = drag.current?.moved;
                  drag.current = undefined;
                  if (connecting && selected !== node.id) addLink(node.id);
                  else if (!moved || selected !== node.id) select(node.id);
                }}
              >
                <Icon size={19} aria-hidden="true" />
                <span>
                  <small>{label}</small>
                  <strong title={node.name}>{node.name || '未命名'}</strong>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {current && (
        <div className="operation-chain-details" key={current.id}>
          <div className="operation-chain-details-title">
            <strong>
              {nodeTypes[current.type].label}节点 · {current.name || '未命名'}
            </strong>
            {onChange && current.type !== 'START' && (
              <button
                type="button"
                className="button compact"
                onClick={() => {
                  onChange({
                    nodes: chain.nodes.filter(({ id }) => id !== current.id),
                    edges: chain.edges.filter(
                      ({ from, to }) => from !== current.id && to !== current.id,
                    ),
                  });
                  select('');
                }}
              >
                <Trash2 size={15} /> 删除节点
              </button>
            )}
          </div>
          {onChange && (
            <div className="operation-chain-fields">
              <Field label="节点名称">
                <input
                  value={current.name}
                  maxLength={120}
                  onChange={(event) => patchNode(current.id, { name: event.target.value })}
                />
              </Field>
              {current.type === 'CONDITION' && (
                <Field label="判断依据">
                  <select
                    value={current.fact ?? 'PACKAGE_MANAGER'}
                    onChange={(event) => {
                      patchNode(current.id, { fact: event.target.value as Fact });
                      setBranch('');
                    }}
                  >
                    <option value="PACKAGE_MANAGER">目标主机包管理器</option>
                    <option value="OS">Linux 发行版</option>
                  </select>
                </Field>
              )}
              {current.type === 'COMMAND' && (
                <>
                  <Field label="超时（秒）">
                    <input
                      type="number"
                      min={1}
                      max={3600}
                      placeholder="沿用系统设置"
                      value={current.timeout ?? ''}
                      onChange={(event) =>
                        patchNode(current.id, {
                          timeout:
                            event.target.value === '' ? undefined : event.target.valueAsNumber,
                        })
                      }
                    />
                  </Field>
                  <Field label="命令失败后">
                    <select
                      value={current.failurePolicy ?? 'STOP'}
                      onChange={(event) =>
                        patchNode(current.id, {
                          failurePolicy: event.target.value as 'STOP' | 'CONTINUE',
                        })
                      }
                    >
                      <option value="STOP">停止当前执行链</option>
                      <option value="CONTINUE">继续后续节点</option>
                    </select>
                  </Field>
                </>
              )}
            </div>
          )}
          {current.type === 'COMMAND' &&
            (onChange ? (
              <Field label="Shell 命令">
                <textarea
                  className="operation-chain-command"
                  rows={5}
                  value={current.command ?? ''}
                  maxLength={65536}
                  onChange={(event) => patchNode(current.id, { command: event.target.value })}
                />
              </Field>
            ) : (
              <pre className="operation-plan-command">{current.command}</pre>
            ))}
          {current.type === 'CONDITION' && !onChange && (
            <span className="field-note">
              判断依据 · {current.fact === 'OS' ? 'Linux 发行版' : '目标主机包管理器'}
            </span>
          )}
          {current.type !== 'END' && (
            <>
              <div className="operation-chain-links">
                {chain.edges.map(
                  (edge, index) =>
                    edge.from === current.id && (
                      <span key={`${edge.to}-${index}`}>
                        {current.type === 'CONDITION' && <small>{edge.when ?? '默认分支'}</small>}
                        {nodeMap.get(edge.to)?.name ?? '未知节点'}
                        {onChange && (
                          <button
                            type="button"
                            className="icon-button bare"
                            aria-label={`删除到 ${nodeMap.get(edge.to)?.name ?? '节点'} 的连线`}
                            onClick={() =>
                              onChange({
                                ...chain,
                                edges: chain.edges.filter(
                                  (_entry, edgeIndex) => index !== edgeIndex,
                                ),
                              })
                            }
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </span>
                    ),
                )}
              </div>
              {onChange && (
                <div className="operation-chain-connect">
                  {current.type === 'CONDITION' &&
                    (current.fact === 'OS' ? (
                      <Field label="分支值">
                        <input
                          placeholder="如 ubuntu，留空为默认"
                          maxLength={48}
                          value={branch}
                          onChange={(event) => setBranch(event.target.value)}
                        />
                      </Field>
                    ) : (
                      <Field label="分支值">
                        <select value={branch} onChange={(event) => setBranch(event.target.value)}>
                          <option value="">默认分支</option>
                          {packageManagers.map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                        </select>
                      </Field>
                    ))}
                  <Field label="连接到">
                    <select value={target} onChange={(event) => setTarget(event.target.value)}>
                      <option value="">选择节点</option>
                      {chain.nodes
                        .filter(({ id, type }) => id !== current.id && type !== 'START')
                        .map(({ id, name, type }) => (
                          <option key={id} value={id}>
                            {name} · {nodeTypes[type].label}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <button
                    type="button"
                    className="button compact"
                    disabled={!target}
                    onClick={() => addLink(target)}
                  >
                    添加连线
                  </button>
                  <button
                    type="button"
                    className="button compact"
                    aria-pressed={connecting}
                    onClick={() => setConnecting(!connecting)}
                  >
                    {connecting ? '取消选取' : '从画布选取'}
                  </button>
                </div>
              )}
            </>
          )}
          <ErrorBanner error={error} />
        </div>
      )}
    </div>
  );
}
