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
        disabled={disabled}
        showLabels={true}
        displayTimeFormat={displayTimeFormat}
        streamStartTimeUs={streamStartTimeUs ?? undefined}
      />
    </div>
  );
}
