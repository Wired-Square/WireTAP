// ui/src/apps/graph/views/panels/gauge/GaugePanel.tsx

import { useGraphStore, getConfidenceColour, type GraphPanel } from "../../../../../stores/graphStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { textSecondary } from "../../../../../styles/colourTokens";
import { formatValue } from "../../../utils/graphFormat";
import PanelTooltip from "../PanelTooltip";

interface Props {
  panel: GraphPanel;
}

/** SVG radial gauge constants */
const GAUGE_OUTER_RADIUS = 80;
const GAUGE_START_ANGLE = 225;  // lower-left, degrees clockwise from 12 o'clock
const GAUGE_END_ANGLE = 495;    // lower-right (225 + 270)
const GAUGE_SWEEP = GAUGE_END_ANGLE - GAUGE_START_ANGLE;
const LABEL_OFFSET = 14;
const ARC_GAP = 3;              // gap between concentric arcs

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const sweep = endAngle - startAngle;
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

export default function GaugePanel({ panel }: Props) {
  const signalCount = panel.signals.length;
  const { settings } = useSettings();

  // Subscribe to data updates via stable selectors (avoid returning new arrays)
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const seriesBuffers = useGraphStore((s) => s.seriesBuffers);

  // Compute values in the component body — re-runs when dataVersion changes
  void dataVersion;
  const values = panel.signals.map((sig) => {
    const key = `${sig.frameId}:${sig.signalName}`;
    return seriesBuffers.get(key)?.latestValue ?? 0;
  });

  const { minValue, maxValue } = panel;
  const range = maxValue - minValue;
  const cx = 100;
  const cy = 90;

  // Compute stroke width and radii for each signal ring
  const maxStroke = 12;
  const minStroke = 4;
  const stroke = signalCount <= 1
    ? maxStroke
    : Math.max(minStroke, Math.floor((GAUGE_OUTER_RADIUS - 30) / signalCount - ARC_GAP));

  const rings = panel.signals.map((sig, i) => {
    const radius = GAUGE_OUTER_RADIUS - i * (stroke + ARC_GAP);
    const value = values[i] ?? 0;
    const clamped = Math.max(minValue, Math.min(maxValue, value));
    const pct = range > 0 ? (clamped - minValue) / range : 0;
    const valueAngle = GAUGE_START_ANGLE + GAUGE_SWEEP * pct;
    return { sig, radius, value, pct, valueAngle, stroke };
  });

  // Label positions based on outermost arc
  const minPoint = polarToCartesian(cx, cy, GAUGE_OUTER_RADIUS + LABEL_OFFSET, GAUGE_START_ANGLE);
  const maxPoint = polarToCartesian(cx, cy, GAUGE_OUTER_RADIUS + LABEL_OFFSET, GAUGE_END_ANGLE);

  // Display selected signal's value in the centre
  const primaryIdx = Math.min(panel.primarySignalIndex ?? 0, Math.max(0, signalCount - 1));
  const primaryValue = values[primaryIdx] ?? 0;
  const primarySignal = panel.signals[primaryIdx];
  const displayValue = formatValue(primaryValue);

  if (signalCount === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={`text-xs ${textSecondary}`}>
          Click + to add a signal
        </p>
      </div>
    );
  }

  return (
    <PanelTooltip
      signals={panel.signals}
      values={values}
      settings={settings}
      showColourDot
      className="flex items-center justify-center h-full p-1"
    >
      <svg viewBox="0 0 200 165" className="w-full h-full">
        {/* Arc rings — one per signal */}
        {rings.map(({ sig, radius, pct, valueAngle, stroke: sw }, i) => (
          <g key={`${sig.frameId}:${sig.signalName}`}>
            {/* Background arc */}
            <path
              d={describeArc(cx, cy, radius, GAUGE_START_ANGLE, GAUGE_END_ANGLE)}
              fill="none"
              stroke="var(--border-default)"
              strokeWidth={sw}
              strokeLinecap="round"
            />
            {/* Value arc */}
            {pct > 0.001 && (
              <path
                d={describeArc(cx, cy, radius, GAUGE_START_ANGLE, valueAngle)}
                fill="none"
                stroke={sig.colour}
                strokeWidth={sw}
                strokeLinecap="round"
                style={{ transition: "d 0.15s ease-out" }}
              />
            )}
            {/* Colour legend dot for multi-signal gauges */}
            {signalCount > 1 && (
              <>
                <circle
                  cx={cx + (i - (signalCount - 1) / 2) * 12}
                  cy={cy + 34}
                  r={3.5}
                  fill={sig.colour}
                />
                {sig.confidence && (
                  <circle
                    cx={cx + (i - (signalCount - 1) / 2) * 12}
                    cy={cy + 34}
                    r={5}
                    fill="none"
                    stroke={getConfidenceColour(sig.confidence, settings)}
                    strokeWidth={1.5}
                  />
                )}
              </>
            )}
          </g>
        ))}

        {/* Value text */}
        <text
          x={cx}
          y={cy - 5}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--text-primary)"
          fontSize="28"
          fontWeight="600"
          fontFamily="ui-monospace, monospace"
          stroke="var(--bg-primary)"
          strokeWidth={2}
          paintOrder="stroke"
        >
          {displayValue}
        </text>

        {/* Unit */}
        <text
          x={cx}
          y={cy + 20}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--text-secondary)"
          fontSize="12"
          stroke="var(--bg-primary)"
          strokeWidth={1.5}
          paintOrder="stroke"
        >
          {primarySignal?.unit ?? ""}
        </text>

        {/* Confidence indicator for primary signal */}
        {primarySignal?.confidence && signalCount <= 1 && (
          <circle
            cx={cx}
            cy={cy + 32}
            r={3}
            fill={getConfidenceColour(primarySignal.confidence, settings)}
          />
        )}

        {/* Min label */}
        <text
          x={minPoint.x}
          y={minPoint.y}
          textAnchor="end"
          dominantBaseline="middle"
          fill="var(--text-muted)"
          fontSize="9"
        >
          {minValue}
        </text>

        {/* Max label */}
        <text
          x={maxPoint.x}
          y={maxPoint.y}
          textAnchor="start"
          dominantBaseline="middle"
          fill="var(--text-muted)"
          fontSize="9"
        >
          {maxValue}
        </text>
      </svg>
    </PanelTooltip>
  );
}
