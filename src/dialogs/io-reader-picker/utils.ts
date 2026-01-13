// ui/src/dialogs/io-reader-picker/utils.ts
//
// Utility functions for the IoReaderPickerDialog

import type { IOProfile } from "../../hooks/useSettings";

/** Convert a datetime-local value to ISO-8601 string with explicit timezone offset */
export function localToIsoWithOffset(datetimeLocal: string): string {
  if (!datetimeLocal) return "";
  // datetime-local is in format "YYYY-MM-DDTHH:mm" (local time, no timezone)
  // Add the local timezone offset to make it explicit
  const date = new Date(datetimeLocal);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${datetimeLocal}:00${sign}${hours}:${minutes}`;
}

/** Get the local timezone abbreviation (e.g., "AEDT", "PST") */
export function getLocalTimezoneAbbr(): string {
  const formatter = new Intl.DateTimeFormat("en", { timeZoneName: "short" });
  const parts = formatter.formatToParts(new Date());
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  return tzPart?.value || "Local";
}

/** Format a Unix timestamp (seconds) as a time string (e.g., "10:30 AM") */
export function formatBufferTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// Ingest speed options (0 = no limit / wire speed)
export const SPEED_OPTIONS = [
  { value: 0, label: "No Limit" },
  { value: 1, label: "1x" },
  { value: 2, label: "2x" },
  { value: 10, label: "10x" },
  { value: 30, label: "30x" },
  { value: 60, label: "60x" },
];

// Special ID for the imported buffer "profile"
export const BUFFER_PROFILE_ID = "__imported_buffer__";

// Special ID for CSV external source
export const CSV_EXTERNAL_ID = "__csv_external__";

// Session ID for ingest operations (exported for use by parent components)
export const INGEST_SESSION_ID = "__ingest__";

// Real-time source types (no speed limiting possible)
const REALTIME_KINDS = ["gvret_tcp", "gvret_usb", "serial", "slcan", "socketcan", "gs_usb", "mqtt"];

/** Check if a profile is a real-time source */
export function isRealtimeProfile(profile: IOProfile): boolean {
  return REALTIME_KINDS.includes(profile.kind || "");
}
