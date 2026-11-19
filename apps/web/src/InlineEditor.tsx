import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import './inline-editor.css';

/** Keep the opening control mounted when switching the list to its editor. */
export function useInlineEditor<T>() {
  const [value, setValue] = useState<T>();
  const opener = useRef<HTMLElement | null>(null);
  const change = useCallback((next: T | undefined) => {
    if (next !== undefined) {
      if (document.activeElement instanceof HTMLElement) opener.current = document.activeElement;
    }
    setValue(next);
  }, []);
  useLayoutEffect(() => {
    if (value !== undefined || !opener.current) return;
    if (opener.current.isConnected && opener.current.getClientRects().length)
      opener.current.focus();
    opener.current = null;
  }, [value]);
  return [value, change] as const;
}

export function InlineEditor({
  title,
  description,
  children,
  onClose,
  busy = false,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest('section')?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <section
      className={`panel inline-editor${wide ? ' inline-editor-wide' : ''}`}
      aria-labelledby={titleId}
    >
      <div className="panel-header">
        <div>
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          {description && <p>{description}</p>}
        </div>
        <button
          type="button"
          className="button secondary compact"
          disabled={busy}
          onClick={onClose}
        >
          <ArrowLeft size={16} aria-hidden="true" /> 返回
        </button>
      </div>
      {children}
    </section>
  );
}
