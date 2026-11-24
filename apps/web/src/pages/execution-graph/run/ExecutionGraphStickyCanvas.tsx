import { useId, useState, type ReactNode, type Ref } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import './execution-graph-sticky-canvas.css';

export function scrollBelowGraphCanvas(target: HTMLElement | null, canvas: HTMLElement | null) {
  if (!target) return;
  const offset =
    canvas && window.getComputedStyle(canvas).position === 'sticky'
      ? canvas.getBoundingClientRect().height
      : 0;
  window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - offset - 12 });
}

export function ExecutionGraphStickyCanvas({
  containerRef,
  controls,
  renderCanvas,
}: {
  containerRef: Ref<HTMLDivElement>;
  controls: ReactNode;
  renderCanvas?: (expanded: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  const canvasId = useId();

  return (
    <div className="graph-sticky-canvas" ref={containerRef}>
      <div className="graph-sticky-canvas-toolbar">
        {controls}
        {renderCanvas && (
          <button
            type="button"
            className="button secondary small"
            aria-controls={canvasId}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronUp size={15} aria-hidden="true" />
            ) : (
              <ChevronDown size={15} aria-hidden="true" />
            )}
            {expanded ? '收起画布' : '展开画布'}
          </button>
        )}
      </div>
      {renderCanvas && (
        <div id={canvasId} hidden={!expanded}>
          {renderCanvas(expanded)}
        </div>
      )}
    </div>
  );
}
