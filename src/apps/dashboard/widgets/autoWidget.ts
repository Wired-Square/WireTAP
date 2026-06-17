// ui/src/apps/dashboard/widgets/autoWidget.ts
//
// Choose a widget for a signal: an explicit catalog `display` hint wins;
// otherwise infer from the signal's metadata (enum / min-max / unit).

import type { PanelType } from "../../../stores/dashboardStore";
import type { WidgetConfig, IconStateConfig } from "./configTypes";
import { hintWidget, type DisplayHint } from "./displayHints";

/** The signal facts that drive widget selection. */
export interface SignalMeta {
  unit?: string;
  min?: number;
  max?: number;
  enum?: Record<number, string>;
  format?: string;
}

export interface AutoWidget {
  type: PanelType;
  minValue?: number;
  maxValue?: number;
  widgetConfig?: WidgetConfig;
}

const STATE_COLOURS = ["#22c55e", "#f59e0b", "#ef4444", "#3b82f6", "#a855f7", "#06b6d4"];
const ANGULAR_UNIT = /^\s*(deg|°|degree|degrees|rad|radian)/i;

/** Build icon-state config from an enum: off-ish value 0 dim, others bright. */
function iconStateFromEnum(enumMap: Record<number, string>): IconStateConfig {
  const entries = Object.entries(enumMap).map(([v, label]) => ({ value: Number(v), label }));
  return {
    states: entries.map((e, i) => ({
      value: e.value,
      label: e.label,
      icon: "circle",
      colour: e.value === 0 ? "var(--text-muted)" : STATE_COLOURS[i % STATE_COLOURS.length],
      brightness: e.value === 0 ? 0.3 : 1,
    })),
    fallback: { icon: "circle", colour: "var(--text-muted)" },
  };
}

/** Infer a widget type from metadata when no explicit hint is given. */
function inferType(meta: SignalMeta): PanelType {
  if (meta.enum && Object.keys(meta.enum).length > 0) return "icon-state";
  const bounded = meta.min != null && meta.max != null;
  if (bounded) return meta.unit && ANGULAR_UNIT.test(meta.unit) ? "rotary" : "level-bar";
  return "line-chart";
}

/** Build per-widget config from the signal's metadata + any rich-hint keys.
 *  Returns undefined when nothing needs configuring (defaults suffice). */
function buildConfig(type: PanelType, meta: SignalMeta, hint?: DisplayHint): WidgetConfig | undefined {
  const h = hint && typeof hint !== "string" ? (hint as Record<string, unknown>) : {};
  switch (type) {
    case "icon-state": {
      const states = (h.states as IconStateConfig["states"]) ?? (meta.enum ? iconStateFromEnum(meta.enum).states : undefined);
      return states ? { iconState: { states, fallback: { icon: "circle", colour: "var(--text-muted)" } } } : undefined;
    }
    case "rotary":
      if (h.start_angle == null && h.end_angle == null && h.show_readout == null && h.icon == null) return undefined;
      return { rotary: {
        startAngle: h.start_angle as number | undefined,
        endAngle: h.end_angle as number | undefined,
        showReadout: h.show_readout as boolean | undefined,
        icon: h.icon as string | undefined,
      } };
    case "level-bar":
      if (h.orientation == null && h.thresholds == null) return undefined;
      return { levelBar: {
        orientation: h.orientation as "horizontal" | "vertical" | undefined,
        thresholds: h.thresholds as Array<{ at: number; colour: string }> | undefined,
      } };
    default:
      return undefined;
  }
}

export function widgetForSignal(meta: SignalMeta, hint?: DisplayHint): AutoWidget {
  const type = hint ? hintWidget(hint) : inferType(meta);
  const out: AutoWidget = { type };
  if (meta.min != null) out.minValue = meta.min;
  if (meta.max != null) out.maxValue = meta.max;
  const widgetConfig = buildConfig(type, meta, hint);
  if (widgetConfig) out.widgetConfig = widgetConfig;
  return out;
}
