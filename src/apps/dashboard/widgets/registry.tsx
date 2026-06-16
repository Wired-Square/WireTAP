// ui/src/apps/dashboard/widgets/registry.tsx
//
// Attaches panel components to the pure metadata in widgetMeta.ts. This is the
// single source consumed by DashboardGrid (rendering + export surface) and the
// add-panel menu. Adding a widget = a component + a widgetMeta entry + here.

import type { PanelType } from "../../../stores/dashboardStore";
import type { WidgetMeta } from "./widgetMeta";
import { WIDGET_META } from "./widgetMeta";

import LineChartPanel from "../views/panels/line-chart/LineChartPanel";
import GaugePanel from "../views/panels/gauge/GaugePanel";
import ListPanel from "../views/panels/list/ListPanel";
import FlowViewPanel from "../views/panels/flow/FlowViewPanel";
import HeatmapPanel from "../views/panels/heatmap/HeatmapPanel";
import HistogramPanel from "../views/panels/histogram/HistogramPanel";
import IconStatePanel from "../views/panels/icon-state/IconStatePanel";
import RotaryPanel from "../views/panels/rotary/RotaryPanel";
import LevelBarPanel from "../views/panels/level-bar/LevelBarPanel";
import BitfieldPanel from "../views/panels/bitfield/BitfieldPanel";
import RawCanvasPanel from "../views/panels/raw-canvas/RawCanvasPanel";
import CustomSvgPanel from "../views/panels/custom-svg/CustomSvgPanel";

import type { DashboardPanel } from "../../../stores/dashboardStore";

export interface WidgetRenderProps {
  panel: DashboardPanel;
  // Exactly one of these is supplied, per `surface`:
  canvasRef?: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
  svgRef?: React.MutableRefObject<(() => SVGSVGElement | null) | null>;
}

export interface WidgetDefinition extends WidgetMeta {
  component: React.ComponentType<WidgetRenderProps>;
}

/** Cast helper — each panel's props are a structural subset of WidgetRenderProps. */
const asWidget = (c: unknown) => c as React.ComponentType<WidgetRenderProps>;

/** Component per widget type. Must stay in step with WIDGET_META keys. */
const COMPONENTS: Partial<Record<PanelType, React.ComponentType<WidgetRenderProps>>> = {
  "line-chart": asWidget(LineChartPanel),
  gauge: asWidget(GaugePanel),
  list: asWidget(ListPanel),
  flow: asWidget(FlowViewPanel),
  heatmap: asWidget(HeatmapPanel),
  histogram: asWidget(HistogramPanel),
  "icon-state": asWidget(IconStatePanel),
  rotary: asWidget(RotaryPanel),
  "level-bar": asWidget(LevelBarPanel),
  bitfield: asWidget(BitfieldPanel),
  "raw-canvas": asWidget(RawCanvasPanel),
  "custom-svg": asWidget(CustomSvgPanel),
};

export const WIDGETS: Partial<Record<PanelType, WidgetDefinition>> = Object.fromEntries(
  Object.entries(WIDGET_META).flatMap(([type, meta]) => {
    const component = COMPONENTS[type as PanelType];
    return component ? [[type, { ...meta, component }]] : [];
  }),
) as Partial<Record<PanelType, WidgetDefinition>>;

export function getWidget(type: PanelType): WidgetDefinition | undefined {
  return WIDGETS[type];
}

/** Ordered list for the add-panel menu (signal group first, then raw). */
export const WIDGET_LIST: WidgetDefinition[] = (
  [
    // signal
    "line-chart", "gauge", "list", "icon-state", "rotary", "level-bar",
    // raw
    "flow", "heatmap", "histogram", "bitfield",
    // custom
    "raw-canvas", "custom-svg",
  ] as PanelType[]
)
  .map((t) => WIDGETS[t])
  .filter((w): w is WidgetDefinition => w != null);

/** The fallback component when a panel's type has no registered widget. */
export const FALLBACK_WIDGET = asWidget(ListPanel);
