// ui/src/dialogs/io-reader-picker/utils.ts
//
// Utility functions for the IoReaderPickerDialog

/** Convert a datetime-local value to ISO-8601 string with explicit timezone offset */
export function localToIsoWithOffset(datetimeLocal: string): string {
  if (!datetimeLocal) return "";
  // datetime-local is in format "YYYY-MM-DDTHH:mm" or "YYYY-MM-DDTHH:mm:ss" (local time, no timezone)
  // Add the local timezone offset to make it explicit
  const date = new Date(datetimeLocal);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0");
  // Only add :00 for seconds if not already present (format without seconds is 16 chars: YYYY-MM-DDTHH:mm)
  const timeWithSeconds = datetimeLocal.length <= 16 ? `${datetimeLocal}:00` : datetimeLocal;
  return `${timeWithSeconds}${sign}${hours}:${minutes}`;
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

import type { PlaybackSpeed } from "../../components/TimeController";

// Watch speed options - no "unlimited" since watching implies paced playback
export const SPEED_OPTIONS: { value: PlaybackSpeed; label: string }[] = [
  { value: 0.25, label: "0.25x" },
  { value: 0.5, label: "0.5x" },
  { value: 1, label: "1x (realtime)" },
  { value: 2, label: "2x" },
  { value: 10, label: "10x" },
  { value: 30, label: "30x" },
  { value: 60, label: "60x" },
];

// Special ID for the imported buffer "profile"
export const BUFFER_PROFILE_ID = "__imported_buffer__";

// Special ID for CSV external source
export const CSV_EXTERNAL_ID = "__csv_external__";

// Legacy session ID for ingest operations - DEPRECATED
// Use generateIngestSessionId() instead for unique session IDs
export const INGEST_SESSION_ID = "__ingest__";

/**
 * Generate a unique session ID for ingest operations.
 * Pattern: ingest_{shortId}
 * Examples: ingest_a7f3c9, ingest_b2c4d6
 */
export function generateIngestSessionId(): string {
  const shortId = Math.random().toString(16).slice(2, 8);
  return `ingest_${shortId}`;
}

// ============================================================================
// Profile Traits - Re-exported from centralised module
// ============================================================================

export {
  // Types
  type TemporalMode,
  type Protocol,
  type ProfileTraits,
  type TraitValidation,
  type InterfaceTraits,
  type Platform,
  type ProfileKind,
  // Functions
  getProfileTraits,
  getTraitsForKind,
  isRealtimeProfile,
  isMultiSourceCapable,
  validateProfileSelection,
  canTransmit,
  isKindAvailableOnPlatform,
  isProfileAvailableOnPlatform,
  getAvailableProfileKinds,
} from "../../utils/profileTraits";
