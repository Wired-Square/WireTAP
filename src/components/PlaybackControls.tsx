// src/components/PlaybackControls.tsx
//
// Reusable playback controls for timeline readers (Buffer, CSV, PostgreSQL).
// Used by Discovery and Decoder when viewing recorded/buffered data.

import { ChevronLeft, ChevronRight, FastForward, Play, Rewind, SkipBack, SkipForward, Square } from "lucide-react";
import { iconSm } from "../styles/spacing";
import type { PlaybackSpeed } from "./TimeController";

export type PlaybackState = "playing" | "paused";
export type PlaybackDirection = "forward" | "backward";

export interface PlaybackControlsProps {
  /** Current playback state */
  playbackState: PlaybackState;
  /** Whether the session is ready for playback */
  isReady: boolean;
  /** Whether pause is supported */
  canPause?: boolean;
  /** Whether seek is supported (enables skip buttons) */
  supportsSeek?: boolean;
  /** Whether speed control is supported */
  supportsSpeedControl?: boolean;
  /** Whether reverse playback is supported */
  supportsReverse?: boolean;
  /** Current playback direction (only relevant when playing) */
  playbackDirection?: PlaybackDirection;
  /** Current playback speed */
  playbackSpeed?: PlaybackSpeed;
  /** Available speed options */
  speedOptions?: PlaybackSpeed[];
  /** Timeline bounds for seek operations (timestamp mode) */
  minTimeUs?: number | null;
  maxTimeUs?: number | null;
  currentTimeUs?: number | null;
  /** Current frame index (0-based) for step display and frame-based seeking */
  currentFrameIndex?: number | null;
  /** Total frame count for step display and frame-based seeking */
  totalFrames?: number | null;
  /** Callbacks */
  onPlay: () => void;
  onPlayBackward?: () => void;
  onPause: () => void;
  onStepBackward?: () => void;
  onStepForward?: () => void;
  /** Called for timestamp-based seeking (legacy, for backward compatibility) */
  onScrub?: (timeUs: number) => void;
  /** Called for frame-based seeking (preferred for buffer playback) */
  onFrameChange?: (frameIndex: number) => void;
  onSpeedChange?: (speed: PlaybackSpeed) => void;
}

const DEFAULT_SPEED_OPTIONS: PlaybackSpeed[] = [0.25, 0.5, 1, 2, 10, 30, 60];
/** Default number of frames to skip for 10-second jumps when we can't calculate from timestamps */
const DEFAULT_SKIP_FRAMES = 100;

/**
 * Playback controls for timeline readers.
 * Renders play/pause/stop buttons with optional seek and speed controls.
 */
