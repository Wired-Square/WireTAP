// ui/src/components/TimeController.tsx

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Play, Pause, Square, Clock, Zap } from "lucide-react";
import TimeDisplay from "./TimeDisplay";
import type { IOCapabilities } from '../api/io';
import { Button } from "./Button";
import { Input, Select } from "./forms";
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

  /** Show time range inputs (for backend replay) */
  showTimeRange?: boolean;

  /** Compact mode (smaller UI) */
  compact?: boolean;

  /** IO capabilities - used to conditionally show controls */
  capabilities?: IOCapabilities | null;
}

import { SPEED_OPTIONS } from "../dialogs/io-source-picker/utils";

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
  const { t } = useTranslation("common");
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

  const controlSize = compact ? "sm" : "md";

  return (
    <div className={`flex items-center gap-3 ${compact ? "text-sm" : ""}`}>
      {/* Playback controls */}
      <div className={`${flexRowGap2} border-r border-[color:var(--border-default)] pr-3`}>
        {isPaused ? (
          <Button
            onClick={onPlay}
            disabled={disabled}
            variant="solid"
            tone="success"
            size={controlSize}
            title={t("timeController.play")}
          >
            <Play className={compact ? iconSm : iconMd} />
            {!compact && t("timeController.play")}
          </Button>
        ) : showPauseButton ? (
          <Button
            onClick={onPause}
            disabled={disabled}
            variant="solid"
            tone="warning"
            size={controlSize}
            title={t("timeController.pausePlayback")}
          >
            <Pause className={compact ? iconSm : iconMd} />
            {!compact && t("timeController.pause")}
          </Button>
        ) : (
          // For realtime sources that can't pause, show disabled play button
          <Button
            disabled
            variant="solid"
            tone="success"
            size={controlSize}
            title={t("timeController.streaming")}
          >
            <Play className={compact ? iconSm : iconMd} />
            {!compact && t("timeController.live")}
          </Button>
        )}

        <Button
          onClick={onStop}
          disabled={disabled || isPaused}
          variant="solid"
          tone="danger"
          size={controlSize}
          title={t("timeController.pause")}
        >
          <Square className={compact ? iconSm : iconMd} />
          {!compact && t("timeController.pause")}
        </Button>
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
          <Select
            value={speed}
            onChange={(e) =>
              onSpeedChange?.(Number(e.target.value) as PlaybackSpeed)
            }
            disabled={disabled}
            size={controlSize}
            className="w-auto"
          >
            {SPEED_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* Time range inputs - only show if supported */}
      {showTimeRangeInputs && (
        <div className={`${flexRowGap2} border-l border-[color:var(--border-default)] pl-3`}>
          <label className="text-xs text-[color:var(--text-muted)]">
            {t("timeController.from")}
          </label>
          <Input
            type="datetime-local"
            value={localStartTime}
            onChange={(e) => setLocalStartTime(e.target.value)}
            onBlur={handleStartTimeBlur}
            disabled={disabled || !isPaused}
            size={controlSize}
            mono
            className="w-auto"
          />
          <label className="text-xs text-[color:var(--text-muted)]">
            {t("timeController.to")}
          </label>
          <Input
            type="datetime-local"
            value={localEndTime}
            onChange={(e) => setLocalEndTime(e.target.value)}
            onBlur={handleEndTimeBlur}
            disabled={disabled || !isPaused}
            size={controlSize}
            mono
            className="w-auto"
          />
        </div>
      )}
    </div>
  );
}
