// ui/src/apps/dashboard/widgets/useSignalValues.ts
//
// Each widget's latest values, re-read when new values arrive.

import { useDashboardStore, signalKey, type SignalRef } from "../../../stores/dashboardStore";

/** Latest value per signal, aligned to `signals` order. Missing signals → NaN. */
export function useSignalValues(signals: SignalRef[]): number[] {
  const latest = useDashboardStore((s) => s.latest);
  return signals.map((s) => latest.get(signalKey(s.frameId, s.signalName)) ?? NaN);
}

/** Latest value for one "frameId:signalName" key, or NaN. */
export function useSignalValue(key: string | undefined): number {
  const latest = useDashboardStore((s) => s.latest);
  return key ? latest.get(key) ?? NaN : NaN;
}

/** The "frameId:signalName" keys feeding a custom widget: explicit config if set,
 *  else the panel's bound signals in order. */
export function customWidgetKeys(signals: SignalRef[], explicit?: string[]): string[] {
  return explicit?.length ? explicit : signals.map((s) => signalKey(s.frameId, s.signalName));
}

/** A getter that samples the latest value of each key into a fresh Float64Array.
 *  Used by the custom-widget worker host (reads the store imperatively per frame). */
export function makeSignalSampler(keys: string[]): () => Float64Array {
  return () => {
    const latest = useDashboardStore.getState().latest;
    const arr = new Float64Array(keys.length);
    for (let i = 0; i < keys.length; i++) arr[i] = latest.get(keys[i]) ?? NaN;
    return arr;
  };
}
