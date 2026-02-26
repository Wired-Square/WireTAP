// ui/src/apps/graph/views/panels/heatmap/HeatmapPanel.tsx

import { useRef, useCallback } from "react";
import { useGraphStore, type GraphPanel } from "../../../../../stores/graphStore";
import { emptyStateText } from "../../../../../styles/typography";

interface Props {
  panel: GraphPanel;
  svgRef?: React.MutableRefObject<(() => SVGSVGElement | null) | null>;
}

/** Interpolate from cool blue to hot red based on normalised change rate (0–1) */
function cellColour(count: number, maxCount: number): string {
  if (count === 0) return "var(--border-default)";
  const t = maxCount > 0 ? Math.min(1, count / maxCount) : 0;
  const r = Math.round(59 + t * (239 - 59));
  const g = Math.round(130 + t * (68 - 130));
  const b = Math.round(246 + t * (68 - 246));
  return `rgb(${r},${g},${b})`;
}

const GRID_ROWS = 8; // bytes
const GRID_COLS = 8; // bits
const CELL_SIZE = 20;
const GAP = 2;
const LABEL_W = 24;
const LABEL_H = 16;
const SVG_W = LABEL_W + GRID_COLS * (CELL_SIZE + GAP);
const SVG_H = LABEL_H + GRID_ROWS * (CELL_SIZE + GAP);

export default function HeatmapPanel({ panel, svgRef: svgRefProp }: Props) {
  const svgElRef = useRef<SVGSVGElement>(null);
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const bitChangeCounts = useGraphStore((s) => s.bitChangeCounts);

  // Expose SVG ref for export
  const getSvgEl = useCallback(() => svgElRef.current, []);
  if (svgRefProp) {
    svgRefProp.current = getSvgEl;
  }

  void dataVersion; // trigger re-render

  if (panel.targetFrameId == null) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={emptyStateText}>Select a frame ID in Configure Panel</p>
      </div>
    );
  }

  const entry = bitChangeCounts.get(panel.targetFrameId);
  const counts = entry?.counts;
  const totalFrames = entry?.totalFrames ?? 0;

  // Find max count for normalisation
  let maxCount = 0;
  if (counts) {
    for (let i = 0; i < 64; i++) {
      if (counts[i] > maxCount) maxCount = counts[i];
    }
  }

  return (
    <div className="flex items-center justify-center h-full p-2">
      <svg
        ref={svgElRef}
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className="w-full h-full"
        style={{ maxWidth: SVG_W * 2, maxHeight: SVG_H * 2 }}
      >
        {/* Column labels (bit positions, MSB left) */}
        {Array.from({ length: GRID_COLS }, (_, bit) => {
          const bitPos = 7 - bit; // MSB left
          const x = LABEL_W + bit * (CELL_SIZE + GAP) + CELL_SIZE / 2;
          return (
            <text
              key={`col-${bit}`}
              x={x}
              y={LABEL_H - 3}
              textAnchor="middle"
              fill="var(--text-muted)"
              fontSize="8"
              fontFamily="ui-monospace, monospace"
            >
              {bitPos}
            </text>
          );
        })}

        {/* Grid cells */}
        {Array.from({ length: GRID_ROWS }, (_, byteIdx) => (
          <g key={`row-${byteIdx}`}>
            {/* Row label */}
            <text
              x={LABEL_W - 4}
              y={LABEL_H + byteIdx * (CELL_SIZE + GAP) + CELL_SIZE / 2 + 3}
              textAnchor="end"
              fill="var(--text-muted)"
              fontSize="8"
              fontFamily="ui-monospace, monospace"
            >
              B{byteIdx}
            </text>

            {/* Bit cells */}
            {Array.from({ length: GRID_COLS }, (_, colIdx) => {
              const bitPos = 7 - colIdx; // MSB left
              const countIdx = byteIdx * 8 + bitPos;
              const count = counts?.[countIdx] ?? 0;
              const fill = cellColour(count, maxCount);
              const rate = totalFrames > 0 ? ((count / totalFrames) * 100).toFixed(1) : "0.0";
              const x = LABEL_W + colIdx * (CELL_SIZE + GAP);
              const y = LABEL_H + byteIdx * (CELL_SIZE + GAP);

              return (
                <rect
                  key={`${byteIdx}-${colIdx}`}
                  x={x}
                  y={y}
                  width={CELL_SIZE}
                  height={CELL_SIZE}
                  rx={3}
                  fill={fill}
                  opacity={count === 0 ? 0.4 : 0.6 + 0.4 * Math.min(1, count / Math.max(1, maxCount))}
                >
                  <title>
                    Byte {byteIdx}, Bit {bitPos} | {count.toLocaleString()} changes ({rate}%)
                    {totalFrames > 0 ? ` | ${totalFrames.toLocaleString()} frames` : ""}
                  </title>
                </rect>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}
