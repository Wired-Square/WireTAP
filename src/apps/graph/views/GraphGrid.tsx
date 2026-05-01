// ui/src/apps/graph/views/GraphGrid.tsx

import { GridLayout, useContainerWidth, type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { useTranslation } from "react-i18next";
import { useGraphStore, type LayoutItem } from "../../../stores/graphStore";
import PanelWrapper from "./panels/PanelWrapper";
import LineChartPanel from "./panels/line-chart/LineChartPanel";
import GaugePanel from "./panels/gauge/GaugePanel";
import ListPanel from "./panels/list/ListPanel";
import FlowViewPanel from "./panels/flow/FlowViewPanel";
import HeatmapPanel from "./panels/heatmap/HeatmapPanel";
import HistogramPanel from "./panels/histogram/HistogramPanel";
import { useCallback, useMemo, useRef } from "react";
import { emptyStateContainer, emptyStateText } from "../../../styles/typography";
import { buildPanelCsv, buildFlowPanelCsv } from "../utils/graphExport";
import { pickFileToSave, PNG_FILTERS, SVG_FILTERS } from "../../../api/dialogs";
import { saveCatalog } from "../../../api/catalog";
import {
  exportCanvasAsPng,
  exportSvgElementAsSvg,
  exportSvgElementAsPng,
  exportChartAsSvg,
} from "../utils/graphExportImage";

interface Props {
  onOpenPanelConfig: (panelId: string) => void;
}

const gridConfig = {
  cols: 12,
  rowHeight: 40,
  margin: [8, 8] as const,
};

const dragConfig = {
  handle: ".drag-handle",
};

/** Byte colour palette (shared with FlowViewPanel) */
const BYTE_COLOURS = ['#3b82f6','#ef4444','#22c55e','#f59e0b','#a855f7','#06b6d4','#f97316','#ec4899'];

export default function GraphGrid({ onOpenPanelConfig }: Props) {
  const { t } = useTranslation("graph");
  const panels = useGraphStore((s) => s.panels);
  const layout = useGraphStore((s) => s.layout);
  const updateLayout = useGraphStore((s) => s.updateLayout);
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 800 });

  // Canvas/SVG getter refs for image export
  const canvasGettersRef = useRef(new Map<string, () => HTMLCanvasElement | null>());
  const svgGettersRef = useRef(new Map<string, () => SVGSVGElement | null>());

  const handleLayoutChange = useCallback(
    (newLayout: Layout) => {
      const items: LayoutItem[] = newLayout.map((l) => ({
        i: l.i,
        x: l.x,
        y: l.y,
        w: l.w,
        h: l.h,
      }));
      updateLayout(items);
    },
    [updateLayout],
  );

  // CSV export
  const handleExport = useCallback(async (panelId: string) => {
    const panel = useGraphStore.getState().panels.find((p) => p.id === panelId);
    if (!panel) return;

    const csv = panel.type === 'flow'
      ? buildFlowPanelCsv(panel, useGraphStore.getState().seriesBuffers)
      : buildPanelCsv(panel, useGraphStore.getState().seriesBuffers);
    if (!csv) return;

    const path = await pickFileToSave({
      defaultPath: `${panel.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await saveCatalog(path, csv);
  }, []);

  // PNG export
  const handleExportPng = useCallback(async (panelId: string) => {
    const panel = useGraphStore.getState().panels.find((p) => p.id === panelId);
    if (!panel) return;

    const path = await pickFileToSave({
      defaultPath: `${panel.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`,
      filters: PNG_FILTERS,
    });
    if (!path) return;

    // Canvas-based panels (line-chart, flow, histogram)
    const canvasGetter = canvasGettersRef.current.get(panelId);
    if (canvasGetter) {
      const canvas = canvasGetter();
      if (canvas) {
        await exportCanvasAsPng(canvas, path);
        return;
      }
    }

    // SVG-based panels (gauge, heatmap) — render SVG to PNG
    const svgGetter = svgGettersRef.current.get(panelId);
    if (svgGetter) {
      const svg = svgGetter();
      if (svg) {
        await exportSvgElementAsPng(svg, path);
        return;
      }
    }
  }, []);

  // SVG export
  const handleExportSvg = useCallback(async (panelId: string) => {
    const panel = useGraphStore.getState().panels.find((p) => p.id === panelId);
    if (!panel) return;

    const path = await pickFileToSave({
      defaultPath: `${panel.title.replace(/[^a-zA-Z0-9_-]/g, '_')}.svg`,
      filters: SVG_FILTERS,
    });
    if (!path) return;

    // SVG-based panels — direct serialisation
    const svgGetter = svgGettersRef.current.get(panelId);
    if (svgGetter) {
      const svg = svgGetter();
      if (svg) {
        await exportSvgElementAsSvg(svg, path);
        return;
      }
    }

    // Canvas-based panels — generate SVG from data
    if (panel.type === 'line-chart' || panel.type === 'flow' || panel.type === 'histogram') {
      const signals = panel.type === 'flow'
        ? Array.from({ length: panel.byteCount ?? 8 }, (_, i) => ({
            frameId: panel.targetFrameId!,
            signalName: `byte[${i}]`,
            colour: BYTE_COLOURS[i % 8],
          }))
        : panel.signals;

      const containerEl = document.querySelector(`[data-panel-id="${panelId}"]`);
      const rect = containerEl?.getBoundingClientRect();

      await exportChartAsSvg({
        signals,
        buffers: useGraphStore.getState().seriesBuffers,
        width: rect?.width ?? 800,
        height: rect?.height ?? 400,
        path,
        interactive: true,
      });
    }
  }, []);

  // Create stable canvas/SVG ref objects per panel
  const canvasRefsMap = useRef(new Map<string, React.MutableRefObject<(() => HTMLCanvasElement | null) | null>>());
  const svgRefsMap = useRef(new Map<string, React.MutableRefObject<(() => SVGSVGElement | null) | null>>());

  const getCanvasRefForPanel = useCallback((panelId: string) => {
    let ref = canvasRefsMap.current.get(panelId);
    if (!ref) {
      ref = { current: null };
      Object.defineProperty(ref, 'current', {
        get() { return canvasGettersRef.current.get(panelId) ?? null; },
        set(fn: (() => HTMLCanvasElement | null) | null) {
          if (fn) canvasGettersRef.current.set(panelId, fn);
          else canvasGettersRef.current.delete(panelId);
        },
        configurable: true,
      });
      canvasRefsMap.current.set(panelId, ref);
    }
    return ref;
  }, []);

  const getSvgRefForPanel = useCallback((panelId: string) => {
    let ref = svgRefsMap.current.get(panelId);
    if (!ref) {
      ref = { current: null };
      Object.defineProperty(ref, 'current', {
        get() { return svgGettersRef.current.get(panelId) ?? null; },
        set(fn: (() => SVGSVGElement | null) | null) {
          if (fn) svgGettersRef.current.set(panelId, fn);
          else svgGettersRef.current.delete(panelId);
        },
        configurable: true,
      });
      svgRefsMap.current.set(panelId, ref);
    }
    return ref;
  }, []);

  const rglLayout = useMemo(
    () => layout.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
    [layout],
  );

  if (panels.length === 0) {
    return (
      <div className={emptyStateContainer}>
        <p className={emptyStateText}>
          {t("grid.emptyState")}
        </p>
      </div>
    );
  }

  // Determine which export options are available per panel type
  const hasCsv = (type: string) => type === 'line-chart' || type === 'flow' || type === 'histogram';

  return (
    <div ref={containerRef} className="h-full overflow-auto p-2">
      {mounted && (
        <GridLayout
          layout={rglLayout}
          width={width}
          gridConfig={gridConfig}
          dragConfig={dragConfig}
          onLayoutChange={handleLayoutChange}
        >
          {panels.map((panel) => (
            <div key={panel.id} data-panel-id={panel.id}>
              <PanelWrapper
                panel={panel}
                onOpenPanelConfig={() => onOpenPanelConfig(panel.id)}
                onExport={hasCsv(panel.type) ? () => handleExport(panel.id) : undefined}
                onExportPng={() => handleExportPng(panel.id)}
                onExportSvg={() => handleExportSvg(panel.id)}
              >
                {panel.type === "line-chart" ? (
                  <LineChartPanel panel={panel} canvasRef={getCanvasRefForPanel(panel.id)} />
                ) : panel.type === "gauge" ? (
                  <GaugePanel panel={panel} svgRef={getSvgRefForPanel(panel.id)} />
                ) : panel.type === "flow" ? (
                  <FlowViewPanel panel={panel} canvasRef={getCanvasRefForPanel(panel.id)} />
                ) : panel.type === "heatmap" ? (
                  <HeatmapPanel panel={panel} svgRef={getSvgRefForPanel(panel.id)} />
                ) : panel.type === "histogram" ? (
                  <HistogramPanel panel={panel} canvasRef={getCanvasRefForPanel(panel.id)} />
                ) : (
                  <ListPanel panel={panel} />
                )}
              </PanelWrapper>
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
