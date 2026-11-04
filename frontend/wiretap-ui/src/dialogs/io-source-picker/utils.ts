// ui/src/dialogs/io-source-picker/utils.ts
//
// Utility functions for the IoSourcePickerDialog

import i18n from "i18next";
import type { PlaybackSpeed } from "../../components/TimeController";

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

// Watch speed options - no "unlimited" since watching implies paced playback
export const SPEED_OPTIONS: { value: PlaybackSpeed; label: string }[] = [
  { value: 0.25, label: "0.25x" },
  { value: 0.5, label: "0.5x" },
  {
    value: 1,
    get label() {
      return i18n.t("common:playback.speedRealtime");
    },
  },
  { value: 2, label: "2x" },
  { value: 10, label: "10x" },
  { value: 30, label: "30x" },
  { value: 60, label: "60x" },
];

// Special ID for CSV external source
export const CSV_EXTERNAL_ID = "__csv_external__";
