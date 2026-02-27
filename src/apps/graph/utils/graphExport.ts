// ui/src/apps/graph/utils/graphExport.ts
//
// CSV export builder for graph panel data.

import { readTimeSeries, getSignalLabel, type GraphPanel, type SignalTimeSeries, type SignalRef } from "../../../stores/graphStore";
import { buildCsv } from "../../../utils/csvBuilder";
import { formatTimestampIso } from "./graphFormat";

/**
 * Build CSV content from a panel's signal data.
 * Columns: timestamp, signal1, signal2, ...
 * Each signal gets its own column with aligned timestamps.
 */
export function buildPanelCsv(
  panel: GraphPanel,
  buffers: Map<string, SignalTimeSeries>,
): string {
  if (panel.signals.length === 0) return "";

  // Read all series
  const seriesData = panel.signals.map((sig) => {
    const key = `${sig.frameId}:${sig.signalName}`;
    const series = buffers.get(key);
    if (series && series.count > 0) {
      return readTimeSeries(series);
    }
    return { timestamps: [] as number[], values: [] as number[] };
  });

  // Collect all unique timestamps and sort
  const tsSet = new Set<number>();
  for (const s of seriesData) {
    for (const t of s.timestamps) tsSet.add(t);
  }
  const allTimestamps = Array.from(tsSet).sort((a, b) => a - b);

  if (allTimestamps.length === 0) return "";

  // Build lookup maps for each signal (timestamp → value)
  const lookups = seriesData.map((s) => {
    const map = new Map<number, number>();
    for (let i = 0; i < s.timestamps.length; i++) {
      map.set(s.timestamps[i], s.values[i]);
    }
    return map;
  });

  // Header row
  const headers = [
    "timestamp",
    ...panel.signals.map((sig) => {
      const label = getSignalLabel(sig);
      return sig.unit ? `${label} (${sig.unit})` : label;
    }),
  ];

  // Data rows
  const rows: (string | number)[][] = [];
  for (const ts of allTimestamps) {
    const row: (string | number)[] = [formatTimestampIso(ts)];
    for (const lookup of lookups) {
      const v = lookup.get(ts);
      row.push(v != null ? v : "");
    }
    rows.push(row);
  }

  return buildCsv(headers, rows);
}

/**
 * Build CSV for a flow panel (raw byte time-series).
 * Constructs synthetic signal refs from targetFrameId + byteCount.
 */
export function buildFlowPanelCsv(
  panel: GraphPanel,
  buffers: Map<string, SignalTimeSeries>,
): string {
  if (panel.targetFrameId == null) return "";
  const count = panel.byteCount ?? 8;
  const signals: SignalRef[] = Array.from({ length: count }, (_, i) => ({
    frameId: panel.targetFrameId!,
    signalName: `byte[${i}]`,
    colour: "#000",
  }));

  // Reuse the same CSV logic as buildPanelCsv with synthetic signals
  const syntheticPanel: GraphPanel = { ...panel, signals };
  return buildPanelCsv(syntheticPanel, buffers);
}
