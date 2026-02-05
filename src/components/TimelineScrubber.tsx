// ui/src/components/TimelineScrubber.tsx

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { formatHumanUs, formatDeltaUs } from "../utils/timeFormat";
import { caption } from "../styles/typography";

type TimeDisplayFormat = "delta-last" | "delta-start" | "timestamp" | "human";

type Props = {
  /** Minimum timestamp in microseconds (for timestamp mode) */
  minTimeUs?: number;
  /** Maximum timestamp in microseconds (for timestamp mode) */
  maxTimeUs?: number;
  /** Current position in microseconds (for timestamp mode) */
  currentTimeUs?: number;
  /** Called when user scrubs to a new position in timestamp mode */
  onPositionChange?: (timeUs: number) => void;

  /** Total frames in buffer (enables frame-based mode when provided) */
  totalFrames?: number;
  /** Current frame index (0-based, for frame mode) */
  currentFrameIndex?: number;
  /** Called when user scrubs to a new frame index (for frame mode) */
  onFrameChange?: (frameIndex: number) => void;

  /** Whether the scrubber is disabled (e.g., while streaming) */
  disabled?: boolean;
  /** Optional: show time labels at edges */
  showLabels?: boolean;
  /** Time display format - affects label and tooltip display */
  displayTimeFormat?: TimeDisplayFormat;
  /** Stream start time in microseconds (for delta-start format) */
  streamStartTimeUs?: number | null;
};

