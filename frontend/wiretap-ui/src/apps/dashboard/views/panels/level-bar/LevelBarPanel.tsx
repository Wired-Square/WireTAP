// ui/src/apps/dashboard/views/panels/level-bar/LevelBarPanel.tsx

import { useRef } from "react";
import { type DashboardPanel } from "../../../../../stores/dashboardStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { formatValue } from "../../../utils/dashboardFormat";
import { fraction, thresholdColour } from "../../../widgets/svgArc";
import { useSignalValues } from "../../../widgets/useSignalValues";
import { useSvgExportRef } from "../../../widgets/useExportRef";
import WidgetEmpty from "../../../widgets/WidgetEmpty";
import PanelTooltip from "../PanelTooltip";

interface Props {
  panel: DashboardPanel;
  svgRef?: React.MutableRefObject<(() => SVGSVGElement | null) | null>;
}

export default function LevelBarPanel({ panel, svgRef: svgRefProp }: Props) {
  const { settings } = useSettings();
  const svgElRef = useRef<SVGSVGElement>(null);
  useSvgExportRef(svgElRef, svgRefProp);

  const values = useSignalValues(panel.signals);
  const cfg = panel.widgetConfig?.levelBar;
  const vertical = cfg?.orientation === "vertical";

  if (panel.signals.length === 0) {
    return <WidgetEmpty>Click + to add a signal</WidgetEmpty>;
  }

  const idx = Math.min(cfg?.primarySignalIndex ?? 0, panel.signals.length - 1);
  const sig = panel.signals[idx];
  const value = values[idx];
  const pct = Number.isFinite(value) ? fraction(value, panel.minValue, panel.maxValue) : 0;
  const colour = thresholdColour(pct, sig.colour, cfg?.thresholds);

  // viewBox 0..100 in both axes; track inset 10
  const TRACK = 80;
  const fillLen = TRACK * pct;

  return (
    <PanelTooltip
      signals={[sig]}
      values={[value]}
      settings={settings}
      showColourDot
      className="flex flex-col items-center justify-center h-full p-2 gap-1"
    >
      <svg ref={svgElRef} viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
        {vertical ? (
          <>
            <rect x={40} y={10} width={20} height={TRACK} rx={4} fill="var(--border-default)" />
            <rect x={40} y={10 + (TRACK - fillLen)} width={20} height={fillLen} rx={4} fill={colour} style={{ transition: "all 0.15s ease-out" }} />
          </>
        ) : (
          <>
            <rect x={10} y={40} width={TRACK} height={20} rx={4} fill="var(--border-default)" />
            <rect x={10} y={40} width={fillLen} height={20} rx={4} fill={colour} style={{ transition: "all 0.15s ease-out" }} />
          </>
        )}
        <text x={50} y={vertical ? 99 : 30} textAnchor="middle" fill="var(--text-primary)" fontSize="14" fontWeight="600" fontFamily="ui-monospace, monospace">
          {Number.isFinite(value) ? formatValue(value) : "—"}
          {sig.unit ? ` ${sig.unit}` : ""}
        </text>
      </svg>
    </PanelTooltip>
  );
}
