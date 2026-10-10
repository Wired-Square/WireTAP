// ui/src/apps/dashboard/views/panels/StatsOverlay.tsx

import type { SignalRef } from "../../../../stores/dashboardStore";
import type { WindowStats } from "../../../../api/dashboardHistory";
import { textMuted } from "../../../../styles";
import { formatValue } from "../../utils/dashboardFormat";

/** min / avg / max of each signal over the samples the chart holds. */
export default function StatsOverlay({ signals, stats }: { signals: SignalRef[]; stats: (WindowStats | null)[] }) {
  return (
    <div
      className="absolute top-1 right-1 pointer-events-none"
      style={{
        background: "var(--bg-surface)",
        opacity: 0.92,
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        padding: "4px 8px",
        fontSize: 10,
        lineHeight: 1.6,
        zIndex: 10,
      }}
    >
      {signals.map((sig, i) => {
        const s = stats[i];
        return (
          <div key={`${i}:${sig.frameId}:${sig.signalName}`} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: sig.colour, flexShrink: 0 }} />
            <span className={textMuted} style={{ fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>
              {formatValue(s?.min)}
              {" / "}
              {formatValue(s?.mean)}
              {" / "}
              {formatValue(s?.max)}
            </span>
          </div>
        );
      })}
      <div className={textMuted} style={{ fontSize: 9, textAlign: "center", marginTop: 1 }}>
        min / avg / max
      </div>
    </div>
  );
}
