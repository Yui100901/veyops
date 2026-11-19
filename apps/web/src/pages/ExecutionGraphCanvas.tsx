import { useId, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import {
  Box,
  CheckCircle2,
  CirclePlay,
  Clock3,
  FileText,
  GitBranch,
  GitFork,
  GitMerge,
  ListTree,
  ShieldCheck,
  Workflow,
  Upload,
} from 'lucide-react';
import { branchLabel, graphNodeLabels, orderedNodes } from './execution-graph-definition';
import type { GraphFlow } from './execution-graph-definition';

const icons = {
  START: CirclePlay,
  LOG: FileText,
  BUILD: Box,
  DEPLOY_ARTIFACT: Upload,
  CONDITION: GitBranch,
  SWITCH: ListTree,
  DELAY: Clock3,
  APPROVAL: ShieldCheck,
  PARALLEL: GitFork,
  JOIN: GitMerge,
  FLOW_CALL: Workflow,
  END: CheckCircle2,
};
const columnGap = 85;
const rowGap = 42;
const cardWidth = 168;
const cardHeight = 66;
const margin = 20;

function layout(flow: GraphFlow, manual?: { id: string; point: Point }) {
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
    column.forEach((node, lane) =>
      points.set(
        node.id,
        (manual?.id === node.id ? manual.point : node.position) ?? {
          x: margin + level * (cardWidth + columnGap),
          y: margin + (lane + (maxRows - column.length) / 2) * (cardHeight + rowGap),
        },
      ),
    );
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

interface Point {
  x: number;
  y: number;
}
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
  selected = [],
  multiple,
  onSelect,
  onBox,
  onEdgeSelect,
  onMove,
}: {
  flow: GraphFlow;
  selected?: string[];
  multiple?: boolean;
  onSelect?: (id: string, additive: boolean) => void;
  onBox?: (ids: string[]) => void;
  onEdgeSelect?: (index: number) => void;
  onMove?: (id: string, point: Point) => void;
}) {
  const marker = useId();
  const [zoom, setZoom] = useState(100);
  const scale = zoom / 100;
  const [drag, setDrag] = useState<{ start: Point; end: Point }>();
  const [manual, setManual] = useState<{ id: string; point: Point }>();
  const moving = useRef<{ id: string; pointer: Point; position: Point } | null>(null);
  const { points, width, height } = layout(flow, manual);
  function nodePosition(
    event: PointerEvent<HTMLDivElement>,
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
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(width, Math.max(0, (event.clientX - rect.left) / scale)),
      y: Math.min(height, Math.max(0, (event.clientY - rect.top) / scale)),
    };
  };
  return (
    <div className="graph-canvas">
      <div className="graph-canvas-controls">
        <span>执行流画布</span>
        <label>
          缩放{' '}
          <select
            aria-label="画布缩放"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          >
            <option value={60}>60%</option>
            <option value={80}>80%</option>
            <option value={100}>100%</option>
            <option value={120}>120%</option>
          </select>
        </label>
      </div>
      <div className="graph-canvas-scroll" tabIndex={0} aria-label="可滚动的执行流画布">
        <div
          className="graph-canvas-viewport"
          style={{ width: width * scale, height: height * scale }}
        >
          <div
            className={`graph-canvas-content${onMove || multiple ? ' graph-canvas-editing' : ''}`}
            style={{ width, height, transform: `scale(${scale})` }}
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
            <svg className="graph-connectors" width={width} height={height} aria-hidden="true">
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
              </defs>
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
                const path = `M ${start} ${y} C ${start + control} ${y}, ${end - control} ${endY}, ${end} ${endY}`;
                return (
                  <g
                    key={i}
                    className={
                      edge.when ? 'edge-' + edge.when.split(':')[0].toLowerCase() : undefined
                    }
                  >
                    <path d={path} markerEnd={`url(#${marker})`} />
                    {onEdgeSelect && (
                      <path className="graph-edge-hit" d={path} onClick={() => onEdgeSelect(i)} />
                    )}
                    {edge.when && (
                      <text x={midpoint} y={(y + endY) / 2 - 7} textAnchor="middle">
                        {branchLabel(
                          edge.when,
                          flow.nodes.find(({ id }) => id === edge.from),
                        )?.slice(0, 30)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            {flow.nodes.map((node) => {
              const Icon = icons[node.type];
              const location = points.get(node.id)!;
              const style = {
                left: location.x,
                top: location.y,
                width: cardWidth,
                height: cardHeight,
              };
              const label = (
                <>
                  <Icon size={18} />
                  <span>
                    <strong>{node.name || '未命名节点'}</strong>
                    <small>{graphNodeLabels[node.type]}</small>
                  </span>
                </>
              );
              return onSelect ? (
                <button
                  type="button"
                  key={node.id}
                  className="graph-node"
                  style={style}
                  aria-pressed={selected.includes(node.id)}
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
                      onSelect(node.id, Boolean(multiple || e.ctrlKey || e.metaKey || e.shiftKey));
                  }}
                >
                  {label}
                </button>
              ) : (
                <div key={node.id} className="graph-node" style={style}>
                  {label}
                </div>
              );
            })}
            {drag && <div className="graph-selection" style={bounds(drag.start, drag.end)} />}
          </div>
        </div>
      </div>
    </div>
  );
}
