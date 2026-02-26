// ui/src/apps/graph/views/panels/flow/FlowViewPanel.tsx

import { useRef, useEffect, useCallback, useMemo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useGraphStore, buildAlignedData, type GraphPanel, type SignalRef } from "../../../../../stores/graphStore";
import { emptyStateText } from "../../../../../styles/typography";
import { formatValue } from "../../../utils/graphFormat";
import { tooltipPlugin, wheelZoomPlugin, panPlugin, measurementPlugin } from "../line-chart/chartPlugins";

interface Props {
  panel: GraphPanel;
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

/** Colour palette for byte series */
const BYTE_COLOURS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
];

/** Read CSS variable value from the document */
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const COMPACT_WIDTH = 350;
const COMPACT_HEIGHT = 180;

function responsiveKey(w: number, h: number): string {
  return `${w < COMPACT_WIDTH ? "cw" : "nw"}_${h < COMPACT_HEIGHT ? "ch" : "nh"}`;
}

function buildOptions(
  signals: SignalRef[],
  width: number,
  height: number,
  onUserInteraction?: () => void,
): uPlot.Options {
  const textColour = getCssVar("--text-primary") || "#e2e8f0";
  const gridColour = getCssVar("--border-default") || "rgba(255,255,255,0.1)";
  const isCompactW = width < COMPACT_WIDTH;
  const isCompactH = height < COMPACT_HEIGHT;
  const callbacks = { onUserInteraction };

  const series: uPlot.Series[] = [
    {},
    ...signals.map((sig) => ({
      label: sig.signalName,
      stroke: sig.colour,
      width: 2,
      points: { show: false },
    })),
  ];

  return {
    width,
    height,
    series,
    plugins: [
      tooltipPlugin(signals),
      wheelZoomPlugin(callbacks),
      panPlugin(callbacks),
      measurementPlugin(signals),
    ],
    cursor: {
      drag: { x: true, y: false },
      points: {
        size: 6,
        fill: (_u: uPlot, seriesIdx: number) => signals[seriesIdx - 1]?.colour ?? "#fff",
      },
    },
    scales: {
      x: { time: true },
      y: { auto: true, range: [0, 255] },
    },
    axes: [
      {
        stroke: textColour,
        grid: { stroke: gridColour, width: 1 },
        ticks: { stroke: gridColour, width: 1 },
        ...(isCompactH ? { show: false } : {}),
      },
      {
        stroke: textColour,
        grid: { stroke: gridColour, width: 1 },
        ticks: { stroke: gridColour, width: 1 },
        size: isCompactW ? 40 : 60,
        label: "Byte Value",
      },
    ],
    legend: {
      show: !isCompactH && signals.length > 1,
    },
  };
}

export default function FlowViewPanel({ panel, canvasRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const respKeyRef = useRef<string>("");
  const isUpdatingDataRef = useRef(false);
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const seriesBuffers = useGraphStore((s) => s.seriesBuffers);
  const zoomResetVersion = useGraphStore((s) => s.zoomResetVersion);
  const setFollowMode = useGraphStore((s) => s.setFollowMode);

  const followMode = panel.followMode !== false;

  // Build synthetic signal refs from targetFrameId + byteCount
  const signals: SignalRef[] = useMemo(() => {
    if (panel.targetFrameId == null) return [];
    const count = panel.byteCount ?? 8;
    return Array.from({ length: count }, (_, i) => ({
      frameId: panel.targetFrameId!,
      signalName: `byte[${i}]`,
      colour: BYTE_COLOURS[i % BYTE_COLOURS.length],
    }));
  }, [panel.targetFrameId, panel.byteCount]);

  // Expose canvas for PNG export
  useEffect(() => {
    if (canvasRef) {
      canvasRef.current = () => chartRef.current?.ctx.canvas ?? null;
    }
    return () => {
      if (canvasRef) canvasRef.current = null;
    };
  }, [canvasRef]);

  const handleUserInteraction = useCallback(() => {
    if (!isUpdatingDataRef.current) {
      setFollowMode(panel.id, false);
    }
  }, [panel.id, setFollowMode]);

  useEffect(() => {
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  // Re-create chart when signals change
  const sigCount = signals.length;
  const sigKey = signals.map((s) => `${s.frameId}:${s.signalName}:${s.colour}`).join('|');
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    chartRef.current?.destroy();
    chartRef.current = null;

    if (sigCount === 0) return;

    const rect = el.getBoundingClientRect();
    const opts = buildOptions(signals, rect.width, rect.height, handleUserInteraction);
    const data = buildAlignedData(signals, seriesBuffers) as uPlot.AlignedData;
    const chart = new uPlot(opts, data, el);
    chartRef.current = chart;
    respKeyRef.current = responsiveKey(rect.width, rect.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigCount, sigKey]);

  // Update data
  const updateData = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || signals.length === 0) return;

    const data = buildAlignedData(signals, useGraphStore.getState().seriesBuffers) as uPlot.AlignedData;

    isUpdatingDataRef.current = true;
    chart.setData(data);

    if (followMode && data[0] && data[0].length > 1) {
      const timestamps = data[0] as number[];
      const firstTs = timestamps[0];
      const lastTs = timestamps[timestamps.length - 1];
      if (firstTs != null && lastTs != null && lastTs > firstTs) {
        chart.setScale("x", { min: firstTs, max: lastTs });
      }
    }

    isUpdatingDataRef.current = false;
  }, [signals, followMode]);

  useEffect(() => { updateData(); }, [dataVersion, updateData]);

  // Reset zoom
  useEffect(() => {
    if (zoomResetVersion === 0) return;
    const chart = chartRef.current;
    if (!chart) return;
    const data = chart.data;
    if (data[0] && data[0].length > 1) {
      const timestamps = data[0] as number[];
      isUpdatingDataRef.current = true;
      chart.setScale("x", { min: timestamps[0], max: timestamps[timestamps.length - 1] });
      isUpdatingDataRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomResetVersion]);

  // Handle resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) continue;
        const newKey = responsiveKey(width, height);
        if (newKey !== respKeyRef.current && chartRef.current) {
          chartRef.current.destroy();
          chartRef.current = null;
          if (signals.length === 0) return;
          const opts = buildOptions(signals, width, height, handleUserInteraction);
          const data = buildAlignedData(signals, useGraphStore.getState().seriesBuffers) as uPlot.AlignedData;
          const chart = new uPlot(opts, data, el);
          chartRef.current = chart;
          respKeyRef.current = newKey;
        } else {
          chartRef.current?.setSize({ width, height });
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [signals, handleUserInteraction]);

  if (panel.targetFrameId == null) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={emptyStateText}>Select a frame ID in Configure Panel</p>
      </div>
    );
  }

  if (signals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={emptyStateText}>Waiting for frames...</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />

      {/* Stats overlay */}
      {panel.showStats && (
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
          {signals.map((sig) => {
            const key = `${sig.frameId}:${sig.signalName}`;
            const series = seriesBuffers.get(key);
            const avg = series && series.sampleCount > 0 ? series.sum / series.sampleCount : null;
            return (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: sig.colour, flexShrink: 0 }} />
                <span style={{ color: "var(--text-muted)", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>
                  {formatValue(series?.min === Infinity ? null : series?.min)}
                  {" / "}
                  {formatValue(avg)}
                  {" / "}
                  {formatValue(series?.max === -Infinity ? null : series?.max)}
                </span>
              </div>
            );
          })}
          <div style={{ color: "var(--text-muted)", fontSize: 9, textAlign: "center", marginTop: 1 }}>
            min / avg / max
          </div>
        </div>
      )}
    </div>
  );
}
