// ui/src/apps/graph/views/panels/list/ListPanel.tsx

import { useGraphStore, getSignalLabel, getConfidenceColour, type GraphPanel } from "../../../../../stores/graphStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { textSecondary } from "../../../../../styles/colourTokens";

interface Props {
  panel: GraphPanel;
}

/** Format a numeric value for display */
function formatValue(v: number): string {
  if (Math.abs(v) >= 10000) return v.toFixed(0);
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 100) return v.toFixed(2);
  return v.toFixed(3);
}

export default function ListPanel({ panel }: Props) {
  const { settings } = useSettings();

  // Subscribe to data updates via stable selectors (avoid returning new arrays)
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const seriesBuffers = useGraphStore((s) => s.seriesBuffers);

  // Compute values in the component body — re-runs when dataVersion changes
  void dataVersion;
  const values = panel.signals.map((sig) => {
    const key = `${sig.frameId}:${sig.signalName}`;
    const series = seriesBuffers.get(key);
    return { key, value: series?.latestValue ?? 0 };
  });

  if (panel.signals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={`text-xs ${textSecondary}`}>
          Click + to add signals
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-2 py-1">
      {panel.signals.map((signal, i) => (
        <div
          key={values[i].key}
          className="flex items-center gap-2 py-1 border-b border-[var(--border-default)] last:border-b-0"
        >
          {/* Confidence dot */}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: getConfidenceColour(signal.confidence, settings) }}
            title={signal.confidence ? `Confidence: ${signal.confidence}` : undefined}
          />

          {/* Signal name */}
          <span className="text-xs text-[color:var(--text-secondary)] truncate flex-1">
            {getSignalLabel(signal)}
          </span>

          {/* Value */}
          <span className="text-xs font-mono font-medium text-[color:var(--text-primary)] tabular-nums shrink-0">
            {formatValue(values[i].value)}
          </span>

          {/* Unit */}
          {signal.unit && (
            <span className="text-[10px] text-[color:var(--text-muted)] shrink-0">
              {signal.unit}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
