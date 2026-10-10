// ui/src/apps/dashboard/views/panels/useUPlotPanel.ts
//
// The time charts' uPlot instance: one owner creates and destroys it, it draws
// what Rust aligns for the panel's signals, follows the newest data until the
// user zooms or pans, and resizes in place.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import { useDashboardStore, type DashboardPanel, type SignalRef } from "../../../../stores/dashboardStore";
import { readAligned, type WindowStats } from "../../../../api/dashboardHistory";
import { useHistoryQuery } from "../../widgets/useHistoryQuery";

export function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const COMPACT_WIDTH = 350;
const COMPACT_HEIGHT = 180;

export const isCompact = (width: number, height: number) => ({ w: width < COMPACT_WIDTH, h: height < COMPACT_HEIGHT });

function responsiveKey(w: number, h: number): string {
  const compact = isCompact(w, h);
  return `${compact.w ? "cw" : "nw"}_${compact.h ? "ch" : "nh"}`;
}

interface Options {
  panel: DashboardPanel;
  signals: SignalRef[];
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
  buildOptions: (width: number, height: number, onUserInteraction: () => void) => uPlot.Options;
  /** The chart is rebuilt when this changes. */
  optionsKey: string;
}

export function useUPlotPanel({ panel, signals, canvasRef, buildOptions, optionsKey }: Options) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const respKeyRef = useRef("");
  const [respKey, setRespKey] = useState("");
  const isUpdatingDataRef = useRef(false);
  const zoomResetVersion = useDashboardStore((s) => s.zoomResetVersion);
  const setFollowMode = useDashboardStore((s) => s.setFollowMode);
  const followMode = panel.followMode !== false;

  const signalsKey = signals.map((s) => `${s.frameId}:${s.signalName}`).join("|");
  const aligned = useHistoryQuery(signalsKey, (sessionId) => readAligned(sessionId, signals));
  const data = useMemo(
    () => (aligned ? [aligned.x, ...aligned.y] : [[], ...signals.map(() => [])]) as uPlot.AlignedData,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aligned, signals.length],
  );
  const dataRef = useRef(data);
  dataRef.current = data;
  const buildOptionsRef = useRef(buildOptions);
  buildOptionsRef.current = buildOptions;

  useEffect(() => {
    if (!canvasRef) return;
    canvasRef.current = () => chartRef.current?.ctx.canvas ?? null;
    return () => {
      canvasRef.current = null;
    };
  }, [canvasRef]);

  const onUserInteraction = useCallback(() => {
    if (!isUpdatingDataRef.current) setFollowMode(panel.id, false);
  }, [panel.id, setFollowMode]);

  const programmatic = (act: () => void) => {
    isUpdatingDataRef.current = true;
    act();
    isUpdatingDataRef.current = false;
  };

  // The cleanup destroys exactly the instance it created, so no chart or body
  // tooltip outlives a re-run, StrictMode, HMR or a responsive rebuild.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || signals.length === 0) return;
    const rect = el.getBoundingClientRect();
    const chart = new uPlot(buildOptionsRef.current(rect.width, rect.height, onUserInteraction), dataRef.current, el);
    chartRef.current = chart;
    respKeyRef.current = responsiveKey(rect.width, rect.height);
    return () => {
      chart.destroy();
      if (chartRef.current === chart) chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals.length, optionsKey, respKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    programmatic(() => {
      chart.setData(data);
      const x = data[0];
      if (followMode && x.length > 1 && x[x.length - 1] > x[0]) {
        chart.setScale("x", { min: x[0], max: x[x.length - 1] });
      }
    });
  }, [data, followMode]);

  useEffect(() => {
    if (zoomResetVersion === 0) return;
    const chart = chartRef.current;
    const x = chart?.data[0];
    if (chart && x && x.length > 1) programmatic(() => chart.setScale("x", { min: x[0], max: x[x.length - 1] }));
  }, [zoomResetVersion]);

  // Crossing a breakpoint rebuilds through the owning effect; anything else resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const { contentRect: { width, height } } of entries) {
        if (width <= 0 || height <= 0) continue;
        const key = responsiveKey(width, height);
        if (key !== respKeyRef.current) {
          respKeyRef.current = key;
          setRespKey(key);
        } else {
          chartRef.current?.setSize({ width, height });
        }
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const stats: (WindowStats | null)[] = aligned?.stats ?? [];
  return { containerRef, stats };
}
