// ui/src/apps/dashboard/views/panels/line-chart/LineChartPanel.tsx

import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { getSignalLabel, type DashboardPanel } from "../../../../../stores/dashboardStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { emptyStateText } from "../../../../../styles/typography";
import { getCssVar, isCompact, useUPlotPanel } from "../useUPlotPanel";
import StatsOverlay from "../StatsOverlay";
import { tooltipPlugin, wheelZoomPlugin, panPlugin, measurementPlugin, type ConfidenceColours } from "./chartPlugins";

interface Props {
  panel: DashboardPanel;
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

/** Build uPlot options for this panel */
function buildOptions(
  panel: DashboardPanel,
  width: number,
  height: number,
  confidenceColours?: ConfidenceColours,
  onUserInteraction?: () => void,
): uPlot.Options {
  const textColour = getCssVar("--text-primary") || "#e2e8f0";
  const gridColour = getCssVar("--border-default") || "rgba(255,255,255,0.1)";
  const { w: isCompactW, h: isCompactH } = isCompact(width, height);

  const hasRightAxis = panel.signals.some((s) => s.yAxis === "right");
  const callbacks = { onUserInteraction };

  const series: uPlot.Series[] = [
    {}, // x-axis (time)
    ...panel.signals.map((sig) => ({
      label: getSignalLabel(sig),
      stroke: sig.colour,
      width: 2,
      points: { show: false },
      spanGaps: true,
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
  };
}

/** Stable key for signal config changes that should trigger chart recreation */
function signalConfigKey(panel: DashboardPanel): string {
  return panel.signals.map((s) =>
    `${s.frameId}:${s.signalName}:${s.colour}:${s.displayName ?? ''}:${s.yAxis ?? 'left'}`
  ).join('|');
}

export default function LineChartPanel({ panel, canvasRef }: Props) {
  const { settings } = useSettings();
  const confidenceColours = settings ? {
    none: settings.signal_colour_none || '#94a3b8',
    low: settings.signal_colour_low || '#f59e0b',
    medium: settings.signal_colour_medium || '#3b82f6',
    high: settings.signal_colour_high || '#22c55e',
  } : undefined;

  const { containerRef, stats } = useUPlotPanel({
    panel,
    signals: panel.signals,
    canvasRef,
    buildOptions: (width, height, onUserInteraction) => buildOptions(panel, width, height, confidenceColours, onUserInteraction),
    optionsKey: signalConfigKey(panel),
  });

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
      {panel.showStats && <StatsOverlay signals={panel.signals} stats={stats} />}
    </div>
  );
}
