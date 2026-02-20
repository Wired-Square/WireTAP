// ui/src/apps/graph/views/panels/line-chart/LineChartPanel.tsx

import { useRef, useEffect, useCallback } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useGraphStore, buildAlignedData, getSignalLabel, type GraphPanel, type SignalRef } from "../../../../../stores/graphStore";
import { useSettings } from "../../../../../hooks/useSettings";
import { textSecondary } from "../../../../../styles/colourTokens";

interface Props {
  panel: GraphPanel;
}

/** Read CSS variable value from the document */
function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Format a value for tooltip display */
function formatValue(v: number | null | undefined): string {
  if (v == null) return "—";
  if (Math.abs(v) >= 1000) return v.toFixed(1);
  if (Math.abs(v) >= 100) return v.toFixed(2);
  return v.toFixed(3);
}

/** Responsive breakpoints */
const COMPACT_WIDTH = 350;
const COMPACT_HEIGHT = 180;

/** Tooltip plugin for uPlot — shows signal values at cursor position.
 *  Appended to document.body so it can overflow panel boundaries. */
function tooltipPlugin(
  signals: SignalRef[],
  confidenceColours?: { none: string; low: string; medium: string; high: string },
): uPlot.Plugin {
  let tooltip: HTMLDivElement;

  return {
    hooks: {
      init(_u: uPlot) {
        tooltip = document.createElement("div");
        tooltip.style.cssText = `
          display: none;
          position: fixed;
          pointer-events: none;
          z-index: 9999;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 11px;
          line-height: 1.5;
          white-space: nowrap;
          background: var(--bg-surface);
          color: var(--text-primary);
          border: 1px solid var(--border-default);
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        `;
        document.body.appendChild(tooltip);
      },
      setCursor(u: uPlot) {
        const idx = u.cursor.idx;
        if (idx == null || idx < 0) {
          tooltip.style.display = "none";
          return;
        }

        const ts = u.data[0]?.[idx];
        if (ts == null) {
          tooltip.style.display = "none";
          return;
        }

        // Build tooltip content
        const time = new Date(ts * 1000).toLocaleTimeString();
        let html = `<div style="color: var(--text-muted); margin-bottom: 2px;">${time}</div>`;

        for (let i = 0; i < signals.length; i++) {
          const val = u.data[i + 1]?.[idx];
          const sig = signals[i];
          html += `<div style="display: flex; align-items: center; gap: 6px;">`;
          html += `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${sig.colour}; flex-shrink: 0;"></span>`;
          html += `<span style="color: var(--text-secondary);">${getSignalLabel(sig)}</span>`;
          if (sig.confidence && confidenceColours) {
            const confCol = confidenceColours[sig.confidence] || confidenceColours.none;
            html += `<span style="display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: ${confCol}; flex-shrink: 0;" title="Confidence: ${sig.confidence}"></span>`;
          }
          html += `<span style="margin-left: auto; font-family: ui-monospace, monospace; font-weight: 500;">${formatValue(val as number | null)}</span>`;
          if (sig.unit) html += `<span style="color: var(--text-muted); font-size: 10px;">${sig.unit}</span>`;
          html += `</div>`;
        }

        tooltip.innerHTML = html;
        tooltip.style.display = "block";

        // Position tooltip in screen coordinates near cursor
        const overRect = u.over.getBoundingClientRect();
        const cursorLeft = u.cursor.left ?? 0;
        const cursorTop = u.cursor.top ?? 0;
        const tipRect = tooltip.getBoundingClientRect();

        let tipX = overRect.left + cursorLeft + 12;
        let tipY = overRect.top + cursorTop - tipRect.height / 2;

        // Flip to left side if too close to right edge of viewport
        if (tipX + tipRect.width > window.innerWidth - 8) {
          tipX = overRect.left + cursorLeft - tipRect.width - 12;
        }
        // Clamp vertical position to viewport
        tipY = Math.max(4, Math.min(tipY, window.innerHeight - tipRect.height - 4));

        tooltip.style.left = `${tipX}px`;
        tooltip.style.top = `${tipY}px`;
      },
      destroy(_u: uPlot) {
        tooltip?.remove();
      },
    },
  };
}

/** Build uPlot options for this panel */
function buildOptions(
  panel: GraphPanel,
  width: number,
  height: number,
  confidenceColours?: { none: string; low: string; medium: string; high: string },
): uPlot.Options {
  const textColour = getCssVar("--text-primary") || "#e2e8f0";
  const gridColour = getCssVar("--border-default") || "rgba(255,255,255,0.1)";
  const isCompactW = width < COMPACT_WIDTH;
  const isCompactH = height < COMPACT_HEIGHT;

  const series: uPlot.Series[] = [
    {}, // x-axis (time)
    ...panel.signals.map((sig) => ({
      label: getSignalLabel(sig),
      stroke: sig.colour,
      width: 2,
      points: { show: false },
    })),
  ];

  return {
    width,
    height,
    series,
    plugins: [tooltipPlugin(panel.signals, confidenceColours)],
    cursor: {
      drag: { x: false, y: false },
      points: {
        size: 6,
        fill: (_u: uPlot, seriesIdx: number) => panel.signals[seriesIdx - 1]?.colour ?? "#fff",
      },
    },
    scales: {
      x: {
        time: true,
      },
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
      },
    ],
    legend: {
      show: !isCompactH && panel.signals.length > 1,
    },
  };
}

/** Compute a responsive class key — chart recreates when this changes */
function responsiveKey(w: number, h: number): string {
  return `${w < COMPACT_WIDTH ? "cw" : "nw"}_${h < COMPACT_HEIGHT ? "ch" : "nh"}`;
}

export default function LineChartPanel({ panel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const respKeyRef = useRef<string>("");
  const dataVersion = useGraphStore((s) => s.dataVersion);
  const seriesBuffers = useGraphStore((s) => s.seriesBuffers);
  const { settings } = useSettings();

  const confidenceColours = settings ? {
    none: settings.signal_colour_none || '#94a3b8',
    low: settings.signal_colour_low || '#f59e0b',
    medium: settings.signal_colour_medium || '#3b82f6',
    high: settings.signal_colour_high || '#22c55e',
  } : undefined;

  // Destroy chart on unmount
  useEffect(() => {
    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  // Re-create chart when panel signals change (series config changes)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Destroy existing chart
    chartRef.current?.destroy();
    chartRef.current = null;

    if (panel.signals.length === 0) return;

    const rect = el.getBoundingClientRect();
    const opts = buildOptions(panel, rect.width, rect.height, confidenceColours);
    const data = buildAlignedData(panel.signals, seriesBuffers) as uPlot.AlignedData;

    const chart = new uPlot(opts, data, el);
    chartRef.current = chart;
    respKeyRef.current = responsiveKey(rect.width, rect.height);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.signals.length, ...panel.signals.map((s) => `${s.frameId}:${s.signalName}:${s.colour}:${s.displayName ?? ''}`)]);

  // Update data when dataVersion changes (new signal values pushed)
  const updateData = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || panel.signals.length === 0) return;

    const data = buildAlignedData(panel.signals, useGraphStore.getState().seriesBuffers) as uPlot.AlignedData;
    chart.setData(data);
  }, [panel.signals]);

  useEffect(() => {
    updateData();
  }, [dataVersion, updateData]);

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

          const opts = buildOptions(panel, width, height, confidenceColours);
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
  }, [panel.signals]);

  if (panel.signals.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className={`text-xs ${textSecondary}`}>
          Click + to add signals
        </p>
      </div>
    );
  }

  return <div ref={containerRef} className="w-full h-full" />;
}
