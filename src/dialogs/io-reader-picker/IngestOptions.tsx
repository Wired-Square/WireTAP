// ui/src/dialogs/io-reader-picker/IngestOptions.tsx

import { Bookmark, Globe } from "lucide-react";
import { iconXs } from "../../styles/spacing";
import { sectionHeader, caption, captionMuted } from "../../styles/typography";
import { borderDivider, bgSurface } from "../../styles";
import type { IOProfile } from "../../hooks/useSettings";
import type { TimeRangeFavorite } from "../../utils/favorites";
import { SPEED_OPTIONS, CSV_EXTERNAL_ID, isRealtimeProfile } from "./utils";

type Props = {
  checkedReaderId: string | null;
  checkedProfile: IOProfile | null;
  isIngesting: boolean;
  // Time range
  startTime: string;
  endTime: string;
  onStartTimeChange: (value: string) => void;
  onEndTimeChange: (value: string) => void;
  // Timezone
  timezoneMode: "local" | "utc";
  localTzAbbr: string;
  onTimezoneModeChange: (mode: "local" | "utc") => void;
  // Max frames/bytes
  maxFrames: string;
  onMaxFramesChange: (value: string) => void;
  // Speed
  selectedSpeed: number;
  onSpeedChange: (speed: number) => void;
  // Bookmarks
  profileBookmarks: TimeRangeFavorite[];
  onSelectBookmark: (bookmark: TimeRangeFavorite) => void;
};

export default function IngestOptions({
  checkedReaderId,
  checkedProfile,
  isIngesting,
  startTime,
  endTime,
  onStartTimeChange,
  onEndTimeChange,
  timezoneMode,
  localTzAbbr,
  onTimezoneModeChange,
  maxFrames,
  onMaxFramesChange,
  selectedSpeed,
  onSpeedChange,
  profileBookmarks,
  onSelectBookmark,
}: Props) {
  // Don't show options if no reader is checked, CSV is selected, or ingesting
  if (!checkedReaderId || checkedReaderId === CSV_EXTERNAL_ID || isIngesting) {
    return null;
  }

  const isCheckedRealtime = checkedProfile ? isRealtimeProfile(checkedProfile) : false;
  const maxLabel = checkedProfile?.kind === "serial" ? "Max Bytes" : "Max Frames";

  return (
    <div className={borderDivider}>
      <div className={`px-4 py-2 bg-[var(--bg-surface)] ${sectionHeader}`}>
        Options
      </div>
      <div className="p-3 space-y-3">
        {/* Bookmarks (for recorded sources only) */}
        {!isCheckedRealtime && profileBookmarks.length > 0 && (
          <div>
            <label className={`block ${caption} mb-1.5`}>
              Bookmarks
            </label>
            <div className="flex flex-wrap gap-1">
              {profileBookmarks.map((bm) => (
                <button
                  key={bm.id}
                  onClick={() => onSelectBookmark(bm)}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-[var(--status-warning-bg)] text-[color:var(--text-amber)] rounded hover:brightness-95 transition-colors"
                  title={`${bm.startTime} → ${bm.endTime}`}
                >
                  <Bookmark className={iconXs} />
                  <span className="max-w-24 truncate">{bm.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Time range (for recorded sources only) */}
        {!isCheckedRealtime && (
          <div className="space-y-2">
            {/* Timezone toggle */}
            <div className="flex items-center justify-between">
              <label className={caption}>Time Zone</label>
              <div className="flex items-center gap-1 bg-[var(--hover-bg)] rounded p-0.5">
                <button
                  type="button"
                  onClick={() => onTimezoneModeChange("local")}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    timezoneMode === "local"
                      ? "bg-[var(--bg-primary)] text-[color:var(--text-primary)] shadow-sm"
                      : "text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
                  }`}
                >
                  {localTzAbbr}
                </button>
                <button
                  type="button"
                  onClick={() => onTimezoneModeChange("utc")}
                  className={`px-2 py-0.5 text-xs rounded transition-colors flex items-center gap-1 ${
                    timezoneMode === "utc"
                      ? "bg-[var(--bg-primary)] text-[color:var(--text-primary)] shadow-sm"
                      : "text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
                  }`}
                >
                  <Globe className={iconXs} />
                  UTC
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={`block ${caption} mb-1`}>
                  Start Time
                </label>
                <input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => onStartTimeChange(e.target.value)}
                  className={`w-full px-2 py-1.5 text-xs rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-secondary)]`}
                />
              </div>
              <div>
                <label className={`block ${caption} mb-1`}>
                  End Time
                </label>
                <input
                  type="datetime-local"
                  value={endTime}
                  onChange={(e) => onEndTimeChange(e.target.value)}
                  className={`w-full px-2 py-1.5 text-xs rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-secondary)]`}
                />
              </div>
            </div>
          </div>
        )}

        {/* Max frames/bytes (for all sources) */}
        <div>
          <label className={`block ${caption} mb-1`}>{maxLabel}</label>
          <input
            type="number"
            min="1"
            placeholder="No limit"
            value={maxFrames}
            onChange={(e) => onMaxFramesChange(e.target.value)}
            className={`w-full px-2 py-1.5 text-xs rounded border border-[color:var(--border-default)] ${bgSurface} text-[color:var(--text-secondary)]`}
          />
        </div>

        {/* Speed (for Watch mode, recorded sources only) */}
        {!isCheckedRealtime && (
          <div>
            <label className={`block ${caption} mb-1`}>
              Watch Speed
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
              Ingest always runs at max speed
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
