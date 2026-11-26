import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
  DragEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { upstreamTriggerLinks } from './graph-trigger-model';
import {
  Box,
  CheckCircle2,
  CirclePlay,
  Clock3,
  Code2,
  Copy,
  Download,
  FileText,
  GitBranch,
  GitFork,
  GitMerge,
  HeartPulse,
  ListTree,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Unlink2,
  Workflow,
  Upload,
  X,
} from 'lucide-react';
import {
  branchLabel,
  effectiveNodeType,
  graphNodeFamily,
  graphNodeTypeLabel,
  orderedNodes,
} from '../execution-graph-definition';
import type { GraphCanvas, GraphEdge, GraphFlow, GraphNode } from '../execution-graph-definition';

const icons = {
  START: CirclePlay,
  LOG: FileText,
  BUILD: Box,
  SOURCE_REVIEW: GitMerge,
  DEPLOY_ARTIFACT: Upload,
  HEALTH_CHECK: HeartPulse,
  ROLLBACK_ARTIFACT: RotateCcw,
  CONDITION: GitBranch,
  SWITCH: ListTree,
  DELAY: Clock3,
  APPROVAL: ShieldCheck,
  PARALLEL: GitFork,
  JOIN: GitMerge,
  FLOW_CALL: Workflow,
  CHECKOUT: Download,
  CHECK: ShieldCheck,
  LOAD_ENV: ListTree,
  REGISTER_ARTIFACT: Box,
  SHELL: Code2,
  END: CheckCircle2,
};
const columnGap = 76;
const rowGap = 38;
const cardWidth = 154;
const cardHeight = 60;
const margin = 18;
const minZoom = 50;
const maxZoom = 100;

const clampZoom = (value: number) => Math.max(minZoom, Math.min(maxZoom, value));

function layout(
  flow: GraphFlow,
  { autoLayout, manual }: { autoLayout?: boolean; manual?: { id: string; point: Point } } = {},
) {
  const nodes = orderedNodes(flow);
  const depth = new Map<string, number>();
  const columns: (typeof nodes)[] = [];
  for (const node of nodes) {
    const column = Math.max(
      0,
      ...flow.edges
        .filter((edge) => edge.to === node.id && depth.has(edge.from))
        .map((edge) => depth.get(edge.from)! + 1),
    );
    depth.set(node.id, column);
    columns[column] ??= [];
    columns[column].push(node);
  }
  const maxRows = Math.max(1, ...columns.map((col) => col.length));
  const points = new Map<string, { x: number; y: number }>();
  columns.forEach((column, level) => {
    column.forEach((node, lane) => {
      const saved = autoLayout ? undefined : manual?.id === node.id ? manual.point : node.position;
      points.set(
        node.id,
        saved ?? {
          x: margin + level * (cardWidth + columnGap),
          y: margin + (lane + (maxRows - column.length) / 2) * (cardHeight + rowGap),
        },
      );
    });
  });
  const coords = [...points.values()];
  return {
    points,
    width: Math.max(
      margin * 2 +
        Math.max(1, columns.length) * cardWidth +
        Math.max(0, columns.length - 1) * columnGap,
      ...coords.map(({ x }) => x + cardWidth + margin),
    ),
    height: Math.max(
      margin * 2 + maxRows * cardHeight + (maxRows - 1) * rowGap,
      ...coords.map(({ y }) => y + cardHeight + margin),
    ),
  };
}

export function placeFlowTemplate(canvas: GraphCanvas, fragment: GraphCanvas): GraphNode[] {
  const nodes = [...canvas.nodes, ...fragment.nodes];
  const edges = [...canvas.edges, ...fragment.edges];
  const { points } = layout({ id: '', name: '', nodes, edges });
  const occupied = canvas.nodes.map(({ id }) => points.get(id)!);
  const base = fragment.nodes.map(({ id }) => points.get(id)!);
  const left = Math.min(...base.map(({ x }) => x));
  const top = Math.min(...base.map(({ y }) => y));
  const right = Math.max(...base.map(({ x }) => x)) + cardWidth;
  const bottom = Math.max(...base.map(({ y }) => y)) + cardHeight;
  const width = right - left;
  const height = bottom - top;
  for (let x = margin; x + width <= 30000; x += cardWidth + columnGap) {
    for (let y = margin; y + height <= 30000; y += cardHeight + rowGap) {
      // Keep each inserted chain together, with room to connect or drag its nodes.
      if (
        occupied.some(
          (p) =>
            p.x < x + width + rowGap / 2 &&
            p.x + cardWidth + rowGap / 2 > x &&
            p.y < y + height + rowGap / 2 &&
            p.y + cardHeight + rowGap / 2 > y,
        )
      )
        continue;
      return fragment.nodes.map((node, i) => ({
        ...node,
        position: { x: Math.round(x + base[i]!.x - left), y: Math.round(y + base[i]!.y - top) },
      }));
    }
  }
  throw new Error('画布空间不足，无法放置整条执行流。');
}

