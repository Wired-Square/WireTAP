// ui/src/utils/dashboards.ts
//
// Standalone dashboard artifact schema. Reuses the DashboardPanel/LayoutItem shapes
// so loading a dashboard is the same as loading a saved layout, plus identity
// and the catalog the bindings assume.

import type { DashboardPanel, LayoutItem, HypothesisParams } from "../stores/dashboardStore";
import { getWidgetMeta } from "../apps/dashboard/widgets/widgetMeta";

export const DASHBOARD_SCHEMA = "wiretap.dashboard/1";

export interface DashboardFileContent {
  schema: string;
  name: string;
  /** The catalog filename the signal bindings assume (for decode + mismatch warnings). */
  catalogFilename?: string;
  panels: DashboardPanel[];
  layout: LayoutItem[];
  candidateRegistry?: [string, HypothesisParams][];
  createdAt?: number;
  updatedAt?: number;
}

/** Build a dashboard artifact from the current panels/layout. */
export function buildDashboard(
  name: string,
  catalogFilename: string,
  panels: DashboardPanel[],
  layout: LayoutItem[],
  candidateRegistry: Map<string, HypothesisParams>,
  now: number,
): DashboardFileContent {
  return {
    schema: DASHBOARD_SCHEMA,
    name,
    catalogFilename: catalogFilename || undefined,
    panels: structuredClone(panels),
    layout: structuredClone(layout),
    candidateRegistry: candidateRegistry.size > 0 ? Array.from(candidateRegistry.entries()) : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

/** Parse + validate a dashboard JSON string. Throws on malformed input. */
export function parseDashboard(json: string): DashboardFileContent {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error(`Dashboard is not valid JSON: ${e}`);
  }
  const d = data as Partial<DashboardFileContent>;
  if (!d || typeof d !== "object") throw new Error("Dashboard must be an object");
  if (d.schema !== DASHBOARD_SCHEMA) throw new Error(`Unsupported dashboard schema: ${d.schema}`);
  if (!Array.isArray(d.panels) || !Array.isArray(d.layout)) throw new Error("Dashboard must have panels[] and layout[]");
  for (const p of d.panels) {
    if (!p || typeof p.type !== "string" || !getWidgetMeta(p.type)) {
      throw new Error(`Dashboard panel has unknown widget type: ${(p as DashboardPanel)?.type}`);
    }
  }
  return d as DashboardFileContent;
}

/** Suggest a filename from a dashboard name. */
export function dashboardFilename(name: string): string {
  const slug = name.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "dashboard";
  return `${slug}.dashboard.json`;
}
