import type { GraphActionSource } from './graph-action-sources';

type SourceTarget = {
  nodeId: string;
  fieldId?: string;
  section?: 'input' | 'output';
};

export function ExecutionGraphInputSummary({
  entries,
  onSource,
}: {
  entries: GraphActionSource[];
  onSource?: (target: SourceTarget) => void;
}) {
  if (!entries.length) return null;
  return (
    <dl className="graph-action-sources" aria-label="实际数据来源">
      {entries.map(({ label, sources, grouped }) => (
        <div key={label}>
          <dt>
            {label}
            {!grouped && '来自'}
          </dt>
          <dd>
            {sources.map(({ name, nodeId, fieldId, section }, index) => {
              const target = nodeId ? { nodeId, fieldId, section } : undefined;
              if (target && onSource)
                return (
                  <button
                    key={index}
                    type="button"
                    className="button secondary small"
                    onClick={() => onSource(target)}
                  >
                    {name}
                  </button>
                );
              return <span key={index}>{name}</span>;
            })}
          </dd>
        </div>
      ))}
    </dl>
  );
}
