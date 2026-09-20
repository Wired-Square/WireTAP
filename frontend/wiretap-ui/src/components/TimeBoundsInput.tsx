// ui/src/components/TimeBoundsInput.tsx
//
// Reusable time bounds input component with optional bookmark pre-fill.
// Used in Query app (with bookmarks) and BookmarkEditorDialog (without bookmarks).

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Globe, X } from "lucide-react";
import { caption } from "../styles/typography";
import { getLocalTimezoneAbbr, convertDatetimeLocal, utcToLocal } from "../utils/timezone";
import { useSettingsStore } from "../apps/settings/stores/settingsStore";
import type { TimeRangeFavorite } from "../utils/favorites";
import { Select, Input } from "./forms";
import { IconButton } from "./Button";
import { Tab, Tabs } from "./Tabs";

/** The resolved time bounds emitted by the component */
export interface TimeBounds {
  /** Start time in datetime-local format */
  startTime: string;
  /** End time in datetime-local format (empty string = no end bound) */
  endTime: string;
  /** Maximum number of frames (undefined = no limit) */
  maxFrames?: number;
  /** The timezone mode used for the times */
  timezoneMode: "local" | "utc";
  /** Name of the selected bookmark (cleared when fields are manually modified) */
  bookmarkName?: string;
}

export interface TimeBoundsInputProps {
  /** Current time bounds (controlled component) */
  value: TimeBounds;
  /** Called when time bounds change */
  onChange: (bounds: TimeBounds) => void;
  /** Available bookmarks to select from */
  bookmarks?: TimeRangeFavorite[];
  /** Whether to show the bookmark dropdown (default: true) */
  showBookmarks?: boolean;
  /** Whether to show the max-frames cap (default: true). Hidden where a separate
   *  result-limit control owns the cap (e.g. the Query builder). */
  showMaxFrames?: boolean;
  /** Whether the component is disabled */
  disabled?: boolean;
}

export default function TimeBoundsInput({
  value,
  onChange,
  bookmarks = [],
  showBookmarks = true,
  showMaxFrames = true,
  disabled = false,
}: TimeBoundsInputProps) {
  const { t } = useTranslation("common");
  const defaultTz = useSettingsStore((s) => s.display.timezone);
  const localTzAbbr = useMemo(() => getLocalTimezoneAbbr(), []);
  const now = useMemo(() => utcToLocal(new Date().toISOString()), []);

  // Editing a field by hand leaves whatever bookmark pre-filled it.
  const edit = (patch: Partial<TimeBounds>) => onChange({ ...value, ...patch, bookmarkName: undefined });

  // Handle bookmark selection - pre-fill the fields and remember the name
  const handleBookmarkChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const bookmarkId = e.target.value;
      if (!bookmarkId) {
        // Clear bookmark selection
        onChange({ ...value, bookmarkName: undefined });
        return;
      }

      const bookmark = bookmarks.find((b) => b.id === bookmarkId);
      if (!bookmark) return;

      // Pre-fill fields and set bookmark name
      onChange({
        startTime: bookmark.startTime,
        endTime: bookmark.endTime,
        maxFrames: bookmark.maxFrames,
        timezoneMode: value.timezoneMode,
        bookmarkName: bookmark.name,
      });
    },
    [bookmarks, value, onChange]
  );

  // Handle timezone mode change - convert existing times
  const handleTimezoneChange = useCallback(
    (newMode: "local" | "utc") => {
      if (newMode === value.timezoneMode) return;

      const newStart = convertDatetimeLocal(
        value.startTime,
        value.timezoneMode,
        newMode,
        defaultTz
      );
      const newEnd = convertDatetimeLocal(
        value.endTime,
        value.timezoneMode,
        newMode,
        defaultTz
      );

      onChange({
        ...value,
        startTime: newStart,
        endTime: newEnd,
        timezoneMode: newMode,
      });
    },
    [value, defaultTz, onChange]
  );

  return (
    <div className="space-y-3">
      {/* Bookmarks dropdown (optional) */}
      {showBookmarks && bookmarks.length > 0 && (
        <div>
          <label className={`block ${caption} mb-1`}>{t("timeBounds.bookmarks")}</label>
          <Select
            value={bookmarks.find((b) => b.name === value.bookmarkName)?.id ?? ""}
            onChange={handleBookmarkChange}
            disabled={disabled}
          >
            <option value="">{t("timeBounds.selectBookmark")}</option>
            {bookmarks.map((bm) => (
              <option key={bm.id} value={bm.id}>
                {bm.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* Timezone toggle */}
      <div className="flex items-center justify-between">
        <label className={caption}>{t("timeBounds.timeZone")}</label>
        <Tabs variant="segmented">
          <Tab selected={value.timezoneMode === "local"} onClick={() => handleTimezoneChange("local")} disabled={disabled}>
            {localTzAbbr}
          </Tab>
          <Tab selected={value.timezoneMode === "utc"} onClick={() => handleTimezoneChange("utc")} disabled={disabled}>
            <Globe />
            UTC
          </Tab>
        </Tabs>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <TimeField
          label={t("timeBounds.startTime")}
          value={value.startTime}
          onChange={(startTime) => edit({ startTime })}
          max={now}
          disabled={disabled}
          clearLabel={t("timeBounds.clear")}
        />
        <TimeField
          label={t("timeBounds.endTime")}
          value={value.endTime}
          onChange={(endTime) => edit({ endTime })}
          min={value.startTime || undefined}
          max={now}
          disabled={disabled}
          clearLabel={t("timeBounds.clear")}
        />
      </div>

      {/* Max frames input */}
      {showMaxFrames && (
        <div>
          <label className={`block ${caption} mb-1`}>{t("timeBounds.maxFrames")}</label>
          <Input
            type="number"
            min={1}
            placeholder={t("timeBounds.noLimitPlaceholder")}
            value={value.maxFrames ?? ""}
            onChange={(e) => edit({ maxFrames: e.target.value ? Number(e.target.value) : undefined })}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

interface TimeFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max: string;
  disabled: boolean;
  clearLabel: string;
}

/** A labelled datetime-local field with a ✕ beside it when filled — WebKit's field has no clear affordance of its own. */
function TimeField({ label, value, onChange, min, max, disabled, clearLabel }: TimeFieldProps) {
  return (
    <div>
      <label className={`block ${caption} mb-1`}>{label}</label>
      <div className="flex items-center gap-1">
        <Input
          type="datetime-local"
          step={1}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="flex-1 min-w-0"
        />
        {value && !disabled && (
          <IconButton size="sm" label={clearLabel} onClick={() => onChange("")}>
            <X />
          </IconButton>
        )}
      </div>
    </div>
  );
}

