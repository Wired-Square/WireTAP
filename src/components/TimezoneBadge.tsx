// ui/src/components/TimezoneBadge.tsx
//
// A clickable badge that shows and allows switching between timezone modes:
// - default: Uses the app's default timezone setting from Settings → Display
// - local: Uses the browser/system timezone
// - utc: Uses UTC

import { Globe } from "lucide-react";
import { iconXs } from "../styles/spacing";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";

export type TimezoneMode = "default" | "local" | "utc";

/** Get the local timezone abbreviation (e.g., "AEDT", "PST") */
export function getLocalTimezoneAbbr(): string {
  const formatter = new Intl.DateTimeFormat("en", { timeZoneName: "short" });
  const parts = formatter.formatToParts(new Date());
  const tzPart = parts.find((p) => p.type === "timeZoneName");
  return tzPart?.value || "Local";
}

/** Get the display label for a timezone mode */
export function getTimezoneLabel(mode: TimezoneMode, defaultTz: "local" | "utc"): string {
  switch (mode) {
    case "default":
      return defaultTz === "utc" ? "Default (UTC)" : `Default (${getLocalTimezoneAbbr()})`;
    case "local":
      return getLocalTimezoneAbbr();
    case "utc":
      return "UTC";
  }
}

/** Get the effective timezone for a mode */
export function getEffectiveTimezone(mode: TimezoneMode, defaultTz: "local" | "utc"): "local" | "utc" {
  if (mode === "default") {
    return defaultTz;
  }
  return mode;
}

/** Convert a datetime-local string to UTC ISO string */
export function localToUtc(datetimeLocal: string): string {
  if (!datetimeLocal) return "";
  const date = new Date(datetimeLocal);
  return date.toISOString();
}

/** Convert a UTC ISO string to datetime-local format */
export function utcToLocal(isoString: string): string {
  if (!isoString) return "";
  const date = new Date(isoString);
  // Format as YYYY-MM-DDTHH:mm:ss (local time)
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

/** Convert a datetime-local string from one timezone mode to another */
export function convertDatetimeLocal(
  value: string,
  fromMode: TimezoneMode,
  toMode: TimezoneMode,
  defaultTz: "local" | "utc"
): string {
  if (!value) return "";

  const fromTz = getEffectiveTimezone(fromMode, defaultTz);
  const toTz = getEffectiveTimezone(toMode, defaultTz);

  if (fromTz === toTz) return value;

  if (fromTz === "local" && toTz === "utc") {
    // Convert local to UTC - the input is local time, output as UTC datetime-local
    const date = new Date(value);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
  } else {
    // Convert UTC to local - the input is UTC time, output as local datetime-local
    // Parse the value as UTC
    const [datePart, timePart] = value.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const timeParts = (timePart || "00:00:00").split(":").map(Number);
    const hours = timeParts[0] ?? 0;
    const minutes = timeParts[1] ?? 0;
    const seconds = timeParts[2] ?? 0;
    const date = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
    return utcToLocal(date.toISOString());
  }
}

type TimezoneBadgeProps = {
  mode: TimezoneMode;
  onChange: (mode: TimezoneMode) => void;
  className?: string;
};

export default function TimezoneBadge({ mode, onChange, className = "" }: TimezoneBadgeProps) {
  const defaultTz = useSettingsStore((s) => s.display.timezone);
  const label = getTimezoneLabel(mode, defaultTz);

  const handleClick = () => {
    // Cycle through modes: default → local → utc → default
    const next: TimezoneMode = mode === "default" ? "local" : mode === "local" ? "utc" : "default";
    onChange(next);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full
        bg-[var(--status-info-bg)] text-[color:var(--status-info-text)]
        hover:brightness-95 transition-colors cursor-pointer ${className}`}
      title="Click to change timezone"
    >
      <Globe className={iconXs} />
      {label}
    </button>
  );
}
