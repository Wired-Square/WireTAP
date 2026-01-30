// src/components/TimeDisplay.tsx

import { useState, useMemo, useCallback } from 'react';
import { useSettingsStore } from '../apps/settings/stores/settingsStore';
import { badgeSmallNeutral, badgeSmallInfo } from '../styles/badgeStyles';
import { caption } from '../styles/typography';

export type TimezoneMode = 'local' | 'utc';

export interface TimeDisplayProps {
  /** Timestamp to display - epoch seconds or ISO string */
  timestamp: number | string | null;
  /** Whether to show the date portion (default: true) */
  showDate?: boolean;
  /** Whether to show the time portion (default: true) */
  showTime?: boolean;
  /** Compact mode - smaller text (default: false) */
  compact?: boolean;
  /** Custom className for the container */
  className?: string;
  /** Whether clicking the badge cycles timezone (default: true) */
  allowOverride?: boolean;
}

/**
 * TimeDisplay component - displays timestamps with timezone awareness.
 *
 * Features:
 * - Reads default timezone from settings store
 * - Shows a clickable badge (UTC/Local) to cycle through timezones
 * - Supports temporary override without changing the global setting
 */
export default function TimeDisplay({
  timestamp,
  showDate = true,
  showTime = true,
  compact = false,
  className = '',
  allowOverride = true,
}: TimeDisplayProps) {
  const settingsTimezone = useSettingsStore((s) => s.display.timezone);
  const [override, setOverride] = useState<TimezoneMode | null>(null);

  const effectiveTimezone = override ?? settingsTimezone;

  const { formattedTime, formattedDate } = useMemo(() => {
    if (!timestamp) {
      return { formattedTime: '--:--:--', formattedDate: '' };
    }

    let date: Date;
    if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else {
      // Epoch seconds
      date = new Date(timestamp * 1000);
    }

    if (isNaN(date.getTime())) {
      return { formattedTime: '--:--:--', formattedDate: '' };
    }

    const tzOption = effectiveTimezone === 'utc' ? 'UTC' : undefined;

    const time = date.toLocaleTimeString('en-GB', {
      timeZone: tzOption,
      hour12: false,
    });

    const dateStr = date.toLocaleDateString('en-GB', {
      timeZone: tzOption,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    return { formattedTime: time, formattedDate: dateStr };
  }, [timestamp, effectiveTimezone]);

  const badgeLabel = effectiveTimezone === 'utc' ? 'UTC' : 'Local';
  const isOverridden = override !== null;

  const handleBadgeClick = useCallback(() => {
    if (!allowOverride) return;

    // Cycle: setting → utc → local → setting (skip if matches)
    if (override === null) {
      // Currently at setting default, go to the other option
      if (settingsTimezone === 'local') {
        setOverride('utc');
      } else {
        setOverride('local');
      }
    } else if (override === 'utc') {
      // At UTC override
      if (settingsTimezone === 'local') {
        // Go to local override
        setOverride('local');
      } else {
        // Setting is UTC, reset to setting
        setOverride(null);
      }
    } else {
      // At local override, reset to setting
      setOverride(null);
    }
  }, [override, settingsTimezone, allowOverride]);

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex flex-col">
        {showTime && (
          <span
            className={`font-mono min-w-[80px] leading-tight ${
              compact ? 'text-sm text-[color:var(--text-secondary)]' : 'text-[color:var(--text-primary)]'
            }`}
          >
            {formattedTime}
          </span>
        )}
        {showDate && formattedDate && (
          <span
            className={`font-mono leading-tight ${
              compact ? 'text-[10px] text-[color:var(--text-secondary)]' : caption
            }`}
          >
            {formattedDate}
          </span>
        )}
      </div>
      {allowOverride && (
        <button
          onClick={handleBadgeClick}
          className={`${
            isOverridden ? badgeSmallInfo : badgeSmallNeutral
          } cursor-pointer hover:opacity-80 transition-opacity`}
          title={`Click to cycle timezone. Currently: ${badgeLabel}${
            isOverridden ? ' (override)' : ' (default)'
          }`}
        >
          {badgeLabel}
        </button>
      )}
    </div>
  );
}
