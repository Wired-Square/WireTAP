// ui/src/components/DataViewTimelineSection.tsx
//
// Shared timeline section wrapper for data views (Discovery, Decoder, etc.).

import TimelineScrubber from "./TimelineScrubber";
import { bgDataToolbar, borderDataView } from "../styles";

interface DataViewTimelineSectionProps {
  /** Whether to show the timeline section */
  show: boolean;
  /** Minimum timestamp in microseconds */
  minTimeUs: number;
  /** Maximum timestamp in microseconds */
  maxTimeUs: number;
  /** Current position in microseconds */
  currentTimeUs: number;
  /** Callback when user scrubs to a new position */
  onPositionChange: (timeUs: number) => void;
  /** Time format for display */
  displayTimeFormat: "delta-last" | "delta-start" | "timestamp" | "human";
  /** Reference start time for delta calculations (in microseconds) */
  streamStartTimeUs?: number | null;
  /** Whether scrubbing is disabled */
  disabled?: boolean;
  /** Total frames in buffer (enables frame-based mode when provided) */
  totalFrames?: number;
  /** Current frame index (0-based, for frame mode) */
  currentFrameIndex?: number;
  /** Called when user scrubs to a new frame index (for frame mode) */
  onFrameChange?: (frameIndex: number) => void;
}

export default function DataViewTimelineSection({
  show,
  minTimeUs,
  maxTimeUs,
  currentTimeUs,
  onPositionChange,
  displayTimeFormat,
  streamStartTimeUs,
  disabled = false,
  totalFrames,
  currentFrameIndex,
  onFrameChange,
}: DataViewTimelineSectionProps) {
  if (!show) {
    return null;
  }

  return (
    <div className={`flex-shrink-0 px-3 py-2 border-b ${borderDataView} ${bgDataToolbar}`}>
      <TimelineScrubber
        minTimeUs={minTimeUs}
        maxTimeUs={maxTimeUs}
        currentTimeUs={currentTimeUs}
        onPositionChange={onPositionChange}
        totalFrames={totalFrames}
        currentFrameIndex={currentFrameIndex}
        onFrameChange={onFrameChange}
        disabled={disabled}
        showLabels={true}
        displayTimeFormat={displayTimeFormat}
        streamStartTimeUs={streamStartTimeUs ?? undefined}
      />
    </div>
  );
}
