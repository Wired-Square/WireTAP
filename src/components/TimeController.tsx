// ui/src/components/TimeController.tsx

import { useState, useEffect, useCallback } from "react";
import { Play, Pause, Square, Clock, Zap } from "lucide-react";
import TimeDisplay from "./TimeDisplay";
import type { IOCapabilities } from '../api/io';
import {
  playButtonBase,
  playButtonCompact,
  pauseButtonBase,
  pauseButtonCompact,
  stopButtonBase,
  stopButtonCompact,
  disabledState,
} from "../styles";
import { iconSm, iconMd, iconLg, flexRowGap2 } from "../styles/spacing";

export type PlaybackSpeed = 0.125 | 0.25 | 0.5 | 1 | 2 | 10 | 30 | 60;
export type PlaybackState = "playing" | "paused";

export interface TimeControllerProps {
  /** Current playback state */
  state: PlaybackState;

  /** Current playback time (ISO-8601 string or epoch seconds) */
  currentTime?: string | number;

  /** Playback speed multiplier */
  speed: PlaybackSpeed;

  /** Start time for replay (ISO-8601 string) */
  startTime?: string;

  /** End time for replay (ISO-8601 string) */
  endTime?: string;

  /** Callback when play is clicked */
  onPlay?: () => void;

  /** Callback when pause is clicked */
  onPause?: () => void;

  /** Callback when stop is clicked */
  onStop?: () => void;

  /** Callback when speed changes */
  onSpeedChange?: (speed: PlaybackSpeed) => void;

  /** Callback when start time changes */
  onStartTimeChange?: (time: string) => void;

  /** Callback when end time changes */
  onEndTimeChange?: (time: string) => void;

  /** Whether controls are disabled */
  disabled?: boolean;

  /** Show time range inputs (for PostgreSQL replay) */
  showTimeRange?: boolean;

  /** Compact mode (smaller UI) */
  compact?: boolean;

  /** IO capabilities - used to conditionally show controls */
  capabilities?: IOCapabilities | null;
}

import { SPEED_OPTIONS } from "../dialogs/io-reader-picker/utils";

export default function TimeController({
  state,
  currentTime,
  speed,
  startTime,
  endTime,
  onPlay,
  onPause,
  onStop,
  onSpeedChange,
  onStartTimeChange,
  onEndTimeChange,
  disabled = false,
  showTimeRange = false,
  compact = false,
  capabilities,
}: TimeControllerProps) {
  const [localStartTime, setLocalStartTime] = useState(startTime || "");
  const [localEndTime, setLocalEndTime] = useState(endTime || "");

  // Determine what to show based on capabilities
  const showPauseButton = capabilities?.can_pause ?? true;
  const showSpeedControl = capabilities?.supports_speed_control ?? true;
  const showTimeRangeInputs =
    showTimeRange || (capabilities?.supports_time_range ?? false);

  // Sync local time inputs with props
  useEffect(() => {
    setLocalStartTime(startTime || "");
  }, [startTime]);

  useEffect(() => {
    setLocalEndTime(endTime || "");
  }, [endTime]);

  const handleStartTimeBlur = useCallback(() => {
    if (onStartTimeChange && localStartTime !== startTime) {
      onStartTimeChange(localStartTime);
    }
  }, [localStartTime, startTime, onStartTimeChange]);

  const handleEndTimeBlur = useCallback(() => {
    if (onEndTimeChange && localEndTime !== endTime) {
      onEndTimeChange(localEndTime);
    }
  }, [localEndTime, endTime, onEndTimeChange]);

  const isPlaying = state === "playing";
  const isPaused = state === "paused";

  return (
    <div className={`flex items-center gap-3 ${compact ? "text-sm" : ""}`}>
      {/* Playback controls */}
      <div className={`${flexRowGap2} border-r border-[color:var(--border-default)] pr-3`}>
        {isPaused ? (
          <button
            onClick={onPlay}
            disabled={disabled}
            className={compact ? playButtonCompact : playButtonBase}
            title="Play"
          >
            <Play className={compact ? iconSm : iconMd} />
            {!compact && "Play"}
          </button>
        ) : showPauseButton ? (
          <button
            onClick={onPause}
            disabled={disabled}
            className={compact ? pauseButtonCompact : pauseButtonBase}
            title="Pause playback"
          >
            <Pause className={compact ? iconSm : iconMd} />
            {!compact && "Pause"}
          </button>
        ) : (
          // For realtime sources that can't pause, show disabled play button
          <button
            disabled
            className={`flex items-center gap-2 rounded-lg transition-colors bg-green-600/50 text-white/70 cursor-not-allowed ${
              compact ? "px-2 py-1" : "px-3 py-1.5"
            }`}
            title="Streaming..."
          >
            <Play className={compact ? iconSm : iconMd} />
            {!compact && "Live"}
          </button>
        )}

        <button
          onClick={onStop}
          disabled={disabled || isPaused}
          className={compact ? stopButtonCompact : stopButtonBase}
          title="Pause"
        >
          <Square className={compact ? iconSm : iconMd} />
          {!compact && "Pause"}
        </button>
      </div>

      {/* Current time display */}
      <div className={flexRowGap2}>
        <Clock
          className={`${compact ? iconMd : iconLg} text-[color:var(--text-muted)] ${
            isPlaying ? "animate-pulse" : ""
          }`}
        />
        <TimeDisplay
          timestamp={currentTime ?? null}
          showDate={true}
          showTime={true}
          compact={compact}
          allowOverride={true}
        />
      </div>

      {/* Speed control - only show if supported */}
      {showSpeedControl && (
        <div className={`${flexRowGap2} border-l border-[color:var(--border-default)] pl-3`}>
          <Zap
            className={`${compact ? iconMd : iconLg} text-[color:var(--text-orange)]`}
          />
          <select
            value={speed}
            onChange={(e) =>
              onSpeedChange?.(Number(e.target.value) as PlaybackSpeed)
            }
            disabled={disabled}
            className={`${
              compact ? "px-2 py-0.5 text-xs" : "px-3 py-1"
            } rounded border bg-[var(--bg-surface)] border-[color:var(--border-default)] text-[color:var(--text-primary)] ${disabledState}`}
          >
            {SPEED_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Time range inputs - only show if supported */}
      {showTimeRangeInputs && (
        <div className={`${flexRowGap2} border-l border-[color:var(--border-default)] pl-3`}>
          <label className="text-xs text-[color:var(--text-muted)]">
            From:
          </label>
          <input
            type="datetime-local"
            value={localStartTime}
            onChange={(e) => setLocalStartTime(e.target.value)}
            onBlur={handleStartTimeBlur}
            disabled={disabled || !isPaused}
            className={`${
              compact ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"
            } rounded border bg-[var(--bg-surface)] border-[color:var(--border-default)] text-[color:var(--text-primary)] ${disabledState} font-mono`}
          />
          <label className="text-xs text-[color:var(--text-muted)]">
            To:
          </label>
          <input
            type="datetime-local"
            value={localEndTime}
            onChange={(e) => setLocalEndTime(e.target.value)}
            onBlur={handleEndTimeBlur}
            disabled={disabled || !isPaused}
            className={`${
              compact ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"
            } rounded border bg-[var(--bg-surface)] border-[color:var(--border-default)] text-[color:var(--text-primary)] ${disabledState} font-mono`}
          />
        </div>
      )}
    </div>
  );
}
