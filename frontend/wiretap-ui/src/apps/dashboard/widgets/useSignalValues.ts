// ui/src/apps/dashboard/widgets/useSignalValues.ts
//
// Each widget's latest values, re-read when new values arrive.

import { useDashboardStore, signalKey, type DashboardState, type SignalRef } from "../../../stores/dashboardStore";
import type { SignalValueFormat } from "../../../generated/SignalValueFormat";
import { formatAs, formatValue } from "../utils/dashboardFormat";

/** Latest value per signal, aligned to `signals` order. Missing signals → NaN. */
export function useSignalValues(signals: SignalRef[]): number[] {
  const latest = useDashboardStore((s) => s.latest);
  return signals.map((s) => latest.get(signalKey(s.frameId, s.signalName)) ?? NaN);
}

/** A getter for a key's latest value as text: Rust's decoded text, else the value
 *  formatted to the signal's precision. */
export function useReadoutOf(): (key: string) => string {
  const latest = useDashboardStore((s) => s.latest);
  const displays = useDashboardStore((s) => s.latestDisplays);
  const precisions = useDashboardStore((s) => s.signalPrecisions);
  return (key) => displays.get(key) ?? formatValue(latest.get(key), precisions.get(key));
}

/** Each signal's latest value as text, aligned to `signals` order. */
export function useSignalReadouts(signals: SignalRef[]): string[] {
  const readoutOf = useReadoutOf();
  return signals.map((s) => readoutOf(signalKey(s.frameId, s.signalName)));
}

type ComputedValueText = (key: string, value: number | null | undefined, kind: keyof SignalValueFormat) => string;

const computedTextIn =
  ({ signalFormats, signalPrecisions }: Pick<DashboardState, "signalFormats" | "signalPrecisions">): ComputedValueText =>
  (key, value, kind) => {
    const format = signalFormats.get(key)?.[kind];
    return format ? formatAs(value, format) : formatValue(value, signalPrecisions.get(key));
  };

/** A value computed from a signal's samples, worded as Rust's format for the signal says. */
export const computedValueText: ComputedValueText = (key, value, kind) =>
  computedTextIn(useDashboardStore.getState())(key, value, kind);

/** `computedValueText`, re-rendering when the formats arrive. */
export function useComputedValueText(): ComputedValueText {
  const signalFormats = useDashboardStore((s) => s.signalFormats);
  const signalPrecisions = useDashboardStore((s) => s.signalPrecisions);
  return computedTextIn({ signalFormats, signalPrecisions });
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
