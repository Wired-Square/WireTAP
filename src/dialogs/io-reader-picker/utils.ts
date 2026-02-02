// ui/src/dialogs/io-reader-picker/utils.ts
//
// Utility functions for the IoReaderPickerDialog

import type { IOProfile } from "../../hooks/useSettings";

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

// Real-time source types (no speed limiting possible)
const REALTIME_KINDS = ["gvret_tcp", "gvret_usb", "serial", "slcan", "socketcan", "gs_usb", "mqtt"];

/** Check if a profile is a real-time source */
export function isRealtimeProfile(profile: IOProfile): boolean {
  return REALTIME_KINDS.includes(profile.kind || "");
}

// ============================================================================
// Interface Traits (for session compatibility validation)
// ============================================================================

/** Temporal mode - realtime (live streaming) or timeline (recorded data) */
export type TemporalMode = "realtime" | "timeline";

/** Protocol type - determines frame format and compatibility */
export type Protocol = "can" | "canfd" | "modbus" | "serial";

/** Interface traits for validation */
export interface InterfaceTraits {
  temporalMode: TemporalMode;
  protocols: Protocol[];
  canTransmit: boolean;
}

/** Validation result when combining interfaces */
export interface TraitValidation {
  valid: boolean;
  error?: string;
}

/** Profile kinds that support multi-source (multi-bus) mode */
const MULTI_SOURCE_CAPABLE_KINDS = ["gvret_tcp", "gvret_usb", "slcan", "gs_usb", "socketcan", "serial", "mqtt"];

/** Check if a profile supports multi-source mode */
export function isMultiSourceCapable(profile: IOProfile): boolean {
  return MULTI_SOURCE_CAPABLE_KINDS.includes(profile.kind || "");
}

/** Get traits for a profile based on its kind */
export function getProfileTraits(profile: IOProfile): InterfaceTraits {
  const kind = profile.kind || "";

  // Determine temporal mode
  const temporalMode: TemporalMode = isRealtimeProfile(profile) ? "realtime" : "timeline";

  // Determine protocols based on kind
  let protocols: Protocol[];
  switch (kind) {
    case "gvret_tcp":
    case "gvret_usb":
    case "slcan":
    case "gs_usb":
    case "socketcan":
      protocols = ["can"]; // CAN interfaces
      break;
    case "serial":
      protocols = ["serial"]; // Raw serial
      break;
    case "mqtt":
      protocols = ["can"]; // MQTT usually carries CAN frames
      break;
    case "postgres":
    case "csv_file":
      // Recorded sources - could have any protocol, assume CAN for now
      protocols = ["can"];
      break;
    default:
      protocols = ["can"];
  }

  // Determine transmit capability
  const canTransmit = ["gvret_tcp", "gvret_usb", "slcan", "gs_usb", "socketcan"].includes(kind);

  return { temporalMode, protocols, canTransmit };
}

/** Protocol compatibility groups - protocols in the same group can be combined */
function getProtocolGroup(protocol: Protocol): number {
  switch (protocol) {
    case "can":
    case "canfd":
      return 0; // CAN group
    case "modbus":
      return 1;
    case "serial":
      return 2;
    default:
      return -1;
  }
}

/** Check if two protocol sets are compatible */
function areProtocolsCompatible(a: Protocol[], b: Protocol[]): boolean {
  if (a.length === 0 || b.length === 0) return true;

  // Get groups for each protocol set
  const aGroups = new Set(a.map(getProtocolGroup));
  const bGroups = new Set(b.map(getProtocolGroup));

  // Check if there's at least one common group
  for (const group of aGroups) {
    if (bGroups.has(group)) return true;
  }
  return false;
}

/** Validate if a profile can be added to a selection of profiles */
export function validateProfileSelection(
  selectedProfiles: IOProfile[],
  newProfile: IOProfile
): TraitValidation {
  if (selectedProfiles.length === 0) {
    return { valid: true };
  }

  const newTraits = getProfileTraits(newProfile);

  // Check temporal mode compatibility
  const existingTraits = selectedProfiles.map(getProfileTraits);
  const existingMode = existingTraits[0].temporalMode;

  if (newTraits.temporalMode !== existingMode) {
    return {
      valid: false,
      error: `Cannot mix ${existingMode} and ${newTraits.temporalMode} sources`,
    };
  }

  // Timeline sources can only have 1 interface
  if (newTraits.temporalMode === "timeline") {
    return {
      valid: false,
      error: "Timeline sources cannot be combined (single interface only)",
    };
  }

  // Check protocol compatibility
  const existingProtocols = existingTraits.flatMap((t) => t.protocols);
  if (!areProtocolsCompatible(existingProtocols, newTraits.protocols)) {
    return {
      valid: false,
      error: `Incompatible protocols: ${newTraits.protocols.join("/")} cannot be combined with ${[...new Set(existingProtocols)].join("/")}`,
    };
  }

  // Check if the new profile supports multi-source
  if (!isMultiSourceCapable(newProfile)) {
    return {
      valid: false,
      error: `${newProfile.kind} does not support multi-bus mode`,
    };
  }

  return { valid: true };
}
