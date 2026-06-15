// ui/src/apps/graph/views/panels/rotary/RotaryPanel.tsx

import { useRef } from "react";
import { type GraphPanel } from "../../../../../stores/graphStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { formatValue } from "../../../utils/graphFormat";
import { fraction } from "../../../widgets/svgArc";
import { useSignalValues } from "../../../widgets/useSignalValues";
import { useSvgExportRef } from "../../../widgets/useExportRef";
import WidgetEmpty from "../../../widgets/WidgetEmpty";
import PanelTooltip from "../PanelTooltip";

interface Props {
  panel: GraphPanel;
  svgRef?: React.MutableRefObject<(() => SVGSVGElement | null) | null>;
}

/** A steering-wheel glyph centred at (50,50), radius 38 — rotated by the caller. */
function SteeringWheel({ colour }: { colour: string }) {
  return (
    <g fill="none" stroke={colour} strokeWidth={5} strokeLinecap="round">
      <circle cx={50} cy={50} r={38} />
      <circle cx={50} cy={50} r={8} fill={colour} stroke="none" />
      {/* three spokes */}
      <line x1={50} y1={50} x2={50} y2={12} />
      <line x1={50} y1={50} x2={17} y2={69} />
      <line x1={50} y1={50} x2={83} y2={69} />
    </g>
  );
}

export default function RotaryPanel({ panel, svgRef: svgRefProp }: Props) {
  const { settings } = useSettings();
  const svgElRef = useRef<SVGSVGElement>(null);
  useSvgExportRef(svgElRef, svgRefProp);

  const values = useSignalValues(panel.signals);
  const cfg = panel.widgetConfig?.rotary;

  if (panel.signals.length === 0) {
    return <WidgetEmpty>Click + to add a signal</WidgetEmpty>;
  }

  const idx = Math.min(cfg?.primarySignalIndex ?? 0, panel.signals.length - 1);
  const sig = panel.signals[idx];
  const value = values[idx];
  const startAngle = cfg?.startAngle ?? -450;
  const endAngle = cfg?.endAngle ?? 450;
  const pct = Number.isFinite(value) ? fraction(value, panel.minValue, panel.maxValue) : 0;
  const rotation = startAngle + pct * (endAngle - startAngle);
  const showReadout = cfg?.showReadout !== false;

  return (
    <PanelTooltip
      signals={[sig]}
      values={[value]}
      settings={settings}
      showColourDot
      className="flex items-center justify-center h-full p-2"
    >
      <svg ref={svgElRef} viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="xMidYMid meet">
        <g transform={`rotate(${rotation} 50 50)`} style={{ transition: "transform 0.15s ease-out" }}>
          <SteeringWheel colour={sig.colour} />
        </g>
        {showReadout && (
          <text
            x={50}
            y={54}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="var(--text-primary)"
            fontSize="13"
            fontWeight="600"
            fontFamily="ui-monospace, monospace"
            stroke="var(--bg-primary)"
            strokeWidth={2}
            paintOrder="stroke"
          >
            {Number.isFinite(value) ? formatValue(value) : "—"}{sig.unit ? ` ${sig.unit}` : ""}
          </text>
        )}
      </svg>
    </PanelTooltip>
  );
}