interface Point {
  x: number;
  y: number;
}

type MenuTarget = { kind: 'node'; id: string } | { kind: 'edge'; index: number };
type CanvasMenuState = { target: MenuTarget; point: Point; trigger: HTMLElement | SVGElement };

export const graphDragType = 'application/x-veyops-graph-node';

function bounds(start: Point, end: Point) {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x),
    height: Math.abs(start.y - end.y),
  };
}

export function NodeMap({
  flow,
  autoLayout = false,
  triggerLinks = [],
  selected = [],
  multiple,
  onSelect,
  onBox,
  onEdgeSelect,
  onMove,
  onDropNode,
  onNodeCopy,
  onNodeDelete,
  onEdgeDelete,
  selectedEdge,
  onHighlight,
  highlighted,
  highlightEdges,
  reveal,
  connecting,
  onConnectSource,
  onConnectTarget,
  isConnectTarget,
  isRunnableStart,
  nodeSummary,
}: {
  flow: GraphFlow;
  autoLayout?: boolean;
  triggerLinks?: ReturnType<typeof upstreamTriggerLinks>;
  selected?: string[];
  multiple?: boolean;
  onSelect?: (id: string, additive: boolean) => void;
  onBox?: (ids: string[]) => void;
  onEdgeSelect?: (index: number) => void;
  onMove?: (id: string, point: Point) => void;
  onDropNode?: (payload: string, point: Point) => void;
  onNodeCopy?: (id: string, point: Point) => void;
  onNodeDelete?: (id: string) => void;
  onEdgeDelete?: (index: number) => void;
  selectedEdge?: number;
  onHighlight?: (id?: string) => void;
  highlighted?: Set<string>;
  highlightEdges?: Set<number>;
  reveal?: { nodeId: string } | { edge: GraphEdge };
  connecting?: string;
  onConnectSource?: (id: string) => void;
  onConnectTarget?: (id: string) => void;
  isConnectTarget?: (id: string) => boolean;
  isRunnableStart?: (id: string) => boolean;
  nodeSummary?: (node: GraphNode) => string | undefined;
}) {
  const marker = useId();
  const [zoomOverride, setZoomOverride] = useState<number>();
  const [fitZoom, setFitZoom] = useState(maxZoom);
  const zoom = zoomOverride ?? (autoLayout ? fitZoom : maxZoom);
  const scale = zoom / 100;
  const [drag, setDrag] = useState<{ start: Point; end: Point }>();
  const [manual, setManual] = useState<{ id: string; point: Point }>();
  const [menu, setMenu] = useState<CanvasMenuState>();
  const scroll = useRef<HTMLDivElement>(null);
  const moving = useRef<{ id: string; pointer: Point; position: Point } | null>(null);
  const { points, width: layoutWidth, height: layoutHeight } = layout(flow, { autoLayout, manual });
  const repeated = new Map<string, number[]>();
  flow.edges.forEach(({ from, to }, index) => {
    const key = JSON.stringify([from, to]);
    const indices = repeated.get(key) ?? [];
    indices.push(index);
    repeated.set(key, indices);
  });
  const offsets = new Map<number, number>();
  for (const indices of repeated.values())
    indices.forEach((index, slot) => offsets.set(index, (slot - (indices.length - 1) / 2) * 24));
  const width = onDropNode ? Math.max(layoutWidth + 170, 640) : layoutWidth;
  const height = onDropNode ? Math.max(layoutHeight + 100, 360) : layoutHeight;
  const visibleTriggerLinks = triggerLinks.flatMap((link) => {
    const from = points.get(link.from);
    const to = points.get(link.to);
    return from && to ? [{ ...link, from, to }] : [];
  });
  const target = reveal && 'nodeId' in reveal ? points.get(reveal.nodeId) : undefined;
  const edge = reveal && 'edge' in reveal ? reveal.edge : undefined;
  const edgeFrom = edge && points.get(edge.from);
  const edgeTo = edge && points.get(edge.to);
  const revealX = target
    ? target.x + cardWidth / 2
    : edgeFrom && edgeTo && (edgeFrom.x + edgeTo.x + cardWidth) / 2;
  const revealY = target
    ? target.y + cardHeight / 2
    : edgeFrom && edgeTo && (edgeFrom.y + edgeTo.y + cardHeight) / 2;

  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!autoLayout || !viewport) return;
    const fit = () => {
      if (viewport.clientWidth)
        setFitZoom(clampZoom(Math.floor((viewport.clientWidth / width) * 100)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [autoLayout, width]);

  useLayoutEffect(() => {
    const viewport = scroll.current;
    if (!viewport || revealX === undefined || revealY === undefined) return;
    viewport.scrollTo({
      left: Math.max(0, revealX * scale - viewport.clientWidth / 2),
      top: Math.max(0, revealY * scale - viewport.clientHeight / 2),
    });
  }, [reveal, revealX, revealY, scale]);

  function openMenu(
    event: MouseEvent<HTMLElement | SVGElement> | KeyboardEvent<HTMLElement | SVGElement>,
    target: MenuTarget,
  ) {
    if ('key' in event && event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
      return;
    event.preventDefault();
    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();
    const point =
      'key' in event
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : { x: event.clientX, y: event.clientY };
    setMenu({ target, point, trigger });
    if (target.kind === 'node') onSelect?.(target.id, false);
    else onEdgeSelect?.(target.index);
  }

  function menuItems(target: MenuTarget) {
    if (target.kind === 'edge') {
      const remove = onEdgeDelete;
      if (!remove || !flow.edges[target.index]) return [];
      return [
        { label: '断开连线', icon: Unlink2, action: () => remove(target.index), danger: true },
      ];
    }
    const location = points.get(target.id);
    const copy = onNodeCopy;
    const remove = onNodeDelete;
    if (!location || !copy || !remove) return [];
    return [
      { label: '复制节点', icon: Copy, action: () => copy(target.id, location) },
      { label: '删除节点', icon: Trash2, action: () => remove(target.id), danger: true },
    ];
  }

  const closeMenu = useCallback(
    (reason?: 'action' | 'key') => {
      setMenu(undefined);
      if (!menu || !reason) return;
      const { trigger } = menu;
      if (reason === 'key') trigger.focus({ preventScroll: true });
      else
        window.requestAnimationFrame(() => {
          if (document.activeElement === document.body)
            (trigger.isConnected ? trigger : scroll.current)?.focus({ preventScroll: true });
        });
    },
    [menu],
  );

  const items = menu ? menuItems(menu.target) : [];
  function nodePosition(
    event: ReactPointerEvent<HTMLDivElement>,
    origin: NonNullable<typeof moving.current>,
  ) {
    return {
      x: Math.max(
        0,
        Math.min(30000, Math.round(origin.position.x + (event.clientX - origin.pointer.x) / scale)),
      ),
      y: Math.max(
        0,
        Math.min(30000, Math.round(origin.position.y + (event.clientY - origin.pointer.y) / scale)),
      ),
    };
  }
  const point = (event: ReactPointerEvent<HTMLDivElement> | DragEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(width, Math.max(0, (event.clientX - rect.left) / scale)),
      y: Math.min(height, Math.max(0, (event.clientY - rect.top) / scale)),
    };
  };
  return (
    <div className="graph-canvas">
      <div className="graph-canvas-controls">
        <span>{onDropNode ? '项目画布' : '执行流画布'}</span>
        {visibleTriggerLinks.length > 0 && (
          <span
            className="graph-trigger-legend"
            title={visibleTriggerLinks.map(({ name }) => name).join('、')}
          >
            上游触发
          </span>
        )}
        <div className="graph-canvas-zoom">
          <label htmlFor={`${marker}-zoom`}>缩放</label>
          <input
            id={`${marker}-zoom`}
            aria-label="画布缩放"
            aria-valuetext={`${zoom}%`}
            type="range"
            min={minZoom}
            max={maxZoom}
            step={1}
            value={zoom}
            onChange={(event) => setZoomOverride(clampZoom(event.currentTarget.valueAsNumber))}
          />
          <button
            type="button"
            aria-label={autoLayout ? '适应画布宽度' : '恢复 100% 缩放'}
            title={autoLayout ? '适应画布宽度' : '恢复 100% 缩放'}
            onClick={() => setZoomOverride(undefined)}
          >
            {zoom}%
          </button>
        </div>
      </div>
      <div
        className="graph-canvas-scroll"
        ref={scroll}
        tabIndex={0}
        aria-label="可滚动的执行流画布"
      >
        <div
          className="graph-canvas-viewport"
          style={{ width: width * scale, height: height * scale }}
        >
          <div
            className={`graph-canvas-content${onMove || multiple ? ' graph-canvas-editing' : ''}`}
            style={{ width, height, transform: `scale(${scale})` }}
            onDragOver={
              onDropNode
                ? (event) => {
                    if (!event.dataTransfer.types.includes(graphDragType)) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                  }
                : undefined
            }
            onDrop={
              onDropNode
                ? (event) => {
                    const payload = event.dataTransfer.getData(graphDragType);
                    if (!payload) return;
                    event.preventDefault();
                    const target = point(event);
                    onDropNode(payload, {
                      x: Math.min(30000, Math.max(0, Math.round(target.x - cardWidth / 2))),
                      y: Math.min(30000, Math.max(0, Math.round(target.y - cardHeight / 2))),
                    });
                  }
                : undefined
            }
            onPointerDown={(event) => {
              if (!onBox || event.button !== 0 || !multiple || event.target !== event.currentTarget)
                return;
              const start = point(event);
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({ start, end: start });
            }}
            onPointerMove={(event) => {
              if (drag) setDrag({ start: drag.start, end: point(event) });
              if (moving.current)
                setManual({ id: moving.current.id, point: nodePosition(event, moving.current) });
            }}
            onPointerUp={(event) => {
              if (moving.current) {
                const next = nodePosition(event, moving.current);
                if (
                  Math.abs(next.x - moving.current.position.x) +
                    Math.abs(next.y - moving.current.position.y) >
                  3
                )
                  onMove?.(moving.current.id, next);
                else
                  onSelect?.(
                    moving.current.id,
                    Boolean(multiple || event.ctrlKey || event.metaKey || event.shiftKey),
                  );
                moving.current = null;
                setManual(undefined);
                return;
              }
              if (!drag) return;
              const rect = bounds(drag.start, point(event));
              setDrag(undefined);
              if (rect.width + rect.height < 8) return;
              onBox?.(
                [...points]
                  .filter(
                    ([, value]) =>
                      value.x + cardWidth >= rect.left &&
                      value.x <= rect.left + rect.width &&
                      value.y + cardHeight >= rect.top &&
                      value.y <= rect.top + rect.height,
                  )
                  .map(([id]) => id),
              );
            }}
            onPointerCancel={() => {
              moving.current = null;
              setManual(undefined);
              setDrag(undefined);
            }}
          >
            <svg
              className="graph-connectors"
              width={width}
              height={height}
              aria-hidden={onEdgeSelect ? undefined : true}
            >
              <defs>
                <marker
                  id={marker}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrow" />
                </marker>
                <marker
                  id={marker + '-trigger'}
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="graph-trigger-arrow" />
                </marker>
              </defs>
              {visibleTriggerLinks.map(({ id, name, from, to }, index) => {
                const start = from.x + cardWidth / 2;
                const end = to.x + cardWidth / 2;
                const above = Math.min(from.y, to.y) >= 24;
                const y = from.y + (above ? 0 : cardHeight);
                const endY = to.y + (above ? -4 : cardHeight + 4);
                const bend = 12 + (index % 3) * 5;
                const lane = above
                  ? Math.max(7, Math.min(y, endY) - bend)
                  : Math.min(height - 6, Math.max(y, endY) + bend);
                return (
                  <g key={id} className="graph-trigger-connector">
                    <title>{name}</title>
                    <path
                      d={`M ${start} ${y} V ${lane} H ${end} V ${endY}`}
                      markerEnd={`url(#${marker}-trigger)`}
                    />
                  </g>
                );
              })}
              {flow.edges.map((edge, i) => {
                const from = points.get(edge.from);
                const to = points.get(edge.to);
                if (!from || !to) return null;
                const start = from.x + cardWidth;
                const end = to.x - 5;
                const y = from.y + cardHeight / 2;
                const endY = to.y + cardHeight / 2;
                const midpoint = (start + end) / 2;
                const control = Math.max(25, (end - start) / 2);
                const offset = offsets.get(i) ?? 0;
                const label = branchLabel(
                  edge.when,
                  flow.nodes.find(({ id }) => id === edge.from),
                );
                const path = `M ${start} ${y} C ${start + control} ${y + offset}, ${end - control} ${endY + offset}, ${end} ${endY}`;
                return (
                  <g
                    key={JSON.stringify([edge.from, edge.to, edge.when])}
                    className={[
                      edge.when && 'edge-' + edge.when.split(':')[0].toLowerCase(),
                      highlightEdges?.has(i) && 'graph-edge-highlighted',
                      selectedEdge === i && 'graph-edge-selected',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <path d={path} markerEnd={`url(#${marker})`} />
                    {onEdgeSelect && (
                      <path
                        className="graph-edge-hit"
                        d={path}
                        role="button"
                        tabIndex={0}
                        aria-label={`连线 ${flow.nodes.find((n) => n.id === edge.from)?.name} → ${flow.nodes.find((n) => n.id === edge.to)?.name}${label ? ` · ${label}` : ''}`}
                        aria-pressed={selectedEdge === i}
                        aria-haspopup={onEdgeDelete ? 'menu' : undefined}
                        onContextMenu={
                          onEdgeDelete
                            ? (event) => openMenu(event, { kind: 'edge', index: i })
                            : undefined
                        }
                        onClick={() => onEdgeSelect(i)}
                        onKeyDown={(event) => {
                          if (onEdgeDelete) openMenu(event, { kind: 'edge', index: i });
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          onEdgeSelect(i);
                        }}
                      />
                    )}
                    {edge.when && (
                      <text x={midpoint} y={(y + endY) / 2 - 7 + 0.75 * offset} textAnchor="middle">
                        {label?.slice(0, 30)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {onEdgeDelete &&
              selectedEdge !== undefined &&
              (() => {
                const edge = flow.edges[selectedEdge];
                const from = edge && points.get(edge.from),
                  to = edge && points.get(edge.to);
                return (
                  from &&
                  to && (
                    <button
                      type="button"
                      className="graph-edge-remove"
                      aria-label="删除所选连线"
                      aria-haspopup="menu"
                      title="删除连线"
                      style={{
                        left: (from.x + cardWidth + to.x) / 2,
                        top:
                          (from.y + to.y + cardHeight) / 2 +
                          9 +
                          0.75 * (offsets.get(selectedEdge) ?? 0),
                      }}
                      onClick={() => onEdgeDelete(selectedEdge)}
                      onContextMenu={(event) =>
                        openMenu(event, { kind: 'edge', index: selectedEdge })
                      }
                      onKeyDown={(event) => openMenu(event, { kind: 'edge', index: selectedEdge })}
                    >
                      <X size={16} />
                    </button>
                  )
                );
              })()}
            {flow.nodes.map((node) => {
              const nodeType = effectiveNodeType(node);
              const family = graphNodeFamily(node);
              const Icon = icons[nodeType];
              const runnable = node.type === 'START' && isRunnableStart?.(node.id);
              const hasMenu = onNodeCopy && onNodeDelete;
              const location = points.get(node.id)!;
              const style = {
                left: location.x,
                top: location.y,
                width: cardWidth,
                height: cardHeight,
              };
              const className = `graph-node${highlighted?.has(node.id) ? ' graph-node-highlighted' : ''}${runnable ? ' graph-node-runnable' : ''}`;
              const summary = nodeSummary?.(node);
              const label = (
                <>
                  <Icon size={16} />
                  <span>
                    <strong>{node.name || '未命名节点'}</strong>
                    <small title={summary ?? undefined}>
                      {summary || (runnable ? '开始 · 手动运行' : graphNodeTypeLabel(node))}
                    </small>
                  </span>
                </>
              );
              return onSelect ? (
                <div key={node.id}>
                  <button
                    type="button"
                    className={className}
                    data-node-type={nodeType}
                    data-node-family={family}
                    style={style}
                    aria-pressed={selected.includes(node.id)}
                    aria-label={runnable ? `运行 ${node.name}` : undefined}
                    aria-haspopup={hasMenu ? 'menu' : undefined}
                    onContextMenu={
                      hasMenu
                        ? (event) => openMenu(event, { kind: 'node', id: node.id })
                        : undefined
                    }
                    onKeyDown={
                      hasMenu
                        ? (event) => openMenu(event, { kind: 'node', id: node.id })
                        : undefined
                    }
                    onPointerEnter={() =>
                      onHighlight?.(node.type === 'START' ? node.id : undefined)
                    }
                    onPointerLeave={() => onHighlight?.()}
                    onFocus={() => onHighlight?.(node.type === 'START' ? node.id : undefined)}
                    onBlur={() => onHighlight?.()}
                    onPointerDown={
                      onMove
                        ? (event) => {
                            if (event.button !== 0) return;
                            event.currentTarget.setPointerCapture(event.pointerId);
                            moving.current = {
                              id: node.id,
                              pointer: { x: event.clientX, y: event.clientY },
                              position: location,
                            };
                          }
                        : undefined
                    }
                    onClick={(e) => {
                      if (!onMove || !e.detail)
                        onSelect(
                          node.id,
                          Boolean(multiple || e.ctrlKey || e.metaKey || e.shiftKey),
                        );
                    }}
                  >
                    {label}
                  </button>
                  {onConnectSource && node.type !== 'END' && (
                    <button
                      type="button"
                      className="graph-port graph-port-out"
                      title="从此节点连线"
                      aria-label={`从 ${node.name} 开始连线`}
                      aria-pressed={connecting === node.id}
                      style={{ left: location.x + cardWidth, top: location.y + cardHeight / 2 }}
                      onClick={() => onConnectSource(node.id)}
                    />
                  )}
                  {onConnectTarget &&
                    connecting &&
                    connecting !== node.id &&
                    (!isConnectTarget || isConnectTarget(node.id)) &&
                    node.type !== 'START' && (
                      <button
                        type="button"
                        className="graph-port graph-port-in"
                        title="连接到此节点"
                        aria-label={`连接到 ${node.name}`}
                        style={{ left: location.x, top: location.y + cardHeight / 2 }}
                        onClick={() => onConnectTarget(node.id)}
                      />
                    )}
                </div>
              ) : (
                <div
                  key={node.id}
                  className={className}
                  data-node-type={nodeType}
                  data-node-family={family}
                  style={style}
                >
                  {label}
                </div>
              );
            })}
            {drag && <div className="graph-selection" style={bounds(drag.start, drag.end)} />}
          </div>
        </div>
      </div>
      {menu && items.length > 0 && (
        <CanvasMenu point={menu.point} items={items} onClose={closeMenu} />
      )}
    </div>
  );
}

function CanvasMenu({
  point,
  items,
  onClose,
}: {
  point: Point;
  items: { label: string; icon: typeof Copy; action: () => void; danger?: boolean }[];
  onClose: (reason?: 'action' | 'key') => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current!;
    const rect = element.getBoundingClientRect();
    element.style.left = Math.max(8, Math.min(point.x, window.innerWidth - rect.width - 8)) + 'px';
    element.style.top = Math.max(8, Math.min(point.y, window.innerHeight - rect.height - 8)) + 'px';
    element.querySelector('button')?.focus({ preventScroll: true });
  }, [point]);
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) onClose();
    }
    function dismiss() {
      onClose();
    }
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="graph-context-menu"
      role="menu"
      aria-label="画布操作"
      ref={menu}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          onClose('key');
          return;
        }
        const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
        const active = buttons.findIndex((item) => item === document.activeElement);
        const positions: Partial<Record<string, number>> = {
          ArrowDown: (active + 1) % buttons.length,
          ArrowUp: (active - 1 + buttons.length) % buttons.length,
          Home: 0,
          End: buttons.length - 1,
        };
        const next = positions[event.key];
        if (next === undefined) return;
        event.preventDefault();
        buttons[next]?.focus();
      }}
    >
      {items.map(({ label, icon: Icon, action, danger }) => (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={danger ? 'graph-context-danger' : undefined}
          key={label}
          onClick={() => {
            action();
            onClose('action');
          }}
        >
          <Icon size={16} aria-hidden="true" /> {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
