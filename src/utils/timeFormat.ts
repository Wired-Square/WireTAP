// ui/src/utils/timeFormat.ts

import React from "react";

/**
 * Formats a timestamp in microseconds into ISO-like string with microsecond precision.
 * Epoch timestamps (≥ year 2000): full ISO "YYYY-MM-DDTHH:MM:SS.mmmmmm Z"
 * Relative/normalised timestamps (< year 2000): time-only "HH:MM:SS.mmmuuuZ"
 */
export function formatIsoUs(ts_us: number): string {
  const msPart = Math.floor(ts_us / 1000);
  const usRemainder = ts_us % 1000;
  const isoMs = new Date(msPart).toISOString(); // includes milliseconds
  const isRelative = ts_us < 946684800_000_000;
  if (isRelative) {
    // Strip date portion: "1970-01-01T00:00:14.865Z" → "00:00:14.865"
    const timePart = isoMs.slice(11, -1); // "HH:MM:SS.mmm"
    return `${timePart}${usRemainder.toString().padStart(3, "0")}Z`;
  }
  const isoNoZ = isoMs.slice(0, -1); // drop trailing Z
  return `${isoNoZ}${usRemainder.toString().padStart(3, "0")}Z`;
}

/**
 * Formats a timestamp in microseconds into a human-readable UTC date and time.
 * Epoch timestamps (≥ year 2000): "YYYY-MM-DD HH:MM:SS.mmmuuu"
 * Relative/normalised timestamps (< year 2000): "HH:MM:SS.mmmuuu"
 */
export function formatHumanUs(ts_us: number): string {
  const msPart = Math.floor(ts_us / 1000);
  const usRemainder = ts_us % 1000;
  const date = new Date(msPart);

  // Timestamps before year 2000 in µs are relative (e.g. normalised CSV imports).
  // Show elapsed time only, no calendar date.
  const isRelative = ts_us < 946684800_000_000;

  const datePart = isRelative
    ? ""
    : (() => {
        const year = date.getUTCFullYear();
        const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
        const day = date.getUTCDate().toString().padStart(2, "0");
        return `${year}-${month}-${day} `;
      })();

  // Format time part (UTC)
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  const seconds = date.getUTCSeconds().toString().padStart(2, "0");
  const ms = date.getUTCMilliseconds().toString().padStart(3, "0");

  return `${datePart}${hours}:${minutes}:${seconds}.${ms}${usRemainder.toString().padStart(3, "0")}`;
}

/**
 * Renders a delta in microseconds as seconds.milliseconds plus highlighted micros.
 */
export function renderDeltaNode(deltaUs: number): React.ReactNode {
  const secondsMs = (deltaUs / 1_000_000).toFixed(3); // seconds.milliseconds
  const microsRemainder = Math.floor(deltaUs % 1000);
  return React.createElement(
    "span",
    { className: "inline-flex items-baseline gap-1" },
    React.createElement(
      "span",
      { className: "text-[color:var(--text-primary)] font-semibold" },
      `${secondsMs}s`
    ),
    React.createElement(
      "span",
      { className: "text-[11px] text-[color:var(--text-muted)]" },
      `${microsRemainder.toString().padStart(3, "0")}µs`
    )
  );
}

/**
 * Formats a delta in microseconds as a plain string (e.g., "123.456s").
 * Used for timeline labels and tooltips.
 */
export function formatDeltaUs(deltaUs: number): string {
  const seconds = deltaUs / 1_000_000;
  return `${seconds.toFixed(3)}s`;
}

// ============================================================================
// Display & Form Utilities (extracted from Discovery/Decoder components)
// ============================================================================

/**
 * Format epoch seconds to a locale string for display (e.g., clock display).
 * @param epochSeconds - Unix timestamp in seconds
 * @returns Formatted date/time string or empty string if null
 */
export function formatDisplayTime(epochSeconds: number | null): string {
  if (epochSeconds === null) return "";
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleString();
}

/**
 * Convert datetime-local value (local time) to ISO-8601 UTC string for backend.
 * Used for time range inputs in Discovery/Decoder apps.
 * @param localTime - datetime-local format string (e.g., "2025-09-06T11:30")
 * @returns ISO-8601 UTC string or undefined if empty
 */
export function localToUtc(localTime: string): string | undefined {
  if (!localTime) return undefined;
  // datetime-local format: "2025-09-06T11:30"
  // Parse as local time and convert to ISO string (UTC)
  const date = new Date(localTime);
  return date.toISOString();
}

/**
 * Convert epoch microseconds to datetime-local format for input fields.
 * @param microseconds - Unix timestamp in microseconds
 * @returns datetime-local format string with seconds (YYYY-MM-DDTHH:mm:ss)
 */
export function microsToDatetimeLocal(microseconds: number): string {
  const date = new Date(microseconds / 1000); // Convert microseconds to milliseconds
  // Format as YYYY-MM-DDTHH:mm:ss (datetime-local format with seconds)
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/**
 * Generate a filename-friendly date/time string in local time.
 * Format: YYYYMMDD-HHmm (e.g., "20260110-1430")
 * Used for auto-generated export filenames.
 * @param date - Date object (defaults to current time)
 * @returns Filename-friendly date string in local time
 */
export function formatFilenameDate(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}`;
}
