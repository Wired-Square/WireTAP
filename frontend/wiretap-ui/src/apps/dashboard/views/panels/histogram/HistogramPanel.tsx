// ui/src/apps/dashboard/views/panels/histogram/HistogramPanel.tsx

import { useRef, useEffect, useCallback, useMemo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { getSignalLabel, type DashboardPanel } from "../../../../../stores/dashboardStore";
import { emptyStateText } from "../../../../../styles/typography";
import { readHistograms, type HistogramBins } from "../../../../../api/dashboardHistory";
import { useHistoryQuery } from "../../../widgets/useHistoryQuery";
import { getCssVar } from "../useUPlotPanel";

interface Props {
  panel: DashboardPanel;
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

/** Make a semi-transparent version of a hex colour */
function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return hex.length === 7 ? hex + a : hex;
}

/** Each signal's bins on one x of every bin centre, a count where a signal has that bin. */
function histogramData(perSignal: HistogramBins[]): uPlot.AlignedData {
  const centres = [...new Set(perSignal.flat().map((b) => b.centre))].sort((a, b) => a - b);
  if (centres.length === 0) return [[]];
  return [
    centres,
    ...perSignal.map((bins) => {
      const counts = new Map(bins.map((b) => [b.centre, b.count]));
      return centres.map((c) => counts.get(c) ?? null);
    }),
  ];
}

export default function HistogramPanel({ panel, canvasRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const bins = panel.histogramBins ?? 20;
  const signalsKey = panel.signals.map((s) => `${s.frameId}:${s.signalName}`).join("|");
  const histograms = useHistoryQuery(`${signalsKey}#${bins}`, (sessionId) => readHistograms(sessionId, panel.signals, bins));
  const data = useMemo(() => histogramData(histograms ?? []), [histograms]);
  const dataRef = useRef(data);
  dataRef.current = data;

  // Expose canvas for PNG export
  useEffect(() => {
    if (canvasRef) {
      canvasRef.current = () => chartRef.current?.ctx.canvas ?? null;
    }
    return () => {
      if (canvasRef) canvasRef.current = null;
    };
  }, [canvasRef]);

  useEffect(() => {
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  const sigKey = useMemo(() =>
    panel.signals.map((s) => `${s.frameId}:${s.signalName}:${s.colour}`).join('|'),
    [panel.signals],
  );

  // Build chart options
  const buildOpts = useCallback((width: number, height: number): uPlot.Options => {
    const textColour = getCssVar("--text-primary") || "#e2e8f0";
    const gridColour = getCssVar("--border-default") || "rgba(255,255,255,0.1)";

    const series: uPlot.Series[] = [
      {}, // x-axis (bin centres)
      ...panel.signals.map((sig) => ({
        label: getSignalLabel(sig),
        stroke: sig.colour,
        fill: withAlpha(sig.colour, 0.5),
        paths: uPlot.paths.bars!({ size: [0.8, 100] }),
        points: { show: false },
      })),
    ];

    return {
      width,
      height,
      series,
      cursor: {
        drag: { x: false, y: false },
      },
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      axes: [
        {
          stroke: textColour,
          grid: { stroke: gridColour, width: 1 },
          ticks: { stroke: gridColour, width: 1 },
          label: "Value",
        },
        {
          stroke: textColour,
          grid: { stroke: gridColour, width: 1 },
          ticks: { stroke: gridColour, width: 1 },
          size: 50,
          label: "Count",
        },
      ],
      legend: {
        show: panel.signals.length > 1,
      },
    };
  }, [panel.signals, sigKey]);

  // Re-create chart when signal config changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    chartRef.current?.destroy();
    chartRef.current = null;

    if (panel.signals.length === 0) return;

    const rect = el.getBoundingClientRect();
    const opts = buildOpts(rect.width, rect.height);
    const chart = new uPlot(opts, dataRef.current, el);
    chartRef.current = chart;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.signals.length, sigKey, panel.histogramBins]);

  useEffect(() => {
    chartRef.current?.setData(data);
  }, [data]);

  // Handle resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width <= 0 || height <= 0) continue;
        chartRef.current?.setSize({ width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (panel.signals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={emptyStateText}>Click + to add signals</p>
      </div>
    );
  }

  return <div ref={containerRef} className="w-full h-full" />;
}
