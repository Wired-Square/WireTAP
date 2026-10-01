// ui/src/apps/dashboard/utils/adhocWatch.ts

import type { AdhocSignalRef } from "../../../api/adhoc";
import type { DashboardPanel, HypothesisParams } from "../../../stores/dashboardStore";

/** What the panels chart, for Rust to decode: every signal, flow and bitfield bytes, and heatmap frames. */
export function adhocWatch(
  panels: DashboardPanel[],
  registry: Map<string, HypothesisParams>,
): { signals: AdhocSignalRef[]; heatmaps: number[] } {
  const signals: AdhocSignalRef[] = [];
  const heatmaps: number[] = [];
  for (const panel of panels) {
    const frameId = panel.targetFrameId;
    if (frameId != null && panel.type === "heatmap") heatmaps.push(frameId);
    if (frameId != null && (panel.type === "flow" || panel.type === "bitfield")) {
      for (let i = 0; i < (panel.byteCount ?? 8); i++) signals.push({ frameId, name: `byte[${i}]` });
    }
    for (const s of panel.signals) {
      signals.push({ frameId: s.frameId, name: s.signalName, params: registry.get(s.signalName) });
    }
  }
  return { signals, heatmaps };
}
