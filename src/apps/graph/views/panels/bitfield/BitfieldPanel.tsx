// ui/src/apps/graph/views/panels/bitfield/BitfieldPanel.tsx

import { useRef } from "react";
import { useGraphStore, type GraphPanel } from "../../../../../stores/graphStore";
import { useSvgExportRef } from "../../../widgets/useExportRef";
import WidgetEmpty from "../../../widgets/WidgetEmpty";
import { formatFrameId } from "../../../../../utils/frameIds";

interface Props {
  panel: GraphPanel;
  svgRef?: React.MutableRefObject<(() => SVGSVGElement | null) | null>;
}

const CELL = 20;
const GAP = 2;
const LABEL_W = 26;
const LABEL_H = 14;

export default function BitfieldPanel({ panel, svgRef: svgRefProp }: Props) {
  const svgElRef = useRef<SVGSVGElement>(null);
  useSvgExportRef(svgElRef, svgRefProp);

  // Re-render on new data; read each byte's latest value from the shared buffers.
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const buffers = useGraphStore((s) => s.seriesBuffers);
  void dataVersion;

  const cfg = panel.widgetConfig?.bitfield;
  const frameId = panel.targetFrameId;
  const byteCount = Math.max(1, Math.min(8, panel.byteCount ?? 8));

  if (frameId == null) {
    return <WidgetEmpty>Configure a target frame ID</WidgetEmpty>;
  }

  const onColour = cfg?.onColour ?? "#22c55e";
  const offColour = cfg?.offColour ?? "var(--border-default)";

  const bytes: number[] = [];
  for (let i = 0; i < byteCount; i++) {
    bytes.push(buffers.get(`${frameId}:byte[${i}]`)?.latestValue ?? 0);
  }

  const svgW = LABEL_W + 8 * (CELL + GAP);
  const svgH = LABEL_H + byteCount * (CELL + GAP);

  return (
    <div className="flex items-center justify-center h-full p-2">
      <svg ref={svgElRef} viewBox={`0 0 ${svgW} ${svgH}`} className="w-full h-full" preserveAspectRatio="xMidYMid meet">
        {/* Bit column headers (7..0, MSB left) */}
        {Array.from({ length: 8 }, (_, col) => {
          const bit = 7 - col;
          return (
            <text key={`h${col}`} x={LABEL_W + col * (CELL + GAP) + CELL / 2} y={LABEL_H - 4} textAnchor="middle" fill="var(--text-muted)" fontSize="8">
              {bit}
            </text>
          );
        })}
        {Array.from({ length: byteCount }, (_, row) => {
          const value = Math.round(bytes[row]) & 0xff;
          const y = LABEL_H + row * (CELL + GAP);
          return (
            <g key={`b${row}`}>
              <text x={LABEL_W - 6} y={y + CELL / 2} textAnchor="end" dominantBaseline="middle" fill="var(--text-muted)" fontSize="8" fontFamily="ui-monospace, monospace">
                B{row}
              </text>
              {Array.from({ length: 8 }, (_, col) => {
                const bit = 7 - col;
                const on = (value >> bit) & 1;
                const x = LABEL_W + col * (CELL + GAP);
                const label = cfg?.labels?.[row * 8 + bit];
                return (
                  <rect key={`c${col}`} x={x} y={y} width={CELL} height={CELL} rx={3}
                    fill={on ? onColour : offColour}
                    style={{ transition: "fill 0.1s ease-out" }}>
                    <title>{`${formatFrameId(frameId)} byte ${row} bit ${bit} = ${on}${label ? ` (${label})` : ""}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
