// ui/src/apps/dashboard/widgets/useSignalValues.ts
//
// Shared hook factoring the seriesBuffers lookup every widget repeats: subscribe
// to dataVersion (re-render on new data) and read each signal's latest value.

import { useDashboardStore, type SignalRef } from "../../../stores/dashboardStore";

/** Latest value per signal, aligned to `signals` order. Missing signals → NaN. */
export function useSignalValues(signals: SignalRef[]): number[] {
  const dataVersion = useDashboardStore((s) => s.dataVersion);
  const buffers = useDashboardStore((s) => s.seriesBuffers);
  void dataVersion; // re-runs the map when new data arrives
  return signals.map((s) => buffers.get(`${s.frameId}:${s.signalName}`)?.latestValue ?? NaN);
}

/** Latest value for one "frameId:signalName" key, or NaN. */
export function useSignalValue(signalKey: string | undefined): number {
  const dataVersion = useDashboardStore((s) => s.dataVersion);
  const buffers = useDashboardStore((s) => s.seriesBuffers);
  void dataVersion;
  return signalKey ? buffers.get(signalKey)?.latestValue ?? NaN : NaN;
}

/** The "frameId:signalName" keys feeding a custom widget: explicit config if set,
 *  else the panel's bound signals in order. */
export function customWidgetKeys(signals: SignalRef[], explicit?: string[]): string[] {
  return explicit?.length ? explicit : signals.map((s) => `${s.frameId}:${s.signalName}`);
}

/** A getter that samples the latest value of each key into a fresh Float64Array.
 *  Used by the custom-widget worker host (reads the store imperatively per frame). */
export function makeSignalSampler(keys: string[]): () => Float64Array {
  return () => {
    const buffers = useDashboardStore.getState().seriesBuffers;
    const arr = new Float64Array(keys.length);
    for (let i = 0; i < keys.length; i++) arr[i] = buffers.get(keys[i])?.latestValue ?? NaN;
    return arr;
  };
}
