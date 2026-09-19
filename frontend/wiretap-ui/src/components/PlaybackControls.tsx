// src/components/PlaybackControls.tsx
//
// Reusable playback controls for recorded sources (Buffer, CSV, WireTAP backend).
// Used by Discovery and Decoder when viewing recorded/buffered data.
//
// Renders only transport buttons. Frame counter and speed selector are
// rendered separately by the parent and placed in the toolbar's info/right slots.

import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, FastForward, Play, RefreshCw, Rewind, SkipBack, SkipForward, Square } from "lucide-react";
import { iconSm } from "../styles/spacing";
import { textPrimary } from "../styles/colourTokens";
import type { PlaybackSpeed } from "./TimeController";
import { IconButton } from "./Button";

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
  /** Whether a live stream is actively fetching data (e.g., a WireTAP backend streaming) */
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
  /** Called to resume a paused stream (e.g., resume a backend fetch) */
  onResumeStream?: () => void;
}

const DEFAULT_SPEED_OPTIONS: PlaybackSpeed[] = [0.125, 0.25, 0.5, 1, 2, 10, 30, 60];
/** Default number of frames to skip for 10-second jumps when we can't calculate from timestamps */
const DEFAULT_SKIP_FRAMES = 100;

/**
 * Playback controls for recorded sources.
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
  const { t } = useTranslation("common");
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
        <IconButton
          onClick={handleSkipToStart}
          size="sm"
          title={t("playback.skipToStart")}
        >
          <SkipBack className={iconSm} />
        </IconButton>
      )}

      {/* Skip back 10 seconds */}
      {showSeekControls && bufferControlsEnabled && (
        <IconButton
          onClick={handleSkipBack}
          size="sm"
          title={canSeekByFrame ? t("playback.skipBackFrames", { count: framesPerSkip }) : t("playback.skipBackSeconds")}
        >
          <Rewind className={iconSm} />
        </IconButton>
      )}

      {/* Play backward (only when buffer controls are enabled) */}
      {supportsReverse && onPlayBackward && bufferControlsEnabled && (
        <IconButton
          onClick={onPlayBackward}
          disabled={isPlayingBackward}
          tone="primary"
          size="sm"
          pressed={isPlayingBackward}
          title={t("playback.playBackward")}
        >
          <Play className={`${iconSm} rotate-180`} fill="currentColor" />
        </IconButton>
      )}

      {/* Pause/Stop button - pauses stream when live streaming, pauses buffer playback otherwise */}
      <IconButton
        onClick={onPause}
        disabled={isPaused && !isLiveStreaming}
        tone="danger"
        size="sm"
        pressed={(isPaused && !isLiveStreaming) || (isStreamPaused && isLiveStreaming)}
        title={isLiveStreaming ? t("playback.pauseStream") : t("playback.pause")}
      >
        <Square className={iconSm} fill="currentColor" />
      </IconButton>

      {/* Step backward (when paused and not at start, only when buffer controls enabled) */}
      {onStepBackward && bufferControlsEnabled && (() => {
        const atStart = currentFrameIndex != null && currentFrameIndex <= 0;
        const canStep = isPaused && !atStart;
        return (
          <IconButton
            onClick={onStepBackward}
            disabled={!canStep}
            size="sm"
            className={textPrimary}
            title={atStart ? t("playback.atStart") : t("playback.stepBack")}
          >
            <ChevronLeft className={iconSm} strokeWidth={3} />
          </IconButton>
        );
      })()}

      {/* Step forward (when paused and not at end, only when buffer controls enabled) */}
      {onStepForward && bufferControlsEnabled && (() => {
        const atEnd = currentFrameIndex != null && totalFrames != null && currentFrameIndex >= totalFrames - 1;
        const canStep = isPaused && !atEnd;
        return (
          <IconButton
            onClick={onStepForward}
            disabled={!canStep}
            size="sm"
            className={textPrimary}
            title={atEnd ? t("playback.atEnd") : t("playback.stepForward")}
          >
            <ChevronRight className={iconSm} strokeWidth={3} />
          </IconButton>
        );
      })()}

      {/* Play forward (only when buffer controls enabled) */}
      {bufferControlsEnabled && (
        <IconButton
          onClick={onPlay}
          disabled={isPlayingForward}
          tone="success"
          size="sm"
          pressed={isPlayingForward}
          title={isPaused ? t("playback.resumeForward") : t("playback.playForward")}
        >
          <Play className={iconSm} fill="currentColor" />
        </IconButton>
      )}

      {/* Skip forward 10 seconds */}
      {showSeekControls && bufferControlsEnabled && (
        <IconButton
          onClick={handleSkipForward}
          size="sm"
          title={canSeekByFrame ? t("playback.skipForwardFrames", { count: framesPerSkip }) : t("playback.skipForwardSeconds")}
        >
          <FastForward className={iconSm} />
        </IconButton>
      )}

      {/* Skip to end */}
      {showSeekControls && bufferControlsEnabled && (
        <IconButton
          onClick={handleSkipToEnd}
          size="sm"
          title={t("playback.skipToEnd")}
        >
          <SkipForward className={iconSm} />
        </IconButton>
      )}

      {/* Resume Stream button - resumes recorded fetch after pause */}
      {isStreamPaused && onResumeStream && (
        <IconButton
          onClick={onResumeStream}
          tone="cyan"
          size="sm"
          title={t("playback.resumeStreamTooltip")}
        >
          <RefreshCw className={iconSm} />
        </IconButton>
      )}
    </div>
  );
}

export default PlaybackControls;
