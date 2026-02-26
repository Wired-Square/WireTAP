// ui/src/apps/graph/views/panels/histogram/HistogramPanel.tsx

import { useRef, useEffect, useCallback, useMemo } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useGraphStore, readTimeSeries, getSignalLabel, type GraphPanel } from "../../../../../stores/graphStore";
import { emptyStateText } from "../../../../../styles/typography";
import { computeHistogram } from "../../../utils/graphHistogram";

interface Props {
  panel: GraphPanel;
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

/** Read CSS variable value from the document */
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Make a semi-transparent version of a hex colour */
function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return hex.length === 7 ? hex + a : hex;
}

function buildHistogramData(
  panel: GraphPanel,
  buffers: Map<string, import("../../../../../stores/graphStore").SignalTimeSeries>,
): { data: uPlot.AlignedData; labels: string[] } {
  const binCount = panel.histogramBins ?? 20;
  const allCentres = new Set<number>();
  const signalBins: Array<{ centres: number[]; counts: number[]; label: string }> = [];

  for (const sig of panel.signals) {
    const key = `${sig.frameId}:${sig.signalName}`;
    const series = buffers.get(key);
    if (!series || series.count === 0) {
      signalBins.push({ centres: [], counts: [], label: getSignalLabel(sig) });
      continue;
    }
    const { values } = readTimeSeries(series);
    const bins = computeHistogram(values, binCount);
    const centres = bins.map((b) => b.centre);
    const counts = bins.map((b) => b.count);
    for (const c of centres) allCentres.add(c);
    signalBins.push({ centres, counts, label: getSignalLabel(sig) });
  }

  // Build aligned data: shared X-axis (bin centres), one Y per signal
  const sortedCentres = Array.from(allCentres).sort((a, b) => a - b);
  if (sortedCentres.length === 0) {
    return { data: [[]] as uPlot.AlignedData, labels: [] };
  }

  const data: (number | null)[][] = [sortedCentres];
  const labels: string[] = [];

  for (const sb of signalBins) {
    const lookup = new Map<number, number>();
    for (let i = 0; i < sb.centres.length; i++) {
      lookup.set(sb.centres[i], sb.counts[i]);
    }
    data.push(sortedCentres.map((c) => lookup.get(c) ?? null));
    labels.push(sb.label);
  }

  return { data: data as uPlot.AlignedData, labels };
}

export default function HistogramPanel({ panel, canvasRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const seriesBuffers = useGraphStore((s) => s.seriesBuffers);

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
    const { data } = buildHistogramData(panel, seriesBuffers);
    const chart = new uPlot(opts, data, el);
    chartRef.current = chart;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.signals.length, sigKey, panel.histogramBins]);

  // Update data when dataVersion changes
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || panel.signals.length === 0) return;
    const { data } = buildHistogramData(panel, useGraphStore.getState().seriesBuffers);
    chart.setData(data);
  }, [dataVersion, panel]);

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
