// ui/src/apps/graph/views/panels/list/ListPanel.tsx

import { useGraphStore, getSignalLabel, getConfidenceColour, type GraphPanel } from "../../../../../stores/graphStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { emptyStateText } from "../../../../../styles/typography";
import { formatValue } from "../../../utils/graphFormat";
import PanelTooltip from "../PanelTooltip";

interface Props {
  panel: GraphPanel;
}

export default function ListPanel({ panel }: Props) {
  const { settings } = useSettings();

  // Subscribe to data updates via stable selectors (avoid returning new arrays)
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const seriesBuffers = useGraphStore((s) => s.seriesBuffers);

  // Compute values in the component body — re-runs when dataVersion changes
  void dataVersion;
  const signalValues = panel.signals.map((sig) => {
    const key = `${sig.frameId}:${sig.signalName}`;
    const series = seriesBuffers.get(key);
    return { key, value: series?.latestValue ?? 0 };
  });

  const numericValues = signalValues.map((v) => v.value);

  if (panel.signals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={emptyStateText}>Click + to add signals</p>
      </div>
    );
  }

  return (
    <PanelTooltip
      signals={panel.signals}
      values={numericValues}
      settings={settings}
      className="h-full overflow-y-auto px-2 py-1"
    >
      {panel.signals.map((signal, i) => (
        <div
          key={signalValues[i].key}
          className="flex items-center gap-2 py-1 border-b border-[var(--border-default)] last:border-b-0"
        >
          {/* Confidence dot */}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: getConfidenceColour(signal.confidence, settings) }}
          />

          {/* Signal name */}
          <span className="text-xs text-[color:var(--text-secondary)] truncate flex-1">
            {getSignalLabel(signal)}
          </span>

          {/* Value */}
          <span className="text-xs font-mono font-medium text-[color:var(--text-primary)] tabular-nums shrink-0">
            {formatValue(signalValues[i].value)}
          </span>

          {/* Unit */}
          {signal.unit && (
            <span className="text-[10px] text-[color:var(--text-muted)] shrink-0">
              {signal.unit}
            </span>
          )}
        </div>
      ))}
    </PanelTooltip>
  );
}
