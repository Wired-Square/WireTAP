// src/components/PlaybackControls.tsx
//
// Reusable playback controls for timeline readers (Buffer, CSV, PostgreSQL).
// Used by Discovery and Decoder when viewing recorded/buffered data.
//
// Renders only transport buttons. Frame counter and speed selector are
// rendered separately by the parent and placed in the toolbar's info/right slots.

import { ChevronLeft, ChevronRight, FastForward, Play, RefreshCw, Rewind, SkipBack, SkipForward, Square } from "lucide-react";
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
  /** Whether a live stream is actively fetching data (e.g., PostgreSQL streaming) */
  isLiveStreaming?: boolean;
  /** Whether the stream is paused (separate from buffer playback pause) */
  isStreamPaused?: boolean;
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
  /** Called to resume a paused stream (e.g., resume PostgreSQL fetch) */
  onResumeStream?: () => void;
}

const DEFAULT_SPEED_OPTIONS: PlaybackSpeed[] = [0.125, 0.25, 0.5, 1, 2, 10, 30, 60];
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
  isLiveStreaming = false,
  isStreamPaused = false,
  playbackDirection = "forward",
  playbackSpeed: _playbackSpeed = 1,
  speedOptions: _speedOptions = DEFAULT_SPEED_OPTIONS,
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
  onSpeedChange: _onSpeedChange,
  onResumeStream,
}: PlaybackControlsProps) {
  const isPlaying = playbackState === "playing";
  const isPaused = playbackState === "paused";
  const isPlayingForward = isPlaying && playbackDirection === "forward";
  const isPlayingBackward = isPlaying && playbackDirection === "backward";

  // When live streaming, only the stop button is enabled (to pause the stream)
  // When stream is paused, all buffer playback controls are enabled
  const bufferControlsEnabled = !isLiveStreaming || isStreamPaused;

  // Only show if ready and has some control capability
  const showControls = isReady && (supportsSeek || supportsSpeedControl || canPause || supportsReverse || isLiveStreaming);
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

  // Handler for skip to start - prefer time-based since it works with filtering
  const handleSkipToStart = () => {
    if (canSeekByTime) {
      onScrub!(minTimeUs!);
    } else if (canSeekByFrame) {
      onFrameChange!(0);
    }
  };

  // Handler for skip to end - prefer time-based since it works with filtering
  const handleSkipToEnd = () => {
    if (canSeekByTime) {
      onScrub!(maxTimeUs!);
    } else if (canSeekByFrame) {
      onFrameChange!(totalFrames! - 1);
    }
  };

  // Handler for skip back (~10 seconds) - prefer time-based
  const handleSkipBack = () => {
    if (canSeekByTime) {
      const newTime = Math.max(minTimeUs!, (currentTimeUs ?? minTimeUs!) - 10_000_000);
      onScrub!(newTime);
    } else if (canSeekByFrame && currentFrameIndex != null) {
      const newFrame = Math.max(0, currentFrameIndex - framesPerSkip);
      onFrameChange!(newFrame);
    }
  };

  // Handler for skip forward (~10 seconds) - prefer time-based
  const handleSkipForward = () => {
    if (canSeekByTime) {
      const newTime = Math.min(maxTimeUs!, (currentTimeUs ?? minTimeUs!) + 10_000_000);
      onScrub!(newTime);
    } else if (canSeekByFrame && currentFrameIndex != null) {
      const newFrame = Math.min(totalFrames! - 1, currentFrameIndex + framesPerSkip);
      onFrameChange!(newFrame);
    }
  };

  return (
    <div className="flex items-center gap-1">
      {/* Skip to start */}
      {showSeekControls && bufferControlsEnabled && (
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
      {showSeekControls && bufferControlsEnabled && (
        <button
          type="button"
          onClick={handleSkipBack}
          className="p-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          title={canSeekByFrame ? `Skip back ~${framesPerSkip} frames` : "Skip back 10 seconds"}
        >
          <Rewind className={iconSm} />
        </button>
      )}

      {/* Play backward (only when buffer controls are enabled) */}
      {supportsReverse && onPlayBackward && bufferControlsEnabled && (
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

      {/* Pause/Stop button - pauses stream when live streaming, pauses buffer playback otherwise */}
      <button
        type="button"
        onClick={onPause}
        disabled={isPaused && !isLiveStreaming}
        className={`p-1 rounded ${
          (isPaused && !isLiveStreaming) || (isStreamPaused && isLiveStreaming)
            ? "bg-red-600/30 text-red-400"
            : "text-red-500 hover:bg-gray-700 hover:text-red-400"
        }`}
        title={isLiveStreaming ? "Pause stream" : "Pause"}
      >
        <Square className={iconSm} fill="currentColor" />
      </button>

      {/* Step backward (when paused and not at start, only when buffer controls enabled) */}
      {onStepBackward && bufferControlsEnabled && (() => {
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

      {/* Step forward (when paused and not at end, only when buffer controls enabled) */}
      {onStepForward && bufferControlsEnabled && (() => {
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

      {/* Play forward (only when buffer controls enabled) */}
      {bufferControlsEnabled && (
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
      )}

      {/* Skip forward 10 seconds */}
      {showSeekControls && bufferControlsEnabled && (
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
      {showSeekControls && bufferControlsEnabled && (
        <button
          type="button"
          onClick={handleSkipToEnd}
          className="p-1 rounded text-gray-400 hover:bg-gray-700 hover:text-gray-200"
          title="Skip to end"
        >
          <SkipForward className={iconSm} />
        </button>
      )}

      {/* Resume Stream button - resumes PostgreSQL/timeline fetch after pause */}
      {isStreamPaused && onResumeStream && (
        <button
          type="button"
          onClick={onResumeStream}
          className="p-1 rounded text-cyan-500 hover:bg-gray-700 hover:text-cyan-400"
          title="Resume stream (continue fetching from database)"
        >
          <RefreshCw className={iconSm} />
        </button>
      )}
    </div>
  );
}

export default PlaybackControls;
