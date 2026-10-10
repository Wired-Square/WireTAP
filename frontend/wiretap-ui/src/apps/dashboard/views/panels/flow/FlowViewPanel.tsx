// ui/src/apps/dashboard/views/panels/flow/FlowViewPanel.tsx

import { useMemo } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { flowSignals, type DashboardPanel, type SignalRef } from "../../../../../stores/dashboardStore";
import { emptyStateText } from "../../../../../styles/typography";
import { getCssVar, isCompact, useUPlotPanel } from "../useUPlotPanel";
import StatsOverlay from "../StatsOverlay";
import { tooltipPlugin, wheelZoomPlugin, panPlugin, measurementPlugin } from "../line-chart/chartPlugins";

interface Props {
  panel: DashboardPanel;
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

function buildOptions(
  signals: SignalRef[],
  width: number,
  height: number,
  onUserInteraction?: () => void,
): uPlot.Options {
  const textColour = getCssVar("--text-primary") || "#e2e8f0";
  const gridColour = getCssVar("--border-default") || "rgba(255,255,255,0.1)";
  const { w: isCompactW, h: isCompactH } = isCompact(width, height);
  const callbacks = { onUserInteraction };

  const series: uPlot.Series[] = [
    {},
    ...signals.map((sig) => ({
      label: sig.signalName,
      stroke: sig.colour,
      width: 2,
      points: { show: false },
      spanGaps: true,
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
  const signals = useMemo(() => flowSignals(panel), [panel.targetFrameId, panel.byteCount]);
  const { containerRef, stats } = useUPlotPanel({
    panel,
    signals,
    canvasRef,
    buildOptions: (width, height, onUserInteraction) => buildOptions(signals, width, height, onUserInteraction),
    optionsKey: signals.map((s) => `${s.frameId}:${s.signalName}`).join("|"),
  });

  if (panel.targetFrameId == null) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={emptyStateText}>Select a frame ID in Configure Panel</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />
      {panel.showStats && <StatsOverlay signals={signals} stats={stats} />}
    </div>
  );
}
