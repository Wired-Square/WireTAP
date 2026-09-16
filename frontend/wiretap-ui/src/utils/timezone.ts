// ui/src/utils/timezone.ts
//
// Timezone helpers used by `TimezoneBadge` and `TimeBoundsInput`.
// Separated from the component file so React Fast Refresh can hot-
// reload `TimezoneBadge.tsx` without falling back to a full page
// reload (rule: a *.tsx file should export only React components).

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
