// ui/src/apps/dashboard/utils/dashboardFormat.ts
//
// Shared formatting helpers for dashboard panels, tooltips and measurement overlays.

import type { ValueFormat } from "../../../generated/ValueFormat";

/** Format a numeric value to the signal's `precision`, else to places chosen by its
 *  size. A missing or non-finite value reads "—". */
export function formatValue(v: number | null | undefined, precision?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const places = precision ?? (abs >= 10_000 ? 0 : abs >= 1_000 ? 1 : abs >= 100 ? 2 : 3);
  return toFixedHalfAwayFromZero(v, places);
}

/** Format a value as Rust's `ValueFormat` for its signal says. A missing or non-finite value reads "—". */
export function formatAs(v: number | null | undefined, { places, padded }: ValueFormat): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const text = toFixedHalfAwayFromZero(v, places);
  return padded || places === 0 ? text : text.replace(/\.?0+$/, "");
}

// Rounds the shortest decimal form of `v`, as wslib-quantity's `format_decimal` does,
// so 1.0005 reads 1.001 (toFixed rounds the binary value, 1.000499…) and no -0.000.
function toFixedHalfAwayFromZero(v: number, places: number): string {
  const [mantissa, exponent = "0"] = Math.abs(v).toString().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const pointAt = whole.length + Number(exponent);
  const digits = whole + fraction;
  const at = (i: number) => (i >= 0 && i < digits.length ? digits[i] : "0");
  let kept = "";
  for (let i = Math.min(pointAt, 0); i < pointAt + places; i++) kept += at(i);
  const scaled = BigInt(kept) + (at(pointAt + places) >= "5" ? 1n : 0n);
  const text = scaled.toString().padStart(places + 1, "0");
  const sign = v < 0 && scaled !== 0n ? "-" : "";
  return places === 0 ? sign + text : `${sign}${text.slice(0, -places)}.${text.slice(-places)}`;
}

/** Format a time delta in seconds for human-readable display.
 *  Chooses units automatically: µs, ms, s, min, h. */
export function formatTimeDelta(seconds: number): string {
  const abs = Math.abs(seconds);
  if (abs < 0.001) return `${(seconds * 1_000_000).toFixed(0)} µs`;
  if (abs < 1) return `${(seconds * 1_000).toFixed(1)} ms`;
  if (abs < 60) return `${seconds.toFixed(3)} s`;
  if (abs < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(2)} h`;
}

/** Format a unix timestamp (seconds) to a locale time string. */
export function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString();
}
