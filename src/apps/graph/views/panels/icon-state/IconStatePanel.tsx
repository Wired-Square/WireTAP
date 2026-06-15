// ui/src/apps/graph/views/panels/icon-state/IconStatePanel.tsx

import { useRef } from "react";
import { type GraphPanel } from "../../../../../stores/graphStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { useSignalValues } from "../../../widgets/useSignalValues";
import { useSvgExportRef } from "../../../widgets/useExportRef";
import WidgetEmpty from "../../../widgets/WidgetEmpty";
import { lucideByName } from "../../../widgets/lucideByName";
import type { IconStateConfig } from "../../../widgets/configTypes";
import PanelTooltip from "../PanelTooltip";

interface Props {
  panel: GraphPanel;
  svgRef?: React.MutableRefObject<(() => SVGSVGElement | null) | null>;
}

/** Pick the state whose `value` matches (exact, else nearest) the signal value. */
function pickState(value: number, cfg: IconStateConfig) {
  if (!Number.isFinite(value) || cfg.states.length === 0) return undefined;
  let best = cfg.states[0];
  let bestDiff = Math.abs(best.value - value);
  for (const s of cfg.states) {
    const diff = Math.abs(s.value - value);
    if (diff < bestDiff) { best = s; bestDiff = diff; }
  }
  return best;
}

export default function IconStatePanel({ panel, svgRef: svgRefProp }: Props) {
  const { settings } = useSettings();
  const svgElRef = useRef<SVGSVGElement>(null);
  useSvgExportRef(svgElRef, svgRefProp);

  const values = useSignalValues(panel.signals);
  const cfg = panel.widgetConfig?.iconState;

  if (panel.signals.length === 0 || !cfg) {
    return <WidgetEmpty>{cfg ? "Click + to add a signal" : "Configure icon states"}</WidgetEmpty>;
  }

  const idx = Math.min(cfg.primarySignalIndex ?? 0, panel.signals.length - 1);
  const sig = panel.signals[idx];
  const value = values[idx];
  const state = pickState(value, cfg);

  const iconName = state?.icon ?? cfg.fallback?.icon ?? "circle";
  const colour = state?.colour ?? cfg.fallback?.colour ?? "var(--text-muted)";
  const brightness = state?.brightness ?? 1;
  const opacity = 0.25 + 0.75 * Math.max(0, Math.min(1, brightness));
  const glow = brightness > 0.5 ? `drop-shadow(0 0 6px ${colour})` : "none";
  const Icon = lucideByName(iconName);

  return (
    <PanelTooltip
      signals={[sig]}
      values={[value]}
      settings={settings}
      showColourDot
      className="flex flex-col items-center justify-center h-full p-3 gap-1"
    >
      <Icon
        ref={svgElRef}
        className="flex-1 min-h-0 w-auto h-full max-h-[70%]"
        style={{ color: colour, opacity, filter: glow, transition: "all 0.15s ease-out" }}
        strokeWidth={1.75}
      />
      <span className="text-xs font-medium text-[color:var(--text-secondary)] truncate max-w-full">
        {state?.label ?? sig.displayName ?? sig.signalName}
      </span>
    </PanelTooltip>
  );
}
