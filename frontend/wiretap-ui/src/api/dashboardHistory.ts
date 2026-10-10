// ui/src/api/dashboardHistory.ts
//
// The Dashboard's signal history, held per session in Rust (`dashboard_history.rs`).

import { wsTransport } from "../services/wsTransport";
import type { AlignedSeries } from "../generated/AlignedSeries";
import type { HistogramBin } from "../generated/HistogramBin";
import type { HistorySignal } from "../generated/HistorySignal";
import type { SeriesWindow } from "../generated/SeriesWindow";

export type { AlignedSeries, HistogramBin, SeriesWindow };
export type { WindowStats } from "../generated/WindowStats";

const historySignals = (signals: { frameId: number; signalName: string }[]): HistorySignal[] =>
  signals.map(({ frameId, signalName }) => ({ frameId, name: signalName }));

type Signals = Parameters<typeof historySignals>[0];

export function readSeries(sessionId: string, signals: Signals): Promise<SeriesWindow[]> {
  return wsTransport.command("dashboard.series", { session_id: sessionId, signals: historySignals(signals) });
}

/** Every stamp across the signals as x; each signal null where it has no sample. */
export function readAligned(sessionId: string, signals: Signals): Promise<AlignedSeries> {
  return wsTransport.command("dashboard.aligned", { session_id: sessionId, signals: historySignals(signals) });
}

export function readHistograms(sessionId: string, signals: Signals, bins: number): Promise<HistogramBin[][]> {
  return wsTransport.command("dashboard.histogram", { session_id: sessionId, signals: historySignals(signals), bins });
}

/** `""` when no signal has samples. */
export function exportHistoryCsv(sessionId: string, signals: Signals, headers: string[]): Promise<string> {
  return wsTransport.command("dashboard.csv", { session_id: sessionId, signals: historySignals(signals), headers });
}

/** Every window watching the session loses it, with the heatmap counts. */
export async function clearHistory(sessionId: string): Promise<void> {
  await wsTransport.command("dashboard.clear", { session_id: sessionId });
}
