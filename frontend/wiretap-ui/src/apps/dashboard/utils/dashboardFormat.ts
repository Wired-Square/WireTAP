// ui/src/apps/dashboard/utils/dashboardFormat.ts
//
// Shared formatting helpers for dashboard panels, tooltips and measurement overlays.

/** Format a numeric value for display with adaptive decimal precision.
 *  A missing or non-finite value reads "—". */
export function formatValue(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 10_000) return v.toFixed(0);
  if (abs >= 1_000) return v.toFixed(1);
  if (abs >= 100) return v.toFixed(2);
  return v.toFixed(3);
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
