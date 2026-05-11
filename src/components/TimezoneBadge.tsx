// ui/src/components/TimezoneBadge.tsx
//
// A clickable badge that shows and allows switching between timezone modes:
// - default: Uses the app's default timezone setting from Settings → Display
// - local: Uses the browser/system timezone
// - utc: Uses UTC
//
// Helpers (TimezoneMode, conversion functions, etc.) live in
// `../utils/timezone` so this file exports only the component — required
// for React Fast Refresh to hot-reload in place rather than triggering
// a full page reload.

import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { iconXs } from "../styles/spacing";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import { getTimezoneLabel, type TimezoneMode } from "../utils/timezone";

type TimezoneBadgeProps = {
  mode: TimezoneMode;
  onChange: (mode: TimezoneMode) => void;
  className?: string;
};

export default function TimezoneBadge({ mode, onChange, className = "" }: TimezoneBadgeProps) {
  const { t } = useTranslation("common");
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
      title={t("timezone.changeTooltip")}
    >
      <Globe className={iconXs} />
      {label}
    </button>
  );
}
