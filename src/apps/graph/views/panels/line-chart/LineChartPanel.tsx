// ui/src/apps/graph/views/panels/line-chart/LineChartPanel.tsx

import { useRef, useEffect, useCallback } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useGraphStore, buildAlignedData, getSignalLabel, type GraphPanel } from "../../../../../stores/graphStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { emptyStateText } from "../../../../../styles/typography";
import { formatValue } from "../../../utils/graphFormat";
import { tooltipPlugin, wheelZoomPlugin, panPlugin, measurementPlugin, type ConfidenceColours } from "./chartPlugins";

interface Props {
  panel: GraphPanel;
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

/** Read CSS variable value from the document */
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Responsive breakpoints */
const COMPACT_WIDTH = 350;
const COMPACT_HEIGHT = 180;

/** Build uPlot options for this panel */
function buildOptions(
  panel: GraphPanel,
  width: number,
  height: number,
  confidenceColours?: ConfidenceColours,
  onUserInteraction?: () => void,
): uPlot.Options {
  const textColour = getCssVar("--text-primary") || "#e2e8f0";
  const gridColour = getCssVar("--border-default") || "rgba(255,255,255,0.1)";
  const isCompactW = width < COMPACT_WIDTH;
  const isCompactH = height < COMPACT_HEIGHT;

  const hasRightAxis = panel.signals.some((s) => s.yAxis === "right");
  const callbacks = { onUserInteraction };

  const series: uPlot.Series[] = [
    {}, // x-axis (time)
    ...panel.signals.map((sig) => ({
      label: getSignalLabel(sig),
      stroke: sig.colour,
      width: 2,
      points: { show: false },
      scale: sig.yAxis === "right" ? "y2" : "y",
    })),
  ];

  const axes: uPlot.Axis[] = [
    // X-axis (time)
    {
      stroke: textColour,
      grid: { stroke: gridColour, width: 1 },
      ticks: { stroke: gridColour, width: 1 },
      ...(isCompactH ? { show: false } : {}),
    },
    // Left Y-axis
    {
      stroke: textColour,
      grid: { stroke: gridColour, width: 1 },
      ticks: { stroke: gridColour, width: 1 },
      size: isCompactW ? 40 : 60,
      scale: "y",
    },
  ];

  // Right Y-axis (only if any signal uses it)
  if (hasRightAxis) {
    axes.push({
      side: 1,
      stroke: textColour,
      grid: { show: false },
      ticks: { stroke: gridColour, width: 1 },
      size: isCompactW ? 40 : 60,
      scale: "y2",
    });
  }

  return {
    width,
    height,
    series,
    plugins: [
      tooltipPlugin(panel.signals, confidenceColours),
      wheelZoomPlugin(callbacks),
      panPlugin(callbacks),
      measurementPlugin(panel.signals, confidenceColours),
    ],
    cursor: {
      drag: { x: true, y: false },
      points: {
        size: 6,
        fill: (_u: uPlot, seriesIdx: number) => panel.signals[seriesIdx - 1]?.colour ?? "#fff",
      },
    },
    scales: {
      x: { time: true },
      y: { auto: true },
      ...(hasRightAxis ? { y2: { auto: true } } : {}),
    },
    axes,
    legend: {
      show: !isCompactH && panel.signals.length > 1,
    },
    hooks: {
      // Detect user-initiated drag-zoom (uPlot built-in)
      setScale: [
        (_u: uPlot, key: string) => {
          if (key === "x") {
            // This fires for both programmatic and user setScale calls.
            // We'll handle the distinction in the component by tracking
            // whether the call was triggered by updateData (programmatic).
          }
        },
      ],
    },
  };
}

/** Compute a responsive class key — chart recreates when this changes */
function responsiveKey(w: number, h: number): string {
  return `${w < COMPACT_WIDTH ? "cw" : "nw"}_${h < COMPACT_HEIGHT ? "ch" : "nh"}`;
}

/** Stable key for signal config changes that should trigger chart recreation */
function signalConfigKey(panel: GraphPanel): string {
  return panel.signals.map((s) =>
    `${s.frameId}:${s.signalName}:${s.colour}:${s.displayName ?? ''}:${s.yAxis ?? 'left'}`
  ).join('|');
}

export default function LineChartPanel({ panel, canvasRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const respKeyRef = useRef<string>("");
  const isUpdatingDataRef = useRef(false);
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const seriesBuffers = useGraphStore((s) => s.seriesBuffers);
  const zoomResetVersion = useGraphStore((s) => s.zoomResetVersion);
  const setFollowMode = useGraphStore((s) => s.setFollowMode);
  const { settings } = useSettings();

  const confidenceColours = settings ? {
    none: settings.signal_colour_none || '#94a3b8',
    low: settings.signal_colour_low || '#f59e0b',
    medium: settings.signal_colour_medium || '#3b82f6',
    high: settings.signal_colour_high || '#22c55e',
  } : undefined;

  // Expose canvas for PNG export
  useEffect(() => {
    if (canvasRef) {
      canvasRef.current = () => chartRef.current?.ctx.canvas ?? null;
    }
    return () => {
      if (canvasRef) canvasRef.current = null;
    };
  }, [canvasRef]);

  // Follow mode: treat undefined as true (backwards compat)
  const followMode = panel.followMode !== false;

  const handleUserInteraction = useCallback(() => {
    // Only disable follow if user manually zoomed/panned (not programmatic)
    if (!isUpdatingDataRef.current) {
      setFollowMode(panel.id, false);
    }
  }, [panel.id, setFollowMode]);

  // Destroy chart on unmount
  useEffect(() => {
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  // Re-create chart when panel signals change (series config changes)
  const sigKey = signalConfigKey(panel);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Destroy existing chart
    chartRef.current?.destroy();
    chartRef.current = null;

    if (panel.signals.length === 0) return;

    const rect = el.getBoundingClientRect();
    const opts = buildOptions(panel, rect.width, rect.height, confidenceColours, handleUserInteraction);
    const data = buildAlignedData(panel.signals, seriesBuffers) as uPlot.AlignedData;

    const chart = new uPlot(opts, data, el);
    chartRef.current = chart;
    respKeyRef.current = responsiveKey(rect.width, rect.height);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.signals.length, sigKey]);

  // Update data when dataVersion changes (new signal values pushed)
  const updateData = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || panel.signals.length === 0) return;

    const data = buildAlignedData(panel.signals, useGraphStore.getState().seriesBuffers) as uPlot.AlignedData;

    // Mark as programmatic so zoom/pan plugins don't disable follow mode
    isUpdatingDataRef.current = true;
    chart.setData(data);

    // Follow mode: auto-scroll to show the full buffer
    if (followMode && data[0] && data[0].length > 1) {
      const timestamps = data[0] as number[];
      const firstTs = timestamps[0];
      const lastTs = timestamps[timestamps.length - 1];
      if (firstTs != null && lastTs != null && lastTs > firstTs) {
        chart.setScale("x", { min: firstTs, max: lastTs });
      }
    }

    isUpdatingDataRef.current = false;
  }, [panel.signals, followMode]);

  useEffect(() => {
    updateData();
  }, [dataVersion, updateData]);

  // Reset zoom when triggerZoomReset is called
  useEffect(() => {
    if (zoomResetVersion === 0) return; // skip initial
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

  // Handle resize — setSize for normal resizes, recreate chart when crossing responsive thresholds
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) continue;

        const newKey = responsiveKey(width, height);
        if (newKey !== respKeyRef.current && chartRef.current) {
          // Responsive threshold crossed — recreate chart with new options
          chartRef.current.destroy();
          chartRef.current = null;

          if (panel.signals.length === 0) return;

          const opts = buildOptions(panel, width, height, confidenceColours, handleUserInteraction);
          const data = buildAlignedData(panel.signals, useGraphStore.getState().seriesBuffers) as uPlot.AlignedData;
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
  }, [panel.signals, handleUserInteraction]);

  if (panel.signals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={emptyStateText}>Click + to add signals</p>
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
          {panel.signals.map((sig) => {
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
