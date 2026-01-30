// ui/src/components/TimelineScrubber.tsx

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { formatHumanUs, formatDeltaUs } from "../utils/timeFormat";
import { caption } from "../styles/typography";

type TimeDisplayFormat = "delta-last" | "delta-start" | "timestamp" | "human";

type Props = {
  /** Minimum timestamp in microseconds */
  minTimeUs: number;
  /** Maximum timestamp in microseconds */
  maxTimeUs: number;
  /** Current position in microseconds */
  currentTimeUs: number;
  /** Called when user scrubs to a new position */
  onPositionChange: (timeUs: number) => void;
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
  minTimeUs,
  maxTimeUs,
  currentTimeUs,
  onPositionChange,
  disabled = false,
  showLabels = true,
  displayTimeFormat = "human",
  streamStartTimeUs,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [hoverTimeUs, setHoverTimeUs] = useState<number | null>(null);

  // Calculate position percentage
  const range = maxTimeUs - minTimeUs;
  const positionPercent = useMemo(() => {
    if (range <= 0) return 0;
    const percent = ((currentTimeUs - minTimeUs) / range) * 100;
    return Math.max(0, Math.min(100, percent));
  }, [currentTimeUs, minTimeUs, range]);

  // Convert pixel position to timestamp
  const pixelToTime = useCallback(
    (clientX: number): number => {
      if (!trackRef.current || range <= 0) return minTimeUs;
      const rect = trackRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      return minTimeUs + ratio * range;
    },
    [minTimeUs, range]
  );

  // Handle click on track
  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      const timeUs = pixelToTime(e.clientX);
      onPositionChange(timeUs);
    },
    [disabled, pixelToTime, onPositionChange]
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
        const timeUs = pixelToTime(e.clientX);
        onPositionChange(timeUs);
      }
    },
    [isDragging, disabled, pixelToTime, onPositionChange]
  );

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Handle track hover for tooltip
  const handleTrackMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return;
      const timeUs = pixelToTime(e.clientX);
      setHoverTimeUs(timeUs);
    },
    [disabled, pixelToTime]
  );

  const handleTrackMouseLeave = useCallback(() => {
    setHoverTimeUs(null);
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

  // Don't render if no valid range
  if (range <= 0) {
    return null;
  }

  return (
    <div
      className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`}
    >
      {/* Start time label */}
      {showLabels && (
        <span className={`${caption} font-mono shrink-0`}>
          {formatLabelTime(minTimeUs)}
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
        {hoverTimeUs !== null && !isDragging && !disabled && (
          <div
            className="absolute bottom-5 transform -translate-x-1/2 px-2 py-1 bg-[var(--bg-primary)] text-[color:var(--text-primary)] text-xs rounded shadow-lg whitespace-nowrap pointer-events-none z-10"
            style={{
              left: `${((hoverTimeUs - minTimeUs) / range) * 100}%`,
            }}
          >
            {formatTooltipTime(hoverTimeUs)}
          </div>
        )}
      </div>

      {/* End time label */}
      {showLabels && (
        <span className={`${caption} font-mono shrink-0`}>
          {formatLabelTime(maxTimeUs)}
        </span>
      )}
    </div>
  );
}