export default function TimelineScrubber({
  minTimeUs = 0,
  maxTimeUs = 0,
  currentTimeUs = 0,
  onPositionChange,
  totalFrames,
  currentFrameIndex,
  onFrameChange,
  disabled = false,
  showLabels = true,
  displayTimeFormat = "human",
  streamStartTimeUs,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverPosition, setHoverPosition] = useState<number | null>(null); // frame index or timestamp

  // Determine if we're in frame-based mode
  const isFrameMode = totalFrames != null && totalFrames > 0 && onFrameChange != null;
  const effectiveCurrentFrameIndex = currentFrameIndex ?? 0;

  // Calculate position percentage based on mode
  const positionPercent = useMemo(() => {
    if (isFrameMode) {
      // Frame-based mode: position based on frame index
      if (totalFrames <= 1) return 0;
      const percent = (effectiveCurrentFrameIndex / (totalFrames - 1)) * 100;
      return Math.max(0, Math.min(100, percent));
    } else {
      // Timestamp-based mode
      const range = maxTimeUs - minTimeUs;
      if (range <= 0) return 0;
      const percent = ((currentTimeUs - minTimeUs) / range) * 100;
      return Math.max(0, Math.min(100, percent));
    }
  }, [isFrameMode, totalFrames, effectiveCurrentFrameIndex, currentTimeUs, minTimeUs, maxTimeUs]);

  // Convert pixel position to frame index (frame mode)
  const pixelToFrame = useCallback(
    (clientX: number): number => {
      if (!trackRef.current || !totalFrames || totalFrames <= 1) return 0;
      const rect = trackRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      // Round to nearest frame index
      return Math.round(ratio * (totalFrames - 1));
    },
    [totalFrames]
  );

  // Convert pixel position to timestamp (timestamp mode)
  const pixelToTime = useCallback(
    (clientX: number): number => {
      const range = maxTimeUs - minTimeUs;
      if (!trackRef.current || range <= 0) return minTimeUs;
      const rect = trackRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      return minTimeUs + ratio * range;
    },
    [minTimeUs, maxTimeUs]
  );

  // Handle click on track
  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      if (isFrameMode) {
        const frameIndex = pixelToFrame(e.clientX);
        onFrameChange!(frameIndex);
      } else if (onPositionChange) {
        const timeUs = pixelToTime(e.clientX);
        onPositionChange(timeUs);
      }
    },
    [disabled, isFrameMode, pixelToFrame, pixelToTime, onFrameChange, onPositionChange]
  );

  // Handle mouse down on handle
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      e.preventDefault();
      setIsDragging(true);
    },
    [disabled]
  );

  // Handle mouse move (for dragging and hover tooltip)
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isDragging && !disabled) {
        if (isFrameMode) {
          const frameIndex = pixelToFrame(e.clientX);
          onFrameChange!(frameIndex);
        } else if (onPositionChange) {
          const timeUs = pixelToTime(e.clientX);
          onPositionChange(timeUs);
        }
      }
    },
    [isDragging, disabled, isFrameMode, pixelToFrame, pixelToTime, onFrameChange, onPositionChange]
  );

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Handle track hover for tooltip
  const handleTrackMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      if (isFrameMode) {
        const frameIndex = pixelToFrame(e.clientX);
        setHoverPosition(frameIndex);
      } else {
        const timeUs = pixelToTime(e.clientX);
        setHoverPosition(timeUs);
      }
    },
    [disabled, isFrameMode, pixelToFrame, pixelToTime]
  );

  const handleTrackMouseLeave = useCallback(() => {
    setHoverPosition(null);
  }, []);

  // Set up global mouse listeners for drag
  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Format time for labels based on display format
  // For delta modes (delta-start and delta-last), show delta from stream start
  // (delta-last doesn't make sense for fixed slider labels, so we use stream start for both)
  const formatLabelTime = useCallback((us: number) => {
    if ((displayTimeFormat === "delta-start" || displayTimeFormat === "delta-last") && streamStartTimeUs != null) {
      // Show as delta from stream start
      return formatDeltaUs(us - streamStartTimeUs);
    }
    // Default: show time portion (HH:MM:SS)
    const full = formatHumanUs(us);
    const timePart = full.split(" ")[1];
    return timePart ? timePart.substring(0, 8) : full;
  }, [displayTimeFormat, streamStartTimeUs]);

  // Format time for tooltip based on display format
  const formatTooltipTime = useCallback((us: number) => {
    if ((displayTimeFormat === "delta-start" || displayTimeFormat === "delta-last") && streamStartTimeUs != null) {
      return formatDeltaUs(us - streamStartTimeUs);
    }
    return formatHumanUs(us);
  }, [displayTimeFormat, streamStartTimeUs]);

  // Calculate hover position percentage for tooltip
  const hoverPercent = useMemo(() => {
    if (hoverPosition === null) return 0;
    if (isFrameMode) {
      if (!totalFrames || totalFrames <= 1) return 0;
      return (hoverPosition / (totalFrames - 1)) * 100;
    } else {
      const range = maxTimeUs - minTimeUs;
      if (range <= 0) return 0;
      return ((hoverPosition - minTimeUs) / range) * 100;
    }
  }, [hoverPosition, isFrameMode, totalFrames, minTimeUs, maxTimeUs]);

  // Don't render if no valid range
  const hasValidRange = isFrameMode
    ? totalFrames != null && totalFrames > 0
    : (maxTimeUs - minTimeUs) > 0;

  if (!hasValidRange) {
    return null;
  }

  return (
    <div
      className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`}
    >
      {/* Start label */}
      {showLabels && (
        <span className={`${caption} font-mono shrink-0`}>
          {isFrameMode ? "1" : formatLabelTime(minTimeUs)}
        </span>
      )}

      {/* Track container */}
      <div
        ref={trackRef}
        className={`relative flex-1 h-4 flex items-center ${
          disabled ? "cursor-not-allowed" : "cursor-pointer"
        }`}
        onClick={handleTrackClick}
        onMouseMove={handleTrackMouseMove}
        onMouseLeave={handleTrackMouseLeave}
      >
        {/* Track background */}
        <div className="absolute inset-x-0 h-1.5 bg-[var(--bg-tertiary)] rounded-full" />

        {/* Filled portion */}
        <div
          className="absolute left-0 h-1.5 bg-[var(--accent-primary)] rounded-full"
          style={{ width: `${positionPercent}%` }}
        />

        {/* Handle */}
        <div
          className={`absolute w-3.5 h-3.5 bg-[var(--accent-primary)] rounded-full shadow-md transform -translate-x-1/2 ${
            disabled
              ? "cursor-not-allowed"
              : isDragging
              ? "cursor-grabbing scale-110"
              : "cursor-grab hover:scale-110"
          } transition-transform`}
          style={{ left: `${positionPercent}%` }}
          onMouseDown={handleMouseDown}
        />

        {/* Hover tooltip */}
        {hoverPosition !== null && !isDragging && !disabled && (
          <div
            className="absolute bottom-5 transform -translate-x-1/2 px-2 py-1 bg-[var(--bg-primary)] text-[color:var(--text-primary)] text-xs rounded shadow-lg whitespace-nowrap pointer-events-none z-10"
            style={{
              left: `${hoverPercent}%`,
            }}
          >
            {isFrameMode
              ? `Frame ${(hoverPosition + 1).toLocaleString()}`
              : formatTooltipTime(hoverPosition)}
          </div>
        )}
      </div>

      {/* End label */}
      {showLabels && (
        <span className={`${caption} font-mono shrink-0`}>
          {isFrameMode ? totalFrames!.toLocaleString() : formatLabelTime(maxTimeUs)}
        </span>
      )}
    </div>
  );
}
