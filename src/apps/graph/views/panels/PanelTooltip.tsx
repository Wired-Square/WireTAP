// ui/src/apps/graph/views/panels/PanelTooltip.tsx
//
// Shared hover tooltip for graph panels (gauge, list).
// Wraps children and shows a portalled tooltip with signal details on hover.

import { useState, useRef, useCallback, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getSignalLabel, getConfidenceColour, type SignalRef } from "../../../../stores/graphStore";
import type { AppSettings } from "../../../../hooks/useSettings";

/** Format a numeric value for tooltip display */
function formatValue(v: number): string {
  if (Math.abs(v) >= 10000) return v.toFixed(0);
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 100) return v.toFixed(2);
  return v.toFixed(3);
}

interface PanelTooltipProps {
  signals: SignalRef[];
  /** Parallel array matching signals — latest value per signal */
  values: number[];
  settings: AppSettings | null;
  /** Show a colour dot per signal (uses signal.colour). Default: false */
  showColourDot?: boolean;
  children: ReactNode;
  className?: string;
}

export default function PanelTooltip({
  signals,
  values,
  settings,
  showColourDot = false,
  children,
  className,
}: PanelTooltipProps) {
  const [tip, setTip] = useState<{ x: number; y: number; visible: boolean }>({ x: 0, y: 0, visible: false });
  const tipRef = useRef<HTMLDivElement>(null);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    setTip({ x: e.clientX, y: e.clientY, visible: true });
  }, []);

  const onMouseLeave = useCallback(() => {
    setTip((prev) => ({ ...prev, visible: false }));
  }, []);

  // Edge-aware positioning
  let tipX = tip.x + 12;
  let tipY = tip.y - 4;
  if (tip.visible && tipRef.current) {
    const rect = tipRef.current.getBoundingClientRect();
    if (tipX + rect.width > window.innerWidth - 8) {
      tipX = tip.x - rect.width - 12;
    }
    tipY = Math.max(4, Math.min(tip.y - rect.height / 2, window.innerHeight - rect.height - 4));
  }

  return (
    <div className={className} onMouseMove={onMouseMove} onMouseLeave={onMouseLeave}>
      {children}

      {tip.visible && signals.length > 0 && createPortal(
        <div
          ref={tipRef}
          style={{
            position: "fixed",
            left: tipX,
            top: tipY,
            pointerEvents: "none",
            zIndex: 9999,
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 11,
            lineHeight: 1.5,
            whiteSpace: "nowrap",
            background: "var(--bg-surface)",
            color: "var(--text-primary)",
            border: "1px solid var(--border-default)",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          {signals.map((sig, i) => {
            const label = getSignalLabel(sig);
            const displayName = label !== sig.signalName
              ? `${label} (${sig.signalName})`
              : sig.signalName;
            return (
              <div key={`${sig.frameId}:${sig.signalName}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {showColourDot && (
                  <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: sig.colour, flexShrink: 0 }} />
                )}
                <span style={{ color: "var(--text-secondary)" }}>{displayName}</span>
                {sig.confidence && (
                  <span
                    style={{
                      display: "inline-block",
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: getConfidenceColour(sig.confidence, settings),
                      flexShrink: 0,
                    }}
                  />
                )}
                <span style={{ marginLeft: "auto", paddingLeft: 8, fontFamily: "ui-monospace, monospace", fontWeight: 500 }}>
                  {formatValue(values[i] ?? 0)}
                </span>
                {sig.unit && <span style={{ color: "var(--text-muted)", fontSize: 10 }}>{sig.unit}</span>}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