export function PlaybackControls({
  playbackState,
  isReady,
  canPause = false,
  supportsSeek = false,
  supportsSpeedControl = false,
  supportsReverse = false,
  playbackDirection = "forward",
  playbackSpeed = 1,
  speedOptions = DEFAULT_SPEED_OPTIONS,
  minTimeUs,
  maxTimeUs,
  currentTimeUs,
  currentFrameIndex,
  totalFrames,
  onPlay,
  onPlayBackward,
  onPause,
  onStepBackward,
  onStepForward,
  onScrub,
  onFrameChange,
  onSpeedChange,
}: PlaybackControlsProps) {
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";
  const isPlayingForward = isPlaying && playbackDirection === "forward";
  const isPlayingBackward = isPlaying && playbackDirection === "backward";

  // Only show if ready and has some control capability
  const showControls = isReady && (supportsSeek || supportsSpeedControl || canPause || supportsReverse);
  if (!showControls) return null;

  // Whether frame-based seeking is available (preferred)
  const canSeekByFrame = supportsSeek && onFrameChange && totalFrames != null && totalFrames > 0;

  // Whether timestamp-based seeking is available (fallback)
  const canSeekByTime = supportsSeek && onScrub && minTimeUs != null && maxTimeUs != null;

  // Whether any seek controls should be shown
  const showSeekControls = canSeekByFrame || canSeekByTime;

  // Calculate frames per 10 seconds for skip operations
  const framesPerSkip = (() => {
    if (!canSeekByFrame) return DEFAULT_SKIP_FRAMES;
    if (minTimeUs != null && maxTimeUs != null && totalFrames > 1) {
      const durationUs = maxTimeUs - minTimeUs;
      const durationSecs = durationUs / 1_000_000;
      if (durationSecs > 0) {
        // Calculate frames for 10 seconds
        const framesPerSec = totalFrames / durationSecs;
        return Math.max(1, Math.round(framesPerSec * 10));
      }
    }
    return DEFAULT_SKIP_FRAMES;
  })();

  // Handler for skip to start
  const handleSkipToStart = () => {
    if (canSeekByFrame) {
      onFrameChange!(0);
    } else if (canSeekByTime) {
      onScrub!(minTimeUs!);
    }
  };

  // Handler for skip to end
  const handleSkipToEnd = () => {
    if (canSeekByFrame) {
      onFrameChange!(totalFrames! - 1);
    } else if (canSeekByTime) {
      onScrub!(maxTimeUs!);
    }
  };

  // Handler for skip back (~10 seconds)
  const handleSkipBack = () => {
    if (canSeekByFrame && currentFrameIndex != null) {
      const newFrame = Math.max(0, currentFrameIndex - framesPerSkip);
      onFrameChange!(newFrame);
    } else if (canSeekByTime) {
      const newTime = Math.max(minTimeUs!, (currentTimeUs ?? minTimeUs!) - 10_000_000);
      onScrub!(newTime);
    }
  };

  // Handler for skip forward (~10 seconds)
  const handleSkipForward = () => {
    if (canSeekByFrame && currentFrameIndex != null) {
      const newFrame = Math.min(totalFrames! - 1, currentFrameIndex + framesPerSkip);
      onFrameChange!(newFrame);
    } else if (canSeekByTime) {
      const newTime = Math.min(maxTimeUs!, (currentTimeUs ?? minTimeUs!) + 10_000_000);
      onScrub!(newTime);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {/* Skip to start */}
      {showSeekControls && (
        <button
          type="button"
          onClick={handleSkipToStart}
          className="p-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          title="Skip to start"
        >
          <SkipBack className={iconSm} />
        </button>
      )}

      {/* Skip back 10 seconds */}
      {showSeekControls && (
        <button
          type="button"
          onClick={handleSkipBack}
          className="p-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          title={canSeekByFrame ? `Skip back ~${framesPerSkip} frames` : "Skip back 10 seconds"}
        >
          <Rewind className={iconSm} />
        </button>
      )}

      {/* Play backward */}
      {supportsReverse && onPlayBackward && (
        <button
          type="button"
          onClick={onPlayBackward}
          disabled={isPlayingBackward}
          className={`p-1 rounded ${
            isPlayingBackward
              ? "bg-blue-600/30 text-blue-400"
              : "text-blue-500 hover:bg-gray-700 hover:text-blue-400"
          }`}
          title="Play backward"
        >
          <Play className={`${iconSm} rotate-180`} fill="currentColor" />
        </button>
      )}

      {/* Pause (shown as stop button) */}
      <button
        type="button"
        onClick={onPause}
        disabled={isPaused}
        className={`p-1 rounded ${
          isPaused
            ? "bg-red-600/30 text-red-400"
            : "text-red-500 hover:bg-gray-700 hover:text-red-400"
        }`}
        title="Pause"
      >
        <Square className={iconSm} fill="currentColor" />
      </button>

      {/* Step backward (when paused and not at start) */}
      {onStepBackward && (() => {
        const atStart = currentFrameIndex != null && currentFrameIndex <= 0;
        const canStep = isPaused && !atStart;
        return (
          <button
            type="button"
            onClick={onStepBackward}
            disabled={!canStep}
            className={`p-1 rounded ${
              canStep
                ? "text-gray-300 hover:bg-gray-700 hover:text-white"
                : "text-gray-600 cursor-not-allowed"
            }`}
            title={atStart ? "At start of buffer" : "Step backward one frame"}
          >
            <ChevronLeft className={iconSm} strokeWidth={3} />
          </button>
        );
      })()}

      {/* Frame index display (when stepping is available and we have frame info) */}
      {(onStepBackward || onStepForward) && currentFrameIndex != null && (
        <span className="px-1.5 text-xs font-mono text-gray-400 tabular-nums">
          {totalFrames != null
            ? `${(currentFrameIndex + 1).toLocaleString()} / ${totalFrames.toLocaleString()}`
            : (currentFrameIndex + 1).toLocaleString()}
        </span>
      )}

      {/* Step forward (when paused and not at end) */}
      {onStepForward && (() => {
        const atEnd = currentFrameIndex != null && totalFrames != null && currentFrameIndex >= totalFrames - 1;
        const canStep = isPaused && !atEnd;
        return (
          <button
            type="button"
            onClick={onStepForward}
            disabled={!canStep}
            className={`p-1 rounded ${
              canStep
                ? "text-gray-300 hover:bg-gray-700 hover:text-white"
                : "text-gray-600 cursor-not-allowed"
            }`}
            title={atEnd ? "At end of buffer" : "Step forward one frame"}
          >
            <ChevronRight className={iconSm} strokeWidth={3} />
          </button>
        );
      })()}

      {/* Play forward */}
      <button
        type="button"
        onClick={onPlay}
        disabled={isPlayingForward}
        className={`p-1 rounded ${
          isPlayingForward
            ? "bg-green-600/30 text-green-400"
            : "text-green-500 hover:bg-gray-700 hover:text-green-400"
        }`}
        title={isPaused ? "Resume forward" : "Play forward"}
      >
        <Play className={iconSm} fill="currentColor" />
      </button>

      {/* Skip forward 10 seconds */}
      {showSeekControls && (
        <button
          type="button"
          onClick={handleSkipForward}
          className="p-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          title={canSeekByFrame ? `Skip forward ~${framesPerSkip} frames` : "Skip forward 10 seconds"}
        >
          <FastForward className={iconSm} />
        </button>
      )}

      {/* Skip to end */}
      {showSeekControls && (
        <button
          type="button"
          onClick={handleSkipToEnd}
          className="p-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          title="Skip to end"
        >
          <SkipForward className={iconSm} />
        </button>
      )}

      {/* Speed selector */}
      {supportsSpeedControl && onSpeedChange && (
        <select
          value={playbackSpeed}
          onChange={(e) => onSpeedChange(parseFloat(e.target.value) as PlaybackSpeed)}
          className="ml-1 px-2 py-0.5 text-xs rounded border border-gray-600 bg-gray-700 text-gray-200"
          title="Playback speed"
        >
          {speedOptions.map((s) => (
            <option key={s} value={s}>
              {s === 1 ? "1x (realtime)" : `${s}x`}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export default PlaybackControls;
