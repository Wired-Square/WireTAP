// ui/src/apps/dashboard/widgets/widgetMeta.ts
//
// Pure (component-free) widget metadata. Kept separate from registry.tsx so the
// store can read defaults (title/size) without importing the panel component
// tree — which would import the store back and form a cycle.

import type { LucideIcon } from "lucide-react";
import { LineChart, Gauge, List, Waves, Grid3X3, BarChart2, Lightbulb, LifeBuoy, SlidersHorizontal, Binary, PenTool, Shapes } from "lucide-react";
import i18n from "i18next";
import type { DashboardPanel, PanelType } from "../../../stores/dashboardStore";
import { FALLBACK_LANGUAGE } from "../../../locales";

/** How a widget sources its data — drives default binding + auto-widget selection. */
export type DataShape = "scalar" | "enum" | "bitfield" | "timeseries" | "raw";

/** Rendering surface — drives which export ref is handed in and the export path. */
export type Surface = "svg" | "canvas" | "dom"; // 'dom' = no image export

/** Grouping in the add-panel menu (a divider separates groups). */
export type WidgetCategory = "signal" | "raw" | "custom";

export interface WidgetMeta {
  type: PanelType;
  /** i18n key under the "dashboard" namespace, e.g. "topBar.panelTypes.lineChart". */
  displayName: string;
  icon: LucideIcon;
  surface: Surface;
  dataShape: DataShape;
  category: WidgetCategory;
  /** Key under "dashboard:defaultTitles"; the title a panel shows until it is given one. */
  defaultTitle: string;
  /** Merged into a new panel on creation. */
  defaultConfig?: Partial<DashboardPanel>;
  defaultSize: { w: number; h: number };
  supportsCsv?: boolean;
}

export const WIDGET_META: Partial<Record<PanelType, WidgetMeta>> = {
  "line-chart": {
    type: "line-chart",
    displayName: "topBar.panelTypes.lineChart",
    icon: LineChart,
    surface: "canvas",
    dataShape: "timeseries",
    category: "signal",
    defaultTitle: "lineChart",
    defaultSize: { w: 6, h: 3 },
    supportsCsv: true,
  },
  gauge: {
    type: "gauge",
    displayName: "topBar.panelTypes.gauge",
    icon: Gauge,
    surface: "svg",
    dataShape: "scalar",
    category: "signal",
    defaultTitle: "gauge",
    defaultSize: { w: 3, h: 3 },
  },
  list: {
    type: "list",
    displayName: "topBar.panelTypes.list",
    icon: List,
    surface: "dom",
    dataShape: "scalar",
    category: "signal",
    defaultTitle: "list",
    defaultSize: { w: 3, h: 3 },
  },
  flow: {
    type: "flow",
    displayName: "topBar.panelTypes.flow",
    icon: Waves,
    surface: "canvas",
    dataShape: "timeseries",
    category: "raw",
    defaultTitle: "flow",
    defaultSize: { w: 6, h: 3 },
    supportsCsv: true,
  },
  heatmap: {
    type: "heatmap",
    displayName: "topBar.panelTypes.heatmap",
    icon: Grid3X3,
    surface: "svg",
    dataShape: "bitfield",
    category: "raw",
    defaultTitle: "heatmap",
    defaultSize: { w: 3, h: 3 },
  },
  histogram: {
    type: "histogram",
    displayName: "topBar.panelTypes.histogram",
    icon: BarChart2,
    surface: "canvas",
    dataShape: "scalar",
    category: "raw",
    defaultTitle: "histogram",
    defaultSize: { w: 4, h: 3 },
  },
  "icon-state": {
    type: "icon-state",
    displayName: "topBar.panelTypes.iconState",
    icon: Lightbulb,
    surface: "svg",
    dataShape: "enum",
    category: "signal",
    defaultTitle: "iconState",
    defaultSize: { w: 2, h: 2 },
  },
  rotary: {
    type: "rotary",
    displayName: "topBar.panelTypes.rotary",
    icon: LifeBuoy,
    surface: "svg",
    dataShape: "scalar",
    category: "signal",
    defaultTitle: "rotary",
    defaultConfig: { minValue: -540, maxValue: 540 },
    defaultSize: { w: 3, h: 3 },
  },
  "level-bar": {
    type: "level-bar",
    displayName: "topBar.panelTypes.levelBar",
    icon: SlidersHorizontal,
    surface: "svg",
    dataShape: "scalar",
    category: "signal",
    defaultTitle: "levelBar",
    defaultSize: { w: 3, h: 2 },
  },
  bitfield: {
    type: "bitfield",
    displayName: "topBar.panelTypes.bitfield",
    icon: Binary,
    surface: "svg",
    dataShape: "bitfield",
    category: "raw",
    defaultTitle: "bitfield",
    defaultSize: { w: 3, h: 3 },
  },
  "raw-canvas": {
    type: "raw-canvas",
    displayName: "topBar.panelTypes.rawCanvas",
    icon: PenTool,
    surface: "canvas",
    dataShape: "raw",
    category: "custom",
    defaultTitle: "rawCanvas",
    defaultSize: { w: 4, h: 4 },
  },
  "custom-svg": {
    type: "custom-svg",
    displayName: "topBar.panelTypes.customSvg",
    icon: Shapes,
    surface: "svg",
    dataShape: "raw",
    category: "custom",
    defaultTitle: "customSvg",
    defaultSize: { w: 4, h: 4 },
  },
};

export function getWidgetMeta(type: PanelType): WidgetMeta | undefined {
  return WIDGET_META[type];
}

const defaultTitleKey = (type: PanelType) => `dashboard:defaultTitles.${WIDGET_META[type]?.defaultTitle ?? "panel"}`;

/** An empty title is the default; so is the English default an older dashboard saved. */
export function hasDefaultTitle(panel: Pick<DashboardPanel, "type" | "title">): boolean {
  return !panel.title || panel.title === i18n.t(defaultTitleKey(panel.type), { lng: FALLBACK_LANGUAGE });
}

export function panelTitle(panel: Pick<DashboardPanel, "type" | "title">): string {
  return hasDefaultTitle(panel) ? i18n.t(defaultTitleKey(panel.type)) : panel.title;
}
