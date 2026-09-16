// ui/src/dialogs/io-source-picker/LoadOptions.tsx

import { useTranslation } from "react-i18next";
import { sectionHeader, caption, captionMuted } from "../../styles/typography";
import { borderDivider, bgSurface } from "../../styles";
import type { IOProfile } from "../../hooks/useSettings";
import type { TimeRangeFavorite } from "../../utils/favorites";
import TimeBoundsInput, { type TimeBounds } from "../../components/TimeBoundsInput";
import { SPEED_OPTIONS, CSV_EXTERNAL_ID, isRealtimeProfile } from "./utils";

type Props = {
  checkedSourceId: string | null;
  checkedProfile: IOProfile | null;
  isLoading: boolean;
  // Time bounds (combined start/end/maxFrames/timezone)
  timeBounds: TimeBounds;
  onTimeBoundsChange: (bounds: TimeBounds) => void;
  // Speed
  selectedSpeed: number;
  onSpeedChange: (speed: number) => void;
  // Bookmarks
  profileBookmarks: TimeRangeFavorite[];
};

export default function LoadOptions({
  checkedSourceId,
  checkedProfile,
  isLoading,
  timeBounds,
  onTimeBoundsChange,
  selectedSpeed,
  onSpeedChange,
  profileBookmarks,
}: Props) {
  const { t } = useTranslation("dialogs");
  // Don't show options if no source is checked, CSV is selected, or loading
  if (!checkedSourceId || checkedSourceId === CSV_EXTERNAL_ID || isLoading) {
    return null;
  }

  const isCheckedRealtime = checkedProfile ? isRealtimeProfile(checkedProfile) : false;

  return (
    <div className={borderDivider}>
      <div className={`px-4 py-2 bg-[var(--bg-surface)] ${sectionHeader}`}>
        {t("ioSourcePicker.options")}
      </div>
      <div className="p-3 space-y-3">
        {/* Time bounds (for recorded sources only) */}
        {!isCheckedRealtime && (
          <TimeBoundsInput
            value={timeBounds}
            onChange={onTimeBoundsChange}
            bookmarks={profileBookmarks}
            showBookmarks={profileBookmarks.length > 0}
          />
        )}

        {/* Speed (for Connect mode, recorded sources only) */}
        {!isCheckedRealtime && (
          <div>
            <label className={`block ${caption} mb-1`}>
              {t("ioSourcePicker.playbackSpeed")}
            </label>
            <select
              value={selectedSpeed}
              onChange={(e) => onSpeedChange(Number(e.target.value))}
              className={`w-full px-2 py-1.5 text-xs rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-secondary)]`}
            >
              {SPEED_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className={`${captionMuted} mt-1`}>
              {t("ioSourcePicker.loadingMaxSpeed")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
